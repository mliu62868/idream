// SPEC: durable file-intent ledger (chat.chat_file_mutations). The file layer
// (mem/*.md, sessions/*.jsonl) is authority but is NOT transactional, so no
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
//     keyed by turn/mutation id, appendTraceOnce by fileMutationId).
//   - No self-projection: a writer takes the same user lock and then calls
//     assertNoPendingChatFileMutationsTx. A newly committed intent aborts and
//     retries the entire request (runWithProjectedChatFiles) rather than letting
//     request code drain the ledger on the projector's behalf. Turn-scoped
//     writers get that ordering from withTurnAuthority, which also ties the
//     post-commit projection to whether an intent was actually recorded. The
//     account-erasure and batch-repair paths deliberately stay outside it:
//     erasure supersedes every pending intent instead of asserting there are
//     none, so it must NOT fail closed on a poisoned row.
//   - Cross-service honesty: watermarks (memoryExtractedAttempt, logExtractedSeq)
//     and outbox events are written in the SAME transaction that marks the row
//     applied, so main is never told about a file effect that did not land.
//   - Privacy: applying an intent overwrites its payload with an identity-only
//     receipt (appliedFileMutationReceipt) so the ledger cannot survive as a
//     second copy of text the user deleted. relationship_set is the deliberate
//     exception — buildRelationshipProjection replays its summary/stage verbatim
//     — and relationship_delete calls chat.purge_applied_relationship_sets to
//     drop those retained rows before the reset takes effect.
import path from "node:path";
import { z } from "zod";
import type { Prisma } from "../generated/client/client.js";
import type { ChatPrismaClient } from "./db.js";
import { chatPrisma, chatProjectorPrisma } from "./db.js";
import {
  appendLine,
  chatFsPaths,
  deletePrefix,
  listPrefix,
  readWhole,
  withFileMutationLock,
  writeAtomic,
} from "./chat-fs.js";
import { createId } from "./id.js";
import {
  consolidateMemories,
  deleteMemory,
  forgetByMessageIds,
  updateMemory,
} from "./memories.js";
import { recordOutbox } from "./outbox.js";
import {
  appendRelationshipEvidenceOnce,
  deleteRelationship,
  deleteRelationshipEvidence,
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
import { CHAT_TO_MAIN_EVENTS } from "@idream/shared/contracts";

const memoryCandidateSchema = z.object({
  scope: z.enum(["global", "character", "session"]),
  type: z.string().min(1),
  text: z.string().min(1),
  confidence: z.number(),
  sourceMessageIds: z.array(z.string().min(1)),
});

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
  z.object({ kind: z.literal("account_delete") }),
  z.object({
    kind: z.literal("memory_extract"),
    sessionId: z.string().min(1),
    userMessageId: z.string().min(1),
    characterId: z.string().min(1),
    turnKey: z.string().min(1),
    attempt: z.number().int().positive(),
    summaryDelta: z.string(),
    warmth: z.number().int().min(0).max(1).optional(),
    familiarity: z.number().int().min(0).max(1).optional(),
    relationshipEvidence: z.array(relationshipEvidenceSchema).optional(),
    candidates: z.array(memoryCandidateSchema),
    maxStored: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("memory_update"),
    memoryId: z.string().min(1),
    text: z.string(),
  }),
  z.object({
    kind: z.literal("memory_delete"),
    memoryId: z.string().min(1),
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
  z.object({
    kind: z.literal("trace_append"),
    sessionId: z.string().min(1),
    entry: z.record(z.string(), z.unknown()),
  }),
]);

export type ChatFileMutation = z.infer<typeof fileMutationSchema>;

class ChatFileProjectionRaceError extends Error {
  constructor(userId: string) {
    super(`chat file projection changed before user lock for ${userId}`);
  }
}

export const CHAT_CONTEXT_INVALIDATING_FILE_MUTATIONS = [
  "turn_forget",
  "session_delete",
  "account_delete",
  "memory_update",
  "memory_delete",
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
): Promise<number> {
  let applied = 0;
  for (;;) {
    const rows = await tx.chatFileMutation.findMany({
      where: { userId, status: "pending" },
      orderBy: { sequence: "asc" },
      take: 100,
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      const mutation = fileMutationSchema.parse(row.payload);
      if (mutation.kind === "memory_extract") {
        await assertMemoryExtractAuthority(tx, userId, mutation);
      }
      const relationshipProjection =
        mutation.kind === "relationship_rebuild"
          ? await buildRelationshipProjection(tx, {
              userId,
              characterId: mutation.characterId,
            })
          : null;
      const validRelationshipEvidenceSourceIds =
        mutation.kind === "relationship_rebuild"
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
      await applyFileMutation(
        userId,
        row.id,
        mutation,
        relationshipProjection,
        validRelationshipEvidenceSourceIds,
      );
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
        const sessionClaimed = await tx.chatSession.updateMany({
          where: {
            id: mutation.sessionId,
            userId,
            characterId: mutation.characterId,
            status: { not: "deleted" },
            deletedAt: null,
          },
          data: { logExtractedSeq: { increment: 1 } },
        });
        if (sessionClaimed.count !== 1) {
          throw new Error(
            `session authority changed before file completion for ${mutation.sessionId}`,
          );
        }
        await recordOutbox(tx, {
          eventType: CHAT_TO_MAIN_EVENTS.relationshipUpdated,
          aggregateType: "character",
          aggregateId: mutation.characterId,
          payload: { userId, fileMutationId: row.id },
        });
        if (mutation.candidates.length > 0) {
          await recordOutbox(tx, {
            eventType: CHAT_TO_MAIN_EVENTS.memoryUpdated,
            aggregateType: "user",
            aggregateId: userId,
            payload: {
              characterId: mutation.characterId,
              count: mutation.candidates.length,
              fileMutationId: row.id,
            },
          });
        }
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
        await recordOutbox(tx, {
          eventType: CHAT_TO_MAIN_EVENTS.accountErasureCompleted,
          aggregateType: "user",
          aggregateId: userId,
          payload: { userId, fileMutationId: row.id },
        });
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

export async function projectChatFileMutations(
  userId: string,
  authorityPrisma: ChatPrismaClient = chatProjectorPrisma,
): Promise<number> {
  try {
    return await authorityPrisma.$transaction(
      async (tx) => {
        await lockUser(tx, userId);
        return applyPendingChatFileMutationsTx(tx, userId);
      },
      { timeout: 30_000 },
    );
  } catch (error) {
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
 * Return one file-layer snapshot while preventing a newly committed mutation
 * from landing between the pending-intent check and the final file read.
 * Writers/projectors take the matching exclusive user advisory lock.
 */
export async function withReadableChatFileSnapshot<T>(
  userId: string,
  read: () => Promise<T>,
  prisma: ChatPrismaClient = chatPrisma,
  authorityPrisma: ChatPrismaClient = chatProjectorPrisma,
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
      return read();
    },
    { timeout: 30_000 },
  );
}

async function assertMemoryExtractAuthority(
  tx: Prisma.TransactionClient,
  userId: string,
  mutation: Extract<ChatFileMutation, { kind: "memory_extract" }>,
): Promise<void> {
  const [session, assistant, source, { linkage }] = await Promise.all([
    tx.chatSession.findUnique({ where: { id: mutation.sessionId } }),
    tx.message.findUnique({ where: { id: mutation.turnKey } }),
    tx.message.findUnique({ where: { id: mutation.userMessageId } }),
    loadSessionLinkage(tx, mutation.sessionId),
  ]);
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
      await forgetByMessageIds(userId, mutation.messageIds);
      // Later trace entries embed model context and injected memories, so a
      // source message can be copied into rows whose own message ids differ.
      // Legacy trace has no complete context provenance; privacy deletion/edit
      // therefore purges the session trace conservatively.
      await removeSessionTraceFiles(userId, mutation.sessionId);
      return;
    case "session_delete":
      await forgetByMessageIds(userId, mutation.messageIds);
      await removeSessionTraceFiles(userId, mutation.sessionId);
      return;
    case "account_delete":
      await deletePrefix(["sessions", userId]);
      await deletePrefix(["mem", userId]);
      return;
    case "memory_extract":
      if (mutation.relationshipEvidence) {
        await appendRelationshipEvidenceOnce(
          userId,
          mutation.characterId,
          mutation.relationshipEvidence,
        );
      } else {
        // Explicit schemaVersion 0 adapter for already-committed intents.
        await updateRelationshipOnce(
          userId,
          mutation.characterId,
          mutation.turnKey,
          {
            summaryDelta: mutation.summaryDelta,
            warmth: mutation.warmth ?? 0,
            familiarity: mutation.familiarity ?? 0,
          },
        );
      }
      if (mutation.candidates.length > 0) {
        await consolidateMemories(
          userId,
          mutation.characterId,
          mutation.candidates,
          { maxStored: mutation.maxStored },
        );
      }
      return;
    case "memory_update":
      await updateMemory(userId, mutation.memoryId, mutation.text);
      return;
    case "memory_delete":
      await deleteMemory(userId, mutation.memoryId);
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
      await deleteRelationship(userId, mutation.characterId);
      await deleteRelationshipEvidence(userId, mutation.characterId);
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
    case "trace_append":
      await appendTraceOnce(
        userId,
        mutation.sessionId,
        mutationId,
        mutation.entry,
      );
      return;
  }
}

function appliedFileMutationReceipt(
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
      return mutation;
    case "turn_forget":
    case "session_delete":
      return {
        kind: mutation.kind,
        sessionId: mutation.sessionId,
        characterId: mutation.characterId,
      };
    case "memory_update":
    case "memory_delete":
      return {
        kind: mutation.kind,
        memoryId: mutation.memoryId,
      };
    case "relationship_rebuild":
      return {
        kind: mutation.kind,
        characterId: mutation.characterId,
      };
    case "trace_append":
      return {
        kind: mutation.kind,
        sessionId: mutation.sessionId,
      };
    case "account_delete":
      return { kind: mutation.kind };
  }
}

async function appendTraceOnce(
  userId: string,
  sessionId: string,
  mutationId: string,
  entry: Record<string, unknown>,
): Promise<void> {
  const active = chatFsPaths.sessionLog(userId, sessionId);
  await withFileMutationLock(active, async () => {
    for (const file of await sessionTraceFiles(userId, sessionId)) {
      const raw = await readWhole(file);
      if (
        raw
          ?.split("\n")
          .some((line) => traceMutationId(line) === mutationId)
      ) {
        return;
      }
    }
    await appendLine(
      active,
      JSON.stringify({ ...entry, fileMutationId: mutationId }),
    );
  });
}

async function removeSessionTraceFiles(
  userId: string,
  sessionId: string,
): Promise<void> {
  const active = chatFsPaths.sessionLog(userId, sessionId);
  await withFileMutationLock(active, async () => {
    for (const file of await sessionTraceFiles(userId, sessionId)) {
      if (samePath(file, active)) await deletePrefix(file);
      else await withFileMutationLock(file, () => deletePrefix(file));
    }
  });
}

async function sessionTraceFiles(
  userId: string,
  sessionId: string,
): Promise<string[][]> {
  const prefix = `${sessionId}.`;
  return (await listPrefix(["sessions", userId]))
    .filter((relative) => {
      const filename = path.basename(relative);
      return filename === `${sessionId}.jsonl` || filename.startsWith(prefix);
    })
    .map((relative) => relative.split(path.sep));
}

function traceMutationId(line: string): string | null {
  if (!line.trim()) return null;
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    return typeof value.fileMutationId === "string"
      ? value.fileMutationId
      : null;
  } catch {
    return null;
  }
}

function samePath(left: string[], right: string[]): boolean {
  return left.length === right.length &&
    left.every((segment, index) => segment === right[index]);
}
