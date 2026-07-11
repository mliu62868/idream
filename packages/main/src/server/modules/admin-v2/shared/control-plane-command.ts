import { Prisma, type PrismaClient } from "@prisma/client";
import { canonicalSha256 } from "./canonical-json";

export interface CanonicalCommandRequest {
  readonly commandType: string;
  readonly target: { readonly type: string; readonly id: string };
  readonly expectedVersion?: number;
  readonly payload: unknown;
  readonly approvalId?: string;
}

export interface AcceptControlPlaneCommandInput extends CanonicalCommandRequest {
  readonly environment: string;
  readonly actor: { readonly id: string; readonly role: string };
  readonly idempotencyKey: string;
  readonly reason: string;
  readonly requestId: string;
  readonly maxAttempts?: number;
}

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

function inputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export function canonicalRequestHash(input: CanonicalCommandRequest): string {
  return canonicalSha256({
    commandType: input.commandType,
    target: input.target,
    expectedVersion: input.expectedVersion ?? null,
    payload: input.payload,
    approvalId: input.approvalId ?? null,
  });
}

async function resolveExisting(
  db: PrismaClient,
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
  const scope = `${input.environment}:${input.actor.id}`;
  const requestHash = canonicalRequestHash(input);
  const existing = await resolveExisting(db, scope, input.idempotencyKey, requestHash);
  if (existing) return existing;

  try {
    return await db.$transaction(async (tx) => {
      const command = await tx.controlPlaneCommand.create({
        data: {
          scope,
          idempotencyKey: input.idempotencyKey,
          commandType: input.commandType,
          targetType: input.target.type,
          targetId: input.target.id,
          actorId: input.actor.id,
          requestId: input.requestId,
          requestHash,
          expectedVersion: input.expectedVersion,
          approvalId: input.approvalId,
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
          after: inputJson({
            commandId: command.id,
            expectedVersion: input.expectedVersion ?? null,
            approvalId: input.approvalId ?? null,
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
          payload: inputJson({
            commandId: command.id,
            commandType: input.commandType,
            target: input.target,
            expectedVersion: input.expectedVersion ?? null,
            payload: input.payload,
            approvalId: input.approvalId ?? null,
            requestHash,
          }),
        },
      });
      return { commandId: command.id, status: command.status, replayed: false as const };
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const raced = await resolveExisting(db, scope, input.idempotencyKey, requestHash);
      if (raced) return raced;
    }
    throw error;
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
  if (
    !candidate ||
    candidate.status !== "accepted" ||
    candidate.leaseOwner !== null ||
    candidate.attemptCount >= candidate.maxAttempts
  ) {
    return null;
  }
  const attemptNo = candidate.attemptCount + 1;
  const leaseExpiresAt = new Date(now.getTime() + Math.max(1, input.leaseMs));
  return db.$transaction(async (tx) => {
    const claimed = await tx.controlPlaneCommand.updateMany({
      where: {
        id: input.commandId,
        status: "accepted",
        leaseOwner: null,
        attemptCount: candidate.attemptCount,
      },
      data: {
        status: "running",
        leaseOwner: input.workerId,
        leaseExpiresAt,
        heartbeatAt: now,
        attemptCount: attemptNo,
      },
    });
    if (claimed.count !== 1) return null;
    await tx.controlPlaneCommandAttempt.create({
      data: { commandId: input.commandId, attemptNo, status: "running", startedAt: now },
    });
    return tx.controlPlaneCommand.findUniqueOrThrow({ where: { id: input.commandId } });
  });
}

export async function reconcileExpiredCommandLeases(db: PrismaClient, now = new Date()) {
  const expired = await db.controlPlaneCommand.findMany({
    where: {
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
      const updated = await tx.controlPlaneCommand.updateMany({
        where: {
          id: command.id,
          status: command.status,
          leaseOwner: command.leaseOwner,
          leaseExpiresAt: command.leaseExpiresAt,
        },
        data: {
          status: exhausted ? "failed" : "accepted",
          needsReconciliation: exhausted,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          finishedAt: exhausted ? now : null,
          error: exhausted
            ? inputJson({ code: "lease_expired_max_attempts", attemptCount: command.attemptCount })
            : undefined,
        },
      });
      if (updated.count !== 1) return;
      await tx.controlPlaneCommandAttempt.updateMany({
        where: {
          commandId: command.id,
          attemptNo: command.attemptCount,
          status: "running",
        },
        data: {
          status: "failed",
          finishedAt: now,
          error: inputJson({ code: "lease_expired", leaseOwner: command.leaseOwner }),
        },
      });
      if (exhausted) failed += 1;
      else requeued += 1;
    });
  }
  return { examined: expired.length, requeued, failed };
}
