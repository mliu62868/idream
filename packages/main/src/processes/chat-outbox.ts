import { Prisma, type PrismaClient } from "@prisma/client";
import {
  durableAckSchema,
  durableEventEnvelopeSchema,
  MAIN_TO_CHAT_EVENTS,
  type DurableEventEnvelope,
} from "@idream/shared/contracts";
import { setGauge } from "@idream/shared";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";

type Db = PrismaClient | Prisma.TransactionClient;
export type MainToChatEventType =
  (typeof MAIN_TO_CHAT_EVENTS)[keyof typeof MAIN_TO_CHAT_EVENTS];

export async function recordMainToChatEvent(input: {
  eventId: string;
  eventType: MainToChatEventType;
  schemaVersion?: number;
  aggregateType?: string;
  aggregateId?: string;
  payload: Record<string, unknown>;
}, db: Db = prisma): Promise<void> {
  const envelope = durableEventEnvelopeSchema.parse({
    sourceService: "main",
    sourceEventId: input.eventId,
    eventType: input.eventType,
    schemaVersion: input.schemaVersion ?? 1,
    occurredAt: new Date().toISOString(),
    aggregateType: input.aggregateType ?? "chat_effect",
    aggregateId: input.aggregateId ?? input.eventId,
    payload: input.payload,
  });
  await db.mainOutboxEvent.upsert({
    where: { id: input.eventId },
    create: {
      id: input.eventId,
      eventType: input.eventType,
      aggregateType: envelope.aggregateType,
      aggregateId: envelope.aggregateId,
      payload: toInputJson(envelope),
    },
    update: {},
  });
}

export async function dispatchPendingChatEvents(
  batch = 100,
  deliver: (event: DurableEventEnvelope) => Promise<void> = deliverToChat,
): Promise<{ delivered: number; failed: number }> {
  const now = new Date();
  const eventTypes = Object.values(MAIN_TO_CHAT_EVENTS);
  const [oldestPending, rows] = await Promise.all([
    prisma.mainOutboxEvent.findFirst({
      where: { status: "pending", eventType: { in: eventTypes } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    prisma.mainOutboxEvent.findMany({
      where: {
        status: "pending",
        nextRunAt: { lte: now },
        eventType: { in: eventTypes },
      },
      orderBy: { createdAt: "asc" },
      take: batch,
    }),
  ]);
  setGauge(
    "main_outbox_pending_age_seconds",
    "Age of the oldest pending Main outbox event",
    { queue: "chat" },
    oldestPending ? Math.max(0, now.getTime() - oldestPending.createdAt.getTime()) / 1_000 : 0,
  );
  let delivered = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await deliver(durableEventEnvelopeSchema.parse(row.payload));
    } catch (error) {
      const attempts = row.attempts + 1;
      // INVARIANT: a stale failure may only advance the exact pending attempt
      // it observed; it must never overwrite a durable ACK or a newer retry.
      const transition = await prisma.mainOutboxEvent.updateMany({
        where: { id: row.id, status: "pending", attempts: row.attempts },
        data: {
          attempts,
          status: attempts >= 8 ? "failed" : "pending",
          nextRunAt: new Date(Date.now() + attempts * 30_000),
          lastError: toInputJson({ message: error instanceof Error ? error.message : "chat delivery failed" }),
        },
      });
      failed += transition.count;
      continue;
    }

    // INTENT: receiver durable ACK is stronger evidence than local retry
    // exhaustion. It may repair a concurrent failed write and is never
    // followed by the failure path if this local persistence step errors.
    const transition = await prisma.mainOutboxEvent.updateMany({
      where: { id: row.id, status: { in: ["pending", "failed"] } },
      data: { status: "delivered", deliveredAt: new Date(), lastError: Prisma.DbNull },
    });
    delivered += transition.count;
  }
  return { delivered, failed };
}

export function resolveChatDurableIngestUrl(chatServiceUrl: string | undefined): string {
  if (!chatServiceUrl?.trim()) {
    throw new Error("CHAT_SERVICE_URL is required for Main to Chat durable delivery");
  }
  return `${chatServiceUrl.replace(/\/$/, "")}/internal/events/ingest`;
}

async function deliverToChat(event: DurableEventEnvelope): Promise<void> {
  const response = await fetch(resolveChatDurableIngestUrl(env.CHAT_SERVICE_URL), {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": env.INTERNAL_TOKEN },
    body: JSON.stringify(event),
  });
  if (!response.ok) throw new Error(`chat durable ingest returned ${response.status}`);
  const ack = durableAckSchema.parse(await response.json());
  if (!ack.acknowledged) throw new Error(`chat did not durably acknowledge ${event.sourceEventId}`);
}
