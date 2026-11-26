// Session lifecycle: list, open, archive, rename, delete, memory toggle.
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { isMediaAssetOperationalForAuthority } from "@/server/lib/media-asset-authority";
import { appendCanonicalMetricEventsForUser } from "@/server/modules/admin-v2/metrics/event-writer";
import { isReusablePlatformAssetWhere } from "@/server/modules/ourdream/chat-image-reuse";
import { publicReadableMediaAssetWhere } from "@/server/modules/ourdream/public-content-audience";
import { collectionMediaViewUrl } from "@/server/modules/ourdream/public-read-model";
import { assertNoPendingCompanionMemoryRebuild, scheduleCompanionMemoryRebuild } from "./companion-memory-authority";
import { lockChatScope } from "./turn-scope";
import { ACTIVE_ASSISTANT_STATES, optionalText, requiredText } from "./turn-ledger-support";
import { chatExchangeCorrectedEvent } from "./exchange-metrics";
import { chatSessionCharacterPin, repinOwnerSessionToServingRelease, requireSession } from "./chat-session-authority";
import { publicSession } from "./chat-read-model";
import { redactChatImageSourceText, refundPendingDelayedAttachments } from "./turn-media-rebind";

export async function listChatSessions(userId: string) {
  const rows = await prisma.recentChat.findMany({
    where: { userId, groupId: null },
    orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
    include: {
      character: { select: { name: true, imageAssetId: true } },
      turns: {
        // Only committed, visible text belongs in a preview. Proactive userContent
        // is an internal instruction, and an unfinished reply is not delivered.
        where: { OR: [
          { assistantStatus: "sent", assistantContent: { not: "" } },
          { origin: "user", userStatus: "sent", userContent: { not: "" } },
        ] },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 1,
        select: { assistantMessageId: true, assistantStatus: true, assistantContent: true, userMessageId: true, userContent: true, origin: true },
      },
    },
  });
  const imageIds = [...new Set(rows.flatMap(row => row.character.imageAssetId ? [row.character.imageAssetId] : []))];
  // Batch the same media audience used by owned-media reads. A private draft
  // belonging to another creator cannot become a chat-list avatar.
  const images = imageIds.length ? await prisma.mediaAsset.findMany({
    where: {
      id: { in: imageIds }, deletedAt: null, type: "image", safetyStatus: "passed",
      OR: [...(isReusablePlatformAssetWhere(userId).OR ?? []), publicReadableMediaAssetWhere],
    },
    select: { id: true, type: true, url: true, storageKey: true, contentType: true, metadata: true },
  }) : [];
  const imageById = new Map(images.filter(image => isMediaAssetOperationalForAuthority(image.metadata)).map(image => [image.id, collectionMediaViewUrl(image)]));
  return rows.map((row) => {
    const turn = row.turns[0];
    const assistant = turn?.assistantStatus === "sent" && Boolean(turn.assistantContent.trim());
    const content = (assistant ? turn.assistantContent : turn?.origin === "user" ? turn.userContent : "").replace(/\s+/g, " ").trim();
    return {
      ...publicSession(row, row.character.name),
      characterImage: imageById.get(row.character.imageAssetId ?? "") ?? null,
      lastMessage: content ? {
        id: assistant ? turn!.assistantMessageId : turn!.userMessageId,
        role: assistant ? "assistant" as const : "user" as const,
        content: content.length > 180 ? `${content.slice(0, 180)}…` : content,
      } : null,
    };
  });
}

export async function createChatSession(
  userId: string,
  input: {
    characterId: string;
    title?: string;
    entryExposureId?: string;
    entryJourneyId?: string;
    entryPlacementId?: string;
  },
) {
  const characterId = requiredText(input.characterId, "characterId", 160);
  const { character, owner, release, content, visual, openingMessage } = await chatSessionCharacterPin(userId, characterId);
  const activeKey = `${userId}:${characterId}`;
  const existing = await prisma.recentChat.findUnique({ where: { activeKey } });
  if (existing) {
    if (existing.characterReleaseId === release?.id) return publicSession(existing, character.name);
    if (owner) {
      // Only a Release-pinned session behind a different live Release can move;
      // anything else would take the user-row lock for nothing.
      if (!release || !existing.characterReleaseId) return publicSession(existing, character.name);
      // Same lock ladder as beginChatTurn, so no reply can start between the
      // pending-reply check and the re-pin.
      const repinned = await prisma.$transaction(async (tx) => {
        const { session } = await lockChatScope(tx, { userId, at: { session: existing.sessionId } });
        // Archived concurrently: fall through and open the new active session.
        if (session.activeKey !== activeKey) return null;
        return repinOwnerSessionToServingRelease(tx, userId, session);
      });
      if (repinned) return publicSession(repinned, character.name);
    }
    if (!owner) {
      // INVARIANT: a session keeps its immutable Release pin. When Serving moves,
      // preserve that history and open a new active session instead of mutating it.
      // INTENT: admission only runs Turns of active sessions, so archiving under a
      // pending reply would leave it spinning forever. Cancelling it would throw
      // away the answer the user is waiting for, and refusing would block opening
      // the chat at all. Keep the old session until its reply ends; the next open
      // moves to the new Release. Locks follow beginChatTurn so no reply can start
      // between the check and the archive.
      const kept = await prisma.$transaction(async (tx) => {
        const { session } = await lockChatScope(tx, { userId, at: { session: existing.sessionId } });
        if (session.activeKey !== activeKey) return null;
        const active = await tx.chatTurn.findFirst({
          where: { sessionId: session.sessionId, assistantStatus: { in: ACTIVE_ASSISTANT_STATES } },
          select: { id: true },
        });
        if (active) return session;
        await tx.recentChat.update({
          where: { sessionId: session.sessionId },
          data: { status: "archived", activeKey: null },
        });
        return null;
      });
      if (kept) return publicSession(kept, character.name);
    }
  }

  try {
    const created = await prisma.recentChat.create({
      data: {
        sessionId: randomUUID(),
        userId,
        characterId,
        // INVARIANT: title 只存用户自己起的会话名；默认名不落库，读时从角色名派生，
        // 角色改名后旧会话标题随之更新，而用户改过的名字不受影响。
        title: optionalText(input.title, 120),
        activeKey,
        characterContentVersionId: content?.id ?? null,
        characterReleaseId: release?.id ?? null,
        characterVisualProfileId: visual?.id ?? null,
        characterVisualProfileVersion: visual?.version ?? null,
        releasePinnedAt: new Date(),
        openingMessage,
        entryExposureId: optionalText(input.entryExposureId, 200),
        entryJourneyId: optionalText(input.entryJourneyId, 200),
        entryPlacementId: optionalText(input.entryPlacementId, 200),
      },
    });
    return publicSession(created, character.name);
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
      throw error;
    }
    return publicSession(
      await prisma.recentChat.findUniqueOrThrow({ where: { activeKey } }),
      character.name,
    );
  }
}

export async function deleteChatSession(userId: string, sessionId: string) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
    await deleteSessionTranscript(tx, userId, sessionId, null);
    await tx.deletedChatTurnSend.deleteMany({ where: { userId, conversationKey: `session:${sessionId}` } });
  });
}

export async function deleteGroupChatConversation(userId: string, groupId: string) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "group_conversations" WHERE id = ${groupId} FOR UPDATE`;
    const group = await tx.groupConversation.findFirst({ where: { id: groupId, userId }, include: { members: { orderBy: { groupPosition: "asc" } } } });
    if (!group) throw Errors.notFound("Group conversation not found");
    for (const member of group.members) await deleteSessionTranscript(tx, userId, member.sessionId, groupId);
    await tx.groupConversation.delete({ where: { id: groupId } });
    await tx.deletedChatTurnSend.deleteMany({ where: { userId, conversationKey: `group:${groupId}` } });
  });
}

async function deleteSessionTranscript(tx: Prisma.TransactionClient, userId: string, sessionId: string, groupId: string | null) {
    await tx.$queryRaw`SELECT "sessionId" FROM "recent_chats" WHERE "sessionId" = ${sessionId} FOR UPDATE`;
    const session = await tx.recentChat.findFirst({ where: { sessionId, userId } });
    if (!session) throw Errors.notFound("Chat session not found");
    if (session.groupId !== groupId) throw Errors.conflict("Delete this conversation from its group chat");
    await assertNoPendingCompanionMemoryRebuild(tx, userId, session.characterId);
    const active = await tx.chatTurn.findFirst({
      where: { sessionId, assistantStatus: { in: ACTIVE_ASSISTANT_STATES } },
      select: { id: true },
    });
    if (active) throw Errors.conflict("Cancel the active reply before deleting this chat");
    const turnIds = await tx.chatTurn.findMany({
      where: { sessionId },
      select: { id: true, attempt: true, origin: true, statsCountedAt: true, characterContentVersionId: true, userMessageId: true, assistantMessageId: true },
    });
    const deletedAt = new Date();
    // One batch: a long session must still delete inside the transaction timeout.
    await appendCanonicalMetricEventsForUser(tx, userId, turnIds.flatMap((turn) => {
      const event = chatExchangeCorrectedEvent(turn, {
        userId,
        correctionType: "superseded",
        correctionRevision: turn.attempt,
        sessionId,
        messageIds: [turn.userMessageId, turn.assistantMessageId],
      }, deletedAt);
      return event ? [event] : [];
    }));
    await redactChatImageSourceText(tx, {
      userId,
      reason: "session_deleted",
      redactedAt: new Date(),
      sessionId,
    });
    if (turnIds.length > 0) {
      await refundPendingDelayedAttachments(tx, userId, turnIds.map((turn) => turn.id));
    }
    await tx.recentChat.delete({ where: { sessionId } });
    await scheduleCompanionMemoryRebuild(tx, {
      userId,
      characterId: session.characterId,
      purgeTurnIds: turnIds.map((turn) => turn.id),
    });
}

export async function archiveChatSession(userId: string, sessionId: string) {
  return prisma.$transaction(async (tx) => {
    const { session } = await lockChatScope(tx, { userId, at: { session: sessionId } });
    if (session.groupId) throw Errors.conflict("Archive this conversation from its group chat");
    const call = await tx.voiceCall.findFirst({
      where: { userId, sessionId: session.sessionId, status: { not: "ended" } },
      select: { id: true },
    });
    if (call) throw Errors.conflict("End your voice call before archiving this chat");
    // INVARIANT: admission only runs Turns of active sessions, so a reply left
    // pending here would never be admitted, never end, and the spinner would
    // outlive the conversation. Same rule as archiving or deleting a group.
    const active = await tx.chatTurn.findFirst({
      where: { sessionId: session.sessionId, assistantStatus: { in: ACTIVE_ASSISTANT_STATES } },
      select: { id: true },
    });
    if (active) throw Errors.conflict("Cancel the active reply before archiving this chat");
    const archived = await tx.recentChat.update({
      where: { sessionId: session.sessionId },
      data: { status: "archived", activeKey: null },
      include: { character: { select: { name: true } } },
    });
    return publicSession(archived, archived.character.name);
  });
}

export async function renameChatSession(userId: string, sessionId: string, title: string) {
  const session = await requireSession(userId, sessionId);
  if (session.groupId) throw Errors.conflict("Rename this conversation from its group chat");
  const renamed = await prisma.recentChat.update({
    where: { sessionId: session.sessionId },
    data: { title: requiredText(title, "title", 120) },
    include: { character: { select: { name: true } } },
  });
  return publicSession(renamed, renamed.character.name);
}

export async function setChatMemory(userId: string, sessionId: string, memoryEnabled: boolean) {
  const session = await requireSession(userId, sessionId);
  const updated = await prisma.recentChat.update({
    where: { sessionId: session.sessionId },
    data: { memoryEnabled, contextRevision: { increment: 1 } },
    include: { character: { select: { name: true } } },
  });
  return publicSession(updated, updated.character.name);
}
