import type { Prisma } from "@prisma/client";
import { toInputJson } from "../shared/prisma-json";

const DAY_MS = 24 * 60 * 60 * 1_000;
const RELATIONSHIP_MIN_GAP_MS = 12 * 60 * 60 * 1_000;

type Transaction = Prisma.TransactionClient;

function nextDay(day: Date) {
  return new Date(day.getTime() + DAY_MS);
}

function previousDays(day: Date, days: number) {
  return new Date(day.getTime() - days * DAY_MS);
}

function dayKey(day: Date) {
  return day.toISOString().slice(0, 10);
}

export async function refreshCharacterFunnelDaily(
  tx: Transaction,
  input: {
    readonly characterId: string;
    readonly characterContentVersionId: string;
    readonly characterReleaseId: string;
    readonly placementId: string | null;
    readonly productDay: Date;
    readonly asOf: Date;
  },
) {
  const placementWhere = input.placementId === null ? {} : { placementId: input.placementId };
  const exposures = await tx.characterExposureFact.findMany({
      where: {
        characterId: input.characterId,
        characterContentVersionId: input.characterContentVersionId,
        characterReleaseId: input.characterReleaseId,
        ...placementWhere,
        eligible: true,
        coverageState: "exact",
        occurredAt: { gte: input.productDay, lt: nextDay(input.productDay) },
      },
      select: { eventType: true, occurredAt: true },
    });
  const exchanges = await tx.chatExchangeFact.findMany({
      where: {
        characterId: input.characterId,
        characterContentVersionId: input.characterContentVersionId,
        characterReleaseId: input.characterReleaseId,
        ...placementWhere,
        eligible: true,
        coverageState: "exact",
        entryExposureId: { not: null },
        occurredAt: { lte: input.asOf },
      },
      select: {
        userId: true,
        sessionId: true,
        engagementSessionId: true,
        productDay: true,
        occurredAt: true,
      },
    });
  const sessions = new Map<string, {
    userId: string;
    chatSessionId: string;
    sessionId: string;
    productDay: Date;
    firstAt: Date;
    completedAt: Date;
    exchanges: number;
  }>();
  for (const exchange of exchanges) {
    const key = `${exchange.userId}|${dayKey(exchange.productDay)}|${exchange.engagementSessionId}`;
    const session = sessions.get(key);
    if (!session) {
      sessions.set(key, {
        userId: exchange.userId,
        chatSessionId: exchange.sessionId,
        sessionId: exchange.engagementSessionId,
        productDay: exchange.productDay,
        firstAt: exchange.occurredAt,
        completedAt: exchange.occurredAt,
        exchanges: 1,
      });
    } else {
      session.exchanges += 1;
      if (exchange.occurredAt < session.firstAt) session.firstAt = exchange.occurredAt;
      if (exchange.occurredAt > session.completedAt) session.completedAt = exchange.occurredAt;
    }
  }
  const allSessions = [...sessions.values()];
  const firstEngagementByChatSession = new Map<string, (typeof allSessions)[number]>();
  for (const session of [...allSessions].sort((left, right) => left.firstAt.getTime() - right.firstAt.getTime())) {
    if (!firstEngagementByChatSession.has(session.chatSessionId)) {
      firstEngagementByChatSession.set(session.chatSessionId, session);
    }
  }
  const dayStarts = [...firstEngagementByChatSession.values()]
    .filter((session) => dayKey(session.productDay) === dayKey(input.productDay));
  const qceEpisodes = allSessions.filter((session) => session.exchanges >= 5);
  const dayStartQce = dayStarts.filter((session) => session.exchanges >= 5);
  const dayQceEpisodes = qceEpisodes.filter((session) => dayKey(session.productDay) === dayKey(input.productDay));
  const relationshipUsers = new Set<string>();
  for (const episode of dayQceEpisodes) {
    const prior = qceEpisodes.find((candidate) =>
      candidate.userId === episode.userId &&
      candidate.sessionId !== episode.sessionId &&
      dayKey(candidate.productDay) !== dayKey(episode.productDay) &&
      candidate.completedAt.getTime() <= episode.firstAt.getTime() - RELATIONSHIP_MIN_GAP_MS &&
      candidate.completedAt.getTime() >= episode.firstAt.getTime() - 7 * DAY_MS,
    );
    if (prior) relationshipUsers.add(episode.userId);
  }

  const firstQceDayByUser = new Map<string, Date>();
  for (const episode of [...qceEpisodes].sort((left, right) => left.completedAt.getTime() - right.completedAt.getTime())) {
    if (!firstQceDayByUser.has(episode.userId)) firstQceDayByUser.set(episode.userId, episode.productDay);
  }
  const d7Mature = input.asOf.getTime() >= nextDay(new Date(input.productDay.getTime() + 7 * DAY_MS)).getTime();
  const d7Cohort = d7Mature
    ? [...firstQceDayByUser.entries()]
        .filter(([, firstDay]) => dayKey(firstDay) === dayKey(input.productDay))
        .map(([userId]) => userId)
    : [];
  const d7Day = new Date(input.productDay.getTime() + 7 * DAY_MS);
  const d7Returns = d7Cohort.filter((userId) => qceEpisodes.some((episode) =>
    episode.userId === userId && dayKey(episode.productDay) === dayKey(d7Day),
  ));
  const latestDataAt = [...exposures.map((row) => row.occurredAt), ...exchanges.map((row) => row.occurredAt)]
    .reduce<Date | null>((latest, value) => latest === null || value > latest ? value : latest, null);
  const data = {
    characterId: input.characterId,
    characterContentVersionId: input.characterContentVersionId,
    characterReleaseId: input.characterReleaseId,
    placementId: input.placementId,
    productDay: input.productDay,
    metricVersion: 1,
    eligibleImpressions: exposures.filter((row) => row.eventType === "eligible_impression").length,
    detailViews: exposures.filter((row) => row.eventType === "detail_view").length,
    firstSuccessfulExchanges: dayStarts.length,
    qceCount: dayStartQce.length,
    relationshipActivations: relationshipUsers.size,
    sameCharacterD7EligiblePairs: d7Cohort.length,
    sameCharacterD7Returns: d7Returns.length,
    paidAttributions: 0,
    coverageState: "exact_through_same_character_d7_paid_attribution_unavailable",
    projectionVersion: 2,
    latestDataAt,
    sourceEvidence: toInputJson([
      "character_exposure_facts:exact_chain",
      "chat_exchange_facts:exact_entry_attribution",
      "qce:v1",
      "same_character_d7:calendar_day_v1",
      "paid_attribution:unavailable",
    ]),
  };
  const existing = await tx.characterFunnelDaily.findFirst({
    where: {
      characterContentVersionId: input.characterContentVersionId,
      characterReleaseId: input.characterReleaseId,
      placementId: input.placementId,
      productDay: input.productDay,
      metricVersion: 1,
    },
  });
  return existing
    ? tx.characterFunnelDaily.update({ where: { id: existing.id }, data })
    : tx.characterFunnelDaily.create({ data });
}

export async function refreshCharacterFunnelForEvent(
  tx: Transaction,
  input: {
    readonly characterId: string;
    readonly characterContentVersionId: string;
    readonly characterReleaseId: string;
    readonly placementId: string;
    readonly productDay: Date;
    readonly asOf: Date;
  },
) {
  const priorDay = previousDays(input.productDay, 7);
  const priorExists = await tx.characterFunnelDaily.findFirst({
    where: {
      characterContentVersionId: input.characterContentVersionId,
      characterReleaseId: input.characterReleaseId,
      productDay: priorDay,
      metricVersion: 1,
    },
    select: { id: true },
  });
  const days = priorExists ? [input.productDay, priorDay] : [input.productDay];
  for (const productDay of days) {
    await refreshCharacterFunnelDaily(tx, { ...input, productDay, placementId: input.placementId });
    await refreshCharacterFunnelDaily(tx, { ...input, productDay, placementId: null });
  }
}
