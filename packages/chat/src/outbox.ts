// SPEC: Transactional outbox (chat → main, design §4/§6). Effects are written to
// chat.chat_outbox_events INSIDE the finalize TX, then delivered async by
// chat.outbox.deliver → main.inbound. Guards "committed but never published".
// INVARIANTS: delivery is at-least-once; main consumer dedupes on eventId.
import type { Prisma } from "../generated/client/client.js";
import type { ChatPrismaClient } from "./db.js";
import { chatPrisma } from "./db.js";
import { createId } from "./id.js";
import { enqueue } from "./queue.js";
import { CHAT_QUEUES, MAIN_QUEUES, idempotencyKeys, CHAT_TO_MAIN_EVENTS } from "@idream/shared/contracts";

export type ChatToMainEventType =
  (typeof CHAT_TO_MAIN_EVENTS)[keyof typeof CHAT_TO_MAIN_EVENTS];

export interface OutboxRecord {
  eventType: ChatToMainEventType;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
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
    },
  });
  return id;
}

/** Kick the deliver queue (best-effort; reconcile also sweeps pending). */
export async function scheduleOutboxDelivery(): Promise<void> {
  await enqueue({ queue: CHAT_QUEUES.outboxDeliver, payload: {}, dedupeKey: "chat-outbox-deliver-tick" });
}

/**
 * chat.outbox.deliver handler: claim pending rows, fan them out to main.inbound,
 * mark delivered. Bounded batch; failures bump attempts + backoff via next_run_at.
 */
export async function deliverPendingOutbox(
  prisma: ChatPrismaClient = chatPrisma,
  batch = 100,
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
      await enqueue({
        queue: MAIN_QUEUES.mainInbound,
        payload: {
          eventId: row.id,
          eventType: row.eventType,
          aggregateType: row.aggregateType,
          aggregateId: row.aggregateId,
          occurredAt: row.createdAt.toISOString(),
          payload: row.payload,
        },
        dedupeKey: idempotencyKeys.chatOutbox(row.id),
      });
      await prisma.chatOutboxEvent.update({
        where: { id: row.id },
        data: { status: "delivered", deliveredAt: new Date() },
      });
      delivered += 1;
    } catch {
      const attempts = row.attempts + 1;
      await prisma.chatOutboxEvent.update({
        where: { id: row.id },
        data: {
          attempts,
          // exponential-ish backoff: 30s * attempts
          nextRunAt: new Date(Date.now() + 30_000 * attempts),
          status: attempts >= 8 ? "failed" : "pending",
        },
      });
      failed += 1;
    }
  }
  return { delivered, failed };
}
