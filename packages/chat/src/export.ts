// SPEC: account data export (P1-3, PRD §12). Aggregate the user's chat data from
// PG ledger plus Chat-owned boundaries and relationship state.
import type { ChatPrismaClient } from "./db.js";
import { chatPrisma } from "./db.js";
import { chatFsPaths, listPrefix, readWhole } from "./chat-fs.js";
import { readBoundaries } from "./boundaries.js";
import { parseRelationship, type RelationshipState } from "./relationship.js";
import { withReadableChatFileSnapshot } from "./file-mutations.js";

export interface AccountExport {
  userId: string;
  exportedAt: string;
  sessions: Array<{ id: string; characterId: string; status: string; title: string | null; lastMessageAt: string | null }>;
  messages: Array<{ id: string; sessionId: string; role: string; content: string; status: string; createdAt: string }>;
  usage: Array<{ periodStart: string; messagesUsed: number }>;
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
    async (tx) => {
      const sessions = await tx.chatSession.findMany({
        where: { userId },
      });
      const sessionIds = sessions.map((session) => session.id);
      const messages = sessionIds.length
        ? await tx.message.findMany({
            where: { sessionId: { in: sessionIds } },
            orderBy: { createdAt: "asc" },
          })
        : [];
      const usage = await tx.chatUsage.findMany({ where: { userId } });

      // Quarantined (reset) relationship files are an engineering artefact,
      // not part of the account's live data.
      const memFiles = (await listPrefix(["mem", userId]))
        .filter((rel) => !rel.split("/").includes(".reset-quarantine"));
      const relationships: AccountExport["relationships"] = [];
      for (const rel of memFiles) {
        const parts = rel.split("/");
        const charId = parts[2];
        const file = parts[3];
        if (file === "relationship.md") {
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
      const boundaries = await readBoundaries(userId);

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
        boundaries,
        relationships,
      };
    },
    prisma,
  );
}
