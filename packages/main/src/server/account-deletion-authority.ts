import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  MAIN_TO_CHAT_EVENTS,
  accountDeletionRequestedV2PayloadSchema,
  durableEventEnvelopeSchema,
} from "@idream/shared/contracts";
import type { ChatAccountErasureCompletedV2Payload } from "@idream/shared/contracts";
import { recordMainToChatEvent } from "@/processes/chat-outbox";
import type { BlobStore } from "@/server/providers/types";
import { providers } from "@/server/providers";
import { prisma } from "@/server/lib/db";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import {
  transitionCharacterProject,
  updateRetiredCharacterProjectMetadata,
} from "@/server/modules/admin-v2/characters/transition";

const DAY_MS = 24 * 60 * 60 * 1_000;

// SPEC: docs/architecture/07-security-and-compliance.md §6 requires a real
// grace period before erasure. Access is revoked immediately; authority data is
// not erased and the v2 deletion request is not delivered to Chat until due.
export const ACCOUNT_DELETION_GRACE_PERIOD_MS = 30 * DAY_MS;

export type AccountDeletionRequest = {
  readonly id: string;
  readonly status: "awaiting_chat";
  readonly requestedAt: Date;
  readonly graceEndsAt: Date;
  readonly created: boolean;
};

/**
 * Deep interface for the user-triggered half of account erasure. Session
 * revocation, workflow receipt, and the delayed Chat intent commit together.
 */
export async function requestAccountDeletion(
  tx: Prisma.TransactionClient,
  input: {
    readonly userId: string;
    readonly now?: Date;
    readonly gracePeriodMs?: number;
  },
): Promise<AccountDeletionRequest> {
  const now = input.now ?? new Date();
  const gracePeriodMs = input.gracePeriodMs ?? ACCOUNT_DELETION_GRACE_PERIOD_MS;
  if (!Number.isSafeInteger(gracePeriodMs) || gracePeriodMs <= 0) {
    throw new Error("Account deletion grace period must be a positive integer");
  }
  const subjectHash = sha256(input.userId);
  const id = `account_deletion_${subjectHash.slice(0, 32)}`;
  const chatRequestEventId = `user_deleted_${input.userId}`;
  const graceEndsAt = new Date(now.getTime() + gracePeriodMs);

  await tx.$queryRaw(Prisma.sql`
    SELECT id FROM users WHERE id = ${input.userId} FOR UPDATE
  `);
  const existing = await tx.accountDeletion.findUnique({ where: { subjectHash } });
  if (existing) {
    if (!existing.userId || existing.status !== "awaiting_chat") {
      throw new Error("Account deletion has already advanced past its grace period");
    }
    return {
      id: existing.id,
      status: "awaiting_chat",
      requestedAt: existing.requestedAt,
      graceEndsAt: existing.graceEndsAt,
      created: false,
    };
  }

  await tx.user.update({
    where: { id: input.userId },
    data: { status: "deleted", deletedAt: now },
  });
  await tx.session.deleteMany({ where: { userId: input.userId } });
  const deletion = await tx.accountDeletion.create({
    data: {
      id,
      userId: input.userId,
      subjectHash,
      status: "awaiting_chat",
      requestedAt: now,
      graceEndsAt,
      chatRequestEventId,
    },
  });
  await recordMainToChatEvent(
    {
      eventId: chatRequestEventId,
      eventType: MAIN_TO_CHAT_EVENTS.accountDeletionRequestedV2,
      schemaVersion: 2,
      aggregateType: "user",
      aggregateId: input.userId,
      payload: { userId: input.userId },
      occurredAt: now,
      deliverAfter: graceEndsAt,
    },
    tx,
  );
  return {
    id: deletion.id,
    status: "awaiting_chat",
    requestedAt: deletion.requestedAt,
    graceEndsAt: deletion.graceEndsAt,
    created: true,
  };
}

export function accountDeletionPublicState(deletion: AccountDeletionRequest) {
  return {
    id: deletion.id,
    status: deletion.status,
    gracePeriodMs:
      deletion.graceEndsAt.getTime() - deletion.requestedAt.getTime(),
    requestedAt: deletion.requestedAt.toISOString(),
    graceEndsAt: deletion.graceEndsAt.toISOString(),
  };
}

/**
 * Accept Chat's exact terminal receipt and materialize every currently-owned
 * Blob delete intent in the same transaction. No Main PII is removed here.
 */
export async function acceptChatAccountErasureCompletion(
  tx: Prisma.TransactionClient,
  input: {
    readonly sourceEventId: string;
    readonly aggregateId: string;
    readonly payload: ChatAccountErasureCompletedV2Payload;
    readonly now?: Date;
  },
) {
  const now = input.now ?? new Date();
  if (input.aggregateId !== input.payload.userId) {
    throw new Error("Account erasure aggregateId does not match payload.userId");
  }
  const subjectHash = sha256(input.payload.userId);
  await tx.$queryRaw(Prisma.sql`
    SELECT id FROM account_deletions
    WHERE "subjectHash" = ${subjectHash}
    FOR UPDATE
  `);
  const deletion = await tx.accountDeletion.findUnique({
    where: { subjectHash },
  });
  if (!deletion) {
    throw new Error("Account erasure has no Main deletion authority");
  }
  if (deletion.chatCompletionEventId) {
    if (!matchesDeletionRequestAuthority(deletion, input.payload)) {
      throw new Error("Account erasure Chat completion request authority changed");
    }
    // A pre-cutover binary may already have advanced (or even completed) the
    // deletion under its legacy completion event. Keep that immutable terminal
    // identity, but ACK the later request-bound proof so Chat can close the v2
    // transport after a forward deploy. Completed rows intentionally no longer
    // retain userId/chatRequestEventId, hence the deterministic identity check.
    return deletion;
  }
  if (deletion.status !== "awaiting_chat") {
    throw new Error(`Account erasure cannot accept Chat completion from ${deletion.status}`);
  }
  if (deletion.graceEndsAt.getTime() > now.getTime()) {
    throw new Error("Account erasure Chat completion arrived before graceEndsAt");
  }
  if (!deletion.chatRequestEventId) {
    throw new Error("Account erasure has no Chat request authority");
  }
  if (input.payload.deletionRequestEventId !== deletion.chatRequestEventId) {
    throw new Error("Account erasure Chat completion request authority changed");
  }
  // PrismaPg uses one pg client for this interactive transaction. Keep every
  // query serialized; Promise.all would re-enter that client.
  const user = await tx.user.findUnique({
    where: { id: input.payload.userId },
    select: { status: true, deletedAt: true },
  });
  const dispatched = await tx.mainOutboxEvent.findUnique({
    where: { id: deletion.chatRequestEventId },
    select: {
      eventType: true,
      aggregateType: true,
      aggregateId: true,
      status: true,
      nextRunAt: true,
      payload: true,
    },
  });
  if (user?.status !== "deleted" || !user.deletedAt) {
    throw new Error("Account erasure requires a deleted Main user authority");
  }
  const requestEnvelope = dispatched
    ? durableEventEnvelopeSchema.parse(dispatched.payload)
    : null;
  const requestPayload = requestEnvelope
    ? accountDeletionRequestedV2PayloadSchema.parse(requestEnvelope.payload)
    : null;
  if (
    dispatched?.eventType !== MAIN_TO_CHAT_EVENTS.accountDeletionRequestedV2 ||
    dispatched.aggregateType !== "user" ||
    dispatched.aggregateId !== input.payload.userId ||
    !["pending", "delivered"].includes(dispatched.status) ||
    dispatched.nextRunAt.getTime() > now.getTime() ||
    !requestEnvelope ||
    !requestPayload ||
    requestEnvelope.sourceService !== "main" ||
    requestEnvelope.sourceEventId !== deletion.chatRequestEventId ||
    requestEnvelope.eventType !== MAIN_TO_CHAT_EVENTS.accountDeletionRequestedV2 ||
    requestEnvelope.schemaVersion !== 2 ||
    requestEnvelope.aggregateType !== "user" ||
    requestEnvelope.aggregateId !== input.payload.userId ||
    requestPayload.userId !== input.payload.userId
  ) {
    throw new Error("Account erasure requires due exact v2 deletion authority");
  }

  const activeLegalHold = await findActiveAccountDeletionLegalHold(
    tx,
    input.payload.userId,
  );
  if (activeLegalHold) {
    return tx.accountDeletion.update({
      where: { id: deletion.id },
      data: {
        status: "finalizing",
        chatCompletionEventId: input.sourceEventId,
        chatFileMutationId: input.payload.fileMutationId,
        chatCompletedAt: now,
        blobExpectedCount: 0,
        blobDeletedCount: 0,
        lastError: toInputJson(activeLegalHoldError(activeLegalHold.id)),
        version: { increment: 1 },
      },
    });
  }

  await materializeCurrentBlobDeletes(tx, deletion, now);
  const blobExpectedCount = await tx.accountDeletionBlobReceipt.count({
    where: { deletionId: deletion.id },
  });
  return tx.accountDeletion.update({
    where: { id: deletion.id },
    data: {
      status: blobExpectedCount > 0 ? "deleting_blobs" : "finalizing",
      chatCompletionEventId: input.sourceEventId,
      chatFileMutationId: input.payload.fileMutationId,
      chatCompletedAt: now,
      blobExpectedCount,
      blobDeletedCount: 0,
      version: { increment: 1 },
    },
  });
}

function matchesDeletionRequestAuthority(
  deletion: {
    readonly status: string;
    readonly subjectHash: string;
    readonly chatRequestEventId: string | null;
  },
  payload: ChatAccountErasureCompletedV2Payload,
) {
  if (deletion.subjectHash !== sha256(payload.userId)) return false;
  if (deletion.chatRequestEventId) {
    return payload.deletionRequestEventId === deletion.chatRequestEventId;
  }
  if (deletion.status !== "completed") return false;
  return [
    `user_deleted_${payload.userId}`,
    `user_deleted_account_deletion_${deletion.subjectHash.slice(0, 32)}`,
  ].includes(payload.deletionRequestEventId);
}

export function accountDeletionSubjectHash(value: string) {
  return sha256(value);
}

type AccountDeletionDb = PrismaClient;

export async function dispatchPendingAccountDeletionBlobDeletes(input: {
  readonly blob?: BlobStore;
  readonly db?: AccountDeletionDb;
  readonly now?: Date;
  readonly workerId?: string;
  readonly batch?: number;
  readonly deletionIds?: readonly string[];
} = {}): Promise<{ deleted: number; failed: number; completed: number }> {
  const db = input.db ?? prisma;
  const blob = input.blob ?? providers.blob;
  const now = input.now ?? new Date();
  const workerId = input.workerId ?? `account-deletion-${randomUUID()}`;
  const batch = Math.max(1, Math.min(input.batch ?? 25, 100));
  const deletionIds = input.deletionIds
    ? [...new Set(input.deletionIds)]
    : undefined;
  await db.accountDeletionBlobReceipt.updateMany({
    where: {
      status: "processing",
      leaseExpiresAt: { lte: now },
      deletion: {
        status: { in: ["deleting_blobs", "finalizing"] },
        graceEndsAt: { lte: now },
        chatCompletedAt: { not: null },
      },
      ...(deletionIds ? { deletionId: { in: deletionIds } } : {}),
    },
    data: {
      status: "pending",
      leaseOwner: null,
      leaseExpiresAt: null,
      nextAttemptAt: now,
    },
  });
  const rows = await db.accountDeletionBlobReceipt.findMany({
    where: {
      status: "pending",
      nextAttemptAt: { lte: now },
      deletion: {
        status: { in: ["deleting_blobs", "finalizing"] },
        graceEndsAt: { lte: now },
        chatCompletedAt: { not: null },
      },
      ...(deletionIds ? { deletionId: { in: deletionIds } } : {}),
    },
    orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
    take: batch,
  });
  let deleted = 0;
  let failed = 0;
  const touchedDeletionIds = new Set<string>();
  for (const row of rows) {
    const held = await db.$transaction(async (tx) => {
      const deletion = await tx.accountDeletion.findUnique({
        where: { id: row.deletionId },
        select: { userId: true },
      });
      if (!deletion?.userId) return false;
      const hold = await findActiveAccountDeletionLegalHold(tx, deletion.userId);
      if (!hold) return false;
      await tx.accountDeletion.updateMany({
        where: {
          id: row.deletionId,
          status: { in: ["deleting_blobs", "finalizing"] },
        },
        data: {
          status: "finalizing",
          lastError: toInputJson(activeLegalHoldError(hold.id)),
          version: { increment: 1 },
        },
      });
      return true;
    });
    if (held) {
      touchedDeletionIds.add(row.deletionId);
      continue;
    }
    const leaseExpiresAt = new Date(now.getTime() + 60_000);
    const claimed = await db.accountDeletionBlobReceipt.updateMany({
      where: {
        id: row.id,
        status: "pending",
        attempts: row.attempts,
        nextAttemptAt: { lte: now },
      },
      data: {
        status: "processing",
        attempts: { increment: 1 },
        leaseOwner: workerId,
        leaseExpiresAt,
      },
    });
    if (claimed.count !== 1) continue;
    touchedDeletionIds.add(row.deletionId);
    const key = row.storageKey;
    if (!key) {
      await requeueBlobDelete(db, row.id, workerId, row.attempts + 1, now, {
        code: "account_deletion_blob_key_missing",
        message: "Pending account deletion Blob receipt has no storage key",
        retryable: false,
      });
      failed += 1;
      continue;
    }
    let result: Awaited<ReturnType<BlobStore["delete"]>>;
    try {
      result = await blob.delete({ key });
    } catch (error) {
      result = {
        ok: false,
        error: {
          code: "account_deletion_blob_delete_threw",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
      };
    }
    if (!result.ok) {
      await requeueBlobDelete(
        db,
        row.id,
        workerId,
        row.attempts + 1,
        now,
        result.error,
      );
      failed += 1;
      continue;
    }
    const terminal = await db.accountDeletionBlobReceipt.updateMany({
      where: {
        id: row.id,
        status: "processing",
        leaseOwner: workerId,
        attempts: row.attempts + 1,
      },
      data: {
        status: "deleted",
        deletedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: Prisma.DbNull,
      },
    });
    deleted += terminal.count;
  }

  for (const deletionId of touchedDeletionIds) {
    await refreshBlobReceiptCounts(db, deletionId);
  }
  const finalizationDeletionIds = deletionIds
    ? [...new Set([...deletionIds, ...touchedDeletionIds])]
    : undefined;
  const completed = await finalizeReadyAccountDeletions({
    db,
    now,
    ...(finalizationDeletionIds
      ? { deletionIds: finalizationDeletionIds }
      : {}),
  });
  return { deleted, failed, completed };
}

async function requeueBlobDelete(
  db: AccountDeletionDb,
  receiptId: string,
  workerId: string,
  attemptNo: number,
  now: Date,
  error: { code: string; message: string; retryable: boolean },
) {
  const delayMs = Math.min(30 * 60_000, 30_000 * Math.max(1, attemptNo));
  await db.accountDeletionBlobReceipt.updateMany({
    where: {
      id: receiptId,
      status: "processing",
      leaseOwner: workerId,
      attempts: attemptNo,
    },
    data: {
      status: "pending",
      leaseOwner: null,
      leaseExpiresAt: null,
      nextAttemptAt: new Date(now.getTime() + delayMs),
      lastError: toInputJson(error),
    },
  });
}

async function refreshBlobReceiptCounts(
  db: AccountDeletionDb,
  deletionId: string,
) {
  const expected = await db.accountDeletionBlobReceipt.count({
    where: { deletionId },
  });
  const deleted = await db.accountDeletionBlobReceipt.count({
    where: { deletionId, status: "deleted" },
  });
  await db.accountDeletion.updateMany({
    where: { id: deletionId, status: { in: ["deleting_blobs", "finalizing"] } },
    data: {
      blobExpectedCount: expected,
      blobDeletedCount: deleted,
      ...(expected === deleted ? { status: "finalizing" } : {}),
      version: { increment: 1 },
    },
  });
}

export async function finalizeReadyAccountDeletions(input: {
  readonly db?: AccountDeletionDb;
  readonly now?: Date;
  readonly deletionIds?: readonly string[];
} = {}): Promise<number> {
  const db = input.db ?? prisma;
  const now = input.now ?? new Date();
  const candidates = await db.accountDeletion.findMany({
    where: {
      status: { in: ["deleting_blobs", "finalizing"] },
      graceEndsAt: { lte: now },
      chatCompletedAt: { not: null },
      ...(input.deletionIds
        ? { id: { in: [...new Set(input.deletionIds)] } }
        : {}),
    },
    orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  let completed = 0;
  for (const candidate of candidates) {
    const didComplete = await db.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT id FROM account_deletions WHERE id = ${candidate.id} FOR UPDATE
      `);
      const deletion = await tx.accountDeletion.findUniqueOrThrow({
        where: { id: candidate.id },
      });
      if (
        !["deleting_blobs", "finalizing"].includes(deletion.status) ||
        !deletion.userId ||
        !deletion.chatCompletedAt ||
        deletion.graceEndsAt.getTime() > now.getTime()
      ) {
        return false;
      }

      // Lock the User root before checking Generation. It blocks a new
      // GenerationJob FK from appearing between the quiescence check and the
      // final User delete.
      await tx.$queryRaw(Prisma.sql`
        SELECT id FROM users WHERE id = ${deletion.userId} FOR UPDATE
      `);
      if (!await lockAndCheckGenerationAuthorityTerminal(tx, deletion.userId)) {
        await tx.accountDeletion.update({
          where: { id: deletion.id },
          data: {
            status: "finalizing",
            lastError: toInputJson({
              code: "account_deletion_generation_authority_pending",
              message: "Generation authority is not terminal yet",
            }),
            version: { increment: 1 },
          },
        });
        return false;
      }

      const activeLegalHold = await findActiveAccountDeletionLegalHold(
        tx,
        deletion.userId,
      );
      if (activeLegalHold) {
        await tx.accountDeletion.update({
          where: { id: deletion.id },
          data: {
            status: "finalizing",
            lastError: toInputJson(activeLegalHoldError(activeLegalHold.id)),
            version: { increment: 1 },
          },
        });
        return false;
      }

      // A provider result may race the original enumeration. Re-scan under the
      // same deletion lock; newly observed owned keys become durable work and
      // force another worker pass instead of being silently orphaned.
      const added = await materializeCurrentBlobDeletes(tx, deletion, now);
      const expected = await tx.accountDeletionBlobReceipt.count({
        where: { deletionId: deletion.id },
      });
      const terminal = await tx.accountDeletionBlobReceipt.count({
        where: { deletionId: deletion.id, status: "deleted" },
      });
      if (added > 0 || expected !== terminal) {
        await tx.accountDeletion.update({
          where: { id: deletion.id },
          data: {
            status: "deleting_blobs",
            blobExpectedCount: expected,
            blobDeletedCount: terminal,
            version: { increment: 1 },
          },
        });
        return false;
      }
      await tx.accountDeletion.update({
        where: { id: deletion.id },
        data: { status: "finalizing", version: { increment: 1 } },
      });
      await hardDeleteMainAccountAuthority(tx, {
        deletionId: deletion.id,
        userId: deletion.userId,
        subjectHash: deletion.subjectHash,
        now,
      });
      return true;
    }, { maxWait: 10_000, timeout: 60_000 });
    if (didComplete) completed += 1;
  }
  return completed;
}

async function findActiveAccountDeletionLegalHold(
  tx: Prisma.TransactionClient,
  userId: string,
) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT hold.id
    FROM legal_holds AS hold
    WHERE hold.status = 'active'
      AND (
        (hold."targetType" = 'user' AND hold."targetId" = ${userId})
        OR (
          hold."targetType" = 'media'
          AND EXISTS (
            SELECT 1 FROM media_assets AS media
            WHERE media.id = hold."targetId"
              AND media."ownerId" = ${userId}
          )
        )
        OR (
          hold."targetType" = 'generation_job'
          AND EXISTS (
            SELECT 1 FROM generation_jobs AS job
            WHERE job.id = hold."targetId"
              AND job."userId" = ${userId}
          )
        )
      )
    ORDER BY hold."createdAt" ASC, hold.id ASC
    LIMIT 1
  `);
  return rows[0] ?? null;
}

function activeLegalHoldError(legalHoldId: string) {
  return {
    code: "account_deletion_active_legal_hold",
    message: "Account erasure is paused while retained evidence has an active legal hold",
    legalHoldId,
  };
}

async function materializeCurrentBlobDeletes(
  tx: Prisma.TransactionClient,
  deletion: { id: string; userId: string | null; subjectHash: string },
  now: Date,
) {
  if (!deletion.userId) return 0;
  const rows = await tx.mediaAsset.findMany({
    where: { ownerId: deletion.userId, storageKey: { not: null } },
    select: { storageKey: true },
  });
  const requestRows = await tx.generationJob.findMany({
    where: { userId: deletion.userId },
    select: { id: true },
  });
  const requestIds = requestRows.map((row) => row.id);
  const attemptRows = requestIds.length > 0
    ? await tx.generationAttempt.findMany({
        where: { requestId: { in: requestIds } },
        select: { id: true, terminalRecordRef: true },
      })
    : [];
  const attemptIds = attemptRows.map((row) => row.id);
  const transportRows = attemptIds.length > 0
    ? await tx.generationTransportExecution.findMany({
        where: { attemptId: { in: attemptIds } },
        select: { terminalRecordRef: true },
      })
    : [];
  const terminalOutboxes = attemptIds.length > 0
    ? await tx.mainOutboxEvent.findMany({
        where: {
          eventType: "generation.terminal_record.accepted.v1",
          aggregateType: "generation_attempt",
          aggregateId: { in: attemptIds },
        },
        select: { payload: true },
      })
    : [];
  const lateEvents = requestIds.length > 0
    ? await tx.generationJobEvent.findMany({
        where: {
          jobId: { in: requestIds },
          type: {
            in: [
              "late_artifact_archived",
              "unknown_terminal_evidence_recovered",
              "unknown_terminal_resolution_evidence_recovered",
            ],
          },
        },
        select: { metadata: true },
      })
    : [];
  const keys = new Set(rows.flatMap((row) =>
    row.storageKey?.trim() ? [row.storageKey.trim()] : [],
  ));
  for (const row of attemptRows) {
    if (row.terminalRecordRef?.trim()) keys.add(row.terminalRecordRef.trim());
  }
  for (const row of transportRows) {
    if (row.terminalRecordRef?.trim()) keys.add(row.terminalRecordRef.trim());
  }
  for (const row of terminalOutboxes) {
    for (const key of generationBlobKeys(row.payload)) keys.add(key);
  }
  for (const row of lateEvents) {
    for (const key of generationBlobKeys(row.metadata)) keys.add(key);
  }
  const data = [...keys].map((storageKey) => {
    const storageKeyHash = sha256(storageKey);
    return {
      id: `account_blob_${deletion.subjectHash.slice(0, 16)}_${storageKeyHash.slice(0, 24)}`,
      deletionId: deletion.id,
      storageKey,
      storageKeyHash,
      status: "pending",
      nextAttemptAt: now,
    };
  });
  if (data.length === 0) return 0;
  const existing = await tx.accountDeletionBlobReceipt.count({
    where: { deletionId: deletion.id },
  });
  await tx.accountDeletionBlobReceipt.createMany({ data, skipDuplicates: true });
  const current = await tx.accountDeletionBlobReceipt.count({
    where: { deletionId: deletion.id },
  });
  return current - existing;
}

async function lockAndCheckGenerationAuthorityTerminal(
  tx: Prisma.TransactionClient,
  userId: string,
) {
  // A retry reservation locks the Generation Request before it creates the
  // next Attempt. Take the same lock first so it cannot commit a new Attempt
  // between this terminal check and the User->GenerationJob cascade. The User
  // root is already locked by the caller, which also fences brand-new Requests.
  await tx.$queryRaw(Prisma.sql`
    SELECT id FROM generation_jobs
    WHERE "userId" = ${userId}
    ORDER BY id
    FOR UPDATE
  `);
  const requests = await tx.generationJob.findMany({
    where: { userId },
    select: { id: true, status: true },
  });
  if (requests.length === 0) return true;
  const requestIds = requests.map((row) => row.id);
  const attemptIds = await tx.generationAttempt.findMany({
    where: { requestId: { in: requestIds } },
    select: { id: true },
  });
  if (attemptIds.length > 0) {
    await tx.$queryRaw(Prisma.sql`
      SELECT id FROM generation_attempts
      WHERE id IN (${Prisma.join(attemptIds.map((row) => row.id))})
      ORDER BY id
      FOR UPDATE
    `);
  }
  const attempts = await tx.generationAttempt.findMany({
    where: { requestId: { in: requestIds } },
    select: { id: true, status: true },
  });
  if (requests.some((row) =>
    ["queued", "moderating_input", "running", "moderating_output"].includes(row.status)
  )) {
    return false;
  }
  if (attempts.some((row) =>
    ["queued", "running", "unknown"].includes(row.status)
  )) {
    return false;
  }
  if (attempts.length === 0) return true;
  const unresolvedTransports = await tx.generationTransportExecution.count({
    where: {
      attemptId: { in: attempts.map((row) => row.id) },
      status: { in: ["running", "unknown"] },
    },
  });
  return unresolvedTransports === 0;
}

function generationBlobKeys(value: Prisma.JsonValue) {
  const root = jsonRecord(value);
  const completed = root.kind === "generation.completed"
    ? root
    : jsonRecord(root.recoveredSuccess);
  const terminalRefs = [root.terminalRecordRef, completed.terminalRecordRef]
    .flatMap((key) => typeof key === "string" && key.trim() ? [key.trim()] : []);
  if (completed.kind !== "generation.completed" || !Array.isArray(completed.assets)) {
    return terminalRefs;
  }
  return [...terminalRefs, ...completed.assets.flatMap((asset) => {
    const key = jsonRecord(asset).key;
    return typeof key === "string" && key.trim() ? [key.trim()] : [];
  })];
}

async function hardDeleteMainAccountAuthority(
  tx: Prisma.TransactionClient,
  input: {
    readonly deletionId: string;
    readonly userId: string;
    readonly subjectHash: string;
    readonly now: Date;
  },
) {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id = ${input.userId} FOR UPDATE`);
  const user = await tx.user.findUnique({
    where: { id: input.userId },
    select: { id: true, email: true },
  });
  if (!user) {
    throw new Error("Main account disappeared before terminal erasure receipt");
  }
  const erasedSubjectRef = `erased:${input.subjectHash}`;
  const ledger = await tx.dreamcoinLedger.findMany({
    where: { userId: input.userId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (ledger.length > 0) {
    await tx.erasedDreamcoinLedgerEntry.createMany({
      data: ledger.map((entry) => ({
        id: `erased_ledger_${sha256(`${input.deletionId}:${entry.id}`).slice(0, 32)}`,
        deletionId: input.deletionId,
        sourceEntryHash: sha256(entry.id),
        sourceIdHash: entry.sourceId ? sha256(entry.sourceId) : null,
        delta: entry.delta,
        balanceAfter: entry.balanceAfter,
        reason: entry.reason,
        occurredAt: entry.createdAt,
        archivedAt: input.now,
      })),
      skipDuplicates: true,
    });
  }

  const characters = await tx.character.findMany({
    where: { creatorId: input.userId },
    select: { id: true },
  });
  const characterIds = characters.map((row) => row.id);
  const media = await tx.mediaAsset.findMany({
    where: { ownerId: input.userId },
    select: { id: true },
  });
  const mediaIds = media.map((row) => row.id);
  const requests = await tx.generationJob.findMany({
    where: { userId: input.userId },
    select: { id: true },
  });
  const requestIds = requests.map((row) => row.id);
  const attempts = requestIds.length > 0
    ? await tx.generationAttempt.findMany({
        where: { requestId: { in: requestIds } },
        select: { id: true },
      })
    : [];
  const attemptIds = attempts.map((row) => row.id);
  const projects = await tx.characterProject.findMany({
    where: {
      OR: [
        { ownerId: input.userId },
        ...(characterIds.length > 0 ? [{ characterId: { in: characterIds } }] : []),
      ],
    },
    select: { id: true, characterId: true, phase: true },
  });
  const projectIds = projects.map((row) => row.id);
  const releases = projectIds.length > 0
    ? await tx.characterRelease.findMany({
        where: { projectId: { in: projectIds } },
        select: { id: true, projectId: true },
      })
    : [];
  const releaseIds = releases.map((row) => row.id);
  const qualifications = releaseIds.length > 0
    ? await tx.publicCatalogQualification.findMany({
        where: { releaseId: { in: releaseIds } },
        select: { releaseId: true, validationRunId: true },
      })
    : [];
  const retainedReleaseIds = new Set(
    qualifications.map((qualification) => qualification.releaseId),
  );
  const retainedProjectIds = new Set(
    releases
      .filter((release) => retainedReleaseIds.has(release.id))
      .map((release) => release.projectId),
  );
  const retainedValidationRunIds = new Set(
    qualifications.flatMap((qualification) =>
      qualification.validationRunId ? [qualification.validationRunId] : [],
    ),
  );
  const deletableReleaseIds = releaseIds.filter(
    (releaseId) => !retainedReleaseIds.has(releaseId),
  );
  const validationRuns = releaseIds.length > 0
    ? await tx.releaseValidationRun.findMany({
        where: { releaseId: { in: releaseIds } },
        select: { id: true },
      })
    : [];
  const deletableValidationRunIds = validationRuns
    .map((row) => row.id)
    .filter((validationRunId) => !retainedValidationRunIds.has(validationRunId));

  // Release/serving rows use scalar IDs rather than a complete Prisma relation
  // graph, so delete their pointers explicitly before the Character root.
  if (characterIds.length > 0) {
    await tx.character.updateMany({
      where: { id: { in: characterIds } },
      data: { currentContentVersionId: null, imageAssetId: null },
    });
    await tx.characterServing.deleteMany({ where: { characterId: { in: characterIds } } });
    await tx.characterQaRun.deleteMany({ where: { characterId: { in: characterIds } } });
    await tx.characterReleaseEvent.deleteMany({ where: { characterId: { in: characterIds } } });
    await tx.characterFunnelDaily.deleteMany({ where: { characterId: { in: characterIds } } });
    await tx.characterEconomicsFact.deleteMany({ where: { characterId: { in: characterIds } } });
  }
  if (releaseIds.length > 0) {
    // INVARIANT: public qualification is immutable publication evidence and
    // its database authority forbids DELETE. Revoke it once, then preserve the
    // exact Release/Validation rows it pins while user-owned content is erased.
    await tx.publicCatalogQualification.updateMany({
      where: {
        releaseId: { in: releaseIds },
        revokedAt: null,
      },
      data: { revokedAt: input.now },
    });
    await tx.releaseMonitor.deleteMany({ where: { releaseId: { in: releaseIds } } });
    await tx.characterReleaseEvent.deleteMany({ where: { releaseId: { in: releaseIds } } });
  }
  if (deletableValidationRunIds.length > 0) {
    await tx.releaseCheckResult.deleteMany({
      where: { validationRunId: { in: deletableValidationRunIds } },
    });
    await tx.releaseValidationRun.deleteMany({
      where: { id: { in: deletableValidationRunIds } },
    });
  }
  if (deletableReleaseIds.length > 0) {
    await tx.characterRelease.deleteMany({
      where: { id: { in: deletableReleaseIds } },
    });
  }
  if (projectIds.length > 0) {
    await tx.characterRevision.deleteMany({ where: { projectId: { in: projectIds } } });
    for (const project of projects) {
      if (!retainedProjectIds.has(project.id)) continue;
      const anonymizedProject = {
        characterId: `erased:${sha256(project.characterId)}`,
        ownerId: null,
        audience: {},
        hypothesis: null,
        differentiation: null,
        successCriteria: {},
        plannedLaunchAt: null,
        draftImageAssetId: null,
        draftAssetPack: {},
        activeKey: null,
      } satisfies Prisma.CharacterProjectUncheckedUpdateManyInput;
      if (project.phase === "retired") {
        await updateRetiredCharacterProjectMetadata(tx, {
          projectId: project.id,
          data: anonymizedProject,
        });
      } else {
        await transitionCharacterProject(tx, {
          projectId: project.id,
          to: "retired",
          data: anonymizedProject,
        });
      }
    }
    const deletableProjectIds = projectIds.filter(
      (projectId) => !retainedProjectIds.has(projectId),
    );
    if (deletableProjectIds.length > 0) {
      await tx.characterProject.deleteMany({
        where: { id: { in: deletableProjectIds } },
      });
    }
  }
  if (characterIds.length > 0) {
    await tx.character.deleteMany({ where: { id: { in: characterIds } } });
    await tx.characterContentVersion.deleteMany({
      where: { characterId: { in: characterIds } },
    });
  }

  // Remove cross-character pointers to user-owned bytes before User->Media
  // cascade. An owned object cannot remain authoritative through another row.
  if (mediaIds.length > 0) {
    await tx.character.updateMany({
      where: { imageAssetId: { in: mediaIds } },
      data: { imageAssetId: null },
    });
    await tx.characterTemplate.updateMany({
      where: { coverAssetId: { in: mediaIds } },
      data: { coverAssetId: null },
    });
    await tx.characterLook.updateMany({
      where: { referenceAssetId: { in: mediaIds } },
      data: { referenceAssetId: null },
    });
    await tx.characterVoiceProfile.deleteMany({
      where: {
        OR: [
          { referenceAssetId: { in: mediaIds } },
          { previewAssetId: { in: mediaIds } },
        ],
      },
    });
    await tx.characterVisualReferenceSnapshot.deleteMany({
      where: { mediaAssetId: { in: mediaIds } },
    });
    await tx.referenceCandidate.deleteMany({ where: { mediaAssetId: { in: mediaIds } } });
    await tx.generationArtifact.deleteMany({ where: { assetId: { in: mediaIds } } });
  }

  if (attemptIds.length > 0) {
    await tx.generationTransportExecution.deleteMany({
      where: { attemptId: { in: attemptIds } },
    });
    await tx.generationArtifact.deleteMany({ where: { attemptId: { in: attemptIds } } });
  }
  if (requestIds.length > 0) {
    await tx.generationDelivery.deleteMany({ where: { requestId: { in: requestIds } } });
    await tx.generationSettlementLink.deleteMany({ where: { requestId: { in: requestIds } } });
  }
  if (attemptIds.length > 0) {
    await tx.generationAttempt.deleteMany({ where: { id: { in: attemptIds } } });
  }

  // Generation outboxes are deliberately FK-free durability records. Remove
  // them by the Request/Attempt authorities collected above; their payloads
  // retain terminal Blob locators even though they do not repeat userId.
  if (requestIds.length > 0 || attemptIds.length > 0) {
    await tx.mainOutboxEvent.deleteMany({
      where: {
        OR: [
          ...(requestIds.length > 0
            ? [{ aggregateId: { in: requestIds } }]
            : []),
          ...(attemptIds.length > 0
            ? [{ aggregateId: { in: attemptIds } }]
            : []),
        ],
      },
    });
  }
  if (attemptIds.length > 0) {
    await tx.inboundEventReceipt.deleteMany({
      where: {
        sourceService: "gen",
        sourceEventId: { in: attemptIds },
      },
    });
  }

  // PII-bearing records whose User relation is SetNull or absent must not
  // survive as anonymous-looking copies of user content.
  await tx.ageGateAcceptance.deleteMany({ where: { userId: input.userId } });
  // Reports and legal holds are retained evidence. Replace direct subject
  // pointers before the User FK nulls the reporter identity.
  await tx.contentReport.updateMany({
    where: { targetType: "user", targetId: input.userId },
    data: { targetId: erasedSubjectRef },
  });
  await tx.moderationEvent.updateMany({
    where: { targetType: "user", targetId: input.userId },
    data: { targetId: erasedSubjectRef },
  });
  await tx.legalHold.updateMany({
    where: { targetType: "user", targetId: input.userId },
    data: { targetId: erasedSubjectRef },
  });
  await tx.legalHold.updateMany({
    where: { approvedById: input.userId },
    data: { approvedById: erasedSubjectRef },
  });
  await tx.legalHold.updateMany({
    where: { createdById: input.userId },
    data: { createdById: erasedSubjectRef },
  });
  await tx.legalHold.updateMany({
    where: { releasedById: input.userId },
    data: { releasedById: erasedSubjectRef },
  });
  await tx.productFeedbackItem.deleteMany({ where: { createdById: input.userId } });
  await tx.analyticsEvent.deleteMany({ where: { userId: input.userId } });
  await tx.customerSignupFact.deleteMany({ where: { userId: input.userId } });
  await tx.chatExchangeFact.deleteMany({ where: { userId: input.userId } });
  await tx.generationFulfillmentFact.deleteMany({ where: { userId: input.userId } });
  await tx.subscriptionLifecycleFact.deleteMany({ where: { userId: input.userId } });
  await tx.characterExposureFact.deleteMany({ where: { userId: input.userId } });
  await tx.companionEngagementDaily.deleteMany({ where: { userId: input.userId } });
  await tx.aiUsageFact.deleteMany({ where: { userId: input.userId } });
  await tx.supportConsentGrant.deleteMany({ where: { userId: input.userId } });
  // Audit rows are retained evidence, not user-owned content. Replace direct
  // subject pointers with the one-way deletion subject reference instead of
  // deleting the authority that proves what an operator did and when.
  await tx.adminAuditLog.updateMany({
    where: { actorId: input.userId },
    data: { actorId: erasedSubjectRef },
  });
  await tx.adminAuditLog.updateMany({
    where: { targetType: "user", targetId: input.userId },
    data: { targetId: erasedSubjectRef },
  });
  await tx.adminActionRequest.deleteMany({
    where: {
      OR: [
        { requestedById: input.userId },
        { approvedById: input.userId },
        { targetType: "user", targetId: input.userId },
      ],
    },
  });
  await tx.adminSavedView.deleteMany({ where: { ownerId: input.userId } });
  await tx.adminCollaborationActivity.deleteMany({ where: { actorId: input.userId } });
  await tx.adminUserPermission.deleteMany({ where: { userId: input.userId } });
  await tx.adminUserGrantBundle.deleteMany({ where: { userId: input.userId } });
  await tx.operationalWorkPreference.deleteMany({ where: { actorId: input.userId } });
  await tx.decisionRecord.deleteMany({ where: { ownerId: input.userId } });
  await tx.controlPlaneCommand.deleteMany({ where: { actorId: input.userId } });
  await tx.experimentAssignment.deleteMany({
    where: { subjectType: "user", subjectId: input.userId },
  });
  await tx.experimentExposureFact.deleteMany({
    where: { subjectType: "user", subjectId: input.userId },
  });
  await tx.verification.deleteMany({ where: { identifier: user.email } });

  // JSON payloads and loose operational rows have no User FK. Parameterized
  // SQL closes the exact-id projections without scanning or interpolating.
  await tx.$executeRaw(Prisma.sql`
    DELETE FROM provider_events
    WHERE payload->>'userId' = ${input.userId}
  `);
  await tx.$executeRaw(Prisma.sql`
    DELETE FROM main_outbox_events
    WHERE "aggregateId" = ${input.userId}
       OR payload->'payload'->>'userId' = ${input.userId}
       OR payload->>'userId' = ${input.userId}
  `);

  await tx.user.delete({ where: { id: input.userId } });
  await tx.accountDeletionBlobReceipt.updateMany({
    where: { deletionId: input.deletionId, status: "deleted" },
    data: { storageKey: null },
  });
  await tx.accountDeletion.update({
    where: { id: input.deletionId },
    data: {
      userId: null,
      status: "completed",
      chatRequestEventId: null,
      blobExpectedCount: { set: await tx.accountDeletionBlobReceipt.count({
        where: { deletionId: input.deletionId },
      }) },
      blobDeletedCount: { set: await tx.accountDeletionBlobReceipt.count({
        where: { deletionId: input.deletionId, status: "deleted" },
      }) },
      mainPurgedAt: input.now,
      completedAt: input.now,
      lastError: Prisma.DbNull,
      version: { increment: 1 },
    },
  });
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
