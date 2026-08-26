// SPEC: durable file-intent ledger (chat.chat_file_mutations). The file layer
// (mem/*.md plus the companion workspace) is authority but is NOT transactional, so no
// domain transaction may touch it directly. A writer commits an INTENT; a
// separate projector transaction performs the file effect. Recording an intent
// is therefore a promise with a precise meaning: it will be applied under the
// exclusive user advisory lock, over the projector connection, in `sequence`
// order, and before any read that goes through withReadableChatFileSnapshot can
// observe that user's files.
// INTENT: the capability split is enforced by PG role, not by convention —
// chat_service may only INSERT (id, user_id, kind, payload) and holds neither
// UPDATE nor DELETE, while chat_projector holds SELECT+UPDATE and none of the
// INSERT (db/sql/03_chat_tables.sql). Request code therefore cannot forge an
// "applied" receipt for a side effect that never landed, which is the whole
// reason this ledger exists instead of writing files inline.
// INVARIANTS:
//   - Exclusivity: the ledger flip to `applied` is a guarded updateMany whose
//     count must be 1. The file effect itself, however, runs BEFORE that
//     transaction commits, so a rollback replays it — every applyFileMutation
//     branch must stay idempotent (updateRelationshipOnce/setRelationshipOnce
//     are keyed by turn/mutation id).
//   - No self-projection: a writer takes the same user lock and then calls
//     assertNoPendingChatFileMutationsTx. A newly committed intent aborts and
//     retries the entire request (runWithProjectedChatFiles) rather than letting
//     request code drain the ledger on the projector's behalf. Turn-scoped
//     writers get that ordering from withTurnAuthority, which also ties the
//     post-commit projection to whether an intent was actually recorded. The
//     account-erasure and batch-repair paths deliberately stay outside it:
//     erasure supersedes every pending intent instead of asserting there are
//     none, so it must NOT fail closed on a poisoned row.
//   - Cross-service honesty: memoryExtractedAttempt and outbox events are
//     written in the SAME transaction that marks the row
//     applied, so main is never told about a file effect that did not land.
//   - Privacy: applying an intent overwrites its payload with an identity-only
//     receipt (appliedFileMutationReceipt) so the ledger cannot survive as a
//     second copy of text the user deleted. relationship_set is the deliberate
//     exception — buildRelationshipProjection replays its summary/stage verbatim
//     — and relationship_delete calls chat.purge_applied_relationship_sets to
//     drop those retained rows before the reset takes effect.
//   - Long rebuilds: relationship_rebuild is the sole two-stage exception. A
//     short transaction claims and snapshots it, igrep builds outside every PG
//     transaction, a second short transaction records the retryable candidate,
//     and a final user-fenced transaction rechecks authority, performs only the
//     bounded local pointer cutover, and settles the receipt.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { Prisma } from "../generated/client/client.js";
import type { ChatPrismaClient } from "./db.js";
import { chatPrisma, chatProjectorPrisma } from "./db.js";
import { deletePrefix, writeAtomic } from "./chat-fs.js";
import { createId } from "./id.js";
import {
  applyCompanionMemoryProjection,
  buildCompanionWorkspaceRebuild,
  companionMemoryProjectionPort,
  companionMemoryProjectionTimeoutMs,
  type CompanionMemoryProjectionPort,
} from "./companion-memory-projection.js";
import { recordOutbox } from "./outbox.js";
import {
  appendRelationshipEvidenceOnce,
  deleteRelationship,
  quarantineRelationshipFiles,
  rebuildRelationshipFromEvidence,
  resetRelationshipEvidenceBaseline,
  restoreRelationshipCutoverBaseline,
  setRelationshipOnce,
  updateRelationshipOnce,
} from "./relationship.js";
import {
  buildRelationshipProjection,
  loadSessionLinkage,
  type RelationshipProjectionOperation,
} from "./relationship-authority.js";
import { lockTurn, lockUser, lockUserShared } from "./turn-lock.js";
import type {
  CompanionWorkspaceRebuild,
  CompanionWorkspaceRebuildFence,
  CompanionWorkspaceRebuildPromotion,
} from "@idream/shared/chat/companion-runtime";
import { CHAT_TO_MAIN_EVENTS } from "@idream/shared/contracts";

const relationshipEvidenceSchema = z.object({
  sourceAssistantMessageId: z.string().min(1),
  sourceUserMessageId: z.string().min(1),
  kind: z.enum([
    "self_disclosure",
    "trust",
    "affection",
    "shared_plan",
    "conflict",
    "repair",
    "boundary_respected",
  ]),
  confidence: z.number().min(0).max(1),
  extractorVersion: z.string().min(1),
});

const fileMutationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("turn_forget"),
    sessionId: z.string().min(1),
    characterId: z.string().min(1),
    messageIds: z.array(z.string().min(1)),
  }),
  z.object({
    kind: z.literal("session_delete"),
    sessionId: z.string().min(1),
    characterId: z.string().min(1),
    messageIds: z.array(z.string().min(1)),
  }),
  z.object({
    kind: z.literal("account_delete"),
    deletionRequestEventId: z.string().min(1),
    // Optional keeps already-persisted legacy rows readable. Only `true`
    // authorizes the dedicated v2 completion protocol.
    requestBound: z.literal(true).optional(),
  }),
  z.object({
    kind: z.literal("memory_extract"),
    sessionId: z.string().min(1),
    userMessageId: z.string().min(1),
    characterId: z.string().min(1),
    turnKey: z.string().min(1),
    attempt: z.number().int().positive(),
    relationshipEvidence: z.array(relationshipEvidenceSchema),
  }),
  z.object({
    kind: z.literal("relationship_set"),
    characterId: z.string().min(1),
    summary: z.string().optional(),
    stage: z.enum(["new", "familiar", "close", "committed"]).optional(),
  }),
  z.object({
    kind: z.literal("relationship_delete"),
    characterId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("relationship_rebuild"),
    characterId: z.string().min(1),
  }),
]);

export type ChatFileMutation = z.infer<typeof fileMutationSchema>;

function parsePersistedFileMutation(input: {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
}): ChatFileMutation {
  const payload =
    input.payload &&
    typeof input.payload === "object" &&
    !Array.isArray(input.payload)
      ? (input.payload as Record<string, unknown>)
      : null;
  if (
    input.kind === "account_delete" &&
    payload &&
    (payload.kind === undefined || payload.kind === "account_delete") &&
    payload.deletionRequestEventId === undefined &&
    payload.requestBound !== true
  ) {
    // INTENT: pre-v2 pending rows had no request identity. The row id is
    // immutable, so this adapter gives every retry the same legacy-only
    // completion identity without granting request-bound v2 authority.
    return fileMutationSchema.parse({
      ...payload,
      kind: "account_delete",
      deletionRequestEventId: `legacy-chat-file-mutation:${input.id}`,
    });
  }
  return fileMutationSchema.parse(input.payload);
}

export class ChatFileProjectionRaceError extends Error {
  constructor(userId: string) {
    super(`chat file projection changed before user lock for ${userId}`);
  }
}

export class TerminalTurnDeadlineError extends Error {
  constructor() {
    super("terminal turn authority exceeded the companion deadline");
  }
}

export const CHAT_CONTEXT_INVALIDATING_FILE_MUTATIONS = [
  "turn_forget",
  "session_delete",
  "account_delete",
  "relationship_set",
  "relationship_delete",
  "relationship_rebuild",
] as const;

export async function recordChatFileMutation(
  tx: Prisma.TransactionClient,
  userId: string,
  mutation: ChatFileMutation,
): Promise<string> {
  const parsed = fileMutationSchema.parse(mutation);
  const id = createId("filemut");
  const payload = JSON.stringify(parsed);
  await tx.$executeRaw`
    INSERT INTO chat.chat_file_mutations (
      id,
      user_id,
      kind,
      payload
    )
    VALUES (
      ${id},
      ${userId},
      ${parsed.kind},
      ${payload}::jsonb
    )
  `;
  return id;
}

/**
 * Apply every previously committed file intent while the caller already holds
 * the user advisory lock. File writes may precede this transaction's commit,
 * but they only project earlier committed intents; a rollback merely causes an
 * idempotent replay and never exposes an uncommitted domain mutation.
 */
export async function applyPendingChatFileMutationsTx(
  tx: Prisma.TransactionClient,
  userId: string,
  maximum = Number.MAX_SAFE_INTEGER,
  options: {
    companionAlreadyAppliedMutationId?: string;
    localRelationshipAlreadyAppliedMutationId?: string;
  } = {},
): Promise<number> {
  let applied = 0;
  while (applied < maximum) {
    const rows = await tx.chatFileMutation.findMany({
      where: { userId, status: "pending" },
      orderBy: { sequence: "asc" },
      take: Math.min(100, maximum - applied),
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      const mutation = parsePersistedFileMutation(row);
      const localRelationshipAlreadyApplied =
        mutation.kind === "relationship_rebuild"
        && row.id === options.localRelationshipAlreadyAppliedMutationId;
      if (mutation.kind === "memory_extract") {
        await assertMemoryExtractAuthority(tx, userId, mutation);
      }
      const relationshipProjection =
        mutation.kind === "relationship_rebuild" && !localRelationshipAlreadyApplied
          ? await buildRelationshipProjection(tx, {
              userId,
              characterId: mutation.characterId,
            })
          : null;
      const validRelationshipEvidenceSourceIds =
        mutation.kind === "relationship_rebuild" && !localRelationshipAlreadyApplied
          ? new Set((await tx.message.findMany({
              where: {
                session: {
                  userId,
                  characterId: mutation.characterId,
                  status: { not: "deleted" },
                  deletedAt: null,
                },
                status: "sent",
                deletedAt: null,
              },
              select: { id: true },
            })).map((message) => message.id))
          : null;
      if (!localRelationshipAlreadyApplied) {
        await applyFileMutation(
          userId,
          row.id,
          mutation,
          relationshipProjection,
          validRelationshipEvidenceSourceIds,
        );
      }
      if (
        mutation.kind === "relationship_rebuild"
        || mutation.kind === "relationship_delete"
        || mutation.kind === "account_delete"
      ) {
        if (row.id !== options.companionAlreadyAppliedMutationId) {
          await applyCompanionMemoryProjection(
            tx,
            userId,
            mutation.kind === "relationship_delete"
              // The ledger row id labels the quarantine, so the retired sidecar
              // workspace and the retired relationship files share one name.
              ? { ...mutation, quarantine: row.id }
              : mutation,
          );
        }
      }
      if (mutation.kind === "memory_extract") {
        const claimed = await tx.message.updateMany({
          where: {
            id: mutation.turnKey,
            sessionId: mutation.sessionId,
            role: "assistant",
            attempt: mutation.attempt,
            memoryExtractedAttempt: { lt: mutation.attempt },
            memoryAuthority: "enabled",
            status: "sent",
            deletedAt: null,
          },
          data: { memoryExtractedAttempt: mutation.attempt },
        });
        if (claimed.count !== 1) {
          throw new Error(
            `turn memory authority changed before file completion for ${mutation.turnKey}`,
          );
        }
        await recordOutbox(tx, {
          eventType: CHAT_TO_MAIN_EVENTS.relationshipUpdated,
          aggregateType: "character",
          aggregateId: mutation.characterId,
          payload: { userId, fileMutationId: row.id },
        });
      }
      if (mutation.kind === "session_delete") {
        await recordOutbox(tx, {
          eventType: CHAT_TO_MAIN_EVENTS.sessionDeleted,
          aggregateType: "session",
          aggregateId: mutation.sessionId,
          payload: { userId, fileMutationId: row.id },
        });
      }
      if (mutation.kind === "account_delete") {
        if (mutation.requestBound) {
          await recordOutbox(tx, {
            eventType: CHAT_TO_MAIN_EVENTS.accountErasureCompletedV2,
            aggregateType: "user",
            aggregateId: userId,
            schemaVersion: 2,
            status: "request_bound",
            payload: {
              version: 2,
              binding: "request_bound",
              userId,
              fileMutationId: row.id,
              deletionRequestEventId: mutation.deletionRequestEventId,
            },
          });
        } else {
          await recordOutbox(tx, {
            eventType: CHAT_TO_MAIN_EVENTS.accountErasureCompleted,
            aggregateType: "user",
            aggregateId: userId,
            payload: {
              userId,
              fileMutationId: row.id,
              deletionRequestEventId: mutation.deletionRequestEventId,
            },
          });
        }
      }
      if (mutation.kind === "relationship_delete") {
        await tx.$queryRaw`
          SELECT chat.purge_applied_relationship_sets(
            ${userId},
            ${mutation.characterId},
            ${row.sequence}
          )
        `;
      }
      const claimed = await tx.chatFileMutation.updateMany({
        where: { id: row.id, status: "pending" },
        data: {
          status: "applied",
          payload: appliedFileMutationReceipt(
            mutation,
          ) as Prisma.InputJsonValue,
          attempts: { increment: 1 },
          lastError: null,
          projectionClaimToken: null,
          projectionClaimedAt: null,
          projectionAuthorityVersion: null,
          projectionRebuildId: null,
          appliedAt: new Date(),
        },
      });
      if (claimed.count !== 1) {
        throw new Error(`file mutation authority changed for ${row.id}`);
      }
      if (mutation.kind === "account_delete") {
        await tx.$queryRaw`
          SELECT chat.purge_file_mutations_for_account(
            ${userId},
            ${row.id}
          )
        `;
      }
      applied += 1;
    }
    if (rows.length < 100) break;
  }
  return applied;
}

/**
 * Request/domain transactions cannot own the projector capability. After they
 * acquire the user lock, they may only prove that the out-of-transaction
 * projector snapshot is still current. A newly committed intent causes the
 * whole request transaction to roll back and the outer coordinator to project
 * and retry.
 */
export async function assertNoPendingChatFileMutationsTx(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  const pending = await tx.chatFileMutation.count({
    where: { userId, status: "pending" },
  });
  if (pending > 0) {
    throw new ChatFileProjectionRaceError(userId);
  }
}

export async function runWithProjectedChatFiles<T>(
  userId: string,
  run: () => Promise<T>,
  authorityPrisma: ChatPrismaClient = chatProjectorPrisma,
): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await projectChatFileMutations(userId, authorityPrisma);
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof ChatFileProjectionRaceError)) throw error;
    }
  }
  throw new Error(
    `chat file projection kept changing for ${userId}; retry the request`,
  );
}

const COMPANION_PROJECTION_CLAIM_LEASE_MS = 120_000;
const COMPANION_PROJECTION_HEARTBEAT_MS = 30_000;

// SPEC: 关系工作区的重建租约还被上一轮持有——短暂、可自愈、客户端稍后重试即可。
// INTENT: 导出它是为了让 router 能把它翻成一个正经的领域错误。过去它落进 500
//   兜底分支，用户收到的是 "relationship rebuild filemut_… is owned by a live
//   projection claim" —— 既是内部实现细节，又把一个等几十秒就好的状态说成了服务器故障。
export class CompanionProjectionClaimBusyError extends Error {}

export interface CompanionProjectionClaim {
  mutationId: string;
  userId: string;
  characterId: string;
  claimToken: string;
  authorityVersion: bigint;
  fence: CompanionWorkspaceRebuildFence;
  request?: CompanionWorkspaceRebuild & { fence: CompanionWorkspaceRebuildFence };
  relationshipProjection?: RelationshipProjectionOperation[];
  validRelationshipEvidenceSourceIds?: Set<string>;
  rebuildId?: string;
}

export type ClaimedProjectionStep =
  | { kind: "empty" }
  | { kind: "ordinary"; applied: number }
  | { kind: "companion"; claim: CompanionProjectionClaim };

export async function claimNextProjectionTx(
  tx: Prisma.TransactionClient,
  userId: string,
  options: { now?: Date; claimToken?: string } = {},
): Promise<ClaimedProjectionStep> {
  const now = options.now ?? new Date();
  const row = await tx.chatFileMutation.findFirst({
    where: { userId, status: "pending" },
    orderBy: { sequence: "asc" },
  });
  if (!row) return { kind: "empty" };
  const mutation = parsePersistedFileMutation(row);
  if (mutation.kind !== "relationship_rebuild") {
    return {
      kind: "ordinary",
      applied: await applyPendingChatFileMutationsTx(tx, userId, 1),
    };
  }
  const staleBefore = new Date(now.getTime() - COMPANION_PROJECTION_CLAIM_LEASE_MS);
  if (
    row.projectionClaimToken
    && row.projectionClaimedAt
    && row.projectionClaimedAt >= staleBefore
  ) {
    throw new CompanionProjectionClaimBusyError(
      `relationship rebuild ${row.id} is owned by a live projection claim`,
    );
  }
  const authority = await tx.chatFileMutation.aggregate({
    where: { userId },
    _max: { sequence: true },
  });
  const authorityVersion = authority._max.sequence;
  if (!authorityVersion || authorityVersion <= 0n) {
    throw new Error("relationship rebuild projection authority version is missing");
  }
  if (
    row.projectionClaimToken
    && row.projectionAuthorityVersion
    && row.projectionRebuildId
  ) {
    if (row.projectionAuthorityVersion !== authorityVersion) {
      await tx.chatFileMutation.updateMany({
        where: {
          id: row.id,
          status: "pending",
          projectionClaimToken: row.projectionClaimToken,
        },
        data: {
          projectionClaimToken: null,
          projectionClaimedAt: null,
          projectionAuthorityVersion: null,
          projectionRebuildId: null,
        },
      });
      throw new Error("relationship rebuild authority advanced after candidate persistence");
    }
    const renewed = await tx.chatFileMutation.updateMany({
      where: {
        id: row.id,
        status: "pending",
        projectionClaimToken: row.projectionClaimToken,
        projectionRebuildId: row.projectionRebuildId,
      },
      data: { projectionClaimedAt: now },
    });
    if (renewed.count !== 1) {
      throw new CompanionProjectionClaimBusyError(
        `relationship rebuild ${row.id} recovery claim changed concurrently`,
      );
    }
    const fence: CompanionWorkspaceRebuildFence = {
      mutationId: row.id,
      claimToken: row.projectionClaimToken,
      authorityVersion: authorityVersion.toString(),
    };
    return {
      kind: "companion",
      claim: {
        mutationId: row.id,
        userId,
        characterId: mutation.characterId,
        claimToken: row.projectionClaimToken,
        authorityVersion,
        fence,
        rebuildId: row.projectionRebuildId,
      },
    };
  }
  const claimToken = options.claimToken ?? randomUUID();
  const claimed = await tx.chatFileMutation.updateMany({
    where: {
      id: row.id,
      status: "pending",
      OR: [
        { projectionClaimToken: null },
        { projectionClaimedAt: { lt: staleBefore } },
      ],
    },
    data: {
      projectionClaimToken: claimToken,
      projectionClaimedAt: now,
      projectionAuthorityVersion: authorityVersion,
      projectionRebuildId: null,
    },
  });
  if (claimed.count !== 1) {
    throw new CompanionProjectionClaimBusyError(
      `relationship rebuild ${row.id} claim changed concurrently`,
    );
  }
  const fence: CompanionWorkspaceRebuildFence = {
    mutationId: row.id,
    claimToken,
    authorityVersion: authorityVersion.toString(),
  };
  const request = await buildCompanionWorkspaceRebuild(tx, {
    userId,
    characterId: mutation.characterId,
  });
  const relationshipProjection = await buildRelationshipProjection(tx, {
    userId,
    characterId: mutation.characterId,
  });
  const validRelationshipEvidenceSourceIds = new Set((await tx.message.findMany({
    where: {
      session: {
        userId,
        characterId: mutation.characterId,
        status: { not: "deleted" },
        deletedAt: null,
      },
      status: "sent",
      deletedAt: null,
    },
    select: { id: true },
  })).map((message) => message.id));
  return {
    kind: "companion",
    claim: {
      mutationId: row.id,
      userId,
      characterId: mutation.characterId,
      claimToken,
      authorityVersion,
      fence,
      request: { ...request, fence },
      relationshipProjection,
      validRelationshipEvidenceSourceIds,
    },
  };
}

export async function persistPreparedCompanionProjectionTx(
  tx: Prisma.TransactionClient,
  claim: CompanionProjectionClaim,
  rebuildId: string,
): Promise<boolean> {
  const authority = await tx.chatFileMutation.aggregate({
    where: { userId: claim.userId },
    _max: { sequence: true },
  });
  if (authority._max.sequence !== claim.authorityVersion) return false;
  const persisted = await tx.chatFileMutation.updateMany({
    where: {
      id: claim.mutationId,
      status: "pending",
      projectionClaimToken: claim.claimToken,
      projectionAuthorityVersion: claim.authorityVersion,
    },
    data: {
      projectionClaimedAt: new Date(),
      projectionRebuildId: rebuildId,
    },
  });
  return persisted.count === 1;
}

/**
 * Perform only the bounded canonical-pointer cutover while owning the same
 * user fence as every authoritative writer. The candidate was expensive to
 * build, but promotion itself must stay a local, idempotent control operation:
 * keeping it behind this final authority check closes the persisted-candidate
 * to promotion race without putting ingest/maintenance inside PostgreSQL.
 */
export async function promoteCompanionProjectionTx(
  tx: Prisma.TransactionClient,
  claim: CompanionProjectionClaim,
  rebuildId: string,
  promote: () => Promise<unknown>,
): Promise<boolean> {
  await lockUser(tx, claim.userId);
  const authority = await tx.chatFileMutation.aggregate({
    where: { userId: claim.userId },
    _max: { sequence: true },
  });
  if (authority._max.sequence !== claim.authorityVersion) return false;
  const owned = await tx.chatFileMutation.count({
    where: {
      id: claim.mutationId,
      status: "pending",
      projectionClaimToken: claim.claimToken,
      projectionAuthorityVersion: claim.authorityVersion,
      projectionRebuildId: rebuildId,
    },
  });
  if (owned !== 1) return false;
  await promote();
  return true;
}

async function settleCompanionProjectionTx(
  tx: Prisma.TransactionClient,
  claim: CompanionProjectionClaim,
  rebuildId: string,
): Promise<number> {
  const authority = await tx.chatFileMutation.aggregate({
    where: { userId: claim.userId },
    _max: { sequence: true },
  });
  if (authority._max.sequence !== claim.authorityVersion) return 0;
  const owned = await tx.chatFileMutation.count({
    where: {
      id: claim.mutationId,
      status: "pending",
      projectionClaimToken: claim.claimToken,
      projectionAuthorityVersion: claim.authorityVersion,
      projectionRebuildId: rebuildId,
    },
  });
  if (owned !== 1) return 0;
  return applyPendingChatFileMutationsTx(tx, claim.userId, 1, {
    companionAlreadyAppliedMutationId: claim.mutationId,
    localRelationshipAlreadyAppliedMutationId: claim.mutationId,
  });
}

async function applyClaimedLocalRelationshipProjection(
  claim: CompanionProjectionClaim,
): Promise<void> {
  if (!claim.relationshipProjection || !claim.validRelationshipEvidenceSourceIds) {
    throw new Error("relationship rebuild claim omitted its local projection snapshot");
  }
  await applyFileMutation(
    claim.userId,
    claim.mutationId,
    { kind: "relationship_rebuild", characterId: claim.characterId },
    claim.relationshipProjection,
    claim.validRelationshipEvidenceSourceIds,
  );
}

async function clearProjectionClaim(
  authorityPrisma: ChatPrismaClient,
  claim: CompanionProjectionClaim,
): Promise<void> {
  await authorityPrisma.chatFileMutation.updateMany({
    where: {
      id: claim.mutationId,
      status: "pending",
      projectionClaimToken: claim.claimToken,
    },
    data: {
      projectionClaimToken: null,
      projectionClaimedAt: null,
      projectionAuthorityVersion: null,
      projectionRebuildId: null,
    },
  });
}

async function expireProjectionClaim(
  authorityPrisma: ChatPrismaClient,
  claim: CompanionProjectionClaim,
): Promise<void> {
  await authorityPrisma.chatFileMutation.updateMany({
    where: {
      id: claim.mutationId,
      status: "pending",
      projectionClaimToken: claim.claimToken,
    },
    data: { projectionClaimedAt: new Date(0) },
  });
}

function startProjectionClaimHeartbeat(
  authorityPrisma: ChatPrismaClient,
  claim: CompanionProjectionClaim,
): { stop(): Promise<void>; failure(): Error | undefined } {
  let failure: Error | undefined;
  let inFlight: Promise<void> | undefined;
  const renew = () => {
    if (inFlight || failure) return;
    inFlight = authorityPrisma.chatFileMutation.updateMany({
      where: {
        id: claim.mutationId,
        status: "pending",
        projectionClaimToken: claim.claimToken,
      },
      data: { projectionClaimedAt: new Date() },
    }).then(({ count }) => {
      if (count !== 1) throw new Error("relationship rebuild projection claim was lost");
    }).catch((error: unknown) => {
      failure = error instanceof Error ? error : new Error(String(error));
    }).finally(() => {
      inFlight = undefined;
    });
  };
  const timer = setInterval(renew, COMPANION_PROJECTION_HEARTBEAT_MS);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      await inFlight;
    },
    failure: () => failure,
  };
}

export async function projectChatFileMutations(
  userId: string,
  authorityPrisma: ChatPrismaClient = chatProjectorPrisma,
  companionPort: CompanionMemoryProjectionPort = companionMemoryProjectionPort(),
  applyLocalProjection: (claim: CompanionProjectionClaim) => Promise<void> =
    applyClaimedLocalRelationshipProjection,
): Promise<number> {
  try {
    let applied = 0;
    for (;;) {
      const step = await authorityPrisma.$transaction(
        async (tx) => {
          await lockUser(tx, userId);
          return claimNextProjectionTx(tx, userId);
        },
        { timeout: companionMemoryProjectionTimeoutMs() },
      );
      if (step.kind === "empty") return applied;
      if (step.kind === "ordinary") {
        applied += step.applied;
        continue;
      }
      const { claim } = step;
      if (!companionPort.prepare || !companionPort.promote || !companionPort.discard) {
        throw new Error("companion projection port does not implement fenced rebuilds");
      }
      const heartbeat = startProjectionClaimHeartbeat(authorityPrisma, claim);
      let prepared: Awaited<ReturnType<NonNullable<typeof companionPort.prepare>>> | undefined;
      let promoted = false;
      let candidatePersisted = Boolean(claim.rebuildId);
      try {
        // INVARIANT: no interactive transaction or advisory lock crosses this
        // potentially multi-minute sidecar call. Only the renewable DB claim
        // remains durable while the candidate is built.
        let persisted = candidatePersisted;
        if (claim.rebuildId) {
          prepared = { rebuildId: claim.rebuildId, sessions: 0, messages: 0 };
        } else {
          if (!claim.request) throw new Error("relationship rebuild claim omitted its snapshot");
          // Local relationship.md reconstruction can also scale with years of
          // history. It is idempotent and runs under the durable pending claim,
          // never inside the final authority transaction.
          await applyLocalProjection(claim);
          prepared = await companionPort.prepare(claim.request);
          const heartbeatFailure = heartbeat.failure();
          if (heartbeatFailure) throw heartbeatFailure;
          persisted = await authorityPrisma.$transaction(
            async (tx) => {
              await lockUser(tx, userId);
              return persistPreparedCompanionProjectionTx(tx, claim, prepared!.rebuildId);
            },
            { timeout: companionMemoryProjectionTimeoutMs() },
          );
          candidatePersisted = persisted;
        }
        const promotion: CompanionWorkspaceRebuildPromotion = {
          scope: "relationship",
          userId: claim.userId,
          characterId: claim.characterId,
          rebuildId: prepared.rebuildId,
          fence: claim.fence,
        };
        if (!persisted) {
          await companionPort.discard(promotion);
          await clearProjectionClaim(authorityPrisma, claim);
          await heartbeat.stop();
          continue;
        }
        const heartbeatFailure = heartbeat.failure();
        if (heartbeatFailure) throw heartbeatFailure;
        await heartbeat.stop();
        const current = await authorityPrisma.$transaction(
          async (tx) => {
            const cutover = await promoteCompanionProjectionTx(
              tx,
              claim,
              prepared!.rebuildId,
              async () => {
                await companionPort.promote!(promotion);
                promoted = true;
              },
            );
            if (!cutover) return 0;
            return settleCompanionProjectionTx(tx, claim, prepared!.rebuildId);
          },
          { timeout: companionMemoryProjectionTimeoutMs() },
        );
        if (current === 0) {
          await companionPort.discard(promotion);
          await clearProjectionClaim(authorityPrisma, claim);
          continue;
        }
        applied += current;
      } catch (error) {
        await heartbeat.stop();
        if (prepared && !promoted && !candidatePersisted) {
          await companionPort.discard({
            scope: "relationship",
            userId: claim.userId,
            characterId: claim.characterId,
            rebuildId: prepared.rebuildId,
            fence: claim.fence,
          }).catch(() => undefined);
        }
        await (candidatePersisted
          ? expireProjectionClaim(authorityPrisma, claim)
          : clearProjectionClaim(authorityPrisma, claim)).catch(() => undefined);
        throw error;
      }
    }
  } catch (error) {
    if (error instanceof CompanionProjectionClaimBusyError) throw error;
    const message =
      error instanceof Error ? error.message.slice(0, 1_000) : "projection failed";
    const head = await authorityPrisma.chatFileMutation.findFirst({
      where: { userId, status: "pending" },
      orderBy: { sequence: "asc" },
      select: { id: true },
    }).catch(() => null);
    if (head) {
      await authorityPrisma.chatFileMutation.updateMany({
        where: { id: head.id, status: "pending" },
        data: {
          attempts: { increment: 1 },
          lastError: message,
        },
      }).catch(() => {});
    }
    throw error;
  }
}

/**
 * Commit one durable file intent from inside a turn-authority transaction.
 * Obtaining this function is the ONLY way a caller reaches the ledger under
 * the turn protocol, and calling it is what schedules the post-commit
 * projection — so "an intent was recorded" and "the projector ran" cannot be
 * wired up independently, or forgotten, at a call site.
 */
export type RecordChatFileIntent = (
  mutation: ChatFileMutation,
) => Promise<string>;

/**
 * SPEC: the write protocol that every turn-scoped mutation must follow. One
 * call owns the whole ordering — drain the ledger, open the transaction, take
 * the user and turn advisory locks in that order, and only then prove that no
 * intent slipped in ahead of this writer.
 * INTENT: those four steps used to be retyped at every write path, where their
 * ORDER was load-bearing but unstated. assertNoPendingChatFileMutationsTx
 * before the lock proves nothing, yet no signature said so and a reader had to
 * compare call sites to recover the rule. Callers can no longer spell it wrong.
 * INVARIANTS:
 *   - `run` executes with both advisory locks held and zero pending intents for
 *     this user, so rows it reads are current and stay current until commit.
 *     It still has to re-read them: the pre-lock snapshot it was planned from
 *     is exactly what this lock was taken to invalidate.
 *   - `recordIntent` is the sole ledger entry point here, and using it is what
 *     makes the projector run — exactly once, after the transaction commits,
 *     and never when nothing was recorded. A path that records nothing has no
 *     file effect to project, so it must not pay for a projection round trip.
 *   - A rolled-back transaction never projects: the failure propagates out of
 *     runWithProjectedChatFiles before the projection call is reached.
 *   - ChatFileProjectionRaceError raised inside `run` is caught and retried by
 *     runWithProjectedChatFiles, while ChatError propagates to the caller. `run`
 *     must therefore stay safe to execute more than once.
 */
export async function withTurnAuthority<T>(
  input: {
    userId: string;
    sessionId: string;
    prisma: ChatPrismaClient;
    projectorPrisma: ChatPrismaClient;
  },
  run: (
    tx: Prisma.TransactionClient,
    recordIntent: RecordChatFileIntent,
  ) => Promise<T>,
): Promise<T> {
  let recorded = false;
  const value = await runWithProjectedChatFiles(
    input.userId,
    () =>
      input.prisma.$transaction(async (tx) => {
        // Reset per attempt: a projection race replays `run` from the top, and
        // the intents recorded by the abandoned attempt rolled back with it.
        recorded = false;
        await lockTurn(tx, input.userId, input.sessionId);
        await assertNoPendingChatFileMutationsTx(tx, input.userId);
        return run(tx, async (mutation) => {
          const id = await recordChatFileMutation(tx, input.userId, mutation);
          recorded = true;
          return id;
        });
      }),
    input.projectorPrisma,
  );
  if (recorded) {
    await projectChatFileMutations(input.userId, input.projectorPrisma);
  }
  return value;
}

/**
 * Commit one already-produced terminal candidate without entering the
 * potentially multi-minute file projector. A pending projection is durable and
 * recoverable, so the generation job must retry after the projector settles;
 * it must never hold the sidecar commit open while rebuilding relationship
 * memory. The transaction budget is carved from the same absolute companion
 * deadline, which makes a lock wait or slow terminal CAS roll back instead of
 * committing after the sidecar has discarded its attempt workspace.
 */
export async function withTerminalTurnAuthority<T>(
  input: {
    userId: string;
    sessionId: string;
    prisma: ChatPrismaClient;
    deadlineAt: number;
  },
  run: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const remainingMs = input.deadlineAt - Date.now();
  if (remainingMs <= 4) throw new TerminalTurnDeadlineError();

  // Prisma budgets acquisition and execution independently. Reserve maxWait
  // from the absolute budget so their worst-case sum cannot cross deadlineAt.
  const maxWait = Math.min(1_000, Math.max(1, Math.floor(remainingMs / 4)));
  const timeout = remainingMs - maxWait;
  try {
    return await input.prisma.$transaction(
      async (tx) => {
        if (Date.now() >= input.deadlineAt) throw new TerminalTurnDeadlineError();
        await lockTurn(tx, input.userId, input.sessionId);
        if (Date.now() >= input.deadlineAt) throw new TerminalTurnDeadlineError();
        await assertNoPendingChatFileMutationsTx(tx, input.userId);
        if (Date.now() >= input.deadlineAt) throw new TerminalTurnDeadlineError();
        const value = await run(tx);
        if (Date.now() >= input.deadlineAt) throw new TerminalTurnDeadlineError();
        return value;
      },
      { maxWait, timeout },
    );
  } catch (error) {
    if (
      error instanceof TerminalTurnDeadlineError ||
      error instanceof ChatFileProjectionRaceError
    ) {
      throw error;
    }
    // Prisma reports an interactive-transaction timeout as its own error. If
    // the reserved execution budget is exhausted, preserve the deadline
    // taxonomy rather than blaming a healthy DSH provider.
    if (Date.now() >= input.deadlineAt - maxWait) {
      throw new TerminalTurnDeadlineError();
    }
    throw error;
  }
}

/**
 * Return one file-layer snapshot while preventing a newly committed mutation
 * from landing between the pending-intent check and the final file read.
 * Writers/projectors take the matching exclusive user advisory lock.
 */
export async function withReadableChatFileSnapshot<T>(
  userId: string,
  read: (tx: Prisma.TransactionClient) => Promise<T>,
  prisma: ChatPrismaClient = chatPrisma,
  authorityPrisma: ChatPrismaClient = chatProjectorPrisma,
  timeoutMs = 30_000,
): Promise<T> {
  await projectChatFileMutations(userId, authorityPrisma);
  return prisma.$transaction(
    async (tx) => {
      await lockUserShared(tx, userId);
      const pending = await tx.chatFileMutation.count({
        where: { userId, status: "pending" },
      });
      if (pending > 0) {
        throw new Error(
          `chat file projection pending for ${userId}: ${pending}`,
        );
      }
      // INVARIANT: cross-store readers must use the transaction that owns the
      // shared user lock. Capturing the outer Prisma client silently escapes
      // this seam and can interleave queries with a transaction client.
      return read(tx);
    },
    { timeout: timeoutMs },
  );
}

async function assertMemoryExtractAuthority(
  tx: Prisma.TransactionClient,
  userId: string,
  mutation: Extract<ChatFileMutation, { kind: "memory_extract" }>,
): Promise<void> {
  const session = await tx.chatSession.findUnique({
    where: { id: mutation.sessionId },
  });
  const assistant = await tx.message.findUnique({
    where: { id: mutation.turnKey },
  });
  const source = await tx.message.findUnique({
    where: { id: mutation.userMessageId },
  });
  const { linkage } = await loadSessionLinkage(tx, mutation.sessionId);
  if (
    !session ||
    session.userId !== userId ||
    session.characterId !== mutation.characterId ||
    session.status === "deleted" ||
    session.deletedAt ||
    !assistant ||
    assistant.sessionId !== session.id ||
    assistant.role !== "assistant" ||
    assistant.status !== "sent" ||
    assistant.deletedAt ||
    assistant.memoryAuthority !== "enabled" ||
    assistant.memoryExtractedAttempt >= mutation.attempt ||
    assistant.attempt !== mutation.attempt ||
    !["passed", "unknown"].includes(assistant.safetyStatus) ||
    !source ||
    source.sessionId !== session.id ||
    source.role !== "user" ||
    source.status !== "sent" ||
    source.deletedAt ||
    !["passed", "unknown"].includes(source.safetyStatus) ||
    linkage.sources.get(assistant.id)?.id !== source.id
  ) {
    throw new Error(
      `turn memory authority changed before file projection for ${mutation.turnKey}`,
    );
  }
}

async function applyFileMutation(
  userId: string,
  mutationId: string,
  mutation: ChatFileMutation,
  relationshipProjection: RelationshipProjectionOperation[] | null,
  validRelationshipEvidenceSourceIds: ReadonlySet<string> | null,
): Promise<void> {
  switch (mutation.kind) {
    case "turn_forget":
      return;
    case "session_delete":
      return;
    case "account_delete":
      await deletePrefix(["mem", userId]);
      return;
    case "memory_extract":
      await appendRelationshipEvidenceOnce(
        userId,
        mutation.characterId,
        mutation.relationshipEvidence,
      );
      return;
    case "relationship_set":
      await setRelationshipOnce(
        userId,
        mutation.characterId,
        mutationId,
        {
          ...(mutation.summary !== undefined
            ? { summary: mutation.summary }
            : {}),
          ...(mutation.stage !== undefined ? { stage: mutation.stage } : {}),
        },
      );
      await resetRelationshipEvidenceBaseline(
        userId,
        mutation.characterId,
      );
      return;
    case "relationship_delete":
      await quarantineRelationshipFiles(userId, mutation.characterId, mutationId);
      return;
    case "relationship_rebuild":
      if (!validRelationshipEvidenceSourceIds) {
        throw new Error("relationship evidence rebuild requires valid source ids");
      }
      const evidenceRebuild = await rebuildRelationshipFromEvidence(
        userId,
        mutation.characterId,
        validRelationshipEvidenceSourceIds,
      );
      if (evidenceRebuild.hasLedger) return;
      await deleteRelationship(userId, mutation.characterId);
      for (const operation of relationshipProjection ?? []) {
        if (operation.kind === "baseline") {
          await restoreRelationshipCutoverBaseline(
            userId,
            mutation.characterId,
            operation.baseline,
          );
        } else if (operation.kind === "turn") {
          await updateRelationshipOnce(
            userId,
            mutation.characterId,
            operation.turnKey,
            {
              summaryDelta: operation.summaryDelta,
              warmth: operation.warmth,
              familiarity: operation.familiarity,
            },
          );
        } else {
          await setRelationshipOnce(
            userId,
            mutation.characterId,
            operation.mutationKey,
            {
              ...(operation.summary !== undefined
                ? { summary: operation.summary }
                : {}),
              ...(operation.stage !== undefined
                ? { stage: operation.stage }
                : {}),
            },
          );
        }
      }
      return;
  }
}

export function appliedFileMutationReceipt(
  mutation: ChatFileMutation,
): Record<string, unknown> {
  switch (mutation.kind) {
    case "memory_extract":
      return {
        kind: mutation.kind,
        sessionId: mutation.sessionId,
        userMessageId: mutation.userMessageId,
        characterId: mutation.characterId,
        turnKey: mutation.turnKey,
        attempt: mutation.attempt,
      };
    case "relationship_set":
      return mutation;
    case "relationship_delete":
      return {
        kind: mutation.kind,
        characterId: mutation.characterId,
      };
    case "turn_forget":
    case "session_delete":
      return {
        kind: mutation.kind,
        sessionId: mutation.sessionId,
        characterId: mutation.characterId,
      };
    case "relationship_rebuild":
      return {
        kind: mutation.kind,
        characterId: mutation.characterId,
      };
    case "account_delete":
      return {
        kind: mutation.kind,
        deletionRequestEventId: mutation.deletionRequestEventId,
        ...(mutation.requestBound ? { requestBound: true } : {}),
      };
  }
}
