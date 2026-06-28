// P0 semantic-fix acceptance (CHAT_SERVICE_CAPABILITY_COMPLETION_PLAN §6):
//   P0-C daily free quota, P0-D policy model written, P0-E no-memory writes no
//   session.jsonl / derives no memory, P0-F user.deleted erases the chat domain,
//   P0-G boundaries fail closed. Runs over PG + the file layer like hot-path.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { createChatPrisma } from "../src/db.js";
import { ChatError, createSession, sendMessage, setNoMemory } from "../src/service.js";
import { processGenerate, type GeneratePayload } from "../src/generate.js";
import { processMemoryExtract } from "../src/memory.js";
import { modelForTier } from "../src/policy.js";
import { setRelationship } from "../src/relationship.js";
import { consumeInbound } from "../src/inbox.js";
import { drainQueue, obliterate } from "../src/queue.js";
import { CHAT_QUEUES, MAIN_TO_CHAT_EVENTS } from "@idream/shared/contracts";

const prisma = createChatPrisma();
const superPool = new Pool({ connectionString: process.env.CHAT_TEST_SUPER_URL });
let fsRoot: string;

const USERS = ["u_p0_quota", "u_p0_nomem", "u_p0_bound", "u_p0_erase", "u_p0_model", "u_p1_rel"] as const;
const CHAR = "c_p0";

async function exists(p: string): Promise<boolean> {
  return access(p).then(() => true, () => false);
}

async function generateOnce(): Promise<number> {
  return drainQueue(CHAT_QUEUES.generate, async (job) => {
    await processGenerate(job.payload as GeneratePayload, prisma);
  });
}

beforeAll(async () => {
  fsRoot = await mkdtemp(path.join(tmpdir(), "chat-p0-"));
  process.env.CHAT_FS_ROOT = fsRoot;
  await obliterate(CHAT_QUEUES.generate).catch(() => {});
  await obliterate(CHAT_QUEUES.memoryExtract).catch(() => {});

  for (const u of USERS) {
    await superPool.query(
      `INSERT INTO public.users (id,email,status,"createdAt","updatedAt") VALUES ($1,$2,'active',now(),now()) ON CONFLICT (id) DO NOTHING`,
      [u, `${u}@test.dev`],
    );
  }
  await superPool.query(
    `INSERT INTO public.characters (id,name,age,description,visibility,status,style,gender,appearance,"advancedDetails","createdAt","updatedAt")
     VALUES ($1,'P0',24,'d','public','approved','realistic','female','{}','{}',now(),now()) ON CONFLICT (id) DO NOTHING`,
    [CHAR],
  );
});

afterAll(async () => {
  await prisma.$disconnect();
  await superPool.end();
  await rm(fsRoot, { recursive: true, force: true });
});

describe("P0-C: free daily quota = 30", () => {
  it("blocks the 31st free message in the same UTC day with 402 quota_exceeded", async () => {
    const user = "u_p0_quota";
    const session = await createSession({ userId: user, characterId: CHAR }, { prisma });
    // Pre-seed today's usage at the cap (avoids 30 real generations).
    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    await prisma.chatUsage.upsert({
      where: { userId_periodStart: { userId: user, periodStart } },
      update: { messagesUsed: 30 },
      create: { id: `usage_${user}`, userId: user, sessionId: session.id, messagesUsed: 30, periodStart, periodEnd },
    });

    await expect(
      sendMessage({ userId: user, sessionId: session.id, content: "one more please" }, { prisma }),
    ).rejects.toMatchObject({ code: "quota_exceeded", status: 402 });
  });
});

describe("P0-E: no-memory / incognito", () => {
  it("writes no session.jsonl and derives no long-term memory", async () => {
    const user = "u_p0_nomem";
    const session = await createSession({ userId: user, characterId: CHAR }, { prisma });
    await setNoMemory({ userId: user, sessionId: session.id, memoryEnabled: false }, { prisma });

    const sent = await sendMessage(
      { userId: user, sessionId: session.id, content: "please call me Quill and i like tea" },
      { prisma },
    );
    expect(sent.status).toBe("generating");
    expect(await generateOnce()).toBe(1);

    // No agent trace file for an incognito session.
    const jsonl = path.join(fsRoot, "sessions", user, `${session.id}.jsonl`);
    expect(await exists(jsonl)).toBe(false);

    // No memory.extract job enqueued, and no memory file written.
    expect(await drainQueue(CHAT_QUEUES.memoryExtract, async () => {})).toBe(0);
    expect(await exists(path.join(fsRoot, "mem", user, CHAR, "memory.md"))).toBe(false);

    // The PG message history still exists for the active session.
    const msgs = await prisma.message.findMany({ where: { sessionId: session.id } });
    expect(msgs.length).toBeGreaterThanOrEqual(2);
  });
});

describe("P0-D: policy model is written to the message", () => {
  it("persists the tier-resolved model on the assistant message", async () => {
    const user = "u_p0_model";
    const session = await createSession({ userId: user, characterId: CHAR }, { prisma });
    const sent = await sendMessage({ userId: user, sessionId: session.id, content: "hi" }, { prisma });
    expect(await generateOnce()).toBe(1);
    const assistant = await prisma.message.findUnique({ where: { id: sent.assistantMessageId } });
    expect(assistant?.status).toBe("sent");
    expect(assistant?.model).toBe(modelForTier("free"));
  });
});

describe("P0-G: boundaries fail closed", () => {
  it("aborts generation (no boundary-less reply) when the boundaries file can't be read", async () => {
    const user = "u_p0_bound";
    // Sabotage the boundaries read: put a DIRECTORY where the file should be → EISDIR.
    await mkdir(path.join(fsRoot, "mem", user, "global", "boundaries.md"), { recursive: true });

    const session = await createSession({ userId: user, characterId: CHAR }, { prisma });
    const sent = await sendMessage({ userId: user, sessionId: session.id, content: "hello there" }, { prisma });
    // The generate job fails (handler throws inside buildContext) — drain reports 0 completed.
    const handled = await generateOnce();
    expect(handled).toBe(0);
    const assistant = await prisma.message.findUnique({ where: { id: sent.assistantMessageId } });
    // Fail closed: the assistant turn never reaches "sent" with missing boundaries.
    expect(assistant?.status).not.toBe("sent");
  });
});

describe("P1-B: relationship state is injected into the model context", () => {
  it("includes the qualitative bond tone + summary in the system prompt", async () => {
    const user = "u_p1_rel";
    // Establish a 'close' bond before the turn (file-layer authority).
    await setRelationship(user, CHAR, { stage: "close", summary: "We share inside jokes about sailing." });

    const session = await createSession({ userId: user, characterId: CHAR }, { prisma });
    const sent = await sendMessage({ userId: user, sessionId: session.id, content: "hey you" }, { prisma });
    expect(await generateOnce()).toBe(1);

    // The agent trace records the exact system prompt the model received.
    const jsonl = await readFile(path.join(fsRoot, "sessions", user, `${session.id}.jsonl`), "utf8");
    const turn = JSON.parse(jsonl.trim().split("\n")[0]) as { system: string };
    expect(turn.system).toContain("Relationship:");
    expect(turn.system).toContain("comfortable intimacy"); // 'close' stage tone
    expect(turn.system).toContain("inside jokes about sailing"); // narrative summary
    expect(sent.status).toBe("generating");
  });
});

describe("P0-F: user.deleted erases the chat domain", () => {
  it("removes PG rows + file layer and emits chat.account_erasure.completed", async () => {
    const user = "u_p0_erase";
    const session = await createSession({ userId: user, characterId: CHAR }, { prisma });
    const sent = await sendMessage(
      { userId: user, sessionId: session.id, content: "remember i like sailing" },
      { prisma },
    );
    expect(await generateOnce()).toBe(1);
    await processMemoryExtract(
      { sessionId: session.id, assistantMessageId: sent.assistantMessageId, attempt: 1 },
      prisma,
    );
    // Pre-conditions: rows + files exist.
    expect(await prisma.chatSession.count({ where: { userId: user } })).toBeGreaterThan(0);
    expect(await exists(path.join(fsRoot, "sessions", user))).toBe(true);

    await consumeInbound(
      { eventId: `evt_del_${user}`, eventType: MAIN_TO_CHAT_EVENTS.userDeleted, payload: { userId: user } },
      prisma,
    );

    // PG: all chat rows for the user are gone.
    expect(await prisma.chatSession.count({ where: { userId: user } })).toBe(0);
    expect(await prisma.chatUsage.count({ where: { userId: user } })).toBe(0);
    // File layer: both tenant prefixes wiped.
    expect(await exists(path.join(fsRoot, "sessions", user))).toBe(false);
    expect(await exists(path.join(fsRoot, "mem", user))).toBe(false);
    // Completion event recorded for main to observe.
    const outbox = await prisma.chatOutboxEvent.findMany({ where: { aggregateId: user } });
    expect(outbox.some((e) => e.eventType === "chat.account_erasure.completed")).toBe(true);
  });
});
