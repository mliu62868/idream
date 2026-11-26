import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { MAIN_TO_CHAT_EVENTS } from "@idream/shared/contracts";
import { recordMainToChatEvent } from "@/processes/chat-outbox";

/**
 * SPEC: the durable Main → Chat cancel intent for one exact attempt.
 *
 * INVARIANT: every path that ends an attempt Chat may already be running (user
 * Stop, stalled reclaim, admission expiry, memory clear) writes this intent in
 * the same transaction as the terminal state. The id is derived from the
 * attempt, so concurrent writers converge on one outbox row.
 */
export async function recordAgentRunCancelIntent(
  tx: Prisma.TransactionClient,
  input: { userId: string; turnId: string; attempt: number; occurredAt: Date },
): Promise<void> {
  await recordMainToChatEvent({
    eventId: `chat_agent_run_cancel_${createHash("sha256").update(`${input.turnId}:${input.attempt}`).digest("hex").slice(0, 40)}`,
    eventType: MAIN_TO_CHAT_EVENTS.agentRunCancelRequestedV1,
    aggregateType: "chat_turn",
    aggregateId: input.turnId,
    payload: { version: 1, userId: input.userId, turnId: input.turnId, attempt: input.attempt },
    occurredAt: input.occurredAt,
  }, tx);
}

/**
 * SPEC: durable removal of a superseded attempt's local AgentRun evidence when
 * no relationship rebuild carries it (the attempt never reached memory).
 * `throughAttempt` omitted = the Turn itself was deleted.
 *
 * INVARIANT: same aggregate as the cancel intent, so the lifecycle lane delivers
 * a pending cancel of that attempt before its purge.
 */
export async function recordAgentRunPurgeIntent(
  tx: Prisma.TransactionClient,
  input: { userId: string; turnId: string; throughAttempt?: number; occurredAt: Date },
): Promise<void> {
  const scope = input.throughAttempt === undefined ? "turn" : `through:${input.throughAttempt}`;
  await recordMainToChatEvent({
    eventId: `chat_agent_run_purge_${createHash("sha256").update(`${input.turnId}:${scope}`).digest("hex").slice(0, 40)}`,
    eventType: MAIN_TO_CHAT_EVENTS.agentRunPurgeRequestedV1,
    aggregateType: "chat_turn",
    aggregateId: input.turnId,
    payload: {
      version: 1, userId: input.userId, turnId: input.turnId,
      ...(input.throughAttempt === undefined ? {} : { throughAttempt: input.throughAttempt }),
    },
    occurredAt: input.occurredAt,
  }, tx);
}
