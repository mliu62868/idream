import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_TO_MAIN_EVENTS } from "@idream/shared/contracts";
import {
  releasedKnowledgeDigest,
  type CompanionShadowComparison,
} from "@idream/shared/chat/companion-runtime";
import type { ChatPrismaClient } from "./db.js";
import { BoundedShadowExecutor } from "./companion-shadow-executor.js";

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
const invalidateReadinessMock = vi.hoisted(() => vi.fn());
const recordMemoryPromotionFailureMock = vi.hoisted(() => vi.fn());
const recordMemoryPromotionSuccessMock = vi.hoisted(() => vi.fn());
const canAdmitShadowMock = vi.hoisted(() => vi.fn(() => true));
const dshRunMock = vi.hoisted(() => vi.fn());
const dshCancelMock = vi.hoisted(() => vi.fn(async () => {}));
const verifiedProfileDigestState = vi.hoisted(() => ({ value: "d".repeat(64) }));
const ensureMemoryCutoverMock = vi.hoisted(() => vi.fn(async () => ({
  schemaVersion: 1 as const,
  status: "cutover_ready" as const,
  mode: "empty" as const,
  legacySourceChecksum: "a".repeat(64),
  importChecksum: "b".repeat(64),
  igrepVersion: "0.1.132" as const,
  cutoverWorkspaceVersion: "rebuild-1787169600000-11111111-1111-4111-8111-111111111111",
  workspaceVersion: "rebuild-1787169600000-11111111-1111-4111-8111-111111111111",
  recallParity: { probeSetChecksum: "c".repeat(64), total: 0, passed: 0 },
  completedAt: "2026-08-19T12:00:00.000Z",
})));

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
  chatFsPaths: {
    memory: () => ["mem", "user", "character", "memory.md"],
    sessionLog: () => "/tmp/session.jsonl",
  },
  withFileMutationLock: async (_path: string[], run: () => Promise<unknown>) => run(),
}));
vi.mock("./queue.js", () => ({ enqueue: enqueueMock }));
vi.mock("./runtime-readiness.js", () => ({
  runtimeReadiness: {
    invalidate: invalidateReadinessMock,
    recordTurnFailure: recordTurnFailureMock,
    recordTurnSuccess: recordTurnSuccessMock,
    recordMemoryPromotionFailure: recordMemoryPromotionFailureMock,
    recordMemoryPromotionSuccess: recordMemoryPromotionSuccessMock,
    canAdmitShadow: canAdmitShadowMock,
  },
}));
vi.mock("./companion-runtime.js", () => ({
  DshCompanionRuntime: class {
    run = dshRunMock;
    cancel = dshCancelMock;
  },
}));
vi.mock("./companion-sidecar-readiness.js", () => ({
  verifiedCompanionProfileDigest: () => verifiedProfileDigestState.value,
}));
vi.mock("./companion-memory-cutover-runtime.js", () => ({
  ensureCompanionMemoryCutoverTx: ensureMemoryCutoverMock,
}));

const {
  claimGenerateAttemptAuthority,
  drainDshShadowExecutor,
  persistAttemptRuntimeTraceCas,
  persistShadowComparison,
  processGenerate,
  processGenerateJob,
  terminalizeGenerateJobFailure,
} = await import("./generate.js");

type CreateCall = { data: Record<string, unknown>; where?: Record<string, unknown> };

/** The one in-transaction write that carries the turn's terminal ledger row. */
function finalizedMessageUpdate(
  messageUpdates: CreateCall[],
): Record<string, unknown> | undefined {
  return messageUpdates.find(
    (call) => (call.data as { status?: string }).status === "sent",
  )?.data;
}

function shadowComparisonFixture(
  status: "completed" | "cancelled" = "completed",
): CompanionShadowComparison {
  const primary = {
    provider: "mock",
    model: "local-model",
    textDigest: "a".repeat(64),
    textLength: 15,
    finishReason: "stop" as const,
    usage: { promptTokens: 12, completionTokens: 3 },
    latencyMs: 10,
    toolCalls: 0,
  };
  if (status === "cancelled") {
    return {
      schemaVersion: 1,
      status,
      invocationId: "shadow:inv:msg_assistant:1",
      attemptId: "shadow:msg_assistant:1",
      profileDigest: "d".repeat(64),
      profileVerified: false,
      primary: { ...primary, finishReason: "cancelled" },
      shadow: null,
      workspace: null,
      commitRejected: false,
      error: { code: "shadow_primary_cancelled", message: "primary cancelled" },
      textDigestEqual: false,
    };
  }
  return {
    schemaVersion: 1,
    status,
    invocationId: "shadow:inv:msg_assistant:1",
    attemptId: "shadow:msg_assistant:1",
    profileDigest: "d".repeat(64),
    profileVerified: true,
    primary,
    shadow: {
      provider: "mock",
      model: "local-model",
      textDigest: "b".repeat(64),
      textLength: 16,
      finishReason: "stop",
      usage: { promptTokens: 11, completionTokens: 4, reasoningTokens: 2 },
      latencyMs: 12,
      toolCalls: 0,
      dryRunToolCalls: 0,
      steps: 1,
    },
    workspace: {
      memoryMode: "shadow",
      workspaceClass: "shadow",
      disposition: "discarded",
      commitAccepted: false,
      promotionAttempted: false,
    },
    commitRejected: true,
    textDigestEqual: false,
  };
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
  assistantRuntimeTrace?: Record<string, unknown>,
  terminalContextRevision: bigint = 0n,
  assistantState: {
    status?: "pending" | "generating";
    attempt?: number;
    strictClaimCas?: boolean;
    failToolReservation?: boolean;
  } = {},
) {
  const attachmentCreates: CreateCall[] = [];
  const outboxCreates: CreateCall[] = [];
  const messageUpdates: CreateCall[] = [];
  const rootMessageUpdates: CreateCall[] = [];
  let currentAssistantStatus: string = assistantState.status ?? "generating";
  const currentAssistantAttempt = assistantState.attempt ?? 1;
  let currentAssistantTrace: Record<string, unknown> | null = assistantRuntimeTrace ?? null;
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
            status: currentAssistantStatus,
            attempt: currentAssistantAttempt,
            replyToMessageId: "msg_user",
            deletedAt: null,
            runtimeTrace: currentAssistantTrace,
          },
      updateMany: async (call: CreateCall) => {
        messageUpdates.push(call);
        if (
          assistantState.strictClaimCas &&
          call.data.status === "generating" &&
          (
            call.where?.status !== currentAssistantStatus ||
            call.where?.attempt !== currentAssistantAttempt
          )
        ) {
          return { count: 0 };
        }
        if (typeof call.data.status === "string") currentAssistantStatus = call.data.status;
        if (call.data.runtimeTrace && typeof call.data.runtimeTrace === "object") {
          currentAssistantTrace = call.data.runtimeTrace as Record<string, unknown>;
        }
        return { count: 1 };
      },
      update: async (call: CreateCall) => {
        messageUpdates.push(call);
        if (typeof call.data.status === "string") currentAssistantStatus = call.data.status;
        if (call.data.runtimeTrace && typeof call.data.runtimeTrace === "object") {
          currentAssistantTrace = call.data.runtimeTrace as Record<string, unknown>;
        }
        return {};
      },
    },
    messageVersion: {
      findUnique: async () => ({ runtimeTrace: null }),
      upsert: async () => ({}),
      updateMany: async () => ({ count: 1 }),
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
        contextRevision: terminalContextRevision,
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
              status: currentAssistantStatus,
              attempt: currentAssistantAttempt,
              replyToMessageId: "msg_user",
              memoryAuthority: turnAuthority?.memoryAuthority ?? "enabled",
              runtimeTrace: currentAssistantTrace,
            },
      updateMany: async (call: CreateCall) => {
        rootMessageUpdates.push(call);
        const nextTrace = call.data.runtimeTrace;
        if (
          assistantState.failToolReservation &&
          nextTrace &&
          typeof nextTrace === "object" &&
          "companionTool" in nextTrace
        ) {
          return { count: 0 };
        }
        if (typeof call.data.status === "string") currentAssistantStatus = call.data.status;
        if (call.data.runtimeTrace && typeof call.data.runtimeTrace === "object") {
          currentAssistantTrace = call.data.runtimeTrace as Record<string, unknown>;
        }
        return { count: 1 };
      },
    },
    messageVersion: {
      upsert: async () => ({}),
      update: async () => ({}),
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

  return {
    prisma,
    attachmentCreates,
    outboxCreates,
    messageUpdates,
    rootMessageUpdates,
    assistantTrace: () => currentAssistantTrace,
  };
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
  releasedKnowledge: (() => {
    const authority = {
      characterId: "char_1",
      characterContentVersionId: "content_v4",
      characterReleaseId: "release_v3",
      files: [] as [],
    };
    return { ...authority, digest: releasedKnowledgeDigest(authority) };
  })(),
};

function installDshRolloutEnv(): () => void {
  const previous = {
    runtime: process.env.CHAT_COMPANION_RUNTIME,
    memory: process.env.CHAT_MEMORY_BACKEND,
    token: process.env.DSH_AGENT_TOKEN,
    rolloutSalt: process.env.CHAT_COMPANION_DSH_ROLLOUT_SALT,
    rolloutBps: process.env.CHAT_COMPANION_DSH_ROLLOUT_BPS,
    rolloutAllowlist: process.env.CHAT_COMPANION_DSH_ROLLOUT_ALLOWLIST,
    deadlineMs: process.env.DSH_AGENT_DEADLINE_MS,
  };
  process.env.CHAT_COMPANION_RUNTIME = "dsh";
  process.env.CHAT_MEMORY_BACKEND = "igrep-dsh";
  process.env.DSH_AGENT_TOKEN = "test-sidecar-token";
  process.env.CHAT_COMPANION_DSH_ROLLOUT_SALT = "phase4-stable-salt";
  process.env.CHAT_COMPANION_DSH_ROLLOUT_BPS = "10000";
  process.env.DSH_AGENT_DEADLINE_MS = "300000";
  delete process.env.CHAT_COMPANION_DSH_ROLLOUT_ALLOWLIST;
  return () => {
    for (const [name, value] of Object.entries({
      CHAT_COMPANION_RUNTIME: previous.runtime,
      CHAT_MEMORY_BACKEND: previous.memory,
      DSH_AGENT_TOKEN: previous.token,
      CHAT_COMPANION_DSH_ROLLOUT_SALT: previous.rolloutSalt,
      CHAT_COMPANION_DSH_ROLLOUT_BPS: previous.rolloutBps,
      CHAT_COMPANION_DSH_ROLLOUT_ALLOWLIST: previous.rolloutAllowlist,
      DSH_AGENT_DEADLINE_MS: previous.deadlineMs,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

function installDshShadowEnv(): () => void {
  const previous = {
    runtime: process.env.CHAT_COMPANION_RUNTIME,
    memory: process.env.CHAT_MEMORY_BACKEND,
    token: process.env.DSH_AGENT_TOKEN,
    shadow: process.env.CHAT_COMPANION_DSH_SHADOW_ENABLED,
  };
  process.env.CHAT_COMPANION_RUNTIME = "native";
  process.env.CHAT_MEMORY_BACKEND = "legacy";
  process.env.DSH_AGENT_TOKEN = "test-shadow-sidecar-token";
  process.env.CHAT_COMPANION_DSH_SHADOW_ENABLED = "true";
  return () => {
    for (const [name, value] of Object.entries({
      CHAT_COMPANION_RUNTIME: previous.runtime,
      CHAT_MEMORY_BACKEND: previous.memory,
      DSH_AGENT_TOKEN: previous.token,
      CHAT_COMPANION_DSH_SHADOW_ENABLED: previous.shadow,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

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
    invalidateReadinessMock.mockClear();
    recordMemoryPromotionFailureMock.mockClear();
    recordMemoryPromotionSuccessMock.mockClear();
    canAdmitShadowMock.mockReset();
    canAdmitShadowMock.mockReturnValue(true);
    dshRunMock.mockReset();
    dshCancelMock.mockClear();
    ensureMemoryCutoverMock.mockClear();
    verifiedProfileDigestState.value = "d".repeat(64);
    buildContextMock.mockResolvedValue(context);
    moderationMock.mockResolvedValue({ status: "passed", confidence: 0.5 });
    supportsToolsState.value = true;
  });

  it("atomically claims the exact attempt route and MessageVersion or rolls both back", async () => {
    const stored: {
      messageTrace: Record<string, unknown> | null;
      versionTrace: Record<string, unknown> | null;
    } = { messageTrace: null, versionTrace: null };
    let messageWhere: Record<string, unknown> | undefined;
    let versionUpdate: Record<string, unknown> | undefined;
    let versionClaimUpdate: Record<string, unknown> | undefined;
    let rejectVersionCas = true;
    const prisma = {
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
        const pending = structuredClone(stored);
        const tx = {
          message: {
            updateMany: vi.fn(async (call: CreateCall) => {
              messageWhere = call.where;
              pending.messageTrace = call.data.runtimeTrace as Record<string, unknown>;
              return { count: 1 };
            }),
          },
          messageVersion: {
            upsert: vi.fn(async (call: {
              create: CreateCall["data"];
              update: Record<string, unknown>;
            }) => {
              pending.versionTrace = call.create.runtimeTrace as Record<string, unknown>;
              versionUpdate = call.update;
              return {};
            }),
            updateMany: vi.fn(async (call: CreateCall) => {
              if (rejectVersionCas) return { count: 0 };
              versionClaimUpdate = call.data;
              pending.versionTrace = call.data.runtimeTrace as Record<string, unknown>;
              return { count: 1 };
            }),
          },
        };
        const result = await callback(tx);
        Object.assign(stored, pending);
        return result;
      }),
    } as unknown as ChatPrismaClient;
    const trace = {
      companionRuntime: {
        runtime: "dsh",
        profileDigest: "d".repeat(64),
      },
    };
    const input = {
      prisma,
      payload: {
        sessionId: "sess_1",
        assistantMessageId: "msg_assistant",
        userMessageId: "msg_user",
        attempt: 1,
      },
      runtimeTrace: trace,
      model: null,
      expectedMessageStatus: "pending" as const,
    };

    await expect(claimGenerateAttemptAuthority(input)).rejects.toThrow(/version CAS/i);
    expect(stored).toEqual({ messageTrace: null, versionTrace: null });

    rejectVersionCas = false;
    await expect(claimGenerateAttemptAuthority(input)).resolves.toBe(true);
    expect(stored).toEqual({ messageTrace: trace, versionTrace: trace });
    expect(messageWhere).toMatchObject({ status: "pending" });
    expect(versionUpdate).toEqual({ runtimeTrace: trace });
    expect(versionClaimUpdate).toEqual({ runtimeTrace: trace });
  });

  it("claims an edited reply's new attempt instead of reusing the previous attempt trace", async () => {
    supportsToolsState.value = false;
    streamMock.mockImplementation(async function* editedReplyStream() {
      yield { delta: "reply after edit", done: true };
    });
    const previousAttemptTrace = {
      schemaVersion: 1,
      attempt: 1,
      companionRuntime: {
        runtime: "native",
        memoryBackend: "legacy",
        profile: "native",
        private: false,
      },
      primaryTelemetry: {
        schemaVersion: 1,
        runtime: "native",
        startedAt: "2026-08-19T12:00:00.000Z",
        retryCount: 0,
        terminalStatus: "sent",
      },
    };
    const { prisma, messageUpdates } = fakePrisma(
      undefined,
      undefined,
      undefined,
      previousAttemptTrace,
      0n,
      { status: "pending", attempt: 2, strictClaimCas: true },
    );

    await expect(processGenerate(
      {
        sessionId: "sess_1",
        assistantMessageId: "msg_assistant",
        userMessageId: "msg_user",
        attempt: 2,
      },
      prisma,
      { projectorPrisma: prisma },
    )).resolves.toEqual({ status: "sent" });

    expect(messageUpdates[0]).toMatchObject({
      where: { status: "pending", attempt: 2 },
      data: {
        status: "generating",
        runtimeTrace: expect.objectContaining({ attempt: 2 }),
      },
    });
    expect(finalizedMessageUpdate(messageUpdates)).toMatchObject({
      status: "sent",
      content: "reply after edit",
      runtimeTrace: expect.objectContaining({ attempt: 2 }),
    });
  });

  it("delivers only native output while auditing a dry-run DSH shadow", async () => {
    const restoreEnv = installDshShadowEnv();
    let shadowToolResult: unknown;
    let shadowCommitAck: unknown;
    try {
      streamMock.mockImplementation(async function* nativeStream() {
        yield {
          delta: "native delivery",
          done: true,
          usage: { promptTokens: 12, completionTokens: 3 },
        };
      });
      dshRunMock.mockImplementation(async (invocation, port) => {
        expect(invocation).toMatchObject({
          memoryMode: "shadow",
          attemptId: "shadow:msg_assistant:1",
          invocationId: "shadow:inv:msg_assistant:1",
          expectedProfileDigest: "d".repeat(64),
        });
        await port.emit({
          type: "started",
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          sequence: 1,
          occurredAt: new Date().toISOString(),
          instance: {
            id: "11111111-1111-4111-8111-111111111111",
            startedAt: new Date().toISOString(),
          },
          profileDigest: "d".repeat(64),
        });
        shadowToolResult = await port.executeTool({
          attemptId: invocation.attemptId,
          callId: "shadow-call-1",
          name: "generate_image_async",
          arguments: { prompt: "Mira beside the blue observatory window" },
        });
        const candidate = {
          attemptId: invocation.attemptId,
          content: "shadow candidate",
          finishReason: "stop" as const,
          provider: "mock",
          model: "local-model",
          usage: { promptTokens: 11, completionTokens: 4, reasoningTokens: 2 },
          execution: { steps: 2, toolCalls: 1 },
          completedAt: new Date().toISOString(),
        };
        await port.emit({
          type: "terminal_candidate",
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          sequence: 2,
          occurredAt: new Date().toISOString(),
          candidate,
        });
        shadowCommitAck = await port.commit(candidate);
        await port.emit({
          type: "workspace_settled",
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          sequence: 3,
          occurredAt: new Date().toISOString(),
          memoryMode: "shadow",
          workspaceClass: "shadow",
          disposition: "discarded",
          commitAccepted: false,
          promotionAttempted: false,
        });
      });
      const { prisma, messageUpdates, rootMessageUpdates, attachmentCreates } = fakePrisma();

      await expect(processGenerate(
        { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
        prisma,
        { projectorPrisma: prisma },
      )).resolves.toEqual({ status: "sent" });
      await drainDshShadowExecutor();

      expect(finalizedMessageUpdate(messageUpdates)).toMatchObject({
        status: "sent",
        content: "native delivery",
      });
      expect(attachmentCreates).toEqual([]);
      expect(shadowToolResult).toMatchObject({
        outcome: "succeeded",
        output: { status: "shadow_dry_run", effectCreated: false },
      });
      expect(shadowCommitAck).toMatchObject({
        accepted: false,
        error: { code: "shadow_terminal_observed" },
      });
      const deliveredDeltas = (appendStreamEventMock.mock.calls as unknown[][])
        .map((call) => call[1] as { type?: string; delta?: string })
        .filter((event) => event.type === "delta")
        .map((event) => event.delta);
      expect(deliveredDeltas).toEqual(["native delivery"]);
      expect([...messageUpdates, ...rootMessageUpdates]).toContainEqual(expect.objectContaining({
        data: {
          runtimeTrace: expect.objectContaining({
            schemaVersion: 1,
            attempt: 1,
            assistantMessageId: "msg_assistant",
            userMessageId: "msg_user",
            profile: expect.objectContaining({ model: "local-model" }),
            trace: expect.objectContaining({ soulFingerprint: expect.any(String) }),
            budget: expect.objectContaining({ usedInputTokens: expect.any(Number) }),
            companionRuntime: expect.objectContaining({ runtime: "native" }),
            scene: null,
            outputAuthority: "model",
            primaryTelemetry: {
              schemaVersion: 1,
              runtime: "native",
              startedAt: expect.any(String),
              firstTokenMs: expect.any(Number),
              totalMs: expect.any(Number),
              terminalStatus: "sent",
              truncated: false,
              provider: "mock",
              model: "local-model",
              usage: { promptTokens: 12, completionTokens: 3 },
              steps: 2,
              toolCalls: 0,
              retryCount: 0,
              sseTerminal: "done",
              memory: { outcome: "pending" },
            },
            shadowComparison: expect.objectContaining({
              schemaVersion: 1,
              status: "completed",
              profileDigest: "d".repeat(64),
              primary: expect.objectContaining({
                textDigest: "851477efacde2d6eadbb48983aed7bd31d03def3f94ed7b06534cff9560f2bc4",
                textLength: 15,
                finishReason: "stop",
                usage: { promptTokens: 12, completionTokens: 3 },
                toolCalls: 0,
                latencyMs: expect.any(Number),
              }),
              shadow: expect.objectContaining({
                textDigest: "8fe9189530e7ad5f270b71ea233b15564f619476fbb6e5349baac7c8b1cd3126",
                textLength: 16,
                finishReason: "stop",
                usage: { promptTokens: 11, completionTokens: 4, reasoningTokens: 2 },
                toolCalls: 1,
                latencyMs: expect.any(Number),
              }),
              workspace: {
                memoryMode: "shadow",
                workspaceClass: "shadow",
                disposition: "discarded",
                commitAccepted: false,
                promotionAttempted: false,
              },
            }),
          }),
        },
      }));
    } finally {
      restoreEnv();
    }
  });

  it("starts the accepted DSH shadow before the native provider completes", async () => {
    const restoreEnv = installDshShadowEnv();
    let markShadowStarted!: () => void;
    const shadowStarted = new Promise<void>((resolve) => { markShadowStarted = resolve; });
    try {
      streamMock.mockImplementation(async function* nativeStream() {
        await Promise.race([
          shadowStarted,
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error("shadow did not start beside primary")), 100);
          }),
        ]);
        yield { delta: "native after concurrent admission", done: true };
      });
      dshRunMock.mockImplementation(async () => { markShadowStarted(); });
      const { prisma } = fakePrisma();

      await expect(processGenerate(
        { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
        prisma,
        { projectorPrisma: prisma },
      )).resolves.toEqual({ status: "sent" });
      await drainDshShadowExecutor();
    } finally {
      restoreEnv();
    }
  });

  it("keeps the native terminal successful when DSH shadow fails", async () => {
    const restoreEnv = installDshShadowEnv();
    try {
      streamMock.mockImplementation(async function* nativeStream() {
        yield { delta: "native survives", done: true };
      });
      dshRunMock.mockRejectedValue(new Error("shadow sidecar unavailable"));
      const { prisma, messageUpdates, rootMessageUpdates } = fakePrisma();

      await expect(processGenerate(
        { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
        prisma,
        { projectorPrisma: prisma },
      )).resolves.toEqual({ status: "sent" });
      await drainDshShadowExecutor();

      expect(finalizedMessageUpdate(messageUpdates)).toMatchObject({
        status: "sent",
        content: "native survives",
      });
      expect([...messageUpdates, ...rootMessageUpdates]).toContainEqual(expect.objectContaining({
        data: {
          runtimeTrace: expect.objectContaining({
            shadowComparison: expect.objectContaining({
              status: "error",
              shadow: null,
              error: {
                code: "shadow_runtime_error",
                message: "shadow sidecar unavailable",
              },
            }),
          }),
        },
      }));
      expect(appendStreamEventMock).toHaveBeenCalledWith(
        "chat:stream:msg_assistant",
        expect.objectContaining({ type: "done" }),
      );
    } finally {
      restoreEnv();
    }
  });

  it("delivers native SSE without waiting for an unresolved DSH shadow", async () => {
    const restoreEnv = installDshShadowEnv();
    let releaseShadow!: () => void;
    const unresolvedShadow = new Promise<void>((resolve) => { releaseShadow = resolve; });
    try {
      streamMock.mockImplementation(async function* nativeStream() {
        yield { delta: "native is already done", done: true };
      });
      dshRunMock.mockImplementation(() => unresolvedShadow);
      const { prisma } = fakePrisma();

      const result = await Promise.race([
        processGenerate(
          { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
          prisma,
          { projectorPrisma: prisma },
        ),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("primary waited for shadow")), 100);
        }),
      ]);

      expect(result).toEqual({ status: "sent" });
      expect(appendStreamEventMock).toHaveBeenCalledWith(
        "chat:stream:msg_assistant",
        expect.objectContaining({ type: "done" }),
      );
    } finally {
      releaseShadow();
      await drainDshShadowExecutor();
      restoreEnv();
    }
  });

  it("does not even enqueue shadow work for a no-memory turn", async () => {
    const restoreEnv = installDshShadowEnv();
    try {
      streamMock.mockImplementation(async function* nativeStream() {
        yield { delta: "private native reply", done: true };
      });
      const { prisma, messageUpdates } = fakePrisma(
        undefined,
        undefined,
        { content: "ordinary private turn", memoryAuthority: "disabled" },
      );
      const shadowExecutor = {
        submit: vi.fn(() => ({ cancel: vi.fn(), onSettled: vi.fn(async () => {}) })),
        cancel: vi.fn(),
        onIdle: vi.fn(async () => {}),
      };

      await expect(processGenerate(
        { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
        prisma,
        { projectorPrisma: prisma, shadowExecutor },
      )).resolves.toEqual({ status: "sent" });

      expect(shadowExecutor.submit).not.toHaveBeenCalled();
      expect(dshRunMock).not.toHaveBeenCalled();
      expect(canAdmitShadowMock).not.toHaveBeenCalled();
      expect(finalizedMessageUpdate(messageUpdates)).toMatchObject({
        runtimeTrace: expect.objectContaining({
          shadowAdmission: {
            schemaVersion: 1,
            status: "skipped_private",
            enqueued: false,
          },
        }),
      });
    } finally {
      restoreEnv();
    }
  });

  it("delivers the native primary without enqueuing an unready shadow", async () => {
    const restoreEnv = installDshShadowEnv();
    try {
      canAdmitShadowMock.mockReturnValue(false);
      streamMock.mockImplementation(async function* nativeStream() {
        yield { delta: "native remains available", done: true };
      });
      const { prisma, messageUpdates } = fakePrisma();
      const shadowExecutor = {
        submit: vi.fn(() => ({ cancel: vi.fn(), onSettled: vi.fn(async () => {}) })),
        cancel: vi.fn(),
        onIdle: vi.fn(async () => {}),
      };

      await expect(processGenerate(
        { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
        prisma,
        { projectorPrisma: prisma, shadowExecutor },
      )).resolves.toEqual({ status: "sent" });

      expect(finalizedMessageUpdate(messageUpdates)).toMatchObject({
        status: "sent",
        content: "native remains available",
      });
      expect(shadowExecutor.submit).not.toHaveBeenCalled();
      expect(dshRunMock).not.toHaveBeenCalled();
    } finally {
      restoreEnv();
    }
  });

  it("records queue saturation without delaying native delivery", async () => {
    const restoreEnv = installDshShadowEnv();
    try {
      streamMock.mockImplementation(async function* nativeStream() {
        yield { delta: "native survives pressure", done: true };
      });
      const { prisma, messageUpdates, rootMessageUpdates } = fakePrisma();
      const shadowExecutor = {
        submit: vi.fn(() => null),
        cancel: vi.fn(),
        onIdle: vi.fn(async () => {}),
      };

      await expect(processGenerate(
        { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
        prisma,
        { projectorPrisma: prisma, shadowExecutor },
      )).resolves.toEqual({ status: "sent" });
      await drainDshShadowExecutor();

      expect(dshRunMock).not.toHaveBeenCalled();
      expect([...messageUpdates, ...rootMessageUpdates]).toContainEqual(expect.objectContaining({
        data: {
          runtimeTrace: expect.objectContaining({
            shadowComparison: expect.objectContaining({
              status: "error",
              error: {
                code: "shadow_queue_saturated",
                message: "DSH shadow executor queue is saturated",
              },
            }),
          }),
        },
      }));
    } finally {
      restoreEnv();
    }
  });

  it("cancels an active shadow and records provider-failure evidence without waiting", async () => {
    const restoreEnv = installDshShadowEnv();
    const executor = new BoundedShadowExecutor({ concurrency: 1, maxQueued: 1 });
    try {
      supportsToolsState.value = false;
      streamMock.mockImplementation(async function* failedPrimary() {
        throw new Error("primary provider unavailable");
      });
      dshRunMock.mockImplementation(async (_invocation, _port, signal: AbortSignal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      });
      const { prisma, messageUpdates, rootMessageUpdates } = fakePrisma();

      await expect(processGenerate(
        { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
        prisma,
        { projectorPrisma: prisma, shadowExecutor: executor },
      )).rejects.toThrow("primary provider unavailable");
      await executor.onIdle();
      await drainDshShadowExecutor();

      expect(dshCancelMock).toHaveBeenCalledWith("shadow:inv:msg_assistant:1", "user");
      expect([...messageUpdates, ...rootMessageUpdates]).toContainEqual(expect.objectContaining({
        data: {
          runtimeTrace: expect.objectContaining({
            shadowComparison: expect.objectContaining({
              status: "cancelled",
              shadow: null,
              error: {
                code: "shadow_primary_provider_failed",
                message: "DSH shadow cancelled because the primary provider failed",
              },
            }),
          }),
        },
      }));
    } finally {
      executor.cancel("test_cleanup");
      await executor.onIdle();
      restoreEnv();
    }
  });

  it("cancels shadow on a primary terminal CAS conflict and records the reason", async () => {
    const restoreEnv = installDshShadowEnv();
    const executor = new BoundedShadowExecutor({ concurrency: 1, maxQueued: 1 });
    try {
      supportsToolsState.value = false;
      streamMock.mockImplementation(async function* nativeStream() {
        yield { delta: "obsolete reply", done: true };
      });
      dshRunMock.mockImplementation(async (_invocation, _port, signal: AbortSignal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      });
      const { prisma, messageUpdates, rootMessageUpdates } = fakePrisma(
        undefined,
        undefined,
        undefined,
        undefined,
        1n,
      );

      await expect(processGenerate(
        { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
        prisma,
        { projectorPrisma: prisma, shadowExecutor: executor },
      )).resolves.toEqual({ status: "failed" });
      await executor.onIdle();
      await drainDshShadowExecutor();

      expect([...messageUpdates, ...rootMessageUpdates]).toContainEqual(expect.objectContaining({
        data: {
          runtimeTrace: expect.objectContaining({
            shadowComparison: expect.objectContaining({
              status: "cancelled",
              error: expect.objectContaining({ code: "shadow_primary_context_changed" }),
            }),
          }),
        },
      }));
    } finally {
      executor.cancel("test_cleanup");
      await executor.onIdle();
      restoreEnv();
    }
  });

  it("persists shadow_shutdown_cancelled for accepted queued work before idle", async () => {
    const restoreEnv = installDshShadowEnv();
    const executor = new BoundedShadowExecutor({ concurrency: 1, maxQueued: 1 });
    try {
      streamMock.mockImplementation(async function* nativeStream() {
        yield { delta: "native remains authoritative", done: true };
      });
      dshRunMock.mockImplementation(async (_invocation, _port, signal: AbortSignal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      });
      const first = fakePrisma();
      const second = fakePrisma();

      await processGenerate(
        { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
        first.prisma,
        { projectorPrisma: first.prisma, shadowExecutor: executor },
      );
      await processGenerate(
        { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
        second.prisma,
        { projectorPrisma: second.prisma, shadowExecutor: executor },
      );

      executor.cancel("shutdown");
      await executor.onIdle();
      await drainDshShadowExecutor();

      expect([...second.messageUpdates, ...second.rootMessageUpdates]).toContainEqual(expect.objectContaining({
        data: {
          runtimeTrace: expect.objectContaining({
            shadowComparison: expect.objectContaining({
              status: "cancelled",
              error: {
                code: "shadow_shutdown_cancelled",
                message: "DSH shadow cancelled during worker shutdown",
              },
            }),
          }),
        },
      }));
    } finally {
      executor.cancel("test_cleanup");
      await executor.onIdle();
      restoreEnv();
    }
  });

  it("rolls back both shadow comparison traces when the version CAS misses", async () => {
    const committed = { message: "before", version: "before" };
    const prisma = {
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
        let pendingMessage = committed.message;
        const tx = {
          message: {
            findUnique: vi.fn(async () => ({
              status: "sent",
              attempt: 1,
              runtimeTrace: { schemaVersion: 1 },
            })),
            updateMany: vi.fn(async (call: CreateCall) => {
              pendingMessage = JSON.stringify(call.data.runtimeTrace);
              return { count: 1 };
            }),
          },
          messageVersion: {
            findUnique: vi.fn(async () => ({ runtimeTrace: { schemaVersion: 1 } })),
            updateMany: vi.fn(async () => ({ count: 0 })),
          },
        };
        const result = await callback(tx);
        committed.message = pendingMessage;
        return result;
      }),
    } as unknown as ChatPrismaClient;

    await expect(persistShadowComparison({
      prisma,
      payload: {
        sessionId: "sess_1",
        assistantMessageId: "msg_assistant",
        userMessageId: "msg_user",
        attempt: 1,
      },
      terminalStatus: "sent",
      runtimeTraceFacts: { schemaVersion: 1 },
      truncated: false,
      shadowComparison: shadowComparisonFixture(),
    })).resolves.toBeUndefined();

    expect(committed).toEqual({ message: "before", version: "before" });
  });

  it("keeps terminal attempt traces atomic and exposes a retryable failed write", async () => {
    const stored: {
      status: string;
      messageTrace: Record<string, unknown>;
      versionTrace: Record<string, unknown>;
    } = {
      status: "sent",
      messageTrace: { state: "terminal" },
      versionTrace: { state: "terminal" },
    };
    let rejectVersionCas = true;
    const prisma = {
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
        const pending = structuredClone(stored);
        const tx = {
          message: {
            updateMany: vi.fn(async (call: CreateCall) => {
              if (call.where?.status !== stored.status) return { count: 0 };
              pending.messageTrace = call.data.runtimeTrace as Record<string, unknown>;
              return { count: 1 };
            }),
          },
          messageVersion: {
            updateMany: vi.fn(async (call: CreateCall) => {
              if (rejectVersionCas) return { count: 0 };
              pending.versionTrace = call.data.runtimeTrace as Record<string, unknown>;
              return { count: 1 };
            }),
          },
        };
        const result = await callback(tx);
        Object.assign(stored, pending);
        return result;
      }),
    } as unknown as ChatPrismaClient;
    const payload = {
      sessionId: "sess_1",
      assistantMessageId: "msg_assistant",
      userMessageId: "msg_user",
      attempt: 1,
    };
    const trace = { state: "settled", primaryTelemetry: { memory: { outcome: "ingested" } } };

    await expect(persistAttemptRuntimeTraceCas({
      prisma,
      payload,
      expectedMessageStatus: "sent",
      trace,
      stage: "dsh_memory_settlement",
    })).resolves.toBe("failed");
    expect(stored).toEqual({
      status: "sent",
      messageTrace: { state: "terminal" },
      versionTrace: { state: "terminal" },
    });

    rejectVersionCas = false;
    await expect(persistAttemptRuntimeTraceCas({
      prisma,
      payload,
      expectedMessageStatus: "sent",
      trace,
      stage: "dsh_memory_settlement",
    })).resolves.toBe("updated");
    expect(stored.messageTrace).toEqual(trace);
    expect(stored.versionTrace).toEqual(trace);
  });

  it("pins the PreparedTurn model on the exact MessageVersion in the trace transaction", async () => {
    const writes: { message?: CreateCall["data"]; version?: CreateCall["data"] } = {};
    const tx = {
      message: {
        updateMany: vi.fn(async (call: CreateCall) => {
          writes.message = call.data;
          return { count: 1 };
        }),
      },
      messageVersion: {
        updateMany: vi.fn(async (call: CreateCall) => {
          writes.version = call.data;
          return { count: 1 };
        }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as ChatPrismaClient;
    const trace = { schemaVersion: 1, state: "prepared" };

    await expect(persistAttemptRuntimeTraceCas({
      prisma,
      payload: {
        sessionId: "sess_1",
        assistantMessageId: "msg_assistant",
        userMessageId: "msg_user",
        attempt: 1,
      },
      expectedMessageStatus: "generating",
      trace,
      stage: "prepared_turn",
      versionModel: "selected-model",
    })).resolves.toBe("updated");

    expect(writes.message).toEqual({ runtimeTrace: trace });
    expect(writes.version).toEqual({ runtimeTrace: trace, model: "selected-model" });
  });

  it("merges detached shadow evidence into the latest retry telemetry", async () => {
    const updates: CreateCall[] = [];
    const currentTrace = {
      schemaVersion: 1,
      primaryTelemetry: { schemaVersion: 1, runtime: "native", retryCount: 2 },
    };
    const tx = {
      message: {
        findUnique: vi.fn(async () => ({
          status: "generating",
          attempt: 1,
          runtimeTrace: currentTrace,
        })),
        updateMany: vi.fn(async (call: CreateCall) => {
          updates.push(call);
          return { count: 1 };
        }),
      },
      messageVersion: {
        findUnique: vi.fn(async () => ({ runtimeTrace: currentTrace })),
        updateMany: vi.fn(async (call: CreateCall) => {
          updates.push(call);
          return { count: 1 };
        }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as ChatPrismaClient;

    await persistShadowComparison({
      prisma,
      payload: {
        sessionId: "sess_1",
        assistantMessageId: "msg_assistant",
        userMessageId: "msg_user",
        attempt: 1,
      },
      terminalStatuses: ["generating", "failed"],
      runtimeTraceFacts: {
        schemaVersion: 1,
        primaryTelemetry: { schemaVersion: 1, runtime: "native", retryCount: 1 },
      },
      truncated: false,
      shadowComparison: shadowComparisonFixture("cancelled"),
    });

    expect(updates).toHaveLength(2);
    for (const update of updates) {
      expect(update.data.runtimeTrace).toMatchObject({
        primaryTelemetry: { retryCount: 2 },
        shadowComparison: { status: "cancelled" },
      });
    }
  });

  it("routes a pinned DSH attempt through the Chat commit port before SSE done", async () => {
    const restoreEnv = installDshRolloutEnv();
    try {
      dshRunMock.mockImplementation(async (invocation, port) => {
        expect(invocation.preparedTurn).toMatchObject({
          version: 2,
          releasedKnowledge: context.releasedKnowledge,
          trace: {
            characterReleaseId: "release_v3",
            releasedKnowledgeDigest: context.releasedKnowledge.digest,
          },
        });
        expect(invocation.expectedProfileDigest).toBe("d".repeat(64));
        await port.executeTool({
          attemptId: invocation.attemptId,
          callId: "call-1",
          name: "generate_image_async",
          arguments: {
            prompt: "Realistic portrait of Melissa beside a blue observatory window",
            caption: "The view is ours tonight.",
          },
        });
        await port.emit({
          type: "started",
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          sequence: 1,
          occurredAt: new Date().toISOString(),
          instance: {
            id: "11111111-1111-4111-8111-111111111111",
            startedAt: "2026-08-19T11:59:00.000Z",
          },
          profileDigest: "d".repeat(64),
        });
        await port.emit({
          type: "igrep_observation",
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          sequence: 2,
          occurredAt: new Date().toISOString(),
          operation: "memory",
          outcome: "hit",
          resultCount: 2,
          durationMs: 12,
        });
        await port.emit({
          type: "text_delta",
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          sequence: 3,
          occurredAt: new Date().toISOString(),
          delta: "hello from DSH",
        });
        const candidate = {
          attemptId: invocation.attemptId,
          content: "hello from DSH",
          finishReason: "stop",
          provider: "mock",
          model: "local-model",
          usage: { promptTokens: 10, completionTokens: 4, reasoningTokens: 2 },
          execution: { steps: 2, toolCalls: 1 },
          attribution: { requestId: "req-1", actualProvider: "local-mlx" },
          completedAt: new Date().toISOString(),
        };
        await port.emit({
          type: "terminal_candidate",
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          sequence: 4,
          occurredAt: new Date().toISOString(),
          candidate,
        });
        await port.commit(candidate);
      });
      const { prisma, messageUpdates, rootMessageUpdates, attachmentCreates } = fakePrisma();

      await expect(processGenerate(
        { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
        prisma,
        { projectorPrisma: prisma },
      )).resolves.toEqual({ status: "sent" });

      expect(buildContextMock).toHaveBeenCalledWith(expect.objectContaining({
        genericMemoryBackend: "runtime",
      }));
      expect(finalizedMessageUpdate(messageUpdates)).toMatchObject({
        status: "sent",
        content: "hello from DSH",
        runtimeTrace: expect.objectContaining({
          trace: expect.objectContaining({
            characterReleaseId: "release_v3",
            releasedKnowledgeDigest: context.releasedKnowledge.digest,
          }),
          companionRuntime: expect.objectContaining({
            runtime: "dsh",
            memoryCutover: expect.objectContaining({
              status: "cutover_ready",
              workspaceVersion: expect.any(String),
            }),
            assignment: expect.objectContaining({
              policyVersion: 1,
              reason: "threshold",
              thresholdBps: 10000,
            }),
          }),
          dsh: expect.objectContaining({
            version: "0.1.0-rc.7",
            igrepVersion: "0.1.132",
            memoryMode: "normal",
            profileDigest: "d".repeat(64),
          }),
          companion: expect.objectContaining({
            memoryIngestOutcome: "pending",
            execution: { steps: 2, toolCalls: 1 },
            attribution: { requestId: "req-1", actualProvider: "local-mlx" },
          }),
        }),
      });
      const streamTypes = (appendStreamEventMock.mock.calls as unknown[][])
        .map((call) => (call[1] as { type?: string } | undefined)?.type);
      expect(streamTypes).toEqual(expect.arrayContaining(["start", "delta", "done"]));
      expect(streamTypes.indexOf("done")).toBeGreaterThan(streamTypes.indexOf("delta"));
      expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({
        queue: "chat.memory.extract",
      }));
      expect(recordTurnSuccessMock).toHaveBeenCalledOnce();
      expect(recordMemoryPromotionSuccessMock).toHaveBeenCalledOnce();
      expect(recordMemoryPromotionFailureMock).not.toHaveBeenCalled();
      expect([...messageUpdates, ...rootMessageUpdates]).toContainEqual(expect.objectContaining({
        data: {
          runtimeTrace: expect.objectContaining({
            primaryTelemetry: {
              schemaVersion: 1,
              runtime: "dsh",
              startedAt: expect.any(String),
              firstTokenMs: expect.any(Number),
              totalMs: expect.any(Number),
              terminalStatus: "sent",
              truncated: false,
              provider: "mock",
              model: "local-model",
              usage: {
                promptTokens: 10,
                completionTokens: 4,
                reasoningTokens: 2,
              },
              steps: 2,
              toolCalls: 1,
              retryCount: 0,
              sseTerminal: "done",
              memory: {
                outcome: "ingested",
                settleLagMs: expect.any(Number),
              },
              sidecar: {
                instanceId: "11111111-1111-4111-8111-111111111111",
                startedAt: "2026-08-19T11:59:00.000Z",
                profileDigest: "d".repeat(64),
              },
              igrep: {
                memory: {
                  calls: 1,
                  hit: 1,
                  empty: 0,
                  failure: 0,
                  resultCount: 2,
                  latencyMs: [12],
                },
              },
            },
          }),
        },
      }));
      expect(attachmentCreates[0]?.data).toMatchObject({
        metadata: expect.objectContaining({
          toolCallIdentity: {
            attemptId: "msg_assistant:1",
            callId: "call-1",
          },
        }),
      });
    } finally {
      restoreEnv();
    }
  });

  it("refuses a new normal DSH claim until memory cutover is proven", async () => {
    const restoreEnv = installDshRolloutEnv();
    try {
      ensureMemoryCutoverMock.mockRejectedValueOnce(
        new Error("legacy memory import is required before DSH cutover"),
      );
      const { prisma, messageUpdates } = fakePrisma(
        undefined,
        undefined,
        undefined,
        undefined,
        0n,
        { status: "pending", strictClaimCas: true },
      );

      await expect(processGenerate(
        {
          sessionId: "sess_1",
          assistantMessageId: "msg_assistant",
          userMessageId: "msg_user",
          attempt: 1,
        },
        prisma,
        { projectorPrisma: prisma },
      )).rejects.toThrow("legacy memory import is required before DSH cutover");

      expect(ensureMemoryCutoverMock).toHaveBeenCalledOnce();
      expect(dshRunMock).not.toHaveBeenCalled();
      expect(messageUpdates).not.toContainEqual(expect.objectContaining({
        data: expect.objectContaining({ status: "generating" }),
      }));
    } finally {
      restoreEnv();
    }
  });

  it("records post-commit memory promotion failure without misclassifying the provider", async () => {
    const restoreEnv = installDshRolloutEnv();
    try {
      dshRunMock.mockImplementation(async (invocation, port) => {
        await port.emit({
          type: "text_delta",
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          sequence: 1,
          occurredAt: new Date().toISOString(),
          delta: "delivered reply",
        });
        const candidate = {
          attemptId: invocation.attemptId,
          content: "delivered reply",
          finishReason: "stop" as const,
          provider: "mock",
          model: "local-model",
          usage: { promptTokens: 10, completionTokens: 3, reasoningTokens: 0 },
          execution: { steps: 1, toolCalls: 0 },
          completedAt: new Date().toISOString(),
        };
        await port.emit({
          type: "terminal_candidate",
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          sequence: 2,
          occurredAt: new Date().toISOString(),
          candidate,
        });
        await port.commit(candidate);
        throw new Error("igrep promotion failed");
      });
      const { prisma, messageUpdates, rootMessageUpdates } = fakePrisma();

      await expect(processGenerate(
        { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
        prisma,
        { projectorPrisma: prisma },
      )).resolves.toEqual({ status: "sent" });

      expect([...messageUpdates, ...rootMessageUpdates]).toContainEqual(expect.objectContaining({
        data: expect.objectContaining({
          runtimeTrace: expect.objectContaining({
            companion: expect.objectContaining({ memoryIngestOutcome: "failed" }),
          }),
        }),
      }));
      expect(recordTurnSuccessMock).toHaveBeenCalledOnce();
      expect(recordTurnFailureMock).not.toHaveBeenCalled();
      expect(recordMemoryPromotionFailureMock).toHaveBeenCalledWith(
        expect.objectContaining({ message: "igrep promotion failed" }),
      );
      expect(recordMemoryPromotionSuccessMock).not.toHaveBeenCalled();
    } finally {
      restoreEnv();
    }
  });

  it("clears provider failures when a complete DSH candidate is blocked locally", async () => {
    const restoreEnv = installDshRolloutEnv();
    try {
      moderationMock.mockResolvedValue({
        status: "blocked",
        policyCode: "blocked_test",
        confidence: 1,
      });
      dshRunMock.mockImplementation(async (invocation, port) => {
        await port.emit({
          type: "text_delta",
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          sequence: 1,
          occurredAt: new Date().toISOString(),
          delta: "complete blocked reply",
        });
        const candidate = {
          attemptId: invocation.attemptId,
          content: "complete blocked reply",
          finishReason: "stop" as const,
          provider: "mock",
          model: "local-model",
          usage: { promptTokens: 10, completionTokens: 4, reasoningTokens: 0 },
          execution: { steps: 1, toolCalls: 0 },
          completedAt: new Date().toISOString(),
        };
        await port.emit({
          type: "terminal_candidate",
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          sequence: 2,
          occurredAt: new Date().toISOString(),
          candidate,
        });
        const ack = await port.commit(candidate);
        if (!ack.accepted) throw new Error(ack.error.code);
      });
      const { prisma } = fakePrisma();

      await expect(processGenerate(
        { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
        prisma,
        { projectorPrisma: prisma },
      )).resolves.toEqual({ status: "blocked" });

      expect(recordTurnSuccessMock).toHaveBeenCalledOnce();
      expect(recordTurnFailureMock).not.toHaveBeenCalled();
      expect(recordMemoryPromotionFailureMock).not.toHaveBeenCalled();
    } finally {
      restoreEnv();
    }
  });

  it("clears provider failures after a complete DSH candidate loses the context CAS", async () => {
    const restoreEnv = installDshRolloutEnv();
    try {
      dshRunMock.mockImplementation(async (invocation, port) => {
        await port.emit({
          type: "text_delta",
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          sequence: 1,
          occurredAt: new Date().toISOString(),
          delta: "complete stale reply",
        });
        const candidate = {
          attemptId: invocation.attemptId,
          content: "complete stale reply",
          finishReason: "stop" as const,
          provider: "mock",
          model: "local-model",
          usage: { promptTokens: 10, completionTokens: 4, reasoningTokens: 0 },
          execution: { steps: 1, toolCalls: 0 },
          completedAt: new Date().toISOString(),
        };
        await port.emit({
          type: "terminal_candidate",
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          sequence: 2,
          occurredAt: new Date().toISOString(),
          candidate,
        });
        const ack = await port.commit(candidate);
        if (!ack.accepted) throw new Error(ack.error.code);
      });
      const { prisma } = fakePrisma(
        undefined,
        undefined,
        undefined,
        undefined,
        1n,
      );

      await expect(processGenerate(
        { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
        prisma,
        { projectorPrisma: prisma },
      )).resolves.toEqual({ status: "failed" });

      expect(recordTurnSuccessMock).toHaveBeenCalledOnce();
      expect(recordTurnFailureMock).not.toHaveBeenCalled();
    } finally {
      restoreEnv();
    }
  });

  it("fails a selected DSH attempt closed without invoking the native provider", async () => {
    const restoreEnv = installDshRolloutEnv();
    try {
      dshRunMock.mockRejectedValue(new Error("sidecar unavailable"));
      const { prisma, messageUpdates, rootMessageUpdates } = fakePrisma();

      await expect(processGenerate(
        { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
        prisma,
        { projectorPrisma: prisma },
      )).rejects.toThrow("sidecar unavailable");

      expect(streamMock).not.toHaveBeenCalled();
      expect([...messageUpdates, ...rootMessageUpdates]).toContainEqual(expect.objectContaining({
        data: expect.objectContaining({
          runtimeTrace: expect.objectContaining({
            companionRuntime: expect.objectContaining({ runtime: "dsh" }),
            primaryTelemetry: expect.objectContaining({
              runtime: "dsh",
              terminalStatus: "failed",
              truncated: false,
              provider: "mock",
              model: "local-model",
              totalMs: expect.any(Number),
              steps: 0,
              toolCalls: 0,
              memory: { outcome: "not_started" },
              error: { category: "runtime", code: "dsh_runtime_error" },
              sseTerminal: "error",
            }),
          }),
        }),
      }));
      expect(recordTurnFailureMock).toHaveBeenCalledOnce();
      expect(recordTurnSuccessMock).not.toHaveBeenCalled();
    } finally {
      restoreEnv();
    }
  });

  it("fails a selected DSH attempt when started truth differs from its pinned profile", async () => {
    const restoreEnv = installDshRolloutEnv();
    try {
      dshRunMock.mockImplementation(async (invocation, port) => {
        expect(invocation.expectedProfileDigest).toBe("d".repeat(64));
        await port.emit({
          type: "started",
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          sequence: 1,
          occurredAt: new Date().toISOString(),
          instance: {
            id: "11111111-1111-4111-8111-111111111111",
            startedAt: "2026-08-19T11:59:00.000Z",
          },
          profileDigest: "e".repeat(64),
        });
      });
      const { prisma } = fakePrisma();

      await expect(processGenerate(
        { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
        prisma,
        { projectorPrisma: prisma },
      )).resolves.toEqual({ status: "failed" });

      expect(streamMock).not.toHaveBeenCalled();
      expect(recordTurnFailureMock).not.toHaveBeenCalled();
      expect(recordTurnSuccessMock).not.toHaveBeenCalled();
      expect(invalidateReadinessMock).toHaveBeenCalledOnce();
      expect(appendStreamEventMock).toHaveBeenCalledWith(
        "chat:stream:msg_assistant",
        expect.objectContaining({
          type: "error",
          code: "dsh_profile_digest_mismatch",
          retryable: false,
        }),
      );
    } finally {
      restoreEnv();
    }
  });

  it("terminalizes a DSH output-limit rejection without retrying or degrading readiness", async () => {
    const restoreEnv = installDshRolloutEnv();
    try {
      dshRunMock.mockImplementation(async (invocation, port) => {
        await port.emit({
          type: "text_delta",
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          sequence: 1,
          occurredAt: new Date().toISOString(),
          delta: "incomplete reply",
        });
        const candidate = {
          attemptId: invocation.attemptId,
          content: "incomplete reply",
          finishReason: "length" as const,
          provider: "mock",
          model: "local-model",
          usage: { promptTokens: 10, completionTokens: 8, reasoningTokens: 0 },
          execution: { steps: 1, toolCalls: 0 },
          completedAt: new Date().toISOString(),
        };
        await port.emit({
          type: "terminal_candidate",
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          sequence: 2,
          occurredAt: new Date().toISOString(),
          candidate,
        });
        const ack = await port.commit(candidate);
        if (!ack.accepted) throw new Error(ack.error.code);
      });
      const { prisma, rootMessageUpdates } = fakePrisma();

      await expect(processGenerate(
        { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
        prisma,
        { projectorPrisma: prisma, jobAttempt: { attemptsMade: 0, maxAttempts: 5 } },
      )).resolves.toEqual({ status: "failed" });

      expect(dshRunMock).toHaveBeenCalledOnce();
      expect(rootMessageUpdates).toContainEqual(expect.objectContaining({
        data: expect.objectContaining({ status: "failed" }),
      }));
      expect(appendStreamEventMock).toHaveBeenCalledWith(
        "chat:stream:msg_assistant",
        expect.objectContaining({
          type: "error",
          code: "provider_output_limit",
          retryable: false,
        }),
      );
      expect(recordTurnFailureMock).not.toHaveBeenCalled();
      expect(invalidateReadinessMock).not.toHaveBeenCalled();
    } finally {
      restoreEnv();
    }
  });

  it("terminalizes a sidecar timeout while retaining it as readiness failure evidence", async () => {
    const restoreEnv = installDshRolloutEnv();
    try {
      dshRunMock.mockImplementation(async (invocation, port) => {
        await port.emit({
          type: "cancelled",
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          sequence: 1,
          occurredAt: new Date().toISOString(),
          reason: "timeout",
        });
      });
      const { prisma } = fakePrisma();

      await expect(processGenerate(
        { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
        prisma,
        { projectorPrisma: prisma, jobAttempt: { attemptsMade: 0, maxAttempts: 5 } },
      )).resolves.toEqual({ status: "failed" });

      expect(appendStreamEventMock).toHaveBeenCalledWith(
        "chat:stream:msg_assistant",
        expect.objectContaining({
          type: "error",
          code: "dsh_deadline_exceeded",
          retryable: false,
        }),
      );
      expect(recordTurnFailureMock).toHaveBeenCalledOnce();
      expect(invalidateReadinessMock).not.toHaveBeenCalled();
    } finally {
      restoreEnv();
    }
  });

  it("reuses the durable DSH profile digest when readiness changes before a retry", async () => {
    const restoreEnv = installDshRolloutEnv();
    try {
      let observedDigest: string | undefined;
      verifiedProfileDigestState.value = "e".repeat(64);
      const durableStartedAt = new Date(Date.now() - 1_000).toISOString();
      let observedDeadlineAt: string | undefined;
      dshRunMock.mockImplementation(async (invocation) => {
        observedDigest = invocation.expectedProfileDigest;
        observedDeadlineAt = invocation.deadlineAt;
        throw new Error("retry observation complete");
      });
      const priorTrace = {
        schemaVersion: 1,
        attempt: 1,
        companionRuntime: {
          runtime: "dsh",
          memoryBackend: "igrep-dsh",
          profile: "idream-companion-memory",
          private: false,
          profileDigest: "d".repeat(64),
          memoryCutover: {
            schemaVersion: 1,
            status: "cutover_ready",
            mode: "empty",
            legacySourceChecksum: "a".repeat(64),
            importChecksum: "b".repeat(64),
            igrepVersion: "0.1.132",
            cutoverWorkspaceVersion:
              "rebuild-1787169600000-11111111-1111-4111-8111-111111111111",
            workspaceVersion:
              "rebuild-1787169600000-11111111-1111-4111-8111-111111111111",
            recallParity: {
              probeSetChecksum: "c".repeat(64),
              total: 0,
              passed: 0,
            },
            completedAt: "2026-08-19T12:00:00.000Z",
          },
        },
        primaryTelemetry: {
          schemaVersion: 1,
          runtime: "dsh",
          startedAt: durableStartedAt,
          retryCount: 0,
        },
      };
      const { prisma, messageUpdates } = fakePrisma(
        undefined,
        undefined,
        undefined,
        priorTrace,
      );

      await expect(processGenerate(
        { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
        prisma,
        { projectorPrisma: prisma, jobAttempt: { attemptsMade: 1, maxAttempts: 3 } },
      )).rejects.toThrow("retry observation complete");

      expect(observedDigest).toBe("d".repeat(64));
      expect(Date.parse(observedDeadlineAt ?? "")).toBe(
        Date.parse(durableStartedAt) + 300_000,
      );
      expect(messageUpdates[0]?.data.runtimeTrace).toMatchObject({
        companionRuntime: { profileDigest: "d".repeat(64) },
      });
    } finally {
      restoreEnv();
    }
  });

  it("persists DSH text already delivered before a runtime disconnect as truncated", async () => {
    const restoreEnv = installDshRolloutEnv();
    try {
      dshRunMock.mockImplementation(async (invocation, port) => {
        await port.emit({
          type: "text_delta",
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          sequence: 1,
          occurredAt: new Date().toISOString(),
          delta: "visible partial reply",
        });
        throw new Error("sidecar disconnected");
      });
      const { prisma, messageUpdates } = fakePrisma();

      await expect(processGenerate(
        { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
        prisma,
        { projectorPrisma: prisma },
      )).resolves.toEqual({ status: "sent" });

      expect(finalizedMessageUpdate(messageUpdates)).toMatchObject({
        status: "sent",
        content: "visible partial reply",
        runtimeTrace: expect.objectContaining({
          truncated: true,
          primaryTelemetry: expect.objectContaining({
            runtime: "dsh",
            terminalStatus: "sent",
            truncated: true,
            firstTokenMs: expect.any(Number),
            totalMs: expect.any(Number),
            memory: { outcome: "discarded_truncated", settleLagMs: 0 },
            error: { category: "runtime", code: "dsh_runtime_error" },
          }),
          companion: expect.objectContaining({
            memoryIngestOutcome: "discarded_truncated",
          }),
        }),
      });
    } finally {
      restoreEnv();
    }
  });

  it("never turns a rejected DSH terminal candidate into a truncated success", async () => {
    const restoreEnv = installDshRolloutEnv();
    try {
      dshRunMock.mockImplementation(async (invocation, port) => {
        await port.emit({
          type: "text_delta",
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          sequence: 1,
          occurredAt: new Date().toISOString(),
          delta: "visible bytes",
        });
        const candidate = {
          attemptId: invocation.attemptId,
          content: "different terminal bytes",
          finishReason: "stop" as const,
          provider: "mock",
          model: "local-model",
          usage: { promptTokens: 10, completionTokens: 4, reasoningTokens: 0 },
          execution: { steps: 1, toolCalls: 0 },
          completedAt: new Date().toISOString(),
        };
        await port.emit({
          type: "terminal_candidate",
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          sequence: 2,
          occurredAt: new Date().toISOString(),
          candidate,
        });
        const ack = await port.commit(candidate);
        if (!ack.accepted) throw new Error(ack.error.code);
      });
      const { prisma, messageUpdates } = fakePrisma();

      await expect(processGenerate(
        { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
        prisma,
        { projectorPrisma: prisma },
      )).resolves.toEqual({ status: "failed" });

      expect(messageUpdates).not.toContainEqual(expect.objectContaining({
        data: expect.objectContaining({ status: "sent" }),
      }));
      expect(recordTurnFailureMock).toHaveBeenCalledOnce();
      expect(invalidateReadinessMock).not.toHaveBeenCalled();
    } finally {
      restoreEnv();
    }
  });

  it("[Gate T] replays a durable DSH tool reservation without creating a second identity", async () => {
    const restoreEnv = installDshRolloutEnv();
    const reservation = {
      attemptId: "msg_assistant:1",
      callId: "call-replayed",
      name: "generate_image_async",
      arguments: {
        prompt: "Mira beside the observatory window",
        caption: "Still the same view.",
      },
    };
    try {
      let replayResult: unknown;
      dshRunMock.mockImplementation(async (invocation, port) => {
        replayResult = await port.executeTool(reservation);
        await port.emit({
          type: "text_delta",
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          sequence: 1,
          occurredAt: new Date().toISOString(),
          delta: "the reserved image is queued",
        });
        const candidate = {
          attemptId: invocation.attemptId,
          content: "the reserved image is queued",
          finishReason: "stop",
          provider: "mock",
          model: "local-model",
          usage: { promptTokens: 10, completionTokens: 5, reasoningTokens: 0 },
          execution: { steps: 2, toolCalls: 1 },
          completedAt: new Date().toISOString(),
        };
        await port.emit({
          type: "terminal_candidate",
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          sequence: 2,
          occurredAt: new Date().toISOString(),
          candidate,
        });
        await port.commit(candidate);
      });
      const { prisma, attachmentCreates, messageUpdates, rootMessageUpdates } = fakePrisma(
        undefined,
        undefined,
        undefined,
        {
          companionRuntime: {
            runtime: "dsh",
            memoryBackend: "igrep-dsh",
            profile: "idream-companion-memory",
            private: false,
            profileDigest: "d".repeat(64),
          },
          companionTool: reservation,
        },
      );

      await expect(processGenerate(
        { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
        prisma,
        { projectorPrisma: prisma },
      )).resolves.toEqual({ status: "sent" });

      expect(replayResult).toMatchObject({
        outcome: "succeeded",
        output: { effectId: "msg_assistant:1:call-replayed" },
      });
      expect(attachmentCreates).toHaveLength(1);
      const persistedReservations = [...messageUpdates, ...rootMessageUpdates]
        .map((call) => (call.data.runtimeTrace as { companionTool?: unknown } | undefined)?.companionTool)
        .filter(Boolean);
      expect(persistedReservations.length).toBeGreaterThan(0);
      expect(persistedReservations).toEqual(
        Array.from({ length: persistedReservations.length }, () => reservation),
      );
    } finally {
      restoreEnv();
    }
  });

  it("[Gate T] reports unknown and creates no effect when tool reservation authority is lost", async () => {
    const restoreEnv = installDshRolloutEnv();
    try {
      let toolResult: unknown;
      dshRunMock.mockImplementation(async (_invocation, port) => {
        toolResult = await port.executeTool({
          attemptId: "msg_assistant:1",
          callId: "call-lost-authority",
          name: "generate_image_async",
          arguments: { prompt: "Mira beside the observatory after authority changed" },
        });
      });
      const { prisma, attachmentCreates, outboxCreates } = fakePrisma(
        undefined,
        undefined,
        undefined,
        undefined,
        0n,
        { status: "pending", strictClaimCas: true, failToolReservation: true },
      );

      await expect(processGenerate(
        { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
        prisma,
        { projectorPrisma: prisma, jobAttempt: { attemptsMade: 0, maxAttempts: 1 } },
      )).resolves.toEqual({ status: "failed" });

      expect(toolResult).toMatchObject({
        outcome: "unknown",
        error: { code: "tool_reservation_authority_lost", retryable: false },
      });
      expect(attachmentCreates).toHaveLength(0);
      expect(outboxCreates.filter((call) => call.data.eventType === CHAT_TO_MAIN_EVENTS.imageRequested)).toHaveLength(0);
    } finally {
      restoreEnv();
    }
  });

  it.each(["before_intent", "after_result"] as const)(
    "[Gate T] converges a sidecar crash %s and creates one image effect after restart",
    async (crashPoint) => {
    const restoreEnv = installDshRolloutEnv();
    const reservation = {
      attemptId: "msg_assistant:1",
      callId: "call-crash-replay",
      name: "generate_image_async" as const,
      arguments: {
        prompt: "Mira beside the observatory window after restart",
        caption: "The same view, recovered.",
      },
    };
    try {
      let runs = 0;
      const toolResults: unknown[] = [];
      dshRunMock.mockImplementation(async (invocation, port) => {
        runs += 1;
        if (runs === 1 && crashPoint === "before_intent") {
          throw new Error("sidecar disconnected before the tool intent");
        }
        toolResults.push(await port.executeTool(reservation));
        if (runs === 1) {
          throw new Error("sidecar disconnected after the tool result");
        }
        await port.emit({
          type: "text_delta",
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          sequence: 1,
          occurredAt: new Date().toISOString(),
          delta: "the recovered image is queued",
        });
        const candidate = {
          attemptId: invocation.attemptId,
          content: "the recovered image is queued",
          finishReason: "stop" as const,
          provider: "mock",
          model: "local-model",
          usage: { promptTokens: 10, completionTokens: 5, reasoningTokens: 0 },
          execution: { steps: 2, toolCalls: 1 },
          completedAt: new Date().toISOString(),
        };
        await port.emit({
          type: "terminal_candidate",
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          sequence: 2,
          occurredAt: new Date().toISOString(),
          candidate,
        });
        await port.commit(candidate);
      });
      const { prisma, attachmentCreates, outboxCreates, assistantTrace } =
        fakePrisma(
          undefined,
          undefined,
          undefined,
          undefined,
          0n,
          { status: "pending", strictClaimCas: true },
        );

      await expect(processGenerate(
        { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
        prisma,
        { projectorPrisma: prisma, jobAttempt: { attemptsMade: 0, maxAttempts: 2 } },
      )).rejects.toThrow(
        crashPoint === "before_intent"
          ? "sidecar disconnected before the tool intent"
          : "sidecar disconnected after the tool result",
      );
      expect(attachmentCreates).toHaveLength(0);
      expect(outboxCreates.filter((call) => call.data.eventType === CHAT_TO_MAIN_EVENTS.imageRequested)).toHaveLength(0);

      await expect(processGenerate(
        { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
        prisma,
        { projectorPrisma: prisma, jobAttempt: { attemptsMade: 1, maxAttempts: 2 } },
      )).resolves.toEqual({ status: "sent" });

      expect(toolResults).toEqual(Array.from(
        { length: crashPoint === "before_intent" ? 1 : 2 },
        () => expect.objectContaining({
          outcome: "succeeded",
          output: expect.objectContaining({ effectId: "msg_assistant:1:call-crash-replay" }),
        }),
      ));
      expect(attachmentCreates).toHaveLength(1);
      expect(outboxCreates.filter((call) => call.data.eventType === CHAT_TO_MAIN_EVENTS.imageRequested)).toHaveLength(1);
      expect(assistantTrace()?.companionTool).toEqual(reservation);

      await expect(processGenerate(
        { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
        prisma,
        { projectorPrisma: prisma, jobAttempt: { attemptsMade: 1, maxAttempts: 2 } },
      )).resolves.toEqual({ status: "skipped" });
      expect(runs).toBe(2);
      expect(attachmentCreates).toHaveLength(1);
      expect(outboxCreates.filter((call) => call.data.eventType === CHAT_TO_MAIN_EVENTS.imageRequested)).toHaveLength(1);
    } finally {
      restoreEnv();
    }
    },
  );

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
    expect(finalizedMessageUpdate(messageUpdates)).toMatchObject({
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
    expect(finalizedMessageUpdate(messageUpdates)).toMatchObject({
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

  it("records a native terminal context CAS rejection as failed telemetry", async () => {
    supportsToolsState.value = false;
    buildContextMock.mockResolvedValue({
      ...context,
      policy: { ...context.policy, imageToolEnabled: false },
      recentMessages: [{ id: "msg_user", role: "user", content: "hello" }],
    });
    streamMock.mockImplementation(async function* nativeStream() {
      yield { delta: "obsolete reply", done: true };
    });
    const { prisma, messageUpdates, rootMessageUpdates } = fakePrisma(
      undefined,
      undefined,
      undefined,
      undefined,
      1n,
    );

    await expect(processGenerate(
      { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
      prisma,
      { projectorPrisma: prisma },
    )).resolves.toEqual({ status: "failed" });

    expect([...messageUpdates, ...rootMessageUpdates]).toContainEqual(expect.objectContaining({
      data: {
        runtimeTrace: expect.objectContaining({
          primaryTelemetry: expect.objectContaining({
            runtime: "native",
            terminalStatus: "failed",
            sseTerminal: "error",
            memory: { outcome: "not_started" },
            error: { category: "cas", code: "context_changed" },
          }),
        }),
      },
    }));
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
    expect(rootMessageUpdates).toContainEqual(expect.objectContaining({
      data: expect.objectContaining({ status: "failed" }),
    }));
    expect([...messageUpdates, ...rootMessageUpdates]).toContainEqual(expect.objectContaining({
      data: {
        runtimeTrace: expect.objectContaining({
          primaryTelemetry: expect.objectContaining({
            runtime: "native",
            terminalStatus: "failed",
            truncated: false,
            firstTokenMs: expect.any(Number),
            totalMs: expect.any(Number),
            provider: "mock",
            model: "local-model",
            steps: 1,
            toolCalls: 0,
            memory: { outcome: "not_started" },
            error: { category: "provider", code: "provider_output_limit" },
            sseTerminal: "error",
          }),
        }),
      },
    }));
    expect(finalizedMessageUpdate(messageUpdates)).toBeUndefined();
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

  it("keeps the original telemetry clock when the same durable attempt retries", async () => {
    supportsToolsState.value = false;
    buildContextMock.mockResolvedValue({
      ...context,
      policy: { ...context.policy, imageToolEnabled: false },
      recentMessages: [{ id: "msg_user", role: "user", content: "hello" }],
    });
    streamMock.mockImplementation(async function* recoveredStream() {
      yield { delta: "recovered reply", done: true };
    });
    const startedAt = new Date(Date.now() - 5_000).toISOString();
    const { prisma, messageUpdates } = fakePrisma(undefined, undefined, undefined, {
      schemaVersion: 1,
      attempt: 1,
      companionRuntime: {
        runtime: "native",
        memoryBackend: "legacy",
        profile: "native",
        private: false,
      },
      primaryTelemetry: {
        schemaVersion: 1,
        runtime: "native",
        startedAt,
        retryCount: 0,
        terminalStatus: "failed",
        error: { category: "provider", code: "empty_model_response" },
      },
    });

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
    )).resolves.toEqual({ status: "sent" });

    expect(finalizedMessageUpdate(messageUpdates)).toMatchObject({
      runtimeTrace: expect.objectContaining({
        primaryTelemetry: expect.objectContaining({
          startedAt,
          retryCount: 1,
          totalMs: expect.any(Number),
          terminalStatus: "sent",
        }),
      }),
    });
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

  it("terminalizes an unexpected exhausted worker failure without erasing admitted telemetry", async () => {
    const startedAt = new Date(Date.now() - 50).toISOString();
    const updates: CreateCall[] = [];
    const versionUpdates: CreateCall[] = [];
    const prismaImpl = {
      message: {
        findUnique: vi.fn(async () => ({
          status: "generating",
          attempt: 1,
          runtimeTrace: {
            primaryTelemetry: {
              schemaVersion: 1,
              runtime: "native",
              startedAt,
              retryCount: 2,
              provider: "mock",
              model: "local-model",
            },
          },
        })),
        updateMany: vi.fn(async (call: CreateCall) => {
          updates.push(call);
          return { count: 1 };
        }),
      },
      messageVersion: {
        upsert: vi.fn(async (call: CreateCall) => {
          versionUpdates.push(call);
          return {};
        }),
      },
    };
    const prisma = {
      ...prismaImpl,
      $transaction: vi.fn(async (callback: (tx: typeof prismaImpl) => Promise<unknown>) =>
        callback(prismaImpl)),
    } as unknown as ChatPrismaClient;

    await expect(terminalizeGenerateJobFailure({
      sessionId: "sess_1",
      assistantMessageId: "msg_assistant",
      userMessageId: "msg_user",
      attempt: 1,
    }, prisma)).resolves.toBe(true);

    expect(updates).toContainEqual(expect.objectContaining({
      data: {
        status: "failed",
        runtimeTrace: expect.objectContaining({
          primaryTelemetry: expect.objectContaining({
            runtime: "native",
            startedAt,
            retryCount: 2,
            terminalStatus: "failed",
            totalMs: expect.any(Number),
            sseTerminal: "error",
            memory: { outcome: "not_started" },
            error: { category: "worker", code: "generation_retries_exhausted" },
          }),
        }),
      },
    }));
    expect(versionUpdates).toHaveLength(1);
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
    expect(finalizedMessageUpdate(messageUpdates)).toMatchObject({
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
    expect(finalizedMessageUpdate(messageUpdates)).toMatchObject({
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
