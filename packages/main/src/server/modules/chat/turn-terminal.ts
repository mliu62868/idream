// Turn terminal transitions: Chat commit, user Stop and stalled reclaim.
import type { ChatTerminalCommit } from "@idream/shared/contracts";
import { chatExecutionSnapshotSchema, chatTerminalCommitSchema, MAIN_TO_CHAT_EVENTS } from "@idream/shared/contracts";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { recordMainToChatEvent } from "@/processes/chat-outbox";
import { scheduleCompanionMemoryProjection } from "./companion-memory-authority";
import { lockChatScope } from "./turn-scope";
import { hasChatMediaResponseAttachment } from "./tool-effect-attachment";
import { ACTIVE_ASSISTANT_STATES, jsonEqual, sha256, toJson } from "./turn-ledger-support";
import { settleChatTurnUsage } from "./turn-usage";
import { appendChatExchangeCompleted } from "./exchange-metrics";
import { requireTurn } from "./turn-commands";

export async function commitChatTerminal(input: ChatTerminalCommit) {
  // The service is also called in-process; HTTP decoding is not its authority boundary.
  const parsed = chatTerminalCommitSchema.safeParse(input);
  if (!parsed.success) throw Errors.badRequest("Invalid Chat terminal contract");
  input = parsed.data;
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
    const accepted = await tx.chatTurn.findUnique({ where: { id: input.turnId } });
    if (!accepted) throw Errors.notFound("Chat turn not found");
    if (
      accepted.sessionId === input.sessionId && accepted.assistantMessageId === input.assistantMessageId &&
      accepted.attempt === input.attempt && ACTIVE_ASSISTANT_STATES.includes(accepted.assistantStatus)
    ) {
      // A completed terminal is replayed below without advancing again. A new
      // selection must derive from this attempt's immutable, pre-Turn anchor,
      // including edits/regenerations which discarded a previously sent Scene.
      const anchor = chatExecutionSnapshotSchema.safeParse(accepted.executionSnapshot);
      if (!anchor.success || anchor.data.turnId !== input.turnId || anchor.data.sessionId !== input.sessionId ||
        anchor.data.assistantMessageId !== input.assistantMessageId || anchor.data.attempt !== input.attempt) {
        throw Errors.conflict("Chat terminal has no matching frozen Scene anchor");
      }
      if (input.status === "sent") {
        if (!input.content.trim() && !hasChatMediaResponseAttachment({
          id: accepted.id, attempt: accepted.attempt, terminalEvidence: input.terminalEvidence,
        }, await tx.chatTurnAttachment.findMany({ where: { turnId: accepted.id } }))) {
          throw Errors.conflict("An empty Chat reply requires a current durable media attachment");
        }
        if (input.sceneVersion !== anchor.data.sceneVersion + 1) {
          throw Errors.conflict("A sent Scene must advance exactly once from its frozen anchor");
        }
      } else if (input.sceneVersion !== anchor.data.sceneVersion || !jsonEqual(input.scene, anchor.data.scene)) {
        throw Errors.conflict("An unsuccessful terminal must preserve its complete frozen Scene");
      }
    }
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
        // A terminal attempt has no lookup consumer. The attachment and the
        // immutable terminal proposal each have their own durable receipt.
      },
    });
    const current = await tx.chatTurn.findUnique({ where: { id: input.turnId } });
    if (!current) throw Errors.notFound("Chat turn not found");
    if (changed.count === 1) {
      const session = await tx.recentChat.update({
        where: { sessionId: input.sessionId },
        data: {
          contextRevision: { increment: 1 },
          lastMessageAt: now,
          // A proactive reply arrives with nobody watching — the session list is
          // the only place it can announce itself. A failed or cancelled
          // proactive attempt has nothing to show, so it marks nothing.
          ...(current.origin === "proactive" && input.status === "sent"
            ? { proactiveUnreadAt: now }
            : {}),
        },
        select: { userId: true, characterId: true, entryExposureId: true, entryJourneyId: true, entryPlacementId: true },
      });
      await settleChatTurnUsage(tx, current, input.status, now);
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
          await scheduleCompanionMemoryProjection(tx, { userId: session.userId, characterId: session.characterId });
        }
        if (current.origin === "user") await appendChatExchangeCompleted(tx, current, session, now);
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
    // The original commit atomically scheduled projection. Its outbox owns
    // delivery and retry even if the terminal ACK was lost after commit.
    return { turn: current, duplicate: true };
  });
  return {
    accepted: true as const,
    duplicate: updated.duplicate,
    terminalMessageId: updated.turn.assistantMessageId,
    committedAt: updated.turn.terminalAt?.toISOString() ?? now.toISOString(),
  };
}

export async function cancelChatTurn(userId: string, messageId: string, expectedAttempt: number) {
  if (!Number.isSafeInteger(expectedAttempt) || expectedAttempt < 1) {
    throw Errors.badRequest("Stop requires the observed positive integer attempt");
  }
  const turn = await requireTurn(userId, messageId);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "sessionId" FROM "recent_chats" WHERE "sessionId" = ${turn.sessionId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "chat_turns" WHERE id = ${turn.id} FOR UPDATE`;
    const current = await tx.chatTurn.findFirst({
      where: { id: turn.id, session: { userId } },
    });
    if (!current) throw Errors.notFound("Chat message not found");
    if (current.attempt !== expectedAttempt) throw Errors.conflict("Stop belongs to a superseded Chat attempt");
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
    await settleChatTurnUsage(tx, current, "cancelled", now);
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

/**
 * SPEC: terminate a Turn that was admitted but never came back.
 *
 * INTENT: `generating` was the one admitted state with no way out. The pending
 * dispatcher only reclaims `pending`, so a Chat process that died after
 * admission left the row generating forever — and because `beginChatTurn`
 * refuses to open a Turn while any reply is active, that relationship could
 * never be used again. The user saw a spinner that outlived the process that
 * was supposed to fill it.
 *
 * INVARIANT: the CAS re-checks the frozen deadline inside the row lock, so a reply that
 * committed between the scan and the lock keeps its real terminal state. The
 * durable cancel intent is the same one user cancellation writes, so a Chat
 * that is merely slow stops instead of racing a terminal we already rejected.
 */
export async function failStalledChatTurn(turnId: string, cutoff: {
  deadlineBefore: Date;
  legacyStalledBefore: Date;
}) {
  const owner = await prisma.chatTurn.findFirst({
    where: { id: turnId },
    select: { session: { select: { userId: true } } },
  });
  if (!owner) return { reclaimed: false as const };
  const userId = owner.session.userId;
  return prisma.$transaction(async (tx) => {
    // The scope ladder owns the lock order; an archived or deleted session still
    // has to release its stuck attempt, so deleted sessions are allowed through.
    const scope = await lockChatScope(tx, {
      userId,
      at: { turn: turnId },
      allowDeletedSession: true,
    });
    const turn = scope.turn;
    // Re-read under the lock: a reply that committed between the scan and here
    // keeps its real terminal state.
    if (
      !turn ||
      turn.assistantStatus !== "generating" ||
      turn.terminalAt !== null ||
      (turn.executionDeadlineAt
        ? turn.executionDeadlineAt >= cutoff.deadlineBefore
        : turn.updatedAt >= cutoff.legacyStalledBefore)
    ) {
      return { reclaimed: false as const };
    }
    const now = new Date();
    await tx.chatTurn.update({
      where: { id: turn.id },
      data: {
        assistantStatus: "failed",
        terminalAt: now,
        terminalEvidence: toJson({ authority: "main_stalled_attempt_reclaim" }),
      },
    });
    await settleChatTurnUsage(tx, turn, "failed", now);
    await recordMainToChatEvent({
      eventId: `chat_agent_run_cancel_${sha256(`${turn.id}:${turn.attempt}`).slice(0, 40)}`,
      eventType: MAIN_TO_CHAT_EVENTS.agentRunCancelRequestedV1,
      aggregateType: "chat_turn",
      aggregateId: turn.id,
      payload: { version: 1, userId, turnId: turn.id, attempt: turn.attempt },
      occurredAt: now,
    }, tx);
    return { reclaimed: true as const, turnId: turn.id, attempt: turn.attempt };
  });
}
