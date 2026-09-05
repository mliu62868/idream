import { createHash, randomUUID } from "node:crypto";
import { FREE_DAILY_MESSAGES } from "@idream/shared/chat/limits";
import type {
  ChatExecutionSnapshot,
  ChatTerminalCommit,
  ChatContextDirective,
  ChatExperiencePreference,
  UserChatPersona,
} from "@idream/shared/contracts";
import { chatContextDirectivesSchema, chatExecutionSnapshotSchema, chatExperiencePreferenceSchema, DEFAULT_CHAT_EXPERIENCE, MAIN_TO_CHAT_EVENTS } from "@idream/shared/contracts";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { isSyntheticMediaAsset } from "@/server/lib/media-asset-authority";
import { moderateText } from "@/server/moderation/text-authority";
import { updateGenerationRequestSourceMeta } from "@/server/ai/generation-request-transition";
import { recordMainToChatEvent } from "@/processes/chat-outbox";
import { isReusablePlatformAssetWhere } from "@/server/modules/ourdream/chat-image-reuse";
import { generationExecutionErrorCode, latestGenerationAttemptStatuses } from "@/server/modules/ourdream/generation-job-read-model";
import {
  assertNoPendingCompanionMemoryRebuild,
  hasPendingCompanionMemoryMutation,
  scheduleCompanionMemoryProjection,
  scheduleCompanionMemoryRebuild,
} from "./companion-memory-authority";
import { userChatPersonaForTurn } from "./user-persona";

const BLOCKED_NOTICE = "I can’t help with that request.";
const ACTIVE_ASSISTANT_STATES = ["pending", "generating"];

export interface BegunChatTurn {
  duplicate: boolean;
  blocked: boolean;
  snapshot: ChatExecutionSnapshot | null;
  userMessage: ReturnType<typeof publicUserMessage>;
  assistant: ReturnType<typeof publicAssistantMessage>;
  streamUrl: string | null;
  safety?: { layer: "input"; policyCode?: string };
}

export async function listChatSessions(userId: string) {
  const rows = await prisma.recentChat.findMany({
    where: { userId },
    orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
  });
  return rows.map(publicSession);
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
  const character = await prisma.character.findFirst({
    where: {
      id: characterId,
      age: { gte: 18 },
      deletedAt: null,
      OR: [
        { creatorId: userId },
        { visibility: { in: ["public", "unlisted"] }, status: "approved" },
      ],
    },
    include: {
      currentContentVersion: true,
      serving: { include: { currentRelease: true } },
      visualProfiles: { where: { status: "active" }, orderBy: { version: "desc" }, take: 1 },
    },
  });
  if (!character) throw Errors.notFound("Character not found");

  const owner = character.creatorId === userId;
  const servingRelease = character.serving?.state === "live" &&
      character.serving.currentRelease?.status === "published"
    ? character.serving.currentRelease
    : null;
  if (!owner && !servingRelease) {
    throw Errors.gone("Character is not backed by an active Serving Release");
  }
  const release = servingRelease;
  const content = release
    ? await prisma.characterContentVersion.findUnique({
        where: { id: release.characterContentVersionId },
      })
    : character.currentContentVersion;
  if (!content) {
    throw Errors.gone("Character has no immutable Chat content version");
  }
  const activeKey = `${userId}:${characterId}`;
  const existing = await prisma.recentChat.findUnique({ where: { activeKey } });
  if (existing) {
    if (owner || existing.characterReleaseId === release?.id) {
      return publicSession(existing);
    }
    // INVARIANT: a session keeps its immutable Release pin. When Serving moves,
    // preserve that history and open a new active session instead of mutating it.
    await prisma.recentChat.updateMany({
      where: { sessionId: existing.sessionId, activeKey },
      data: { status: "archived", activeKey: null },
    });
  }

  const openingMessage = firstMessage(content?.openingSnapshot) ?? null;
  const visual = release
    ? { id: release.visualProfileId, version: release.visualProfileVersion }
    : character.visualProfiles[0]
      ? { id: character.visualProfiles[0].id, version: character.visualProfiles[0].version }
      : null;
  try {
    const created = await prisma.recentChat.create({
      data: {
        sessionId: randomUUID(),
        userId,
        characterId,
        title: optionalText(input.title, 120) ?? character.name,
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
    return publicSession(created);
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
      throw error;
    }
    return publicSession(
      await prisma.recentChat.findUniqueOrThrow({ where: { activeKey } }),
    );
  }
}

export async function getChatSession(userId: string, sessionId: string) {
  const session = await prisma.recentChat.findFirst({
    where: { sessionId, userId },
    include: {
      character: { select: { name: true, creatorId: true } },
      turns: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        include: { attachments: { orderBy: { createdAt: "asc" } } },
      },
    },
  });
  if (!session) throw Errors.notFound("Chat session not found");
  const messages = await enrichAttachmentMedia(publicMessages(session), userId);
  return {
    ...publicSession(session),
    character: {
      name: session.character.name,
      canUpdateIdentity: session.character.creatorId === userId,
    },
    messages,
  };
}

export async function beginChatTurn(input: {
  userId: string;
  sessionId: string;
  content: string;
  idempotencyKey: string;
}): Promise<BegunChatTurn> {
  const content = requiredText(input.content, "content", 20_000);
  const idempotencyKey = requiredText(input.idempotencyKey, "Idempotency-Key", 160);
  const requestHash = sha256(JSON.stringify({ sessionId: input.sessionId, content }));
  const session = await requireActiveSession(input.userId, input.sessionId);
  const turnId = randomUUID();
  const moderation = await moderateText("chat_turn", turnId, content, "input");
  const blocked = moderation.status === "blocked";

  const created = await prisma.$transaction(async (tx) => {
    // INVARIANT: the user lock serializes the daily quota across all of their
    // sessions; the session lock serializes product ordering inside one chat.
    if (!blocked) {
      await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${input.userId} FOR UPDATE`;
    }
    await tx.$queryRaw`SELECT "sessionId" FROM "recent_chats" WHERE "sessionId" = ${session.sessionId} FOR UPDATE`;
    const lockedSession = await tx.recentChat.findFirst({
      where: { sessionId: session.sessionId, userId: input.userId },
    });
    if (!lockedSession) throw Errors.notFound("Chat session not found");
    if (lockedSession.status !== "active") throw Errors.gone("Chat session is archived");
    await assertChatSessionServingAuthority(tx, input.userId, lockedSession);
    const duplicate = await tx.chatTurn.findUnique({
      where: { sessionId_idempotencyKey: { sessionId: session.sessionId, idempotencyKey } },
    });
    const memoryIsolated = await hasPendingCompanionMemoryMutation(
      tx,
      input.userId,
      lockedSession.characterId,
    );
    if (duplicate) {
      if (duplicate.requestHash !== requestHash) {
        throw Errors.conflict("Idempotency-Key was already used for another message");
      }
      return {
        turn: duplicate,
        snapshot: await frozenExecutionSnapshot(
          tx,
          duplicate.id,
          duplicate.memoryEnabled && !memoryIsolated,
          duplicate.executionSnapshot ? undefined : [],
          duplicate.executionSnapshot ? undefined : null,
          duplicate.executionSnapshot ? undefined : null,
        ),
      };
    }
    if (!blocked) {
      const active = await tx.chatTurn.findFirst({
        where: {
          sessionId: session.sessionId,
          assistantStatus: { in: ACTIVE_ASSISTANT_STATES },
        },
        select: { id: true },
      });
      if (active) throw Errors.conflict("A reply is already generating");
      await assertChatQuota(tx, input.userId);
    }
    const previous = await tx.chatTurn.findFirst({
      where: { sessionId: session.sessionId, assistantStatus: "sent" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { sceneVersion: true, scene: true },
    });
    const now = new Date();
    const turn = await tx.chatTurn.create({
      data: {
        id: turnId,
        sessionId: session.sessionId,
        idempotencyKey,
        requestHash,
        userMessageId: randomUUID(),
        assistantMessageId: randomUUID(),
        userContent: content,
        userStatus: blocked ? "blocked" : "sent",
        assistantContent: blocked ? BLOCKED_NOTICE : "",
        assistantStatus: blocked ? "blocked" : "pending",
        terminalAt: blocked ? now : null,
        terminalEvidence: blocked
          ? toJson({ authority: "main_input_moderation", policyCode: moderation.policyCode ?? null })
          : undefined,
        characterContentVersionId: lockedSession.characterContentVersionId,
        characterReleaseId: lockedSession.characterReleaseId,
        characterVisualProfileId: lockedSession.characterVisualProfileId,
        characterVisualProfileVersion: lockedSession.characterVisualProfileVersion,
        memoryEnabled: lockedSession.memoryEnabled,
        sceneVersion: previous?.sceneVersion ?? 0,
        scene: previous?.scene ?? undefined,
      },
    });
    await tx.recentChat.update({
      where: { sessionId: session.sessionId },
      data: { lastMessageAt: now },
    });
    if (!blocked) {
      await tx.chatTurnUsageFact.create({
        data: { turnId: turn.id, userId: input.userId, productDay: productDay(now) },
      });
    }
    return {
      turn,
      snapshot: blocked
        ? null
        : await frozenExecutionSnapshot(tx, turn.id, turn.memoryEnabled && !memoryIsolated),
    };
  });
  return begunResult(
    created.turn,
    created.turn.id !== turnId,
    created.snapshot,
    blocked ? moderation.policyCode : undefined,
  );
}

export async function regenerateChatTurn(userId: string, messageId: string) {
  const turn = await requireTurn(userId, messageId);
  const updated = await prisma.$transaction(async (tx) => {
    const current = await lockLatestTurn(tx, userId, turn);
    if (current.userStatus !== "sent") {
      throw Errors.conflict("A blocked user message cannot be regenerated");
    }
    if (ACTIVE_ASSISTANT_STATES.includes(current.assistantStatus)) {
      throw Errors.conflict("A reply is already generating");
    }
    const previousAttempt = current.attempt;
    const originalSnapshot = current.executionSnapshot ? chatExecutionSnapshotSchema.parse(current.executionSnapshot) : null;
    const contextDirectives = originalSnapshot?.contextDirectives ?? [];
    const experience = originalSnapshot?.experience ?? null;
    const userPersona = originalSnapshot?.userPersona ?? null;
    const sceneAnchor = await previousCommittedScene(tx, current);
    const regenerated = await tx.chatTurn.update({
      where: { id: turn.id },
      data: {
        attempt: { increment: 1 },
        assistantContent: "",
        assistantStatus: "pending",
        model: null,
        promptTokens: null,
        completionTokens: null,
        terminalEvidence: Prisma.JsonNull,
        terminalAt: null,
        executionSnapshot: Prisma.JsonNull,
        sceneVersion: sceneAnchor?.sceneVersion ?? 0,
        scene: sceneAnchor?.scene == null ? Prisma.JsonNull : toJson(sceneAnchor.scene),
        admissionAttempts: 0,
        admissionNextRunAt: new Date(),
        admissionLeaseToken: null,
        admissionLeaseUntil: null,
        admissionLastError: Prisma.JsonNull,
        admittedAt: null,
      },
    });
    await scheduleCompanionMemoryRebuild(tx, {
      userId,
      characterId: turn.session.characterId,
      purgeRunAttempts: [{ turnId: turn.id, throughAttempt: previousAttempt }],
    });
    return { turn: regenerated, snapshot: await frozenExecutionSnapshot(tx, regenerated.id, false, contextDirectives, experience, userPersona) };
  });
  return {
    assistantMessageId: updated.turn.assistantMessageId,
    attempt: updated.turn.attempt,
    status: "pending" as const,
    streamUrl: streamUrl(updated.turn.assistantMessageId, updated.turn.attempt),
    snapshot: updated.snapshot,
  };
}

export async function editChatTurn(userId: string, messageId: string, nextContent: string) {
  const content = requiredText(nextContent, "content", 20_000);
  const turn = await requireTurn(userId, messageId);
  if (turn.userMessageId !== messageId) throw Errors.badRequest("Only user messages can be edited");
  if (ACTIVE_ASSISTANT_STATES.includes(turn.assistantStatus)) {
    throw Errors.conflict("A reply is already generating");
  }
  const moderation = await moderateText("chat_turn", turn.id, content, "input_edit");
  const blocked = moderation.status === "blocked";
  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const current = await lockLatestTurn(tx, userId, turn);
    if (current.userMessageId !== messageId) {
      throw Errors.badRequest("Only user messages can be edited");
    }
    if (ACTIVE_ASSISTANT_STATES.includes(current.assistantStatus)) {
      throw Errors.conflict("A reply is already generating");
    }
    const sceneAnchor = await previousCommittedScene(tx, current);
    await redactChatImageSourceText(tx, {
      userId,
      reason: "logical_turn_edited",
      redactedAt: now,
      exchangeIds: [turn.id],
      messageIds: [turn.userMessageId, turn.assistantMessageId],
    });
    const previousAttempt = current.attempt;
    const originalSnapshot = current.executionSnapshot ? chatExecutionSnapshotSchema.parse(current.executionSnapshot) : null;
    const contextDirectives = originalSnapshot?.contextDirectives ?? [];
    const experience = originalSnapshot?.experience ?? null;
    const userPersona = originalSnapshot?.userPersona ?? null;
    const edited = await tx.chatTurn.update({
      where: { id: turn.id },
      data: {
        attempt: { increment: 1 },
        userContent: content,
        userStatus: blocked ? "blocked" : "sent",
        assistantContent: blocked ? BLOCKED_NOTICE : "",
        assistantStatus: blocked ? "blocked" : "pending",
        model: null,
        promptTokens: null,
        completionTokens: null,
        terminalEvidence: blocked
          ? toJson({ authority: "main_input_moderation", policyCode: moderation.policyCode ?? null })
          : Prisma.JsonNull,
        terminalAt: blocked ? now : null,
        executionSnapshot: Prisma.JsonNull,
        sceneVersion: sceneAnchor?.sceneVersion ?? 0,
        scene: sceneAnchor?.scene == null ? Prisma.JsonNull : toJson(sceneAnchor.scene),
        admissionAttempts: 0,
        admissionNextRunAt: now,
        admissionLeaseToken: null,
        admissionLeaseUntil: null,
        admissionLastError: Prisma.JsonNull,
        admittedAt: null,
      },
    });
    await scheduleCompanionMemoryRebuild(tx, {
      userId,
      characterId: turn.session.characterId,
      purgeRunAttempts: [{ turnId: turn.id, throughAttempt: previousAttempt }],
    });
    return {
      turn: edited,
      snapshot: blocked ? null : await frozenExecutionSnapshot(tx, edited.id, false, contextDirectives, experience, userPersona),
    };
  });
  return {
    assistantMessageId: updated.turn.assistantMessageId,
    attempt: updated.turn.attempt,
    status: blocked ? "blocked" as const : "pending" as const,
    streamUrl: blocked ? null : streamUrl(updated.turn.assistantMessageId, updated.turn.attempt),
    snapshot: updated.snapshot,
    ...(blocked ? { safety: { layer: "input" as const, policyCode: moderation.policyCode } } : {}),
  };
}

export async function commitChatTerminal(input: ChatTerminalCommit) {
  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const owner = await tx.recentChat.findUnique({
      where: { sessionId: input.sessionId },
      select: { userId: true },
    });
    if (!owner) throw Errors.notFound("Chat session not found");
    // Use the same user -> session -> Turn order as cancel/edit/delete. Taking
    // the Turn first deadlocks with a user-first mutation during memory commit.
    await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${owner.userId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "sessionId" FROM "recent_chats" WHERE "sessionId" = ${input.sessionId} FOR UPDATE`;
    const changed = await tx.chatTurn.updateMany({
      where: {
        id: input.turnId,
        sessionId: input.sessionId,
        assistantMessageId: input.assistantMessageId,
        attempt: input.attempt,
        assistantStatus: { in: ACTIVE_ASSISTANT_STATES },
      },
      data: {
        assistantContent: input.content,
        assistantStatus: input.status,
        model: input.model,
        promptTokens: input.promptTokens,
        completionTokens: input.completionTokens,
        sceneVersion: input.sceneVersion,
        scene: input.scene === null ? Prisma.JsonNull : toJson(input.scene),
        terminalEvidence: toJson(input.terminalEvidence),
        terminalAt: now,
      },
    });
    const current = await tx.chatTurn.findUnique({ where: { id: input.turnId } });
    if (!current) throw Errors.notFound("Chat turn not found");
    if (changed.count === 1) {
      const session = await tx.recentChat.update({
        where: { sessionId: input.sessionId },
        data: { contextRevision: { increment: 1 }, lastMessageAt: now },
        select: { userId: true, characterId: true },
      });
      if (input.status === "sent") {
        const firstSelectedReply = await tx.chatTurn.updateMany({
          where: { id: input.turnId, statsCountedAt: null },
          data: { statsCountedAt: now },
        });
        if (firstSelectedReply.count === 1) {
          await tx.characterStats.updateMany({
            where: { characterId: session.characterId },
            data: { chatsCount: { increment: 1 }, lastActivityAt: now },
          });
        }
        if (current.memoryEnabled) {
          await scheduleCompanionMemoryProjection(tx, session);
        }
      }
      return { turn: current, duplicate: false };
    }
    const sameTerminal = current.attempt === input.attempt
      && current.sessionId === input.sessionId
      && current.assistantMessageId === input.assistantMessageId
      && current.assistantStatus === input.status
      && current.assistantContent === input.content
      && current.model === input.model
      && current.promptTokens === input.promptTokens
      && current.completionTokens === input.completionTokens
      && current.sceneVersion === input.sceneVersion
      && jsonEqual(current.scene, input.scene)
      && jsonEqual(current.terminalEvidence, input.terminalEvidence);
    if (!sameTerminal) throw Errors.conflict("Terminal commit lost the active attempt CAS");
    if (input.status === "sent" && current.memoryEnabled) {
      const session = await tx.recentChat.findUniqueOrThrow({
        where: { sessionId: input.sessionId },
        select: { userId: true, characterId: true },
      });
      // A duplicate ACK may follow a Chat crash after Main committed. The
      // idempotent projection closes that window without rerunning the model.
      await scheduleCompanionMemoryProjection(tx, session);
    }
    return { turn: current, duplicate: true };
  });
  return {
    accepted: true as const,
    duplicate: updated.duplicate,
    terminalMessageId: updated.turn.assistantMessageId,
    committedAt: updated.turn.terminalAt?.toISOString() ?? now.toISOString(),
  };
}

export async function cancelChatTurn(userId: string, messageId: string) {
  const turn = await requireTurn(userId, messageId);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "sessionId" FROM "recent_chats" WHERE "sessionId" = ${turn.sessionId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "chat_turns" WHERE id = ${turn.id} FOR UPDATE`;
    const current = await tx.chatTurn.findFirst({
      where: { id: turn.id, session: { userId } },
    });
    if (!current) throw Errors.notFound("Chat message not found");
    if (!ACTIVE_ASSISTANT_STATES.includes(current.assistantStatus)) {
      return {
        ok: true,
        turnId: current.id,
        attempt: current.attempt,
        cancelled: false,
      };
    }
    const now = new Date();
    await tx.chatTurn.update({
      where: { id: current.id },
      data: {
        assistantStatus: "cancelled",
        terminalAt: now,
        terminalEvidence: toJson({ authority: "main_user_cancel" }),
      },
    });
    await recordMainToChatEvent({
      eventId: `chat_agent_run_cancel_${sha256(`${current.id}:${current.attempt}`).slice(0, 40)}`,
      eventType: MAIN_TO_CHAT_EVENTS.agentRunCancelRequestedV1,
      aggregateType: "chat_turn",
      aggregateId: current.id,
      payload: { version: 1, userId, turnId: current.id, attempt: current.attempt },
      occurredAt: now,
    }, tx);
    return { ok: true, turnId: current.id, attempt: current.attempt, cancelled: true };
  });
}

export async function deleteChatMessage(userId: string, messageId: string) {
  const turn = await requireTurn(userId, messageId);
  await prisma.$transaction(async (tx) => {
    const current = await lockLatestTurn(tx, userId, turn);
    if (ACTIVE_ASSISTANT_STATES.includes(current.assistantStatus)) {
      throw Errors.conflict("Cancel the active reply before deleting this chat turn");
    }
    await redactChatImageSourceText(tx, {
      userId,
      reason: "logical_turn_deleted",
      redactedAt: new Date(),
      exchangeIds: [turn.id],
      messageIds: [turn.userMessageId, turn.assistantMessageId],
    });
    await tx.chatTurn.delete({ where: { id: turn.id } });
    await scheduleCompanionMemoryRebuild(tx, {
      userId,
      characterId: turn.session.characterId,
      purgeTurnIds: [turn.id],
    });
  });
}

export async function deleteChatSession(userId: string, sessionId: string) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "sessionId" FROM "recent_chats" WHERE "sessionId" = ${sessionId} FOR UPDATE`;
    const session = await tx.recentChat.findFirst({ where: { sessionId, userId } });
    if (!session) throw Errors.notFound("Chat session not found");
    await assertNoPendingCompanionMemoryRebuild(tx, userId, session.characterId);
    const active = await tx.chatTurn.findFirst({
      where: { sessionId, assistantStatus: { in: ACTIVE_ASSISTANT_STATES } },
      select: { id: true },
    });
    if (active) throw Errors.conflict("Cancel the active reply before deleting this chat");
    const turnIds = await tx.chatTurn.findMany({
      where: { sessionId },
      select: { id: true },
    });
    await redactChatImageSourceText(tx, {
      userId,
      reason: "session_deleted",
      redactedAt: new Date(),
      sessionId,
    });
    await tx.recentChat.delete({ where: { sessionId } });
    await scheduleCompanionMemoryRebuild(tx, {
      userId,
      characterId: session.characterId,
      purgeTurnIds: turnIds.map((turn) => turn.id),
    });
  });
}

export async function archiveChatSession(userId: string, sessionId: string) {
  const session = await requireSession(userId, sessionId);
  return publicSession(await prisma.recentChat.update({
    where: { sessionId: session.sessionId },
    data: { status: "archived", activeKey: null },
  }));
}

export async function renameChatSession(userId: string, sessionId: string, title: string) {
  const session = await requireSession(userId, sessionId);
  return publicSession(await prisma.recentChat.update({
    where: { sessionId: session.sessionId },
    data: { title: requiredText(title, "title", 120) },
  }));
}

export async function setChatMemory(userId: string, sessionId: string, memoryEnabled: boolean) {
  const session = await requireSession(userId, sessionId);
  return publicSession(await prisma.recentChat.update({
    where: { sessionId: session.sessionId },
    data: { memoryEnabled, contextRevision: { increment: 1 } },
  }));
}

export async function chatVoiceAuthority(userId: string, sessionId: string, messageId: string) {
  if (messageId === `opening:${sessionId}`) {
    const session = await prisma.recentChat.findFirst({ where: { sessionId, userId } });
    if (!session?.openingMessage?.trim()) throw Errors.notFound("Message not found");
    // INVARIANT: the greeting belongs to the immutable Session snapshot, not
    // the Character's current draft and not a caller-provided voice text.
    return {
      schemaVersion: 1 as const,
      sessionId,
      messageId,
      characterId: session.characterId,
      text: session.openingMessage,
      attempt: 1,
      sceneVersion: 0,
      scene: null,
      characterContentVersionId: session.characterContentVersionId,
      characterReleaseId: session.characterReleaseId,
    };
  }
  const turn = await prisma.chatTurn.findFirst({
    where: { sessionId, assistantMessageId: messageId, session: { userId } },
    include: { session: true },
  });
  if (!turn || turn.assistantStatus !== "sent") throw Errors.notFound("Message not found");
  return {
    schemaVersion: 1 as const,
    sessionId,
    messageId,
    characterId: turn.session.characterId,
    text: turn.assistantContent,
    attempt: turn.attempt,
    sceneVersion: turn.sceneVersion,
    scene: turn.scene,
    characterContentVersionId: turn.characterContentVersionId,
    characterReleaseId: turn.characterReleaseId,
  };
}

export async function chatTurnForEffect(turnId: string) {
  const turn = await prisma.chatTurn.findUnique({
    where: { id: turnId },
    include: { session: true },
  });
  if (!turn) throw Errors.notFound("Chat turn not found");
  return turn;
}

export async function executionSnapshot(turnId: string): Promise<ChatExecutionSnapshot> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "chat_turns" WHERE id = ${turnId} FOR UPDATE`;
    // Newly accepted Turns already carry their explicit context. A legacy
    // missing snapshot must not acquire today's settings during recovery.
    return frozenExecutionSnapshot(tx, turnId, true, [], null, null);
  });
}

async function frozenExecutionSnapshot(
  tx: Prisma.TransactionClient,
  turnId: string,
  memoryEnabled = true,
  preservedDirectives?: ChatContextDirective[],
  preservedExperience?: ChatExperiencePreference | null,
  preservedUserPersona?: UserChatPersona | null,
): Promise<ChatExecutionSnapshot> {
  const turn = await tx.chatTurn.findUnique({ where: { id: turnId }, include: { session: true } });
  if (!turn) throw Errors.notFound("Chat turn not found");
  const persisted = turn.executionSnapshot;
  if (persisted) {
    const parsed = chatExecutionSnapshotSchema.safeParse(persisted);
    if (parsed.success) return parsed.data;
    throw new Error("Chat Turn has an invalid frozen execution snapshot");
  }
  const recent = await tx.chatTurn.findMany({
    where: {
      sessionId: turn.sessionId,
      assistantStatus: "sent",
      createdAt: { lt: turn.createdAt },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 24,
    include: {
      attachments: {
        select: { status: true, mediaAssetId: true, metadata: true },
      },
    },
  });
  recent.reverse();
  // Explicit settings are copied once, not ingested as synthetic chat messages.
  // Revisions of the same Turn retain its original user context, including an
  // empty historical snapshot; temporary igrep rebuild isolation does not erase it.
  const contextDirectives = chatContextDirectivesSchema.parse(
    (preservedDirectives ?? await tx.chatContextDirective.findMany({
      where: {
        userId: turn.session.userId,
        characterId: turn.session.characterId,
        status: "active",
        ...(turn.memoryEnabled ? {} : { kind: "custom_instruction" }),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, kind: true, content: true, version: true },
    })).filter((item) => turn.memoryEnabled || item.kind === "custom_instruction"),
  );
  const experienceRow = preservedExperience !== undefined ? preservedExperience : await tx.chatExperiencePreference.findUnique({
    where: { sessionId: turn.sessionId },
    select: { responseLength: true, interactionIntensity: true, sceneGeneration: true, version: true },
  });
  const experience = experienceRow
    ? chatExperiencePreferenceSchema.parse(experienceRow)
    : preservedExperience === undefined ? DEFAULT_CHAT_EXPERIENCE : null;
  const snapshot: ChatExecutionSnapshot = {
    version: 1,
    turnId: turn.id,
    sessionId: turn.sessionId,
    userMessageId: turn.userMessageId,
    assistantMessageId: turn.assistantMessageId,
    attempt: turn.attempt,
    userId: turn.session.userId,
    characterId: turn.session.characterId,
    characterContentVersionId:
      turn.characterContentVersionId ?? fail("Chat Turn has no immutable Character content pin"),
    characterReleaseId: turn.characterReleaseId,
    characterVisualProfileId: turn.characterVisualProfileId,
    characterVisualProfileVersion: turn.characterVisualProfileVersion,
    memoryEnabled: turn.memoryEnabled && memoryEnabled,
    contextDirectives,
    ...(experience ? { experience } : {}),
    userPersona: preservedUserPersona === undefined
      ? await userChatPersonaForTurn(tx, turn.session.userId)
      : preservedUserPersona,
    contextRevision: turn.session.contextRevision,
    userContent: turn.userContent,
    hasRecentImageContext: recent.some((item) =>
      item.attachments.some((attachment) =>
        attachment.status === "completed" &&
        attachment.mediaAssetId !== null &&
        attachmentAttempt(attachment.metadata) === item.attempt
      )
    ),
    recentTurns: recent.map((item) => ({
      turnId: item.id,
      userMessageId: item.userMessageId,
      assistantMessageId: item.assistantMessageId,
      userContent: item.userContent,
      assistantContent: item.assistantContent,
      createdAt: item.createdAt.toISOString(),
    })),
    sceneVersion: turn.sceneVersion,
    scene: turn.scene,
  };
  await tx.chatTurn.update({
    where: { id: turn.id },
    data: { executionSnapshot: toJson(snapshot) },
  });
  return snapshot;
}

async function previousCommittedScene(
  tx: Prisma.TransactionClient,
  turn: { id: string; sessionId: string },
) {
  return tx.chatTurn.findFirst({
    where: {
      sessionId: turn.sessionId,
      id: { not: turn.id },
      assistantStatus: "sent",
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { sceneVersion: true, scene: true },
  });
}

async function requireSession(userId: string, sessionId: string) {
  const session = await prisma.recentChat.findFirst({ where: { sessionId, userId } });
  if (!session) throw Errors.notFound("Chat session not found");
  return session;
}

async function requireActiveSession(userId: string, sessionId: string) {
  const session = await requireSession(userId, sessionId);
  if (session.status !== "active") throw Errors.gone("Chat session is archived");
  return session;
}

async function assertChatSessionServingAuthority(
  tx: Prisma.TransactionClient,
  userId: string,
  session: { characterId: string; characterReleaseId: string | null },
): Promise<void> {
  const character = await tx.character.findUnique({
    where: { id: session.characterId },
    select: {
      creatorId: true,
      visibility: true,
      status: true,
      deletedAt: true,
      serving: {
        select: {
          state: true,
          currentRelease: { select: { id: true, status: true } },
        },
      },
    },
  });
  if (!character || character.deletedAt) throw Errors.gone("Character is unavailable");
  if (character.creatorId === userId) return;
  const publicReleaseIsLive =
    ["public", "unlisted"].includes(character.visibility) &&
    character.status === "approved" &&
    character.serving?.state === "live" &&
    character.serving.currentRelease?.id === session.characterReleaseId &&
    character.serving.currentRelease.status === "published";
  if (!publicReleaseIsLive) {
    throw Errors.gone("Character has no active Serving Release");
  }
}

async function requireTurn(userId: string, messageId: string) {
  const turn = await prisma.chatTurn.findFirst({
    where: {
      OR: [{ id: messageId }, { userMessageId: messageId }, { assistantMessageId: messageId }],
      session: { userId },
    },
    include: { session: { select: { characterId: true } } },
  });
  if (!turn) throw Errors.notFound("Chat message not found");
  return turn;
}

async function assertChatQuota(tx: Prisma.TransactionClient, userId: string) {
  const entitlement = await tx.entitlement.findUnique({
    where: { userId_key: { userId, key: "unlimited_messages" } },
  });
  if (entitlement && entitlement.expiresAt && entitlement.expiresAt <= new Date()) {
    // expired rows do not grant access
  } else if (entitlement?.value === true) {
    return;
  }
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const used = await tx.chatTurnUsageFact.count({
    where: { userId, productDay: start },
  });
  if (used >= FREE_DAILY_MESSAGES) throw Errors.paymentRequired("Daily free message limit reached");
}

function productDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

async function lockLatestTurn(
  tx: Prisma.TransactionClient,
  userId: string,
  turn: { id: string; sessionId: string },
) {
  await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "sessionId" FROM "recent_chats" WHERE "sessionId" = ${turn.sessionId} FOR UPDATE`;
  const session = await tx.recentChat.findFirst({
    where: { sessionId: turn.sessionId, userId },
    select: { sessionId: true, characterId: true },
  });
  if (!session) throw Errors.notFound("Chat session not found");
  await assertNoPendingCompanionMemoryRebuild(tx, userId, session.characterId);
  await tx.$queryRaw`SELECT id FROM "chat_turns" WHERE id = ${turn.id} FOR UPDATE`;
  const current = await tx.chatTurn.findUnique({ where: { id: turn.id } });
  if (!current) throw Errors.notFound("Chat message not found");
  const latest = await tx.chatTurn.findFirst({
    where: { sessionId: turn.sessionId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  if (latest?.id !== current.id) {
    throw Errors.conflict("Only the latest chat turn can be changed");
  }
  return current;
}

type ChatImagePrivacyRedactionReason =
  | "logical_turn_edited"
  | "logical_turn_deleted"
  | "session_deleted";

async function redactChatImageSourceText(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    reason: ChatImagePrivacyRedactionReason;
    redactedAt: Date;
    sessionId?: string;
    exchangeIds?: readonly string[];
    messageIds?: readonly string[];
  },
) {
  const selectors: Prisma.GenerationJobWhereInput[] = [
    ...(input.sessionId
      ? [{ sourceMeta: { path: ["sessionId"], equals: input.sessionId } }]
      : []),
    ...[...new Set(input.exchangeIds ?? [])].map((exchangeId) => ({
      sourceMeta: { path: ["exchangeId"], equals: exchangeId },
    })),
    ...[...new Set(input.messageIds ?? [])].map((messageId) => ({
      sourceMeta: { path: ["messageId"], equals: messageId },
    })),
  ];
  if (selectors.length === 0) return;
  const jobs = await tx.generationJob.findMany({
    where: { userId: input.userId, sourceType: "chat_image", OR: selectors },
    select: { id: true, sourceMeta: true },
  });
  for (const job of jobs) {
    await updateGenerationRequestSourceMeta(tx, {
      requestId: job.id,
      sourceMeta: toJson({
        ...jsonRecord(job.sourceMeta),
        promptHint: null,
        conversationContext: null,
        privacyRedaction: {
          authority: "main_turn_ledger",
          reason: input.reason,
          redactedAt: input.redactedAt.toISOString(),
        },
      }),
    });
  }
}

function begunResult(
  turn: {
    id: string;
    userMessageId: string;
    assistantMessageId: string;
    attempt: number;
    userContent: string;
    userStatus: string;
    assistantContent: string;
    assistantStatus: string;
    createdAt: Date;
    sceneVersion: number;
    scene: Prisma.JsonValue | null;
  },
  duplicate: boolean,
  snapshot: ChatExecutionSnapshot | null,
  policyCode?: string,
): BegunChatTurn {
  const blocked = turn.assistantStatus === "blocked";
  const active = ACTIVE_ASSISTANT_STATES.includes(turn.assistantStatus);
  return {
    duplicate,
    blocked,
    snapshot: active ? snapshot : null,
    userMessage: publicUserMessage(turn),
    assistant: publicAssistantMessage(turn),
    streamUrl: active ? streamUrl(turn.assistantMessageId, turn.attempt) : null,
    ...(blocked ? { safety: { layer: "input", ...(policyCode ? { policyCode } : {}) } } : {}),
  };
}

function publicSession(session: {
  sessionId: string;
  characterId: string;
  title: string | null;
  status: string;
  memoryEnabled: boolean;
  lastMessageAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: session.sessionId,
    characterId: session.characterId,
    title: session.title,
    status: session.status,
    memoryEnabled: session.memoryEnabled,
    lastMessageAt: session.lastMessageAt?.toISOString() ?? null,
    createdAt: session.createdAt.toISOString(),
  };
}

function publicMessages(session: {
  sessionId: string;
  openingMessage: string | null;
  createdAt: Date;
  turns: Array<{
    id: string;
    userMessageId: string;
    assistantMessageId: string;
    userContent: string;
    userStatus: string;
    assistantContent: string;
    assistantStatus: string;
    attempt: number;
    sceneVersion: number;
    scene: Prisma.JsonValue | null;
    createdAt: Date;
    attachments: Array<{
      id: string;
      kind: string;
      status: string;
      generationJobId: string | null;
      mediaAssetId: string | null;
      promptHint: string | null;
      width: number | null;
      height: number | null;
      errorCode: string | null;
      metadata: Prisma.JsonValue;
    }>;
  }>;
}) {
  const messages: Array<Record<string, unknown>> = [];
  if (session.openingMessage) {
    messages.push({
      id: `opening:${session.sessionId}`,
      role: "assistant",
      content: session.openingMessage,
      status: "sent",
      opening: true,
      createdAt: session.createdAt.toISOString(),
      attachments: [],
    });
  }
  for (const turn of session.turns) {
    messages.push(publicUserMessage(turn), publicAssistantMessage(turn));
  }
  return messages;
}

function publicUserMessage(turn: {
  userMessageId: string;
  userContent: string;
  userStatus: string;
  createdAt: Date;
}) {
  return {
    id: turn.userMessageId,
    role: "user" as const,
    content: turn.userContent,
    status: turn.userStatus,
    createdAt: turn.createdAt.toISOString(),
    attachments: [],
  };
}

function publicAssistantMessage(turn: {
  assistantMessageId: string;
  userMessageId: string;
  assistantContent: string;
  assistantStatus: string;
  attempt: number;
  sceneVersion: number;
  scene: Prisma.JsonValue | null;
  createdAt: Date;
  attachments?: Array<{
    id: string;
    kind: string;
    status: string;
    generationJobId: string | null;
    mediaAssetId: string | null;
    promptHint: string | null;
    width: number | null;
    height: number | null;
    errorCode: string | null;
    metadata: Prisma.JsonValue;
  }>;
}) {
  return {
    id: turn.assistantMessageId,
    role: "assistant" as const,
    content: turn.assistantContent,
    status: turn.assistantStatus,
    attempt: turn.attempt,
    replyToMessageId: turn.userMessageId,
    sceneVersion: turn.sceneVersion,
    scene: turn.scene,
    createdAt: turn.createdAt.toISOString(),
    attachments: (turn.attachments ?? [])
      .filter((attachment) => attachmentAttempt(attachment.metadata) === turn.attempt)
      .map((attachment) => ({
        id: attachment.id,
        kind: attachment.kind,
        status: attachment.status,
        generationJobId: attachment.generationJobId,
        mediaAssetId: attachment.mediaAssetId,
        promptHint: attachment.promptHint,
        width: attachment.width,
        height: attachment.height,
        errorCode: attachment.errorCode,
      })),
  };
}

function attachmentAttempt(metadata: Prisma.JsonValue): number {
  const root = jsonRecord(metadata);
  const direct = root.attempt;
  const nested = isRecord(root.effect) ? root.effect.attempt : undefined;
  const value = typeof direct === "number" ? direct : nested;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function streamUrl(assistantMessageId: string, attempt: number) {
  return `/api/v1/messages/${encodeURIComponent(assistantMessageId)}/stream?attempt=${attempt}`;
}

async function enrichAttachmentMedia(messages: Array<Record<string, unknown>>, userId: string) {
  const ids = new Set<string>();
  const jobIds = new Set<string>();
  for (const message of messages) {
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    for (const attachment of attachments) {
      if (!isRecord(attachment)) continue;
      const mediaAssetId = typeof attachment.mediaAssetId === "string" ? attachment.mediaAssetId : null;
      if (mediaAssetId) ids.add(mediaAssetId);
      if (typeof attachment.generationJobId === "string" && ["requesting", "accepted", "queued", "running"].includes(String(attachment.status))) {
        jobIds.add(attachment.generationJobId);
      }
    }
  }
  if (ids.size === 0 && jobIds.size === 0) return messages;

  const jobs = jobIds.size ? await prisma.generationJob.findMany({
    where: { id: { in: [...jobIds] }, userId },
    select: { id: true, status: true, errorCode: true },
  }) : [];
  const attemptStatuses = await latestGenerationAttemptStatuses(jobs.map((job) => job.id));
  const executionErrors = new Map(jobs.map((job) => [
    job.id, generationExecutionErrorCode(job.status, attemptStatuses.get(job.id) ?? null, job.errorCode),
  ]));

  const assets = await prisma.mediaAsset.findMany({
    where: {
      id: { in: [...ids] },
      deletedAt: null,
      ...isReusablePlatformAssetWhere(userId),
    },
    select: {
      id: true,
      url: true,
      thumbnailUrl: true,
      width: true,
      height: true,
      metadata: true,
    },
  });
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  return messages.map((message) => {
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    return {
      ...message,
      attachments: attachments.map((attachment) => {
        if (!isRecord(attachment)) return attachment;
        const errorCode = typeof attachment.generationJobId === "string"
          ? executionErrors.get(attachment.generationJobId)
          : null;
        if (errorCode === "provider_outcome_unknown") return { ...attachment, errorCode };
        const mediaAssetId = typeof attachment.mediaAssetId === "string" ? attachment.mediaAssetId : null;
        const asset = mediaAssetId ? byId.get(mediaAssetId) : null;
        return asset
          ? {
              ...attachment,
              mediaUrl: asset.url,
              thumbnailUrl: asset.thumbnailUrl ?? asset.url,
              width: attachment.width ?? asset.width,
              height: attachment.height ?? asset.height,
              isSynthetic: isSyntheticMediaAsset(asset.metadata),
            }
          : attachment;
      }),
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonRecord(value: Prisma.JsonValue | null): Record<string, Prisma.JsonValue> {
  return isRecord(value) ? value as Record<string, Prisma.JsonValue> : {};
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]),
  );
}

function firstMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return optionalText((value as Record<string, unknown>).firstMessage, 20_000);
}

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw Errors.badRequest(`${field} is required`);
  const text = value.trim();
  if (text.length > max) throw Errors.badRequest(`${field} exceeds ${max} characters`);
  return text;
}

function optionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim().slice(0, max);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fail(message: string): never {
  throw new Error(message);
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
