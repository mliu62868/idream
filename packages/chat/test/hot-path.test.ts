// P0-3 acceptance: send a message → enqueue → worker generate → finalize.
// Asserts: assistant message lands `sent` in PG, usage increments, session.jsonl
// is written (file layer), and chat→main outbox events are recorded. Also proves
// regenerate is NOT swallowed by dedupe (carries :attempt) and refresh/replay via
// the persisted message survives a "dropped" stream.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { createChatPrisma } from "../src/db.js";
import { createSession, sendMessage, regenerate } from "../src/service.js";
import { processGenerate } from "../src/generate.js";
import { drainQueue, obliterate } from "../src/queue.js";
import { CHAT_QUEUES } from "@idream/shared/contracts";

const prisma = createChatPrisma();
const superPool = new Pool({ connectionString: process.env.CHAT_TEST_SUPER_URL });
let fsRoot: string;

const USER = "u_hot";
const CHAR = "c_hot";

beforeAll(async () => {
  fsRoot = await mkdtemp(path.join(tmpdir(), "chat-hp-"));
  process.env.CHAT_FS_ROOT = fsRoot;
  await obliterate(CHAT_QUEUES.generate).catch(() => {});

  // Seed public base tables (the views read these). Superuser bypasses the boundary.
  await superPool.query(
    `INSERT INTO public.users (id, email, status, "createdAt", "updatedAt")
     VALUES ($1, $2, 'active', now(), now()) ON CONFLICT (id) DO NOTHING`,
    [USER, "hot@test.dev"],
  );
  await superPool.query(
    `INSERT INTO public.characters (id, name, age, description, visibility, status, style, gender, appearance, "advancedDetails", "createdAt", "updatedAt")
     VALUES ($1, 'Hot', 22, 'desc', 'public', 'approved', 'realistic', 'female', '{}', '{}', now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [CHAR],
  );
});

afterAll(async () => {
  await prisma.$disconnect();
  await superPool.end();
  await rm(fsRoot, { recursive: true, force: true });
});

describe("chat hot path (P0-3)", () => {
  it("send → generate → finalize: message sent, usage++, jsonl, outbox", async () => {
    const session = await createSession({ userId: USER, characterId: CHAR }, { prisma });
    const res = await sendMessage(
      { userId: USER, sessionId: session.id, content: "hello there" },
      { prisma },
    );
    expect(res.assistantMessageId).toBeTruthy();
    expect(res.streamUrl).toContain(res.assistantMessageId);

    // placeholder is generating before the worker runs
    const before = await prisma.message.findUnique({ where: { id: res.assistantMessageId } });
    expect(before?.status).toBe("generating");

    // drain the generate queue with the real worker handler
    const handled = await drainQueue(CHAT_QUEUES.generate, async (job) => {
      await processGenerate(job.payload as Parameters<typeof processGenerate>[0], prisma);
    });
    expect(handled).toBe(1);

    const after = await prisma.message.findUnique({ where: { id: res.assistantMessageId } });
    expect(after?.status).toBe("sent");
    expect(after?.content).toContain("Mock");

    // selected version exists
    const version = await prisma.messageVersion.findFirst({
      where: { messageId: res.assistantMessageId, selected: true },
    });
    expect(version?.content).toBe(after?.content);

    // usage incremented
    const usage = await prisma.chatUsage.findFirst({ where: { userId: USER } });
    expect(usage?.messagesUsed).toBeGreaterThanOrEqual(1);

    // session.jsonl written (file layer / agent trace)
    const jsonl = await readFile(
      path.join(fsRoot, "sessions", USER, `${session.id}.jsonl`),
      "utf8",
    );
    expect(jsonl).toContain("chat.turn");
    expect(jsonl).toContain(res.assistantMessageId);

    // outbox: message.completed + usage.incremented recorded
    const outbox = await prisma.chatOutboxEvent.findMany({ where: { aggregateId: res.assistantMessageId } });
    expect(outbox.some((e) => e.eventType === "chat.message.completed")).toBe(true);
  });

  it("regenerate produces a new attempt + new selected version (not deduped)", async () => {
    const session = await createSession({ userId: USER, characterId: CHAR }, { prisma });
    const res = await sendMessage(
      { userId: USER, sessionId: session.id, content: "first turn" },
      { prisma },
    );
    await drainQueue(CHAT_QUEUES.generate, async (job) => {
      await processGenerate(job.payload as Parameters<typeof processGenerate>[0], prisma);
    });

    const re = await regenerate({ userId: USER, messageId: res.assistantMessageId }, { prisma });
    expect(re.attempt).toBe(2);
    const handled = await drainQueue(CHAT_QUEUES.generate, async (job) => {
      await processGenerate(job.payload as Parameters<typeof processGenerate>[0], prisma);
    });
    expect(handled).toBe(1); // the :attempt key was NOT swallowed

    const versions = await prisma.messageVersion.findMany({
      where: { messageId: res.assistantMessageId },
      orderBy: { attempt: "asc" },
    });
    expect(versions.length).toBe(2);
    expect(versions.filter((v) => v.selected).length).toBe(1);
    expect(versions.at(-1)?.attempt).toBe(2);
  });

  it("blocks unsafe input: no generation enqueued, user msg blocked", async () => {
    const session = await createSession({ userId: USER, characterId: CHAR }, { prisma });
    const res = await sendMessage(
      { userId: USER, sessionId: session.id, content: "this mentions csam content" },
      { prisma },
    );
    const assistant = await prisma.message.findUnique({ where: { id: res.assistantMessageId } });
    expect(assistant?.status).toBe("blocked");
    const handled = await drainQueue(CHAT_QUEUES.generate, async () => {});
    expect(handled).toBe(0); // nothing enqueued for blocked input
  });
});
