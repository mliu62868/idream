import { durableEventEnvelopeSchema } from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { ingestProductEvent } from "@/server/modules/admin-v2/shared/product-event-store";

export async function ingestDurableServiceEvent(raw: unknown) {
  const event = durableEventEnvelopeSchema.parse(raw);
  const result = await ingestProductEvent(prisma, {
    sourceService: event.sourceService,
    sourceEventId: event.sourceEventId,
    eventType: event.eventType,
    schemaVersion: event.schemaVersion,
    occurredAt: new Date(event.occurredAt),
    environment: env.APP_ENV,
    dataClass: "operational",
    trustClass: "canonical",
    actor: { type: "service", service: event.sourceService },
    context: { aggregateType: event.aggregateType, aggregateId: event.aggregateId },
    payload: event.payload,
  });
  return {
    acknowledged: result.status !== "quarantined",
    status: result.status,
    receiptId: result.eventId,
  };
}
