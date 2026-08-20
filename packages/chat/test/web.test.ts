// Acceptance via the dispatch surface (router) + post-turn derivation.
// Proves the full request path and that Chat derives only Scene/relationship;
// generic memory belongs to official igrep inside DSH.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { createChatPrisma } from "../src/db.js";
import { dispatchChat } from "../src/router.js";
import { processGenerate, type GeneratePayload } from "../src/generate.js";
import { processMemoryExtract } from "../src/memory.js";
import { drainQueue } from "../src/queue.js";
import { setNoMemory } from "../src/service.js";
import { CHAT_QUEUES } from "@idream/shared/contracts";
import { acceptAgeGate } from "./fixtures.js";

const superPool = new Pool({ connectionString: process.env.CHAT_TEST_SUPER_URL });
const prisma = createChatPrisma();
let fsRoot: string;
const USER = "u_web";
const CHAR = "c_web";

beforeAll(async () => {
  fsRoot = await mkdtemp(path.join(tmpdir(), "chat-web-"));
  process.env.CHAT_FS_ROOT = fsRoot;
  await superPool.query(
    `INSERT INTO public.users (id,email,status,"createdAt","updatedAt") VALUES ($1,$2,'active',now(),now()) ON CONFLICT (id) DO NOTHING`,
    [USER, "web@test.dev"],
  );
  await superPool.query(
    `INSERT INTO public.characters (id,name,age,description,visibility,status,style,gender,appearance,"advancedDetails","createdAt","updatedAt")
     VALUES ($1,'Web',23,'d','public','approved','realistic','female','{}','{}',now(),now()) ON CONFLICT (id) DO NOTHING`,
    [CHAR],
  );
  await acceptAgeGate(superPool, [USER]);
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

    const voiceAuthority = await dispatchChat({
      method: "GET",
      path: `/api/v1/chat/sessions/${sessionId}/messages/${assistantMessageId}/voice-authority`,
      userId: USER,
    });
    expect(voiceAuthority).toMatchObject({
      kind: "json",
      status: 200,
      body: {
        sessionId,
        messageId: assistantMessageId,
        characterId: CHAR,
        attempt: 1,
      },
    });
    if (voiceAuthority.kind === "json") {
      expect((voiceAuthority.body as { text: string }).text.length).toBeGreaterThan(0);
    }
    const foreignVoiceAuthority = await dispatchChat({
      method: "GET",
      path: `/api/v1/chat/sessions/${sessionId}/messages/${assistantMessageId}/voice-authority`,
      userId: "other_user",
    });
    expect(foreignVoiceAuthority).toMatchObject({ kind: "json", status: 404 });
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

  it("unknown route → 404", async () => {
    const res = await dispatchChat({ method: "GET", path: "/api/v1/chat/nope", userId: USER });
    expect(res.kind === "json" && res.status).toBe(404);
  });
});

describe("post-turn Scene/relationship projection", () => {
  it("projects relationship evidence without writing generic memory", async () => {
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
    expect(res).toEqual({ written: 0, skipped: null });

    const relationship = await readFile(
      path.join(fsRoot, "mem", USER, CHAR, "relationship.md"),
      "utf8",
    );
    expect(relationship).toContain("meaningful self-disclosure");
    await expect(
      readFile(path.join(fsRoot, "mem", USER, CHAR, "memory.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("no-memory session: advances Scene but skips cross-session derivation", async () => {
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
    expect(res.skipped).toBe("scene_only_memory_disabled");
    expect(res.written).toBe(0);
    expect(await prisma.chatSceneRevision.count({
      where: { sessionId, sourceAssistantMessageId: assistantMessageId },
    })).toBe(1);
    expect(await prisma.chatFileMutation.count({
      where: { userId: USER, kind: "memory_extract" },
    })).toBe(0);
  });
});
