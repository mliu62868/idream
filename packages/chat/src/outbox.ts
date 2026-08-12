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
  chatAccountErasureCompletedV2PayloadSchema,
  durableAckSchema,
  durableEventEnvelopeSchema,
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
  /** Dedicated request/response evidence that generic dispatchers must ignore. */
  status?: "pending" | "request_bound";
}

export const REQUEST_BOUND_OUTBOX_STATUS = "request_bound" as const;

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
      status: record.status ?? "pending",
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
    where: {
      status: "pending",
      eventType: { not: CHAT_TO_MAIN_EVENTS.accountErasureCompletedV2 },
      nextRunAt: { lte: now },
    },
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

/**
 * Deliver the exact request-bound account-erasure completion to Main.
 *
 * INTENT: this bypasses the generic Chat outbox dispatcher. The receiver must
 * finish its AccountDeletion projection before this function persists a local
 * ACK; callers may only ACK the original Main request after this returns.
 */
export async function deliverRequestBoundAccountErasureCompletion(
  deletionRequestEventId: string,
  prisma: ChatPrismaClient = chatPrisma,
  acknowledge: (event: DurableEventEnvelope) => Promise<void> =
    acknowledgeAccountErasureCompletionWithMain,
): Promise<{ eventId: string; delivered: true }> {
  const row = await prisma.chatOutboxEvent.findFirst({
    where: {
      eventType: CHAT_TO_MAIN_EVENTS.accountErasureCompletedV2,
      schemaVersion: 2,
      payload: {
        path: ["deletionRequestEventId"],
        equals: deletionRequestEventId,
      },
    },
    orderBy: { createdAt: "asc" },
  });
  if (!row) {
    throw new Error(
      `request-bound account erasure completion is missing for ${deletionRequestEventId}`,
    );
  }
  if (
    row.status !== REQUEST_BOUND_OUTBOX_STATUS &&
    row.status !== "delivered"
  ) {
    throw new Error(
      `account erasure completion ${row.id} has unsafe status ${row.status}`,
    );
  }
  const payload = chatAccountErasureCompletedV2PayloadSchema.parse(row.payload);
  if (
    row.aggregateType !== "user" ||
    row.aggregateId !== payload.userId ||
    payload.deletionRequestEventId !== deletionRequestEventId
  ) {
    throw new Error(`account erasure completion ${row.id} changed authority`);
  }
  const envelope = durableEventEnvelopeSchema.parse({
    sourceService: "chat",
    sourceEventId: row.id,
    eventType: row.eventType,
    schemaVersion: row.schemaVersion,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    occurredAt: row.createdAt.toISOString(),
    payload,
  });

  try {
    // Always redeliver, including after a local delivered marker. This repairs
    // the window where a rolled-back Main binary ACKed a generic no-op before
    // the dedicated receipt namespace existed.
    await acknowledge(envelope);
  } catch (error) {
    if (row.status === REQUEST_BOUND_OUTBOX_STATUS) {
      const attempts = row.attempts + 1;
      await prisma.chatOutboxEvent.updateMany({
        where: {
          id: row.id,
          status: REQUEST_BOUND_OUTBOX_STATUS,
          attempts: row.attempts,
        },
        data: {
          attempts,
          nextRunAt: new Date(
            Date.now() + Math.min(attempts, 120) * 30_000,
          ),
        },
      }).catch(() => undefined);
    }
    throw error;
  }

  if (row.status === REQUEST_BOUND_OUTBOX_STATUS) {
    const transition = await prisma.chatOutboxEvent.updateMany({
      where: { id: row.id, status: REQUEST_BOUND_OUTBOX_STATUS },
      data: { status: "delivered", deliveredAt: new Date() },
    });
    if (transition.count !== 1) {
      const current = await prisma.chatOutboxEvent.findUnique({
        where: { id: row.id },
        select: { status: true },
      });
      if (current?.status !== "delivered") {
        throw new Error(
          `account erasure completion ${row.id} ACK was not persisted`,
        );
      }
    }
  }
  return { eventId: row.id, delivered: true };
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

async function acknowledgeAccountErasureCompletionWithMain(
  event: DurableEventEnvelope,
): Promise<void> {
  const response = await fetch(env.MAIN_ACCOUNT_ERASURE_COMPLETION_V2_INGEST_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": env.INTERNAL_TOKEN,
    },
    body: JSON.stringify(event),
  });
  if (!response.ok) {
    throw new Error(
      `main account erasure completion ingest returned ${response.status}`,
    );
  }
  const ack = durableAckSchema.parse(await response.json());
  if (!ack.acknowledged || ack.receiptId !== event.sourceEventId) {
    throw new Error(
      `main did not project account erasure completion ${event.sourceEventId}`,
    );
  }
}
