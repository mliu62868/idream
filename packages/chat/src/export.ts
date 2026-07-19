// SPEC: account data export (P1-3, PRD §12). Aggregate the user's chat data from
// ALL THREE stores: PG ledger (sessions/messages/usage), file-layer memory
// (mem/*.md) and relationship (relationship.md). One bundle, source-of-truth honest.
import type { ChatPrismaClient } from "./db.js";
import { chatPrisma } from "./db.js";
import { chatFsPaths, listPrefix, readWhole } from "./chat-fs.js";
import { parseRelationship, type RelationshipState } from "./relationship.js";
import { withReadableChatFileSnapshot } from "./file-mutations.js";

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
  return withReadableChatFileSnapshot(
    userId,
    async () => {
      const sessions = await prisma.chatSession.findMany({
        where: { userId },
      });
      const sessionIds = sessions.map((session) => session.id);
      const messages = sessionIds.length
        ? await prisma.message.findMany({
            where: { sessionId: { in: sessionIds } },
            orderBy: { createdAt: "asc" },
          })
        : [];
      const usage = await prisma.chatUsage.findMany({ where: { userId } });

      const memFiles = await listPrefix(["mem", userId]);
      const memories: AccountExport["memories"] = [];
      const relationships: AccountExport["relationships"] = [];
      for (const rel of memFiles) {
        const parts = rel.split("/");
        const charId = parts[2];
        const file = parts[3];
        if (file === "memory.md") {
          const raw =
            (await readWhole(chatFsPaths.memory(userId, charId))) ?? "";
          for (const line of raw.split("\n")) {
            const text = line
              .replace(/^[-*]\s*/, "")
              .replace(/<!--[\s\S]*?-->/, "")
              .trim();
            if (text && !text.startsWith("#")) {
              memories.push({ characterId: charId, text });
            }
          }
        } else if (file === "relationship.md") {
          relationships.push({
            characterId: charId,
            state: parseRelationship(
              await readWhole(
                chatFsPaths.relationship(userId, charId),
              ),
            ),
          });
        }
      }
      const boundariesRaw = await readWhole(chatFsPaths.boundaries(userId));
      const boundaries = (boundariesRaw ?? "")
        .split("\n")
        .map((line) =>
          line
            .replace(/^[-*]\s*/, "")
            .replace(/<!--[\s\S]*?-->/, "")
            .trim(),
        )
        .filter(
          (line) => line && !line.startsWith("#") && line !== "---",
        );

      return {
        userId,
        exportedAt: now.toISOString(),
        sessions: sessions.map((session) => ({
          id: session.id,
          characterId: session.characterId,
          status: session.status,
          title: session.title,
          lastMessageAt: session.lastMessageAt?.toISOString() ?? null,
        })),
        messages: messages.map((message) => ({
          id: message.id,
          sessionId: message.sessionId,
          role: message.role,
          content: message.content,
          status: message.status,
          createdAt: message.createdAt.toISOString(),
        })),
        usage: usage.map((row) => ({
          periodStart: row.periodStart.toISOString(),
          messagesUsed: row.messagesUsed,
        })),
        memories,
        boundaries,
        relationships,
      };
    },
    prisma,
  );
}
