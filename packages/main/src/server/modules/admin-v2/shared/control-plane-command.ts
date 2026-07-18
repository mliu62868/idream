import { Prisma, type PrismaClient } from "@prisma/client";
import { incrementCounter, observeHistogram } from "@idream/shared";
import { canonicalSha256 } from "./canonical-json";
import { toInputJson } from "./prisma-json";
import { AppError, Errors } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { transitionControlPlaneCommandAttempt } from "./control-plane-command-attempt";
import { transitionControlPlaneCommand } from "./control-plane-command-transition";

export interface CanonicalCommandRequest {
  readonly commandType: string;
  readonly target: { readonly type: string; readonly id: string };
  readonly expectedVersion?: number;
  readonly payload: unknown;
  readonly approvalId?: string;
  readonly approvalPermissionKey?: string;
  readonly retryMode?: "idempotent" | "non_replayable";
}

export interface AcceptControlPlaneCommandInput extends CanonicalCommandRequest {
  readonly environment: string;
  readonly actor: { readonly id: string; readonly role: string };
  readonly idempotencyKey: string;
  readonly coordinationKey?: string;
  readonly reason: string;
  readonly requestId: string;
  readonly maxAttempts?: number;
}

export const ACTIVE_CONTROL_PLANE_COMMAND_STATUSES = [
  "accepted",
  "running",
  "verifying",
] as const;

export class IdempotencyConflictError extends Error {
  readonly code = "idempotency_conflict";

  constructor(
    readonly existingCommandId: string,
    readonly existingRequestHash: string,
    readonly submittedRequestHash: string,
  ) {
    super("Idempotency key is already bound to a different canonical command request");
    this.name = "IdempotencyConflictError";
  }
}

export function canonicalRequestHash(input: CanonicalCommandRequest): string {
  return canonicalSha256({
    commandType: input.commandType,
    target: input.target,
    expectedVersion: input.expectedVersion ?? null,
    payload: input.payload,
    approvalId: input.approvalId ?? null,
    approvalPermissionKey: input.approvalPermissionKey ?? null,
    retryMode: input.retryMode ?? "non_replayable",
  });
}

function jsonRecord(value: Prisma.JsonValue): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function consumeBoundApproval(tx: Prisma.TransactionClient, input: AcceptControlPlaneCommandInput) {
  if (!input.approvalId) return;
  const approval = await tx.adminActionRequest.findUnique({ where: { id: input.approvalId } });
  const binding = approval ? jsonRecord(approval.payload) : null;
  const expiresAt = typeof binding?.expiresAt === "string" ? new Date(binding.expiresAt) : null;
  const matches =
    approval?.status === "approved" &&
    approval.requestedById === input.actor.id &&
    approval.approvedById !== null &&
    approval.approvedById !== input.actor.id &&
    approval.permissionKey === input.approvalPermissionKey &&
    approval.action === input.commandType &&
    approval.targetType === input.target.type &&
    approval.targetId === input.target.id &&
    binding?.commandType === input.commandType &&
    binding?.targetType === input.target.type &&
    binding?.targetId === input.target.id &&
    binding?.payloadHash === canonicalSha256(input.payload) &&
    binding?.expectedVersion === input.expectedVersion &&
    expiresAt !== null &&
    Number.isFinite(expiresAt.getTime()) &&
    expiresAt.getTime() > Date.now();
  if (!matches) {
    throw Errors.forbidden("Approval is missing, consumed, expired, or not bound to this canonical command request", { approvalId: input.approvalId });
  }
  const consumed = await tx.adminActionRequest.updateMany({
    where: { id: input.approvalId, status: "approved" },
    data: { status: "consumed" },
  });
  if (consumed.count !== 1) {
    throw Errors.forbidden("Approval was already consumed by another command", { approvalId: input.approvalId });
  }
}

async function resolveExisting(
  db: Pick<PrismaClient, "controlPlaneCommand">,
  scope: string,
  idempotencyKey: string,
  requestHash: string,
) {
  const existing = await db.controlPlaneCommand.findUnique({
    where: { scope_idempotencyKey: { scope, idempotencyKey } },
  });
  if (!existing) return null;
  if (existing.requestHash !== requestHash) {
    throw new IdempotencyConflictError(existing.id, existing.requestHash, requestHash);
  }
  return { commandId: existing.id, status: existing.status, replayed: true as const };
}

export async function acceptControlPlaneCommand(
  db: PrismaClient,
  input: AcceptControlPlaneCommandInput,
) {
  const startedAt = performance.now();
  let outcome = "error";
  let commandId: string | null = null;
  let errorCode: string | null = null;
  try {
    const scope = `${input.environment}:${input.actor.id}`;
    const requestHash = canonicalRequestHash(input);
    const existing = await resolveExisting(db, scope, input.idempotencyKey, requestHash);
    if (existing) {
      outcome = "replayed";
      commandId = existing.commandId;
      return existing;
    }

    try {
      const result = await db.$transaction(
        async (tx) => {
          if (input.coordinationKey) {
            await tx.$executeRaw`
              SELECT pg_advisory_xact_lock(
                hashtext(${`control-plane-command:${input.coordinationKey}`})
              )
            `;
          }
          const raced = await resolveExisting(tx, scope, input.idempotencyKey, requestHash);
          if (raced) return raced;
          if (input.coordinationKey) {
            const active = await tx.controlPlaneCommand.findFirst({
              where: {
                coordinationKey: input.coordinationKey,
                status: { in: [...ACTIVE_CONTROL_PLANE_COMMAND_STATUSES] },
              },
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              select: { id: true, commandType: true, status: true },
            });
            if (active) {
              throw Errors.conflict(
                "Another command is already active for this authority",
                {
                  activeCommandId: active.id,
                  activeCommandType: active.commandType,
                  activeCommandStatus: active.status,
                },
              );
            }
          }
          await consumeBoundApproval(tx, input);
          const command = await tx.controlPlaneCommand.create({
            data: {
              scope,
              idempotencyKey: input.idempotencyKey,
              coordinationKey: input.coordinationKey,
              commandType: input.commandType,
              targetType: input.target.type,
              targetId: input.target.id,
              actorId: input.actor.id,
              requestId: input.requestId,
              requestHash,
              requestPayload: toInputJson(input.payload),
              expectedVersion: input.expectedVersion,
              approvalId: input.approvalId,
              retryMode: input.retryMode ?? "non_replayable",
              status: "accepted",
              maxAttempts: input.maxAttempts ?? 3,
            },
          });
          await tx.adminAuditLog.create({
            data: {
              actorId: input.actor.id,
              actorRole: input.actor.role,
              action: input.commandType,
              targetType: input.target.type,
              targetId: input.target.id,
              reason: input.reason,
              after: toInputJson({
                commandId: command.id,
                expectedVersion: input.expectedVersion ?? null,
                approvalId: input.approvalId ?? null,
                retryMode: input.retryMode ?? "non_replayable",
                coordinationKey: input.coordinationKey ?? null,
                requestHash,
                status: command.status,
              }),
              requestId: input.requestId,
            },
          });
          await tx.mainOutboxEvent.create({
            data: {
              eventType: "admin.command.accepted.v2",
              aggregateType: input.target.type,
              aggregateId: input.target.id,
              payload: toInputJson({
                commandId: command.id,
                commandType: input.commandType,
                target: input.target,
                expectedVersion: input.expectedVersion ?? null,
                payload: input.payload,
                approvalId: input.approvalId ?? null,
                retryMode: input.retryMode ?? "non_replayable",
                coordinationKey: input.coordinationKey ?? null,
                requestHash,
              }),
            },
          });
          return { commandId: command.id, status: command.status, replayed: false as const };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
      outcome = result.replayed ? "replayed" : "accepted";
      commandId = result.commandId;
      return result;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const raced = await resolveExisting(db, scope, input.idempotencyKey, requestHash);
        if (raced) {
          outcome = "replayed";
          commandId = raced.commandId;
          return raced;
        }
      }
      throw error;
    }
  } catch (error) {
    outcome = error instanceof IdempotencyConflictError ||
      (error instanceof AppError && error.code === "conflict")
      ? "conflict"
      : "error";
    errorCode = error instanceof IdempotencyConflictError
      ? error.code
      : error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "internal_error";
    throw error;
  } finally {
    const duration = Math.max(0, performance.now() - startedAt) / 1_000;
    const labels = { type: input.commandType, outcome };
    incrementCounter("admin_command_total", "Admin control-plane command acceptance outcomes", labels);
    observeHistogram(
      "admin_command_duration_seconds",
      "Admin control-plane command acceptance latency in seconds",
      labels,
      duration,
    );
    const context = {
      requestId: input.requestId,
      commandId,
      actorId: input.actor.id,
      permission: input.approvalPermissionKey ?? null,
      module: "admin.control_plane",
      operation: input.commandType,
      target: `${input.target.type}:${input.target.id}`,
      coordinationKey: input.coordinationKey ?? null,
      expectedVersion: input.expectedVersion ?? null,
      outcome,
      errorCode,
      duration,
      environment: input.environment,
    };
    if (errorCode) logger.warn(context, "admin command acceptance failed");
    else logger.info(context, "admin command accepted");
  }
}

export interface ClaimControlPlaneCommandInput {
  readonly commandId: string;
  readonly workerId: string;
  readonly leaseMs: number;
  readonly now?: Date;
}

export async function claimControlPlaneCommand(
  db: PrismaClient,
  input: ClaimControlPlaneCommandInput,
) {
  const now = input.now ?? new Date();
  const candidate = await db.controlPlaneCommand.findUnique({ where: { id: input.commandId } });
  if (!candidate || candidate.status !== "accepted" || candidate.leaseOwner !== null || candidate.attemptCount >= candidate.maxAttempts) {
    return null;
  }
  const attemptNo = candidate.attemptCount + 1;
  const leaseExpiresAt = new Date(now.getTime() + Math.max(1, input.leaseMs));
  return db.$transaction(async (tx) => {
    const claimed = await transitionControlPlaneCommand(tx, {
      commandId: input.commandId,
      to: "running",
      expected: { from: "accepted", leaseOwner: null, attemptCount: candidate.attemptCount },
      data: {
        leaseOwner: input.workerId,
        leaseExpiresAt,
        heartbeatAt: now,
        attemptCount: attemptNo,
      },
      onConflict: "return-null",
    });
    if (!claimed) return null;
    await tx.controlPlaneCommandAttempt.create({
      data: { commandId: input.commandId, attemptNo, status: "running", startedAt: now },
    });
    return claimed;
  });
}

export async function reconcileExpiredCommandLeases(
  db: PrismaClient,
  now = new Date(),
  input: { readonly commandIds?: readonly string[] } = {},
) {
  const expired = await db.controlPlaneCommand.findMany({
    where: {
      id: input.commandIds ? { in: [...input.commandIds] } : undefined,
      status: { in: ["running", "verifying"] },
      leaseExpiresAt: { lt: now },
    },
    orderBy: [{ leaseExpiresAt: "asc" }, { id: "asc" }],
  });

  let requeued = 0;
  let failed = 0;
  for (const command of expired) {
    await db.$transaction(async (tx) => {
      const exhausted = command.attemptCount >= command.maxAttempts;
      const canReplay = command.retryMode === "idempotent" && !exhausted;
      const nextStatus = canReplay ? "accepted" : "failed";
      const updated = await transitionControlPlaneCommand(tx, {
        commandId: command.id,
        to: nextStatus,
        expected: {
          from: command.status === "running" ? "running" : "verifying",
          leaseOwner: command.leaseOwner,
          leaseExpiresAt: command.leaseExpiresAt,
          attemptCount: command.attemptCount,
        },
        data: {
          needsReconciliation: !canReplay,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          finishedAt: canReplay ? null : now,
          error: canReplay
            ? undefined
            : toInputJson({
                code: exhausted ? "lease_expired_max_attempts" : "lease_expired_non_replayable",
                attemptCount: command.attemptCount,
                retryMode: command.retryMode,
              }),
        },
        onConflict: "return-null",
      });
      if (!updated) return;
      await transitionControlPlaneCommandAttempt(tx, {
        commandId: command.id,
        attemptNo: command.attemptCount,
        to: "failed",
        data: {
          finishedAt: now,
          error: toInputJson({ code: "lease_expired", leaseOwner: command.leaseOwner }),
        },
      });
      if (canReplay) requeued += 1;
      else failed += 1;
    });
  }
  if (requeued > 0) {
    incrementCounter(
      "admin_command_lease_expired_total",
      "Expired admin command leases by recovery outcome",
      { outcome: "requeued" },
      requeued,
    );
  }
  if (failed > 0) {
    incrementCounter(
      "admin_command_lease_expired_total",
      "Expired admin command leases by recovery outcome",
      { outcome: "failed" },
      failed,
    );
  }
  return { examined: expired.length, requeued, failed };
}
