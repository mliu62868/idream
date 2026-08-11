// SPEC: Transactional outbox (chat → main, design §4/§6). Effects are written to
// chat.chat_outbox_events INSIDE the finalize TX, then delivered async by
// chat.outbox.deliver → Main HTTP durable ingest. Guards "committed but never published".
// INVARIANTS: delivery is at-least-once; main consumer dedupes on eventId.
import type { Prisma } from "../generated/client/client.js";
import type { ChatPrismaClient } from "./db.js";
import { chatPrisma } from "./db.js";
import { createId } from "./id.js";
import { enqueue } from "./queue.js";
import {
  CHAT_QUEUES,
  CHAT_TO_MAIN_EVENTS,
  durableAckSchema,
  type DurableEventEnvelope,
} from "@idream/shared/contracts";
import { env } from "./env.js";

export type ChatToMainEventType =
  (typeof CHAT_TO_MAIN_EVENTS)[keyof typeof CHAT_TO_MAIN_EVENTS];

export interface OutboxRecord {
  eventType: ChatToMainEventType;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  schemaVersion?: number;
}

/** Insert an outbox row within an existing transaction (atomic with the effect). */
export async function recordOutbox(
  tx: Prisma.TransactionClient,
  record: OutboxRecord,
): Promise<string> {
  const id = createId("evt");
  await tx.chatOutboxEvent.create({
    data: {
      id,
      eventType: record.eventType,
      aggregateType: record.aggregateType,
      aggregateId: record.aggregateId,
      payload: record.payload as Prisma.InputJsonValue,
      schemaVersion: record.schemaVersion ?? 1,
    },
  });
  return id;
}

/** Kick the deliver queue (best-effort; reconcile also sweeps pending). */
export async function scheduleOutboxDelivery(
  schedule: typeof enqueue = enqueue,
): Promise<void> {
  // Do not use a fixed deterministic job id here. Completed BullMQ jobs are
  // retained for observability, so reusing one suppresses every later wake-up
  // until retention expires. Delivery itself is idempotent at the event id.
  await schedule({ queue: CHAT_QUEUES.outboxDeliver, payload: {} });
}

/**
 * chat.outbox.deliver handler: read pending rows, send them to Main durable ingest,
 * then converge each row monotonically. Bounded batch; failures bump attempts +
 * backoff via next_run_at.
 */
export async function deliverPendingOutbox(
  prisma: ChatPrismaClient = chatPrisma,
  batch = 100,
  acknowledge: (event: DurableEventEnvelope) => Promise<void> = acknowledgeWithMain,
): Promise<{ delivered: number; failed: number }> {
  const now = new Date();
  const pending = await prisma.chatOutboxEvent.findMany({
    where: { status: "pending", nextRunAt: { lte: now } },
    orderBy: { createdAt: "asc" },
    take: batch,
  });

  let delivered = 0;
  let failed = 0;
  for (const row of pending) {
    try {
      await acknowledge({
        sourceService: "chat",
        sourceEventId: row.id,
        eventType: row.eventType,
        schemaVersion: row.schemaVersion,
        aggregateType: row.aggregateType,
        aggregateId: row.aggregateId,
        occurredAt: row.createdAt.toISOString(),
        payload: row.payload as Record<string, unknown>,
      });
    } catch {
      const attempts = row.attempts + 1;
      // INVARIANT: a stale failure may only advance the exact pending attempt
      // it observed; it must never overwrite a durable ACK or a newer retry.
      const transition = await prisma.chatOutboxEvent.updateMany({
        where: { id: row.id, status: "pending", attempts: row.attempts },
        data: {
          attempts,
          // exponential-ish backoff: 30s * attempts
          nextRunAt: new Date(Date.now() + 30_000 * attempts),
          status: attempts >= 8 ? "failed" : "pending",
        },
      });
      failed += transition.count;
      continue;
    }

    // INTENT: receiver durable ACK is stronger evidence than local retry
    // exhaustion. It may repair a concurrent failed write and is never
    // followed by the failure path if this local persistence step errors.
    const transition = await prisma.chatOutboxEvent.updateMany({
      where: { id: row.id, status: { in: ["pending", "failed"] } },
      data: { status: "delivered", deliveredAt: new Date() },
    });
    delivered += transition.count;
  }
  return { delivered, failed };
}

async function acknowledgeWithMain(event: DurableEventEnvelope): Promise<void> {
  const response = await fetch(env.MAIN_INTERNAL_INGEST_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": env.INTERNAL_TOKEN,
    },
    body: JSON.stringify(event),
  });
  if (!response.ok) throw new Error(`main durable ingest returned ${response.status}`);
  const ack = durableAckSchema.parse(await response.json());
  if (!ack.acknowledged) throw new Error(`main did not durably acknowledge ${event.sourceEventId}`);
}
