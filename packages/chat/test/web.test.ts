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
import type { GeneratePayload } from "../src/generate.js";
import { processMemoryExtract } from "../src/memory.js";
import { drainQueue } from "../src/queue.js";
import { setNoMemory } from "../src/service.js";
import {
  CHAT_QUEUES,
  CHAT_TO_MAIN_EVENTS,
  MAIN_TO_CHAT_EVENTS,
} from "@idream/shared/contracts";
import { acceptAgeGate, ingestChatImageCallback } from "./fixtures.js";
import {
  processGenerateWithTestDsh,
  withTestDshToolCalls,
} from "./dsh-fixtures.js";

const superPool = new Pool({ connectionString: process.env.CHAT_TEST_SUPER_URL });
const prisma = createChatPrisma();
let fsRoot: string;
const USER = "u_web";
const FOREIGN_USER = "u_web_foreign";
const IMAGE_USER = "u_web_image";
const CHAR = "c_web";

beforeAll(async () => {
  fsRoot = await mkdtemp(path.join(tmpdir(), "chat-web-"));
  process.env.CHAT_FS_ROOT = fsRoot;
  await superPool.query(
    `INSERT INTO public.users (id,email,status,"createdAt","updatedAt")
     VALUES ($1,$2,'active',now(),now()),($3,$4,'active',now(),now())
     ON CONFLICT (id) DO NOTHING`,
    [USER, "web@test.dev", FOREIGN_USER, "web-foreign@test.dev"],
  );
  await superPool.query(
    `INSERT INTO public.users (id,email,status,"createdAt","updatedAt") VALUES ($1,$2,'active',now(),now()) ON CONFLICT (id) DO NOTHING`,
    [IMAGE_USER, "web-image@test.dev"],
  );
  await superPool.query(
    `INSERT INTO public.characters (id,name,age,description,visibility,status,style,gender,appearance,"advancedDetails","createdAt","updatedAt")
     VALUES ($1,'Web',23,'d','public','approved','realistic','female','{}','{}',now(),now()) ON CONFLICT (id) DO NOTHING`,
    [CHAR],
  );
  await acceptAgeGate(superPool, [USER, FOREIGN_USER, IMAGE_USER]);
});
afterAll(async () => {
  await superPool.end();
  await prisma.$disconnect();
  await rm(fsRoot, { recursive: true, force: true });
});

async function drainGen() {
  return drainQueue(CHAT_QUEUES.generate, async (job) => {
    await processGenerateWithTestDsh(job.payload as GeneratePayload, prisma);
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
      userId: FOREIGN_USER,
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
    expect(sent.kind === "json" && sent.status).toBe(202);
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
      userId: FOREIGN_USER,
      query: { lastEventId: "0" },
    });
    expect(foreign.kind === "json" && foreign.status).toBe(404);
    expect(await drainGen()).toBe(1);
  });

  it("unknown route → 404", async () => {
    const res = await dispatchChat({ method: "GET", path: "/api/v1/chat/nope", userId: USER });
    expect(res.kind === "json" && res.status).toBe(404);
  });
});

describe("DSH image tool DB path", () => {
  it("binds generate → edit source authority through terminal commit", async () => {
    const created = await dispatchChat({
      method: "POST",
      path: "/api/v1/chat/sessions",
      userId: IMAGE_USER,
      body: { characterId: CHAR },
    });
    expect(created.kind === "json" && created.status).toBe(201);
    const sessionId =
      created.kind === "json" ? (created.body as { id: string }).id : "";

    const generateSent = await dispatchChat({
      method: "POST",
      path: `/api/v1/chat/sessions/${sessionId}/messages`,
      userId: IMAGE_USER,
      body: { content: "send one rooftop garden portrait" },
    });
    expect(generateSent.kind === "json" && generateSent.status).toBe(202);
    const generateTurn = generateSent.kind === "json"
      ? (generateSent.body as { assistantMessageId: string; userMessageId: string })
      : { assistantMessageId: "", userMessageId: "" };
    await withTestDshToolCalls(
      [{
        callId: "call-web-generate-image",
        name: "generate_image_async",
        arguments: {
          prompt: "Candid rooftop garden portrait with one cobalt paper crane",
          caption: "I made this for you.",
          orientation: "4:5",
          outputCount: 1,
        },
      }],
      drainGen,
    );

    const generatedAttachment = await prisma.messageAttachment.findFirstOrThrow({
      where: { messageId: generateTurn.assistantMessageId },
      orderBy: { createdAt: "desc" },
    });
    expect(generatedAttachment).toMatchObject({
      kind: "generated_image",
      status: "requesting",
      promptHint: "Candid rooftop garden portrait with one cobalt paper crane",
    });
    expect(generatedAttachment.metadata).toMatchObject({
      toolName: "generate_image_async",
      toolCallIdentity: {
        attemptId: `${generateTurn.assistantMessageId}:1`,
        callId: "call-web-generate-image",
      },
      sourceUserMessageId: generateTurn.userMessageId,
      orientation: "4:5",
      outputCount: 1,
    });
    const generateOutbox = await prisma.chatOutboxEvent.findFirstOrThrow({
      where: {
        eventType: CHAT_TO_MAIN_EVENTS.imageRequested,
        aggregateId: generatedAttachment.id,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(generateOutbox.payload).toMatchObject({
      kind: "chat.image.requested",
      attachmentId: generatedAttachment.id,
      messageId: generateTurn.assistantMessageId,
      exchangeId: generateTurn.userMessageId,
      controls: { orientation: "4:5", outputCount: 1 },
    });

    const sourceImageAssetId = "asset_web_dsh_generated_source";
    await ingestChatImageCallback(
      `web-image-completed-${generatedAttachment.id}`,
      MAIN_TO_CHAT_EVENTS.chatImageCompleted,
      {
        version: 1,
        kind: "chat.image.completed",
        attachmentId: generatedAttachment.id,
        generationJobId: "gen_job_web_source",
        mediaAssetId: sourceImageAssetId,
        width: 1024,
        height: 1280,
        summary: "rooftop garden portrait with a cobalt paper crane",
      },
      prisma,
    );
    await expect(prisma.messageAttachment.findUnique({
      where: { id: generatedAttachment.id },
      select: { status: true, mediaAssetId: true },
    })).resolves.toEqual({
      status: "completed",
      mediaAssetId: sourceImageAssetId,
    });

    const editSent = await dispatchChat({
      method: "POST",
      path: `/api/v1/chat/sessions/${sessionId}/messages`,
      userId: IMAGE_USER,
      body: { content: "edit the last photo with a silver crescent hairpin" },
    });
    expect(editSent.kind === "json" && editSent.status).toBe(202);
    const editTurn = editSent.kind === "json"
      ? (editSent.body as { assistantMessageId: string; userMessageId: string })
      : { assistantMessageId: "", userMessageId: "" };
    await withTestDshToolCalls(
      [{
        callId: "call-web-edit-image",
        name: "edit_last_image",
        arguments: {
          instruction: "Add one subtle silver crescent hairpin to the last photo",
          caption: "Here is the adjusted version.",
        },
      }],
      drainGen,
    );

    const editAttachment = await prisma.messageAttachment.findFirstOrThrow({
      where: { messageId: editTurn.assistantMessageId },
      orderBy: { createdAt: "desc" },
    });
    expect(editAttachment).toMatchObject({
      kind: "generated_image",
      status: "requesting",
      promptHint: "Add one subtle silver crescent hairpin to the last photo",
    });
    expect(editAttachment.metadata).toMatchObject({
      toolName: "edit_last_image",
      editSourceAssetId: sourceImageAssetId,
      toolCallIdentity: {
        attemptId: `${editTurn.assistantMessageId}:1`,
        callId: "call-web-edit-image",
      },
      sourceUserMessageId: editTurn.userMessageId,
    });
    const editOutbox = await prisma.chatOutboxEvent.findFirstOrThrow({
      where: {
        eventType: CHAT_TO_MAIN_EVENTS.imageRequested,
        aggregateId: editAttachment.id,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(editOutbox.payload).toMatchObject({
      kind: "chat.image.requested",
      attachmentId: editAttachment.id,
      messageId: editTurn.assistantMessageId,
      exchangeId: editTurn.userMessageId,
      controls: {
        orientation: "4:5",
        outputCount: 1,
        sourceImageAssetId,
      },
    });
    await expect(prisma.messageAttachment.count({
      where: { messageId: editTurn.assistantMessageId },
    })).resolves.toBe(1);
    await expect(prisma.chatOutboxEvent.count({
      where: {
        eventType: CHAT_TO_MAIN_EVENTS.imageRequested,
        aggregateId: editAttachment.id,
      },
    })).resolves.toBe(1);
    const editAssistant = await prisma.message.findUniqueOrThrow({
      where: { id: editTurn.assistantMessageId },
      select: { runtimeTrace: true },
    });
    expect(editAssistant.runtimeTrace).toMatchObject({
      companion: {
        toolIdentity: {
          attemptId: `${editTurn.assistantMessageId}:1`,
          callId: "call-web-edit-image",
        },
        toolResult: {
          attemptId: `${editTurn.assistantMessageId}:1`,
          callId: "call-web-edit-image",
          name: "edit_last_image",
          outcome: "succeeded",
          output: {
            status: "accepted_for_terminal_commit",
            effectId: `${editTurn.assistantMessageId}:1:call-web-edit-image`,
          },
        },
      },
    });
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
    expect(sent).toMatchObject({
      kind: "json",
      status: 202,
      body: {
        assistantMessageId: expect.any(String),
        userMessageId: expect.any(String),
      },
    });
    const { assistantMessageId, userMessageId } = sent.kind === "json"
      ? (sent.body as { assistantMessageId: string; userMessageId: string })
      : { assistantMessageId: "", userMessageId: "" };
    await drainGen();

    const res = await processMemoryExtract({
      sessionId,
      userMessageId,
      assistantMessageId,
      attempt: 1,
    }, prisma);
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
    await setNoMemory({ userId: USER, sessionId, memoryEnabled: false }, { prisma });

    const sent = await dispatchChat({
      method: "POST",
      path: `/api/v1/chat/sessions/${sessionId}/messages`,
      userId: USER,
      body: { content: "call me Secret" },
    });
    expect(sent).toMatchObject({
      kind: "json",
      status: 202,
      body: {
        assistantMessageId: expect.any(String),
        userMessageId: expect.any(String),
      },
    });
    const { assistantMessageId, userMessageId } = sent.kind === "json"
      ? (sent.body as { assistantMessageId: string; userMessageId: string })
      : { assistantMessageId: "", userMessageId: "" };
    await drainGen();

    await expect(prisma.message.findUnique({
      where: { id: assistantMessageId },
      select: { memoryAuthority: true },
    })).resolves.toEqual({ memoryAuthority: "disabled" });
    const mutationWhere = {
      userId: USER,
      kind: "memory_extract" as const,
      payload: { path: ["turnKey"], equals: assistantMessageId },
    };
    const priorMemoryProjectionCount = await prisma.chatFileMutation.count({
      where: mutationWhere,
    });

    const res = await processMemoryExtract({
      sessionId,
      userMessageId,
      assistantMessageId,
      attempt: 1,
    }, prisma);
    expect(res.skipped).toBe("scene_only_memory_disabled");
    expect(res.written).toBe(0);
    expect(await prisma.chatSceneRevision.count({
      where: { sessionId, sourceAssistantMessageId: assistantMessageId },
    })).toBe(1);
    expect(await prisma.chatFileMutation.count({ where: mutationWhere })).toBe(
      priorMemoryProjectionCount,
    );
  });
});
