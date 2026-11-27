// Reply versions: text replies superseded by regenerate stay selectable on the
// latest Turn. Selecting one is a revision of that Turn (new attempt), never a
// Chat execution, so it charges nothing and replays no tool effect.
//
// INVARIANT: only text-only replies become versions. Media replies bind their
// attachments, billing and delivery to one attempt (and regenerate carries the
// durable action forward), so swapping them would detach paid state from the
// reply that owns it.
import { Prisma, type ChatTurn } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import { retireCompanionMemoryAttempt, scheduleCompanionMemoryProjection } from "./companion-memory-authority";
import { appendChatExchangeCorrected } from "./exchange-metrics";
import { attachmentAttempt } from "./turn-scope";
import { ACTIVE_ASSISTANT_STATES, jsonRecord, toJson } from "./turn-ledger-support";

/** Versions the user can switch between, including the current reply. */
export const MAX_REPLY_VERSIONS = 10;

/** Generation order of the current reply; a selected version keeps its own. */
export function replyOrdinal(turn: { attempt: number; terminalEvidence: Prisma.JsonValue | null }): number {
  const value = jsonRecord(turn.terminalEvidence ?? null).replyOrdinal;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : turn.attempt;
}

async function hasCurrentAttemptAttachments(tx: Prisma.TransactionClient, turn: { id: string; attempt: number }) {
  const rows = await tx.chatTurnAttachment.findMany({ where: { turnId: turn.id }, select: { metadata: true } });
  return rows.some((row) => attachmentAttempt(row.metadata) === turn.attempt);
}

/**
 * Keep the current sent text reply as a version before a revision replaces it.
 * Called under the Turn lock. Returns whether a version was kept.
 */
export async function preserveReplyVersion(tx: Prisma.TransactionClient, turn: ChatTurn): Promise<boolean> {
  if (turn.userStatus !== "sent" || turn.assistantStatus !== "sent" || !turn.assistantContent.trim()) return false;
  if (await hasCurrentAttemptAttachments(tx, turn)) return false;
  const ordinal = replyOrdinal(turn);
  const finishReason = jsonRecord(turn.terminalEvidence ?? null).finishReason;
  await tx.chatTurnAlternative.upsert({
    where: { turnId_ordinal: { turnId: turn.id, ordinal } },
    create: {
      turnId: turn.id,
      ordinal,
      assistantContent: turn.assistantContent,
      model: turn.model,
      promptTokens: turn.promptTokens,
      completionTokens: turn.completionTokens,
      finishReason: typeof finishReason === "string" ? finishReason : null,
      sceneVersion: turn.sceneVersion,
      scene: turn.scene === null ? Prisma.JsonNull : toJson(turn.scene),
    },
    update: {},
  });
  // The next reply occupies one of the MAX_REPLY_VERSIONS slots.
  const overflow = await tx.chatTurnAlternative.findMany({
    where: { turnId: turn.id },
    orderBy: { ordinal: "desc" },
    skip: MAX_REPLY_VERSIONS - 1,
    select: { ordinal: true },
  });
  if (overflow.length > 0) {
    await tx.chatTurnAlternative.deleteMany({
      where: { turnId: turn.id, ordinal: { in: overflow.map((row) => row.ordinal) } },
    });
  }
  return true;
}

/** Versions answer one exact user message; edits and newer Turns retire them. */
export async function discardReplyVersions(tx: Prisma.TransactionClient, where: Prisma.ChatTurnAlternativeWhereInput) {
  await tx.chatTurnAlternative.deleteMany({ where });
}

/**
 * Make an earlier version the current reply. `lockedTurn` must be the latest
 * Turn, locked by the caller's revision ladder.
 */
export async function selectLockedReplyVersion(tx: Prisma.TransactionClient, input: {
  userId: string;
  characterId: string;
  turn: ChatTurn;
  ordinal: number;
  expectedAttempt: number;
}): Promise<ChatTurn> {
  const { userId, characterId, turn, ordinal, expectedAttempt } = input;
  if (turn.attempt !== expectedAttempt) {
    throw Errors.versionConflict("This reply changed. Refresh to see its current versions.", {
      reason: "version_mismatch", attempt: turn.attempt,
    });
  }
  if (turn.userStatus !== "sent") throw Errors.conflict("A blocked message has no reply versions");
  if (ACTIVE_ASSISTANT_STATES.includes(turn.assistantStatus)) {
    throw Errors.conflict("A reply is already generating", { reason: "reply_in_progress" });
  }
  if (replyOrdinal(turn) === ordinal && turn.assistantStatus === "sent") return turn;
  const version = await tx.chatTurnAlternative.findUnique({ where: { turnId_ordinal: { turnId: turn.id, ordinal } } });
  if (!version) throw Errors.notFound("This reply version is no longer available");
  if (await hasCurrentAttemptAttachments(tx, turn)) {
    throw Errors.conflict("A reply with media cannot be swapped for another version", { reason: "media_reply" });
  }
  // Whatever memory may hold of the outgoing reply is retired exactly as a
  // regenerate would retire it (rebuild only when it could have been projected).
  const memory = await retireCompanionMemoryAttempt(tx, { userId, characterId, turn, scope: "attempt" });
  await preserveReplyVersion(tx, turn);
  const now = new Date();
  const selected = await tx.chatTurn.update({
    where: { id: turn.id },
    data: {
      attempt: { increment: 1 },
      assistantContent: version.assistantContent,
      assistantStatus: "sent",
      model: version.model,
      promptTokens: version.promptTokens,
      completionTokens: version.completionTokens,
      terminalEvidence: toJson({
        authority: "main_reply_version_selected",
        replyOrdinal: version.ordinal,
        selectedFromAttempt: turn.attempt,
        ...(version.finishReason ? { finishReason: version.finishReason } : {}),
      }),
      terminalAt: now,
      // Every version of this Turn advanced the same Scene anchor by one.
      sceneVersion: version.sceneVersion,
      scene: version.scene === null ? Prisma.JsonNull : toJson(version.scene),
      attemptStartedAt: now,
      admissionAttempts: 0,
      admissionLeaseToken: null,
      admissionLeaseUntil: null,
      admissionLastError: Prisma.JsonNull,
      admittedAt: null,
      executionDeadlineAt: null,
    },
  });
  await tx.chatTurnAlternative.delete({ where: { turnId_ordinal: { turnId: turn.id, ordinal } } });
  // The exchange's counted reply is now the adopted version, not the latest completion.
  await appendChatExchangeCorrected(tx, turn, {
    userId, correctionType: "selected", correctionRevision: selected.attempt, selectedAssistantMessageId: turn.assistantMessageId,
  }, now);
  // A rebuild exports every sent Turn when it runs, including this one.
  if (!memory.rebuilt && selected.memoryEnabled) {
    await scheduleCompanionMemoryProjection(tx, { userId, characterId });
  }
  return selected;
}

/** Public projection: all versions of the latest Turn's reply, in generation order. */
export function publicReplyVersions(turn: {
  attempt: number;
  assistantContent: string;
  assistantStatus: string;
  terminalEvidence: Prisma.JsonValue | null;
  alternatives?: Array<{ ordinal: number; assistantContent: string }>;
}): { versions: Array<{ ordinal: number; content: string; current: boolean }> } | undefined {
  const alternatives = turn.alternatives ?? [];
  if (alternatives.length === 0) return undefined;
  const current = turn.assistantStatus === "sent"
    ? [{ ordinal: replyOrdinal(turn), content: turn.assistantContent, current: true }]
    : [];
  const versions = [
    ...alternatives.map((row) => ({ ordinal: row.ordinal, content: row.assistantContent, current: false })),
    ...current,
  ].sort((a, b) => a.ordinal - b.ordinal);
  return { versions };
}
