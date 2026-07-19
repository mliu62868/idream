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
import { getLastMockStreamMessages } from "../src/providers.js";
import { CHAT_QUEUES, MAIN_TO_CHAT_EVENTS } from "@idream/shared/contracts";
import { acceptAgeGate } from "./fixtures.js";

const superPool = new Pool({ connectionString: process.env.CHAT_TEST_SUPER_URL });
const prisma = createChatPrisma();
let fsRoot: string;
const USER = "u_web";
const IMG_USER = "u_web_img";
const CHAR = "c_web";
const VP_USER = "u_web_vp";
const CHAR_VP = "c_web_vp";
const CHAR_VP_PROFILE = "cvp_web_vp";
const NOTOOL_USER = "u_web_notool";
const CHAR_NOTOOL = "c_web_notool";
const IDENTITY_TOKEN = "P4-IDENTITY-TOKEN-abc123";
const FC_USER = "u_web_fc";
const EDIT_USER = "u_web_edit";
const EDIT_FALLBACK_USER = "u_web_edit_fallback";
const EDIT_RETRY_USER = "u_web_edit_retry";
const CHAR_EDIT = "c_web_edit";
const P5_ACCEPT_USER = "u_web_p5_accept";
const P5_ACCEPT_DEGRADE_USER = "u_web_p5_accept_degrade";

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

  // Character with an active visual profile (passport injection).
  await superPool.query(
    `INSERT INTO public.users (id,email,status,"createdAt","updatedAt") VALUES ($1,$2,'active',now(),now()) ON CONFLICT (id) DO NOTHING`,
    [VP_USER, "web-vp@test.dev"],
  );
  await superPool.query(
    `INSERT INTO public.characters (id,name,age,description,visibility,status,style,gender,appearance,"advancedDetails","createdAt","updatedAt")
     VALUES ($1,'WebVP',23,'d','public','approved','realistic','female','{}','{}',now(),now()) ON CONFLICT (id) DO NOTHING`,
    [CHAR_VP],
  );
  await superPool.query(
    `INSERT INTO public.character_visual_profiles
       (id,"characterId",version,status,style,"identityPrompt","faceTraits","hairTraits","bodyTraits","signatureTraits","styleTraits","anchorAssetIds","referenceAssetIds","adapterRefs","createdFrom","createdAt","updatedAt")
     VALUES ($1,$2,1,'active','realistic',$3,'{}','{}','{}','{}','{}','[]','[]','{}','test',now(),now())
     ON CONFLICT (id) DO NOTHING`,
    [CHAR_VP_PROFILE, CHAR_VP, `WebVP, adult woman, ${IDENTITY_TOKEN}`],
  );

  // P4 Task 7 acceptance user — reuses CHAR_VP (passport character) so the
  // FC + passport + result-awareness assertions can share one fixture.
  await superPool.query(
    `INSERT INTO public.users (id,email,status,"createdAt","updatedAt") VALUES ($1,$2,'active',now(),now()) ON CONFLICT (id) DO NOTHING`,
    [FC_USER, "web-fc@test.dev"],
  );

  // Character with the image tool disabled (advancedDetails.imageToolEnabled=false).
  await superPool.query(
    `INSERT INTO public.users (id,email,status,"createdAt","updatedAt") VALUES ($1,$2,'active',now(),now()) ON CONFLICT (id) DO NOTHING`,
    [NOTOOL_USER, "web-notool@test.dev"],
  );
  await superPool.query(
    `INSERT INTO public.characters (id,name,age,description,visibility,status,style,gender,appearance,"advancedDetails","createdAt","updatedAt")
     VALUES ($1,'WebNoTool',23,'d','public','approved','realistic','female','{}',$2,now(),now()) ON CONFLICT (id) DO NOTHING`,
    [CHAR_NOTOOL, JSON.stringify({ imageToolEnabled: false })],
  );

  // P5 Task 2 acceptance users (edit_last_image tool).
  await superPool.query(
    `INSERT INTO public.users (id,email,status,"createdAt","updatedAt") VALUES ($1,$2,'active',now(),now()) ON CONFLICT (id) DO NOTHING`,
    [EDIT_USER, "web-edit@test.dev"],
  );
  await superPool.query(
    `INSERT INTO public.users (id,email,status,"createdAt","updatedAt") VALUES ($1,$2,'active',now(),now()) ON CONFLICT (id) DO NOTHING`,
    [EDIT_FALLBACK_USER, "web-edit-fallback@test.dev"],
  );
  await superPool.query(
    `INSERT INTO public.users (id,email,status,"createdAt","updatedAt") VALUES ($1,$2,'active',now(),now()) ON CONFLICT (id) DO NOTHING`,
    [EDIT_RETRY_USER, "web-edit-retry@test.dev"],
  );
  await superPool.query(
    `INSERT INTO public.characters (id,name,age,description,visibility,status,style,gender,appearance,"advancedDetails","createdAt","updatedAt")
     VALUES ($1,'WebEdit',23,'d','public','approved','realistic','female','{}','{}',now(),now()) ON CONFLICT (id) DO NOTHING`,
    [CHAR_EDIT],
  );

  // P5 Task 8 acceptance users (single continuous generate→edit→degrade scenario).
  await superPool.query(
    `INSERT INTO public.users (id,email,status,"createdAt","updatedAt") VALUES ($1,$2,'active',now(),now()) ON CONFLICT (id) DO NOTHING`,
    [P5_ACCEPT_USER, "web-p5-accept@test.dev"],
  );
  await superPool.query(
    `INSERT INTO public.users (id,email,status,"createdAt","updatedAt") VALUES ($1,$2,'active',now(),now()) ON CONFLICT (id) DO NOTHING`,
    [P5_ACCEPT_DEGRADE_USER, "web-p5-accept-degrade@test.dev"],
  );
  await acceptAgeGate(superPool, [
    USER,
    IMG_USER,
    VP_USER,
    NOTOOL_USER,
    FC_USER,
    EDIT_USER,
    EDIT_FALLBACK_USER,
    EDIT_RETRY_USER,
    P5_ACCEPT_USER,
    P5_ACCEPT_DEGRADE_USER,
  ]);
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
      const photoSummary = "Web smiling by a sunlit window";
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
          summary: photoSummary,
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

      // P4 Task 5: the next turn's model context recalls the delivered photo.
      const oldMockPlanForNextTurn = process.env.CHAT_MOCK_TOOL_PLAN_JSON;
      process.env.CHAT_MOCK_TOOL_PLAN_JSON = JSON.stringify({ tool: null });
      const followUp = await dispatchChat({
        method: "POST",
        path: `/api/v1/chat/sessions/${sessionId}/messages`,
        userId: IMG_USER,
        body: { content: "did you like that moment?" },
      });
      expect(followUp.kind === "json" && followUp.status).toBe(202);
      await drainGen();
      if (oldMockPlanForNextTurn === undefined) delete process.env.CHAT_MOCK_TOOL_PLAN_JSON;
      else process.env.CHAT_MOCK_TOOL_PLAN_JSON = oldMockPlanForNextTurn;

      const modelMessages = getLastMockStreamMessages() ?? [];
      expect(
        modelMessages.some(
          (m) => m.role === "assistant" && m.content.includes(`[You sent a photo: ${photoSummary}]`),
        ),
      ).toBe(true);
    } finally {
      if (oldMockPlan === undefined) delete process.env.CHAT_MOCK_TOOL_PLAN_JSON;
      else process.env.CHAT_MOCK_TOOL_PLAN_JSON = oldMockPlan;
    }
  });

  it("carries the visual passport (visualProfileId/version + identity prompt) through an agent-triggered image", async () => {
    const oldMockPlan = process.env.CHAT_MOCK_TOOL_PLAN_JSON;
    process.env.CHAT_MOCK_TOOL_PLAN_JSON = JSON.stringify({
      tool: {
        name: "generate_image_async",
        arguments: {
          prompt: "Realistic in-character photo of WebVP sharing a quiet moment in the current chat scene",
          caption: "Sure, one moment.",
          orientation: "4:5",
          outputCount: 1,
        },
      },
    });
    try {
      const created = await dispatchChat({
        method: "POST",
        path: "/api/v1/chat/sessions",
        userId: VP_USER,
        body: { characterId: CHAR_VP },
      });
      const sessionId = created.kind === "json" ? (created.body as { id: string }).id : "";

      const sent = await dispatchChat({
        method: "POST",
        path: `/api/v1/chat/sessions/${sessionId}/messages`,
        userId: VP_USER,
        body: { content: "send me a photo from this moment please" },
      });
      const assistantMessageId =
        sent.kind === "json" ? (sent.body as { assistantMessageId: string }).assistantMessageId : "";
      await drainGen();

      const read = await dispatchChat({
        method: "GET",
        path: `/api/v1/chat/sessions/${sessionId}`,
        userId: VP_USER,
      });
      expect(read.kind).toBe("json");
      if (read.kind !== "json") return;
      const messages = (read.body as {
        messages: Array<{ attachments?: Array<{ id: string }> }>;
      }).messages;
      const attachment = messages.flatMap((message) => message.attachments ?? [])[0];
      expect(attachment).toBeTruthy();

      const outbox = await prisma.chatOutboxEvent.findFirst({
        where: { aggregateId: attachment.id, eventType: "chat.image.requested" },
      });
      expect(outbox?.payload).toMatchObject({
        attachmentId: attachment.id,
        visualProfileId: CHAR_VP_PROFILE,
        visualProfileVersion: 1,
      });

      // System prompt reached the model with the identity line (asserted via the
      // agent trace jsonl, since the web dispatch surface doesn't expose it directly).
      const log = await readFile(path.join(fsRoot, "sessions", VP_USER, `${sessionId}.jsonl`), "utf8");
      const lastLine = log.trim().split("\n").pop() ?? "";
      const trace = JSON.parse(lastLine) as { system?: string; assistantMessageId?: string };
      expect(trace.assistantMessageId).toBe(assistantMessageId);
      expect(trace.system).toContain(IDENTITY_TOKEN);
    } finally {
      if (oldMockPlan === undefined) delete process.env.CHAT_MOCK_TOOL_PLAN_JSON;
      else process.env.CHAT_MOCK_TOOL_PLAN_JSON = oldMockPlan;
    }
  });

  it("P4 acceptance: native FC image tool (text+image same turn) + passport + result-awareness across two turns", async () => {
    const oldToolCalls = process.env.CHAT_MOCK_TOOL_CALLS_JSON;
    const oldSupportsTools = process.env.CHAT_MOCK_SUPPORTS_TOOLS;
    const firstPrompt = "Realistic in-character selfie of WebVP smiling in the current chat scene";
    process.env.CHAT_MOCK_TOOL_CALLS_JSON = JSON.stringify([
      {
        id: "call_p4_1",
        name: "generate_image_async",
        arguments: JSON.stringify({
          prompt: firstPrompt,
          caption: "Here's a selfie!",
          orientation: "4:5",
          outputCount: 1,
        }),
      },
    ]);
    delete process.env.CHAT_MOCK_SUPPORTS_TOOLS; // defaults to true — native FC path
    try {
      const created = await dispatchChat({
        method: "POST",
        path: "/api/v1/chat/sessions",
        userId: FC_USER,
        body: { characterId: CHAR_VP },
      });
      const sessionId = created.kind === "json" ? (created.body as { id: string }).id : "";

      const sent = await dispatchChat({
        method: "POST",
        path: `/api/v1/chat/sessions/${sessionId}/messages`,
        userId: FC_USER,
        body: { content: "发张自拍" },
      });
      expect(sent.kind === "json" && sent.status).toBe(202);
      const assistantMessageId =
        sent.kind === "json" ? (sent.body as { assistantMessageId: string }).assistantMessageId : "";
      await drainGen();

      const read = await dispatchChat({
        method: "GET",
        path: `/api/v1/chat/sessions/${sessionId}`,
        userId: FC_USER,
      });
      expect(read.kind).toBe("json");
      if (read.kind !== "json") return;
      const messages = (read.body as {
        messages: Array<{
          id: string;
          content: string;
          attachments?: Array<{ id: string; status: string; promptHint?: string | null; metadata?: { trigger?: string } }>;
        }>;
      }).messages;
      const assistant = messages.find((m) => m.id === assistantMessageId);
      // Same assistant message carries BOTH text and the attachment (FC contract point 3).
      expect(assistant?.content?.length).toBeGreaterThan(0);
      const firstAttachment = assistant?.attachments?.[0];
      expect(firstAttachment).toMatchObject({ status: "requesting", promptHint: firstPrompt });
      expect(firstAttachment?.metadata?.trigger).toBe("agent_fc");

      const outbox = await prisma.chatOutboxEvent.findFirst({
        where: { aggregateId: firstAttachment!.id, eventType: "chat.image.requested" },
      });
      expect(outbox?.payload).toMatchObject({
        attachmentId: firstAttachment!.id,
        promptHint: firstPrompt,
        visualProfileId: CHAR_VP_PROFILE,
        visualProfileVersion: 1,
      });

      // System prompt reached the model with the identity line (agent trace jsonl).
      const log = await readFile(path.join(fsRoot, "sessions", FC_USER, `${sessionId}.jsonl`), "utf8");
      const lastLine = log.trim().split("\n").pop() ?? "";
      const trace = JSON.parse(lastLine) as { system?: string };
      expect(trace.system).toContain(IDENTITY_TOKEN);

      const photoSummary = "WebVP smiling for a selfie by a sunlit window";
      await consumeInbound({
        eventId: `p4_accept_${firstAttachment!.id}`,
        eventType: MAIN_TO_CHAT_EVENTS.chatImageAccepted,
        payload: {
          version: 1,
          kind: "chat.image.accepted",
          attachmentId: firstAttachment!.id,
          generationJobId: "job_p4_1",
          costDreamcoins: 5,
        },
      });
      await consumeInbound({
        eventId: `p4_done_${firstAttachment!.id}`,
        eventType: MAIN_TO_CHAT_EVENTS.chatImageCompleted,
        payload: {
          version: 1,
          kind: "chat.image.completed",
          attachmentId: firstAttachment!.id,
          generationJobId: "job_p4_1",
          mediaAssetId: "media_p4_1",
          width: 512,
          height: 640,
          summary: photoSummary,
        },
      });

      const afterCompletion = await dispatchChat({
        method: "GET",
        path: `/api/v1/chat/sessions/${sessionId}`,
        userId: FC_USER,
      });
      const completedAttachment =
        afterCompletion.kind === "json"
          ? (afterCompletion.body as {
              messages: Array<{ attachments?: Array<{ id: string; status: string; mediaAssetId?: string }> }>;
            }).messages
              .flatMap((m) => m.attachments ?? [])
              .find((a) => a.id === firstAttachment!.id)
          : undefined;
      expect(completedAttachment).toMatchObject({ status: "completed", mediaAssetId: "media_p4_1" });

      // Second turn: a new scene request triggers a NEW FC tool call, and the model
      // context for THIS turn already recalls the first delivered photo (result-awareness).
      const secondPrompt = "Realistic in-character photo of WebVP at a snowy mountain scene";
      process.env.CHAT_MOCK_TOOL_CALLS_JSON = JSON.stringify([
        {
          id: "call_p4_2",
          name: "generate_image_async",
          arguments: JSON.stringify({
            prompt: secondPrompt,
            caption: "Let's go to the snowy mountains!",
            orientation: "4:5",
            outputCount: 1,
          }),
        },
      ]);
      const secondSent = await dispatchChat({
        method: "POST",
        path: `/api/v1/chat/sessions/${sessionId}/messages`,
        userId: FC_USER,
        body: { content: "换个场景，去雪山" },
      });
      expect(secondSent.kind === "json" && secondSent.status).toBe(202);
      await drainGen();

      const modelMessages = getLastMockStreamMessages() ?? [];
      expect(
        modelMessages.some(
          (m) => m.role === "assistant" && m.content.includes(`[You sent a photo: ${photoSummary}]`),
        ),
      ).toBe(true);

      const finalRead = await dispatchChat({
        method: "GET",
        path: `/api/v1/chat/sessions/${sessionId}`,
        userId: FC_USER,
      });
      const finalAttachments =
        finalRead.kind === "json"
          ? (finalRead.body as {
              messages: Array<{ attachments?: Array<{ id: string; status: string; promptHint?: string | null; metadata?: { trigger?: string } }> }>;
            }).messages.flatMap((m) => m.attachments ?? [])
          : [];
      const secondAttachment = finalAttachments.find((a) => a.id !== firstAttachment!.id);
      expect(secondAttachment).toMatchObject({ status: "requesting", promptHint: secondPrompt });
      expect(secondAttachment?.metadata?.trigger).toBe("agent_fc");
    } finally {
      if (oldToolCalls === undefined) delete process.env.CHAT_MOCK_TOOL_CALLS_JSON;
      else process.env.CHAT_MOCK_TOOL_CALLS_JSON = oldToolCalls;
      if (oldSupportsTools === undefined) delete process.env.CHAT_MOCK_SUPPORTS_TOOLS;
      else process.env.CHAT_MOCK_SUPPORTS_TOOLS = oldSupportsTools;
    }
  });

  it("advancedDetails.imageToolEnabled=false suppresses the image tool entirely (no attachment/outbox, text still replies)", async () => {
    const oldMockPlan = process.env.CHAT_MOCK_TOOL_PLAN_JSON;
    // Even if the (legacy) planner WOULD call the tool, policy.imageToolEnabled=false
    // must short-circuit before the planner ever runs.
    process.env.CHAT_MOCK_TOOL_PLAN_JSON = JSON.stringify({
      tool: {
        name: "generate_image_async",
        arguments: {
          prompt: "Realistic in-character photo of WebNoTool sharing a quiet moment",
          orientation: "4:5",
          outputCount: 1,
        },
      },
    });
    try {
      const created = await dispatchChat({
        method: "POST",
        path: "/api/v1/chat/sessions",
        userId: NOTOOL_USER,
        body: { characterId: CHAR_NOTOOL },
      });
      const sessionId = created.kind === "json" ? (created.body as { id: string }).id : "";

      const sent = await dispatchChat({
        method: "POST",
        path: `/api/v1/chat/sessions/${sessionId}/messages`,
        userId: NOTOOL_USER,
        body: { content: "send me a photo from this moment please" },
      });
      const assistantMessageId =
        sent.kind === "json" ? (sent.body as { assistantMessageId: string }).assistantMessageId : "";
      await drainGen();

      const read = await dispatchChat({
        method: "GET",
        path: `/api/v1/chat/sessions/${sessionId}`,
        userId: NOTOOL_USER,
      });
      expect(read.kind).toBe("json");
      if (read.kind !== "json") return;
      const messages = (read.body as {
        messages: Array<{ id: string; status: string; content: string; attachments?: unknown[] }>;
      }).messages;
      const assistant = messages.find((m) => m.id === assistantMessageId);
      expect(assistant?.status).toBe("sent");
      expect(assistant?.content?.length).toBeGreaterThan(0);
      expect(assistant?.attachments ?? []).toHaveLength(0);

      const outbox = await prisma.chatOutboxEvent.findFirst({
        where: { eventType: "chat.image.requested", payload: { path: ["sessionId"], equals: sessionId } },
      });
      expect(outbox).toBeNull();
    } finally {
      if (oldMockPlan === undefined) delete process.env.CHAT_MOCK_TOOL_PLAN_JSON;
      else process.env.CHAT_MOCK_TOOL_PLAN_JSON = oldMockPlan;
    }
  });

  it("P5 Task 2 acceptance: edit_last_image (FC) targets the last completed photo via sourceImageAssetId", async () => {
    const oldToolCalls = process.env.CHAT_MOCK_TOOL_CALLS_JSON;
    try {
      const created = await dispatchChat({
        method: "POST",
        path: "/api/v1/chat/sessions",
        userId: EDIT_USER,
        body: { characterId: CHAR_EDIT },
      });
      const sessionId = created.kind === "json" ? (created.body as { id: string }).id : "";

      // First turn: a normal generate_image_async delivers a photo the edit can target.
      const firstPrompt = "Realistic in-character selfie of WebEdit smiling in the current chat scene";
      process.env.CHAT_MOCK_TOOL_CALLS_JSON = JSON.stringify([
        {
          id: "call_edit_gen_1",
          name: "generate_image_async",
          arguments: JSON.stringify({ prompt: firstPrompt, caption: "Here's a selfie!", orientation: "4:5", outputCount: 1 }),
        },
      ]);
      const sent = await dispatchChat({
        method: "POST",
        path: `/api/v1/chat/sessions/${sessionId}/messages`,
        userId: EDIT_USER,
        body: { content: "发张自拍" },
      });
      expect(sent.kind === "json" && sent.status).toBe(202);
      await drainGen();

      const afterFirst = await dispatchChat({
        method: "GET",
        path: `/api/v1/chat/sessions/${sessionId}`,
        userId: EDIT_USER,
      });
      const firstMessages =
        afterFirst.kind === "json"
          ? (afterFirst.body as { messages: Array<{ attachments?: Array<{ id: string }> }> }).messages
          : [];
      const firstAttachment = firstMessages.flatMap((m) => m.attachments ?? [])[0];
      expect(firstAttachment).toBeTruthy();

      await consumeInbound({
        eventId: `edit_accept_${firstAttachment!.id}`,
        eventType: MAIN_TO_CHAT_EVENTS.chatImageAccepted,
        payload: {
          version: 1,
          kind: "chat.image.accepted",
          attachmentId: firstAttachment!.id,
          generationJobId: "job_edit_1",
          costDreamcoins: 5,
        },
      });
      await consumeInbound({
        eventId: `edit_done_${firstAttachment!.id}`,
        eventType: MAIN_TO_CHAT_EVENTS.chatImageCompleted,
        payload: {
          version: 1,
          kind: "chat.image.completed",
          attachmentId: firstAttachment!.id,
          generationJobId: "job_edit_1",
          mediaAssetId: "media_edit_source_1",
          width: 512,
          height: 640,
          summary: "WebEdit smiling for a selfie",
        },
      });

      // Second turn: the model calls edit_last_image instead of generating a new scene.
      const editInstruction = "change the background to a snowy mountain scene";
      process.env.CHAT_MOCK_TOOL_CALLS_JSON = JSON.stringify([
        {
          id: "call_edit_2",
          name: "edit_last_image",
          arguments: JSON.stringify({ instruction: editInstruction, caption: "redoing it now!" }),
        },
      ]);
      const editSent = await dispatchChat({
        method: "POST",
        path: `/api/v1/chat/sessions/${sessionId}/messages`,
        userId: EDIT_USER,
        body: { content: "把刚才那张照片改成雪山背景" },
      });
      expect(editSent.kind === "json" && editSent.status).toBe(202);
      await drainGen();

      const afterEdit = await dispatchChat({
        method: "GET",
        path: `/api/v1/chat/sessions/${sessionId}`,
        userId: EDIT_USER,
      });
      const finalAttachments =
        afterEdit.kind === "json"
          ? (afterEdit.body as {
              messages: Array<{ attachments?: Array<{ id: string; status: string; promptHint?: string | null }> }>;
            }).messages.flatMap((m) => m.attachments ?? [])
          : [];
      const editAttachment = finalAttachments.find((a) => a.id !== firstAttachment!.id);
      expect(editAttachment).toMatchObject({ status: "requesting", promptHint: editInstruction });

      const editOutbox = await prisma.chatOutboxEvent.findFirst({
        where: { aggregateId: editAttachment!.id, eventType: "chat.image.requested" },
      });
      expect(editOutbox?.payload).toMatchObject({
        promptHint: editInstruction,
        controls: { sourceImageAssetId: "media_edit_source_1" },
      });
    } finally {
      if (oldToolCalls === undefined) delete process.env.CHAT_MOCK_TOOL_CALLS_JSON;
      else process.env.CHAT_MOCK_TOOL_CALLS_JSON = oldToolCalls;
    }
  });

  it("edit_last_image with no prior completed photo in the session degrades to a fresh generate (no sourceImageAssetId, no throw)", async () => {
    const oldToolCalls = process.env.CHAT_MOCK_TOOL_CALLS_JSON;
    try {
      const created = await dispatchChat({
        method: "POST",
        path: "/api/v1/chat/sessions",
        userId: EDIT_FALLBACK_USER,
        body: { characterId: CHAR_EDIT },
      });
      const sessionId = created.kind === "json" ? (created.body as { id: string }).id : "";

      const instruction = "change the background to a snowy mountain scene";
      process.env.CHAT_MOCK_TOOL_CALLS_JSON = JSON.stringify([
        {
          id: "call_edit_fallback",
          name: "edit_last_image",
          arguments: JSON.stringify({ instruction }),
        },
      ]);
      const sent = await dispatchChat({
        method: "POST",
        path: `/api/v1/chat/sessions/${sessionId}/messages`,
        userId: EDIT_FALLBACK_USER,
        body: { content: "把照片改成雪山背景" },
      });
      expect(sent.kind === "json" && sent.status).toBe(202);
      await drainGen();

      const read = await dispatchChat({
        method: "GET",
        path: `/api/v1/chat/sessions/${sessionId}`,
        userId: EDIT_FALLBACK_USER,
      });
      const messages =
        read.kind === "json"
          ? (read.body as { messages: Array<{ attachments?: Array<{ id: string; status: string; promptHint?: string | null }> }> }).messages
          : [];
      const attachment = messages.flatMap((m) => m.attachments ?? [])[0];
      expect(attachment).toMatchObject({ status: "requesting", promptHint: instruction });

      const outbox = await prisma.chatOutboxEvent.findFirst({
        where: { aggregateId: attachment!.id, eventType: "chat.image.requested" },
      });
      expect(outbox?.payload).toMatchObject({ promptHint: instruction });
      expect((outbox?.payload as { controls: Record<string, unknown> }).controls).not.toHaveProperty(
        "sourceImageAssetId",
      );
    } finally {
      if (oldToolCalls === undefined) delete process.env.CHAT_MOCK_TOOL_CALLS_JSON;
      else process.env.CHAT_MOCK_TOOL_CALLS_JSON = oldToolCalls;
    }
  });

  it("P5 Task 8 acceptance: generate → completed → edit-in-chat carries sourceImageAssetId, then a fresh session with no prior photo degrades cleanly", async () => {
    const oldToolCalls = process.env.CHAT_MOCK_TOOL_CALLS_JSON;
    try {
      // --- Part A: generate a photo to completed, then edit it in the same session. ---
      const created = await dispatchChat({
        method: "POST",
        path: "/api/v1/chat/sessions",
        userId: P5_ACCEPT_USER,
        body: { characterId: CHAR_EDIT },
      });
      const sessionId = created.kind === "json" ? (created.body as { id: string }).id : "";

      process.env.CHAT_MOCK_TOOL_CALLS_JSON = JSON.stringify([
        {
          id: "call_p5_accept_gen",
          name: "generate_image_async",
          arguments: JSON.stringify({
            prompt: "Realistic in-character selfie of WebEdit in the current chat scene",
            caption: "Here's a photo!",
            orientation: "4:5",
            outputCount: 1,
          }),
        },
      ]);
      const sent = await dispatchChat({
        method: "POST",
        path: `/api/v1/chat/sessions/${sessionId}/messages`,
        userId: P5_ACCEPT_USER,
        body: { content: "发张照片" },
      });
      expect(sent.kind === "json" && sent.status).toBe(202);
      await drainGen();

      const afterFirst = await dispatchChat({
        method: "GET",
        path: `/api/v1/chat/sessions/${sessionId}`,
        userId: P5_ACCEPT_USER,
      });
      const firstAttachment =
        afterFirst.kind === "json"
          ? (afterFirst.body as { messages: Array<{ attachments?: Array<{ id: string }> }> }).messages.flatMap(
              (m) => m.attachments ?? [],
            )[0]
          : undefined;
      expect(firstAttachment).toBeTruthy();

      await consumeInbound({
        eventId: `p5_accept_accept_${firstAttachment!.id}`,
        eventType: MAIN_TO_CHAT_EVENTS.chatImageAccepted,
        payload: {
          version: 1,
          kind: "chat.image.accepted",
          attachmentId: firstAttachment!.id,
          generationJobId: "job_p5_accept_1",
          costDreamcoins: 5,
        },
      });
      await consumeInbound({
        eventId: `p5_accept_done_${firstAttachment!.id}`,
        eventType: MAIN_TO_CHAT_EVENTS.chatImageCompleted,
        payload: {
          version: 1,
          kind: "chat.image.completed",
          attachmentId: firstAttachment!.id,
          generationJobId: "job_p5_accept_1",
          mediaAssetId: "media_p5_accept_source_1",
          width: 512,
          height: 640,
          summary: "WebEdit in a photo",
        },
      });

      // "把刚才那张改成雪山背景" — the model selects edit_last_image against the
      // just-completed photo.
      const editInstruction = "把刚才那张改成雪山背景";
      process.env.CHAT_MOCK_TOOL_CALLS_JSON = JSON.stringify([
        {
          id: "call_p5_accept_edit",
          name: "edit_last_image",
          arguments: JSON.stringify({ instruction: editInstruction, caption: "换好了！" }),
        },
      ]);
      const editSent = await dispatchChat({
        method: "POST",
        path: `/api/v1/chat/sessions/${sessionId}/messages`,
        userId: P5_ACCEPT_USER,
        body: { content: editInstruction },
      });
      expect(editSent.kind === "json" && editSent.status).toBe(202);
      await drainGen();

      const afterEdit = await dispatchChat({
        method: "GET",
        path: `/api/v1/chat/sessions/${sessionId}`,
        userId: P5_ACCEPT_USER,
      });
      const editAttachment =
        afterEdit.kind === "json"
          ? (afterEdit.body as { messages: Array<{ attachments?: Array<{ id: string }> }> }).messages
              .flatMap((m) => m.attachments ?? [])
              .find((a) => a.id !== firstAttachment!.id)
          : undefined;
      expect(editAttachment).toBeTruthy();

      const editOutbox = await prisma.chatOutboxEvent.findFirst({
        where: { aggregateId: editAttachment!.id, eventType: "chat.image.requested" },
      });
      expect(editOutbox?.payload).toMatchObject({
        controls: { sourceImageAssetId: "media_p5_accept_source_1" },
      });

      // --- Part B: a brand-new session, no prior photo — edit intent degrades cleanly. ---
      const createdDegrade = await dispatchChat({
        method: "POST",
        path: "/api/v1/chat/sessions",
        userId: P5_ACCEPT_DEGRADE_USER,
        body: { characterId: CHAR_EDIT },
      });
      const degradeSessionId = createdDegrade.kind === "json" ? (createdDegrade.body as { id: string }).id : "";

      process.env.CHAT_MOCK_TOOL_CALLS_JSON = JSON.stringify([
        {
          id: "call_p5_accept_degrade",
          name: "edit_last_image",
          arguments: JSON.stringify({ instruction: editInstruction }),
        },
      ]);
      const degradeSent = await dispatchChat({
        method: "POST",
        path: `/api/v1/chat/sessions/${degradeSessionId}/messages`,
        userId: P5_ACCEPT_DEGRADE_USER,
        body: { content: editInstruction },
      });
      expect(degradeSent.kind === "json" && degradeSent.status).toBe(202);
      await drainGen();

      const afterDegrade = await dispatchChat({
        method: "GET",
        path: `/api/v1/chat/sessions/${degradeSessionId}`,
        userId: P5_ACCEPT_DEGRADE_USER,
      });
      const degradeAttachment =
        afterDegrade.kind === "json"
          ? (afterDegrade.body as { messages: Array<{ attachments?: Array<{ id: string }> }> }).messages.flatMap(
              (m) => m.attachments ?? [],
            )[0]
          : undefined;
      expect(degradeAttachment).toBeTruthy();

      const degradeOutbox = await prisma.chatOutboxEvent.findFirst({
        where: { aggregateId: degradeAttachment!.id, eventType: "chat.image.requested" },
      });
      expect(degradeOutbox?.payload).toMatchObject({ promptHint: editInstruction });
      expect((degradeOutbox?.payload as { controls: Record<string, unknown> }).controls).not.toHaveProperty(
        "sourceImageAssetId",
      );
    } finally {
      if (oldToolCalls === undefined) delete process.env.CHAT_MOCK_TOOL_CALLS_JSON;
      else process.env.CHAT_MOCK_TOOL_CALLS_JSON = oldToolCalls;
    }
  });

  it("confirmImageAttachment retry: a failed edit_last_image attachment re-emits with the same sourceImageAssetId from metadata.editSourceAssetId", async () => {
    const oldToolCalls = process.env.CHAT_MOCK_TOOL_CALLS_JSON;
    try {
      const created = await dispatchChat({
        method: "POST",
        path: "/api/v1/chat/sessions",
        userId: EDIT_RETRY_USER,
        body: { characterId: CHAR_EDIT },
      });
      const sessionId = created.kind === "json" ? (created.body as { id: string }).id : "";

      // Turn 1: deliver a completed source photo.
      process.env.CHAT_MOCK_TOOL_CALLS_JSON = JSON.stringify([
        {
          id: "call_retry_gen_1",
          name: "generate_image_async",
          arguments: JSON.stringify({
            prompt: "Realistic in-character selfie of WebEdit smiling in the current chat scene",
            caption: "Here's a selfie!",
            orientation: "4:5",
            outputCount: 1,
          }),
        },
      ]);
      const sent = await dispatchChat({
        method: "POST",
        path: `/api/v1/chat/sessions/${sessionId}/messages`,
        userId: EDIT_RETRY_USER,
        body: { content: "发张自拍" },
      });
      expect(sent.kind === "json" && sent.status).toBe(202);
      await drainGen();

      const afterFirst = await dispatchChat({
        method: "GET",
        path: `/api/v1/chat/sessions/${sessionId}`,
        userId: EDIT_RETRY_USER,
      });
      const firstAttachment =
        afterFirst.kind === "json"
          ? (afterFirst.body as { messages: Array<{ attachments?: Array<{ id: string }> }> }).messages.flatMap(
              (m) => m.attachments ?? [],
            )[0]
          : undefined;
      expect(firstAttachment).toBeTruthy();

      await consumeInbound({
        eventId: `retry_accept_${firstAttachment!.id}`,
        eventType: MAIN_TO_CHAT_EVENTS.chatImageAccepted,
        payload: {
          version: 1,
          kind: "chat.image.accepted",
          attachmentId: firstAttachment!.id,
          generationJobId: "job_retry_1",
          costDreamcoins: 5,
        },
      });
      await consumeInbound({
        eventId: `retry_done_${firstAttachment!.id}`,
        eventType: MAIN_TO_CHAT_EVENTS.chatImageCompleted,
        payload: {
          version: 1,
          kind: "chat.image.completed",
          attachmentId: firstAttachment!.id,
          generationJobId: "job_retry_1",
          mediaAssetId: "media_retry_source_1",
          width: 512,
          height: 640,
        },
      });

      // Turn 2: edit_last_image against that source photo.
      process.env.CHAT_MOCK_TOOL_CALLS_JSON = JSON.stringify([
        {
          id: "call_retry_edit_1",
          name: "edit_last_image",
          arguments: JSON.stringify({ instruction: "change the background to a snowy mountain scene" }),
        },
      ]);
      const editSent = await dispatchChat({
        method: "POST",
        path: `/api/v1/chat/sessions/${sessionId}/messages`,
        userId: EDIT_RETRY_USER,
        body: { content: "把照片改成雪山背景" },
      });
      expect(editSent.kind === "json" && editSent.status).toBe(202);
      await drainGen();

      const afterEdit = await dispatchChat({
        method: "GET",
        path: `/api/v1/chat/sessions/${sessionId}`,
        userId: EDIT_RETRY_USER,
      });
      const editAttachment =
        afterEdit.kind === "json"
          ? (afterEdit.body as { messages: Array<{ attachments?: Array<{ id: string }> }> }).messages
              .flatMap((m) => m.attachments ?? [])
              .find((a) => a.id !== firstAttachment!.id)
          : undefined;
      expect(editAttachment).toBeTruthy();

      // Main reports the generation as failed — the attachment moves out of "requesting".
      await consumeInbound({
        eventId: `retry_failed_${editAttachment!.id}`,
        eventType: MAIN_TO_CHAT_EVENTS.chatImageFailed,
        payload: {
          version: 1,
          kind: "chat.image.failed",
          attachmentId: editAttachment!.id,
          status: "failed",
        },
      });

      const storedAttachment = await prisma.messageAttachment.findUniqueOrThrow({
        where: { id: editAttachment!.id },
      });
      await prisma.messageAttachment.update({
        where: { id: editAttachment!.id },
        data: {
          metadata: {
            ...((storedAttachment.metadata ?? {}) as Record<string, unknown>),
            characterReleaseId: "release-attachment-old",
          },
        },
      });
      await prisma.chatSession.update({
        where: { id: sessionId },
        data: { characterReleaseId: "release-session-new" },
      });

      // The user retries via the confirm endpoint (service.ts confirmImageAttachment).
      const confirmed = await dispatchChat({
        method: "POST",
        path: `/api/v1/chat/attachments/${editAttachment!.id}/confirm`,
        userId: EDIT_RETRY_USER,
      });
      expect(confirmed.kind === "json" && confirmed.status).toBe(202);

      const retryOutbox = await prisma.chatOutboxEvent.findMany({
        where: { aggregateId: editAttachment!.id, eventType: "chat.image.requested" },
        orderBy: { createdAt: "desc" },
      });
      // The original request from generate.ts + the retry from confirmImageAttachment.
      expect(retryOutbox.length).toBeGreaterThanOrEqual(2);
      expect(retryOutbox[0]?.payload).toMatchObject({
        characterReleaseId: "release-attachment-old",
        controls: { sourceImageAssetId: "media_retry_source_1" },
      });
    } finally {
      if (oldToolCalls === undefined) delete process.env.CHAT_MOCK_TOOL_CALLS_JSON;
      else process.env.CHAT_MOCK_TOOL_CALLS_JSON = oldToolCalls;
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
    expect(res.skipped).toBe("turn_memory_disabled");
    expect(res.written).toBe(0);
  });
});
