// SPEC: chat.memory.extract (P1-1, design §5). Derive long-term memory OFF the hot
// path: read the turn, re-check PG authority, write mem/*.md. PRIVACY IRON LAW:
// canMemorize re-queries PG message status/safety — never trust the jsonl text;
// blocked/deleted/no-memory content must NEVER become long-term memory (PRD §7.2).
// Each memory line carries source_message_ids back-linking PG.
import type { ChatPrismaClient } from "./db.js";
import { chatPrisma } from "./db.js";
import { appendLine, chatFsPaths } from "./chat-fs.js";
import { updateRelationship } from "./relationship.js";
import { createId } from "./id.js";
import { CHAT_TO_MAIN_EVENTS } from "@idream/shared/contracts";

export interface MemoryExtractPayload {
  sessionId: string;
  assistantMessageId: string;
  attempt: number;
}

export interface MemoryCandidate {
  scope: "global" | "character" | "session";
  type: "user_fact" | "preference" | "boundary" | "shared_event";
  text: string;
  confidence: number;
  sourceMessageIds: string[];
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

  const candidates = deriveCandidates(userMessage.content, userMessage.id);
  if (candidates.length === 0) return { written: 0, skipped: null };

  for (const c of candidates) {
    const line = renderMemoryLine(c);
    if (c.type === "boundary") {
      await appendLine(chatFsPaths.boundaries(session.userId), line);
    } else {
      await appendLine(chatFsPaths.memory(session.userId, session.characterId), line);
    }
  }
  await recordDerivedOutbox(prisma, CHAT_TO_MAIN_EVENTS.memoryUpdated, "user", session.userId, {
    characterId: session.characterId,
    count: candidates.length,
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

/** Port of the heuristic extractor (chat-runtime) — EN + ZH name/preference/boundary. */
export function deriveCandidates(userText: string, sourceMessageId: string): MemoryCandidate[] {
  const out: MemoryCandidate[] = [];
  const nickname =
    userText.match(/\bcall me ([a-z0-9 _-]{1,40})/i)?.[1]?.trim() ??
    userText.match(/(?:叫我|称呼我为)([\p{Script=Han}a-zA-Z0-9 _-]{1,40})/u)?.[1]?.trim();
  if (nickname) {
    out.push({ scope: "character", type: "preference", text: `User likes being called ${nickname}.`, confidence: 0.84, sourceMessageIds: [sourceMessageId] });
  }
  const liked =
    userText.match(/\bi like ([^.?!]{3,80})/i)?.[1]?.trim() ??
    userText.match(/我喜欢([^。！？\n]{2,80})/u)?.[1]?.trim();
  if (liked) {
    out.push({ scope: "character", type: "preference", text: `User likes ${liked}.`, confidence: 0.78, sourceMessageIds: [sourceMessageId] });
  }
  const boundary =
    userText.match(/\b(?:do not|don't) (?:remember|store|talk about) ([^.?!]{3,80})/i)?.[1]?.trim() ??
    userText.match(/(?:不要|别)(?:记住|保存|聊|提)([^。！？\n]{2,80})/u)?.[1]?.trim();
  if (boundary) {
    out.push({ scope: "global", type: "boundary", text: `Do not remember, store, or bring up ${boundary}.`, confidence: 0.9, sourceMessageIds: [sourceMessageId] });
  }
  return out;
}

/** memory.md line: a bullet + an inline source tag (front-matter-lite, parseable).
 * Carries a stable `mid` so the management API (memories.ts) can PATCH/DELETE it. */
function renderMemoryLine(c: MemoryCandidate): string {
  return `- [${c.type}] ${c.text} <!-- src:${c.sourceMessageIds.join(",")} mid:${createId("mem")} conf:${c.confidence} -->`;
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
