// AI-companion management API acceptance (PRD §8.2, §12): relationship reset,
// message deletion and SSE aliases over the router against PG + the file layer.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { createChatPrisma } from "../src/db.js";
import { dispatchChat, type ChatResponse } from "../src/router.js";
import type { GeneratePayload } from "../src/generate.js";
import { processMemoryExtract } from "../src/memory.js";
import { drainQueue } from "../src/queue.js";
import { CHAT_QUEUES } from "@idream/shared/contracts";
import { acceptAgeGate } from "./fixtures.js";
import {
  processGenerateWithTestDsh,
  testCompanionWorkspaceFetch,
} from "./dsh-fixtures.js";

const prisma = createChatPrisma();
const superPool = new Pool({ connectionString: process.env.CHAT_TEST_SUPER_URL });
let fsRoot: string;
const USER = "u_capi";
const CHAR = "c_capi";

function jbody<T>(res: ChatResponse): T {
  if (res.kind !== "json") throw new Error("expected json response");
  return res.body as T;
}

/** Create one complete turn and settle the structured Scene/relationship job. */
async function seedTurn(content: string): Promise<{ sessionId: string; userMessageId: string; assistantMessageId: string }> {
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
    await processGenerateWithTestDsh(job.payload as GeneratePayload, prisma);
  });
  await processMemoryExtract({
    sessionId,
    userMessageId,
    assistantMessageId,
    attempt: 1,
  }, prisma);
  return { sessionId, userMessageId, assistantMessageId };
}

beforeAll(async () => {
  vi.stubGlobal("fetch", testCompanionWorkspaceFetch());
  fsRoot = await mkdtemp(path.join(tmpdir(), "chat-capi-"));
  process.env.CHAT_FS_ROOT = fsRoot;
  await superPool.query(
    `INSERT INTO public.users (id,email,status,"createdAt","updatedAt") VALUES ($1,$2,'active',now(),now()) ON CONFLICT (id) DO NOTHING`,
    [USER, "capi@test.dev"],
  );
  await acceptAgeGate(superPool, [USER]);
  await superPool.query(
    `INSERT INTO public.characters (id,name,age,description,visibility,status,style,gender,appearance,"advancedDetails","createdAt","updatedAt")
     VALUES ($1,'CAPI',25,'d','public','approved','realistic','female','{}','{}',now(),now()) ON CONFLICT (id) DO NOTHING`,
    [CHAR],
  );
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await prisma.$disconnect();
  await superPool.end();
  await rm(fsRoot, { recursive: true, force: true });
});

describe("removed item-memory API", () => {
  it("does not expose list, edit or delete authority outside official igrep", async () => {
    const response = await dispatchChat({
      method: "GET",
      path: "/api/v1/chat/memories",
      userId: USER,
    });
    expect(response.kind === "json" && response.status).toBe(404);
  });

  it("reaches delete via the bare /api/v1/messages/:id path (BFF proxy convention)", async () => {
    const { userMessageId } = await seedTurn("call me Nova");
    const del = await dispatchChat({ method: "DELETE", path: `/api/v1/messages/${userMessageId}`, userId: USER });
    expect(del.kind === "json" && del.status).toBe(200);
  });
});

describe("SSE stream aliases (PRD §8.2)", () => {
  it("serves both /messages/:id/stream and /streams/:id", async () => {
    const { assistantMessageId } = await seedTurn("please call me Streamer");
    const viaMessages = await dispatchChat({ method: "GET", path: `/api/v1/chat/messages/${assistantMessageId}/stream`, userId: USER });
    const viaStreams = await dispatchChat({ method: "GET", path: `/api/v1/chat/streams/${assistantMessageId}`, userId: USER });
    expect(viaMessages.kind).toBe("sse");
    expect(viaStreams.kind).toBe("sse");
    expect(viaMessages.kind === "sse" && viaMessages.streamKey).toBe(
      viaStreams.kind === "sse" ? viaStreams.streamKey : "",
    );
    const foreign = await dispatchChat({ method: "GET", path: `/api/v1/chat/streams/${assistantMessageId}`, userId: "u_capi_foreign" });
    expect(foreign.kind === "json" && foreign.status).toBe(404);
  });
});

describe("relationship management API", () => {
  it("lists, reads, rejects client edits, and resets the companion bond", async () => {
    await seedTurn("hey there, nice to meet you");

    const listed = jbody<{ relationships: Array<{ characterId: string; stage: string }> }>(
      await dispatchChat({ method: "GET", path: "/api/v1/chat/relationships", userId: USER }),
    );
    expect(listed.relationships.some((r) => r.characterId === CHAR)).toBe(true);

    const one = jbody<{ characterId: string; summary: string; stage: string; version: number }>(
      await dispatchChat({ method: "GET", path: `/api/v1/chat/relationships/${CHAR}`, userId: USER }),
    );
    expect(one.characterId).toBe(CHAR);

    const patched = await dispatchChat({
      method: "PATCH",
      path: `/api/v1/chat/relationships/${CHAR}`,
      userId: USER,
      body: { summary: "We are close friends.", stage: "close" },
    });
    expect(patched.kind === "json" && patched.status).toBe(405);
    const unchanged = jbody<{ summary: string; stage: string; version: number }>(
      await dispatchChat({ method: "GET", path: `/api/v1/chat/relationships/${CHAR}`, userId: USER }),
    );
    expect(unchanged).toMatchObject({
      summary: one.summary,
      stage: one.stage,
      version: one.version,
    });

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
