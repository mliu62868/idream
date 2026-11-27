// chat.exchange.* canonical metric events written inside Turn transactions.
import { chatExchangeCompletedV2Schema, chatExchangeCorrectionV2Schema, METRIC_PRODUCT_EVENTS } from "@idream/shared/contracts";
import { Prisma } from "@prisma/client";
import { logger } from "@/server/lib/logger";
import { appendCanonicalMetricEvent } from "@/server/modules/admin-v2/metrics/event-writer";
import { jsonRecord } from "./turn-ledger-support";

const ENGAGEMENT_INACTIVITY_MS_V1 = 30 * 60 * 1_000;

function chatExchangeEventId(turnId: string, attempt: number) {
  return `chat_exchange:${turnId}:${attempt}`;
}

/**
 * SPEC: every sent reply to a user message emits `chat.exchange.completed.v2`
 * (WPCU, activation, QCE and every chat-based metric read only this event).
 * INTENT: Chat emitted it from its own ledger until Chat lost its database
 * (59089e316, 2026-08-28); since then nothing did and every chat metric sat at
 * zero. Main now owns the Turn, so it records the event in the same
 * transaction as the terminal commit, through the canonical metric outbox.
 *   - one event per sent attempt; the projector keeps the highest attempt, so
 *     a regeneration replaces the earlier reply in the fact.
 *   - a proactive Turn is not an exchange: the user sent nothing.
 *   - engagement session: continues the previous exchange of this session
 *     when this message came within 30 minutes of that reply (the v1 rule the
 *     Chat ledger used), otherwise starts at this Turn.
 */
export async function appendChatExchangeCompleted(
  tx: Prisma.TransactionClient,
  turn: {
    id: string;
    sessionId: string;
    userMessageId: string;
    assistantMessageId: string;
    attempt: number;
    createdAt: Date;
    characterContentVersionId: string | null;
    characterReleaseId: string | null;
  },
  session: {
    userId: string;
    characterId: string;
    entryExposureId: string | null;
    entryJourneyId: string | null;
    entryPlacementId: string | null;
  },
  at: Date,
) {
  if (!turn.characterContentVersionId) return;
  const previous = await tx.chatTurn.findFirst({
    where: { sessionId: turn.sessionId, id: { not: turn.id }, createdAt: { lte: turn.createdAt }, origin: "user", assistantStatus: "sent" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, attempt: true, terminalAt: true },
  });
  let engagementSessionId = `eng_${turn.id}`;
  if (previous?.terminalAt && turn.createdAt.getTime() - previous.terminalAt.getTime() < ENGAGEMENT_INACTIVITY_MS_V1) {
    const previousEvent = await tx.analyticsEvent.findUnique({
      where: { sourceService_sourceEventId: { sourceService: "main", sourceEventId: chatExchangeEventId(previous.id, previous.attempt) } },
      select: { props: true },
    });
    const inherited = jsonRecord(previousEvent?.props ?? null).engagementSessionId;
    if (typeof inherited === "string" && inherited) engagementSessionId = inherited;
  }
  // The contract accepts entry attribution only as a complete triple.
  const entry = session.entryExposureId && session.entryJourneyId && session.entryPlacementId
    ? { entryExposureId: session.entryExposureId, journeyId: session.entryJourneyId, placementId: session.entryPlacementId }
    : { entryExposureId: null, journeyId: null, placementId: null };
  // INVARIANT: 指标是派生数据，不能让一次契约漂移把已生成的回复整轮回滚；
  //   不合契约就记日志并跳过这条指标（纯 JS 判定，不会污染事务）。
  const parsed = chatExchangeCompletedV2Schema.safeParse({
    exchangeId: turn.id,
    userMessageId: turn.userMessageId,
    assistantMessageId: turn.assistantMessageId,
    selectedAssistantMessageId: turn.assistantMessageId,
    assistantAttemptNo: turn.attempt,
    isRegeneration: turn.attempt > 1,
    sessionId: turn.sessionId,
    engagementSessionId,
    userId: session.userId,
    characterId: session.characterId,
    characterContentVersionId: turn.characterContentVersionId,
    characterReleaseId: turn.characterReleaseId,
    ...entry,
  });
  if (!parsed.success) {
    logger.error({ turnId: turn.id, attempt: turn.attempt, issues: parsed.error.issues.slice(0, 5) }, "chat exchange metric outside its contract; skipped");
    return;
  }
  const payload = parsed.data;
  await appendCanonicalMetricEvent(tx, {
    sourceEventId: chatExchangeEventId(turn.id, turn.attempt),
    eventType: METRIC_PRODUCT_EVENTS.chatExchangeCompleted,
    occurredAt: at,
    userId: session.userId,
    context: {
      characterId: session.characterId,
      characterContentVersionId: turn.characterContentVersionId,
      characterReleaseId: turn.characterReleaseId,
    },
    payload,
  });
}

/**
 * SPEC: a user edit, message delete or session delete of an exchange that was
 * already counted emits `chat.exchange.corrected.v2` in the same transaction.
 * INTENT: the projector marks the exchange fact ineligible for every correction
 * except `selected`; without this an edited or deleted reply kept counting in
 * WPCU and activation. Rules carried over from the Chat producer before
 * 59089e316:
 *   - edited: revision = the attempt being replaced; the next sent attempt
 *     (revision + 1) makes the exchange count again; the projector ignores a
 *     correction older than the fact's attempt, so arrival order does not matter.
 *   - deleted / superseded (session delete): revision = the current attempt, so
 *     a late completion of that same attempt cannot revive it.
 *   - selected: a user adopts an earlier reply version (turn-alternatives);
 *     revision = the new attempt, selectedAssistantMessageId = the reply.
 *     Regeneration itself still replaces the reply through a higher-attempt
 *     completion event.
 *   - only exchanges that ever produced a completion (user origin, a sent reply,
 *     a content version) are corrected. A Turn from the 2026-08-28 gap has no
 *     fact at all; the projector skips a Main correction for it.
 */
export async function appendChatExchangeCorrected(
  tx: Prisma.TransactionClient,
  turn: ExchangeCorrectionTurn,
  correction: ExchangeCorrection,
  at: Date,
) {
  const event = chatExchangeCorrectedEvent(turn, correction, at);
  if (event) await appendCanonicalMetricEvent(tx, { ...event, userId: correction.userId });
}

type ExchangeCorrectionTurn = { id: string; origin: string; statsCountedAt: Date | null; characterContentVersionId: string | null };
type ExchangeCorrection = {
  userId: string;
  correctionType: "selected" | "edited" | "deleted" | "superseded";
  correctionRevision: number;
  selectedAssistantMessageId?: string;
  sessionId?: string;
  messageIds?: string[];
};

export function chatExchangeCorrectedEvent(turn: ExchangeCorrectionTurn, correction: ExchangeCorrection, at: Date) {
  if (turn.origin !== "user" || !turn.statsCountedAt || !turn.characterContentVersionId) return null;
  // INVARIANT: same as the completion event — a derived metric never rolls back the user's edit.
  const parsed = chatExchangeCorrectionV2Schema.safeParse({ exchangeId: turn.id, ...correction });
  if (!parsed.success) {
    logger.error({ turnId: turn.id, correctionType: correction.correctionType, issues: parsed.error.issues.slice(0, 5) }, "chat exchange correction metric outside its contract; skipped");
    return null;
  }
  return {
    sourceEventId: `chat_exchange_correction:${turn.id}:${correction.correctionType}:${correction.correctionRevision}`,
    eventType: METRIC_PRODUCT_EVENTS.chatExchangeCorrected,
    occurredAt: at,
    payload: parsed.data,
  };
}
