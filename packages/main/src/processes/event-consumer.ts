// SPEC: main-event-consumer (design §10). Consumes the chat→main events that the
// chat service delivers to the `main.inbound` queue (its transactional outbox),
// and applies them to main's authority tables: stats, safety, analytics.
// INVARIANTS: idempotent per eventId (effects are upserts/bounded increments).
import { Worker } from "bullmq";
import type { RedisOptions } from "ioredis";
import type { Prisma } from "@prisma/client";
import {
  MAIN_QUEUES,
  MAIN_TO_CHAT_EVENTS,
  MAIN_TO_CHAT_QUEUE,
  CHAT_TO_MAIN_EVENTS,
  chatImageRequestedPayloadSchema,
  idempotencyKeys,
} from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { logger } from "@/server/lib/logger";
import { jobQueue } from "@/server/jobs/queue";
import { createChatImageGenerationJob } from "@/server/modules/ourdream/service";
import { findReusableChatImage } from "@/server/modules/ourdream/chat-image-reuse";

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
}

export async function applyChatEvent(event: InboundEvent): Promise<void> {
  switch (event.eventType) {
    case CHAT_TO_MAIN_EVENTS.sessionCreated: {
      // Seed the library recent-chats projection (chat service owns authority).
      const userId = String(event.payload.userId ?? "");
      const characterId = String(event.payload.characterId ?? "");
      if (userId && characterId) {
        await prisma.recentChat
          .upsert({
            where: { sessionId: event.aggregateId },
            create: { sessionId: event.aggregateId, userId, characterId, lastMessageAt: new Date() },
            update: {},
          })
          .catch((err) => logger.error({ err, eventType: event.eventType, sessionId: event.aggregateId }, "recentChat projection failed"));
      }
      return;
    }
    case CHAT_TO_MAIN_EVENTS.messageCompleted: {
      const characterId = String(event.payload.characterId ?? "");
      if (characterId) {
        await prisma.characterStats
          .update({
            where: { characterId },
            data: { chatsCount: { increment: 1 }, lastActivityAt: new Date() },
          })
          .catch(() => {});
      }
      // Bump the projection's recency (upsert: tolerate a missed session.created).
      const sessionId = String(event.payload.sessionId ?? "");
      const userId = String(event.payload.userId ?? "");
      if (sessionId && userId && characterId) {
        await prisma.recentChat
          .upsert({
            where: { sessionId },
            create: { sessionId, userId, characterId, lastMessageAt: new Date(), status: "active" },
            update: { lastMessageAt: new Date(), status: "active" },
          })
          .catch((err) => logger.error({ err, eventType: event.eventType, sessionId }, "recentChat projection failed"));
      }
      return;
    }
    case CHAT_TO_MAIN_EVENTS.sessionDeleted: {
      await prisma.recentChat
        .update({ where: { sessionId: event.aggregateId }, data: { status: "deleted" } })
        .catch(() => {});
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
    default:
      // usage.incremented / memory.updated / relationship.updated: analytics-only
      // for now; recording is enough.
      logger.debug({ eventType: event.eventType }, "chat event observed");
      return;
  }
}

async function enqueueChatCallback(input: {
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
}) {
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
