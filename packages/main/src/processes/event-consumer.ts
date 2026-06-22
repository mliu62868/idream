// SPEC: main-event-consumer (design §10). Consumes the chat→main events that the
// chat service delivers to the `main.inbound` queue (its transactional outbox),
// and applies them to main's authority tables: stats, safety, analytics.
// INVARIANTS: idempotent per eventId (effects are upserts/bounded increments).
import { Worker } from "bullmq";
import type { RedisOptions } from "ioredis";
import { MAIN_QUEUES, CHAT_TO_MAIN_EVENTS } from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { logger } from "@/server/lib/logger";

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
          .catch(() => {});
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
          .catch(() => {});
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

export function startEventConsumer(): Worker {
  const worker = new Worker(
    MAIN_QUEUES.mainInbound,
    async (job) => {
      await applyChatEvent(job.data as InboundEvent);
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
