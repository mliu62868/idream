import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_TO_MAIN_EVENTS } from "@idream/shared/contracts";
import type { ChatPrismaClient } from "./db.js";

const completeMock = vi.hoisted(() => vi.fn());
const streamMock = vi.hoisted(() => vi.fn());
const moderationMock = vi.hoisted(() => vi.fn());
const buildContextMock = vi.hoisted(() => vi.fn());
const appendStreamEventMock = vi.hoisted(() => vi.fn(async () => ({ id: "stream-id", event: {} })));
const appendLineMock = vi.hoisted(() => vi.fn(async () => {}));
const enqueueMock = vi.hoisted(() => vi.fn(async () => {}));
// Mutable seam so individual tests can flip the FC-capability flag without
// re-mocking the whole providers module (mirrors CHAT_MOCK_SUPPORTS_TOOLS on the
// real MockChatModel, see providers.ts).
const supportsToolsState = vi.hoisted(() => ({ value: true }));

vi.mock("./db.js", () => ({ chatPrisma: {} }));
vi.mock("./providers.js", () => ({
  providers: {
    chat: {
      complete: completeMock,
      stream: streamMock,
      get supportsTools() {
        return supportsToolsState.value;
      },
    },
    moderation: {
      check: moderationMock,
    },
  },
}));
vi.mock("./context.js", () => ({
  buildContext: buildContextMock,
  identityPromptLine: (persona: { identityPrompt?: string | null }) =>
    persona.identityPrompt?.trim()
      ? `Your appearance (keep consistent when sending photos): ${persona.identityPrompt.trim()}`
      : "",
}));
vi.mock("./stream.js", () => ({
  appendStreamEvent: appendStreamEventMock,
  streamKey: (assistantMessageId: string) => `chat:stream:${assistantMessageId}`,
}));
vi.mock("./chat-fs.js", () => ({
  appendLine: appendLineMock,
  chatFsPaths: { sessionLog: () => "/tmp/session.jsonl" },
}));
vi.mock("./queue.js", () => ({ enqueue: enqueueMock }));

const { processGenerate } = await import("./generate.js");

type CreateCall = { data: Record<string, unknown>; where?: Record<string, unknown> };

// `completedSourceAttachment` seeds the edit_last_image lookup (generate.ts's
// buildImageRequestFromPlan queries tx.messageAttachment.findFirst); undefined
// exercises the no-source-photo fallback (behavior contract point 3).
function fakePrisma(completedSourceAttachment?: { mediaAssetId: string }) {
  const attachmentCreates: CreateCall[] = [];
  const outboxCreates: CreateCall[] = [];
  const messageUpdates: CreateCall[] = [];
  const rootMessageUpdates: CreateCall[] = [];

  const tx = {
    messageAttachment: {
      create: async (call: CreateCall) => {
        attachmentCreates.push(call);
        return {};
      },
      findFirst: async () => completedSourceAttachment ?? null,
    },
    message: {
      findUnique: async () => ({ id: "msg_assistant", status: "generating", attempt: 1 }),
      updateMany: async (call: CreateCall) => {
        messageUpdates.push(call);
        return { count: 1 };
      },
    },
    messageVersion: {
      updateMany: async () => ({}),
      create: async () => ({}),
    },
    chatUsage: {
      upsert: async () => ({}),
    },
    chatSession: {
      update: async () => ({}),
    },
    chatModerationEvent: {
      create: async () => ({}),
    },
    chatOutboxEvent: {
      create: async (call: CreateCall) => {
        outboxCreates.push(call);
        return {};
      },
    },
  };

  const prisma = {
    message: {
      findUnique: async () => ({ id: "msg_assistant", status: "generating", attempt: 1 }),
      updateMany: async (call: CreateCall) => {
        rootMessageUpdates.push(call);
        return { count: 1 };
      },
    },
    chatSession: {
      findUnique: async () => ({
        id: "sess_1",
        userId: "user_1",
        characterId: "char_1",
        memoryEnabled: true,
        status: "active",
      }),
    },
    $transaction: async <T>(callback: (client: typeof tx) => Promise<T>) => callback(tx),
  } as unknown as ChatPrismaClient;

  return { prisma, attachmentCreates, outboxCreates, messageUpdates, rootMessageUpdates };
}

const context = {
  persona: {
    characterId: "char_1",
    creatorId: "creator_1",
    name: "Melissa",
    age: 38,
    description: "A realistic adult companion.",
    systemPrompt: null,
    relationship: "companion",
    visibility: "public",
    status: "approved",
    voiceId: null,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  },
  policy: {
    model: "local-model",
    maxContextMessages: 12,
    maxContextChars: 24_000,
    maxMemories: 0,
    maxStoredMemories: 0,
    rateLimitPerHour: 60,
    unlimitedMessages: false,
    voiceEnabled: false,
    allowMemoryWrite: true,
    allowGlobalMemoryWrite: false,
    allowRelationshipPatch: true,
    outputModerationRequired: true,
    imageToolEnabled: true,
  },
  sessionSummary: null,
  recentMessages: [
    { id: "msg_user", role: "user", content: "给我一张靠窗的照片" },
  ],
  boundaries: [],
  longTermMemories: [],
  relationship: null,
  canUpdateSessionSummary: true,
};

describe("chat generate agent image tool", () => {
  beforeEach(() => {
    completeMock.mockReset();
    streamMock.mockReset();
    moderationMock.mockReset();
    buildContextMock.mockReset();
    appendStreamEventMock.mockClear();
    appendLineMock.mockClear();
    enqueueMock.mockClear();
    buildContextMock.mockResolvedValue(context);
    moderationMock.mockResolvedValue({ status: "passed", confidence: 0.5 });
    supportsToolsState.value = true;
  });

  it("renews the generation lease while the provider is silent", async () => {
    vi.useFakeTimers();
    try {
      supportsToolsState.value = false;
      buildContextMock.mockResolvedValue({
        ...context,
        policy: { ...context.policy, imageToolEnabled: false },
      });
      streamMock.mockImplementation(async function* silentFirstToken() {
        await new Promise((resolve) => setTimeout(resolve, 65_000));
        yield { delta: "hello", done: true };
      });
      const { prisma, rootMessageUpdates } = fakePrisma();

      const generation = processGenerate(
        { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
        prisma,
      );
      await vi.advanceTimersByTimeAsync(61_000);

      const leaseRenewals = rootMessageUpdates.filter(
        (call) => call.where?.status === "generating",
      );
      expect(leaseRenewals).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(4_000);
      await expect(generation).resolves.toEqual({ status: "sent" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("executes the model-selected async image tool by creating a requesting attachment and outbox event", async () => {
    // FC unavailable on this provider: the regex-gate + planner path is the only
    // route to an image tool call (behavior contract point 5).
    supportsToolsState.value = false;
    completeMock.mockResolvedValue({
      content: JSON.stringify({
        tool: {
          name: "generate_image_async",
          arguments: {
            prompt: "Realistic in-character portrait of Melissa sitting beside a sunlit window, soft afternoon light, 4:5 composition",
            caption: "我给你生成一张靠窗的照片。",
            orientation: "4:5",
            outputCount: 1,
          },
        },
      }),
    });
    streamMock.mockImplementation(async function* emptyStream() {
      yield { delta: "", done: true };
    });
    const { prisma, attachmentCreates, outboxCreates, messageUpdates } = fakePrisma();

    const result = await processGenerate(
      { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
      prisma,
    );

    expect(result.status).toBe("sent");
    expect(streamMock).not.toHaveBeenCalled();
    expect(messageUpdates[0]?.data).toMatchObject({
      status: "sent",
      content: "我给你生成一张靠窗的照片。",
    });
    expect(attachmentCreates[0]?.data).toMatchObject({
      messageId: "msg_assistant",
      kind: "generated_image",
      status: "requesting",
      promptHint: expect.stringContaining("sunlit window"),
    });
    const imageOutbox = outboxCreates.find((call) => call.data.eventType === CHAT_TO_MAIN_EVENTS.imageRequested);
    expect(imageOutbox?.data).toMatchObject({
      eventType: CHAT_TO_MAIN_EVENTS.imageRequested,
      aggregateType: "message_attachment",
    });
    expect(imageOutbox?.data.payload).toMatchObject({
      kind: "chat.image.requested",
      promptHint: expect.stringContaining("sunlit window"),
      controls: { orientation: "4:5", outputCount: 1 },
    });
  });

  it("marks the assistant failed when the provider dies after streaming has started", async () => {
    buildContextMock.mockResolvedValue({
      ...context,
      recentMessages: [{ id: "msg_user", role: "user", content: "hello" }],
    });
    streamMock.mockImplementation(async function* brokenStream() {
      yield { delta: "partial", done: false };
      throw new Error("provider disconnected");
    });
    const { prisma, rootMessageUpdates, messageUpdates } = fakePrisma();

    const result = await processGenerate(
      { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
      prisma,
    );

    expect(result.status).toBe("failed");
    expect(rootMessageUpdates.at(-1)?.data).toMatchObject({ status: "failed" });
    expect(messageUpdates).toHaveLength(0);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(moderationMock).not.toHaveBeenCalled();
    expect(appendStreamEventMock).toHaveBeenCalledWith(
      "chat:stream:msg_assistant",
      expect.objectContaining({ type: "error", code: "provider_failed", retryable: false }),
    );
  });

  it("FC path: a legal native tool call coexists with the prose already streamed (text+image same turn)", async () => {
    streamMock.mockImplementation(async function* fcStream() {
      yield { delta: "I'd love to share this with you.", done: false };
      yield {
        delta: "",
        done: true,
        toolCalls: [
          {
            id: "call_1",
            name: "generate_image_async",
            arguments: JSON.stringify({
              prompt: "Realistic in-character portrait of Melissa sitting beside a sunlit window, soft afternoon light, 4:5 composition",
              caption: "Here it comes!",
              orientation: "4:5",
              outputCount: 1,
            }),
          },
        ],
      };
    });
    const { prisma, attachmentCreates, outboxCreates, messageUpdates } = fakePrisma();

    const result = await processGenerate(
      { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
      prisma,
    );

    expect(result.status).toBe("sent");
    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(streamMock.mock.calls[0]?.[0]).toMatchObject({ tools: expect.any(Array) });
    // Prose was non-empty, so no FC follow-up complete() call was needed.
    expect(completeMock).not.toHaveBeenCalled();
    expect(messageUpdates[0]?.data).toMatchObject({
      status: "sent",
      content: "I'd love to share this with you.",
    });
    expect(attachmentCreates[0]?.data).toMatchObject({
      messageId: "msg_assistant",
      kind: "generated_image",
      status: "requesting",
      promptHint: expect.stringContaining("sunlit window"),
    });
    expect((attachmentCreates[0]?.data.metadata as { trigger: string }).trigger).toBe("agent_fc");
    const imageOutbox = outboxCreates.find((call) => call.data.eventType === CHAT_TO_MAIN_EVENTS.imageRequested);
    expect(imageOutbox).toBeTruthy();
  });

  it("FC path: an illegal tool call (unknown name) is ignored — no attachment, no outbox, plain text, no throw", async () => {
    streamMock.mockImplementation(async function* fcStream() {
      yield { delta: "Just chatting, no photo needed.", done: false };
      yield {
        delta: "",
        done: true,
        toolCalls: [{ id: "call_1", name: "not_a_real_tool", arguments: "{}" }],
      };
    });
    const { prisma, attachmentCreates, outboxCreates, messageUpdates } = fakePrisma();

    const result = await processGenerate(
      { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
      prisma,
    );

    expect(result.status).toBe("sent");
    expect(messageUpdates[0]?.data).toMatchObject({
      status: "sent",
      content: "Just chatting, no photo needed.",
    });
    expect(attachmentCreates).toHaveLength(0);
    expect(outboxCreates.some((call) => call.data.eventType === CHAT_TO_MAIN_EVENTS.imageRequested)).toBe(false);
  });

  it("FC path: edit_last_image dispatches to the second registry arm — controls carry sourceImageAssetId", async () => {
    streamMock.mockImplementation(async function* fcStream() {
      yield {
        delta: "",
        done: true,
        toolCalls: [
          {
            id: "call_edit_1",
            name: "edit_last_image",
            arguments: JSON.stringify({
              instruction: "change the background to snowy mountains",
              caption: "one sec, redoing it!",
            }),
          },
        ],
      };
    });
    const { prisma, attachmentCreates, outboxCreates } = fakePrisma({ mediaAssetId: "media_source_1" });

    const result = await processGenerate(
      { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
      prisma,
    );

    expect(result.status).toBe("sent");
    expect(attachmentCreates[0]?.data).toMatchObject({
      messageId: "msg_assistant",
      kind: "generated_image",
      status: "requesting",
      promptHint: "change the background to snowy mountains",
    });
    const metadata = attachmentCreates[0]?.data.metadata as { editSourceAssetId?: string; toolName?: string };
    expect(metadata.editSourceAssetId).toBe("media_source_1");
    expect(metadata.toolName).toBe("edit_last_image");
    const imageOutbox = outboxCreates.find((call) => call.data.eventType === CHAT_TO_MAIN_EVENTS.imageRequested);
    expect(imageOutbox?.data.payload).toMatchObject({
      kind: "chat.image.requested",
      promptHint: "change the background to snowy mountains",
      controls: { sourceImageAssetId: "media_source_1" },
    });
  });

  it("FC path: edit_last_image with no completed source photo in the session degrades to generate_image_async semantics (no throw)", async () => {
    streamMock.mockImplementation(async function* fcStream() {
      yield {
        delta: "",
        done: true,
        toolCalls: [
          {
            id: "call_edit_2",
            name: "edit_last_image",
            arguments: JSON.stringify({ instruction: "change the background to snowy mountains" }),
          },
        ],
      };
    });
    const { prisma, attachmentCreates, outboxCreates } = fakePrisma(); // no completed source attachment

    const result = await processGenerate(
      { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
      prisma,
    );

    expect(result.status).toBe("sent");
    expect(attachmentCreates[0]?.data).toMatchObject({
      status: "requesting",
      promptHint: "change the background to snowy mountains",
    });
    const metadata = attachmentCreates[0]?.data.metadata as { editSourceAssetId?: string; toolName?: string };
    expect(metadata.editSourceAssetId).toBeUndefined();
    // Degraded attachment must be tagged with the tool it actually became — not a stale
    // "edit_last_image" — so a later retry (which reads metadata.editSourceAssetId, absent
    // here) can never resurrect a sourceImageAssetId that was never resolved.
    expect(metadata.toolName).toBe("generate_image_async");
    const imageOutbox = outboxCreates.find((call) => call.data.eventType === CHAT_TO_MAIN_EVENTS.imageRequested);
    expect((imageOutbox?.data.payload as { controls: Record<string, unknown> }).controls).not.toHaveProperty(
      "sourceImageAssetId",
    );
  });
});
