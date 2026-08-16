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
const recordTurnFailureMock = vi.hoisted(() => vi.fn());
const recordTurnSuccessMock = vi.hoisted(() => vi.fn());

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
vi.mock("./runtime-readiness.js", () => ({
  runtimeReadiness: {
    recordTurnFailure: recordTurnFailureMock,
    recordTurnSuccess: recordTurnSuccessMock,
  },
}));

const { processGenerate, processGenerateJob } = await import("./generate.js");

type CreateCall = { data: Record<string, unknown>; where?: Record<string, unknown> };

/** The one in-transaction write that carries the turn's terminal ledger row. */
function finalizedMessageUpdate(
  messageUpdates: CreateCall[],
): Record<string, unknown> | undefined {
  return messageUpdates.find(
    (call) => (call.data as { status?: string }).status === "sent",
  )?.data;
}

// `completedSourceAttachment` seeds the edit_last_image lookup (generate.ts's
// buildImageRequestFromPlan queries tx.messageAttachment.findFirst); undefined
// exercises the no-source-photo fallback (behavior contract point 3).
function fakePrisma(
  completedSourceAttachment?: { mediaAssetId: string },
  typedSourceTurn?: {
    engagementSessionId: string;
    characterContentVersionId: string;
    characterReleaseId: string | null;
  },
  turnAuthority?: {
    content: string;
    memoryAuthority: "enabled" | "disabled";
  },
) {
  const attachmentCreates: CreateCall[] = [];
  const outboxCreates: CreateCall[] = [];
  const messageUpdates: CreateCall[] = [];
  const rootMessageUpdates: CreateCall[] = [];
  const character = {
    characterId: "char_1",
    creatorId: "creator_1",
    age: 38,
    visibility: "public",
    status: "approved",
    deletedAt: null,
  };

  const tx = {
    $queryRaw: async () => [{ locked: 1 }],
    $executeRaw: async () => 1,
    chatFileMutation: {
      findMany: async () => [],
      findFirst: async () => null,
      count: async () => 0,
      create: async () => ({}),
      updateMany: async () => ({ count: 0 }),
    },
    chatUserView: {
      findUnique: async () => ({
        userId: "user_1",
        status: "active",
        deletedAt: null,
      }),
    },
    chatCharacterView: {
      findUnique: async () => character,
    },
    messageAttachment: {
      create: async (call: CreateCall) => {
        attachmentCreates.push(call);
        return {};
      },
      findFirst: async () => completedSourceAttachment ?? null,
    },
    message: {
      findUnique: async (call: { where: { id: string } }) => call.where.id === "msg_user"
        ? {
            id: "msg_user",
            role: "user",
            sessionId: "sess_1",
            status: "sent",
            deletedAt: null,
            content: turnAuthority?.content ?? "hello",
            ...typedSourceTurn,
          }
        : {
            id: "msg_assistant",
            role: "assistant",
            sessionId: "sess_1",
            status: "generating",
            attempt: 1,
            replyToMessageId: "msg_user",
            deletedAt: null,
          },
      updateMany: async (call: CreateCall) => {
        messageUpdates.push(call);
        return { count: 1 };
      },
      update: async (call: CreateCall) => {
        messageUpdates.push(call);
        return {};
      },
    },
    messageVersion: {
      updateMany: async () => ({}),
      update: async () => ({}),
    },
    chatUsage: {
      upsert: async () => ({}),
    },
    chatSession: {
      findUnique: async () => ({
        id: "sess_1",
        userId: "user_1",
        characterId: "char_1",
        status: "active",
        deletedAt: null,
        contextRevision: 0n,
      }),
      update: async () => ({}),
      updateMany: async () => ({ count: 1 }),
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
      findUnique: async (call: { where: { id: string } }) =>
        call.where.id === "msg_user"
          ? {
              id: "msg_user",
              role: "user",
              sessionId: "sess_1",
              status: "sent",
              deletedAt: null,
              content: turnAuthority?.content ?? "hello",
            }
          : {
              id: "msg_assistant",
              role: "assistant",
              sessionId: "sess_1",
              status: "generating",
              attempt: 1,
              replyToMessageId: "msg_user",
              memoryAuthority: turnAuthority?.memoryAuthority ?? "enabled",
            },
      updateMany: async (call: CreateCall) => {
        rootMessageUpdates.push(call);
        return { count: 1 };
      },
    },
    messageVersion: {
      upsert: async () => ({}),
    },
    chatSession: {
      findUnique: async () => ({
        id: "sess_1",
        userId: "user_1",
        characterId: "char_1",
        memoryEnabled: true,
        status: "active",
        deletedAt: null,
        contextRevision: 0n,
        characterReleaseId: "release_current_v4",
        entryExposureId: "detail_v1",
        entryJourneyId: "journey_v1",
        entryPlacementId: "feed.hero",
      }),
    },
    chatCharacterView: {
      findUnique: async () => character,
    },
    chatFileMutation: {
      findFirst: async () => null,
      count: async () => 0,
      updateMany: async () => ({ count: 0 }),
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
    deletedAt: null,
    voiceId: null,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    characterContentVersionId: "content_v4",
    characterReleaseId: "release_v3",
  },
  policy: {
    tier: "free",
    modelProfile: {
      adapter: "mock-v1",
      provider: "mock",
      baseUrl: "http://127.0.0.1:8061/v1",
      model: "local-model",
      apiKey: "",
      maxOutputTokens: 8_000,
      firstTokenTimeoutMs: 45_000,
      idleTimeoutMs: 45_000,
      completionTimeoutMs: 45_000,
      supportsTools: true,
    },
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
  openingMessage: null,
  scene: null,
  sceneVersion: 0,
  dropped: [],
  canUpdateSessionSummary: true,
  sessionContextRevision: 0n,
  fileContextRevision: 0n,
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
    recordTurnFailureMock.mockClear();
    recordTurnSuccessMock.mockClear();
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
        { projectorPrisma: prisma },
      );
      await vi.advanceTimersByTimeAsync(61_000);

      const leaseRenewals = rootMessageUpdates.filter(
        (call) => call.where?.status === "generating" && call.data.updatedAt instanceof Date,
      );
      expect(leaseRenewals).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(4_000);
      await expect(generation).resolves.toEqual({ status: "sent" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers explicit no-memory persistence requests without invoking the model", async () => {
    supportsToolsState.value = false;
    const { prisma, messageUpdates } = fakePrisma(
      undefined,
      {
        engagementSessionId: "engagement_v1",
        characterContentVersionId: "content_v4",
        characterReleaseId: "release_v4",
      },
      {
        content: "Remember this phrase next month: amber compass. Promise me.",
        memoryAuthority: "disabled",
      },
    );

    await expect(processGenerate(
      { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
      prisma,
      { projectorPrisma: prisma },
    )).resolves.toEqual({ status: "sent" });

    expect(streamMock).not.toHaveBeenCalled();
    expect(completeMock).not.toHaveBeenCalled();
    expect(messageUpdates[0]?.data).toMatchObject({
      status: "sent",
      content: "I can’t retain that across sessions. If you want to use it later, tell me again then.",
    });
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
      { projectorPrisma: prisma },
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
      metadata: expect.objectContaining({
        characterReleaseId: "release_v3",
      }),
    });
    const imageOutbox = outboxCreates.find((call) => call.data.eventType === CHAT_TO_MAIN_EVENTS.imageRequested);
    expect(imageOutbox?.data).toMatchObject({
      eventType: CHAT_TO_MAIN_EVENTS.imageRequested,
      aggregateType: "message_attachment",
    });
    expect(imageOutbox?.data.payload).toMatchObject({
      kind: "chat.image.requested",
      exchangeId: "msg_user",
      messageId: "msg_assistant",
      characterReleaseId: "release_v3",
      promptHint: expect.stringContaining("sunlit window"),
      controls: { orientation: "4:5", outputCount: 1 },
    });
  });

  it("emits a typed exchange with the pinned content/release and stable engagement session", async () => {
    supportsToolsState.value = false;
    streamMock.mockImplementation(async function* reply() {
      yield { delta: "hello", done: true };
    });
    const { prisma, outboxCreates } = fakePrisma(undefined, {
      engagementSessionId: "engagement_v1",
      characterContentVersionId: "content_v4",
      characterReleaseId: "release_v3",
    });

    await expect(processGenerate(
      { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
      prisma,
      { projectorPrisma: prisma },
    )).resolves.toEqual({ status: "sent" });

    expect(outboxCreates.find((call) => call.data.eventType === CHAT_TO_MAIN_EVENTS.exchangeCompletedV2)?.data).toMatchObject({
      schemaVersion: 2,
      aggregateType: "exchange",
      aggregateId: "msg_user",
      payload: {
        exchangeId: "msg_user",
        engagementSessionId: "engagement_v1",
        characterContentVersionId: "content_v4",
        characterReleaseId: "release_v3",
        entryExposureId: "detail_v1",
        journeyId: "journey_v1",
        placementId: "feed.hero",
      },
    });
  });

  it("keeps the already-streamed text when the provider dies mid-reply", async () => {
    buildContextMock.mockResolvedValue({
      ...context,
      recentMessages: [{ id: "msg_user", role: "user", content: "hello" }],
    });
    streamMock.mockImplementation(async function* brokenStream() {
      yield { delta: "partial", done: false };
      throw new Error("provider disconnected");
    });
    const { prisma, messageUpdates } = fakePrisma();

    const result = await processGenerate(
      { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
      prisma,
      { projectorPrisma: prisma },
    );

    // The user watched "partial" arrive; blanking it is worse than a short reply.
    expect(result.status).toBe("sent");
    expect(finalizedMessageUpdate(messageUpdates)).toMatchObject({
      status: "sent",
      content: "partial",
      runtimeTrace: expect.objectContaining({ truncated: true }),
    });
    expect(appendStreamEventMock).toHaveBeenCalledWith(
      "chat:stream:msg_assistant",
      expect.objectContaining({ type: "done" }),
    );
    expect(appendStreamEventMock).not.toHaveBeenCalledWith(
      "chat:stream:msg_assistant",
      expect.objectContaining({ type: "error" }),
    );
    // One dropped stream is a turn failure, never a truncated success, and never
    // by itself grounds for pulling readiness out from under every other user.
    expect(recordTurnFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: "provider disconnected" }),
    );
    expect(recordTurnSuccessMock).not.toHaveBeenCalled();
  });

  it("uses the provider's reported token usage in place of the estimate", async () => {
    supportsToolsState.value = false;
    buildContextMock.mockResolvedValue({
      ...context,
      policy: { ...context.policy, imageToolEnabled: false },
      recentMessages: [{ id: "msg_user", role: "user", content: "hello" }],
    });
    streamMock.mockImplementation(async function* metered() {
      yield {
        delta: "hello there",
        done: true,
        usage: { promptTokens: 812, completionTokens: 37 },
      };
    });
    const { prisma, messageUpdates } = fakePrisma();

    await expect(processGenerate(
      { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
      prisma,
      { projectorPrisma: prisma },
    )).resolves.toEqual({ status: "sent" });

    expect(finalizedMessageUpdate(messageUpdates)).toMatchObject({ tokenCount: 37 });
    expect(appendStreamEventMock).toHaveBeenCalledWith(
      "chat:stream:msg_assistant",
      expect.objectContaining({
        type: "done",
        usage: { promptTokens: 812, completionTokens: 37 },
      }),
    );
    expect(recordTurnSuccessMock).toHaveBeenCalledOnce();
  });

  it("falls back to the length estimate when the provider reports no usage", async () => {
    supportsToolsState.value = false;
    buildContextMock.mockResolvedValue({
      ...context,
      policy: { ...context.policy, imageToolEnabled: false },
      recentMessages: [{ id: "msg_user", role: "user", content: "hello" }],
    });
    streamMock.mockImplementation(async function* unmetered() {
      yield { delta: "hello there", done: true };
    });
    const { prisma, messageUpdates } = fakePrisma();

    await expect(processGenerate(
      { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
      prisma,
      { projectorPrisma: prisma },
    )).resolves.toEqual({ status: "sent" });

    expect(finalizedMessageUpdate(messageUpdates)).toMatchObject({
      tokenCount: Math.ceil("hello there".length / 4),
    });
  });

  it("records an output-limit terminal instead of completing partial provider text", async () => {
    const { ChatModelOutputLimitError } = await import("@idream/shared");
    buildContextMock.mockResolvedValue({
      ...context,
      recentMessages: [{ id: "msg_user", role: "user", content: "hello" }],
    });
    streamMock.mockImplementation(async function* limitedStream() {
      yield { delta: "So, are we just going to stare at the ocean, or", done: false };
      throw new ChatModelOutputLimitError(64);
    });
    const { prisma, rootMessageUpdates, messageUpdates } = fakePrisma();

    const result = await processGenerate(
      { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
      prisma,
      { projectorPrisma: prisma },
    );

    expect(result).toEqual({ status: "failed" });
    expect(rootMessageUpdates.at(-1)?.data).toMatchObject({ status: "failed" });
    expect(messageUpdates).toHaveLength(0);
    expect(appendStreamEventMock).toHaveBeenCalledWith(
      "chat:stream:msg_assistant",
      expect.objectContaining({
        type: "error",
        code: "provider_output_limit",
        retryable: false,
      }),
    );
    expect(appendStreamEventMock).not.toHaveBeenCalledWith(
      "chat:stream:msg_assistant",
      expect.objectContaining({ type: "done" }),
    );
    expect(recordTurnFailureMock).not.toHaveBeenCalled();
  });

  it("keeps an empty provider response retryable without terminalizing the assistant", async () => {
    supportsToolsState.value = false;
    buildContextMock.mockResolvedValue({
      ...context,
      policy: { ...context.policy, imageToolEnabled: false },
      recentMessages: [{ id: "msg_user", role: "user", content: "hello" }],
    });
    streamMock.mockImplementation(async function* emptyStream() {
      yield { delta: "", done: true };
    });
    const { prisma, rootMessageUpdates } = fakePrisma();

    await expect(processGenerate(
      { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
      prisma,
      { projectorPrisma: prisma },
    )).rejects.toThrow("chat model returned an empty response");

    expect(rootMessageUpdates).not.toContainEqual(
      expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) }),
    );
    expect(appendStreamEventMock).toHaveBeenCalledWith(
      "chat:stream:msg_assistant",
      expect.objectContaining({
        type: "error",
        code: "empty_model_response",
        retryable: true,
      }),
    );
    expect(recordTurnFailureMock).toHaveBeenCalledOnce();
    expect(recordTurnFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: "chat model returned an empty response" }),
    );
  });

  it("lets the worker retry the same assistant after an empty provider response", async () => {
    supportsToolsState.value = false;
    buildContextMock.mockResolvedValue({
      ...context,
      policy: { ...context.policy, imageToolEnabled: false },
      recentMessages: [{ id: "msg_user", role: "user", content: "hello" }],
    });
    streamMock
      .mockImplementationOnce(async function* emptyStream() {
        yield { delta: "", done: true };
      })
      .mockImplementationOnce(async function* recoveredStream() {
        yield { delta: "recovered reply", done: true };
      });
    const { prisma, rootMessageUpdates } = fakePrisma();
    const payload = {
      sessionId: "sess_1",
      assistantMessageId: "msg_assistant",
      userMessageId: "msg_user",
      attempt: 1,
    };

    await expect(processGenerateJob(
      { payload, attemptsMade: 0, maxAttempts: 2 },
      prisma,
      { projectorPrisma: prisma },
    )).rejects.toThrow("chat model returned an empty response");
    await expect(processGenerateJob(
      { payload, attemptsMade: 1, maxAttempts: 2 },
      prisma,
      { projectorPrisma: prisma },
    )).resolves.toEqual({ status: "sent" });

    expect(rootMessageUpdates).not.toContainEqual(
      expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) }),
    );
  });

  it("terminalizes an empty provider response only on the final worker attempt", async () => {
    supportsToolsState.value = false;
    buildContextMock.mockResolvedValue({
      ...context,
      policy: { ...context.policy, imageToolEnabled: false },
      recentMessages: [{ id: "msg_user", role: "user", content: "hello" }],
    });
    streamMock.mockImplementation(async function* emptyStream() {
      yield { delta: "", done: true };
    });
    const { prisma, rootMessageUpdates } = fakePrisma();

    await expect(processGenerateJob(
      {
        payload: {
          sessionId: "sess_1",
          assistantMessageId: "msg_assistant",
          userMessageId: "msg_user",
          attempt: 1,
        },
        attemptsMade: 1,
        maxAttempts: 2,
      },
      prisma,
      { projectorPrisma: prisma },
    )).rejects.toThrow("chat model returned an empty response");

    expect(rootMessageUpdates).toContainEqual(
      expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) }),
    );
    expect(appendStreamEventMock).toHaveBeenCalledWith(
      "chat:stream:msg_assistant",
      expect.objectContaining({
        type: "error",
        code: "empty_model_response",
        retryable: false,
      }),
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
      { projectorPrisma: prisma },
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
      { projectorPrisma: prisma },
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
      { projectorPrisma: prisma },
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
      { projectorPrisma: prisma },
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
