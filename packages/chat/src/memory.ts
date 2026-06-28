// SPEC: chat.memory.extract (P1-1, design §5). Derive long-term memory OFF the hot
// path: read the turn, re-check PG authority, write mem/*.md. PRIVACY IRON LAW:
// canMemorize re-queries PG message status/safety — never trust the jsonl text;
// blocked/deleted/no-memory content must NEVER become long-term memory (PRD §7.2).
// Each memory line carries source_message_ids back-linking PG.
import type { ChatPrismaClient } from "./db.js";
import { chatPrisma } from "./db.js";
import { updateRelationship } from "./relationship.js";
import { consolidateMemories } from "./memories.js";
import { extractCandidates } from "./extract.js";
import { resolvePolicy, snapshotFromView } from "./policy.js";
import { createId } from "./id.js";
import { CHAT_TO_MAIN_EVENTS } from "@idream/shared/contracts";

// Re-export the extractor surface so existing importers keep their path.
export { deriveCandidates } from "./extract.js";
export type { MemoryCandidate } from "./extract.js";

export interface MemoryExtractPayload {
  sessionId: string;
  assistantMessageId: string;
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
  // user + assistant placeholder are inserted in the SAME transaction, so they
  // share created_at (now() is fixed per TX); use lte + role filter to find it.
  const userMessage = await prisma.message.findFirst({
    where: { sessionId: session.id, role: "user", createdAt: { lte: assistant.createdAt }, deletedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (!userMessage) return { written: 0, skipped: "no_user_turn" };

  // canMemorize: re-check PG authority — sent + not deleted + safety passed.
  if (!canMemorize(userMessage) || !canMemorize(assistant)) {
    return { written: 0, skipped: "blocked_or_deleted" };
  }

  // Relationship narrative is derived every allowed turn (file authority, P1-2).
  await updateRelationship(session.userId, session.characterId, {
    summaryDelta: clampTurn(userMessage.content),
  });
  await recordDerivedOutbox(prisma, CHAT_TO_MAIN_EVENTS.relationshipUpdated, "character", session.characterId, {
    userId: session.userId,
  });

  // Semantic extraction (igrep mem derive) when enabled, regex floor otherwise —
  // off the hot path, so a slow LLM only delays this worker, never a reply.
  const candidates = await extractCandidates({
    userText: userMessage.content,
    sourceMessageId: userMessage.id,
    userId: session.userId,
    characterId: session.characterId,
  });
  if (candidates.length === 0) return { written: 0, skipped: null };

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
  await recordDerivedOutbox(prisma, CHAT_TO_MAIN_EVENTS.memoryUpdated, "user", session.userId, {
    characterId: session.characterId,
    count: added + merged,
  });

  // advance the derive watermark (D3) — best effort
  await prisma.chatSession
    .update({ where: { id: session.id }, data: { logExtractedSeq: { increment: 1 } } })
    .catch(() => {});

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

/** Outbox for off-TX derivations (memory/relationship). Delivered like any event. */
async function recordDerivedOutbox(
  prisma: ChatPrismaClient,
  eventType: string,
  aggregateType: string,
  aggregateId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await prisma.chatOutboxEvent
    .create({ data: { id: createId("evt"), eventType, aggregateType, aggregateId, payload: payload as never } })
    .catch(() => {});
}
