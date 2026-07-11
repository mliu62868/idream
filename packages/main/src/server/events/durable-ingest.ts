import { durableEventEnvelopeSchema } from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { ingestProductEvent } from "@/server/modules/admin-v2/shared/product-event-store";
import { classifyCustomerMetricActor } from "@/server/modules/admin-v2/metrics/event-classification";

export async function ingestDurableServiceEvent(raw: unknown) {
  const event = durableEventEnvelopeSchema.parse(raw);
  const userId = typeof event.payload.userId === "string" ? event.payload.userId : null;
  const classification = await classifyCustomerMetricActor(prisma, userId);
  const result = await ingestProductEvent(prisma, {
    sourceService: event.sourceService,
    sourceEventId: event.sourceEventId,
    eventType: event.eventType,
    schemaVersion: event.schemaVersion,
    occurredAt: new Date(event.occurredAt),
    environment: env.APP_ENV,
    dataClass: classification.dataClass,
    trustClass: "canonical",
    actor: { ...classification.actor, service: event.sourceService },
    context: { aggregateType: event.aggregateType, aggregateId: event.aggregateId },
    payload: event.payload,
  });
  return {
    acknowledged: result.status !== "quarantined",
    status: result.status,
    receiptId: result.eventId,
  };
}
