const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const QCE_EXCHANGE_THRESHOLD_V1 = 5;
const SUSTAINED_MINIMUM_GAP_MS_V1 = 12 * HOUR_MS;

export interface MetricSignup {
  readonly userId: string;
  readonly occurredAt: Date;
  readonly eligible: boolean;
}

export interface MetricChatExchange {
  readonly exchangeId: string;
  readonly userId: string;
  readonly characterId: string;
  readonly engagementSessionId: string;
  readonly occurredAt: Date;
  readonly eligible: boolean;
}

export interface MetricGenerationDelivery {
  readonly requestId: string;
  readonly userId: string;
  readonly occurredAt: Date;
  readonly eligible: boolean;
}

export interface MetricSubscription {
  readonly subscriptionId: string;
  readonly userId: string;
  readonly activeAt: Date;
  readonly endedAt: Date | null;
  readonly eligible: boolean;
}

export interface CanonicalMetricDataset {
  readonly signups: readonly MetricSignup[];
  readonly chatExchanges: readonly MetricChatExchange[];
  readonly generationDeliveries: readonly MetricGenerationDelivery[];
  readonly subscriptions: readonly MetricSubscription[];
}

export interface QualifiedConversationEpisode {
  readonly userId: string;
  readonly characterId: string;
  readonly engagementSessionId: string;
  readonly productDay: string;
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly exchangeCount: number;
}

export type MetricPublicationStatus = "official" | "shadow" | "diagnostic" | "guardrail";

export interface CanonicalMetricResult {
  readonly numerator: number;
  readonly denominator: number | null;
  readonly value: number | null;
  readonly sampleSize: number;
  readonly matureSampleSize: number;
  readonly immatureSampleSize: number;
  readonly maturity: "mature" | "immature" | "insufficient_data";
  readonly window: string;
  readonly timezone: "UTC";
  readonly definitionVersion: 1;
  readonly publicationStatus: MetricPublicationStatus;
  readonly qualityState: "certified" | "directional";
  readonly asOf: Date;
}

export interface CanonicalMetricEvaluation {
  readonly qualifiedEpisodes: readonly QualifiedConversationEpisode[];
  readonly depthMilestones: {
    readonly firstSuccessfulExchange: number;
    readonly fiveExchange: number;
    readonly twentyExchange: number;
  };
  readonly metrics: Readonly<Record<string, CanonicalMetricResult>>;
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcDayStart(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const result = new Map<string, T>();
  for (const item of items) result.set(key(item), item);
  return [...result.values()];
}

export function deriveQualifiedConversationEpisodes(
  exchanges: readonly MetricChatExchange[],
): readonly QualifiedConversationEpisode[] {
  const groups = new Map<string, MetricChatExchange[]>();
  for (const exchange of uniqueBy(exchanges.filter((row) => row.eligible), (row) => row.exchangeId)) {
    const day = utcDay(exchange.occurredAt);
    const key = [exchange.userId, exchange.characterId, exchange.engagementSessionId, day].join("\u0000");
    const rows = groups.get(key) ?? [];
    rows.push(exchange);
    groups.set(key, rows);
  }
  const episodes: QualifiedConversationEpisode[] = [];
  for (const rows of groups.values()) {
    if (rows.length < QCE_EXCHANGE_THRESHOLD_V1) continue;
    rows.sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime());
    const first = rows[0];
    const fifth = rows[QCE_EXCHANGE_THRESHOLD_V1 - 1];
    episodes.push({
      userId: first.userId,
      characterId: first.characterId,
      engagementSessionId: first.engagementSessionId,
      productDay: utcDay(first.occurredAt),
      startedAt: first.occurredAt,
      completedAt: fifth.occurredAt,
      exchangeCount: rows.length,
    });
  }
  return episodes.sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime());
}

function rateMetric(input: {
  numerator: number;
  denominator: number;
  immature: number;
  window: string;
  publicationStatus?: MetricPublicationStatus;
  qualityState?: "certified" | "directional";
  asOf: Date;
}): CanonicalMetricResult {
  return {
    numerator: input.numerator,
    denominator: input.denominator,
    value: input.denominator > 0 ? input.numerator / input.denominator : null,
    sampleSize: input.denominator + input.immature,
    matureSampleSize: input.denominator,
    immatureSampleSize: input.immature,
    maturity: input.denominator > 0 ? "mature" : input.immature > 0 ? "immature" : "insufficient_data",
    window: input.window,
    timezone: "UTC",
    definitionVersion: 1,
    publicationStatus: input.publicationStatus ?? "diagnostic",
    qualityState: input.qualityState ?? "certified",
    asOf: input.asOf,
  };
}

function countMetric(input: {
  numerator: number;
  sampleSize: number;
  window: string;
  publicationStatus: MetricPublicationStatus;
  qualityState: "certified" | "directional";
  asOf: Date;
}): CanonicalMetricResult {
  return {
    numerator: input.numerator,
    denominator: null,
    value: input.numerator,
    sampleSize: input.sampleSize,
    matureSampleSize: input.sampleSize,
    immatureSampleSize: 0,
    maturity: input.sampleSize > 0 ? "mature" : "insufficient_data",
    window: input.window,
    timezone: "UTC",
    definitionVersion: 1,
    publicationStatus: input.publicationStatus,
    qualityState: input.qualityState,
    asOf: input.asOf,
  };
}

function firstEpisodeByPair(episodes: readonly QualifiedConversationEpisode[]) {
  const first = new Map<string, QualifiedConversationEpisode>();
  for (const episode of episodes) {
    const key = `${episode.userId}\u0000${episode.characterId}`;
    if (!first.has(key)) first.set(key, episode);
  }
  return first;
}

function episodeOnDay(
  episodes: readonly QualifiedConversationEpisode[],
  first: QualifiedConversationEpisode,
  startOffset: number,
  endOffset = startOffset,
): boolean {
  const firstDay = utcDayStart(first.productDay).getTime();
  return episodes.some((episode) =>
    episode.userId === first.userId &&
    episode.characterId === first.characterId &&
    utcDayStart(episode.productDay).getTime() >= firstDay + startOffset * DAY_MS &&
    utcDayStart(episode.productDay).getTime() <= firstDay + endOffset * DAY_MS,
  );
}

function isSubscriptionActiveAt(subscription: MetricSubscription, at: Date): boolean {
  return subscription.eligible &&
    subscription.activeAt.getTime() <= at.getTime() &&
    (subscription.endedAt === null || subscription.endedAt.getTime() > at.getTime());
}

function sustainedPairs(episodes: readonly QualifiedConversationEpisode[], windowStart: Date, asOf: Date) {
  const byPair = new Map<string, QualifiedConversationEpisode[]>();
  for (const episode of episodes) {
    if (episode.startedAt < windowStart || episode.startedAt >= asOf) continue;
    const key = `${episode.userId}\u0000${episode.characterId}`;
    const rows = byPair.get(key) ?? [];
    rows.push(episode);
    byPair.set(key, rows);
  }
  const result: Array<{ first: QualifiedConversationEpisode; second: QualifiedConversationEpisode }> = [];
  for (const rows of byPair.values()) {
    rows.sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime());
    for (let left = 0; left < rows.length; left += 1) {
      const second = rows.find((candidate, right) =>
        right > left &&
        candidate.engagementSessionId !== rows[left].engagementSessionId &&
        candidate.productDay !== rows[left].productDay &&
        candidate.startedAt.getTime() - rows[left].completedAt.getTime() >= SUSTAINED_MINIMUM_GAP_MS_V1,
      );
      if (second) {
        result.push({ first: rows[left], second });
        break;
      }
    }
  }
  return result;
}

export function evaluateCanonicalMetrics(
  dataset: CanonicalMetricDataset,
  asOf: Date,
): CanonicalMetricEvaluation {
  const signups = uniqueBy(dataset.signups.filter((row) => row.eligible && row.occurredAt < asOf), (row) => row.userId);
  const exchanges = dataset.chatExchanges.filter((row) => row.eligible && row.occurredAt < asOf);
  const deliveries = uniqueBy(
    dataset.generationDeliveries.filter((row) => row.eligible && row.occurredAt < asOf),
    (row) => row.requestId,
  );
  const subscriptions = dataset.subscriptions.filter((row) => row.eligible && row.activeAt < asOf);
  const qualifiedEpisodes = deriveQualifiedConversationEpisodes(exchanges);
  const pairCohorts = [...firstEpisodeByPair(qualifiedEpisodes).values()];

  function signupWindowMetric(
    days: number,
    predicate: (signup: MetricSignup, cutoff: Date) => boolean,
    window: string,
  ) {
    const mature = signups.filter((signup) => addDays(signup.occurredAt, days) <= asOf);
    return rateMetric({
      numerator: mature.filter((signup) => predicate(signup, addDays(signup.occurredAt, days))).length,
      denominator: mature.length,
      immature: signups.length - mature.length,
      window,
      asOf,
    });
  }

  function retentionMetric(startOffset: number, endOffset: number, window: string) {
    const mature = pairCohorts.filter((cohort) =>
      addDays(utcDayStart(cohort.productDay), endOffset + 1) <= asOf,
    );
    return rateMetric({
      numerator: mature.filter((cohort) => episodeOnDay(qualifiedEpisodes, cohort, startOffset, endOffset)).length,
      denominator: mature.length,
      immature: pairCohorts.length - mature.length,
      window,
      asOf,
    });
  }

  const chatActivation = signupWindowMetric(1, (signup, cutoff) =>
    qualifiedEpisodes.some((episode) =>
      episode.userId === signup.userId &&
      episode.completedAt >= signup.occurredAt &&
      episode.completedAt <= cutoff,
    ), "signup_plus_24h");

  const relationshipActivation = signupWindowMetric(7, (signup, cutoff) => {
    const userEpisodes = qualifiedEpisodes.filter((episode) =>
      episode.userId === signup.userId &&
      episode.startedAt >= signup.occurredAt &&
      episode.startedAt <= cutoff,
    );
    return sustainedPairs(userEpisodes, signup.occurredAt, new Date(cutoff.getTime() + 1)).length > 0;
  }, "signup_plus_7d");

  const generationActivation = signupWindowMetric(7, (signup, cutoff) => deliveries.some((delivery) =>
    delivery.userId === signup.userId &&
    delivery.occurredAt >= signup.occurredAt &&
    delivery.occurredAt <= cutoff,
  ), "signup_plus_7d");

  function conversion(days: number) {
    return signupWindowMetric(days, (signup, cutoff) => subscriptions.some((subscription) =>
      subscription.userId === signup.userId &&
      subscription.activeAt >= signup.occurredAt &&
      subscription.activeAt <= cutoff,
    ), `signup_plus_${days}d`);
  }

  const rollingWindowStart = new Date(asOf.getTime() - 7 * DAY_MS);
  const rollingEpisodes = qualifiedEpisodes.filter((episode) => episode.startedAt >= rollingWindowStart && episode.startedAt < asOf);
  const rollingDeliveries = deliveries.filter((delivery) => delivery.occurredAt >= rollingWindowStart && delivery.occurredAt < asOf);
  const coreActivityUsers = new Set([
    ...exchanges
      .filter((exchange) => exchange.occurredAt >= rollingWindowStart && exchange.occurredAt < asOf)
      .map((exchange) => exchange.userId),
    ...rollingDeliveries.map((delivery) => delivery.userId),
  ]);
  const payingCoreUsers = new Set([...coreActivityUsers].filter((userId) =>
    subscriptions.some((subscription) =>
      subscription.userId === userId &&
      subscription.activeAt < asOf &&
      (subscription.endedAt === null || subscription.endedAt > rollingWindowStart),
    ),
  ));
  const sustained = sustainedPairs(qualifiedEpisodes, rollingWindowStart, asOf);
  const sustainedUsers = new Set(sustained.map(({ first }) => first.userId));
  const payingSustainedUsers = new Set(sustained.filter(({ first, second }) =>
    subscriptions.some((subscription) =>
      subscription.userId === first.userId &&
      (isSubscriptionActiveAt(subscription, first.completedAt) || isSubscriptionActiveAt(subscription, second.completedAt)),
    ),
  ).map(({ first }) => first.userId));

  const creationByUser = new Map<string, MetricGenerationDelivery[]>();
  for (const delivery of rollingDeliveries) {
    const rows = creationByUser.get(delivery.userId) ?? [];
    rows.push(delivery);
    creationByUser.set(delivery.userId, rows);
  }
  const sustainedCreationUsers = new Set<string>();
  for (const [userId, rows] of creationByUser) {
    rows.sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime());
    if (rows.some((left, index) => rows.some((right, rightIndex) =>
      rightIndex > index &&
      utcDay(left.occurredAt) !== utcDay(right.occurredAt) &&
      right.occurredAt.getTime() - left.occurredAt.getTime() >= SUSTAINED_MINIMUM_GAP_MS_V1,
    ))) sustainedCreationUsers.add(userId);
  }

  const activeSessionGroups = new Set(exchanges.map((row) =>
    `${row.userId}\u0000${row.characterId}\u0000${row.engagementSessionId}\u0000${utcDay(row.occurredAt)}`,
  ));
  const deepSessionGroups = new Set<string>();
  const sessionCounts = new Map<string, number>();
  for (const row of uniqueBy(exchanges, (exchange) => exchange.exchangeId)) {
    const key = `${row.userId}\u0000${row.characterId}\u0000${row.engagementSessionId}\u0000${utcDay(row.occurredAt)}`;
    sessionCounts.set(key, (sessionCounts.get(key) ?? 0) + 1);
    if ((sessionCounts.get(key) ?? 0) >= 20) deepSessionGroups.add(key);
  }

  return {
    qualifiedEpisodes,
    depthMilestones: {
      firstSuccessfulExchange: activeSessionGroups.size,
      fiveExchange: qualifiedEpisodes.length,
      twentyExchange: deepSessionGroups.size,
    },
    metrics: {
      "north_star.wpcu": countMetric({ numerator: payingCoreUsers.size, sampleSize: coreActivityUsers.size, window: "rolling_7d_utc", publicationStatus: "official", qualityState: "certified", asOf }),
      "north_star.wscu": countMetric({ numerator: sustainedUsers.size, sampleSize: new Set(rollingEpisodes.map((row) => row.userId)).size, window: "rolling_7d_utc", publicationStatus: "shadow", qualityState: "directional", asOf }),
      "diagnostic.wsr": countMetric({ numerator: sustained.length, sampleSize: firstEpisodeByPair(rollingEpisodes).size, window: "rolling_7d_utc", publicationStatus: "diagnostic", qualityState: "directional", asOf }),
      "guardrail.wscru": countMetric({ numerator: sustainedCreationUsers.size, sampleSize: creationByUser.size, window: "rolling_7d_utc", publicationStatus: "shadow", qualityState: "directional", asOf }),
      "business.wpscu": countMetric({ numerator: payingSustainedUsers.size, sampleSize: sustainedUsers.size, window: "rolling_7d_utc", publicationStatus: "shadow", qualityState: "directional", asOf }),
      "activation.chat_24h": chatActivation,
      "activation.relationship_7d": relationshipActivation,
      "activation.generation_7d": generationActivation,
      "retention.same_character_d1": retentionMetric(1, 1, "exact_d0_plus_1_utc_day"),
      "retention.same_character_d7": retentionMetric(7, 7, "exact_d0_plus_7_utc_day"),
      "retention.same_character_w1": retentionMetric(7, 13, "d0_plus_7_through_13_utc_days"),
      "conversion.paid_d7": conversion(7),
      "conversion.paid_d30": conversion(30),
    },
  };
}
