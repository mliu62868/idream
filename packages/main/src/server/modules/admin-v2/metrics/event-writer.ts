import type { Prisma } from "@prisma/client";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { canonicalSha256 } from "../shared/canonical-json";
import { toInputJson } from "../shared/prisma-json";
import { classifyMetricSubject } from "./event-classification";

export async function appendCanonicalMetricEvent(
  tx: Prisma.TransactionClient,
  input: {
    readonly sourceEventId: string;
    readonly eventType: string;
    readonly occurredAt: Date;
    readonly userId: string | null;
    readonly anonymousId?: string | null;
    readonly trustClass?: "canonical" | "typed_client";
    readonly context?: Readonly<Record<string, unknown>>;
    readonly payload: Readonly<Record<string, unknown>>;
  },
) {
  const classification = await classifyMetricSubject(tx, {
    userId: input.userId,
    anonymousId: input.anonymousId ?? null,
  });
  const context = input.context ?? {};
  const trustClass = input.trustClass ?? "canonical";
  const hashAt = (occurredAt: Date) => canonicalSha256({
    eventType: input.eventType,
    schemaVersion: 2,
    occurredAt,
    environment: env.APP_ENV,
    dataClass: classification.dataClass,
    trustClass,
    actor: classification.actor,
    context,
    payload: input.payload,
  });
  const hash = hashAt(input.occurredAt);
  const existing = await tx.analyticsEvent.findUnique({
    where: { sourceService_sourceEventId: { sourceService: "main", sourceEventId: input.sourceEventId } },
  });
  if (
    existing?.payloadHash &&
    existing.payloadHash !== hashAt(existing.occurredAt ?? input.occurredAt)
  ) {
    throw Errors.conflict("Canonical metric event id was reused with different content", {
      sourceEventId: input.sourceEventId,
    });
  }
  const event = await tx.analyticsEvent.upsert({
    where: { sourceService_sourceEventId: { sourceService: "main", sourceEventId: input.sourceEventId } },
    create: {
      userId: input.userId,
      anonymousId: input.anonymousId ?? null,
      name: input.eventType,
      props: toInputJson(input.payload),
      sourceService: "main",
      sourceEventId: input.sourceEventId,
      payloadHash: hash,
      schemaVersion: 2,
      occurredAt: input.occurredAt,
      environment: env.APP_ENV,
      dataClass: classification.dataClass,
      trustClass,
      actor: toInputJson(classification.actor),
      context: toInputJson(context),
    },
    update: {},
  });
  if (
    event.payloadHash &&
    event.payloadHash !== hashAt(event.occurredAt ?? input.occurredAt)
  ) {
    throw Errors.conflict("Canonical metric event id was reused with different content", {
      sourceEventId: input.sourceEventId,
    });
  }
  await tx.mainOutboxEvent.upsert({
    where: { id: `product_metric_${input.sourceEventId.replaceAll(":", "_")}` },
    create: {
      id: `product_metric_${input.sourceEventId.replaceAll(":", "_")}`,
      eventType: "product.event.persisted.v2",
      aggregateType: "product_event",
      aggregateId: event.id,
      payload: toInputJson({
        eventId: event.id,
        sourceService: "main",
        sourceEventId: input.sourceEventId,
        eventType: input.eventType,
        schemaVersion: 2,
      }),
    },
    update: {},
  });
  return event;
}

/**
 * SPEC: {@link appendCanonicalMetricEvent} for many canonical events of one
 * user, in a fixed number of round trips whatever the count.
 * INTENT: deleting a chat session writes one correction per Turn inside a
 * transaction that holds the user's row lock. At four round trips per event a
 * thousand-Turn session ran past the 5s interactive-transaction timeout, so
 * the user could not delete the chat at all.
 * INVARIANT: same idempotency and same-id-different-content conflict as the
 * single writer; rows written by either writer are interchangeable.
 */
export async function appendCanonicalMetricEventsForUser(
  tx: Prisma.TransactionClient,
  userId: string,
  inputs: ReadonlyArray<{
    readonly sourceEventId: string;
    readonly eventType: string;
    readonly occurredAt: Date;
    readonly context?: Readonly<Record<string, unknown>>;
    readonly payload: Readonly<Record<string, unknown>>;
  }>,
) {
  if (inputs.length === 0) return;
  const classification = await classifyMetricSubject(tx, { userId, anonymousId: null });
  const hashAt = (input: (typeof inputs)[number], occurredAt: Date) => canonicalSha256({
    eventType: input.eventType,
    schemaVersion: 2,
    occurredAt,
    environment: env.APP_ENV,
    dataClass: classification.dataClass,
    trustClass: "canonical",
    actor: classification.actor,
    context: input.context ?? {},
    payload: input.payload,
  });
  const where = { sourceService: "main", sourceEventId: { in: inputs.map((input) => input.sourceEventId) } };
  const select = { id: true, sourceEventId: true, payloadHash: true, occurredAt: true } as const;
  const assertSameContent = (rows: Array<{ sourceEventId: string | null; payloadHash: string | null; occurredAt: Date | null }>) => {
    const bySourceEventId = new Map(inputs.map((input) => [input.sourceEventId, input]));
    for (const row of rows) {
      const input = row.sourceEventId ? bySourceEventId.get(row.sourceEventId) : undefined;
      if (input && row.payloadHash && row.payloadHash !== hashAt(input, row.occurredAt ?? input.occurredAt)) {
        throw Errors.conflict("Canonical metric event id was reused with different content", {
          sourceEventId: input.sourceEventId,
        });
      }
    }
  };
  const existing = await tx.analyticsEvent.findMany({ where, select });
  assertSameContent(existing);
  const present = new Set(existing.map((row) => row.sourceEventId));
  await tx.analyticsEvent.createMany({
    data: inputs.filter((input) => !present.has(input.sourceEventId)).map((input) => ({
      userId,
      anonymousId: null,
      name: input.eventType,
      props: toInputJson(input.payload),
      sourceService: "main",
      sourceEventId: input.sourceEventId,
      payloadHash: hashAt(input, input.occurredAt),
      schemaVersion: 2,
      occurredAt: input.occurredAt,
      environment: env.APP_ENV,
      dataClass: classification.dataClass,
      trustClass: "canonical",
      actor: toInputJson(classification.actor),
      context: toInputJson(input.context ?? {}),
    })),
    skipDuplicates: true,
  });
  // Re-read: a concurrent writer may have won a row between the read and the insert.
  const events = await tx.analyticsEvent.findMany({ where, select });
  assertSameContent(events);
  const eventTypeBySourceEventId = new Map(inputs.map((input) => [input.sourceEventId, input.eventType]));
  await tx.mainOutboxEvent.createMany({
    data: events.map((event) => ({
      id: `product_metric_${event.sourceEventId!.replaceAll(":", "_")}`,
      eventType: "product.event.persisted.v2",
      aggregateType: "product_event",
      aggregateId: event.id,
      payload: toInputJson({
        eventId: event.id,
        sourceService: "main",
        sourceEventId: event.sourceEventId,
        eventType: eventTypeBySourceEventId.get(event.sourceEventId!),
        schemaVersion: 2,
      }),
    })),
    skipDuplicates: true,
  });
}
