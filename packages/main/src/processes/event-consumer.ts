// SPEC: Main's receiver-local projector. Chat delivers by HTTP into a durable
// Product Event receipt; this process only applies already-persisted rows.
// INVARIANT: each origin service + source event has one durable projection
// receipt; its domain effect and processed receipt commit in the same DB TX.
import { Prisma } from "@prisma/client";
import { setGauge } from "@idream/shared";
import {
  CHAT_TO_MAIN_EVENTS,
  chatAccountErasureCompletedV2PayloadSchema,
} from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import { logger } from "@/server/lib/logger";
import { dispatchPendingChatEvents } from "./chat-outbox";
import { projectCanonicalMetricEvent } from "@/server/modules/admin-v2/metrics/projector";
import { startMetricSnapshotRefresh } from "@/server/modules/admin-v2/metrics/refresh";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import {
  acceptChatAccountErasureCompletion,
  dispatchPendingAccountDeletionBlobDeletes,
} from "@/server/account-deletion-authority";
import { isProcessEntrypoint } from "./process-entrypoint";
import { dispatchPendingChatAgentRuns } from "@/server/modules/chat/agent-run-admission";

interface InboundEvent {
  eventId: string;
  eventType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  occurredAt?: string;
  schemaVersion?: number;
  sourceService?: string;
}
type ChatEventEffectResult = { readonly status: "applied" };

export type ChatEventApplyResult =
  | ChatEventEffectResult
  | {
      readonly status: "duplicate";
      readonly outcome: "applied";
    }
  | {
      readonly status: "quarantined";
      readonly reason: "payload_hash_conflict" | "source_event_quarantined";
    };

export interface ChatEventApplyHooks {
  readonly afterEffect?: (sourceEventId: string) => Promise<void> | void;
}

const CHAT_EVENT_APPLIED = { status: "applied" } as const;
const CHAT_PROJECTION_RECEIPT_NAMESPACE = "main.product_projection";
export const ACCOUNT_ERASURE_COMPLETION_V2_SOURCE_SERVICE =
  "chat.account_erasure_completion_v2";

export async function applyChatEvent(
  event: InboundEvent,
  hooks: ChatEventApplyHooks = {},
): Promise<ChatEventApplyResult> {
  const sourceEventId = event.eventId.trim();
  if (!sourceEventId) {
    throw new Error("chat projection source eventId is required");
  }
  const sourceService = `${CHAT_PROJECTION_RECEIPT_NAMESPACE}:${event.sourceService?.trim() || "chat"}`;
  const payloadHash = canonicalSha256({
    eventType: event.eventType,
    schemaVersion: event.schemaVersion ?? 1,
    aggregateId: event.aggregateId,
    occurredAt: normalizedEventOccurredAt(event.occurredAt),
    payload: event.payload,
  });
  const where = {
    sourceService_sourceEventId: {
      sourceService,
      sourceEventId,
    },
  } as const;

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`${sourceService}:${sourceEventId}`}, 0)
      )
    `;
    const existing = await tx.inboundEventReceipt.findUnique({ where });
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        await tx.inboundEventReceipt.update({
          where,
          data: {
            processingState: "quarantined",
            quarantinedAt: new Date(),
            error: {
              code: "payload_hash_conflict",
              expectedHash: existing.payloadHash,
              receivedHash: payloadHash,
            },
          },
        });
        return {
          status: "quarantined",
          reason: "payload_hash_conflict",
        };
      }
      if (existing.processingState === "quarantined") {
        return {
          status: "quarantined",
          reason: "source_event_quarantined",
        };
      }
      if (existing.processingState === "processed") {
        return { status: "duplicate", outcome: "applied" };
      }
    }

    const result = await applyChatEventEffect(tx, event);
    await hooks.afterEffect?.(sourceEventId);
    const processedAt = new Date();
    const data = {
      payloadHash,
      processingState: "processed",
      processedAt,
      quarantinedAt: null,
      error: Prisma.DbNull,
    } as const;
    if (existing) {
      await tx.inboundEventReceipt.update({ where, data });
    } else {
      await tx.inboundEventReceipt.create({
        data: {
          sourceService,
          sourceEventId,
          ...data,
        },
      });
    }
    return result;
  }, {
    maxWait: 10_000,
    timeout: 60_000,
  });
}

async function applyChatEventEffect(
  tx: Prisma.TransactionClient,
  event: InboundEvent,
): Promise<ChatEventEffectResult> {
  if (event.eventType !== CHAT_TO_MAIN_EVENTS.accountErasureCompletedV2) {
    // Product sessions, Turns, moderation and ToolEffects are written directly
    // by Main. The only Chat -> Main durable event is local account-erasure
    // completion, which has a dedicated authenticated ingress.
    return CHAT_EVENT_APPLIED;
  }
  if (
    event.sourceService !== ACCOUNT_ERASURE_COMPLETION_V2_SOURCE_SERVICE ||
    event.schemaVersion !== 2
  ) {
    throw new Error(
      "account erasure completion v2 requires its dedicated ingress",
    );
  }
  const payload = chatAccountErasureCompletedV2PayloadSchema.parse(event.payload);
  await acceptChatAccountErasureCompletion(tx, {
    sourceEventId: event.eventId,
    aggregateId: event.aggregateId,
    payload,
  });
  return CHAT_EVENT_APPLIED;
}

function normalizedEventOccurredAt(value: string | undefined): string | null {
  if (!value) return null;
  const occurredAt = new Date(value);
  return Number.isNaN(occurredAt.getTime()) ? value : occurredAt.toISOString();
}

export interface ProductEventDispatchOptions {
  readonly outboxIds?: readonly string[];
  readonly signal?: AbortSignal;
}

export async function dispatchPendingProductEvents(
  batch = 100,
  options: ProductEventDispatchOptions = {},
): Promise<{ delivered: number; failed: number }> {
  if (options.signal?.aborted) return { delivered: 0, failed: 0 };
  const now = new Date();
  const pendingWhere: Prisma.MainOutboxEventWhereInput = {
    eventType: "product.event.persisted.v2",
    status: "pending",
    ...(options.outboxIds ? { id: { in: [...new Set(options.outboxIds)] } } : {}),
  };
  const [oldestPending, rows] = await Promise.all([
    prisma.mainOutboxEvent.findFirst({
      where: pendingWhere,
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    prisma.mainOutboxEvent.findMany({
      where: { ...pendingWhere, nextRunAt: { lte: now } },
      orderBy: { createdAt: "asc" },
      take: batch,
    }),
  ]);
  setGauge(
    "main_outbox_pending_age_seconds",
    "Age of the oldest pending Main outbox event",
    { queue: "product_event" },
    oldestPending ? Math.max(0, now.getTime() - oldestPending.createdAt.getTime()) / 1_000 : 0,
  );
  let delivered = 0;
  let failed = 0;
  for (const row of rows) {
    if (options.signal?.aborted) break;
    const event = await prisma.analyticsEvent.findUnique({ where: { id: row.aggregateId } });
    if (options.signal?.aborted) break;
    if (!event) {
      await prisma.mainOutboxEvent.update({
        where: { id: row.id },
        data: {
          status: "failed",
          attempts: { increment: 1 },
          lastError: {
            outcome: "failed",
            reason: "canonical_product_event_missing",
            canonicalEventId: row.aggregateId,
          },
        },
      });
      failed += 1;
      continue;
    }
    const context = jsonRecord(event.context);
    const chatEvent: InboundEvent = {
      eventId: event.sourceEventId ?? event.id,
      eventType: event.name,
      aggregateId: String(
        context.aggregateId ?? event.sourceEventId ?? event.id,
      ),
      occurredAt: event.occurredAt?.toISOString(),
      payload: jsonRecord(event.props),
      schemaVersion: event.schemaVersion,
      sourceService: event.sourceService,
    };
    try {
      const metricProjection = await projectCanonicalMetricEvent(prisma, {
        id: event.id,
        sourceService: event.sourceService,
        sourceEventId: event.sourceEventId ?? event.id,
        name: event.name,
        schemaVersion: event.schemaVersion,
        occurredAt: event.occurredAt ?? event.createdAt,
        ingestedAt: event.ingestedAt,
        environment: event.environment,
        dataClass: event.dataClass,
        trustClass: event.trustClass,
        actor: event.actor,
        context: event.context,
        props: event.props,
      });
      if (metricProjection.status === "deferred") {
        throw new Error(`Metric projection deferred: ${metricProjection.reason}`);
      }
      const chatProjection = await applyChatEvent(chatEvent);
      if (chatProjection.status === "quarantined") {
        await prisma.mainOutboxEvent.update({
          where: { id: row.id },
          data: {
            status: "failed",
            attempts: { increment: 1 },
            lastError: {
              outcome: "quarantined",
              reason: chatProjection.reason,
              sourceService: event.sourceService,
              sourceEventId: event.sourceEventId ?? event.id,
            },
          },
        });
        failed += 1;
        continue;
      }
      await prisma.mainOutboxEvent.update({
        where: { id: row.id },
        data: {
          status: "delivered",
          deliveredAt: new Date(),
          lastError: Prisma.DbNull,
        },
      });
      delivered += 1;
    } catch (error) {
      await prisma.mainOutboxEvent.update({
        where: { id: row.id },
        data: {
          attempts: { increment: 1 },
          nextRunAt: new Date(Date.now() + 30_000 * (row.attempts + 1)),
          lastError: { message: error instanceof Error ? error.message : "projection failed" },
        },
      });
      failed += 1;
    }
  }
  return { delivered, failed };
}

function jsonRecord(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

const EVENT_CONSUMER_CLOSE_TIMEOUT_MS = 30_000;

export function startEventConsumer(): { close(): Promise<void> } {
  const stopping = new AbortController();
  // These fixed responsibilities have different latency requirements. Each
  // owns its next poll; awaiting all of them behind one promise would still
  // let a slow memory upload block later admission and erasure intents.
  const lanes = [
    { name: "product_events", run: () => dispatchPendingProductEvents(100, { signal: stopping.signal }) },
    { name: "chat_memory", run: () => dispatchPendingChatEvents({ lane: "memory", batch: 50, signal: stopping.signal }) },
    { name: "chat_lifecycle", run: () => dispatchPendingChatEvents({ lane: "lifecycle", batch: 50, signal: stopping.signal }) },
    { name: "chat_admission", run: () => dispatchPendingChatAgentRuns(50, stopping.signal) },
    { name: "account_blob_deletion", run: () => dispatchPendingAccountDeletionBlobDeletes({ signal: stopping.signal }) },
  ].map((lane) => ({ ...lane, inFlight: null as Promise<void> | null }));
  const reconcile = () => {
    if (stopping.signal.aborted) return;
    for (const lane of lanes) {
      if (lane.inFlight) continue;
      lane.inFlight = lane.run()
        .then(() => undefined)
        .catch((err) => logger.error({ err, lane: lane.name }, "durable event reconciliation failed"))
        .finally(() => { lane.inFlight = null; });
    }
  };
  const projectionTimer = setInterval(reconcile, 5_000);
  reconcile();
  // Snapshot scans run independently so analytics cannot stall product delivery.
  const metricRefresh = startMetricSnapshotRefresh();
  let closePromise: Promise<void> | null = null;
  logger.info("main durable event projector ready");
  return {
    close() {
      if (closePromise) return closePromise;
      // Abort means no new claim, not cancellation of an accepted delivery.
      // Live attempts retain their heartbeat and exact lease/CAS ownership.
      stopping.abort();
      clearInterval(projectionTimer);
      let metricClosing = true;
      const metricClosed = metricRefresh.close().finally(() => { metricClosing = false; });
      closePromise = (async () => {
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          const drained = await Promise.race([
            Promise.all([...lanes.map((lane) => lane.inFlight), metricClosed]).then(() => true),
            new Promise<false>((resolve) => {
              deadline = setTimeout(() => resolve(false), EVENT_CONSUMER_CLOSE_TIMEOUT_MS);
            }),
          ]);
          if (!drained) {
            const pending = lanes.filter((lane) => lane.inFlight).map((lane) => lane.name);
            if (metricClosing) pending.push("metric_snapshots");
            logger.error({ pending, timeoutMs: EVENT_CONSUMER_CLOSE_TIMEOUT_MS }, "durable event drain timed out; pending work retains its lease");
            throw new Error("Durable event drain timed out with pending work");
          }
        } finally {
          clearTimeout(deadline);
        }
      })();
      return closePromise;
    },
  };
}

// Entry when run directly or through PM2's Bun wrapper: start + graceful shutdown.
if (isProcessEntrypoint(["event-consumer.ts", "event-consumer.js"])) {
  const worker = startEventConsumer();
  const shutdown = () => {
    void worker.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
