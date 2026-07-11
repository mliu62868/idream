import {
  METRIC_PRODUCT_EVENTS,
  aiUsageRecordedV2Schema,
  chatExchangeCompletedV2Schema,
  chatExchangeCorrectionV2Schema,
  customerSignupCompletedV2Schema,
  experimentExposedV2Schema,
  generationDeliveryCompletedV2Schema,
  subscriptionActivatedV2Schema,
  subscriptionEndedV2Schema,
} from "@idream/shared/contracts";
import { incrementCounter, observeHistogram } from "@idream/shared";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { CanonicalMetricDataset } from "./engine";
import { toInputJson } from "../shared/prisma-json";

export interface MetricProductEvent {
  readonly id: string;
  readonly sourceService: string;
  readonly sourceEventId: string;
  readonly name: string;
  readonly schemaVersion: number;
  readonly occurredAt: Date;
  readonly ingestedAt: Date;
  readonly environment: string;
  readonly dataClass: string;
  readonly trustClass: string;
  readonly actor: unknown;
  readonly context: unknown;
  readonly props: unknown;
}

export type MetricProjectionResult =
  | { readonly status: "applied" | "duplicate"; readonly factType: string; readonly factId: string | null }
  | { readonly status: "skipped"; readonly reason: string };

type Transaction = Prisma.TransactionClient;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function actorIsInternal(event: MetricProductEvent): boolean {
  return record(event.actor).isInternal === true;
}

function isEligibleServerOutcome(event: MetricProductEvent): boolean {
  return event.environment === "production" &&
    event.dataClass === "customer" &&
    event.trustClass === "canonical" &&
    !actorIsInternal(event);
}

function utcProductDay(date: Date): Date {
  return new Date(`${date.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

async function refreshCompanionDaily(
  tx: Transaction,
  key: { userId: string; characterId: string; productDay: Date },
) {
  const rows = await tx.chatExchangeFact.findMany({
    where: { ...key, eligible: true },
    select: { engagementSessionId: true, exchangeId: true, occurredAt: true },
  });
  const bySession = new Map<string, Set<string>>();
  for (const row of rows) {
    const exchanges = bySession.get(row.engagementSessionId) ?? new Set<string>();
    exchanges.add(row.exchangeId);
    bySession.set(row.engagementSessionId, exchanges);
  }
  await tx.companionEngagementDaily.upsert({
    where: {
      userId_characterId_productDay_metricVersion: {
        ...key,
        metricVersion: 1,
      },
    },
    create: {
      ...key,
      metricVersion: 1,
      exchangeCount: rows.length,
      engagementSessions: bySession.size,
      qceCount: [...bySession.values()].filter((exchanges) => exchanges.size >= 5).length,
      latestOccurredAt: rows.reduce(
        (latest, row) => row.occurredAt > latest ? row.occurredAt : latest,
        rows[0]?.occurredAt ?? key.productDay,
      ),
    },
    update: {
      exchangeCount: rows.length,
      engagementSessions: bySession.size,
      qceCount: [...bySession.values()].filter((exchanges) => exchanges.size >= 5).length,
      latestOccurredAt: rows.reduce(
        (latest, row) => row.occurredAt > latest ? row.occurredAt : latest,
        rows[0]?.occurredAt ?? key.productDay,
      ),
    },
  });
}

async function applyEvent(tx: Transaction, event: MetricProductEvent): Promise<MetricProjectionResult> {
  if (event.name === "chat.message.completed") {
    return { status: "skipped", reason: "legacy_untyped" };
  }
  if (event.name === METRIC_PRODUCT_EVENTS.experimentExposed) {
    const payload = experimentExposedV2Schema.parse(event.props);
    const eligibleExposure = event.environment === "production" &&
      event.dataClass === "customer" &&
      (event.trustClass === "typed_client" || event.trustClass === "canonical") &&
      !actorIsInternal(event) && payload.eligible;
    if (!eligibleExposure) return { status: "skipped", reason: "ineligible_data" };
    const fact = await tx.experimentExposureFact.upsert({
      where: { exposureId: payload.exposureId },
      create: {
        exposureId: payload.exposureId,
        sourceService: event.sourceService,
        sourceEventId: event.sourceEventId,
        experimentId: payload.experimentId,
        experimentVersion: payload.experimentVersion,
        assignmentVersion: payload.assignmentVersion,
        subjectType: payload.subjectType,
        subjectId: payload.subjectId,
        variant: payload.variant,
        eligible: true,
        environment: event.environment,
        dataClass: event.dataClass,
        trustClass: event.trustClass,
        occurredAt: event.occurredAt,
      },
      update: {},
    });
    return { status: "applied", factType: "experiment_exposure", factId: fact.id };
  }
  if (!isEligibleServerOutcome(event)) {
    return { status: "skipped", reason: "ineligible_data" };
  }
  const context = record(event.context);
  if (event.name === METRIC_PRODUCT_EVENTS.chatExchangeCompleted) {
    const payload = chatExchangeCompletedV2Schema.parse(event.props);
    const existing = await tx.chatExchangeFact.findUnique({ where: { exchangeId: payload.exchangeId } });
    if (existing && (
      existing.correctionRevision > payload.assistantAttemptNo ||
      existing.sourceUpdatedAt > event.occurredAt
    )) {
      return { status: "applied", factType: "chat_exchange", factId: existing.id };
    }
    const productDay = utcProductDay(event.occurredAt);
    const fact = await tx.chatExchangeFact.upsert({
      where: { exchangeId: payload.exchangeId },
      create: {
        exchangeId: payload.exchangeId,
        sourceService: event.sourceService,
        sourceEventId: event.sourceEventId,
        userMessageId: payload.userMessageId,
        assistantMessageId: payload.assistantMessageId,
        selectedAssistantMessageId: payload.selectedAssistantMessageId,
        assistantAttemptNo: payload.assistantAttemptNo,
        sessionId: payload.sessionId,
        engagementSessionId: payload.engagementSessionId,
        userId: payload.userId,
        characterId: payload.characterId,
        characterContentVersionId: payload.characterContentVersionId,
        characterReleaseId: payload.characterReleaseId,
        environment: event.environment,
        dataClass: event.dataClass,
        trustClass: event.trustClass,
        actorIsInternal: false,
        eligible: true,
        occurredAt: event.occurredAt,
        productDay,
        sourceUpdatedAt: event.occurredAt,
        validFrom: event.occurredAt,
        coverageState: payload.characterReleaseId === null ? "exact_unattributed" : "exact",
      },
      update: {
        sourceService: event.sourceService,
        sourceEventId: event.sourceEventId,
        assistantMessageId: payload.assistantMessageId,
        selectedAssistantMessageId: payload.selectedAssistantMessageId,
        assistantAttemptNo: payload.assistantAttemptNo,
        characterContentVersionId: payload.characterContentVersionId,
        characterReleaseId: payload.characterReleaseId,
        eligible: true,
        sourceUpdatedAt: event.occurredAt,
        coverageState: payload.characterReleaseId === null ? "exact_unattributed" : "exact",
      },
    });
    await refreshCompanionDaily(tx, { userId: fact.userId, characterId: fact.characterId, productDay: fact.productDay });
    return { status: "applied", factType: "chat_exchange", factId: fact.id };
  }
  if (event.name === METRIC_PRODUCT_EVENTS.chatExchangeCorrected) {
    const payload = chatExchangeCorrectionV2Schema.parse(event.props);
    const existing = await tx.chatExchangeFact.findUnique({ where: { exchangeId: payload.exchangeId } });
    if (!existing) return { status: "skipped", reason: "missing_exchange" };
    if (payload.correctionRevision > existing.correctionRevision) {
      await tx.chatExchangeFact.update({
        where: { id: existing.id },
        data: {
          correctionRevision: payload.correctionRevision,
          correctionType: payload.correctionType,
          selectedAssistantMessageId: payload.selectedAssistantMessageId ?? existing.selectedAssistantMessageId,
          eligible: payload.correctionType === "selected",
          sourceUpdatedAt: event.occurredAt,
        },
      });
      await refreshCompanionDaily(tx, {
        userId: existing.userId,
        characterId: existing.characterId,
        productDay: existing.productDay,
      });
    }
    return { status: "applied", factType: "chat_exchange_correction", factId: existing.id };
  }
  if (event.name === METRIC_PRODUCT_EVENTS.customerSignupCompleted) {
    const payload = customerSignupCompletedV2Schema.parse(event.props);
    const existing = await tx.customerSignupFact.findUnique({ where: { userId: payload.userId } });
    const fact = existing && existing.occurredAt <= event.occurredAt
      ? existing
      : await tx.customerSignupFact.upsert({
        where: { userId: payload.userId },
        create: {
          userId: payload.userId,
          sourceService: event.sourceService,
          sourceEventId: event.sourceEventId,
          environment: event.environment,
          dataClass: event.dataClass,
          trustClass: event.trustClass,
          actorIsInternal: false,
          eligible: true,
          occurredAt: event.occurredAt,
          validFrom: event.occurredAt,
        },
        update: {
          sourceService: event.sourceService,
          sourceEventId: event.sourceEventId,
          occurredAt: event.occurredAt,
          validFrom: event.occurredAt,
        },
      });
    return { status: "applied", factType: "customer_signup", factId: fact.id };
  }
  if (event.name === METRIC_PRODUCT_EVENTS.subscriptionActivated) {
    const payload = subscriptionActivatedV2Schema.parse(event.props);
    const fact = await tx.subscriptionLifecycleFact.upsert({
      where: { subscriptionId: payload.subscriptionId },
      create: {
        subscriptionId: payload.subscriptionId,
        userId: payload.userId,
        planId: payload.planId,
        activatedSourceService: event.sourceService,
        activatedSourceEventId: event.sourceEventId,
        environment: event.environment,
        dataClass: event.dataClass,
        trustClass: event.trustClass,
        eligible: true,
        activeAt: event.occurredAt,
        validFrom: event.occurredAt,
      },
      update: {
        userId: payload.userId,
        planId: payload.planId,
        activatedSourceService: event.sourceService,
        activatedSourceEventId: event.sourceEventId,
        activeAt: event.occurredAt,
        endedAt: null,
        endedSourceService: null,
        endedSourceEventId: null,
        eligible: true,
      },
    });
    return { status: "applied", factType: "subscription_lifecycle", factId: fact.id };
  }
  if (event.name === METRIC_PRODUCT_EVENTS.subscriptionEnded) {
    const payload = subscriptionEndedV2Schema.parse(event.props);
    const existing = await tx.subscriptionLifecycleFact.findUnique({ where: { subscriptionId: payload.subscriptionId } });
    if (!existing) return { status: "skipped", reason: "missing_subscription_activation" };
    const fact = await tx.subscriptionLifecycleFact.update({
      where: { id: existing.id },
      data: {
        endedSourceService: event.sourceService,
        endedSourceEventId: event.sourceEventId,
        endedAt: event.occurredAt,
      },
    });
    return { status: "applied", factType: "subscription_lifecycle", factId: fact.id };
  }
  if (event.name === METRIC_PRODUCT_EVENTS.generationDeliveryCompleted) {
    const payload = generationDeliveryCompletedV2Schema.parse(event.props);
    const validDelivery = payload.valid && payload.displayable && payload.deliveredOutputCount > 0;
    const fact = await tx.generationFulfillmentFact.upsert({
      where: { requestId: payload.requestId },
      create: {
        requestId: payload.requestId,
        sourceService: event.sourceService,
        sourceEventId: event.sourceEventId,
        artifactId: payload.artifactId,
        userId: payload.userId,
        characterId: stringOrNull(context.characterId),
        characterReleaseId: stringOrNull(context.characterReleaseId),
        placementId: stringOrNull(context.placementId),
        expectedOutputCount: payload.expectedOutputCount,
        deliveredOutputCount: payload.deliveredOutputCount,
        outcome: payload.deliveredOutputCount === payload.expectedOutputCount ? "succeeded" : "partial",
        validArtifact: payload.valid,
        displayable: payload.displayable,
        environment: event.environment,
        dataClass: event.dataClass,
        trustClass: event.trustClass,
        eligible: validDelivery,
        occurredAt: event.occurredAt,
        validFrom: event.occurredAt,
        coverageState: context.characterReleaseId ? "exact" : "exact_unattributed",
      },
      update: {
        sourceService: event.sourceService,
        sourceEventId: event.sourceEventId,
        artifactId: payload.artifactId,
        expectedOutputCount: payload.expectedOutputCount,
        deliveredOutputCount: payload.deliveredOutputCount,
        outcome: payload.deliveredOutputCount === payload.expectedOutputCount ? "succeeded" : "partial",
        validArtifact: payload.valid,
        displayable: payload.displayable,
        eligible: validDelivery,
        occurredAt: event.occurredAt,
      },
    });
    return { status: "applied", factType: "generation_fulfillment", factId: fact.id };
  }
  if (event.name === METRIC_PRODUCT_EVENTS.aiUsageRecorded) {
    const payload = aiUsageRecordedV2Schema.parse(event.props);
    const fact = await tx.aiUsageFact.create({
      data: {
        source: payload.invocationId,
        sourceService: event.sourceService,
        sourceEventId: event.sourceEventId,
        requestId: payload.requestId,
        attemptId: payload.attemptId,
        transportExecutionId: payload.transportExecutionId,
        userId: payload.userId,
        characterId: stringOrNull(context.characterId),
        releaseId: stringOrNull(context.characterReleaseId),
        provider: payload.provider,
        model: payload.model,
        usage: toInputJson(payload.usage),
        latencyMs: payload.latencyMs,
        costMicros: payload.costMicros === undefined ? null : BigInt(payload.costMicros),
        pricingVersion: payload.pricingVersion,
        environment: event.environment,
        dataClass: event.dataClass,
        trustClass: event.trustClass,
        occurredAt: event.occurredAt,
      },
    });
    return { status: "applied", factType: "ai_usage", factId: fact.id };
  }
  return { status: "skipped", reason: "unsupported_event" };
}

function receiptResult(receipt: {
  outcome: string;
  factType: string | null;
  factId: string | null;
  reason: string | null;
}): MetricProjectionResult {
  if (receipt.outcome === "skipped") return { status: "skipped", reason: receipt.reason ?? "unsupported_event" };
  return { status: "duplicate", factType: receipt.factType ?? "unknown", factId: receipt.factId };
}

export async function projectCanonicalMetricEvent(
  db: PrismaClient,
  event: MetricProductEvent,
): Promise<MetricProjectionResult> {
  let outcome = "error";
  try {
    const existing = await db.metricProjectionReceipt.findUnique({
      where: { sourceService_sourceEventId: { sourceService: event.sourceService, sourceEventId: event.sourceEventId } },
    });
    if (existing) {
      const result = receiptResult(existing);
      outcome = result.status;
      return result;
    }
    const result = await db.$transaction(async (tx) => {
      const concurrent = await tx.metricProjectionReceipt.findUnique({
        where: { sourceService_sourceEventId: { sourceService: event.sourceService, sourceEventId: event.sourceEventId } },
      });
      if (concurrent) return receiptResult(concurrent);
      const result = await applyEvent(tx, event);
      await tx.metricProjectionReceipt.create({
        data: {
          sourceService: event.sourceService,
          sourceEventId: event.sourceEventId,
          canonicalEventId: event.id,
          eventType: event.name,
          outcome: result.status,
          factType: "factType" in result ? result.factType : null,
          factId: "factId" in result ? result.factId : null,
          reason: "reason" in result ? result.reason : null,
          occurredAt: event.occurredAt,
        },
      });
      return result;
    });
    outcome = result.status;
    return result;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const receipt = await db.metricProjectionReceipt.findUniqueOrThrow({
        where: { sourceService_sourceEventId: { sourceService: event.sourceService, sourceEventId: event.sourceEventId } },
      });
      const result = receiptResult(receipt);
      outcome = result.status;
      return result;
    }
    throw error;
  } finally {
    incrementCounter(
      "projection_total",
      "Canonical projection events by outcome",
      { projection: "canonical_metrics", outcome },
    );
    observeHistogram(
      "projection_lag_seconds",
      "Canonical source occurrence to projection completion lag in seconds",
      { projection: "canonical_metrics" },
      Math.max(0, Date.now() - event.occurredAt.getTime()) / 1_000,
      [1, 5, 15, 30, 60, 120, 300, 900],
    );
  }
}

export async function loadCanonicalMetricDataset(
  db: PrismaClient,
  options: { readonly userIds?: readonly string[] } = {},
): Promise<CanonicalMetricDataset> {
  const userWhere = options.userIds ? { userId: { in: [...options.userIds] } } : {};
  const [signups, exchanges, deliveries, subscriptions] = await Promise.all([
    db.customerSignupFact.findMany({ where: userWhere, orderBy: { occurredAt: "asc" } }),
    db.chatExchangeFact.findMany({ where: userWhere, orderBy: { occurredAt: "asc" } }),
    db.generationFulfillmentFact.findMany({ where: userWhere, orderBy: { occurredAt: "asc" } }),
    db.subscriptionLifecycleFact.findMany({ where: userWhere, orderBy: { activeAt: "asc" } }),
  ]);
  return {
    signups: signups.map((row) => ({ userId: row.userId, occurredAt: row.occurredAt, eligible: row.eligible })),
    chatExchanges: exchanges.map((row) => ({
      exchangeId: row.exchangeId,
      userId: row.userId,
      characterId: row.characterId,
      engagementSessionId: row.engagementSessionId,
      occurredAt: row.occurredAt,
      eligible: row.eligible,
    })),
    generationDeliveries: deliveries.map((row) => ({
      requestId: row.requestId,
      userId: row.userId,
      occurredAt: row.occurredAt,
      eligible: row.eligible,
    })),
    subscriptions: subscriptions.map((row) => ({
      subscriptionId: row.subscriptionId,
      userId: row.userId,
      activeAt: row.activeAt,
      endedAt: row.endedAt,
      eligible: row.eligible,
    })),
  };
}

export interface MetricReconciliationReport {
  readonly asOf: Date;
  readonly duplicateEffectCount: number;
  readonly impossibleStateCount: number;
  readonly fixtureInternalLeakageCount: number;
  readonly joinCoverage: number;
  readonly userJoinCoverage: number;
  readonly characterJoinCoverage: number;
  readonly contentVersionJoinCoverage: number;
  readonly releaseJoinCoverage: number;
  readonly eventLagP95Ms: number | null;
  readonly scannedFactCount: number;
  readonly qualityState: "certified" | "invalid";
}

function coverage(joined: number, expected: number): number {
  return expected === 0 ? 1 : joined / expected;
}

function percentile95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

export async function reconcileCanonicalMetricFacts(
  db: PrismaClient,
  options: { readonly sourceEventPrefix?: string; readonly asOf?: Date } = {},
): Promise<MetricReconciliationReport> {
  const sourceWhere = options.sourceEventPrefix ? { sourceEventId: { startsWith: options.sourceEventPrefix } } : {};
  const [receipts, signups, exchanges, deliveries, subscriptions] = await Promise.all([
    db.metricProjectionReceipt.findMany({ where: sourceWhere }),
    db.customerSignupFact.findMany({ where: sourceWhere }),
    db.chatExchangeFact.findMany({ where: sourceWhere }),
    db.generationFulfillmentFact.findMany({ where: sourceWhere }),
    db.subscriptionLifecycleFact.findMany({
      where: options.sourceEventPrefix
        ? { activatedSourceEventId: { startsWith: options.sourceEventPrefix } }
        : {},
    }),
  ]);
  const facts = [...signups, ...exchanges, ...deliveries, ...subscriptions];
  const userIds = [...new Set(facts.map((row) => row.userId))];
  const characterIds = [...new Set([
    ...exchanges.map((row) => row.characterId),
    ...deliveries.flatMap((row) => row.characterId ? [row.characterId] : []),
  ])];
  const contentVersionIds = [...new Set(exchanges.map((row) => row.characterContentVersionId))];
  const releaseIds = [...new Set([
    ...exchanges.flatMap((row) => row.characterReleaseId ? [row.characterReleaseId] : []),
    ...deliveries.flatMap((row) => row.characterReleaseId ? [row.characterReleaseId] : []),
  ])];
  const [joinedUsers, joinedCharacters, joinedContentVersions, joinedReleases] = await Promise.all([
    db.user.count({ where: { id: { in: userIds } } }),
    db.character.count({ where: { id: { in: characterIds } } }),
    db.characterContentVersion.count({ where: { id: { in: contentVersionIds } } }),
    db.characterRelease.count({ where: { id: { in: releaseIds } } }),
  ]);
  const userJoinCoverage = coverage(joinedUsers, userIds.length);
  const characterJoinCoverage = coverage(joinedCharacters, characterIds.length);
  const contentVersionJoinCoverage = coverage(joinedContentVersions, contentVersionIds.length);
  const releaseJoinCoverage = coverage(joinedReleases, releaseIds.length);
  const joinCoverage = Math.min(userJoinCoverage, characterJoinCoverage, contentVersionJoinCoverage, releaseJoinCoverage);
  const impossibleStateCount =
    subscriptions.filter((row) => row.endedAt !== null && row.endedAt < row.activeAt).length +
    deliveries.filter((row) =>
      row.deliveredOutputCount > row.expectedOutputCount ||
      (row.outcome === "succeeded" && row.deliveredOutputCount !== row.expectedOutputCount),
    ).length;
  const fixtureInternalLeakageCount = facts.filter((row) =>
    row.eligible && (row.environment !== "production" || row.dataClass !== "customer" || row.actorIsInternal),
  ).length;
  const sourceKeys = facts.map((row) => {
    if ("sourceService" in row && "sourceEventId" in row) return `${row.sourceService}\u0000${row.sourceEventId}`;
    return `${row.activatedSourceService}\u0000${row.activatedSourceEventId}`;
  });
  const duplicateEffectCount = sourceKeys.length - new Set(sourceKeys).size;
  const eventLagP95Ms = percentile95(receipts.map((row) => Math.max(0, row.processedAt.getTime() - row.occurredAt.getTime())));
  return {
    asOf: options.asOf ?? new Date(),
    duplicateEffectCount,
    impossibleStateCount,
    fixtureInternalLeakageCount,
    joinCoverage,
    userJoinCoverage,
    characterJoinCoverage,
    contentVersionJoinCoverage,
    releaseJoinCoverage,
    eventLagP95Ms,
    scannedFactCount: facts.length,
    qualityState: duplicateEffectCount === 0 && impossibleStateCount === 0 && fixtureInternalLeakageCount === 0 && joinCoverage >= 0.99
      ? "certified"
      : "invalid",
  };
}
