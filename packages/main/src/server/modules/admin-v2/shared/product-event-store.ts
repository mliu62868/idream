import { Prisma, type PrismaClient } from "@prisma/client";
import { canonicalSha256 } from "./canonical-json";

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
}

export type ProductEventIngestResult =
  | { readonly status: "persisted"; readonly eventId: string }
  | { readonly status: "duplicate"; readonly eventId: string }
  | { readonly status: "quarantined"; readonly eventId: string | null };

function inputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function payloadHash(input: ProductEventInput): string {
  return canonicalSha256({
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
      if (existing.payloadHash === hash) {
        return { status: "duplicate", eventId: canonical?.id ?? existing.id };
      }
      await tx.inboundEventReceipt.update({
        where,
        data: {
          processingState: "quarantined",
          quarantinedAt: new Date(),
          error: inputJson({
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
        props: inputJson(input.payload),
        sourceService: input.sourceService,
        sourceEventId: input.sourceEventId,
        payloadHash: hash,
        schemaVersion: input.schemaVersion,
        occurredAt: input.occurredAt,
        environment: input.environment,
        dataClass: input.dataClass,
        trustClass: input.trustClass,
        actor: inputJson(input.actor),
        context: inputJson(input.context),
      },
    });
    await tx.mainOutboxEvent.create({
      data: {
        eventType: "product.event.persisted.v2",
        aggregateType: "product_event",
        aggregateId: canonical.id,
        payload: inputJson({
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
  const hash = payloadHash(input);
  try {
    return await ingestTransaction(db, input, hash);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return ingestTransaction(db, input, hash);
    }
    throw error;
  }
}
