// SPEC: main-event-consumer (design §10). Consumes the chat→main events that the
// chat service delivers to the `main.inbound` queue (its transactional outbox),
// and applies them to main's authority tables: stats, safety, analytics.
// INVARIANTS: idempotent per eventId (effects are upserts/bounded increments).
import { Worker } from "bullmq";
import type { RedisOptions } from "ioredis";
import type { Prisma } from "@prisma/client";
import { setGauge } from "@idream/shared";
import {
  MAIN_QUEUES,
  MAIN_TO_CHAT_QUEUE,
  MAIN_TO_CHAT_EVENTS,
  CHAT_TO_MAIN_EVENTS,
  chatImageRequestedPayloadSchema,
  chatSessionReleaseMigrationAppliedPayloadSchema,
  idempotencyKeys,
} from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { logger } from "@/server/lib/logger";
import { createChatImageGenerationJob } from "@/server/modules/ourdream/service";
import { findReusableChatImage } from "@/server/modules/ourdream/chat-image-reuse";
import { jobQueue } from "@/server/jobs/queue";
import {
  dispatchPendingChatEvents,
  durableChatIngressEnabled,
  recordMainToChatEvent,
} from "./chat-outbox";
import { projectCanonicalMetricEvent } from "@/server/modules/admin-v2/metrics/projector";
import { transitionControlPlaneCommandAttempt } from "@/server/modules/admin-v2/shared/control-plane-command-attempt";

function redisOptions(): RedisOptions {
  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname,
    port: url.port ? Number.parseInt(url.port, 10) : 6379,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: url.pathname && url.pathname !== "/" ? Number.parseInt(url.pathname.slice(1), 10) : 0,
    maxRetriesPerRequest: null,
  };
}

interface InboundEvent {
  eventId: string;
  eventType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  occurredAt?: string;
}

export async function applyChatEvent(event: InboundEvent): Promise<void> {
  switch (event.eventType) {
    case CHAT_TO_MAIN_EVENTS.sessionCreated: {
      // Seed the library recent-chats projection (chat service owns authority).
      const userId = String(event.payload.userId ?? "");
      const characterId = String(event.payload.characterId ?? "");
      if (userId && characterId) {
        await prisma.recentChat.upsert({
          where: { sessionId: event.aggregateId },
          create: { sessionId: event.aggregateId, userId, characterId, lastMessageAt: eventTime(event) },
          update: {},
        });
      }
      return;
    }
    case CHAT_TO_MAIN_EVENTS.messageCompleted: {
      const characterId = String(event.payload.characterId ?? "");
      if (characterId) {
        await prisma.characterStats.updateMany({
          where: { characterId },
          data: { chatsCount: { increment: 1 }, lastActivityAt: eventTime(event) },
        });
      }
      // Bump the projection's recency (upsert: tolerate a missed session.created).
      const sessionId = String(event.payload.sessionId ?? "");
      const userId = String(event.payload.userId ?? "");
      if (sessionId && userId && characterId) {
        await prisma.recentChat.upsert({
          where: { sessionId },
          create: { sessionId, userId, characterId, lastMessageAt: eventTime(event), status: "active" },
          update: { lastMessageAt: eventTime(event), status: "active" },
        });
      }
      return;
    }
    case CHAT_TO_MAIN_EVENTS.sessionDeleted: {
      await prisma.recentChat.updateMany({ where: { sessionId: event.aggregateId }, data: { status: "deleted" } });
      return;
    }
    case CHAT_TO_MAIN_EVENTS.safetyFlagged: {
      await prisma.moderationEvent.create({
        data: {
          targetType: "message",
          targetId: event.aggregateId,
          layer: String(event.payload.layer ?? "output"),
          status: "flagged",
          policyCode: (event.payload.policyCode as string) ?? null,
          details: {},
        },
      });
      return;
    }
    case CHAT_TO_MAIN_EVENTS.imageRequested: {
      // Parse INSIDE the try so a schema-mismatched event (e.g. a rolling deploy where an
      // older chat omits a newly-required field) still emits a chat.image.failed callback
      // instead of throwing → dead-lettering with no notification → attachment stuck
      // forever in 'requesting'. Recover the attachmentId best-effort for that callback.
      const attachmentId = String(
        (event.payload as { attachmentId?: unknown }).attachmentId ?? event.aggregateId ?? "",
      );
      try {
        const payload = chatImageRequestedPayloadSchema.parse(event.payload);
        const reusable = await findReusableChatImage(payload);
        if (reusable) {
          await enqueueChatCallback({
            eventId: `chat_image_completed_${payload.attachmentId}_reused_${reusable.asset.id}`,
            eventType: MAIN_TO_CHAT_EVENTS.chatImageCompleted,
            payload: {
              version: 1,
              kind: "chat.image.completed",
              attachmentId: payload.attachmentId,
              generationJobId: null,
              mediaAssetId: reusable.asset.id,
              width: reusable.asset.width,
              height: reusable.asset.height,
              reused: true,
              reuseScore: reusable.score,
              matchedFields: reusable.matchedFields,
              summary: reusable.description ?? (reusable.tags.join(", ") || undefined),
            },
          });
          return;
        }
        const job = await createChatImageGenerationJob(payload);
        await enqueueChatCallback({
          eventId: `chat_image_accepted_${payload.attachmentId}_${job.id}`,
          eventType: MAIN_TO_CHAT_EVENTS.chatImageAccepted,
          payload: {
            version: 1,
            kind: "chat.image.accepted",
            attachmentId: payload.attachmentId,
            generationJobId: job.id,
            costDreamcoins: job.costDreamcoins,
          },
        });
      } catch (error) {
        // INVARIANT: only genuinely PERMANENT errors are 'rejected' (which the chat confirm
        // endpoint refuses to re-confirm). Transient ones — insufficient coins, rate limit,
        // a Redis/DB blip — are 'failed' so the user can retry once the condition clears;
        // marking them 'rejected' would wedge the attachment permanently.
        await enqueueChatCallback({
          eventId: `chat_image_failed_${attachmentId}`,
          eventType: MAIN_TO_CHAT_EVENTS.chatImageFailed,
          payload: {
            version: 1,
            kind: "chat.image.failed",
            attachmentId,
            generationJobId: null,
            status: chatImageFailureStatus(error),
            errorCode: errorCode(error),
          },
        });
      }
      return;
    }
    case CHAT_TO_MAIN_EVENTS.accountErasureCompleted:
      logger.info({ userId: event.aggregateId }, "chat account erasure completed");
      return;
    case CHAT_TO_MAIN_EVENTS.sessionReleaseMigrationApplied: {
      const payload = chatSessionReleaseMigrationAppliedPayloadSchema.parse(event.payload);
      await prisma.$transaction(async (tx) => {
        const command = await tx.controlPlaneCommand.findUnique({
          where: { id: payload.commandId },
        });
        if (!command || command.commandType !== "chat.session_release.migrate") return;
        if (command.status === "succeeded") return;
        if (command.status !== "verifying" || command.targetId !== payload.sessionId) {
          throw new Error("session release migration verification does not match command state");
        }
        const expected = jsonRecord(command.requestPayload);
        const expectedMatches =
          expected.characterId === payload.characterId &&
          expected.fromCharacterContentVersionId === payload.fromCharacterContentVersionId &&
          expected.fromCharacterReleaseId === payload.fromCharacterReleaseId &&
          expected.toCharacterContentVersionId === payload.toCharacterContentVersionId &&
          expected.toCharacterReleaseId === payload.toCharacterReleaseId;
        if (!expectedMatches) {
          throw new Error("session release migration verification payload changed");
        }
        const appliedAt = new Date(payload.appliedAt);
        await tx.controlPlaneCommand.update({
          where: { id: command.id },
          data: {
            status: "succeeded",
            result: {
              sessionId: payload.sessionId,
              characterId: payload.characterId,
              fromCharacterContentVersionId: payload.fromCharacterContentVersionId,
              fromCharacterReleaseId: payload.fromCharacterReleaseId,
              toCharacterContentVersionId: payload.toCharacterContentVersionId,
              toCharacterReleaseId: payload.toCharacterReleaseId,
              verificationState: "passed",
              appliedAt: payload.appliedAt,
            },
            heartbeatAt: appliedAt,
            finishedAt: appliedAt,
          },
        });
        await transitionControlPlaneCommandAttempt(tx, {
          commandId: command.id,
          attemptNo: command.attemptCount,
          to: "succeeded",
          data: { finishedAt: appliedAt },
        });
        await tx.adminAuditLog.create({
          data: {
            actorId: command.actorId,
            actorRole: "command_verifier",
            action: "chat.session_release.migrate.applied",
            targetType: "chat_session",
            targetId: payload.sessionId,
            reason: "Chat applied the approved Release pin at the next turn boundary",
            before: {
              characterContentVersionId: payload.fromCharacterContentVersionId,
              characterReleaseId: payload.fromCharacterReleaseId,
            },
            after: {
              characterContentVersionId: payload.toCharacterContentVersionId,
              characterReleaseId: payload.toCharacterReleaseId,
              appliedAt: payload.appliedAt,
            },
            requestId: command.requestId,
          },
        });
      });
      return;
    }
    default:
      // usage.incremented / memory.updated / relationship.updated: analytics-only
      // for now; recording is enough.
      logger.debug({ eventType: event.eventType }, "chat event observed");
      return;
  }
}

function eventTime(event: InboundEvent): Date {
  const occurredAt = event.occurredAt ? new Date(event.occurredAt) : new Date();
  return Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt;
}

export async function dispatchPendingProductEvents(batch = 100): Promise<{ delivered: number; failed: number }> {
  const now = new Date();
  const [oldestPending, rows] = await Promise.all([
    prisma.mainOutboxEvent.findFirst({
      where: { eventType: "product.event.persisted.v2", status: "pending" },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    prisma.mainOutboxEvent.findMany({
      where: { eventType: "product.event.persisted.v2", status: "pending", nextRunAt: { lte: now } },
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
    const event = await prisma.analyticsEvent.findUnique({ where: { id: row.aggregateId } });
    if (!event) continue;
    const context = jsonRecord(event.context);
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
      await applyChatEvent({
        eventId: event.sourceEventId ?? event.id,
        eventType: event.name,
        aggregateId: String(context.aggregateId ?? event.sourceEventId ?? event.id),
        occurredAt: event.occurredAt?.toISOString(),
        payload: jsonRecord(event.props),
      });
      await prisma.mainOutboxEvent.update({
        where: { id: row.id },
        data: { status: "delivered", deliveredAt: new Date() },
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

async function enqueueChatCallback(input: {
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
}) {
  await recordMainToChatEvent({
    eventId: input.eventId,
    eventType: input.eventType,
    aggregateId: input.eventId,
    payload: input.payload,
  });
  if (durableChatIngressEnabled()) {
    await dispatchPendingChatEvents().catch(() => undefined);
  } else {
    await jobQueue.enqueue({
      queue: MAIN_TO_CHAT_QUEUE,
      payload: {
        eventId: input.eventId,
        eventType: input.eventType,
        payload: input.payload,
      } as Prisma.InputJsonValue,
      dedupeKey: idempotencyKeys.chatInbox(input.eventId),
    });
  }
}

function errorCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "chat_image_rejected";
}

// Permanent AppError codes → 'rejected' (not retryable); everything else (payment_required,
// rate_limited, internal, conflict, parse/unknown) → 'failed' so the user can retry.
const PERMANENT_IMAGE_ERROR_CODES = new Set([
  "bad_request",
  "forbidden",
  "not_found",
  "unauthorized",
]);

function chatImageFailureStatus(error: unknown): "failed" | "rejected" {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "";
  return PERMANENT_IMAGE_ERROR_CODES.has(code) ? "rejected" : "failed";
}

export function startEventConsumer(): Worker {
  const worker = new Worker(
    MAIN_QUEUES.mainInbound,
    async (job) => {
      // The chat producer (packages/chat enqueue) wraps the event envelope as
      // { payload: <envelope>, dedupeKey }. Unwrap to the envelope; tolerate an
      // already-unwrapped shape so either producer convention is consumed.
      const data = job.data as { payload?: InboundEvent } & Partial<InboundEvent>;
      const event = (data.payload ?? data) as InboundEvent;
      await applyChatEvent(event);
    },
    { connection: redisOptions(), prefix: env.BULLMQ_PREFIX, concurrency: 4 },
  );
  worker.on("ready", () => logger.info("main-event-consumer ready"));
  worker.on("failed", (job, err) => logger.error({ jobId: job?.id, err }, "event consume failed"));
  const projectionTimer = setInterval(() => {
    dispatchPendingProductEvents().catch((err) => logger.error({ err }, "product event projection dispatch failed"));
    if (durableChatIngressEnabled()) {
      dispatchPendingChatEvents().catch((err) => logger.error({ err }, "chat outbox dispatch failed"));
    }
  }, 5_000);
  worker.on("closed", () => clearInterval(projectionTimer));
  return worker;
}

// Entry when run directly (pm2): start + graceful shutdown.
if (import.meta.url === `file://${process.argv[1]}`) {
  const worker = startEventConsumer();
  const shutdown = async () => {
    await worker.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
