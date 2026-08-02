// SPEC: privacy deletion across PG + file layer (PRD §12, design §5). Deletion
// lands in the AUTHORITY layers (PG rows / files), not just an index.
//   - delete message → PG hard-delete + forget derived memory (source link).
//   - delete session → PG rows + remove sessions/{u}/{s}.jsonl (+ segments).
//   - delete account → all chat.* rows for user + sessions/{u}/ + mem/{u}/ prefixes
//     + emit chat.account_erasure.completed.
import type { Prisma } from "../generated/client/client.js";
import type { ChatPrismaClient } from "./db.js";
import { chatPrisma, chatProjectorPrisma } from "./db.js";
import {
  assertNoPendingChatFileMutationsTx,
  projectChatFileMutations,
  recordChatFileMutation,
  runWithProjectedChatFiles,
  withTurnAuthority,
} from "./file-mutations.js";
import { loadSessionLinkage } from "./relationship-authority.js";
import { CHAT_TO_MAIN_EVENTS } from "@idream/shared/contracts";
import { recordExchangeCorrection } from "./exchange-corrections.js";
import { lockTurn, lockUser } from "./turn-lock.js";

type PrivacyRedactionReason =
  | "logical_exchange_deleted"
  | "session_deleted";

function jsonRecord(value: Prisma.JsonValue): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function scrubImageRequestPayload(
  value: Prisma.JsonValue,
  reason: PrivacyRedactionReason,
): Prisma.InputJsonValue {
  return {
    ...jsonRecord(value),
    promptHint: null,
    conversationContext: null,
    privacyRedaction: {
      reason,
      redactedAt: new Date().toISOString(),
    },
  } as Prisma.InputJsonValue;
}

async function redactOrDeleteImageRequestOutbox(
  tx: Prisma.TransactionClient,
  input: {
    reason: PrivacyRedactionReason;
    attachmentIds?: readonly string[];
    messageIds?: readonly string[];
    exchangeIds?: readonly string[];
    sessionId?: string;
  },
): Promise<void> {
  const attachmentIds = [...new Set(input.attachmentIds ?? [])];
  const messageIds = [...new Set(input.messageIds ?? [])];
  const exchangeIds = [...new Set(input.exchangeIds ?? [])];
  const selectors: Prisma.ChatOutboxEventWhereInput[] = [
    ...(attachmentIds.length > 0
      ? [{ aggregateId: { in: attachmentIds } }]
      : []),
    ...messageIds.map((messageId) => ({
      payload: { path: ["messageId"], equals: messageId },
    })),
    ...exchangeIds.map((exchangeId) => ({
      payload: { path: ["exchangeId"], equals: exchangeId },
    })),
    ...(input.sessionId
      ? [{ payload: { path: ["sessionId"], equals: input.sessionId } }]
      : []),
  ];
  if (selectors.length === 0) return;

  const rows = await tx.chatOutboxEvent.findMany({
    where: {
      eventType: CHAT_TO_MAIN_EVENTS.imageRequested,
      OR: selectors,
    },
    select: { id: true, status: true, payload: true },
  });
  for (const row of rows) {
    if (row.status === "delivered") {
      await tx.chatOutboxEvent.update({
        where: { id: row.id },
        data: { payload: scrubImageRequestPayload(row.payload, input.reason) },
      });
      continue;
    }
    const deleted = await tx.chatOutboxEvent.deleteMany({
      where: { id: row.id, status: { not: "delivered" } },
    });
    if (deleted.count > 0) continue;

    // Delivery can win after the initial read. If it did, preserve its minimal
    // delivery evidence but remove the conversation text from the row.
    const delivered = await tx.chatOutboxEvent.findUnique({
      where: { id: row.id },
      select: { status: true, payload: true },
    });
    if (delivered?.status === "delivered") {
      await tx.chatOutboxEvent.update({
        where: { id: row.id },
        data: {
          payload: scrubImageRequestPayload(
            delivered.payload,
            input.reason,
          ),
        },
      });
    }
  }
}

export async function deleteMessage(
  input: { userId: string; messageId: string },
  prisma: ChatPrismaClient = chatPrisma,
  projectorPrisma: ChatPrismaClient = chatProjectorPrisma,
): Promise<void> {
  const message = await prisma.message.findUnique({ where: { id: input.messageId } });
  if (!message) return;
  const session = await prisma.chatSession.findUnique({ where: { id: message.sessionId } });
  if (!session || session.userId !== input.userId) {
    throw new Error("not your message");
  }
  await withTurnAuthority(
    {
      userId: input.userId,
      sessionId: session.id,
      prisma,
      projectorPrisma,
    },
    async (tx, recordIntent) => {
      const currentMessage = await tx.message.findUnique({
        where: { id: message.id },
      });
      const currentSession = await tx.chatSession.findUnique({
        where: { id: session.id },
      });
      if (!currentMessage) return;
      if (!currentSession || currentSession.userId !== input.userId) {
        throw new Error("not your message");
      }
      if (currentMessage.status === "deleted" || currentMessage.deletedAt) {
        return;
      }
      const { messages, linkage } = await loadSessionLinkage(
        tx,
        currentSession.id,
      );
      const messagesById = new Map(
        messages.map((candidate) => [candidate.id, candidate]),
      );
      const sourceIds = new Set<string>();
      const affectedAssistantIds = new Set<string>();
      if (currentMessage.role === "user") {
        sourceIds.add(currentMessage.id);
      } else {
        affectedAssistantIds.add(currentMessage.id);
        const exact = linkage.sources.get(currentMessage.id);
        if (exact) sourceIds.add(exact.id);
        for (const candidateId of
          linkage.candidateSourceIds.get(currentMessage.id) ?? []) {
          const candidate = messagesById.get(candidateId);
          if (candidate?.role === "user") sourceIds.add(candidate.id);
        }
      }

      // Ambiguous legacy relationship evidence is a connected component, not
      // a single pair. Scrub the whole component so no assistant variant can
      // retain text from a deleted candidate user turn (or vice versa).
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (const candidate of messages) {
          if (candidate.role !== "assistant") continue;
          const candidateSourceIds = new Set([
            ...(linkage.sources.get(candidate.id)
              ? [linkage.sources.get(candidate.id)!.id]
              : []),
            ...(linkage.candidateSourceIds.get(candidate.id) ?? []),
          ]);
          if (
            !affectedAssistantIds.has(candidate.id) &&
            ![...candidateSourceIds].some((sourceId) => sourceIds.has(sourceId))
          ) {
            continue;
          }
          if (!affectedAssistantIds.has(candidate.id)) {
            affectedAssistantIds.add(candidate.id);
            expanded = true;
          }
          for (const sourceId of candidateSourceIds) {
            if (messagesById.get(sourceId)?.role !== "user") continue;
            if (!sourceIds.has(sourceId)) {
              sourceIds.add(sourceId);
              expanded = true;
            }
          }
        }
      }
      const affectedAssistants = messages.filter(
        (candidate) =>
          candidate.role === "assistant" &&
          affectedAssistantIds.has(candidate.id),
      );
      const messageIds = Array.from(
        new Set([
          currentMessage.id,
          ...affectedAssistants.map((assistant) => assistant.id),
          ...sourceIds,
        ]),
      );
      const attachments = await tx.messageAttachment.findMany({
        where: { messageId: { in: messageIds } },
        select: { id: true },
      });
      await recordIntent({
        kind: "turn_forget",
        sessionId: currentSession.id,
        characterId: currentSession.characterId,
        messageIds,
      });
      await recordIntent({
        kind: "relationship_rebuild",
        characterId: currentSession.characterId,
      });

      await redactOrDeleteImageRequestOutbox(tx, {
        reason: "logical_exchange_deleted",
        attachmentIds: attachments.map((attachment) => attachment.id),
        messageIds,
        exchangeIds: [...sourceIds],
      });
      await tx.messageVersion.deleteMany({
        where: { messageId: { in: messageIds } },
      });
      await tx.messageAttachment.deleteMany({
        where: { messageId: { in: messageIds } },
      });
      await tx.message.updateMany({
        where: { id: { in: messageIds } },
        data: { status: "deleted", content: "", deletedAt: new Date() },
      });
      await tx.chatSession.update({
        where: { id: currentSession.id },
        data: {
          memorySummary: null,
          contextRevision: { increment: 1 },
        },
      });
      for (const sourceId of sourceIds) {
        const sourceAssistants = affectedAssistants.filter((assistant) =>
          linkage.sources.get(assistant.id)?.id === sourceId ||
          (linkage.candidateSourceIds.get(assistant.id) ?? [])
            .includes(sourceId),
        );
        await recordExchangeCorrection(tx, {
          exchangeId: sourceId,
          correctionType: "deleted",
          correctionRevision: Math.max(
            1,
            ...sourceAssistants.map((assistant) => assistant.attempt),
          ),
          userId: input.userId,
          sessionId: currentSession.id,
          messageIds,
        });
      }
    },
  );
}

export async function deleteSession(
  input: { userId: string; sessionId: string },
  prisma: ChatPrismaClient = chatPrisma,
  projectorPrisma: ChatPrismaClient = chatProjectorPrisma,
): Promise<void> {
  const session = await prisma.chatSession.findUnique({ where: { id: input.sessionId } });
  if (!session || session.userId !== input.userId) {
    throw new Error("not your session");
  }
  await withTurnAuthority(
    {
      userId: input.userId,
      sessionId: session.id,
      prisma,
      projectorPrisma,
    },
    async (tx, recordIntent) => {
      const currentSession = await tx.chatSession.findUnique({
        where: { id: session.id },
      });
      if (!currentSession || currentSession.userId !== input.userId) {
        throw new Error("not your session");
      }
      if (
        currentSession.status === "deleted" ||
        currentSession.deletedAt
      ) {
        return;
      }
      const { messages, linkage } = await loadSessionLinkage(tx, session.id);
      const ids = messages.map((m) => m.id);
      await recordIntent({
        kind: "session_delete",
        sessionId: currentSession.id,
        characterId: currentSession.characterId,
        messageIds: ids,
      });
      await recordIntent({
        kind: "relationship_rebuild",
        characterId: currentSession.characterId,
      });

      await redactOrDeleteImageRequestOutbox(tx, {
        reason: "session_deleted",
        sessionId: currentSession.id,
      });
      await tx.chatSendReceipt.deleteMany({
        where: { sessionId: session.id },
      });
      await tx.chatSessionReleaseMigration.deleteMany({
        where: { sessionId: session.id },
      });
      await tx.messageAttachment.deleteMany({
        where: { sessionId: session.id },
      });
      if (ids.length > 0) {
        await tx.messageVersion.deleteMany({
          where: { messageId: { in: ids } },
        });
      }
      await tx.chatModerationEvent.deleteMany({
        where: {
          OR: [
            { targetId: session.id },
            ...(ids.length > 0 ? [{ targetId: { in: ids } }] : []),
          ],
        },
      });
      await tx.message.deleteMany({ where: { sessionId: session.id } });
      await tx.chatSession.update({
        where: { id: session.id },
        data: {
          status: "deleted",
          deletedAt: new Date(),
          memorySummary: null,
          contextRevision: { increment: 1 },
        },
      });
      for (const message of messages) {
        const source = linkage.sources.get(message.id);
        if (
          message.role !== "assistant" ||
          message.status !== "sent" ||
          !source
        ) {
          continue;
        }
        await recordExchangeCorrection(tx, {
          exchangeId: source.id,
          correctionType: "superseded",
          correctionRevision: message.attempt,
          userId: input.userId,
          sessionId: currentSession.id,
          messageIds: ids,
        });
      }
    },
  );
}

export async function deleteAccount(
  input: { userId: string },
  prisma: ChatPrismaClient = chatPrisma,
  projectorPrisma: ChatPrismaClient = chatProjectorPrisma,
): Promise<void> {
  const alreadyCompleted = await prisma.chatOutboxEvent.findFirst({
    where: {
      aggregateId: input.userId,
      eventType: CHAT_TO_MAIN_EVENTS.accountErasureCompleted,
    },
    select: { id: true },
  });
  if (alreadyCompleted) return;

  const mutationRecorded = await prisma.$transaction(async (tx) => {
    await lockUser(tx, input.userId);
    const completedInsideLock = await tx.chatOutboxEvent.findFirst({
      where: {
        aggregateId: input.userId,
        eventType: CHAT_TO_MAIN_EVENTS.accountErasureCompleted,
      },
      select: { id: true },
    });
    if (completedInsideLock) return false;
    // Account erasure supersedes every earlier pending/applied file intent.
    // Even a poisoned intent or partial prior file write cannot block the
    // terminal prefix deletion that follows this transaction.
    const accountDeleteMutationId = await recordChatFileMutation(
      tx,
      input.userId,
      { kind: "account_delete" },
    );
    await tx.$queryRaw`
      SELECT chat.purge_file_mutations_for_account(
        ${input.userId},
        ${accountDeleteMutationId}
      )
    `;
    const sessions = await tx.chatSession.findMany({ where: { userId: input.userId }, select: { id: true } });
    const sessionIds = sessions.map((s) => s.id);
    let messageIds: string[] = [];
    let attachmentIds: string[] = [];
    if (sessionIds.length) {
      await tx.chatSessionReleaseMigration.deleteMany({ where: { sessionId: { in: sessionIds } } });
      await tx.chatSendReceipt.deleteMany({ where: { sessionId: { in: sessionIds } } });
      const messages = await tx.message.findMany({ where: { sessionId: { in: sessionIds } }, select: { id: true } });
      messageIds = messages.map((m) => m.id);
      const attachments = await tx.messageAttachment.findMany({
        where: { sessionId: { in: sessionIds } },
        select: { id: true },
      });
      attachmentIds = attachments.map((attachment) => attachment.id);
      await tx.messageAttachment.deleteMany({
        where: { sessionId: { in: sessionIds } },
      });
      if (messageIds.length) await tx.messageVersion.deleteMany({ where: { messageId: { in: messageIds } } });
      await tx.chatModerationEvent.deleteMany({
        where: {
          OR: [
            { targetId: { in: sessionIds } },
            ...(messageIds.length > 0
              ? [{ targetId: { in: messageIds } }]
              : []),
          ],
        },
      });
      await tx.message.deleteMany({ where: { sessionId: { in: sessionIds } } });
    }
    const aggregateIds = [
      input.userId,
      ...sessionIds,
      ...messageIds,
      ...attachmentIds,
    ];
    await tx.chatOutboxEvent.deleteMany({
      where: {
        OR: [
          { aggregateId: { in: aggregateIds } },
          {
            payload: {
              path: ["userId"],
              equals: input.userId,
            },
          },
        ],
      },
    });
    await tx.chatSession.deleteMany({ where: { userId: input.userId } });
    await tx.chatUsage.deleteMany({ where: { userId: input.userId } });
    return true;
  });
  if (mutationRecorded) {
    await projectChatFileMutations(input.userId, projectorPrisma);
  }
}
