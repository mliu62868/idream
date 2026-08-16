// Core companion invariants that must hold under concurrency and long-lived sessions.
// These tests intentionally cross the public service/worker seams with real Postgres,
// Redis, and the file-backed memory layer.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FREE_DAILY_MESSAGES } from "@idream/shared/chat/limits";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import IORedis from "ioredis";
import { createChatPrisma } from "../src/db.js";
import { processGenerate } from "../src/generate.js";
import { processMemoryExtract } from "../src/memory.js";
import { listMemories } from "../src/memories.js";
import { getRelationshipState } from "../src/relationship.js";
import { reconcile } from "../src/reconcile.js";
import { createSession, getSession, sendMessage } from "../src/service.js";
import { drainQueue, enqueue, obliterate } from "../src/queue.js";
import { appendStreamEvent, streamKey } from "../src/stream.js";
import { getLastMockStreamMessages } from "../src/providers.js";
import { CHAT_QUEUES } from "@idream/shared/contracts";
import { acceptAgeGate } from "./fixtures.js";

const prisma = createChatPrisma();
const superPool = new Pool({ connectionString: process.env.CHAT_TEST_SUPER_URL });
const CHARACTER = "c_core_agent";
const USERS = {
  sessionRace: "u_core_session_race",
  turnRace: "u_core_turn_race",
  quotaRace: "u_core_quota_race",
  history: "u_core_history",
  summary: "u_core_summary",
  memory: "u_core_memory",
  recovery: "u_core_recovery",
  poisonedPayload: "u_core_poisoned_payload",
  exactMemory: "u_core_exact_memory",
  inputLimit: "u_core_input_limit",
  contextBudget: "u_core_context_budget",
  privateOwner: "u_core_private_owner",
  privateIntruder: "u_core_private_intruder",
} as const;
const PRIVATE_CHARACTER = "c_core_private";
const ARCHIVED_PRIVATE_CHARACTER = "c_core_private_archived";
let fsRoot: string;

beforeAll(async () => {
  fsRoot = await mkdtemp(path.join(tmpdir(), "chat-core-agent-"));
  process.env.CHAT_FS_ROOT = fsRoot;
  await obliterate(CHAT_QUEUES.generate).catch(() => {});
  await obliterate(CHAT_QUEUES.memoryExtract).catch(() => {});

  for (const [name, userId] of Object.entries(USERS)) {
    await superPool.query(
      `INSERT INTO public.users (id,email,status,"createdAt","updatedAt")
       VALUES ($1,$2,'active',now(),now()) ON CONFLICT (id) DO NOTHING`,
      [userId, `${name}@core-agent.test`],
    );
  }
  await acceptAgeGate(superPool, Object.values(USERS));
  await superPool.query(
    `INSERT INTO public.characters
       (id,name,age,description,visibility,status,style,gender,appearance,"advancedDetails","createdAt","updatedAt")
     VALUES ($1,'Core Agent',24,'Companion','public','approved','realistic','female','{}','{}',now(),now())
     ON CONFLICT (id) DO NOTHING`,
    [CHARACTER],
  );
  await superPool.query(
    `INSERT INTO public.characters
       (id,"creatorId",name,age,description,visibility,status,style,gender,appearance,"advancedDetails","createdAt","updatedAt")
     VALUES ($1,$2,'Private Agent',24,'Private companion','private','approved','realistic','female','{}','{}',now(),now())
     ON CONFLICT (id) DO NOTHING`,
    [PRIVATE_CHARACTER, USERS.privateOwner],
  );
  await superPool.query(
    `INSERT INTO public.characters
       (id,"creatorId",name,age,description,visibility,status,style,gender,appearance,"advancedDetails","createdAt","updatedAt","deletedAt")
     VALUES ($1,$2,'Archived Private Agent',24,'Archived companion','private','archived','realistic','female','{}','{}',now(),now(),now())
     ON CONFLICT (id) DO NOTHING`,
    [ARCHIVED_PRIVATE_CHARACTER, USERS.privateOwner],
  );
});

afterAll(async () => {
  await prisma.$disconnect();
  await superPool.end();
  await rm(fsRoot, { recursive: true, force: true });
});

describe("core chat command invariants", () => {
  it("does not expose another user's private character by guessed id", async () => {
    await expect(
      createSession(
        { userId: USERS.privateIntruder, characterId: PRIVATE_CHARACTER },
        { prisma },
      ),
    ).rejects.toMatchObject({ code: "character_unavailable", status: 403 });
  });

  it("does not let a creator chat with an archived or deleted character", async () => {
    await expect(
      createSession(
        {
          userId: USERS.privateOwner,
          characterId: ARCHIVED_PRIVATE_CHARACTER,
        },
        { prisma },
      ),
    ).rejects.toMatchObject({ code: "character_unavailable", status: 403 });
  });

  it("rejects an unbounded user turn before writing it to the ledger", async () => {
    const session = await createSession(
      { userId: USERS.inputLimit, characterId: CHARACTER },
      { prisma },
    );
    await expect(
      sendMessage(
        { userId: USERS.inputLimit, sessionId: session.id, content: "x".repeat(12_001) },
        { prisma },
      ),
    ).rejects.toMatchObject({ code: "message_too_long", status: 400 });
    expect(await prisma.message.count({ where: { sessionId: session.id } })).toBe(0);
  });

  it("creates only one active session for concurrent user/character requests", async () => {
    const sessions = await Promise.all(
      Array.from({ length: 8 }, () =>
        createSession({ userId: USERS.sessionRace, characterId: CHARACTER }, { prisma }),
      ),
    );

    expect(new Set(sessions.map((session) => session.id)).size).toBe(1);
    expect(
      await prisma.chatSession.count({
        where: { userId: USERS.sessionRace, characterId: CHARACTER, status: "active" },
      }),
    ).toBe(1);
  });

  it("accepts only one in-flight assistant turn per session", async () => {
    const session = await createSession(
      { userId: USERS.turnRace, characterId: CHARACTER },
      { prisma },
    );

    const results = await Promise.allSettled([
      sendMessage({ userId: USERS.turnRace, sessionId: session.id, content: "first" }, { prisma }),
      sendMessage({ userId: USERS.turnRace, sessionId: session.id, content: "second" }, { prisma }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("reserves the final free quota slot atomically", async () => {
    const session = await createSession(
      { userId: USERS.quotaRace, characterId: CHARACTER },
      { prisma },
    );
    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    await prisma.chatUsage.create({
      data: {
        id: "usage_core_quota_race",
        userId: USERS.quotaRace,
        sessionId: session.id,
        messagesUsed: FREE_DAILY_MESSAGES - 1,
        periodStart,
        periodEnd,
      },
    });

    const results = await Promise.allSettled([
      sendMessage({ userId: USERS.quotaRace, sessionId: session.id, content: "slot one" }, { prisma }),
      sendMessage({ userId: USERS.quotaRace, sessionId: session.id, content: "slot two" }, { prisma }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("re-dispatches a committed pending turn after its queue job is lost", async () => {
    const session = await createSession(
      { userId: USERS.recovery, characterId: CHARACTER },
      { prisma },
    );
    const sent = await sendMessage(
      { userId: USERS.recovery, sessionId: session.id, content: "recover this turn" },
      { prisma },
    );
    await obliterate(CHAT_QUEUES.generate);
    await prisma.$executeRaw`
      UPDATE chat.messages
      SET updated_at = timezone('utc', now()) - interval '1 minute'
      WHERE id = ${sent.assistantMessageId}
    `;

    const result = await reconcile(prisma);
    expect(result.requeuedPending).toBeGreaterThanOrEqual(1);
    const handled = await drainQueue(CHAT_QUEUES.generate, async (job) => {
      await processGenerate(job.payload as Parameters<typeof processGenerate>[0], prisma);
    });
    expect(handled).toBeGreaterThanOrEqual(1);
    expect((await prisma.message.findUnique({ where: { id: sent.assistantMessageId } }))?.status).toBe("sent");
  });

  it("fails a generation payload closed when it points at a different source turn", async () => {
    const session = await createSession(
      { userId: USERS.poisonedPayload, characterId: CHARACTER },
      { prisma },
    );
    const sent = await sendMessage(
      { userId: USERS.poisonedPayload, sessionId: session.id, content: "authoritative source" },
      { prisma },
    );
    await obliterate(CHAT_QUEUES.generate);
    const foreignSource = await prisma.message.create({
      data: {
        id: "msg_core_poisoned_foreign_source",
        sessionId: session.id,
        role: "user",
        content: "wrong source",
        status: "sent",
        safetyStatus: "passed",
      },
    });

    await expect(
      processGenerate(
        {
          sessionId: session.id,
          assistantMessageId: sent.assistantMessageId,
          userMessageId: foreignSource.id,
          attempt: 1,
        },
        prisma,
      ),
    ).resolves.toEqual({ status: "skipped" });
    expect(
      (await prisma.message.findUniqueOrThrow({ where: { id: sent.assistantMessageId } }))
        .status,
    ).toBe("pending");

    await expect(
      processGenerate(
        {
          sessionId: session.id,
          assistantMessageId: sent.assistantMessageId,
          userMessageId: sent.userMessageId,
          attempt: 1,
        },
        prisma,
      ),
    ).resolves.toEqual({ status: "sent" });
  });

  it("revives a failed deterministic queue job when reconcile re-enqueues it", async () => {
    const queue = "chat.test.retry-dedupe";
    await obliterate(queue).catch(() => {});
    await enqueue({ queue, payload: { value: 1 }, dedupeKey: "retry-dedupe", maxAttempts: 1 });
    expect(
      await drainQueue(queue, async () => {
        throw new Error("first attempt fails");
      }),
    ).toBe(0);

    await enqueue({ queue, payload: { value: 1 }, dedupeKey: "retry-dedupe", maxAttempts: 1 });
    expect(await drainQueue(queue, async () => {})).toBe(1);
    await obliterate(queue).catch(() => {});
  });
});

describe("core context continuity invariants", () => {
  it("bounds recent transcript size while retaining the newest user turn", async () => {
    const session = await createSession(
      { userId: USERS.contextBudget, characterId: CHARACTER },
      { prisma },
    );
    const oldMessages = Array.from({ length: 12 }, (_, index) => ({
      id: `msg_core_budget_${index}`,
      sessionId: session.id,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `${index}:`.padEnd(6_000, String(index % 10)),
      status: "sent",
      safetyStatus: "passed",
      createdAt: new Date(Date.UTC(2026, 0, 3, 0, 0, index)),
    }));
    await prisma.message.createMany({ data: oldMessages });
    await sendMessage(
      { userId: USERS.contextBudget, sessionId: session.id, content: "newest-context-marker" },
      { prisma },
    );
    await drainQueue(CHAT_QUEUES.generate, async (job) => {
      await processGenerate(job.payload as Parameters<typeof processGenerate>[0], prisma);
    });

    const modelMessages = getLastMockStreamMessages() ?? [];
    const transcript = modelMessages.filter((message) => message.role !== "system");
    expect(transcript.reduce((total, message) => total + message.content.length, 0)).toBeLessThanOrEqual(24_000);
    expect(transcript.at(-1)?.content).toContain("newest-context-marker");
    expect(transcript[0]?.role).toBe("user");
  });

  it("loads the newest 200 messages in stable user/assistant order", async () => {
    const session = await createSession(
      { userId: USERS.history, characterId: CHARACTER },
      { prisma },
    );
    const messages = Array.from({ length: 101 }, (_, turn) => {
      const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, turn));
      return [
        {
          id: `msg_core_history_u_${turn}`,
          sessionId: session.id,
          role: "user",
          content: `user-${turn}`,
          status: "sent",
          safetyStatus: "passed",
          createdAt,
        },
        {
          id: `msg_core_history_a_${turn}`,
          sessionId: session.id,
          role: "assistant",
          content: `assistant-${turn}`,
          status: "sent",
          safetyStatus: "passed",
          createdAt,
        },
      ];
    }).flat();
    await prisma.message.createMany({ data: messages });

    const loaded = await getSession({ userId: USERS.history, sessionId: session.id }, { prisma });

    expect(loaded.messages).toHaveLength(200);
    expect(loaded.messages[0]?.content).toBe("user-1");
    expect(loaded.messages[1]?.content).toBe("assistant-1");
    expect(loaded.messages.at(-2)?.content).toBe("user-100");
    expect(loaded.messages.at(-1)?.content).toBe("assistant-100");
  });

  it("drains a legacy rolling summary instead of re-injecting it forever", async () => {
    const session = await createSession(
      { userId: USERS.summary, characterId: CHARACTER },
      { prisma },
    );
    // Rows written before the rolling summary was dropped still hold a value, and
    // prompt assembly still reads the field — so a turn must clear it, not ignore it.
    await prisma.chatSession.update({
      where: { id: session.id },
      data: { memorySummary: "stale ".repeat(150) },
    });
    await sendMessage(
      { userId: USERS.summary, sessionId: session.id, content: "newest-summary-marker" },
      { prisma },
    );
    await drainQueue(CHAT_QUEUES.generate, async (job) => {
      await processGenerate(job.payload as Parameters<typeof processGenerate>[0], prisma);
    });

    const updated = await prisma.chatSession.findUnique({ where: { id: session.id } });
    expect(updated?.memorySummary).toBeNull();
  });

  it("derives relationship progress idempotently for a retried memory job", async () => {
    const session = await createSession(
      { userId: USERS.memory, characterId: CHARACTER },
      { prisma },
    );
    const user = await prisma.message.create({
      data: {
        id: "msg_core_memory_user",
        sessionId: session.id,
        role: "user",
        content: "please call me River",
        status: "sent",
        safetyStatus: "passed",
      },
    });
    const assistant = await prisma.message.create({
      data: {
        id: "msg_core_memory_assistant",
        sessionId: session.id,
        role: "assistant",
        content: "Of course, River.",
        status: "sent",
        safetyStatus: "passed",
        memoryAuthority: "enabled",
        createdAt: user.createdAt,
      },
    });
    const payload = { sessionId: session.id, assistantMessageId: assistant.id, attempt: 1 };

    await processMemoryExtract(payload, prisma);
    await processMemoryExtract(payload, prisma);

    const relationship = await getRelationshipState(USERS.memory, CHARACTER);
    expect(relationship.signals.turns).toBe(1);
    expect(relationship.version).toBe(1);
  });

  it("derives memory from the explicit source turn, not a timestamp guess", async () => {
    const session = await createSession(
      { userId: USERS.exactMemory, characterId: CHARACTER },
      { prisma },
    );
    const createdAt = new Date("2026-01-02T00:00:00.000Z");
    await prisma.message.createMany({
      data: [
        {
          id: "msg_core_exact_wrong",
          sessionId: session.id,
          role: "user",
          content: "call me WrongName",
          status: "sent",
          safetyStatus: "passed",
          createdAt,
        },
        {
          id: "msg_core_exact_right",
          sessionId: session.id,
          role: "user",
          content: "call me RightName",
          status: "sent",
          safetyStatus: "passed",
          createdAt,
        },
        {
          id: "msg_core_exact_assistant",
          sessionId: session.id,
          role: "assistant",
          content: "Got it.",
          status: "sent",
          safetyStatus: "passed",
          replyToMessageId: "msg_core_exact_right",
          memoryAuthority: "enabled",
          createdAt,
        },
      ],
    });

    await processMemoryExtract(
      {
        sessionId: session.id,
        assistantMessageId: "msg_core_exact_assistant",
        userMessageId: "msg_core_exact_right",
        attempt: 1,
      },
      prisma,
    );

    const memories = await listMemories(USERS.exactMemory, CHARACTER);
    expect(memories.some((memory) => memory.text.includes("RightName"))).toBe(true);
    expect(memories.some((memory) => memory.text.includes("WrongName"))).toBe(false);
  });

  it("expires per-message Redis streams instead of leaking keys forever", async () => {
    const key = streamKey("msg_core_stream_ttl");
    await appendStreamEvent(key, { type: "start", attempt: 1 });
    const redis = new IORedis(process.env.CHAT_REDIS_URL ?? "redis://127.0.0.1:6379/14");
    try {
      expect(await redis.ttl(key)).toBeGreaterThan(0);
    } finally {
      await redis.quit();
    }
  });
});
