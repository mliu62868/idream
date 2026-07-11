import { randomUUID } from "node:crypto";
import {
  adminCommandAcceptedSchema,
  adminCommandHeadersSchema,
  caseCloseCommandRequestSchema,
  characterReleasePublishCommandRequestSchema,
  characterReleaseRollbackCommandRequestSchema,
  characterReleaseScheduleCommandRequestSchema,
  characterSessionReleaseMigrationCommandRequestSchema,
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
import { CHARACTER_RELEASE_POLICY_VERSION } from "../characters/release-executor";
import { executeAcceptedAdminCommand } from "./executor";
import { generationProfileHealth } from "../creative/retry-executor";

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

class DependencyUnhealthyError extends Error {
  constructor(readonly dependencies: readonly { code: string; message: string; itemId?: string }[]) {
    super("A generation dependency is unhealthy; blind retry is disabled");
    this.name = "DependencyUnhealthyError";
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
  readonly executeInline?: boolean;
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
  if (input.executeInline) await executeAcceptedAdminCommand(accepted.commandId);
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
    if (error instanceof DependencyUnhealthyError) {
      return Response.json(
        {
          ok: false,
          error: {
            code: "dependency_unhealthy",
            message: error.message,
            requestId,
            dependencies: error.dependencies,
          },
        },
        { status: 503 },
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
  retryMode: "idempotent",
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
    if (
      !validation ||
      validation.result !== "passed" ||
      validation.snapshotHash !== release.snapshotHash ||
      validation.policyVersion !== CHARACTER_RELEASE_POLICY_VERSION
    ) {
      blockers.push({ code: "release_validation_stale", message: "A passing validation for the current snapshot is required." });
    }
    if (blockers.length > 0) {
      throw new InvariantFailedError(blockers, `/admin/characters/${characterId}?releaseId=${releaseId}`);
    }
    return acceptCommand({ actor, parsed, definition: publishReleaseDefinition, targetId: releaseId });
  });
}

const scheduleReleaseDefinition = {
  commandType: "character.release.schedule",
  targetType: "character_release",
  permission: "character.release.publish",
  retryMode: "idempotent",
} as const satisfies CommandDefinition;

export function scheduleCharacterRelease(request: Request, characterId: string, releaseId: string) {
  return commandResponse(request, async () => {
    const actor = await actorWithPermission(request, scheduleReleaseDefinition.permission);
    const parsed = await parseCommand(request, characterReleaseScheduleCommandRequestSchema);
    requireConfirmation(parsed.body.confirmation, `${characterId}:${releaseId}:schedule`);
    const release = await prisma.characterRelease.findUnique({ where: { id: releaseId } });
    if (!release) throw Errors.notFound("Character release not found", { releaseId });
    const project = await prisma.characterProject.findUnique({ where: { id: release.projectId } });
    if (!project || project.characterId !== characterId) {
      throw Errors.notFound("Character release not found for character", { characterId, releaseId });
    }
    if (release.version !== parsed.body.entityVersion) {
      return versionConflict(parsed.requestId, { id: release.id, status: release.status, version: release.version }, parsed.body.entityVersion);
    }
    const scheduledAt = new Date(parsed.body.scheduledAt);
    if (release.status !== "approved" || scheduledAt.getTime() <= Date.now()) {
      throw new InvariantFailedError(
        [{ code: "release_not_schedulable", message: "Release must be approved and scheduled in the future." }],
        `/admin/characters/${characterId}?releaseId=${releaseId}`,
      );
    }
    parsed.payload.scheduledAt = parsed.body.scheduledAt;
    return acceptCommand({ actor, parsed, definition: scheduleReleaseDefinition, targetId: releaseId });
  });
}

const rollbackReleaseDefinition = {
  commandType: "character.release.rollback",
  targetType: "character_serving",
  permission: "character.release.publish",
  retryMode: "idempotent",
} as const satisfies CommandDefinition;

export function rollbackCharacterRelease(request: Request, characterId: string, sourceReleaseId: string) {
  return commandResponse(request, async () => {
    const actor = await actorWithPermission(request, rollbackReleaseDefinition.permission);
    const parsed = await parseCommand(request, characterReleaseRollbackCommandRequestSchema);
    requireConfirmation(parsed.body.confirmation, `${characterId}:${sourceReleaseId}:rollback`);
    const source = await prisma.characterRelease.findUnique({ where: { id: sourceReleaseId } });
    if (!source) throw Errors.notFound("Rollback source Release not found", { sourceReleaseId });
    const project = await prisma.characterProject.findUnique({ where: { id: source.projectId } });
    if (!project || project.characterId !== characterId) {
      throw Errors.notFound("Rollback source Release not found for character", { characterId, sourceReleaseId });
    }
    const serving = await prisma.characterServing.findUnique({ where: { characterId } });
    if (!serving) throw Errors.notFound("Character serving authority not found", { characterId });
    if (serving.version !== parsed.body.entityVersion) {
      return versionConflict(
        parsed.requestId,
        { characterId, currentReleaseId: serving.currentReleaseId, version: serving.version },
        parsed.body.entityVersion,
      );
    }
    if (serving.currentReleaseId === sourceReleaseId) {
      throw new InvariantFailedError(
        [{ code: "rollback_source_is_current", message: "Rollback source is already serving." }],
        `/admin/characters/${characterId}?releaseId=${sourceReleaseId}`,
      );
    }
    parsed.payload.sourceReleaseId = sourceReleaseId;
    return acceptCommand({ actor, parsed, definition: rollbackReleaseDefinition, targetId: characterId });
  });
}

const migrateSessionReleaseDefinition = {
  commandType: "chat.session_release.migrate",
  targetType: "chat_session",
  permission: "character.release.publish",
  retryMode: "idempotent",
} as const satisfies CommandDefinition;

export function migrateChatSessionRelease(request: Request, sessionId: string) {
  return commandResponse(request, async () => {
    const actor = await actorWithPermission(request, migrateSessionReleaseDefinition.permission);
    const parsed = await parseCommand(request, characterSessionReleaseMigrationCommandRequestSchema);
    requireConfirmation(
      parsed.body.confirmation,
      `${sessionId}:${parsed.body.toCharacterReleaseId}:migrate`,
    );
    const [content, release] = await Promise.all([
      prisma.characterContentVersion.findUnique({
        where: { id: parsed.body.toCharacterContentVersionId },
      }),
      prisma.characterRelease.findUnique({
        where: { id: parsed.body.toCharacterReleaseId },
      }),
    ]);
    if (!content || content.characterId !== parsed.body.characterId) {
      throw Errors.notFound("Target CharacterContentVersion is not valid for character");
    }
    if (!release) throw Errors.notFound("Target CharacterRelease not found");
    const project = await prisma.characterProject.findUnique({ where: { id: release.projectId } });
    if (
      !project ||
      project.characterId !== parsed.body.characterId ||
      release.characterContentVersionId !== content.id
    ) {
      throw new InvariantFailedError([
        {
          code: "release_content_mismatch",
          message: "Target Release does not pin the requested immutable content version.",
        },
      ]);
    }
    if (release.version !== parsed.body.entityVersion) {
      return versionConflict(
        parsed.requestId,
        { id: release.id, status: release.status, version: release.version },
        parsed.body.entityVersion,
      );
    }
    parsed.payload.characterId = parsed.body.characterId;
    parsed.payload.fromCharacterContentVersionId = parsed.body.fromCharacterContentVersionId;
    parsed.payload.fromCharacterReleaseId = parsed.body.fromCharacterReleaseId;
    parsed.payload.toCharacterContentVersionId = parsed.body.toCharacterContentVersionId;
    parsed.payload.toCharacterReleaseId = parsed.body.toCharacterReleaseId;
    parsed.payload.compatibilityQa = parsed.body.compatibilityQa;
    parsed.payload.requestedById = actor.id;
    return acceptCommand({
      actor,
      parsed,
      definition: migrateSessionReleaseDefinition,
      targetId: sessionId,
      executeInline: true,
    });
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
          select: {
            id: true,
            job: { select: { id: true, status: true, profileId: true, profileVersion: true } },
          },
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
          item.job !== null &&
          item.job.status === "failed" &&
          !refundedJobIds.has(item.job.id),
      )
      .map((item) => item.id)
      .sort();
    if (eligibleItemIds.length === 0) {
      throw new InvariantFailedError(
        [{ code: "no_eligible_failed_items", message: "Creative Run has no eligible failed items." }],
        `/admin/creative/runs/${runId}`,
      );
    }
    const dependencies: Array<{ code: string; message: string; itemId?: string }> = [];
    for (const item of run.items.filter((candidate) => eligibleItemIds.includes(candidate.id))) {
      if (!item.job?.profileId) {
        dependencies.push({ code: "generation_profile_missing", message: "The failed item has no replayable profile authority.", itemId: item.id });
        continue;
      }
      const [profile, latestAttempt] = await Promise.all([
        prisma.generationModelProfile.findFirst({
          where: {
            version: item.job.profileVersion ?? undefined,
            OR: [{ id: item.job.profileId }, { profileKey: item.job.profileId }],
          },
          orderBy: { version: "desc" },
        }),
        prisma.generationAttempt.findFirst({ where: { requestId: item.job.id }, orderBy: { attemptNo: "desc" } }),
      ]);
      const health = generationProfileHealth(profile);
      if (!health.healthy) {
        dependencies.push({ code: health.reason, message: "The generation profile has not passed its health gate.", itemId: item.id });
      }
      if (latestAttempt?.status === "unknown" || latestAttempt?.retryability === "not_retryable") {
        dependencies.push({ code: "attempt_non_replayable", message: "The latest attempt requires reconciliation and cannot be retried.", itemId: item.id });
      }
    }
    if (dependencies.length > 0) throw new DependencyUnhealthyError(dependencies);
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
    return acceptCommand({ actor, parsed, definition: resolveIncidentDefinition, targetId: incidentId, executeInline: true });
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
    return acceptCommand({ actor, parsed, definition: closeCaseDefinition, targetId: caseId, executeInline: true });
  });
}
