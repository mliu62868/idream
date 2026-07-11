// SPEC: chat.memory.extract (P1-1, design §5). Derive long-term memory OFF the hot
// path: read the turn, re-check PG authority, write mem/*.md. PRIVACY IRON LAW:
// canMemorize re-queries PG message status/safety — never trust the jsonl text;
// blocked/deleted/no-memory content must NEVER become long-term memory (PRD §7.2).
// Each memory line carries source_message_ids back-linking PG.
import type { ChatPrismaClient } from "./db.js";
import { chatPrisma } from "./db.js";
import { updateRelationshipOnce } from "./relationship.js";
import { consolidateMemories } from "./memories.js";
import { extractCandidates } from "./extract.js";
import { resolvePolicy, snapshotFromView } from "./policy.js";
import { recordOutbox } from "./outbox.js";
import { CHAT_TO_MAIN_EVENTS } from "@idream/shared/contracts";

// Re-export the extractor surface so existing importers keep their path.
export { deriveCandidates } from "./extract.js";
export type { MemoryCandidate } from "./extract.js";

export interface MemoryExtractPayload {
  sessionId: string;
  assistantMessageId: string;
  /** Exact source turn. Optional only for draining jobs created before this field shipped. */
  userMessageId?: string;
  attempt: number;
}

export async function processMemoryExtract(
  payload: MemoryExtractPayload,
  prisma: ChatPrismaClient = chatPrisma,
): Promise<{ written: number; skipped: string | null }> {
  const session = await prisma.chatSession.findUnique({ where: { id: payload.sessionId } });
  if (!session) return { written: 0, skipped: "no_session" };

  // No-memory gate: never derive from an incognito session (PRD §7.2).
  if (!session.memoryEnabled) return { written: 0, skipped: "no_memory_session" };

  // Find the user turn that preceded this assistant message.
  const assistant = await prisma.message.findUnique({ where: { id: payload.assistantMessageId } });
  if (!assistant) return { written: 0, skipped: "no_assistant" };
  if (assistant.attempt !== payload.attempt) return { written: 0, skipped: "stale_attempt" };
  if (assistant.memoryExtractedAttempt >= payload.attempt) return { written: 0, skipped: "already_extracted" };
  const sourceId = payload.userMessageId ?? assistant.replyToMessageId;
  const userMessage = sourceId
    ? await prisma.message.findUnique({ where: { id: sourceId } })
    : await prisma.message.findFirst({
        // Compatibility only for jobs/rows created before reply_to_message_id.
        where: { sessionId: session.id, role: "user", createdAt: { lte: assistant.createdAt }, deletedAt: null },
        orderBy: [{ createdAt: "desc" }, { role: "desc" }],
      });
  if (!userMessage) return { written: 0, skipped: "no_user_turn" };
  if (userMessage.sessionId !== session.id || userMessage.role !== "user") {
    return { written: 0, skipped: "wrong_user_turn" };
  }

  // canMemorize: re-check PG authority — sent + not deleted + safety passed.
  if (!canMemorize(userMessage) || !canMemorize(assistant)) {
    return { written: 0, skipped: "blocked_or_deleted" };
  }

  // Relationship narrative is derived every allowed turn (file authority, P1-2).
  await updateRelationshipOnce(
    session.userId,
    session.characterId,
    `${assistant.id}:${payload.attempt}`,
    { summaryDelta: clampTurn(userMessage.content) },
  );

  // Semantic extraction (igrep mem derive) when enabled, regex floor otherwise —
  // off the hot path, so a slow LLM only delays this worker, never a reply.
  const candidates = await extractCandidates({
    userText: userMessage.content,
    sourceMessageId: userMessage.id,
    userId: session.userId,
    characterId: session.characterId,
  });
  let changedMemories = 0;
  if (candidates.length > 0) {
    // Consolidate INTO the authority files (dedup + confidence merge + tier cap)
    // instead of blind-appending, so repeated preferences never stack duplicates
    // and storage stays bounded by the entitlement (P1-C).
    const entitlement = await prisma.chatEntitlementView.findUnique({ where: { userId: session.userId } });
    const policy = resolvePolicy(snapshotFromView(entitlement), { memoryEnabled: true });
    const { added, merged } = await consolidateMemories(
      session.userId,
      session.characterId,
      candidates,
      { maxStored: policy.maxStoredMemories },
    );
    changedMemories = added + merged;
  }

  // Claim completion and publish derived events atomically. File writes above are
  // idempotent, so a crash before this TX safely retries without double-advancing
  // the relationship or duplicating memories.
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.message.updateMany({
      where: {
        id: assistant.id,
        attempt: payload.attempt,
        memoryExtractedAttempt: { lt: payload.attempt },
      },
      data: { memoryExtractedAttempt: payload.attempt },
    });
    if (claimed.count === 0) return;
    await tx.chatSession.update({
      where: { id: session.id },
      data: { logExtractedSeq: { increment: 1 } },
    });
    await recordOutbox(tx, {
      eventType: CHAT_TO_MAIN_EVENTS.relationshipUpdated,
      aggregateType: "character",
      aggregateId: session.characterId,
      payload: { userId: session.userId },
    });
    if (changedMemories > 0) {
      await recordOutbox(tx, {
        eventType: CHAT_TO_MAIN_EVENTS.memoryUpdated,
        aggregateType: "user",
        aggregateId: session.userId,
        payload: { characterId: session.characterId, count: changedMemories },
      });
    }
  });

  return { written: candidates.length, skipped: null };
}

interface MemorableMessage {
  status: string;
  safetyStatus: string;
  deletedAt: Date | null;
}

/** PRIVACY: only sent, non-deleted, safety-passed messages may seed memory. */
export function canMemorize(message: MemorableMessage): boolean {
  return (
    message.status === "sent" &&
    message.deletedAt === null &&
    (message.safetyStatus === "passed" || message.safetyStatus === "unknown")
  );
}

function clampTurn(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length <= 200 ? `User: ${t}` : `User: ${t.slice(0, 199)}…`;
}
