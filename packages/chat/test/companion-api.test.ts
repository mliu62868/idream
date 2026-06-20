// AI-companion management API acceptance (PRD §8.2, §12): memory + relationship
// management and delete-message → forget source linkage, end-to-end over the
// router against PG + the file layer.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { createChatPrisma } from "../src/db.js";
import { dispatchChat, type ChatResponse } from "../src/router.js";
import { processGenerate, type GeneratePayload } from "../src/generate.js";
import { processMemoryExtract } from "../src/memory.js";
import { drainQueue } from "../src/queue.js";
import { CHAT_QUEUES } from "@idream/shared/contracts";

const prisma = createChatPrisma();
const superPool = new Pool({ connectionString: process.env.CHAT_TEST_SUPER_URL });
let fsRoot: string;
const USER = "u_capi";
const CHAR = "c_capi";

function jbody<T>(res: ChatResponse): T {
  if (res.kind !== "json") throw new Error("expected json response");
  return res.body as T;
}

/** create session → send a memory-seeding message → generate → extract memory. */
async function seedMemory(content: string): Promise<{ sessionId: string; userMessageId: string }> {
  const created = await dispatchChat({ method: "POST", path: "/api/v1/chat/sessions", userId: USER, body: { characterId: CHAR } });
  const sessionId = jbody<{ id: string }>(created).id;
  const sent = await dispatchChat({
    method: "POST",
    path: `/api/v1/chat/sessions/${sessionId}/messages`,
    userId: USER,
    body: { content },
  });
  const { assistantMessageId, userMessageId } = jbody<{ assistantMessageId: string; userMessageId: string }>(sent);
  await drainQueue(CHAT_QUEUES.generate, async (job) => {
    await processGenerate(job.payload as GeneratePayload, prisma);
  });
  await processMemoryExtract({ sessionId, assistantMessageId, attempt: 1 }, prisma);
  return { sessionId, userMessageId };
}

beforeAll(async () => {
  fsRoot = await mkdtemp(path.join(tmpdir(), "chat-capi-"));
  process.env.CHAT_FS_ROOT = fsRoot;
  await superPool.query(
    `INSERT INTO public.users (id,email,status,"createdAt","updatedAt") VALUES ($1,$2,'active',now(),now()) ON CONFLICT (id) DO NOTHING`,
    [USER, "capi@test.dev"],
  );
  await superPool.query(
    `INSERT INTO public.characters (id,name,age,description,visibility,status,style,gender,appearance,"advancedDetails","createdAt","updatedAt")
     VALUES ($1,'CAPI',25,'d','public','approved','realistic','female','{}','{}',now(),now()) ON CONFLICT (id) DO NOTHING`,
    [CHAR],
  );
});

afterAll(async () => {
  await prisma.$disconnect();
  await superPool.end();
  await rm(fsRoot, { recursive: true, force: true });
});

describe("memory management API", () => {
  it("lists, edits, and deletes long-term memory", async () => {
    await seedMemory("call me Robin and i like jazz");

    const listed = jbody<{ memories: Array<{ id: string; text: string }> }>(
      await dispatchChat({ method: "GET", path: "/api/v1/chat/memories", userId: USER, query: { characterId: CHAR } }),
    );
    const mem = listed.memories.find((m) => m.text.includes("Robin"));
    expect(mem).toBeDefined();
    expect(mem!.id).toMatch(/^mem_/);

    // PATCH edits text in place, id stays stable
    const patched = jbody<{ id: string; text: string }>(
      await dispatchChat({ method: "PATCH", path: `/api/v1/chat/memories/${mem!.id}`, userId: USER, body: { text: "User likes being called Bobby." } }),
    );
    expect(patched.id).toBe(mem!.id);
    expect(patched.text).toBe("User likes being called Bobby.");

    // DELETE removes it from the authority file
    const del = await dispatchChat({ method: "DELETE", path: `/api/v1/chat/memories/${mem!.id}`, userId: USER });
    expect(del.kind === "json" && del.status).toBe(200);
    const after = jbody<{ memories: Array<{ id: string }> }>(
      await dispatchChat({ method: "GET", path: "/api/v1/chat/memories", userId: USER }),
    );
    expect(after.memories.find((m) => m.id === mem!.id)).toBeUndefined();

    // unknown id → 404
    const miss = await dispatchChat({ method: "DELETE", path: "/api/v1/chat/memories/mem_nope", userId: USER });
    expect(miss.kind === "json" && miss.status).toBe(404);
  });
});

describe("delete message forgets derived memory (privacy §12)", () => {
  it("removes source-linked memory when the message is deleted", async () => {
    const { userMessageId } = await seedMemory("please call me Sky");

    const before = jbody<{ memories: Array<{ text: string; sourceMessageIds: string[] }> }>(
      await dispatchChat({ method: "GET", path: "/api/v1/chat/memories", userId: USER, query: { characterId: CHAR } }),
    );
    expect(before.memories.some((m) => m.sourceMessageIds.includes(userMessageId))).toBe(true);

    const del = await dispatchChat({ method: "DELETE", path: `/api/v1/chat/messages/${userMessageId}`, userId: USER });
    expect(del.kind === "json" && del.status).toBe(200);

    const after = jbody<{ memories: Array<{ sourceMessageIds: string[] }> }>(
      await dispatchChat({ method: "GET", path: "/api/v1/chat/memories", userId: USER, query: { characterId: CHAR } }),
    );
    expect(after.memories.some((m) => m.sourceMessageIds.includes(userMessageId))).toBe(false);
  });

  it("reaches delete via the bare /api/v1/messages/:id path (BFF proxy convention)", async () => {
    const { userMessageId } = await seedMemory("call me Nova");
    const del = await dispatchChat({ method: "DELETE", path: `/api/v1/messages/${userMessageId}`, userId: USER });
    expect(del.kind === "json" && del.status).toBe(200);
    const after = jbody<{ memories: Array<{ sourceMessageIds: string[] }> }>(
      await dispatchChat({ method: "GET", path: "/api/v1/chat/memories", userId: USER, query: { characterId: CHAR } }),
    );
    expect(after.memories.some((m) => m.sourceMessageIds.includes(userMessageId))).toBe(false);
  });
});

describe("SSE stream aliases (PRD §8.2)", () => {
  it("serves both /messages/:id/stream and /streams/:id", async () => {
    const viaMessages = await dispatchChat({ method: "GET", path: "/api/v1/chat/messages/msg_x/stream", userId: USER });
    const viaStreams = await dispatchChat({ method: "GET", path: "/api/v1/chat/streams/msg_x", userId: USER });
    expect(viaMessages.kind).toBe("sse");
    expect(viaStreams.kind).toBe("sse");
    expect(viaMessages.kind === "sse" && viaMessages.streamKey).toBe(
      viaStreams.kind === "sse" ? viaStreams.streamKey : "",
    );
  });
});

describe("relationship management API", () => {
  it("lists, reads, edits, and resets the companion bond", async () => {
    await seedMemory("hey there, nice to meet you");

    const listed = jbody<{ relationships: Array<{ characterId: string; stage: string }> }>(
      await dispatchChat({ method: "GET", path: "/api/v1/chat/relationships", userId: USER }),
    );
    expect(listed.relationships.some((r) => r.characterId === CHAR)).toBe(true);

    const one = jbody<{ characterId: string; version: number }>(
      await dispatchChat({ method: "GET", path: `/api/v1/chat/relationships/${CHAR}`, userId: USER }),
    );
    expect(one.characterId).toBe(CHAR);

    const patched = jbody<{ summary: string; stage: string; version: number }>(
      await dispatchChat({ method: "PATCH", path: `/api/v1/chat/relationships/${CHAR}`, userId: USER, body: { summary: "We are close friends.", stage: "close" } }),
    );
    expect(patched.summary).toBe("We are close friends.");
    expect(patched.stage).toBe("close");
    expect(patched.version).toBe(one.version + 1);

    const del = await dispatchChat({ method: "DELETE", path: `/api/v1/chat/relationships/${CHAR}`, userId: USER });
    expect(del.kind === "json" && del.status).toBe(200);
    // after reset → fresh EMPTY state (version 0)
    const reset = jbody<{ version: number; stage: string }>(
      await dispatchChat({ method: "GET", path: `/api/v1/chat/relationships/${CHAR}`, userId: USER }),
    );
    expect(reset.version).toBe(0);
    expect(reset.stage).toBe("new");
  });
});
