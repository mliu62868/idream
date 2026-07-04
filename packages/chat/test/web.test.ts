// P0-3 + P1-1 acceptance via the dispatch surface (router) + memory derivation.
// Proves the full request path (create session → send → generate → read) and that
// memory is derived only from sent/allowed turns and skipped for no-memory sessions.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { createChatPrisma } from "../src/db.js";
import { dispatchChat } from "../src/router.js";
import { processGenerate, type GeneratePayload } from "../src/generate.js";
import { processMemoryExtract } from "../src/memory.js";
import { consumeInbound } from "../src/inbox.js";
import { drainQueue } from "../src/queue.js";
import { setNoMemory } from "../src/service.js";
import { CHAT_QUEUES, MAIN_TO_CHAT_EVENTS } from "@idream/shared/contracts";

const superPool = new Pool({ connectionString: process.env.CHAT_TEST_SUPER_URL });
const prisma = createChatPrisma();
let fsRoot: string;
const USER = "u_web";
const IMG_USER = "u_web_img";
const CHAR = "c_web";

beforeAll(async () => {
  fsRoot = await mkdtemp(path.join(tmpdir(), "chat-web-"));
  process.env.CHAT_FS_ROOT = fsRoot;
  await superPool.query(
    `INSERT INTO public.users (id,email,status,"createdAt","updatedAt") VALUES ($1,$2,'active',now(),now()) ON CONFLICT (id) DO NOTHING`,
    [USER, "web@test.dev"],
  );
  await superPool.query(
    `INSERT INTO public.users (id,email,status,"createdAt","updatedAt") VALUES ($1,$2,'active',now(),now()) ON CONFLICT (id) DO NOTHING`,
    [IMG_USER, "web-img@test.dev"],
  );
  await superPool.query(
    `INSERT INTO public.characters (id,name,age,description,visibility,status,style,gender,appearance,"advancedDetails","createdAt","updatedAt")
     VALUES ($1,'Web',23,'d','public','approved','realistic','female','{}','{}',now(),now()) ON CONFLICT (id) DO NOTHING`,
    [CHAR],
  );
});

afterAll(async () => {
  await superPool.end();
  await prisma.$disconnect();
  await rm(fsRoot, { recursive: true, force: true });
});

async function drainGen() {
  return drainQueue(CHAT_QUEUES.generate, async (job) => {
    await processGenerate(job.payload as GeneratePayload);
  });
}

describe("dispatchChat router", () => {
  it("create session → send message → read back sent reply", async () => {
    const created = await dispatchChat({
      method: "POST",
      path: "/api/v1/chat/sessions",
      userId: USER,
      body: { characterId: CHAR },
    });
    expect(created.kind).toBe("json");
    if (created.kind !== "json") return;
    expect(created.status).toBe(201);
    const sessionId = (created.body as { id: string }).id;

    const sent = await dispatchChat({
      method: "POST",
      path: `/api/v1/chat/sessions/${sessionId}/messages`,
      userId: USER,
      body: { content: "hi web" },
    });
    expect(sent.kind === "json" && sent.status).toBe(202);
    const assistantMessageId =
      sent.kind === "json" ? (sent.body as { assistantMessageId: string }).assistantMessageId : "";

    await drainGen();

    const read = await dispatchChat({
      method: "GET",
      path: `/api/v1/chat/sessions/${sessionId}`,
      userId: USER,
    });
    expect(read.kind).toBe("json");
    if (read.kind !== "json") return;
    const messages = (read.body as { messages: Array<{ id: string; status: string; role: string }> }).messages;
    const assistant = messages.find((m) => m.id === assistantMessageId);
    expect(assistant?.status).toBe("sent");
  });

  it("stream route returns an sse descriptor", async () => {
    const created = await dispatchChat({
      method: "POST",
      path: "/api/v1/chat/sessions",
      userId: USER,
      body: { characterId: CHAR },
    });
    const sessionId = created.kind === "json" ? (created.body as { id: string }).id : "";
    const sent = await dispatchChat({
      method: "POST",
      path: `/api/v1/chat/sessions/${sessionId}/messages`,
      userId: USER,
      body: { content: "stream auth check" },
    });
    const assistantMessageId =
      sent.kind === "json" ? (sent.body as { assistantMessageId: string }).assistantMessageId : "";

    const res = await dispatchChat({
      method: "GET",
      path: `/api/v1/chat/messages/${assistantMessageId}/stream`,
      userId: USER,
      query: { lastEventId: "0" },
    });
    expect(res.kind).toBe("sse");

    const foreign = await dispatchChat({
      method: "GET",
      path: `/api/v1/chat/messages/${assistantMessageId}/stream`,
      userId: "other_user",
      query: { lastEventId: "0" },
    });
    expect(foreign.kind === "json" && foreign.status).toBe(404);
  });

  it("executes agent-selected chat image tools by outbox and applies main callbacks", async () => {
    const oldMockPlan = process.env.CHAT_MOCK_TOOL_PLAN_JSON;
    process.env.CHAT_MOCK_TOOL_PLAN_JSON = JSON.stringify({
      tool: {
        name: "generate_image_async",
        arguments: {
          prompt: "Realistic in-character photo of Web sharing a quiet moment in the current chat scene",
          caption: "I'll make that image for you now.",
          orientation: "4:5",
          outputCount: 1,
        },
      },
    });
    try {
      const created = await dispatchChat({
        method: "POST",
        path: "/api/v1/chat/sessions",
        userId: IMG_USER,
        body: { characterId: CHAR },
      });
      const sessionId = created.kind === "json" ? (created.body as { id: string }).id : "";

      const sent = await dispatchChat({
        method: "POST",
        path: `/api/v1/chat/sessions/${sessionId}/messages`,
        userId: IMG_USER,
        body: { content: "send me a photo from this moment please" },
      });
      expect(sent.kind === "json" && sent.status).toBe(202);
      await drainGen();

      const read = await dispatchChat({
        method: "GET",
        path: `/api/v1/chat/sessions/${sessionId}`,
        userId: IMG_USER,
      });
      expect(read.kind).toBe("json");
      if (read.kind !== "json") return;
      const messages = (read.body as {
        messages: Array<{ attachments?: Array<{ id: string; status: string; promptHint?: string | null }> }>;
      }).messages;
      const attachment = messages.flatMap((message) => message.attachments ?? [])[0];
      expect(attachment).toMatchObject({
        status: "requesting",
        promptHint: "Realistic in-character photo of Web sharing a quiet moment in the current chat scene",
      });

      const outbox = await prisma.chatOutboxEvent.findFirst({
        where: { aggregateId: attachment.id, eventType: "chat.image.requested" },
      });
      expect(outbox?.payload).toMatchObject({
        attachmentId: attachment.id,
        promptHint: "Realistic in-character photo of Web sharing a quiet moment in the current chat scene",
        controls: { orientation: "4:5", outputCount: 1 },
      });

      await consumeInbound({
        eventId: `img_accept_${attachment.id}`,
        eventType: MAIN_TO_CHAT_EVENTS.chatImageAccepted,
        payload: {
          version: 1,
          kind: "chat.image.accepted",
          attachmentId: attachment.id,
          generationJobId: "job_img_1",
          costDreamcoins: 5,
        },
      });
      await consumeInbound({
        eventId: `img_done_${attachment.id}`,
        eventType: MAIN_TO_CHAT_EVENTS.chatImageCompleted,
        payload: {
          version: 1,
          kind: "chat.image.completed",
          attachmentId: attachment.id,
          generationJobId: "job_img_1",
          mediaAssetId: "media_img_1",
          width: 512,
          height: 640,
        },
      });

      const completed = await dispatchChat({
        method: "GET",
        path: `/api/v1/chat/sessions/${sessionId}`,
        userId: IMG_USER,
      });
      const completedMessages =
        completed.kind === "json"
          ? (completed.body as { messages: Array<{ attachments?: Array<{ status: string; mediaAssetId?: string }> }> }).messages
          : [];
      expect(completedMessages.flatMap((message) => message.attachments ?? [])[0]).toMatchObject({
        status: "completed",
        mediaAssetId: "media_img_1",
      });
    } finally {
      if (oldMockPlan === undefined) delete process.env.CHAT_MOCK_TOOL_PLAN_JSON;
      else process.env.CHAT_MOCK_TOOL_PLAN_JSON = oldMockPlan;
    }
  });

  it("unknown route → 404", async () => {
    const res = await dispatchChat({ method: "GET", path: "/api/v1/chat/nope", userId: USER });
    expect(res.kind === "json" && res.status).toBe(404);
  });
});

describe("memory.extract (P1-1)", () => {
  it("derives a preference from a 'call me X' turn and writes mem file", async () => {
    const created = await dispatchChat({ method: "POST", path: "/api/v1/chat/sessions", userId: USER, body: { characterId: CHAR } });
    const sessionId = created.kind === "json" ? (created.body as { id: string }).id : "";

    const sent = await dispatchChat({
      method: "POST",
      path: `/api/v1/chat/sessions/${sessionId}/messages`,
      userId: USER,
      body: { content: "please call me Alex" },
    });
    const assistantMessageId = sent.kind === "json" ? (sent.body as { assistantMessageId: string }).assistantMessageId : "";
    await drainGen();

    const res = await processMemoryExtract({ sessionId, assistantMessageId, attempt: 1 });
    expect(res.written).toBeGreaterThanOrEqual(1);

    const mem = await readFile(path.join(fsRoot, "mem", USER, CHAR, "memory.md"), "utf8");
    expect(mem).toContain("called Alex");
    expect(mem).toContain("src:"); // source back-link to PG message
  });

  it("no-memory session: derivation is skipped (privacy gate)", async () => {
    const created = await dispatchChat({ method: "POST", path: "/api/v1/chat/sessions", userId: USER, body: { characterId: CHAR } });
    const sessionId = created.kind === "json" ? (created.body as { id: string }).id : "";
    await setNoMemory({ userId: USER, sessionId, memoryEnabled: false });

    const sent = await dispatchChat({
      method: "POST",
      path: `/api/v1/chat/sessions/${sessionId}/messages`,
      userId: USER,
      body: { content: "call me Secret" },
    });
    const assistantMessageId = sent.kind === "json" ? (sent.body as { assistantMessageId: string }).assistantMessageId : "";
    await drainGen();

    const res = await processMemoryExtract({ sessionId, assistantMessageId, attempt: 1 });
    expect(res.skipped).toBe("no_memory_session");
    expect(res.written).toBe(0);
  });
});
