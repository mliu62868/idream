import { randomUUID } from "node:crypto";
import {
  type AdminCommandRequest,
  type AdminCommandTargetType,
  type AdminV2DurableOperationId,
} from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { AppError, Errors } from "@/server/lib/errors";
import { fail, ok } from "@/server/lib/http";
import { env } from "@/server/lib/env";
import type { AdminActor } from "../shared/authority";
import {
  durableAdminCommandReceipt,
  readDurableAdminCommand,
  type DurableAdminCommandBody,
} from "../shared/durable-command-admission";
import type { PermissionKey } from "@/server/admin/permissions";
import {
  acceptControlPlaneCommand,
  canonicalRequestHash,
  IdempotencyConflictError,
} from "../shared/control-plane-command";
import { canonicalSha256 } from "../shared/canonical-json";
import { CHARACTER_RELEASE_POLICY_VERSION } from "../characters/release-validation";
import { characterCommandCoordinationKey } from "../characters/command-coordination";
import { executeAcceptedAdminCommand } from "./executor";
import { generationProfileHealth } from "../creative/retry-executor";
import { resolveGenerationAttemptRetryAuthority } from "@/server/modules/generation/generation-attempt-authority";

type JsonObject = Record<string, unknown>;

interface CommandDefinition {
  readonly commandType: string;
  readonly targetType: AdminCommandTargetType;
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

// Incident action plans own an atomic command + mitigation transaction and their
// historical receipt hash. Their transport admission still uses the same manifest seam.
type AdminCommandOperationId = Exclude<
  AdminV2DurableOperationId,
  "POST /api/v2/admin/incidents/:id/action-plans/:planId/execute"
>;
type CommandBody<Id extends AdminCommandOperationId> =
  DurableAdminCommandBody<Id> & AdminCommandRequest;

type CommandContext<Id extends AdminCommandOperationId> = {
  readonly actor: AdminActor;
  readonly parsed: ParsedCommand<CommandBody<Id>>;
  readonly permission: PermissionKey;
};

type CommandPreflight<Context> =
  | {
      readonly replay?: "exact";
      readonly preflight: (context: Context) => Promise<void | Response>;
    }
  | {
      readonly replay: "frozen_payload";
      readonly preflight: (context: Context) => Promise<JsonObject | Response>;
    };

/**
 * Own the admission order once: manifest admission → confirmation → replay → mutable
 * preflight → durable acceptance. Domain callers supply their facts, not this protocol.
 * Frozen preflight data is used only for the first admission; replay restores the
 * committed payload instead of reselecting eligible work against changed authority.
 */
async function executeCommand<const Id extends AdminCommandOperationId>(
  request: Request,
  operationId: Id,
  options: {
    readonly resource?: { readonly characterId?: string };
    readonly target: { readonly type: AdminCommandTargetType; readonly id: string };
    readonly confirmation: string | ((context: CommandContext<Id>) => string);
    readonly payload?: (context: CommandContext<Id>) => JsonObject;
    readonly coordinationKey?: string;
    readonly executeInline?: boolean;
  } & CommandPreflight<CommandContext<Id>>,
) {
  return commandResponse(request, async () => {
    const admitted = await readDurableAdminCommand(request, operationId, options.resource);
    const body = admitted.body as CommandBody<Id>;
    const parsed: ParsedCommand<CommandBody<Id>> = {
      body,
      idempotencyKey: admitted.idempotencyKey,
      requestId: admitted.requestId,
      payload: commandPayload(body),
    };
    const definition: CommandDefinition = {
      ...admitted.definition,
      targetType: options.target.type,
    };
    const context = { actor: admitted.actor, parsed, permission: definition.permission };
    requireConfirmation(body.confirmation, typeof options.confirmation === "string"
      ? options.confirmation
      : options.confirmation(context));
    if (options.payload) Object.assign(parsed.payload, options.payload(context));
    const admission = {
      actor: admitted.actor,
      parsed,
      definition,
      targetId: options.target.id,
      coordinationKey: options.coordinationKey,
      executeInline: options.executeInline,
    };
    const replay = options.replay === "frozen_payload"
      ? await replayCommandBeforeMutablePreflight(admission)
      : await replayExactCommandBeforeMutablePreflight(admission);
    if (replay) return replay;
    const prepared = await options.preflight(context);
    if (prepared instanceof Response) return prepared;
    if (options.replay === "frozen_payload") Object.assign(parsed.payload, prepared);
    return acceptCommand(admission);
  });
}

function reasonText(reason: AdminCommandRequest["reason"]): string {
  return [reason.code, reason.summary, reason.details].filter(Boolean).join(": ");
}

function requireConfirmation(actual: string | undefined, expected: string) {
  if (actual !== expected) {
    throw Errors.badRequest("Confirmation did not match command target", { expected });
  }
}

async function acceptCommand(input: {
  readonly actor: { readonly id: string; readonly role: string };
  readonly parsed: ParsedCommand<AdminCommandRequest>;
  readonly definition: CommandDefinition;
  readonly targetId: string;
  readonly coordinationKey?: string;
  readonly executeInline?: boolean;
}) {
  const accepted = await acceptControlPlaneCommand(prisma, {
    environment: env.APP_ENV,
    actor: input.actor,
    idempotencyKey: input.parsed.idempotencyKey,
    coordinationKey: input.coordinationKey,
    commandType: input.definition.commandType,
    target: { type: input.definition.targetType, id: input.targetId },
    expectedVersion: input.parsed.body.entityVersion,
    payload: input.parsed.payload,
    approvalId: input.parsed.body.approvalId,
    approvalPermissionKey: input.definition.permission,
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
  if (input.executeInline) await executeAcceptedAdminCommand(accepted.commandId, {
    db: prisma,
    workerId: `admin-inline-${randomUUID()}`,
  });
  const envelope = durableAdminCommandReceipt({
    id: accepted.commandId,
    requestId: authoritativeRequestId,
  });
  return ok(envelope, { status: 202, headers: { "Cache-Control": "no-store" } });
}

function jsonObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

async function replayCommandBeforeMutablePreflight(input: {
  readonly actor: { readonly id: string; readonly role: string };
  readonly parsed: ParsedCommand<AdminCommandRequest>;
  readonly definition: CommandDefinition;
  readonly targetId: string;
}) {
  const scope = `${env.APP_ENV}:${input.actor.id}`;
  const existing = await prisma.controlPlaneCommand.findUnique({
    where: {
      scope_idempotencyKey: {
        scope,
        idempotencyKey: input.parsed.idempotencyKey,
      },
    },
  });
  if (!existing) return null;

  const existingPayload = jsonObject(existing.requestPayload);
  const existingClientPayload = existingPayload
    ? {
        reason: existingPayload.reason,
        confirmation: existingPayload.confirmation ?? null,
      }
    : null;
  const submittedHash = canonicalRequestHash({
    commandType: input.definition.commandType,
    target: {
      type: input.definition.targetType,
      id: input.targetId,
    },
    expectedVersion: input.parsed.body.entityVersion,
    payload: input.parsed.payload,
    approvalId: input.parsed.body.approvalId,
    approvalPermissionKey: input.definition.permission,
    retryMode: input.definition.retryMode,
  });
  const matches =
    existingPayload !== null &&
    existing.actorId === input.actor.id &&
    existing.commandType === input.definition.commandType &&
    existing.targetType === input.definition.targetType &&
    existing.targetId === input.targetId &&
    existing.expectedVersion === input.parsed.body.entityVersion &&
    existing.approvalId === (input.parsed.body.approvalId ?? null) &&
    existing.retryMode === input.definition.retryMode &&
    canonicalSha256(existingClientPayload) ===
      canonicalSha256(input.parsed.payload);
  if (!matches) {
    throw new IdempotencyConflictError(
      existing.id,
      existing.requestHash,
      submittedHash,
    );
  }

  return acceptCommand({
    ...input,
    parsed: {
      ...input.parsed,
      payload: existingPayload,
    },
  });
}

async function replayExactCommandBeforeMutablePreflight(input: {
  readonly actor: { readonly id: string; readonly role: string };
  readonly parsed: ParsedCommand<AdminCommandRequest>;
  readonly definition: CommandDefinition;
  readonly targetId: string;
  readonly coordinationKey?: string;
  readonly executeInline?: boolean;
}) {
  const scope = `${env.APP_ENV}:${input.actor.id}`;
  const existing = await prisma.controlPlaneCommand.findUnique({
    where: {
      scope_idempotencyKey: {
        scope,
        idempotencyKey: input.parsed.idempotencyKey,
      },
    },
  });
  if (!existing) return null;

  const submittedHash = canonicalRequestHash({
    commandType: input.definition.commandType,
    target: {
      type: input.definition.targetType,
      id: input.targetId,
    },
    expectedVersion: input.parsed.body.entityVersion,
    payload: input.parsed.payload,
    approvalId: input.parsed.body.approvalId,
    approvalPermissionKey: input.definition.permission,
    retryMode: input.definition.retryMode,
  });
  if (existing.requestHash !== submittedHash) {
    throw new IdempotencyConflictError(
      existing.id,
      existing.requestHash,
      submittedHash,
    );
  }
  return acceptCommand(input);
}

function versionConflict(requestId: string, currentSnapshot: unknown, expectedVersion: number) {
  return Response.json(
    {
      ok: false,
      error: {
        code: "conflict",
        message: "Entity version changed",
        details: { blocker: "version_mismatch", expectedVersion },
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
    if (error instanceof AppError) return fail(error);
    throw error;
  }
}

export function publishCharacterRelease(request: Request, characterId: string, releaseId: string) {
  return executeCommand(request, "POST /api/v2/admin/characters/:id/releases/:releaseId/commands/publish", {
    resource: { characterId },
    target: { type: "character_release", id: releaseId },
    confirmation: `${characterId}:${releaseId}:publish`,
    coordinationKey: characterCommandCoordinationKey(characterId),
    preflight: async ({ parsed }) => {
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
    },
  });
}

export function withdrawCharacterRelease(request: Request, characterId: string, releaseId: string) {
  return executeCommand(request, "POST /api/v2/admin/characters/:id/releases/:releaseId/commands/withdraw", {
    resource: { characterId },
    target: { type: "character_release", id: releaseId },
    confirmation: `${characterId}:${releaseId}:withdraw`,
    coordinationKey: characterCommandCoordinationKey(characterId),
    preflight: async ({ parsed }) => {
      const release = await prisma.characterRelease.findUnique({ where: { id: releaseId } });
      const project = release ? await prisma.characterProject.findUnique({ where: { id: release.projectId } }) : null;
      if (!release || project?.characterId !== characterId) throw Errors.notFound("Character release not found for character");
      if (release.version !== parsed.body.entityVersion) return versionConflict(parsed.requestId, { id: release.id, status: release.status, version: release.version }, parsed.body.entityVersion);
      if (release.status !== "approved") throw Errors.conflict("Only an unpublished candidate can be withdrawn");
    },
  });
}

export function rollbackCharacterRelease(request: Request, characterId: string, sourceReleaseId: string) {
  return executeCommand(request, "POST /api/v2/admin/characters/:id/releases/:releaseId/commands/rollback", {
    resource: { characterId },
    target: { type: "character_serving", id: characterId },
    confirmation: `${characterId}:${sourceReleaseId}:rollback`,
    coordinationKey: characterCommandCoordinationKey(characterId),
    payload: () => ({ sourceReleaseId }),
    preflight: async ({ parsed }) => {
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
      if (source.status !== "superseded") {
        throw new InvariantFailedError(
          [{ code: "rollback_source_not_superseded", message: "Rollback source must be a previously published superseded Release." }],
          `/admin/characters/${characterId}?releaseId=${sourceReleaseId}`,
        );
      }
    },
  });
}

export function changeCharacterServingState(
  request: Request,
  characterId: string,
  action: "pause" | "resume" | "retire" | "restore",
) {
  return executeCommand(request, `POST /api/v2/admin/characters/:id/commands/${action}`, {
    resource: { characterId },
    target: { type: "character_serving", id: characterId },
    confirmation: `${characterId}:${action}`,
    coordinationKey: characterCommandCoordinationKey(characterId),
    payload: () => ({ retireProject: action === "retire", characterId, action }),
    preflight: async ({ parsed }) => {
      const serving = await prisma.characterServing.findUnique({ where: { characterId } });
      if (!serving) throw Errors.notFound("Character Serving authority not found", { characterId });
      if (serving.version !== parsed.body.entityVersion) {
        return versionConflict(parsed.requestId, { characterId, state: serving.state, version: serving.version }, parsed.body.entityVersion);
      }
      const allowed = action === "restore"
        ? serving.state === "retired" && serving.currentReleaseId === null
        : action === "retire" ? ["inactive", "live", "paused"].includes(serving.state)
        : action === "resume" ? serving.state === "paused" : serving.state === "live";
      if (!allowed) {
        throw new InvariantFailedError(
          [{ code: "serving_state_invalid", message: `Character serving state does not allow ${action}.` }],
          `/admin/characters/${characterId}?tab=release`,
        );
      }
    },
  });
}

// A session can only pin a Release that Chat recognizes as already published.
const MIGRATABLE_RELEASE_STATUSES = ["published", "superseded"];

export function migrateChatSessionRelease(request: Request, sessionId: string) {
  return executeCommand(request, "POST /api/v2/admin/chat/sessions/:sessionId/commands/migrate-release", {
    target: { type: "chat_session", id: sessionId },
    confirmation: ({ parsed }) => `${sessionId}:${parsed.body.toCharacterReleaseId}:migrate`,
    payload: ({ actor, parsed }) => ({
      characterId: parsed.body.characterId,
      fromCharacterContentVersionId: parsed.body.fromCharacterContentVersionId,
      fromCharacterReleaseId: parsed.body.fromCharacterReleaseId,
      toCharacterContentVersionId: parsed.body.toCharacterContentVersionId,
      toCharacterReleaseId: parsed.body.toCharacterReleaseId,
      compatibilityCheck: parsed.body.compatibilityCheck,
      requestedById: actor.id,
    }),
    executeInline: true,
    preflight: async ({ parsed }) => {
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
      // SPEC: 目标 Release 必须处于 chat 认得的已发布态。
      // INTENT: 此前只校了「归属正确」与「pin 了请求的内容版本」，没校状态。于是把一个会话迁到
      //         draft / approved / scheduled 上，命令**返回成功**，然后这个会话每说一句话都在
      //         chat 侧抛 `character release ... is not released`；而那个 pin 只有删除会话时才清
      //         （chat/src/privacy.ts:321）—— 一次正常的运营操作永久打死一个会话，且无从撤销。
      //         实测库里就有 1 条 `approved` 的 Release 可以触发它。
      //         校验放在权威侧而不是消费侧：迁移时报错运营能换一个，每轮报错运营什么都做不了。
      if (!MIGRATABLE_RELEASE_STATUSES.includes(release.status)) {
        throw new InvariantFailedError([
          {
            code: "release_not_published",
            message: `Target Release is ${release.status}; only published or superseded Releases can serve a session.`,
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
    },
  });
}

export function retryFailedCreativeRun(request: Request, runId: string) {
  return executeCommand(request, "POST /api/v2/admin/creative/runs/:id/commands/retry-failed", {
    target: { type: "creative_run", id: runId },
    confirmation: `${runId}:retry-failed`,
    replay: "frozen_payload",
    preflight: async ({ parsed }) => {
      const run = await prisma.contentProductionBatch.findUnique({
        where: { id: runId },
        include: {
          items: {
            where: { status: "failed" },
            select: {
              id: true,
              job: {
                select: {
                  id: true,
                  status: true,
                  errorCode: true,
                  deliveredOutputCount: true,
                  profileId: true,
                  profileVersion: true,
                },
              },
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
        const retryAuthority = await resolveGenerationAttemptRetryAuthority(prisma, {
          request: item.job,
          latestAttempt,
        });
        if (!retryAuthority.allowed) {
          dependencies.push({
            code: retryAuthority.code,
            message: retryAuthority.message,
            itemId: item.id,
          });
        }
      }
      if (dependencies.length > 0) throw new DependencyUnhealthyError(dependencies);
      return { failedItemIds: eligibleItemIds };
    },
  });
}

export function resolveIncident(request: Request, incidentId: string) {
  return executeCommand(request, "POST /api/v2/admin/incidents/:id/commands/resolve", {
    target: { type: "ops_incident", id: incidentId },
    confirmation: `${incidentId}:resolve`,
    executeInline: true,
    preflight: async ({ parsed }) => {
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
    },
  });
}

export function closeCase(request: Request, caseId: string) {
  return executeCommand(request, "POST /api/v2/admin/cases/:id/commands/close", {
    target: { type: "admin_case", id: caseId },
    confirmation: `${caseId}:close`,
    executeInline: true,
    preflight: async ({ actor, parsed, permission }) => {
      const adminCase = await prisma.adminCase.findUnique({ where: { id: caseId } });
      if (!adminCase) throw Errors.notFound("Case not found", { caseId });
      if (
        actor.role === "support" &&
        !["support_request", "billing_dispute"].includes(adminCase.type)
      ) {
        throw Errors.forbidden("Case subtype is outside the actor's permission scope", {
          permission,
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
    },
  });
}
