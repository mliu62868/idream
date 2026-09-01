import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  ACCOUNT_DELETION_V2_INGEST_PATH,
  agentRunCancelRequestedV1PayloadSchema,
  durableAckSchema,
  durableEventEnvelopeSchema,
  MAIN_TO_CHAT_EVENTS,
  type DurableEventEnvelope,
} from "@idream/shared/contracts";
import { setGauge } from "@idream/shared";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import {
  purgeCompanionMemoryFromMain,
  syncCompanionMemoryFromMain,
} from "@/server/modules/chat/companion-memory-authority";

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
  occurredAt?: Date;
  /** Keep the durable intent pending until this product-authoritative due time. */
  deliverAfter?: Date;
}, db: Db = prisma): Promise<void> {
  const envelope = durableEventEnvelopeSchema.parse({
    sourceService: "main",
    sourceEventId: input.eventId,
    eventType: input.eventType,
    schemaVersion: input.schemaVersion ?? 1,
    occurredAt: (input.occurredAt ?? new Date()).toISOString(),
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
      ...(input.deliverAfter ? { nextRunAt: input.deliverAfter } : {}),
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
  const due = {
    OR: [
      { status: "pending", nextRunAt: { lte: now } },
      { status: "processing", leaseExpiresAt: { lte: now } },
    ],
    eventType: { in: eventTypes },
  } satisfies Prisma.MainOutboxEventWhereInput;
  const [oldestPending, rows] = await Promise.all([
    prisma.mainOutboxEvent.findFirst({
      where: due,
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    prisma.mainOutboxEvent.findMany({
      where: due,
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
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(Date.now() + 30_000);
    const claimed = await prisma.mainOutboxEvent.updateMany({
      where: {
        id: row.id,
        attempts: row.attempts,
        OR: [
          { status: "pending", nextRunAt: { lte: now } },
          { status: "processing", leaseExpiresAt: { lte: now } },
        ],
      },
      data: {
        status: "processing",
        attempts: { increment: 1 },
        leaseToken,
        leaseExpiresAt,
      },
    });
    if (claimed.count !== 1) continue;
    const attempts = row.attempts + 1;
    const heartbeat = setInterval(() => {
      void prisma.mainOutboxEvent.updateMany({
        where: { id: row.id, status: "processing", leaseToken },
        data: { leaseExpiresAt: new Date(Date.now() + 30_000) },
      }).catch(() => undefined);
    }, 10_000);
    let deliveryError: unknown;
    let deliveryFailed = false;
    try {
      await deliver(durableEventEnvelopeSchema.parse(row.payload));
    } catch (error) {
      deliveryFailed = true;
      deliveryError = error;
    } finally {
      clearInterval(heartbeat);
    }
    if (deliveryFailed) {
      // INVARIANT: a stale failure may only advance the exact pending attempt
      // it observed; it must never overwrite a durable ACK or a newer retry.
      // Chat lifecycle events never enter an unrecoverable transport
      // tombstone: local erasure/rebuild must converge before new work resumes.
      const transition = await prisma.mainOutboxEvent.updateMany({
        where: { id: row.id, status: "processing", leaseToken, attempts },
        data: {
          // Local-file cleanup and relationship rebuild stay retryable until
          // the target capability has actually converged.
          status: "pending",
          nextRunAt: new Date(
            Date.now() + Math.min(attempts, 120) * 30_000,
          ),
          lastError: toInputJson({
            message: deliveryError instanceof Error
              ? deliveryError.message
              : "chat delivery failed",
          }),
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      failed += transition.count;
      continue;
    }

    // Receiver ACK can complete only the exact live lease. An expired owner can
    // neither deliver nor regress the row after another reconciler reclaims it.
    const transition = await prisma.mainOutboxEvent.updateMany({
      where: { id: row.id, status: "processing", leaseToken, attempts },
      data: {
        status: "delivered",
        deliveredAt: new Date(),
        lastError: Prisma.DbNull,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    delivered += transition.count;
  }
  return { delivered, failed };
}

export function resolveChatDurableIngestUrl(
  chatServiceUrl: string | undefined,
  eventType?: MainToChatEventType,
): string {
  if (!chatServiceUrl?.trim()) {
    throw new Error("CHAT_SERVICE_URL is required for Main to Chat durable delivery");
  }
  if (eventType && eventType !== MAIN_TO_CHAT_EVENTS.accountDeletionRequestedV2) {
    throw new Error("only account deletion is a Main to Chat durable event");
  }
  return `${chatServiceUrl.replace(/\/$/, "")}${ACCOUNT_DELETION_V2_INGEST_PATH}`;
}

async function deliverToChat(event: DurableEventEnvelope): Promise<void> {
  if (event.eventType === MAIN_TO_CHAT_EVENTS.agentRunCancelRequestedV1) {
    const payload = agentRunCancelRequestedV1PayloadSchema.parse(event.payload);
    const base = env.CHAT_SERVICE_URL?.trim();
    if (!base) throw new Error("CHAT_SERVICE_URL is required for AgentRun cancellation");
    const response = await fetch(
      `${base.replace(/\/$/, "")}/internal/agent-runs/${encodeURIComponent(payload.turnId)}/${payload.attempt}/cancel`,
      { method: "POST", headers: { "x-internal-token": env.INTERNAL_TOKEN } },
    );
    if (!response.ok) throw new Error(`Chat AgentRun cancel returned ${response.status}`);
    const acknowledged = await response.json() as { ok?: unknown };
    if (acknowledged.ok !== true) throw new Error("Chat did not durably fence the AgentRun");
    return;
  }
  if (
    event.eventType === MAIN_TO_CHAT_EVENTS.companionMemoryRebuildRequestedV1
    || event.eventType === MAIN_TO_CHAT_EVENTS.companionMemoryProjectRequestedV1
  ) {
    await syncCompanionMemoryFromMain(event);
    return;
  }
  if (event.eventType === MAIN_TO_CHAT_EVENTS.companionMemoryPurgeRequestedV1) {
    await purgeCompanionMemoryFromMain(event);
    return;
  }
  const response = await fetch(resolveChatDurableIngestUrl(
    env.CHAT_SERVICE_URL,
    event.eventType as MainToChatEventType,
  ), {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": env.INTERNAL_TOKEN },
    body: JSON.stringify(event),
  });
  if (!response.ok) throw new Error(`chat durable ingest returned ${response.status}`);
  const ack = durableAckSchema.parse(await response.json());
  if (!ack.acknowledged) throw new Error(`chat did not durably acknowledge ${event.sourceEventId}`);
}
