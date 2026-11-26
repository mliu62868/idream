// User Turn commands: send, regenerate, edit, delete.
import { randomUUID } from "node:crypto";
import { CHAT_SEND_PROTOCOL_VERSION, chatExecutionSnapshotSchema } from "@idream/shared/contracts";
import { Prisma, type ChatTurn, type RecentChat } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { moderateText } from "@/server/moderation/text-authority";
import { assertNoPendingCompanionMemoryRebuild, hasPendingCompanionMemoryMutation, scheduleCompanionMemoryRebuild } from "./companion-memory-authority";
import { lockChatScope } from "./turn-scope";
import { transitionToolEffectAttachment } from "./tool-effect-attachment";
import { frozenChatImageEditSource } from "./chat-media-history";
import { ACTIVE_ASSISTANT_STATES, BLOCKED_NOTICE, jsonRecord, requiredText, sha256, streamUrl, toJson } from "./turn-ledger-support";
import { assertUserReplyCapacity, reserveChatTurnUsage, reserveRevisedChatTurn } from "./turn-usage";
import { appendChatExchangeCorrected } from "./exchange-metrics";
import { assertChatSessionServingAuthority, repinOwnerSessionToServingRelease, requireActiveSession } from "./chat-session-authority";
import { type BegunChatTurn, begunResult } from "./chat-read-model";
import { rebindDurableTurnMedia, redactChatImageSourceText, refundPendingDelayedAttachments } from "./turn-media-rebind";
import { frozenExecutionSnapshot } from "./execution-snapshot";

export async function beginChatTurn(input: {
  userId: string;
  sessionId: string;
  content: string;
  idempotencyKey: string;
  sendProtocolVersion?: string;
  allowPaidImage?: boolean;
  origin?: "user" | "proactive";
  voiceCall?: { id: string; leaseToken: string; utteranceId: string };
}): Promise<BegunChatTurn> {
  const content = requiredText(input.content, "content", 20_000);
  const idempotencyKey = requiredText(input.idempotencyKey, "Idempotency-Key", 160);
  const userSend = input.origin !== "proactive" && !input.voiceCall;
  const allowPaidImage = input.allowPaidImage === true && userSend;
  const requestHash = sha256(JSON.stringify({ sessionId: input.sessionId, content, ...(allowPaidImage ? { allowPaidImage } : {}),
    ...(input.sendProtocolVersion !== undefined ? { sendProtocolVersion: input.sendProtocolVersion } : {}) }));
  const session = await requireActiveSession(input.userId, input.sessionId);
  const turnId = randomUUID();
  const moderation = await moderateText("chat_turn", turnId, content, "input");
  const blocked = moderation.status === "blocked";

  const created = await prisma.$transaction(async (tx) => {
    // INVARIANT: the user lock serializes the daily quota across all of their
    // sessions; the session lock serializes product ordering inside one chat.
    if (!blocked || session.groupId || input.voiceCall) {
      await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${input.userId} FOR UPDATE`;
    }
    if (session.groupId) {
      await tx.$queryRaw`SELECT id FROM "group_conversations" WHERE id = ${session.groupId} FOR UPDATE`;
      const group = await tx.groupConversation.findFirst({ where: { id: session.groupId, userId: input.userId, status: "active" } });
      if (!group) throw Errors.gone("Group conversation is unavailable or archived");
    }
    await tx.$queryRaw`SELECT "sessionId" FROM "recent_chats" WHERE "sessionId" = ${session.sessionId} FOR UPDATE`;
    const lockedSession = await tx.recentChat.findFirst({
      where: { sessionId: session.sessionId, userId: input.userId },
    });
    if (!lockedSession) throw Errors.notFound("Chat session not found");
    if (lockedSession.status !== "active") throw Errors.gone("Chat session is archived");
    await assertChatSessionServingAuthority(tx, input.userId, lockedSession);
    if (input.voiceCall) {
      const now = new Date();
      const call = await tx.voiceCall.findFirst({ where: { id: input.voiceCall.id, userId: input.userId,
        sessionId: session.sessionId, status: "active", leaseToken: input.voiceCall.leaseToken,
        leaseExpiresAt: { gt: now }, deadlineAt: { gt: now } } });
      const utterance = await tx.voiceCallUtterance.findFirst({ where: { id: input.voiceCall.utteranceId,
        callId: input.voiceCall.id, status: { in: ["transcribing", "linked"] } } });
      if (!call || !utterance) throw Errors.gone("Call stopped before this spoken turn could be accepted");
    }
    const duplicate = lockedSession.groupId
      ? await tx.chatTurn.findFirst({ where: { groupTurn: { groupId: lockedSession.groupId }, idempotencyKey } })
      : await tx.chatTurn.findUnique({ where: { sessionId_idempotencyKey: { sessionId: session.sessionId, idempotencyKey } } });
    if (!duplicate && await tx.deletedChatTurnSend.findUnique({
      where: { userId_conversationKey_keyHash: deletedChatTurnSendKey(input.userId, lockedSession, idempotencyKey) },
      select: { keyHash: true },
    })) {
      throw Errors.conflict("This message was deleted. Send again to make a new request.", { reason: "chat_send_deleted" });
    }
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
        // An old, exact receipt is readable, but replaying its POST must not
        // restart execution or upgrade its original authorization protocol.
        snapshot: !userSend || input.sendProtocolVersion === CHAT_SEND_PROTOCOL_VERSION ? await frozenExecutionSnapshot(
          tx,
          duplicate.id,
          duplicate.memoryEnabled && !memoryIsolated,
          duplicate.executionSnapshot ? undefined : [],
          duplicate.executionSnapshot ? undefined : null,
          duplicate.executionSnapshot ? undefined : null,
          { preservedImageEditSourceAssetId: null },
        ) : null,
      };
    }
    if (userSend && input.sendProtocolVersion !== CHAT_SEND_PROTOCOL_VERSION) {
      // Deleted pre-cutover keys cannot be reconstructed. A first write from an
      // old body therefore needs an explicit new Send, even without a tombstone.
      throw Errors.conflict("This chat changed elsewhere. Copy your draft, reload this page, and send it again.", { reason: "chat_send_protocol_required" });
    }
    if (!blocked) {
      const active = await tx.chatTurn.findFirst({
        where: {
          ...(lockedSession.groupId ? { groupTurn: { groupId: lockedSession.groupId } } : { sessionId: session.sessionId }),
          assistantStatus: { in: ACTIVE_ASSISTANT_STATES },
        },
        select: { id: true },
      });
      if (active) throw Errors.conflict("A reply is already generating");
      // INVARIANT: counted under the user lock taken above, so concurrent sends
      // from different sessions cannot all slip past the limit. A scheduled
      // proactive Turn neither counts nor is refused here.
      if (input.origin !== "proactive") await assertUserReplyCapacity(tx, input.userId);
    }
    const previous = await tx.chatTurn.findFirst({
      where: { ...(lockedSession.groupId ? { groupTurn: { groupId: lockedSession.groupId } } : { sessionId: session.sessionId }), assistantStatus: "sent" },
      orderBy: lockedSession.groupId ? { groupTurn: { ordinal: "desc" } } : [{ createdAt: "desc" }, { id: "desc" }],
      select: { sceneVersion: true, scene: true },
    });
    // After the idempotent-replay return: a replay must not re-pin or bump contextRevision.
    const pinnedSession = await repinOwnerSessionToServingRelease(tx, input.userId, lockedSession);
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
        imageActionMode: allowPaidImage ? "paid" : "chat",
        userStatus: blocked ? "blocked" : "sent",
        assistantContent: blocked ? BLOCKED_NOTICE : "",
        assistantStatus: blocked ? "blocked" : "pending",
        terminalAt: blocked ? now : null,
        terminalEvidence: blocked
          ? toJson({ authority: "main_input_moderation", policyCode: moderation.policyCode ?? null })
          : undefined,
        characterContentVersionId: pinnedSession.characterContentVersionId,
        characterReleaseId: pinnedSession.characterReleaseId,
        characterVisualProfileId: pinnedSession.characterVisualProfileId,
        characterVisualProfileVersion: pinnedSession.characterVisualProfileVersion,
        memoryEnabled: lockedSession.memoryEnabled,
        sceneVersion: previous?.sceneVersion ?? 0,
        scene: previous?.scene ?? undefined,
        // INVARIANT: 溯源和它描述的行同事务提交。先写 user 再补一条 UPDATE 的话，
        //            进程在两者之间退出会把主动消息永久标成用户发起。
        origin: input.origin ?? "user",
      },
    });
    if (input.voiceCall) await tx.voiceCallUtterance.update({ where: { id: input.voiceCall.utteranceId }, data: {
      turnId: turn.id, assistantMessageId: turn.assistantMessageId, replyAttempt: turn.attempt, status: "linked",
    } });
    await tx.recentChat.update({
      where: { sessionId: session.sessionId },
      data: { lastMessageAt: now },
    });
    if (lockedSession.groupId) {
      const group = await tx.groupConversation.update({
        where: { id: lockedSession.groupId }, data: { nextOrdinal: { increment: 1 } }, select: { nextOrdinal: true },
      });
      await tx.groupChatTurn.create({ data: { groupId: lockedSession.groupId, ordinal: group.nextOrdinal - 1, turnId: turn.id } });
    }
    if (!blocked) {
      await reserveChatTurnUsage(tx, input.userId, turn);
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
    const current = await lockLatestTurn(tx, userId, turn, "revise");
    await assertNoPendingCompanionMemoryRebuild(tx, userId, turn.session.characterId);
    return regenerateLockedChatTurn(tx, userId, current, turn.session.characterId);
  });
  return {
    assistantMessageId: updated.turn.assistantMessageId,
    attempt: updated.turn.attempt,
    status: "pending" as const,
    streamUrl: streamUrl(updated.turn.assistantMessageId, updated.turn.attempt),
    snapshot: updated.snapshot,
  };
}

async function regenerateLockedChatTurn(tx: Prisma.TransactionClient, userId: string, turn: ChatTurn, characterId: string) {
  if (turn.userStatus !== "sent") {
    throw Errors.conflict("A blocked user message cannot be regenerated");
  }
  if (ACTIVE_ASSISTANT_STATES.includes(turn.assistantStatus)) {
    throw Errors.conflict("A reply is already generating");
  }
  await reserveRevisedChatTurn(tx, userId, turn);
  const previousAttempt = turn.attempt;
  const originalSnapshot = turn.executionSnapshot ? chatExecutionSnapshotSchema.parse(turn.executionSnapshot) : null;
  const contextDirectives = originalSnapshot?.contextDirectives ?? [];
  const experience = originalSnapshot?.experience ?? null;
  const userPersona = originalSnapshot?.userPersona ?? null;
  const sceneAnchor = await previousCommittedScene(tx, turn);
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
      attemptStartedAt: new Date(),
      admissionLeaseToken: null,
      admissionLeaseUntil: null,
      admissionLastError: Prisma.JsonNull,
      admittedAt: null,
      executionDeadlineAt: null,
    },
  });
  await scheduleCompanionMemoryRebuild(tx, {
    userId,
    characterId,
    purgeRunAttempts: [{ turnId: turn.id, throughAttempt: previousAttempt }],
  });
  const recoveredMediaAction = await rebindDurableTurnMedia(tx, userId, regenerated, previousAttempt);
  return { turn: regenerated, snapshot: await frozenExecutionSnapshot(tx, regenerated.id, false, contextDirectives, experience, userPersona, {
    recoveredMediaAction, userMessageRevision: originalSnapshot?.userMessageRevision,
    preservedImageEditSourceAssetId: originalSnapshot ? frozenChatImageEditSource(originalSnapshot) : null,
  }) };
}

export type ChatTurnEditOptions = {
  expectedAttempt?: number;
  idempotencyKey?: string;
  allowPaidImage?: boolean;
};

export async function editChatTurn(userId: string, messageId: string, nextContent: string, options: ChatTurnEditOptions = {}) {
  const content = requiredText(nextContent, "content", 20_000);
  const { expectedAttempt, allowPaidImage = false } = options;
  if (expectedAttempt !== undefined && (!Number.isSafeInteger(expectedAttempt) || expectedAttempt <= 0)) {
    throw Errors.badRequest("Edit requires a positive integer attempt");
  }
  const idempotencyKey = options.idempotencyKey === undefined ? undefined : requiredText(options.idempotencyKey, "Idempotency-Key", 160);
  const turn = await requireTurn(userId, messageId);
  if (turn.userMessageId !== messageId) throw Errors.badRequest("Only user messages can be edited");
  const receiptKey = idempotencyKey === undefined ? null : { turnId: turn.id, idempotencyKey };
  const requestHash = sha256(JSON.stringify({ content, expectedAttempt: expectedAttempt ?? null, allowPaidImage }));
  const whereReceipt = receiptKey ? { turnId_idempotencyKey: receiptKey } : null;
  const activeWhenRead = ACTIVE_ASSISTANT_STATES.includes(turn.assistantStatus);
  // Moderation runs outside the Turn lock. A committed retry needs neither a new
  // decision nor a new audit event. This read only controls that preparation.
  const needsModeration = content !== turn.userContent && !activeWhenRead
    && expectedAttempt === turn.attempt
    && !(whereReceipt && await prisma.chatTurnEditReceipt.findUnique({ where: whereReceipt, select: { turnId: true } }));
  const moderation = needsModeration ? await moderateText("chat_turn", turn.id, content, "input_edit") : null;
  const updated = await prisma.$transaction(async (tx) => {
    const current = await lockLatestTurn(tx, userId, turn, "revise");
    const receipt = whereReceipt && await tx.chatTurnEditReceipt.findUnique({ where: whereReceipt });
    if (receipt) {
      if (receipt.requestHash !== requestHash) {
        throw Errors.conflict("Idempotency-Key was already used for a different edit", { reason: "edit_key_conflict" });
      }
      if (receipt.attempt !== current.attempt) throw staleChatEdit(current.attempt);
      return {
        turn: current,
        snapshot: expectedAttempt !== undefined && current.assistantStatus === "pending" && current.executionSnapshot
          ? chatExecutionSnapshotSchema.parse(current.executionSnapshot) : null,
      };
    }
    // A known legacy key can read its original receipt. A new revision must
    // identify what the caller saw before preparing the edit.
    if (expectedAttempt === undefined) {
      throw Errors.versionConflict("This edit requires the observed reply attempt. Reopen the editor and try again.", {
        reason: "edit_attempt_required", attempt: current.attempt,
      });
    }
    if (current.attempt !== turn.attempt || current.attempt !== expectedAttempt) {
      throw staleChatEdit(current.attempt);
    }
    if (activeWhenRead || ACTIVE_ASSISTANT_STATES.includes(current.assistantStatus)) {
      throw Errors.conflict("A reply is already generating");
    }
    await assertNoPendingCompanionMemoryRebuild(tx, userId, turn.session.characterId);
    if (!moderation && content !== current.userContent) throw Errors.internal("Missing moderation decision for chat edit");
    const result = moderation
      ? await replaceLockedChatTurn(tx, { userId, turn: current, characterId: turn.session.characterId, content, moderation, allowPaidImage })
      : await regenerateLockedChatTurn(tx, userId, current, turn.session.characterId);
    if (receiptKey) {
      await tx.chatTurnEditReceipt.create({ data: { ...receiptKey, requestHash, attempt: result.turn.attempt } });
    }
    return result;
  });
  const { assistantMessageId, assistantStatus: status, attempt, userStatus, terminalEvidence } = updated.turn;
  const policyCode = jsonRecord(terminalEvidence).policyCode;
  return {
    assistantMessageId,
    attempt,
    status,
    streamUrl: ACTIVE_ASSISTANT_STATES.includes(status) ? streamUrl(assistantMessageId, attempt) : null,
    snapshot: updated.snapshot,
    ...(userStatus === "blocked" ? { safety: { layer: "input" as const, ...(typeof policyCode === "string" ? { policyCode } : {}) } } : {}),
  };
}

function staleChatEdit(attempt: number) {
  return Errors.versionConflict("This reply changed elsewhere. Reopen the editor to use the latest message.", { reason: "edit_attempt_changed", attempt });
}

async function replaceLockedChatTurn(tx: Prisma.TransactionClient, input: {
  userId: string;
  turn: ChatTurn;
  characterId: string;
  content: string;
  moderation: Awaited<ReturnType<typeof moderateText>>;
  allowPaidImage: boolean;
}) {
  const { userId, turn, characterId, content, moderation, allowPaidImage } = input;
  const blocked = moderation.status === "blocked";
  const now = new Date();
  if (!blocked) await reserveRevisedChatTurn(tx, userId, turn);
  const sceneAnchor = await previousCommittedScene(tx, turn);
  // Edited user words invalidate every old action, including unpaid drafts.
  // The old source remains a private snapshot, but no surviving card grants access.
  const actions = await tx.chatTurnAttachment.findMany({ where: { turnId: turn.id, kind: { in: ["generated_image", "generated_video"] } }, select: { id: true } });
  for (const action of actions) {
    const scope = await lockChatScope(tx, { userId, at: { attachment: action.id } });
    const attachment = scope.attachment!;
    if (attachment.status === "awaiting_confirmation") await transitionToolEffectAttachment(tx, attachment, { to: "cancelled", errorCode: "logical_turn_edited" });
    await tx.chatTurnAttachment.update({ where: { id: action.id }, data: {
      promptHint: null,
      metadata: toJson({ ...jsonRecord(attachment.metadata), editDraft: null, turnActionInvalidatedByEdit: true }),
    } });
  }
  await redactChatImageSourceText(tx, {
    userId,
    reason: "logical_turn_edited",
    redactedAt: now,
    exchangeIds: [turn.id],
    messageIds: [turn.userMessageId, turn.assistantMessageId],
  });
  const previousAttempt = turn.attempt;
  const originalSnapshot = turn.executionSnapshot ? chatExecutionSnapshotSchema.parse(turn.executionSnapshot) : null;
  const contextDirectives = originalSnapshot?.contextDirectives ?? [];
  const experience = originalSnapshot?.experience ?? null;
  const userPersona = originalSnapshot?.userPersona ?? null;
  // The replacement reply makes the exchange count again once it is sent.
  await appendChatExchangeCorrected(tx, turn, { userId, correctionType: "edited", correctionRevision: previousAttempt }, now);
  const edited = await tx.chatTurn.update({
    where: { id: turn.id },
    data: {
      attempt: { increment: 1 },
      userContent: content,
      userStatus: blocked ? "blocked" : "sent",
      assistantContent: blocked ? BLOCKED_NOTICE : "",
      assistantStatus: blocked ? "blocked" : "pending",
      imageActionMode: allowPaidImage ? "paid" : "chat",
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
      attemptStartedAt: now,
      admissionLeaseToken: null,
      admissionLeaseUntil: null,
      admissionLastError: Prisma.JsonNull,
      admittedAt: null,
      executionDeadlineAt: null,
    },
  });
  await scheduleCompanionMemoryRebuild(tx, {
    userId,
    characterId,
    purgeRunAttempts: [{ turnId: turn.id, throughAttempt: previousAttempt }],
  });
  return {
    turn: edited,
    snapshot: blocked ? null : await frozenExecutionSnapshot(tx, edited.id, false, contextDirectives, experience, userPersona, {
      userMessageRevision: edited.attempt,
    }),
  };
}

export async function deleteChatMessage(userId: string, messageId: string) {
  const turn = await requireTurn(userId, messageId);
  await prisma.$transaction(async (tx) => {
    const current = await lockLatestTurn(tx, userId, turn, "delete");
    await assertNoPendingCompanionMemoryRebuild(tx, userId, turn.session.characterId);
    if (ACTIVE_ASSISTANT_STATES.includes(current.assistantStatus)) {
      throw Errors.conflict("Cancel the active reply before deleting this chat turn");
    }
    await appendChatExchangeCorrected(tx, current, {
      userId,
      correctionType: "deleted",
      correctionRevision: current.attempt,
      sessionId: current.sessionId,
      messageIds: [current.userMessageId, current.assistantMessageId],
    }, new Date());
    await redactChatImageSourceText(tx, {
      userId,
      reason: "logical_turn_deleted",
      redactedAt: new Date(),
      exchangeIds: [turn.id],
      messageIds: [turn.userMessageId, turn.assistantMessageId],
    });
    const groupTurn = await tx.groupChatTurn.findUnique({ where: { turnId: current.id }, select: { groupId: true } });
    // The send key and transcript deletion commit together. A lost send
    // response must never reauthorize the deleted message.
    await tx.deletedChatTurnSend.createMany({
      data: [deletedChatTurnSendKey(userId, { sessionId: current.sessionId, groupId: groupTurn?.groupId ?? null }, current.idempotencyKey)],
      skipDuplicates: true,
    });
    await refundPendingDelayedAttachments(tx, userId, [turn.id]);
    await tx.chatTurn.delete({ where: { id: turn.id } });
    await scheduleCompanionMemoryRebuild(tx, {
      userId,
      characterId: turn.session.characterId,
      purgeTurnIds: [turn.id],
    });
  });
}

function deletedChatTurnSendKey(userId: string, scope: Pick<RecentChat, "sessionId" | "groupId">, idempotencyKey: string) {
  const conversationKey = scope.groupId ? `group:${scope.groupId}` : `session:${scope.sessionId}`;
  return { userId, conversationKey, keyHash: sha256(idempotencyKey) };
}

async function previousCommittedScene(
  tx: Prisma.TransactionClient,
  turn: { id: string; sessionId: string },
) {
  const groupTurn = await tx.groupChatTurn.findUnique({ where: { turnId: turn.id } });
  return tx.chatTurn.findFirst({
    where: {
      ...(groupTurn ? { groupTurn: { groupId: groupTurn.groupId, ordinal: { lt: groupTurn.ordinal } } } : { sessionId: turn.sessionId }),
      id: { not: turn.id },
      assistantStatus: "sent",
    },
    orderBy: groupTurn ? { groupTurn: { ordinal: "desc" } } : [{ createdAt: "desc" }, { id: "desc" }],
    select: { sceneVersion: true, scene: true },
  });
}

export async function requireTurn(userId: string, messageId: string) {
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

export async function lockLatestTurn(
  tx: Prisma.TransactionClient,
  userId: string,
  turn: { id: string; sessionId: string },
  operation: "revise" | "delete",
) {
  await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
  const session = await tx.recentChat.findFirst({
    where: { sessionId: turn.sessionId, userId },
    select: { groupId: true },
  });
  if (!session) throw Errors.notFound("Chat session not found");
  if (session.groupId) await tx.$queryRaw`SELECT id FROM "group_conversations" WHERE id = ${session.groupId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "sessionId" FROM "recent_chats" WHERE "sessionId" = ${turn.sessionId} FOR UPDATE`;
  if (operation === "revise") {
    const lockedSession = await tx.recentChat.findUnique({
      where: { sessionId: turn.sessionId },
      select: { status: true, characterId: true, characterReleaseId: true, group: { select: { status: true } } },
    });
    // Archived history can be deleted, but admission cannot execute a new
    // attempt there. Reject before replacing its saved reply or memory state.
    if (lockedSession?.status !== "active" || (lockedSession.group && lockedSession.group.status !== "active")) {
      throw Errors.gone("This conversation is archived. Its replies cannot be edited or regenerated");
    }
    // A revision starts a new attempt on the same Turn. Its immutable pin does
    // not preserve permission to execute after public Serving is revoked.
    await assertChatSessionServingAuthority(tx, userId, lockedSession);
  }
  await tx.$queryRaw`SELECT id FROM "chat_turns" WHERE id = ${turn.id} FOR UPDATE`;
  const current = await tx.chatTurn.findUnique({ where: { id: turn.id } });
  if (!current) throw Errors.notFound("Chat message not found");
  const latest = await tx.chatTurn.findFirst({
    where: session.groupId ? { groupTurn: { groupId: session.groupId } } : { sessionId: turn.sessionId },
    orderBy: session.groupId ? { groupTurn: { ordinal: "desc" } } : [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  if (latest?.id !== current.id) {
    throw Errors.conflict("Only the latest chat turn can be changed");
  }
  return current;
}
