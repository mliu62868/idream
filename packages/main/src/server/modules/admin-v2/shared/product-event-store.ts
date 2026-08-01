import { Prisma, type PrismaClient } from "@prisma/client";
import { incrementCounter, observeHistogram } from "@idream/shared";
import { canonicalSha256 } from "./canonical-json";
import { toInputJson } from "./prisma-json";

export interface ProductEventInput {
  readonly sourceService: string;
  readonly sourceEventId: string;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly occurredAt: Date;
  readonly environment: string;
  readonly dataClass: string;
  readonly trustClass: string;
  readonly actor: Readonly<Record<string, unknown>>;
  readonly context: Readonly<Record<string, unknown>>;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Cross-service ingress supplies the shared envelope hash; local writers omit it. */
  readonly canonicalHash?: string;
}

export type ProductEventIngestResult =
  | { readonly status: "persisted"; readonly eventId: string }
  | { readonly status: "duplicate"; readonly eventId: string }
  | { readonly status: "quarantined"; readonly eventId: string | null };

function payloadHash(input: ProductEventInput): string {
  return input.canonicalHash ?? canonicalSha256({
    eventType: input.eventType,
    schemaVersion: input.schemaVersion,
    occurredAt: input.occurredAt,
    environment: input.environment,
    dataClass: input.dataClass,
    trustClass: input.trustClass,
    actor: input.actor,
    context: input.context,
    payload: input.payload,
  });
}

async function ingestTransaction(
  db: PrismaClient,
  input: ProductEventInput,
  hash: string,
): Promise<ProductEventIngestResult> {
  return db.$transaction(async (tx) => {
    const where = {
      sourceService_sourceEventId: {
        sourceService: input.sourceService,
        sourceEventId: input.sourceEventId,
      },
    } as const;
    const existing = await tx.inboundEventReceipt.findUnique({ where });
    if (existing) {
      const canonical = await tx.analyticsEvent.findUnique({ where });
      // INVARIANT: quarantine is sticky until an explicit reconciliation owns
      // the decision. An original-payload replay cannot silently restore ACK.
      if (existing.processingState === "quarantined") {
        return { status: "quarantined", eventId: canonical?.id ?? null };
      }
      if (existing.payloadHash === hash) {
        return { status: "duplicate", eventId: canonical?.id ?? existing.id };
      }
      await tx.inboundEventReceipt.update({
        where,
        data: {
          processingState: "quarantined",
          quarantinedAt: new Date(),
          error: toInputJson({
            code: "payload_hash_conflict",
            expectedHash: existing.payloadHash,
            receivedHash: hash,
          }),
        },
      });
      return { status: "quarantined", eventId: canonical?.id ?? null };
    }

    await tx.inboundEventReceipt.create({
      data: {
        sourceService: input.sourceService,
        sourceEventId: input.sourceEventId,
        payloadHash: hash,
        processingState: "processed",
        processedAt: new Date(),
      },
    });
    const canonical = await tx.analyticsEvent.create({
      data: {
        name: input.eventType,
        props: toInputJson(input.payload),
        sourceService: input.sourceService,
        sourceEventId: input.sourceEventId,
        payloadHash: hash,
        schemaVersion: input.schemaVersion,
        occurredAt: input.occurredAt,
        environment: input.environment,
        dataClass: input.dataClass,
        trustClass: input.trustClass,
        actor: toInputJson(input.actor),
        context: toInputJson(input.context),
      },
    });
    await tx.mainOutboxEvent.create({
      data: {
        eventType: "product.event.persisted.v2",
        aggregateType: "product_event",
        aggregateId: canonical.id,
        payload: toInputJson({
          eventId: canonical.id,
          sourceService: input.sourceService,
          sourceEventId: input.sourceEventId,
          eventType: input.eventType,
          schemaVersion: input.schemaVersion,
        }),
      },
    });
    return { status: "persisted", eventId: canonical.id };
  });
}

export async function ingestProductEvent(
  db: PrismaClient,
  input: ProductEventInput,
): Promise<ProductEventIngestResult> {
  const startedAt = performance.now();
  let outcome = "error";
  const hash = payloadHash(input);
  try {
    const result = await ingestTransaction(db, input, hash);
    outcome = result.status;
    return result;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const result = await ingestTransaction(db, input, hash);
      outcome = result.status;
      return result;
    }
    throw error;
  } finally {
    const labels = { source: input.sourceService, outcome };
    incrementCounter("main_inbound_events_total", "Durable inbound product events by outcome", labels);
    observeHistogram(
      "main_inbound_event_lag_seconds",
      "Source occurrence to main durable ingest lag in seconds",
      { source: input.sourceService },
      Math.max(0, Date.now() - input.occurredAt.getTime()) / 1_000,
      [1, 5, 15, 30, 60, 120, 300, 900],
    );
    observeHistogram(
      "durable_ingest_ack_latency_seconds",
      "Durable ingest acknowledgement latency in seconds",
      { source: input.sourceService, target: "main" },
      Math.max(0, performance.now() - startedAt) / 1_000,
    );
  }
}
