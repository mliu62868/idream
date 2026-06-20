// SPEC: privacy deletion across PG + file layer (PRD §12, design §5). Deletion
// lands in the AUTHORITY layers (PG rows / files), not just an index.
//   - delete message → PG hard-delete + forget derived memory (source link).
//   - delete session → PG rows + remove sessions/{u}/{s}.jsonl (+ segments).
//   - delete account → all chat.* rows for user + sessions/{u}/ + mem/{u}/ prefixes
//     + emit chat.account_erasure.completed.
import { rm, readdir } from "node:fs/promises";
import path from "node:path";
import type { ChatPrismaClient } from "./db.js";
import { chatPrisma } from "./db.js";
import { env } from "./env.js";
import { deletePrefix } from "./chat-fs.js";
import { recordOutbox } from "./outbox.js";
import { CHAT_TO_MAIN_EVENTS } from "@idream/shared/contracts";

export async function deleteMessage(
  input: { userId: string; messageId: string },
  prisma: ChatPrismaClient = chatPrisma,
): Promise<void> {
  const message = await prisma.message.findUnique({ where: { id: input.messageId } });
  if (!message) return;
  const session = await prisma.chatSession.findUnique({ where: { id: message.sessionId } });
  if (!session || session.userId !== input.userId) {
    throw new Error("not your message");
  }
  await prisma.$transaction(async (tx) => {
    await tx.messageVersion.deleteMany({ where: { messageId: message.id } });
    await tx.message.update({
      where: { id: message.id },
      data: { status: "deleted", content: "", deletedAt: new Date() },
    });
  });
  // memory forget is async (memory.extract / forget worker re-checks source links)
}

export async function deleteSession(
  input: { userId: string; sessionId: string },
  prisma: ChatPrismaClient = chatPrisma,
): Promise<void> {
  const session = await prisma.chatSession.findUnique({ where: { id: input.sessionId } });
  if (!session || session.userId !== input.userId) {
    throw new Error("not your session");
  }
  await prisma.$transaction(async (tx) => {
    const messages = await tx.message.findMany({ where: { sessionId: session.id }, select: { id: true } });
    const ids = messages.map((m) => m.id);
    if (ids.length) await tx.messageVersion.deleteMany({ where: { messageId: { in: ids } } });
    await tx.message.deleteMany({ where: { sessionId: session.id } });
    await tx.chatSession.update({
      where: { id: session.id },
      data: { status: "deleted", deletedAt: new Date() },
    });
    await recordOutbox(tx, {
      eventType: CHAT_TO_MAIN_EVENTS.sessionDeleted,
      aggregateType: "session",
      aggregateId: session.id,
      payload: { userId: input.userId },
    });
  });

  // remove the agent trace: active jsonl + any numbered segments
  await removeSessionFiles(session.userId, session.id);
}

export async function deleteAccount(
  input: { userId: string },
  prisma: ChatPrismaClient = chatPrisma,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const sessions = await tx.chatSession.findMany({ where: { userId: input.userId }, select: { id: true } });
    const sessionIds = sessions.map((s) => s.id);
    if (sessionIds.length) {
      const messages = await tx.message.findMany({ where: { sessionId: { in: sessionIds } }, select: { id: true } });
      const messageIds = messages.map((m) => m.id);
      if (messageIds.length) await tx.messageVersion.deleteMany({ where: { messageId: { in: messageIds } } });
      await tx.message.deleteMany({ where: { sessionId: { in: sessionIds } } });
    }
    await tx.chatSession.deleteMany({ where: { userId: input.userId } });
    await tx.chatUsage.deleteMany({ where: { userId: input.userId } });
    await recordOutbox(tx, {
      eventType: CHAT_TO_MAIN_EVENTS.accountErasureCompleted,
      aggregateType: "user",
      aggregateId: input.userId,
      payload: { userId: input.userId },
    });
  });

  // file layer: wipe both prefixes for the tenant
  await deletePrefix(["sessions", input.userId]);
  await deletePrefix(["mem", input.userId]);
}

/** Remove the active jsonl + all numbered segments for a session. */
async function removeSessionFiles(userId: string, sessionId: string): Promise<void> {
  const dir = path.join(env.CHAT_FS_ROOT, "sessions", userId);
  const files = await readdir(dir).catch(() => [] as string[]);
  const prefix = `${sessionId}.`;
  await Promise.all(
    files
      .filter((f) => f === `${sessionId}.jsonl` || f.startsWith(prefix))
      .map((f) => rm(path.join(dir, f), { force: true })),
  );
}
