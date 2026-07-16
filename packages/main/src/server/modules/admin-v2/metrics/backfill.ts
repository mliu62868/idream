import { METRIC_PRODUCT_EVENTS } from "@idream/shared/contracts";
import type { PrismaClient } from "@prisma/client";
import { toInputJson } from "../shared/prisma-json";
import { projectCanonicalMetricEvent, type MetricProductEvent } from "./projector";
import { classifyExistingCustomerMetricActor } from "./event-classification";

const SUPPORTED_EVENT_TYPES = Object.values(METRIC_PRODUCT_EVENTS);

export interface MetricBackfillOptions {
  readonly source: string;
  readonly sourceKind?: "main_authority" | "canonical_events";
  readonly dryRun: boolean;
  readonly batchSize: number;
  readonly cursor?: string | null;
  readonly userIdPrefix?: string;
}

export interface MetricBackfillReport {
  readonly runId: string;
  readonly status: "paused" | "completed";
  readonly dryRun: boolean;
  readonly scannedCount: number;
  readonly wouldApplyCount: number;
  readonly appliedCount: number;
  readonly duplicateCount: number;
  readonly skippedCount: number;
  readonly mismatchCount: number;
  readonly nextCursor: string | null;
  readonly validFrom: string | null;
  readonly coverage: number;
  readonly before: Readonly<Record<string, number>>;
  readonly after: Readonly<Record<string, number>>;
  readonly mismatches: readonly Readonly<Record<string, unknown>>[];
}

interface BackfillItem {
  readonly cursor: string;
  readonly event: MetricProductEvent;
}

function syntheticEvent(input: {
  sourceEventId: string;
  eventType: string;
  occurredAt: Date;
  classification: ReturnType<typeof classifyExistingCustomerMetricActor>;
  payload: Record<string, unknown>;
  context?: Record<string, unknown>;
}): MetricProductEvent {
  return {
    id: input.sourceEventId,
    sourceService: "main",
    sourceEventId: input.sourceEventId,
    name: input.eventType,
    schemaVersion: 2,
    occurredAt: input.occurredAt,
    ingestedAt: new Date(),
    environment: "production",
    dataClass: input.classification.dataClass,
    trustClass: "canonical",
    actor: input.classification.actor,
    context: input.context ?? {},
    props: input.payload,
  };
}

async function mainAuthorityItems(
  db: PrismaClient,
  options: MetricBackfillOptions,
): Promise<{ items: BackfillItem[]; hasMore: boolean }> {
  const limit = Math.max(1, Math.min(options.batchSize, 1_000));
  const [cursorKind, cursorId = ""] = options.cursor?.split(":", 2) ?? ["signup", ""];
  const items: BackfillItem[] = [];
  if (cursorKind === "signup") {
    const users = await db.user.findMany({
      where: {
        id: {
          gt: cursorId,
          ...(options.userIdPrefix ? { startsWith: options.userIdPrefix } : {}),
        },
      },
      orderBy: { id: "asc" },
      take: limit + 1,
    });
    for (const user of users.slice(0, limit)) {
      const sourceEventId = `backfill.main.user.${user.id}.signup.v2`;
      items.push({
        cursor: `signup:${user.id}`,
        event: syntheticEvent({
          sourceEventId,
          eventType: METRIC_PRODUCT_EVENTS.customerSignupCompleted,
          occurredAt: user.createdAt,
          classification: classifyExistingCustomerMetricActor(user),
          payload: { userId: user.id },
        }),
      });
    }
    if (users.length > limit) return { items, hasMore: true };
  }
  const remaining = limit - items.length;
  if (remaining <= 0) {
    const moreSubscriptions = await db.subscription.count({
      where: {
        status: "active",
        ...(options.userIdPrefix ? { userId: { startsWith: options.userIdPrefix } } : {}),
      },
    });
    return { items, hasMore: moreSubscriptions > 0 };
  }
  const subscriptionCursor = cursorKind === "subscription" ? cursorId : "";
  const subscriptions = await db.subscription.findMany({
    where: {
      id: { gt: subscriptionCursor },
      // Terminal/checkout-only legacy rows do not retain an authoritative
      // activeAt. Backfill only what is exact; the rest remains unavailable.
      status: "active",
      ...(options.userIdPrefix ? { userId: { startsWith: options.userIdPrefix } } : {}),
    },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          role: true,
          status: true,
          deletedAt: true,
          dataClass: true,
        },
      },
    },
    orderBy: { id: "asc" },
    take: remaining + 1,
  });
  for (const subscription of subscriptions.slice(0, remaining)) {
    const sourceEventId = `backfill.main.subscription.${subscription.id}.activated.v2`;
    items.push({
      cursor: `subscription:${subscription.id}`,
      event: syntheticEvent({
        sourceEventId,
        eventType: METRIC_PRODUCT_EVENTS.subscriptionActivated,
        occurredAt: subscription.createdAt,
        classification: classifyExistingCustomerMetricActor(subscription.user),
        payload: {
          subscriptionId: subscription.id,
          userId: subscription.userId,
          planId: subscription.planId,
        },
      }),
    });
  }
  return { items, hasMore: subscriptions.length > remaining };
}

async function canonicalEventItems(
  db: PrismaClient,
  options: MetricBackfillOptions,
): Promise<{ items: BackfillItem[]; hasMore: boolean }> {
  const limit = Math.max(1, Math.min(options.batchSize, 1_000));
  const cursorId = options.cursor?.startsWith("event:") ? options.cursor.slice("event:".length) : "";
  const rows = await db.analyticsEvent.findMany({
    where: {
      id: { gt: cursorId },
      name: { in: SUPPORTED_EVENT_TYPES },
      sourceEventId: { not: null },
      trustClass: "canonical",
    },
    orderBy: { id: "asc" },
    take: limit + 1,
  });
  return {
    items: rows.slice(0, limit).map((row) => ({
      cursor: `event:${row.id}`,
      event: {
        ...row,
        sourceEventId: row.sourceEventId as string,
        occurredAt: row.occurredAt ?? row.createdAt,
        actor: row.actor,
        context: row.context,
        props: row.props,
      },
    })),
    hasMore: rows.length > limit,
  };
}

async function factCounts(db: PrismaClient, userIdPrefix?: string) {
  const where = userIdPrefix ? { userId: { startsWith: userIdPrefix } } : {};
  const [signups, exchanges, generations, subscriptions] = await Promise.all([
    db.customerSignupFact.count({ where }),
    db.chatExchangeFact.count({ where }),
    db.generationFulfillmentFact.count({ where }),
    db.subscriptionLifecycleFact.count({ where }),
  ]);
  return { signups, exchanges, generations, subscriptions };
}

export async function backfillCanonicalMetricFacts(
  db: PrismaClient,
  options: MetricBackfillOptions,
): Promise<MetricBackfillReport> {
  const before = await factCounts(db, options.userIdPrefix);
  const batch = options.sourceKind === "canonical_events"
    ? await canonicalEventItems(db, options)
    : await mainAuthorityItems(db, options);
  const validFrom = batch.items.reduce<Date | null>(
    (earliest, item) => earliest === null || item.event.occurredAt < earliest ? item.event.occurredAt : earliest,
    null,
  );
  const run = await db.metricBackfillRun.create({
    data: {
      source: options.source,
      status: "running",
      dryRun: options.dryRun,
      cursor: options.cursor,
      batchSize: options.batchSize,
      validFrom,
      beforeSnapshot: toInputJson(before),
      afterSnapshot: toInputJson(before),
      mismatchReport: [],
    },
  });
  let appliedCount = 0;
  let duplicateCount = 0;
  let skippedCount = 0;
  const mismatches: Array<Readonly<Record<string, unknown>>> = [];
  if (!options.dryRun) {
    for (const item of batch.items) {
      try {
        const result = await projectCanonicalMetricEvent(db, item.event);
        if (result.status === "applied") appliedCount += 1;
        else if (result.status === "duplicate") duplicateCount += 1;
        else skippedCount += 1;
      } catch (error) {
        mismatches.push({
          cursor: item.cursor,
          sourceEventId: item.event.sourceEventId,
          message: error instanceof Error ? error.message : "unknown backfill failure",
        });
      }
    }
  }
  const after = await factCounts(db, options.userIdPrefix);
  const status = batch.hasMore ? "paused" as const : "completed" as const;
  const nextCursor = batch.hasMore ? batch.items.at(-1)?.cursor ?? options.cursor ?? null : null;
  const eligibleCount = batch.items.filter((item) => item.event.dataClass === "customer" && record(item.event.actor).isInternal !== true).length;
  const coverage = eligibleCount === 0 ? 1 : (options.dryRun ? eligibleCount : appliedCount + duplicateCount) / eligibleCount;
  await db.metricBackfillRun.update({
    where: { id: run.id },
    data: {
      status,
      cursor: nextCursor,
      scannedCount: batch.items.length,
      appliedCount,
      skippedCount,
      mismatchCount: mismatches.length,
      coverage,
      afterSnapshot: toInputJson(after),
      mismatchReport: toInputJson(mismatches),
      completedAt: status === "completed" ? new Date() : null,
    },
  });
  return {
    runId: run.id,
    status,
    dryRun: options.dryRun,
    scannedCount: batch.items.length,
    wouldApplyCount: eligibleCount,
    appliedCount,
    duplicateCount,
    skippedCount,
    mismatchCount: mismatches.length,
    nextCursor,
    validFrom: validFrom?.toISOString() ?? null,
    coverage,
    before,
    after,
    mismatches,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
