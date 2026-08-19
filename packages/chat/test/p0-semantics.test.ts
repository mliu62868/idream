// P0 semantic-fix acceptance (CHAT_SERVICE_CAPABILITY_COMPLETION_PLAN §6):
//   P0-C daily free quota, P0-D policy model written, P0-E no-memory writes no
//   session.jsonl / derives no memory, P0-F user.deleted erases the chat domain,
//   P0-G boundaries fail closed. Runs over PG + the file layer like hot-path.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FREE_DAILY_MESSAGES } from "@idream/shared/chat/limits";
import { mkdtemp, mkdir, rm, access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { createChatPrisma } from "../src/db.js";
import { ChatError, createSession, sendMessage, setNoMemory } from "../src/service.js";
import { processGenerate, type GeneratePayload } from "../src/generate.js";
import { processMemoryExtract } from "../src/memory.js";
import { reconcile } from "../src/reconcile.js";
import { modelForTier } from "../src/policy.js";
import { setRelationshipOnce } from "../src/relationship.js";
import { drainQueue, obliterate } from "../src/queue.js";
import { CHAT_QUEUES, MAIN_TO_CHAT_EVENTS } from "@idream/shared/contracts";
import { acceptAgeGate, ingestMainEvent } from "./fixtures.js";

const prisma = createChatPrisma();
const superPool = new Pool({ connectionString: process.env.CHAT_TEST_SUPER_URL });
let fsRoot: string;

const USERS = [
  "u_p0_quota",
  "u_p0_nomem",
  "u_p0_nomem_summary",
  "u_p0_nomem_inflight",
  "u_p0_legacy_memory",
  "u_p0_nomem_replay",
  "u_p0_bound",
  "u_p0_bound_nomem",
  "u_p0_erase",
  "u_p0_model",
  "u_p1_rel",
] as const;
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
  await acceptAgeGate(superPool, USERS);
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

describe("P0-C: free daily quota", () => {
  it("blocks the first message beyond the daily cap with 402 quota_exceeded", async () => {
    const user = "u_p0_quota";
    const session = await createSession({ userId: user, characterId: CHAR }, { prisma });
    // Pre-seed today's usage at the cap (avoids 30 real generations).
    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    await prisma.chatUsage.upsert({
      where: { userId_periodStart: { userId: user, periodStart } },
      update: { messagesUsed: FREE_DAILY_MESSAGES },
      create: {
        id: `usage_${user}`,
        userId: user,
        sessionId: session.id,
        messagesUsed: FREE_DAILY_MESSAGES,
        periodStart,
        periodEnd,
      },
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

    const captured = await prisma.message.findUniqueOrThrow({
      where: { id: sent.assistantMessageId },
    });
    expect(captured.memoryAuthority).toBe("disabled");

    // Re-enable before either worker runs. The immutable turn authority must
    // still win over this later session preference.
    await setNoMemory({ userId: user, sessionId: session.id, memoryEnabled: true }, { prisma });
    expect(await generateOnce()).toBe(1);

    // No agent trace file for an incognito session.
    const jsonl = path.join(fsRoot, "sessions", user, `${session.id}.jsonl`);
    expect(await exists(jsonl)).toBe(false);

    // Scene advances off the hot path even in incognito mode. The same job must
    // not write memory, relationship evidence, summary, or file-layer traces.
    expect(await drainQueue(CHAT_QUEUES.memoryExtract, async (job) => {
      expect(
        await processMemoryExtract(job.payload as Parameters<typeof processMemoryExtract>[0], prisma),
      ).toEqual({ written: 0, skipped: "scene_only_memory_disabled" });
    })).toBe(1);
    expect(await exists(path.join(fsRoot, "mem", user, CHAR, "memory.md"))).toBe(false);
    expect(await exists(path.join(fsRoot, "mem", user, CHAR, "relationship.md"))).toBe(false);
    expect(await prisma.chatSceneRevision.count({
      where: { sessionId: session.id, sourceAssistantMessageId: sent.assistantMessageId },
    })).toBe(1);

    // Compensation must use the same immutable authority, not the restored flag.
    // Other sequential test files can leave unrelated recoverable rows in this
    // shared throwaway DB, so inspect exact scheduled payloads instead of a
    // process-global count.
    await obliterate(CHAT_QUEUES.memoryExtract);
    await reconcile(prisma);
    const reconciledAssistantIds: string[] = [];
    await drainQueue(CHAT_QUEUES.memoryExtract, async (job) => {
      reconciledAssistantIds.push(
        (job.payload as { assistantMessageId: string }).assistantMessageId,
      );
    });
    expect(reconciledAssistantIds).not.toContain(sent.assistantMessageId);
    await obliterate(CHAT_QUEUES.memoryExtract);
    await obliterate(CHAT_QUEUES.generate);

    // The PG message history still exists for the active session.
    const msgs = await prisma.message.findMany({ where: { sessionId: session.id } });
    expect(msgs.length).toBeGreaterThanOrEqual(2);
  });

  it("clears the rolling summary when memory is disabled", async () => {
    const user = "u_p0_nomem_summary";
    const session = await createSession({ userId: user, characterId: CHAR }, { prisma });

    await sendMessage(
      { userId: user, sessionId: session.id, content: "remember this summary seed" },
      { prisma },
    );
    expect(await generateOnce()).toBe(1);
    // Seeded directly: turns no longer write memorySummary, but disabling memory
    // still has to clear whatever a pre-existing row is carrying.
    await prisma.chatSession.update({
      where: { id: session.id },
      data: { memorySummary: "legacy summary seed" },
    });

    await setNoMemory({ userId: user, sessionId: session.id, memoryEnabled: false }, { prisma });
    expect((await prisma.chatSession.findUnique({ where: { id: session.id } }))?.memorySummary).toBeNull();

    await sendMessage(
      { userId: user, sessionId: session.id, content: "this should not enter summary" },
      { prisma },
    );
    expect(await generateOnce()).toBe(1);
    expect((await prisma.chatSession.findUnique({ where: { id: session.id } }))?.memorySummary).toBeNull();
  });

  it("replays the original disabled authority after the session is restored", async () => {
    const user = "u_p0_nomem_replay";
    const session = await createSession({ userId: user, characterId: CHAR }, { prisma });
    await setNoMemory({ userId: user, sessionId: session.id, memoryEnabled: false }, { prisma });
    const request = {
      userId: user,
      sessionId: session.id,
      content: "do not remember this replay",
      idempotencyKey: "p0-no-memory-replay",
    };
    const first = await sendMessage(request, { prisma });
    await setNoMemory({ userId: user, sessionId: session.id, memoryEnabled: true }, { prisma });
    const replay = await sendMessage(request, { prisma });

    expect(replay.assistantMessageId).toBe(first.assistantMessageId);
    expect(replay.userMessageId).toBe(first.userMessageId);
    expect(
      (await prisma.message.findUniqueOrThrow({ where: { id: first.assistantMessageId } }))
        .memoryAuthority,
    ).toBe("disabled");
    expect(await prisma.message.count({ where: { sessionId: session.id } })).toBe(2);
    expect(await generateOnce()).toBe(1);
  });

  it("does not repopulate a cleared summary from an enabled in-flight turn", async () => {
    const user = "u_p0_nomem_inflight";
    const session = await createSession({ userId: user, characterId: CHAR }, { prisma });
    const sent = await sendMessage(
      { userId: user, sessionId: session.id, content: "enabled before the toggle" },
      { prisma },
    );
    expect(
      (await prisma.message.findUniqueOrThrow({ where: { id: sent.assistantMessageId } }))
        .memoryAuthority,
    ).toBe("enabled");

    await setNoMemory({ userId: user, sessionId: session.id, memoryEnabled: false }, { prisma });
    expect(await generateOnce()).toBe(1);
    expect((await prisma.chatSession.findUnique({ where: { id: session.id } }))?.memorySummary).toBeNull();
    await obliterate(CHAT_QUEUES.memoryExtract);
  });

  it("fails historical unknown turn authority closed", async () => {
    const user = "u_p0_legacy_memory";
    const session = await createSession({ userId: user, characterId: CHAR }, { prisma });
    const source = await prisma.message.create({
      data: {
        id: "msg_p0_legacy_memory_user",
        sessionId: session.id,
        role: "user",
        content: "call me Historical",
        status: "sent",
        safetyStatus: "passed",
      },
    });
    const assistant = await prisma.message.create({
      data: {
        id: "msg_p0_legacy_memory_assistant",
        sessionId: session.id,
        role: "assistant",
        content: "Hello.",
        status: "sent",
        safetyStatus: "passed",
        replyToMessageId: source.id,
      },
    });

    expect(assistant.memoryAuthority).toBe("legacy_unknown");
    expect(
      await processMemoryExtract(
        {
          sessionId: session.id,
          assistantMessageId: assistant.id,
          userMessageId: source.id,
          attempt: 1,
        },
        prisma,
      ),
    ).toEqual({ written: 0, skipped: "scene_only_legacy_unknown" });
    expect(await prisma.chatSceneRevision.count({
      where: { sessionId: session.id, sourceAssistantMessageId: assistant.id },
    })).toBe(1);
    expect(await exists(path.join(fsRoot, "mem", user, CHAR, "memory.md"))).toBe(false);
    expect(await exists(path.join(fsRoot, "mem", user, CHAR, "relationship.md"))).toBe(false);
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

  it("keeps global boundaries active when session memory is disabled", async () => {
    const user = "u_p0_bound_nomem";
    await mkdir(path.join(fsRoot, "mem", user, "global", "boundaries.md"), { recursive: true });

    const session = await createSession({ userId: user, characterId: CHAR }, { prisma });
    await setNoMemory({ userId: user, sessionId: session.id, memoryEnabled: false }, { prisma });
    const sent = await sendMessage({ userId: user, sessionId: session.id, content: "hello there" }, { prisma });

    expect(await generateOnce()).toBe(0);
    const assistant = await prisma.message.findUnique({ where: { id: sent.assistantMessageId } });
    expect(assistant?.status).not.toBe("sent");
  });
});

describe("P1-B: relationship state is injected into the model context", () => {
  it("includes the qualitative bond tone + summary in the system prompt", async () => {
    const user = "u_p1_rel";
    // Establish a 'close' bond before the turn (file-layer authority).
    await setRelationshipOnce(user, CHAR, "p1_b_seed", { stage: "close", summary: "We share inside jokes about sailing." });

    const session = await createSession({ userId: user, characterId: CHAR }, { prisma });
    const sent = await sendMessage({ userId: user, sessionId: session.id, content: "hey you" }, { prisma });
    expect(await generateOnce()).toBe(1);

    // The agent trace records the exact system prompt the model received.
    const jsonl = await readFile(path.join(fsRoot, "sessions", user, `${session.id}.jsonl`), "utf8");
    const turn = JSON.parse(jsonl.trim().split("\n")[0]) as { system: string };
    expect(turn.system).toContain("Relationship State");
    expect(turn.system).toContain("comfortable intimacy"); // 'close' stage tone
    expect(turn.system).toContain("inside jokes about sailing"); // narrative summary
    expect(sent.status).toBe("generating");
  });
});

describe("P0-F: account deletion v2 erases the chat domain", () => {
  it("removes PG rows + file layer and emits request-bound v2 completion", async () => {
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

    await ingestMainEvent(
      {
        sourceEventId: `evt_del_${user}`,
        eventType: MAIN_TO_CHAT_EVENTS.accountDeletionRequestedV2,
        schemaVersion: 2,
        occurredAt: new Date().toISOString(),
        aggregateType: "user",
        aggregateId: user,
        payload: { userId: user },
      },
      prisma,
    );

    // PG: all chat rows for the user are gone.
    expect(await prisma.chatSession.count({ where: { userId: user } })).toBe(0);
    expect(await prisma.chatUsage.count({ where: { userId: user } })).toBe(0);
    // File layer: both tenant prefixes wiped.
    expect(await exists(path.join(fsRoot, "sessions", user))).toBe(false);
    expect(await exists(path.join(fsRoot, "mem", user))).toBe(false);
    // Completion event recorded for main to observe.
    const firstCompletion = await prisma.chatOutboxEvent.findFirstOrThrow({
      where: {
        aggregateId: user,
        eventType: "chat.account_erasure.completed.v2",
      },
    });
    expect(firstCompletion.payload).toMatchObject({
      version: 2,
      binding: "request_bound",
      deletionRequestEventId: `evt_del_${user}`,
    });

    // A pre-authority deployment may already have completed Chat erasure. A
    // later Main backfill uses a new request identity and must receive its own
    // causally bound completion instead of being suppressed by the legacy row.
    await prisma.chatOutboxEvent.update({
      where: { id: firstCompletion.id },
      data: { status: "delivered", deliveredAt: new Date() },
    });
    const backfillRequestId = `evt_del_${user}_backfill`;
    await ingestMainEvent(
      {
        sourceEventId: backfillRequestId,
        eventType: MAIN_TO_CHAT_EVENTS.accountDeletionRequestedV2,
        schemaVersion: 2,
        occurredAt: new Date().toISOString(),
        aggregateType: "user",
        aggregateId: user,
        payload: { userId: user },
      },
      prisma,
    );
    const backfillCompletion = await prisma.chatOutboxEvent.findFirstOrThrow({
      where: {
        aggregateId: user,
        eventType: "chat.account_erasure.completed.v2",
        payload: {
          path: ["deletionRequestEventId"],
          equals: backfillRequestId,
        },
      },
    });
    expect(backfillCompletion.payload).toMatchObject({
      deletionRequestEventId: backfillRequestId,
    });
  });
});
