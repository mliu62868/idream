// SPEC: liveness answers "is the process alive"; readiness answers "may this
// process accept a real turn". Readiness requires DB, Redis and an actual model
// warm-up through the production adapter.
import Redis from "ioredis";
import type { ChatPrismaClient } from "./db.js";
import { chatPrisma } from "./db.js";
import type { ChatModel } from "./providers.js";
import { providers } from "./providers.js";
import { redisOptions } from "./queue.js";

export interface RuntimeReadinessSnapshot {
  live: boolean;
  ready: boolean;
  accepting: boolean;
  warming: boolean;
  lastError: string | null;
  warmedAt: string | null;
}

export class RuntimeReadiness {
  private state: RuntimeReadinessSnapshot = {
    live: true,
    ready: false,
    accepting: true,
    warming: false,
    lastError: null,
    warmedAt: null,
  };

  snapshot(): RuntimeReadinessSnapshot {
    return { ...this.state };
  }

  beginWarmup(): void {
    this.state = { ...this.state, ready: false, warming: true, lastError: null };
  }

  warmed(): void {
    this.state = {
      ...this.state,
      ready: true,
      warming: false,
      lastError: null,
      warmedAt: new Date().toISOString(),
    };
  }

  failed(error: unknown): void {
    this.state = {
      ...this.state,
      ready: false,
      warming: false,
      lastError: error instanceof Error ? error.message : String(error),
    };
  }

  stopAccepting(): void {
    this.state = { ...this.state, accepting: false, ready: false };
  }

  canAcceptTurns(): boolean {
    return this.state.live && this.state.ready && this.state.accepting;
  }
}

export const runtimeReadiness = new RuntimeReadiness();

export async function assertChatSchemaReady(prisma: ChatPrismaClient): Promise<void> {
  // INVARIANT: a reachable database is not a ready database. Resolving the
  // exact relations used by every turn makes an unapplied Scene migration fail
  // before admission rather than during message creation.
  await prisma.$queryRaw`
    SELECT messages.scene_version, revisions.version
    FROM chat.messages AS messages
    LEFT JOIN chat.chat_scene_revisions AS revisions
      ON revisions.session_id = messages.session_id
    LIMIT 0
  `;
}

export async function warmRuntime(input: {
  prisma?: ChatPrismaClient;
  chat?: ChatModel;
  pingRedis?: () => Promise<void>;
  readiness?: RuntimeReadiness;
} = {}): Promise<void> {
  const readiness = input.readiness ?? runtimeReadiness;
  readiness.beginWarmup();
  try {
    const prisma = input.prisma ?? chatPrisma;
    const chat = input.chat ?? providers.chat;
    await assertChatSchemaReady(prisma);
    await (input.pingRedis ?? pingRedis)();

    let output = "";
    for await (const chunk of chat.stream({
      messages: [
        {
          role: "system",
          content: "You are a runtime warm-up probe. Reply with READY only.",
        },
        { role: "user", content: "READY" },
      ],
    })) {
      output += chunk.delta;
    }
    if (!output.trim()) throw new Error("chat model warm-up returned no content");
    readiness.warmed();
  } catch (error) {
    readiness.failed(error);
    throw error;
  }
}

async function pingRedis(): Promise<void> {
  const redis = new Redis(redisOptions());
  try {
    await redis.ping();
  } finally {
    await redis.quit().catch(() => redis.disconnect());
  }
}
