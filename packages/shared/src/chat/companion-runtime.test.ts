import { describe, expect, it } from "vitest";
import {
  COMPANION_DSH_COMMIT,
  COMPANION_DSH_VERSION,
  COMPANION_IGREP_PLUGIN_VERSION,
  COMPANION_IGREP_VERSION,
  COMPANION_RUNTIME_PROTOCOL_VERSION,
  companionCommitAckSchema,
  companionEventSchema,
  companionInvocationSchema,
  companionNdjsonFrameSchema,
  companionReadinessSchema,
  companionTerminalCandidateSchema,
  companionToolCallSchema,
  companionToolResultSchema,
  decodeCompanionNdjsonFrame,
  encodeCompanionNdjsonFrame,
  preparedTurnWireSchema,
} from "./companion-runtime";

const now = "2026-08-19T12:00:00.000Z";

const profile = {
  tier: "premium",
  adapter: "openai-compatible-v1",
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  model: "deepseek/deepseek-v4-flash-0731",
  supportsTools: true,
  maxOutputTokens: 4_096,
  timeout: {
    firstTokenMs: 20_000,
    idleMs: 30_000,
    completionMs: 45_000,
  },
  sampling: {
    temperature: 0.9,
    topP: 0.95,
    repetitionPenalty: 1.05,
    structuredTemperature: 0.2,
  },
};

const preparedTurn = {
  version: 1 as const,
  model: profile.model,
  characterName: "Mira",
  messages: [
    {
      id: "system:soul-fingerprint",
      sourceKind: "plugin" as const,
      role: "system" as const,
      content: "Pinned Soul and runtime policy",
    },
    {
      id: "message:user-1",
      sourceKind: "replay" as const,
      role: "user" as const,
      content: "Do you remember the observatory?",
    },
    {
      id: "message:assistant-1",
      sourceKind: "replay" as const,
      role: "assistant" as const,
      content: "Every blue-lit window.",
    },
    {
      id: "message:user-2",
      sourceKind: "current_user" as const,
      role: "user" as const,
      content: "Show me the view tonight.",
    },
  ],
  tools: [
    {
      name: "generate_image_async" as const,
      description: "Generate a companion image asynchronously.",
      parameters: {
        type: "object",
        properties: { prompt: { type: "string" } },
        required: ["prompt"],
      },
    },
  ],
  profile,
  budget: {
    maxInputTokens: 8_000,
    usedInputTokens: 1_234,
    dropped: ["memory" as const],
  },
  trace: {
    characterContentVersionId: "ccv-1",
    characterReleaseId: "release-1",
    soulFingerprint: "a".repeat(64),
    compilerVersion: "soul-v1",
    sceneVersion: 4,
    relationshipVersion: 7,
    fileContextRevision: "12",
  },
};

function invocation(memoryMode: "normal" | "private") {
  return {
    invocationId: `invocation-${memoryMode}`,
    attemptId: `attempt-${memoryMode}`,
    sessionId: "session-1",
    userId: "user-1",
    characterId: "character-1",
    preparedTurn,
    memoryMode,
    deadlineAt: "2026-08-19T12:01:00.000Z",
  };
}

describe("companion runtime stable wire contract", () => {
  it.each(["normal", "private"] as const)(
    "round-trips a complete %s invocation without importing runtime implementation types",
    (memoryMode) => {
      const parsed = companionInvocationSchema.parse(invocation(memoryMode));
      expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
      expect(parsed.memoryMode).toBe(memoryMode);
      expect(parsed.preparedTurn.messages.at(-1)).toMatchObject({
        id: "message:user-2",
        sourceKind: "current_user",
      });
    },
  );

  it("fails loud on unknown event and NDJSON frame types", () => {
    const common = {
      invocationId: "invocation-1",
      attemptId: "attempt-1",
      sequence: 1,
      occurredAt: now,
    };
    expect(companionEventSchema.safeParse({ ...common, type: "assistant/chunk" }).success)
      .toBe(false);
    expect(
      companionNdjsonFrameSchema.safeParse({
        protocolVersion: COMPANION_RUNTIME_PROTOCOL_VERSION,
        type: "cordis_event",
        invocationId: "invocation-1",
        payload: {},
      }).success,
    ).toBe(false);
  });

  it("rejects secrets and extra keys at every declared authority boundary", () => {
    expect(companionInvocationSchema.safeParse({
      ...invocation("normal"),
      capabilityToken: "must-stay-in-transport",
    }).success).toBe(false);
    expect(preparedTurnWireSchema.safeParse({
      ...preparedTurn,
      profile: { ...profile, apiKey: "secret" },
    }).success).toBe(false);
    expect(preparedTurnWireSchema.safeParse({
      ...preparedTurn,
      profile: { ...profile, baseUrl: "https://user:secret@example.com/v1" },
    }).success).toBe(false);
    expect(preparedTurnWireSchema.safeParse({
      ...preparedTurn,
      messages: [
        { ...preparedTurn.messages[0], dshSessionEvent: {} },
        ...preparedTurn.messages.slice(1),
      ],
    }).success).toBe(false);
  });

  it("requires one current user message and preserves its stable id", () => {
    expect(preparedTurnWireSchema.safeParse({
      ...preparedTurn,
      messages: preparedTurn.messages.map((message) => ({
        ...message,
        sourceKind: "replay",
      })),
    }).success).toBe(false);
    expect(preparedTurnWireSchema.safeParse({
      ...preparedTurn,
      messages: [
        ...preparedTurn.messages,
        {
          id: "message:user-3",
          sourceKind: "current_user",
          role: "user",
          content: "Duplicate current input",
        },
      ],
    }).success).toBe(false);
    expect(preparedTurnWireSchema.safeParse({
      ...preparedTurn,
      messages: [
        ...preparedTurn.messages.slice(0, -2),
        preparedTurn.messages.at(-1),
        preparedTurn.messages.at(-2),
      ],
    }).success).toBe(false);
  });

  it(
    "preserves attemptId + callId identity across tool call, result, events and frames",
    () => {
      const call = companionToolCallSchema.parse({
        attemptId: "attempt-1",
        callId: "call-7",
        name: "generate_image_async",
        arguments: { prompt: "Mira at a blue-lit observatory window" },
      });
      const result = companionToolResultSchema.parse({
        attemptId: call.attemptId,
        callId: call.callId,
        name: call.name,
        outcome: "succeeded",
        output: { artifactId: "artifact-1", status: "queued" },
      });
      const event = companionEventSchema.parse({
        type: "tool_finished",
        invocationId: "invocation-1",
        attemptId: call.attemptId,
        sequence: 3,
        occurredAt: now,
        callId: call.callId,
        name: call.name,
        outcome: result.outcome,
        durationMs: 140,
      });
      const frame = companionNdjsonFrameSchema.parse({
        protocolVersion: COMPANION_RUNTIME_PROTOCOL_VERSION,
        type: "tool_result",
        invocationId: "invocation-1",
        result,
      });
      if (event.type !== "tool_finished" || frame.type !== "tool_result") {
        throw new Error("tool identity fixture parsed as the wrong wire variant");
      }
      expect([
        [result.attemptId, result.callId],
        [event.attemptId, event.callId],
        [frame.result.attemptId, frame.result.callId],
      ]).toEqual([
        ["attempt-1", "call-7"],
        ["attempt-1", "call-7"],
        ["attempt-1", "call-7"],
      ]);
    },
  );

  it("accepts all and only the stable product event vocabulary", () => {
    const common = {
      invocationId: "invocation-1",
      attemptId: "attempt-1",
      sequence: 1,
      occurredAt: now,
    };
    const candidate = {
      attemptId: "attempt-1",
      content: "The observatory is brighter tonight.",
      finishReason: "stop" as const,
      provider: "openrouter",
      model: profile.model,
      usage: { promptTokens: 12, completionTokens: 8, reasoningTokens: 0 },
      execution: { steps: 2, toolCalls: 1 },
      completedAt: now,
      attribution: {
        requestId: "req-1",
        actualProvider: "DeepInfra",
      },
    };
    const fixtures = [
      { ...common, type: "started" },
      { ...common, type: "text_delta", delta: "The observatory" },
      { ...common, type: "reasoning_usage", reasoningTokens: 4 },
      { ...common, type: "tool_started", callId: "call-1", name: "generate_image_async" },
      { ...common, type: "tool_finished", callId: "call-1", name: "generate_image_async", outcome: "succeeded", durationMs: 10 },
      { ...common, type: "usage", usage: candidate.usage },
      { ...common, type: "heartbeat" },
      { ...common, type: "terminal_candidate", candidate },
      { ...common, type: "failed", error: { code: "provider_timeout", message: "timed out", retryable: true } },
      { ...common, type: "cancelled", reason: "user" },
    ];
    expect(fixtures.map((fixture) => companionEventSchema.parse(fixture).type)).toEqual([
      "started",
      "text_delta",
      "reasoning_usage",
      "tool_started",
      "tool_finished",
      "usage",
      "heartbeat",
      "terminal_candidate",
      "failed",
      "cancelled",
    ]);
  });

  it("round-trips exactly one strict NDJSON frame", () => {
    const frame = companionNdjsonFrameSchema.parse({
      protocolVersion: COMPANION_RUNTIME_PROTOCOL_VERSION,
      type: "run",
      invocation: invocation("private"),
    });
    const encoded = encodeCompanionNdjsonFrame(frame);
    expect(encoded.endsWith("\n")).toBe(true);
    expect(decodeCompanionNdjsonFrame(encoded)).toEqual(frame);
    expect(() => decodeCompanionNdjsonFrame(`${encoded}${encoded}`)).toThrow(
      /exactly one NDJSON frame/,
    );
  });

  it("rejects empty or unknown provider attribution", () => {
    const candidate = {
      attemptId: "attempt-1",
      content: "Hello",
      finishReason: "stop",
      provider: "openrouter",
      model: profile.model,
      usage: { promptTokens: 12, completionTokens: 8, reasoningTokens: 0 },
      execution: { steps: 1, toolCalls: 0 },
      completedAt: now,
    };
    expect(companionTerminalCandidateSchema.safeParse({
      ...candidate,
      attribution: {},
    }).success).toBe(false);
    expect(companionTerminalCandidateSchema.safeParse({
      ...candidate,
      attribution: { requestId: "req-1", secret: "must-not-cross-wire" },
    }).success).toBe(false);
  });

  it("models terminal commit acceptance without treating a candidate as terminal truth", () => {
    expect(companionCommitAckSchema.parse({
      attemptId: "attempt-1",
      accepted: true,
      status: "committed",
      terminalMessageId: "message-assistant-1",
      committedAt: now,
    })).toMatchObject({ accepted: true, status: "committed" });
    expect(companionCommitAckSchema.safeParse({
      attemptId: "attempt-1",
      accepted: false,
      status: "rejected",
      error: { code: "terminal_cas_conflict", message: "lost authority" },
      terminalMessageId: "must-not-exist",
    }).success).toBe(false);
  });

  it("requires pinned runtime versions and both memory profile capability probes", () => {
    const readiness = {
      protocolVersion: COMPANION_RUNTIME_PROTOCOL_VERSION,
      service: "dsh-companion" as const,
      ready: true as const,
      checkedAt: now,
      dshVersion: COMPANION_DSH_VERSION,
      dshCommit: COMPANION_DSH_COMMIT,
      igrepVersion: COMPANION_IGREP_VERSION,
      pluginVersion: COMPANION_IGREP_PLUGIN_VERSION,
      provider: { name: "openrouter", model: profile.model, resolved: true as const },
      profiles: {
        normal: {
          name: "normal" as const,
          loaded: true as const,
          normalizedConfigDigest: "b".repeat(64),
          capabilities: { memoryRead: true, memoryWrite: true, tools: true, commit: true },
        },
        private: {
          name: "private" as const,
          loaded: true as const,
          normalizedConfigDigest: "c".repeat(64),
          capabilities: { memoryRead: false, memoryWrite: false, tools: true, commit: true },
        },
      },
      bridges: { toolReachable: true as const, commitReachable: true as const },
    };
    expect(companionReadinessSchema.parse(readiness)).toEqual(readiness);
    expect(companionReadinessSchema.safeParse({
      ...readiness,
      dshVersion: "latest",
    }).success).toBe(false);
    expect(companionReadinessSchema.safeParse({
      ...readiness,
      profiles: {
        ...readiness.profiles,
        private: {
          ...readiness.profiles.private,
          capabilities: {
            ...readiness.profiles.private.capabilities,
            memoryWrite: true,
          },
        },
      },
    }).success).toBe(false);
  });
});
