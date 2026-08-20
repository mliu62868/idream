import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { CHAT_TO_MAIN_EVENTS } from "@idream/shared/contracts";
import { releasedKnowledgeDigest } from "@idream/shared/chat/companion-runtime";
import type { ChatPrismaClient } from "./db.js";

const moderationMock = vi.hoisted(() => vi.fn());
const buildContextMock = vi.hoisted(() => vi.fn());
const appendStreamEventMock = vi.hoisted(() => vi.fn(async () => ({ id: "stream-id", event: {} })));
const enqueueMock = vi.hoisted(() => vi.fn(async () => {}));
const recordTurnFailureMock = vi.hoisted(() => vi.fn());
const recordTurnSuccessMock = vi.hoisted(() => vi.fn());
const invalidateReadinessMock = vi.hoisted(() => vi.fn());
const recordMemoryPromotionFailureMock = vi.hoisted(() => vi.fn());
const recordMemoryPromotionSuccessMock = vi.hoisted(() => vi.fn());
const dshRunMock = vi.hoisted(() => vi.fn());
const dshCancelMock = vi.hoisted(() => vi.fn(async () => {}));
const verifiedProfileDigestState = vi.hoisted(() => ({ value: "d".repeat(64) }));

vi.mock("./db.js", () => ({ chatPrisma: {} }));
vi.mock("./providers.js", () => ({
  providers: {
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
vi.mock("./queue.js", () => ({ enqueue: enqueueMock }));
vi.mock("./runtime-readiness.js", () => ({
  runtimeReadiness: {
    invalidate: invalidateReadinessMock,
    recordTurnFailure: recordTurnFailureMock,
    recordTurnSuccess: recordTurnSuccessMock,
    recordMemoryPromotionFailure: recordMemoryPromotionFailureMock,
    recordMemoryPromotionSuccess: recordMemoryPromotionSuccessMock,
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
const {
  claimGenerateAttemptAuthority,
  persistAttemptRuntimeTraceCas,
  processGenerate,
  processGenerateJob,
  terminalizeGenerateJobFailure,
} = await import("./generate.js");

type CreateCall = { data: Record<string, unknown>; where?: Record<string, unknown> };

function stableJsonForTest(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJsonForTest).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonForTest(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function toolArgumentsDigest(value: unknown): string {
  return createHash("sha256").update(stableJsonForTest(value)).digest("hex");
}

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
  completedSourceAttachment?:
    | { mediaAssetId: string }
    | Array<{ mediaAssetId: string }>,
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
  const versionUpdates: CreateCall[] = [];
  const rootMessageUpdates: CreateCall[] = [];
  let currentAssistantStatus: string = assistantState.status ?? "generating";
  const currentAssistantAttempt = assistantState.attempt ?? 1;
  let currentAssistantTrace: Record<string, unknown> | null = assistantRuntimeTrace ?? null;
  const findCompletedSource = async (
    call?: { where?: { mediaAssetId?: string | { not: null } } },
  ) => {
    const sources = Array.isArray(completedSourceAttachment)
      ? completedSourceAttachment
      : completedSourceAttachment
        ? [completedSourceAttachment]
        : [];
    const requested = call?.where?.mediaAssetId;
    if (typeof requested === "string") {
      return sources.find((source) => source.mediaAssetId === requested) ?? null;
    }
    return sources.at(-1) ?? null;
  };
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
      findFirst: findCompletedSource,
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
        const nextTrace = call.data.runtimeTrace;
        if (
          assistantState.failToolReservation &&
          nextTrace &&
          typeof nextTrace === "object" &&
          "companionTool" in nextTrace
        ) {
          return { count: 0 };
        }
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
      updateMany: async (call: CreateCall) => {
        versionUpdates.push(call);
        return { count: 1 };
      },
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
    messageAttachment: {
      findFirst: findCompletedSource,
    },
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
    versionUpdates,
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
    rateLimitPerHour: 60,
    unlimitedMessages: false,
    voiceEnabled: false,
    memoryEnabled: true,
    allowRelationshipPatch: true,
    outputModerationRequired: true,
    imageToolEnabled: true,
  },
  recentMessages: [
    { id: "msg_user", role: "user", content: "给我一张靠窗的照片" },
  ],
  boundaries: [],
  relationship: null,
  openingMessage: null,
  scene: null,
  sceneVersion: 0,
  dropped: [],
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
    token: process.env.DSH_AGENT_TOKEN,
    deadlineMs: process.env.DSH_AGENT_DEADLINE_MS,
  };
  process.env.DSH_AGENT_TOKEN = "test-sidecar-token";
  process.env.DSH_AGENT_DEADLINE_MS = "300000";
  return () => {
    for (const [name, value] of Object.entries({
      DSH_AGENT_TOKEN: previous.token,
      DSH_AGENT_DEADLINE_MS: previous.deadlineMs,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

describe("chat generate agent image tool", () => {
  beforeEach(() => {
    moderationMock.mockReset();
    buildContextMock.mockReset();
    appendStreamEventMock.mockClear();
    enqueueMock.mockClear();
    recordTurnFailureMock.mockClear();
    recordTurnSuccessMock.mockClear();
    invalidateReadinessMock.mockClear();
    recordMemoryPromotionFailureMock.mockClear();
    recordMemoryPromotionSuccessMock.mockClear();
    dshRunMock.mockReset();
    dshCancelMock.mockClear();
    verifiedProfileDigestState.value = "d".repeat(64);
    buildContextMock.mockResolvedValue(context);
    moderationMock.mockResolvedValue({ status: "passed", confidence: 0.5 });
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

  it("atomically persists a tool reservation to Message and MessageVersion", async () => {
    const stored: {
      messageTrace: Record<string, unknown> | null;
      versionTrace: Record<string, unknown> | null;
    } = { messageTrace: null, versionTrace: null };
    let rejectVersionCas = true;
    const prisma = {
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
        const pending = structuredClone(stored);
        const tx = {
          message: {
            updateMany: vi.fn(async (call: CreateCall) => {
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
    const trace = {
      companionTool: {
        attemptId: "msg_assistant:1",
        callId: "call-reserved",
        name: "generate_image_async",
        argumentsDigest: "a".repeat(64),
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
      expectedMessageStatus: "generating" as const,
      trace,
      stage: "tool_reservation" as const,
    };

    await expect(persistAttemptRuntimeTraceCas(input)).resolves.toBe("failed");
    expect(stored).toEqual({ messageTrace: null, versionTrace: null });

    rejectVersionCas = false;
    await expect(persistAttemptRuntimeTraceCas(input)).resolves.toBe("updated");
    expect(stored).toEqual({ messageTrace: trace, versionTrace: trace });
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
        turnMemoryEnabled: true,
        userMessageId: "msg_user",
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
            memoryBackend: "igrep-dsh",
            profile: "idream-companion-memory",
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
                  evidenceMatches: 0,
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

  it("commits the no-memory future-recall policy reply through DSH without exposing provider prose", async () => {
    const restoreEnv = installDshRolloutEnv();
    const userContent = "Remember this phrase next month: amber compass. Promise me.";
    const providerContent = "Of course — I'll remember amber compass next month.";
    const policyContent = "I can’t retain that across sessions. If you want to use it later, tell me again then.";
    try {
      buildContextMock.mockResolvedValue({
        ...context,
        policy: {
          ...context.policy,
          memoryEnabled: false,
        },
        recentMessages: [
          { id: "msg_user", role: "user", content: userContent },
        ],
      });
      dshRunMock.mockImplementation(async (invocation, port) => {
        expect(invocation.memoryMode).toBe("private");
        expect(invocation.preparedTurn.tools).toEqual([]);
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
          type: "text_delta",
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          sequence: 2,
          occurredAt: new Date().toISOString(),
          delta: providerContent,
        });
        const candidate = {
          attemptId: invocation.attemptId,
          content: providerContent,
          finishReason: "stop" as const,
          provider: "mock",
          model: "local-model",
          usage: { promptTokens: 14, completionTokens: 11, reasoningTokens: 0 },
          execution: { steps: 1, toolCalls: 0 },
          attribution: { requestId: "req-no-memory-policy", actualProvider: "local-mlx" },
          completedAt: new Date().toISOString(),
        };
        await port.emit({
          type: "terminal_candidate",
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          sequence: 3,
          occurredAt: new Date().toISOString(),
          candidate,
        });
        await expect(port.commit(candidate)).resolves.toMatchObject({
          accepted: true,
          status: "committed",
        });
      });
      const { prisma, messageUpdates, attachmentCreates, outboxCreates } = fakePrisma(
        undefined,
        undefined,
        { content: userContent, memoryAuthority: "disabled" },
      );

      await expect(processGenerate(
        { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
        prisma,
        { projectorPrisma: prisma },
      )).resolves.toEqual({ status: "sent" });

      expect(dshRunMock).toHaveBeenCalledOnce();
      expect(finalizedMessageUpdate(messageUpdates)).toMatchObject({
        status: "sent",
        content: policyContent,
        runtimeTrace: expect.objectContaining({
          outputAuthority: "no_memory_boundary",
          companionRuntime: expect.objectContaining({ private: true }),
          dsh: expect.objectContaining({
            memoryMode: "private",
            provider: "mock",
            model: "local-model",
          }),
          companion: expect.objectContaining({
            memoryIngestOutcome: "disabled",
            attribution: { requestId: "req-no-memory-policy", actualProvider: "local-mlx" },
            policyOutput: expect.objectContaining({
              authority: "chat",
              code: "no_memory_future_recall",
              transform: "replace_terminal_candidate",
            }),
          }),
        }),
      });
      const deliveredDeltas = (appendStreamEventMock.mock.calls as unknown[][])
        .map((call) => call[1] as { type?: string; delta?: string })
        .filter((event) => event.type === "delta")
        .map((event) => event.delta)
        .join("");
      expect(deliveredDeltas).toBe(policyContent);
      expect(deliveredDeltas).not.toContain(providerContent);
      expect(attachmentCreates).toHaveLength(0);
      expect(outboxCreates.filter((call) => call.data.eventType === CHAT_TO_MAIN_EVENTS.imageRequested))
        .toHaveLength(0);
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
        expect.objectContaining({ message: "memory_commit_failed" }),
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
      )).rejects.toThrow("dsh_runtime_error");

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

  it("does not turn streamed partial text into a ledger terminal after sidecar timeout", async () => {
    const restoreEnv = installDshRolloutEnv();
    try {
      dshRunMock.mockImplementation(async (invocation, port) => {
        await port.emit({
          type: "text_delta",
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          sequence: 1,
          occurredAt: new Date().toISOString(),
          delta: "partial text before timeout",
        });
        await port.emit({
          type: "cancelled",
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          sequence: 2,
          occurredAt: new Date().toISOString(),
          reason: "timeout",
        });
      });
      const { prisma, messageUpdates } = fakePrisma();

      await expect(processGenerate(
        { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
        prisma,
        { projectorPrisma: prisma, jobAttempt: { attemptsMade: 0, maxAttempts: 5 } },
      )).resolves.toEqual({ status: "failed" });

      expect(finalizedMessageUpdate(messageUpdates)).toBeUndefined();
      expect(appendStreamEventMock).toHaveBeenCalledWith(
        "chat:stream:msg_assistant",
        expect.objectContaining({
          type: "error",
          code: "dsh_deadline_exceeded",
          retryable: false,
        }),
      );
    } finally {
      restoreEnv();
    }
  });

  it("rolls back a terminal candidate when moderation consumes the absolute DSH deadline", async () => {
    const restoreEnv = installDshRolloutEnv();
    process.env.DSH_AGENT_DEADLINE_MS = "100";
    try {
      moderationMock.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { status: "passed", confidence: 0.5 };
      });
      dshRunMock.mockImplementation(async (invocation, port) => {
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
          type: "text_delta",
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          sequence: 2,
          occurredAt: new Date().toISOString(),
          delta: "candidate near deadline",
        });
        const candidate = {
          attemptId: invocation.attemptId,
          content: "candidate near deadline",
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
          sequence: 3,
          occurredAt: new Date().toISOString(),
          candidate,
        });
        await port.commit(candidate);
      });
      const { prisma, messageUpdates } = fakePrisma();

      await expect(processGenerate(
        { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
        prisma,
        { projectorPrisma: prisma, jobAttempt: { attemptsMade: 0, maxAttempts: 5 } },
      )).resolves.toEqual({ status: "failed" });

      expect(finalizedMessageUpdate(messageUpdates)).toBeUndefined();
      expect(dshCancelMock).toHaveBeenCalledWith("inv:msg_assistant:1", "timeout");
      expect(appendStreamEventMock).toHaveBeenCalledWith(
        "chat:stream:msg_assistant",
        expect.objectContaining({
          type: "error",
          code: "dsh_deadline_exceeded",
          retryable: false,
        }),
      );
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
      )).rejects.toThrow("dsh_runtime_error");

      expect(observedDigest).toBe("d".repeat(64));
      expect(Date.parse(observedDeadlineAt ?? "")).toBe(
        Date.parse(durableStartedAt) + 300_000,
      );
      expect(messageUpdates[0]?.data.runtimeTrace).toMatchObject({
        companionRuntime: {
          profileDigest: "d".repeat(64),
          memoryCutover: { status: "cutover_ready" },
        },
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
        throw new Error("PRIVATE_PROVIDER_BODY_SENTINEL");
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
            failure: { category: "runtime", code: "dsh_runtime_error" },
          }),
        }),
      });
      expect(JSON.stringify(finalizedMessageUpdate(messageUpdates))).not.toContain(
        "PRIVATE_PROVIDER_BODY_SENTINEL",
      );
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
    const durableReservation = {
      attemptId: reservation.attemptId,
      callId: reservation.callId,
      name: reservation.name,
      argumentsDigest: toolArgumentsDigest({
        ...reservation.arguments,
        orientation: "4:5",
        outputCount: 1,
      }),
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
          companionTool: durableReservation,
          companionToolEffect: {
            attemptId: reservation.attemptId,
            callId: reservation.callId,
            toolName: reservation.name,
            sourceImageAssetId: null,
          },
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
        Array.from({ length: persistedReservations.length }, () => durableReservation),
      );
    } finally {
      restoreEnv();
    }
  });

  it("[Gate T] reports unknown and creates no effect when tool reservation authority is lost", async () => {
    const restoreEnv = installDshRolloutEnv();
    try {
      const toolResults: unknown[] = [];
      dshRunMock.mockImplementation(async (_invocation, port) => {
        toolResults.push(await port.executeTool({
          attemptId: "msg_assistant:1",
          callId: "call-lost-authority",
          name: "generate_image_async",
          arguments: { prompt: "Mira beside the observatory after authority changed" },
        }));
        toolResults.push(await port.executeTool({
          attemptId: "msg_assistant:1",
          callId: "call-after-unknown-commit",
          name: "generate_image_async",
          arguments: { prompt: "A second image must not overwrite uncertain authority" },
        }));
      });
      const { prisma, attachmentCreates, outboxCreates, messageUpdates } = fakePrisma(
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

      expect(toolResults).toEqual([
        expect.objectContaining({
          outcome: "unknown",
          error: expect.objectContaining({ code: "tool_reservation_authority_lost", retryable: false }),
        }),
        expect.objectContaining({
          callId: "call-after-unknown-commit",
          outcome: "unknown",
          error: expect.objectContaining({ code: "tool_reservation_authority_lost", retryable: false }),
        }),
      ]);
      expect(messageUpdates.filter((call) =>
        Boolean((call.data.runtimeTrace as { companionTool?: unknown } | undefined)?.companionTool)
      )).toHaveLength(1);
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
    const firstCall = {
      attemptId: "msg_assistant:1",
      callId: "call-crash-first",
      name: "generate_image_async" as const,
      arguments: {
        prompt: "Mira beside the observatory window after restart",
        caption: "The same view, recovered.",
      },
    };
    const retryCall = {
      ...firstCall,
      callId: "call-crash-retry",
      arguments: {
        ...firstCall.arguments,
        orientation: "4:5" as const,
        outputCount: 1,
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
        toolResults.push(await port.executeTool(runs === 1 ? firstCall : retryCall));
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
      const { prisma, attachmentCreates, outboxCreates, messageUpdates, versionUpdates, assistantTrace } =
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
      )).rejects.toThrow("dsh_runtime_error");
      expect(dshCancelMock).toHaveBeenCalledWith("inv:msg_assistant:1", "transport");
      expect(attachmentCreates).toHaveLength(0);
      expect(outboxCreates.filter((call) => call.data.eventType === CHAT_TO_MAIN_EVENTS.imageRequested)).toHaveLength(0);

      await expect(processGenerate(
        { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
        prisma,
        { projectorPrisma: prisma, jobAttempt: { attemptsMade: 1, maxAttempts: 2 } },
      )).resolves.toEqual({ status: "sent" });

      const durableCall = {
        attemptId: retryCall.attemptId,
        callId: crashPoint === "before_intent" ? retryCall.callId : firstCall.callId,
        name: retryCall.name,
        argumentsDigest: toolArgumentsDigest(retryCall.arguments),
      };
      expect(toolResults).toEqual(
        crashPoint === "before_intent"
          ? [expect.objectContaining({
              callId: retryCall.callId,
              outcome: "succeeded",
              output: expect.objectContaining({ effectId: `${retryCall.attemptId}:${retryCall.callId}` }),
            })]
          : [
              expect.objectContaining({
                callId: firstCall.callId,
                outcome: "succeeded",
                output: expect.objectContaining({ effectId: `${firstCall.attemptId}:${firstCall.callId}` }),
              }),
              expect.objectContaining({
                callId: retryCall.callId,
                outcome: "succeeded",
                output: expect.objectContaining({ effectId: `${firstCall.attemptId}:${firstCall.callId}` }),
              }),
            ],
      );
      expect(attachmentCreates).toHaveLength(1);
      expect(outboxCreates.filter((call) => call.data.eventType === CHAT_TO_MAIN_EVENTS.imageRequested)).toHaveLength(1);
      const messageReservation = messageUpdates.find((call) =>
        Boolean((call.data.runtimeTrace as { companionTool?: unknown } | undefined)?.companionTool)
      );
      const versionReservation = versionUpdates.find((call) =>
        Boolean((call.data.runtimeTrace as { companionTool?: unknown } | undefined)?.companionTool)
      );
      expect(messageReservation?.data.runtimeTrace).toMatchObject({ companionTool: durableCall });
      expect(versionReservation?.data.runtimeTrace).toMatchObject({ companionTool: durableCall });
      expect(assistantTrace()?.companionTool).toEqual(durableCall);
      expect(JSON.stringify(assistantTrace())).not.toContain(firstCall.arguments.prompt);
      expect(JSON.stringify(assistantTrace())).not.toContain(firstCall.arguments.caption);
      expect(assistantTrace()?.companion).toMatchObject({
        toolResult: {
          attemptId: retryCall.attemptId,
          callId: durableCall.callId,
          name: retryCall.name,
          outcome: "succeeded",
          output: {
            status: "accepted_for_terminal_commit",
            effectId: `${durableCall.attemptId}:${durableCall.callId}`,
          },
        },
      });

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

  it("[Gate T] pins the edit source before a crash so a newer image cannot retarget the effect", async () => {
    const restoreEnv = installDshRolloutEnv();
    const sources = [{ mediaAssetId: "media_original" }];
    const firstCall = {
      attemptId: "msg_assistant:1",
      callId: "call-edit-before-crash",
      name: "edit_last_image" as const,
      arguments: {
        instruction: "Move the same portrait beneath the observatory dome",
        caption: "Same portrait, new setting.",
      },
    };
    const retryCall = { ...firstCall, callId: "call-edit-after-crash" };
    try {
      let runs = 0;
      dshRunMock.mockImplementation(async (invocation, port) => {
        runs += 1;
        const call = runs === 1 ? firstCall : retryCall;
        const result = await port.executeTool(call);
        expect(result).toMatchObject({
          outcome: "succeeded",
          output: { effectId: `${firstCall.attemptId}:${firstCall.callId}` },
        });
        if (runs === 1) throw new Error("sidecar disconnected after edit reservation");
        await port.emit({
          type: "text_delta",
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          sequence: 1,
          occurredAt: new Date().toISOString(),
          delta: "the pinned edit is queued",
        });
        const candidate = {
          attemptId: invocation.attemptId,
          content: "the pinned edit is queued",
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
      const { prisma, attachmentCreates, outboxCreates, assistantTrace } = fakePrisma(
        sources,
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
      )).rejects.toThrow("dsh_runtime_error");

      // A different image completes while BullMQ is retrying. The accepted edit
      // intent must still target the source Chat resolved before the crash.
      sources.push({ mediaAssetId: "media_newer" });

      await expect(processGenerate(
        { sessionId: "sess_1", assistantMessageId: "msg_assistant", userMessageId: "msg_user", attempt: 1 },
        prisma,
        { projectorPrisma: prisma, jobAttempt: { attemptsMade: 1, maxAttempts: 2 } },
      )).resolves.toEqual({ status: "sent" });

      expect(attachmentCreates).toHaveLength(1);
      expect(attachmentCreates[0]?.data.metadata).toMatchObject({
        toolName: "edit_last_image",
        editSourceAssetId: "media_original",
      });
      const imageEvent = outboxCreates.find((call) =>
        call.data.eventType === CHAT_TO_MAIN_EVENTS.imageRequested
      );
      expect(imageEvent?.data.payload).toMatchObject({
        controls: { sourceImageAssetId: "media_original" },
      });
      expect(assistantTrace()?.companionToolEffect).toMatchObject({
        attemptId: firstCall.attemptId,
        callId: firstCall.callId,
        toolName: firstCall.name,
        sourceImageAssetId: "media_original",
      });
      expect(runs).toBe(2);
    } finally {
      restoreEnv();
    }
  });

});
