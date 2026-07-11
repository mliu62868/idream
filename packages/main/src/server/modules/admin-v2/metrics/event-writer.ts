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
