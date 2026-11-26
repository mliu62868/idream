// Daily allowance, per-user concurrency and usage-fact settlement for Turns.
import { FREE_DAILY_MESSAGES } from "@idream/shared/chat/limits";
import type { ChatTerminalCommit } from "@idream/shared/contracts";
import { Prisma } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import { entitlementMap } from "@/server/modules/ourdream/subscription-lifecycle";
import { ACTIVE_ASSISTANT_STATES } from "./turn-ledger-support";

// INTENT: Chat 的 agent 池是全站共享的少量槽位；不设按用户上限时，一个人在多个会话里
// 并发发送就能占满池子，让其他用户排队。3 个足够覆盖正常的多会话切换。
const MAX_ACTIVE_TURNS_PER_USER = 3;

// SPEC: one user has at most MAX_ACTIVE_TURNS_PER_USER replies generating at
// once across chats, whether from a send, a regenerate or an edit.
// INTENT: proactive Turns are the Character's own check-ins; counting them would
// refuse a message the user actually typed.
export async function assertUserReplyCapacity(tx: Prisma.TransactionClient, userId: string) {
  const activeForUser = await tx.chatTurn.count({
    where: { session: { userId }, origin: { not: "proactive" }, assistantStatus: { in: ACTIVE_ASSISTANT_STATES } },
  });
  if (activeForUser >= MAX_ACTIVE_TURNS_PER_USER) {
    throw Errors.conflict(
      `A reply is already generating in ${activeForUser} of your chats. Wait for one to finish, then send again.`,
      { reason: "reply_in_progress", scope: "account" },
    );
  }
}

async function assertChatQuota(tx: Prisma.TransactionClient, userId: string, day: Date) {
  // The map read under the user lock is returned so inline admission can reuse it.
  const now = new Date();
  const entitlements = await entitlementMap(userId, tx, now);
  if (entitlements.unlimited_messages === true) return entitlements;
  // SPEC: the free allowance counts the user's own messages for the UTC day.
  // INTENT: every admitted Turn still writes a usage fact, because a proactive
  // reply costs the same generation capacity and daily operational usage must
  // stay complete. Only what the user chose to send can exhaust their own
  // allowance.
  // INVARIANT: the count reads the fact alone. Facts deliberately outlive the
  // Turn (no FK), so a JOIN to "chat_turns" would hand the allowance back
  // every time the user deleted a message or a session.
  const [row] = await tx.$queryRaw<Array<{ used: bigint }>>`
    SELECT count(*) AS used
      FROM "chat_turn_usage_facts"
     WHERE "userId" = ${userId}
       AND "productDay" = ${day}::date
       AND "origin" = 'user'
       AND "voidedAt" IS NULL
  `;
  if (Number(row?.used ?? 0) >= FREE_DAILY_MESSAGES) {
    throw Errors.paymentRequired("Daily free message limit reached");
  }
  return entitlements;
}

/** Caller holds the user and conversation locks from lockLatestTurn. */
export async function reserveRevisedChatTurn(
  tx: Prisma.TransactionClient,
  userId: string,
  turn: { id: string; sessionId: string; createdAt: Date; origin: string },
) {
  const groupTurn = await tx.groupChatTurn.findUnique({ where: { turnId: turn.id }, select: { groupId: true } });
  const active = await tx.chatTurn.findFirst({
    where: {
      ...(groupTurn ? { groupTurn: { groupId: groupTurn.groupId } } : { sessionId: turn.sessionId }),
      id: { not: turn.id },
      assistantStatus: { in: ACTIVE_ASSISTANT_STATES },
    },
    select: { id: true },
  });
  if (active) throw Errors.conflict("A reply is already generating", { reason: "reply_in_progress" });
  await assertUserReplyCapacity(tx, userId);
  await reserveChatTurnUsage(tx, userId, turn);
}

/**
 * INVARIANT: every executable Turn holds one allowance reservation before Chat
 * starts. A blocked Turn has none; a failed Turn released its reservation.
 * Revisions of an already-counted Turn never consume another slot. The user
 * lock serializes restoration across sessions, not just within the latest Turn.
 */
export async function reserveChatTurnUsage(
  tx: Prisma.TransactionClient,
  userId: string,
  turn: { id: string; createdAt: Date; origin: string },
) {
  const fact = await tx.chatTurnUsageFact.findUnique({ where: { turnId: turn.id } });
  if (fact && fact.voidedAt === null) return undefined;
  // Scheduled Character messages retain operational usage without spending
  // the allowance for messages the user chose to send.
  // A revision restores its original Turn-day fact, even across midnight.
  const day = fact?.productDay ?? productDay(turn.createdAt);
  const entitlements = turn.origin !== "proactive" ? await assertChatQuota(tx, userId, day) : undefined;
  if (fact) {
    await tx.chatTurnUsageFact.update({ where: { turnId: turn.id }, data: { voidedAt: null } });
  } else {
    await tx.chatTurnUsageFact.create({
      data: { turnId: turn.id, userId, productDay: day, origin: turn.origin },
    });
  }
  return entitlements;
}

/**
 * SPEC: the free allowance counts Turns that gave the user a reply.
 *
 * INTENT: charging a Turn that failed makes the user pay for our outage — while
 * the model was down every send spent 1/30 and delivered nothing.
 *   - failed / blocked: voided.
 *   - cancelled: voided only while the attempt was never admitted to Chat
 *     (`admittedAt` null). An admitted attempt is already streaming text to the
 *     user; voiding it would make "read the reply, then press Stop" free.
 *   - a consumed fact remains consumed across all subsequent attempts. This
 *     includes an admitted cancellation, which never increments reply stats.
 *   - regenerate / edit reserves a released slot before executing. A sent
 *     attempt keeps that reservation; another failed attempt releases it again.
 * INVARIANT: the fact row is never deleted here; operational usage stays whole.
 */
export async function settleChatTurnUsage(
  tx: Prisma.TransactionClient,
  turn: { id: string; statsCountedAt: Date | null; admittedAt: Date | null },
  outcome: ChatTerminalCommit["status"],
  at: Date,
) {
  if (outcome === "sent" || turn.statsCountedAt || (outcome === "cancelled" && turn.admittedAt)) {
    await tx.chatTurnUsageFact.updateMany({
      where: { turnId: turn.id, consumedAt: null },
      data: { voidedAt: null, consumedAt: turn.statsCountedAt ?? at },
    });
    return;
  }
  await tx.chatTurnUsageFact.updateMany({
    where: { turnId: turn.id, voidedAt: null, consumedAt: null },
    data: { voidedAt: at },
  });
}

function productDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}
