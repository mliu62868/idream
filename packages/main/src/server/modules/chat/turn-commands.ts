// User Turn commands: send, regenerate, edit, delete.
import { randomUUID } from "node:crypto";
import { CHAT_SEND_PROTOCOL_VERSION, chatExecutionSnapshotSchema } from "@idream/shared/contracts";
import { Prisma, type ChatTurn, type RecentChat } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { moderateText } from "@/server/moderation/text-authority";
import { hasPendingCompanionMemoryMutation, retireCompanionMemoryAttempt } from "./companion-memory-authority";
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
import { discardReplyVersions, preserveReplyVersion, selectLockedReplyVersion } from "./turn-alternatives";
import type { ChatEntitlements } from "./chat-authority-snapshot";

// INTENT: the creating request admits its own Turn inline. Starting the first
// dispatcher due time a little later keeps the reconciler from claiming the
// same fresh attempt in parallel (see attemptChatAgentRunAdmission).
export const INLINE_ADMISSION_HEAD_START_MS = 3_000;

export async function beginChatTurn(input: {
  userId: string;
  sessionId: string;
  content: string;
  idempotencyKey: string;
  sendProtocolVersion?: string;
  allowPaidImage?: boolean;
  origin?: "user" | "proactive";
  voiceCall?: { id: string; leaseToken: string; utteranceId: string };
}): Promise<BegunChatTurn & { entitlements?: ChatEntitlements }> {
  const content = requiredText(input.content, "content", 20_000);
  const idempotencyKey = requiredText(input.idempotencyKey, "Idempotency-Key", 160);
  const userSend = input.origin !== "proactive" && !input.voiceCall;
  const allowPaidImage = input.allowPaidImage === true && userSend;
  const requestHash = sha256(JSON.stringify({ sessionId: input.sessionId, content, ...(allowPaidImage ? { allowPaidImage } : {}),
    ...(input.sendProtocolVersion !== undefined ? { sendProtocolVersion: input.sendProtocolVersion } : {}) }));
  const session = await requireActiveSession(input.userId, input.sessionId);
  const turnId = randomUUID();
  // A replayed key (or a conflicting reuse of one) is answered from its receipt
  // and needs no new moderation decision, so no orphan audit event is written.
  // The locked re-read below stays authoritative.
  const priorReceipt = await findSendReceipt(prisma, session, idempotencyKey);
  const moderation = priorReceipt ? null : await moderateText("chat_turn", turnId, content, "input");
  const blocked = moderation?.status === "blocked";

  const created = await prisma.$transaction(async (tx) => {
    // INVARIANT: the user lock serializes the daily quota across all of their
    // sessions; the session lock serializes product ordering inside one chat.
    const scope = await lockChatScope(tx, { userId: input.userId, at: { session: session.sessionId } });
    const lockedSession = scope.session;
    if (scope.group && scope.group.status !== "active") throw Errors.gone("Group conversation is unavailable or archived");
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
    const duplicate = await findSendReceipt(tx, lockedSession, idempotencyKey);
    if (!duplicate && await tx.deletedChatTurnSend.findUnique({
      where: { userId_conversationKey_keyHash: deletedChatTurnSendKey(input.userId, lockedSession, idempotencyKey) },
      select: { keyHash: true },
    })) {
      throw Errors.conflict("This message was deleted. Send again to make a new request.", { reason: "chat_send_deleted" });
    }
    if (duplicate) {
      if (duplicate.requestHash !== requestHash) {
        throw Errors.conflict("Idempotency-Key was already used for another message");
      }
      // An old, exact receipt is readable, but replaying its POST must not
      // restart execution or upgrade its original authorization protocol. Only
      // a still-pending attempt can be (re)admitted; anything else is a read
      // and freezes nothing.
      const replayable = duplicate.assistantStatus === "pending"
        && (!userSend || input.sendProtocolVersion === CHAT_SEND_PROTOCOL_VERSION);
      return { turn: duplicate, snapshot: replayable ? await pendingReplaySnapshot(tx, input.userId, lockedSession.characterId, duplicate) : null };
    }
    if (!moderation) {
      // The receipt seen before the lock is gone (deleted together with its tombstone check above).
      throw Errors.conflict("This chat changed while sending. Send the message again.");
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
      if (active) throw Errors.conflict("A reply is already generating", { reason: "reply_in_progress" });
      // INVARIANT: counted under the user lock taken above, so concurrent sends
      // from different sessions cannot all slip past the limit. A scheduled
      // proactive Turn neither counts nor is refused here.
      if (input.origin !== "proactive") await assertUserReplyCapacity(tx, input.userId);
    }
    const memoryIsolated = await hasPendingCompanionMemoryMutation(tx, input.userId, lockedSession.characterId);
    const previous = await tx.chatTurn.findFirst({
      where: { ...(lockedSession.groupId ? { groupTurn: { groupId: lockedSession.groupId } } : { sessionId: session.sessionId }), assistantStatus: "sent" },
      orderBy: lockedSession.groupId ? { groupTurn: { ordinal: "desc" } } : [{ createdAt: "desc" }, { id: "desc" }],
      select: { sceneVersion: true, scene: true },
    });
    // After the idempotent-replay return: a replay must not re-pin or bump contextRevision.
    const pinnedSession = await repinOwnerSessionToServingRelease(tx, input.userId, lockedSession);
    // Only the latest Turn's reply versions are selectable; a new Turn retires them.
    await discardReplyVersions(tx, lockedSession.groupId
      ? { turn: { groupTurn: { groupId: lockedSession.groupId } } }
      : { turn: { sessionId: session.sessionId } });
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
        attemptStartedAt: now,
        admissionNextRunAt: new Date(now.getTime() + INLINE_ADMISSION_HEAD_START_MS),
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
    const entitlements = blocked ? undefined : await reserveChatTurnUsage(tx, input.userId, turn);
    return {
      turn,
      entitlements,
      snapshot: blocked
        ? null
        : await frozenExecutionSnapshot(tx, turn.id, turn.memoryEnabled && !memoryIsolated),
    };
  });
  return {
    ...begunResult(
      created.turn,
      created.turn.id !== turnId,
      created.snapshot,
      blocked ? moderation?.policyCode : undefined,
    ),
    ...("entitlements" in created && created.entitlements ? { entitlements: created.entitlements } : {}),
  };
}

function findSendReceipt(
  db: Prisma.TransactionClient,
  session: Pick<RecentChat, "sessionId" | "groupId">,
  idempotencyKey: string,
) {
  return session.groupId
    ? db.chatTurn.findFirst({ where: { groupTurn: { groupId: session.groupId }, idempotencyKey } })
    : db.chatTurn.findUnique({ where: { sessionId_idempotencyKey: { sessionId: session.sessionId, idempotencyKey } } });
}

/** The frozen snapshot of a still-pending replayed send; a legacy row without one freezes it now. */
async function pendingReplaySnapshot(
  tx: Prisma.TransactionClient,
  userId: string,
  characterId: string,
  duplicate: ChatTurn,
) {
  if (duplicate.executionSnapshot) {
    const persisted = chatExecutionSnapshotSchema.safeParse(duplicate.executionSnapshot);
    if (!persisted.success) throw new Error("Chat Turn has an invalid frozen execution snapshot");
    return persisted.data;
  }
  // A legacy missing snapshot must not acquire today's settings during recovery.
  const memoryIsolated = await hasPendingCompanionMemoryMutation(tx, userId, characterId);
  return frozenExecutionSnapshot(tx, duplicate.id, duplicate.memoryEnabled && !memoryIsolated, [], null, null, {
    preservedImageEditSourceAssetId: null,
  });
}

export async function regenerateChatTurn(userId: string, messageId: string) {
  const turn = await requireTurn(userId, messageId);
  const updated = await prisma.$transaction(async (tx) => {
    const current = await lockLatestTurn(tx, userId, turn, "revise");
    // A pending memory rebuild refuses only a revision that needs another one
    // (see retireCompanionMemoryAttempt).
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
    throw Errors.conflict("A reply is already generating", { reason: "reply_in_progress" });
  }
  await reserveRevisedChatTurn(tx, userId, turn);
  const previousAttempt = turn.attempt;
  const memory = await retireCompanionMemoryAttempt(tx, { userId, characterId, turn, scope: "attempt" });
  // The replaced text reply stays selectable as an earlier version.
  await preserveReplyVersion(tx, turn);
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
      admissionNextRunAt: new Date(Date.now() + INLINE_ADMISSION_HEAD_START_MS),
      attemptStartedAt: new Date(),
      admissionLeaseToken: null,
      admissionLeaseUntil: null,
      admissionLastError: Prisma.JsonNull,
      admittedAt: null,
      executionDeadlineAt: null,
    },
  });
  const recoveredMediaAction = await rebindDurableTurnMedia(tx, userId, regenerated, previousAttempt);
  return { turn: regenerated, snapshot: await frozenExecutionSnapshot(tx, regenerated.id, !memory.memoryIsolated, contextDirectives, experience, userPersona, {
    recoveredMediaAction, userMessageRevision: originalSnapshot?.userMessageRevision,
    preservedImageEditSourceAssetId: originalSnapshot ? frozenChatImageEditSource(originalSnapshot) : null,
  }) };
}

export async function selectChatReplyVersion(userId: string, messageId: string, input: { ordinal: number; expectedAttempt: number }) {
  if (!Number.isSafeInteger(input.ordinal) || input.ordinal <= 0) throw Errors.badRequest("A reply version needs a positive ordinal");
  if (!Number.isSafeInteger(input.expectedAttempt) || input.expectedAttempt <= 0) throw Errors.badRequest("Selecting a version requires the observed attempt");
  const turn = await requireTurn(userId, messageId);
  if (turn.assistantMessageId !== messageId) throw Errors.badRequest("Only replies have versions");
  const selected = await prisma.$transaction(async (tx) => {
    const current = await lockLatestTurn(tx, userId, turn, "revise");
    return selectLockedReplyVersion(tx, {
      userId, characterId: turn.session.characterId, turn: current, ordinal: input.ordinal, expectedAttempt: input.expectedAttempt,
    });
  });
  return { assistantMessageId: selected.assistantMessageId, attempt: selected.attempt, status: selected.assistantStatus };
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
  // Every edit identifies the reply attempt the caller saw. (Attempt-less
  // legacy receipts had no remaining rows; their replay path was removed.)
  if (expectedAttempt === undefined) {
    throw Errors.versionConflict("This edit requires the observed reply attempt. Reopen the editor and try again.", {
      reason: "version_mismatch", cause: "edit_attempt_required", attempt: turn.attempt,
    });
  }
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
        snapshot: current.assistantStatus === "pending" && current.executionSnapshot
          ? chatExecutionSnapshotSchema.parse(current.executionSnapshot) : null,
      };
    }
    if (current.attempt !== turn.attempt || current.attempt !== expectedAttempt) {
      throw staleChatEdit(current.attempt);
    }
    if (activeWhenRead || ACTIVE_ASSISTANT_STATES.includes(current.assistantStatus)) {
      throw Errors.conflict("A reply is already generating", { reason: "reply_in_progress" });
    }
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
  return Errors.versionConflict("This reply changed elsewhere. Reopen the editor to use the latest message.", { reason: "version_mismatch", cause: "edit_attempt_changed", attempt });
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
  // The old user words leave memory exactly when they could have entered it.
  const memory = await retireCompanionMemoryAttempt(tx, { userId, characterId, turn, scope: "attempt" });
  // Earlier reply versions answered the old words.
  await discardReplyVersions(tx, { turnId: turn.id });
  const sceneAnchor = await previousCommittedScene(tx, turn);
  // Edited user words invalidate every old action, including unpaid drafts.
  // The old source remains a private snapshot, but no surviving card grants access.
  const { attachments } = await lockChatScope(tx, { userId, at: { turn: turn.id }, attachments: "all" });
  for (const attachment of attachments) {
    if (!["generated_image", "generated_video"].includes(attachment.kind)) continue;
    if (attachment.status === "awaiting_confirmation") await transitionToolEffectAttachment(tx, attachment, { to: "cancelled", errorCode: "logical_turn_edited" });
    await tx.chatTurnAttachment.update({ where: { id: attachment.id }, data: {
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
      admissionNextRunAt: new Date(now.getTime() + INLINE_ADMISSION_HEAD_START_MS),
      attemptStartedAt: now,
      admissionLeaseToken: null,
      admissionLeaseUntil: null,
      admissionLastError: Prisma.JsonNull,
      admittedAt: null,
      executionDeadlineAt: null,
    },
  });
  return {
    turn: edited,
    snapshot: blocked ? null : await frozenExecutionSnapshot(tx, edited.id, !memory.memoryIsolated, contextDirectives, experience, userPersona, {
      userMessageRevision: edited.attempt,
    }),
  };
}

export async function deleteChatMessage(userId: string, messageId: string) {
  const turn = await requireTurn(userId, messageId);
  await prisma.$transaction(async (tx) => {
    const current = await lockLatestTurn(tx, userId, turn, "delete");
    if (ACTIVE_ASSISTANT_STATES.includes(current.assistantStatus)) {
      throw Errors.conflict("Cancel the active reply before deleting this chat turn", { reason: "reply_in_progress" });
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
    await refundPendingDelayedAttachments(tx, userId, current.sessionId, [turn.id]);
    await tx.chatTurn.delete({ where: { id: turn.id } });
    await retireCompanionMemoryAttempt(tx, { userId, characterId: turn.session.characterId, turn: current, scope: "turn" });
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
  // Archived (and, for delete, deleted) history stays reachable here; the
  // revise-only gates below run under the same full ladder.
  const scope = await lockChatScope(tx, { userId, at: { turn: turn.id }, allowDeletedSession: true });
  const { session, group } = scope;
  if (operation === "revise") {
    // Archived history can be deleted, but admission cannot execute a new
    // attempt there. Reject before replacing its saved reply or memory state.
    if (session.status !== "active" || (group && group.status !== "active")) {
      throw Errors.gone("This conversation is archived. Its replies cannot be edited or regenerated");
    }
    // A revision starts a new attempt on the same Turn. Its immutable pin does
    // not preserve permission to execute after public Serving is revoked.
    await assertChatSessionServingAuthority(tx, userId, session);
  }
  const current: ChatTurn = scope.turn!;
  const latest = await tx.chatTurn.findFirst({
    where: session.groupId ? { groupTurn: { groupId: session.groupId } } : { sessionId: session.sessionId },
    orderBy: session.groupId ? { groupTurn: { ordinal: "desc" } } : [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  if (latest?.id !== current.id) {
    throw Errors.conflict("Only the latest chat turn can be changed", { reason: "version_mismatch" });
  }
  return current;
}
