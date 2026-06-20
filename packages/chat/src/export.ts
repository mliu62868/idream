// SPEC: account data export (P1-3, PRD §12). Aggregate the user's chat data from
// ALL THREE stores: PG ledger (sessions/messages/usage), file-layer memory
// (mem/*.md) and relationship (relationship.md). One bundle, source-of-truth honest.
import type { ChatPrismaClient } from "./db.js";
import { chatPrisma } from "./db.js";
import { chatFsPaths, listPrefix, readWhole } from "./chat-fs.js";
import { parseRelationship, type RelationshipState } from "./relationship.js";

export interface AccountExport {
  userId: string;
  exportedAt: string;
  sessions: Array<{ id: string; characterId: string; status: string; title: string | null; lastMessageAt: string | null }>;
  messages: Array<{ id: string; sessionId: string; role: string; content: string; status: string; createdAt: string }>;
  usage: Array<{ periodStart: string; messagesUsed: number }>;
  memories: Array<{ characterId: string; text: string }>;
  boundaries: string[];
  relationships: Array<{ characterId: string; state: RelationshipState }>;
}

export async function exportAccount(
  userId: string,
  now: Date,
  prisma: ChatPrismaClient = chatPrisma,
): Promise<AccountExport> {
  const sessions = await prisma.chatSession.findMany({ where: { userId } });
  const sessionIds = sessions.map((s) => s.id);
  const messages = sessionIds.length
    ? await prisma.message.findMany({ where: { sessionId: { in: sessionIds } }, orderBy: { createdAt: "asc" } })
    : [];
  const usage = await prisma.chatUsage.findMany({ where: { userId } });

  // file layer: walk mem/{userId}/* for memory.md + relationship.md per character
  const memFiles = await listPrefix(["mem", userId]);
  const memories: AccountExport["memories"] = [];
  const relationships: AccountExport["relationships"] = [];
  for (const rel of memFiles) {
    const parts = rel.split("/"); // mem/{userId}/{charId}/file.md
    const charId = parts[2];
    const file = parts[3];
    if (file === "memory.md") {
      const raw = (await readWhole(chatFsPaths.memory(userId, charId))) ?? "";
      for (const line of raw.split("\n")) {
        const text = line.replace(/^[-*]\s*/, "").replace(/<!--[\s\S]*?-->/, "").trim();
        if (text && !text.startsWith("#")) memories.push({ characterId: charId, text });
      }
    } else if (file === "relationship.md") {
      relationships.push({ characterId: charId, state: parseRelationship(await readWhole(chatFsPaths.relationship(userId, charId))) });
    }
  }
  const boundariesRaw = await readWhole(chatFsPaths.boundaries(userId));
  const boundaries = (boundariesRaw ?? "")
    .split("\n")
    .map((l) => l.replace(/^[-*]\s*/, "").replace(/<!--[\s\S]*?-->/, "").trim())
    .filter((l) => l && !l.startsWith("#") && l !== "---");

  return {
    userId,
    exportedAt: now.toISOString(),
    sessions: sessions.map((s) => ({
      id: s.id,
      characterId: s.characterId,
      status: s.status,
      title: s.title,
      lastMessageAt: s.lastMessageAt?.toISOString() ?? null,
    })),
    messages: messages.map((m) => ({
      id: m.id,
      sessionId: m.sessionId,
      role: m.role,
      content: m.content,
      status: m.status,
      createdAt: m.createdAt.toISOString(),
    })),
    usage: usage.map((u) => ({ periodStart: u.periodStart.toISOString(), messagesUsed: u.messagesUsed })),
    memories,
    boundaries,
    relationships,
  };
}
