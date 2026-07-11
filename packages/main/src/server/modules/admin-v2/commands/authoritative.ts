import { randomUUID } from "node:crypto";
import {
  adminCommandAcceptedSchema,
  adminCommandHeadersSchema,
  caseCloseCommandRequestSchema,
  characterReleasePublishCommandRequestSchema,
  creativeRunRetryFailedCommandRequestSchema,
  incidentResolveCommandRequestSchema,
  type AdminCommandRequest,
} from "@idream/shared/admin";
import type { Prisma } from "@prisma/client";
import { ZodError, type ZodType } from "zod";
import { prisma } from "@/server/lib/db";
import { AppError, Errors } from "@/server/lib/errors";
import { fail, ok } from "@/server/lib/http";
import { env } from "@/server/lib/env";
import { actorWithPermission } from "@/server/modules/admin/service";
import type { PermissionKey } from "@/server/admin/permissions";
import { canonicalSha256 } from "../shared/canonical-json";
import {
  acceptControlPlaneCommand,
  IdempotencyConflictError,
} from "../shared/control-plane-command";

type JsonObject = Record<string, unknown>;

interface CommandDefinition {
  readonly commandType: string;
  readonly targetType: string;
  readonly permission: PermissionKey;
  readonly retryMode: "idempotent" | "non_replayable";
}

interface ParsedCommand<T extends AdminCommandRequest> {
  readonly body: T;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly payload: JsonObject;
}

class InvariantFailedError extends Error {
  constructor(
    readonly blockers: readonly { code: string; message: string; deepLink?: string }[],
    readonly repairDeepLink?: string,
  ) {
    super("Command invariants are not satisfied");
    this.name = "InvariantFailedError";
  }
}

function commandPayload(body: AdminCommandRequest): JsonObject {
  return {
    reason: body.reason,
    confirmation: body.confirmation ?? null,
  };
}

function parseIfMatch(value: string): number | null {
  const normalized = value.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  if (!/^\d+$/.test(normalized)) return null;
  return Number(normalized);
}

async function parseCommand<T extends AdminCommandRequest>(
  request: Request,
  schema: ZodType<T>,
): Promise<ParsedCommand<T>> {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  const headers = adminCommandHeadersSchema.parse({
    idempotencyKey: request.headers.get("idempotency-key"),
    ifMatch: request.headers.get("if-match") ?? undefined,
    requestId,
  });
  const body = schema.parse(await request.json());
  if (headers.ifMatch) {
    const matchedVersion = parseIfMatch(headers.ifMatch);
    if (matchedVersion === null || matchedVersion !== body.entityVersion) {
      throw Errors.badRequest("If-Match must equal body entityVersion", {
        ifMatch: headers.ifMatch,
        entityVersion: body.entityVersion,
      });
    }
  }
  return {
    body,
    idempotencyKey: headers.idempotencyKey,
    requestId: headers.requestId,
    payload: commandPayload(body),
  };
}

function reasonText(reason: AdminCommandRequest["reason"]): string {
  return [reason.code, reason.summary, reason.details].filter(Boolean).join(": ");
}

function requireConfirmation(actual: string | undefined, expected: string) {
  if (actual !== expected) {
    throw Errors.badRequest("Confirmation did not match command target", { expected });
  }
}

function jsonRecord(value: Prisma.JsonValue): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

async function validateApproval(input: {
  readonly approvalId?: string;
  readonly definition: CommandDefinition;
  readonly targetId: string;
  readonly expectedVersion: number;
  readonly payload: JsonObject;
}) {
  if (!input.approvalId) return;
  const approval = await prisma.adminActionRequest.findUnique({ where: { id: input.approvalId } });
  if (!approval || approval.status !== "approved") {
    throw Errors.forbidden("Approval is missing, expired, or not approved", {
      approvalId: input.approvalId,
    });
  }
  const binding = jsonRecord(approval.payload);
  const expiresAt = typeof binding?.expiresAt === "string" ? new Date(binding.expiresAt) : null;
  const matches =
    approval.action === input.definition.commandType &&
    approval.targetType === input.definition.targetType &&
    approval.targetId === input.targetId &&
    binding?.commandType === input.definition.commandType &&
    binding?.targetType === input.definition.targetType &&
    binding?.targetId === input.targetId &&
    binding?.payloadHash === canonicalSha256(input.payload) &&
    binding?.expectedVersion === input.expectedVersion &&
    expiresAt !== null &&
    Number.isFinite(expiresAt.getTime()) &&
    expiresAt.getTime() > Date.now();
  if (!matches) {
    throw Errors.forbidden("Approval is not bound to this canonical command request", {
      approvalId: input.approvalId,
    });
  }
}

async function acceptCommand(input: {
  readonly actor: { readonly id: string; readonly role: string };
  readonly parsed: ParsedCommand<AdminCommandRequest>;
  readonly definition: CommandDefinition;
  readonly targetId: string;
}) {
  await validateApproval({
    approvalId: input.parsed.body.approvalId,
    definition: input.definition,
    targetId: input.targetId,
    expectedVersion: input.parsed.body.entityVersion,
    payload: input.parsed.payload,
  });
  const accepted = await acceptControlPlaneCommand(prisma, {
    environment: env.APP_ENV,
    actor: input.actor,
    idempotencyKey: input.parsed.idempotencyKey,
    commandType: input.definition.commandType,
    target: { type: input.definition.targetType, id: input.targetId },
    expectedVersion: input.parsed.body.entityVersion,
    payload: input.parsed.payload,
    approvalId: input.parsed.body.approvalId,
    retryMode: input.definition.retryMode,
    reason: reasonText(input.parsed.body.reason),
    requestId: input.parsed.requestId,
  });
  const authoritativeRequestId = accepted.replayed
    ? (
        await prisma.controlPlaneCommand.findUniqueOrThrow({
          where: { id: accepted.commandId },
          select: { requestId: true },
        })
      ).requestId
    : input.parsed.requestId;
  const envelope = adminCommandAcceptedSchema.parse({
    status: "accepted",
    requestId: authoritativeRequestId,
    commandId: accepted.commandId,
    verificationDeepLink: `/admin/system/audit?commandId=${encodeURIComponent(accepted.commandId)}`,
  });
  return ok(envelope, { status: 202, headers: { "Cache-Control": "no-store" } });
}

function versionConflict(requestId: string, currentSnapshot: unknown, expectedVersion: number) {
  return Response.json(
    {
      ok: false,
      error: {
        code: "conflict",
        message: "Entity version changed",
        requestId,
        currentSnapshot,
        differences: [`Expected version ${expectedVersion}`],
      },
    },
    { status: 409 },
  );
}

async function commandResponse(
  request: Request,
  execute: () => Promise<Response>,
): Promise<Response> {
  try {
    return await execute();
  } catch (error) {
    const requestId = request.headers.get("x-request-id")?.trim() || "unknown";
    if (error instanceof IdempotencyConflictError) {
      return Response.json(
        {
          ok: false,
          error: {
            code: "idempotency_conflict",
            message: error.message,
            requestId,
            commandId: error.existingCommandId,
          },
        },
        { status: 409 },
      );
    }
    if (error instanceof InvariantFailedError) {
      return Response.json(
        {
          ok: false,
          error: {
            code: "invariant_failed",
            message: error.message,
            requestId,
            blockers: error.blockers,
            repairDeepLink: error.repairDeepLink,
          },
        },
        { status: 422 },
      );
    }
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return fail(Errors.badRequest("Validation failed"));
    }
    if (error instanceof AppError) return fail(error);
    throw error;
  }
}

const publishReleaseDefinition = {
  commandType: "character.release.publish",
  targetType: "character_release",
  permission: "character.release.publish",
  retryMode: "non_replayable",
} as const satisfies CommandDefinition;

export function publishCharacterRelease(request: Request, characterId: string, releaseId: string) {
  return commandResponse(request, async () => {
    const actor = await actorWithPermission(request, publishReleaseDefinition.permission);
    const parsed = await parseCommand(request, characterReleasePublishCommandRequestSchema);
    requireConfirmation(parsed.body.confirmation, `${characterId}:${releaseId}:publish`);
    const release = await prisma.characterRelease.findUnique({ where: { id: releaseId } });
    if (!release) throw Errors.notFound("Character release not found", { releaseId });
    const project = await prisma.characterProject.findUnique({ where: { id: release.projectId } });
    if (!project || project.characterId !== characterId) {
      throw Errors.notFound("Character release not found for character", { characterId, releaseId });
    }
    if (release.version !== parsed.body.entityVersion) {
      return versionConflict(parsed.requestId, { id: release.id, status: release.status, version: release.version }, parsed.body.entityVersion);
    }
    const validation = await prisma.releaseValidationRun.findFirst({
      where: { releaseId },
      orderBy: { startedAt: "desc" },
    });
    const blockers: Array<{ code: string; message: string }> = [];
    if (release.status !== "approved") blockers.push({ code: "release_not_approved", message: "Release must be approved before publish." });
    if (!validation || validation.result !== "passed" || validation.snapshotHash !== release.snapshotHash) {
      blockers.push({ code: "release_validation_stale", message: "A passing validation for the current snapshot is required." });
    }
    if (blockers.length > 0) {
      throw new InvariantFailedError(blockers, `/admin/characters/${characterId}?releaseId=${releaseId}`);
    }
    return acceptCommand({ actor, parsed, definition: publishReleaseDefinition, targetId: releaseId });
  });
}

const retryFailedDefinition = {
  commandType: "creative.run.retry_failed",
  targetType: "creative_run",
  permission: "creative.run.write",
  retryMode: "idempotent",
} as const satisfies CommandDefinition;

export function retryFailedCreativeRun(request: Request, runId: string) {
  return commandResponse(request, async () => {
    const actor = await actorWithPermission(request, retryFailedDefinition.permission);
    const parsed = await parseCommand(request, creativeRunRetryFailedCommandRequestSchema);
    requireConfirmation(parsed.body.confirmation, `${runId}:retry-failed`);
    const run = await prisma.contentProductionBatch.findUnique({
      where: { id: runId },
      include: {
        items: {
          where: { status: "failed" },
          select: { id: true, job: { select: { id: true, status: true } } },
        },
      },
    });
    if (!run) throw Errors.notFound("Creative Run not found", { runId });
    if (run.version !== parsed.body.entityVersion) {
      return versionConflict(parsed.requestId, { id: run.id, status: run.status, version: run.version }, parsed.body.entityVersion);
    }
    const jobIds = run.items.flatMap((item) => (item.job ? [item.job.id] : []));
    const refundedJobIds = new Set(
      (
        await prisma.dreamcoinLedger.findMany({
          where: { sourceId: { in: jobIds }, reason: "refund" },
          select: { sourceId: true },
        })
      ).flatMap((entry) => (entry.sourceId ? [entry.sourceId] : [])),
    );
    const eligibleItemIds = run.items
      .filter(
        (item) =>
          item.job === null ||
          (["failed", "blocked", "cancelled"].includes(item.job.status) &&
            !refundedJobIds.has(item.job.id)),
      )
      .map((item) => item.id)
      .sort();
    if (eligibleItemIds.length === 0) {
      throw new InvariantFailedError(
        [{ code: "no_eligible_failed_items", message: "Creative Run has no eligible failed items." }],
        `/admin/creative/runs/${runId}`,
      );
    }
    parsed.payload.failedItemIds = eligibleItemIds;
    return acceptCommand({ actor, parsed, definition: retryFailedDefinition, targetId: runId });
  });
}

const resolveIncidentDefinition = {
  commandType: "incident.resolve",
  targetType: "ops_incident",
  permission: "ops.incident.manage",
  retryMode: "non_replayable",
} as const satisfies CommandDefinition;

export function resolveIncident(request: Request, incidentId: string) {
  return commandResponse(request, async () => {
    const actor = await actorWithPermission(request, resolveIncidentDefinition.permission);
    const parsed = await parseCommand(request, incidentResolveCommandRequestSchema);
    requireConfirmation(parsed.body.confirmation, `${incidentId}:resolve`);
    const incident = await prisma.opsIncident.findUnique({ where: { id: incidentId } });
    if (!incident) throw Errors.notFound("Incident not found", { incidentId });
    if (incident.version !== parsed.body.entityVersion) {
      return versionConflict(parsed.requestId, { id: incident.id, status: incident.status, version: incident.version }, parsed.body.entityVersion);
    }
    if (incident.status !== "monitoring" || !["passed", "overridden"].includes(incident.verificationState)) {
      throw new InvariantFailedError(
        [{ code: "recovery_not_verified", message: "Incident must be monitoring with passed recovery verification." }],
        `/admin/ops/incidents/${incidentId}`,
      );
    }
    return acceptCommand({ actor, parsed, definition: resolveIncidentDefinition, targetId: incidentId });
  });
}

const closeCaseDefinition = {
  commandType: "case.close",
  targetType: "admin_case",
  permission: "case.decide",
  retryMode: "non_replayable",
} as const satisfies CommandDefinition;

export function closeCase(request: Request, caseId: string) {
  return commandResponse(request, async () => {
    const actor = await actorWithPermission(request, closeCaseDefinition.permission);
    const parsed = await parseCommand(request, caseCloseCommandRequestSchema);
    requireConfirmation(parsed.body.confirmation, `${caseId}:close`);
    const adminCase = await prisma.adminCase.findUnique({ where: { id: caseId } });
    if (!adminCase) throw Errors.notFound("Case not found", { caseId });
    if (
      actor.role === "support" &&
      !["support_request", "billing_dispute"].includes(adminCase.type)
    ) {
      throw Errors.forbidden("Case subtype is outside the actor's permission scope", {
        permission: closeCaseDefinition.permission,
        scope: "support_case_subtypes",
        caseType: adminCase.type,
      });
    }
    if (adminCase.version !== parsed.body.entityVersion) {
      return versionConflict(parsed.requestId, { id: adminCase.id, status: adminCase.status, version: adminCase.version }, parsed.body.entityVersion);
    }
    if (
      adminCase.status !== "resolved" ||
      adminCase.resolution === null ||
      !["passed", "overridden"].includes(adminCase.verificationState)
    ) {
      throw new InvariantFailedError(
        [{ code: "case_resolution_incomplete", message: "Case needs a resolution and verified downstream outcome before close." }],
        `/admin/customer-ops/cases/${caseId}`,
      );
    }
    return acceptCommand({ actor, parsed, definition: closeCaseDefinition, targetId: caseId });
  });
}
