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
  companionMemoryCutoverProofSchema,
  companionMemoryCutoverSidecarProofSchema,
  companionNdjsonFrameSchema,
  companionProbeDshEvidenceSchema,
  companionReadinessSchema,
  companionTerminalCandidateSchema,
  companionToolCallSchema,
  companionToolReservationSchema,
  companionToolResultSchema,
  companionWorkspaceRebuildBudget,
  COMPANION_WORKSPACE_REBUILD_MAX_TIMEOUT_MS,
  companionWorkspaceRebuildSchema,
  decodeCompanionWorkspaceRebuildFrame,
  decodeCompanionNdjsonFrame,
  encodeCompanionWorkspaceRebuildFrame,
  encodeCompanionNdjsonFrame,
  preparedTurnWireSchema,
} from "./companion-runtime";

const now = "2026-08-19T12:00:00.000Z";
const sidecarInstance = {
  id: "11111111-1111-4111-8111-111111111111",
  startedAt: "2026-08-19T11:59:00.000Z",
};

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
  version: 2 as const,
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
    dropped: ["transcript" as const],
  },
  releasedKnowledge: {
    characterId: "character-1",
    characterContentVersionId: "ccv-1",
    characterReleaseId: "release-1",
    digest: "6868f5d7cc13655b3943d97dfe74e41d1da3fd8806721b3c19c7906e847b52ef",
    files: [{
      path: "canon.md" as const,
      content: "# Canon\n\n- The observatory windows are blue.\n",
    }],
  },
  trace: {
    characterContentVersionId: "ccv-1",
    characterReleaseId: "release-1",
    soulFingerprint: "a".repeat(64),
    compilerVersion: "soul-v1",
    sceneVersion: 4,
    relationshipVersion: 7,
    fileContextRevision: "12",
    releasedKnowledgeDigest:
      "6868f5d7cc13655b3943d97dfe74e41d1da3fd8806721b3c19c7906e847b52ef",
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
    expectedProfileDigest: "b".repeat(64),
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
      expect(parsed.expectedProfileDigest).toBe("b".repeat(64));
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
    expect(companionEventSchema.safeParse({
      ...common,
      type: "started",
      instance: sidecarInstance,
    }).success).toBe(false);
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
    const { expectedProfileDigest: _missingDigest, ...unpinnedInvocation } = invocation("normal");
    expect(companionInvocationSchema.safeParse(unpinnedInvocation).success).toBe(false);
    expect(companionInvocationSchema.safeParse({
      ...invocation("normal"),
      expectedProfileDigest: "not-a-sha256",
    }).success).toBe(false);
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

  it("binds released knowledge to the exact character, release, content and bytes", () => {
    expect(preparedTurnWireSchema.parse(preparedTurn).releasedKnowledge.files)
      .toEqual([{
        path: "canon.md",
        content: "# Canon\n\n- The observatory windows are blue.\n",
      }]);
    expect(preparedTurnWireSchema.safeParse({
      ...preparedTurn,
      releasedKnowledge: {
        ...preparedTurn.releasedKnowledge,
        digest: "f".repeat(64),
      },
    }).success).toBe(false);
    expect(preparedTurnWireSchema.safeParse({
      ...preparedTurn,
      releasedKnowledge: {
        ...preparedTurn.releasedKnowledge,
        files: [{ path: "../admin-draft.md", content: "draft" }],
      },
    }).success).toBe(false);
    expect(companionInvocationSchema.safeParse({
      ...invocation("normal"),
      characterId: "character-2",
    }).success).toBe(false);
  });

  it("carries an explicit digest for an empty unreleased knowledge snapshot", () => {
    const empty = {
      characterId: "character-1",
      characterContentVersionId: "legacy-unattributed",
      characterReleaseId: null,
      digest: "105eeb3b7da80af178083cdcd5a37d702e64d0d2daa2ca51f531e11992de875f",
      files: [],
    };
    expect(preparedTurnWireSchema.parse({
      ...preparedTurn,
      releasedKnowledge: empty,
      trace: {
        ...preparedTurn.trace,
        characterContentVersionId: "legacy-unattributed",
        characterReleaseId: null,
        releasedKnowledgeDigest: empty.digest,
      },
    }).releasedKnowledge).toEqual(empty);
    expect(preparedTurnWireSchema.safeParse({
      ...preparedTurn,
      releasedKnowledge: {
        ...empty,
        files: [{ path: "canon.md", content: "mutable fallback" }],
      },
      trace: {
        ...preparedTurn.trace,
        characterContentVersionId: "legacy-unattributed",
        characterReleaseId: null,
        releasedKnowledgeDigest: empty.digest,
      },
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

  it("keeps durable tool reservations content-free", () => {
    const reservation = companionToolReservationSchema.parse({
      attemptId: "attempt-1",
      callId: "call-7",
      name: "generate_image_async",
      argumentsDigest: "a".repeat(64),
    });
    expect(reservation).not.toHaveProperty("arguments");
    expect(companionToolReservationSchema.safeParse({
      ...reservation,
      arguments: { prompt: "PRIVATE SENTINEL" },
    }).success).toBe(false);
  });

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
      {
        ...common,
        type: "started",
        instance: sidecarInstance,
        profileDigest: "b".repeat(64),
      },
      { ...common, type: "text_delta", delta: "The observatory" },
      { ...common, type: "reasoning_usage", reasoningTokens: 4 },
      { ...common, type: "tool_started", callId: "call-1", name: "generate_image_async" },
      { ...common, type: "tool_finished", callId: "call-1", name: "generate_image_async", outcome: "succeeded", durationMs: 10 },
      { ...common, type: "usage", usage: candidate.usage },
      {
        ...common,
        type: "igrep_observation",
        operation: "memory",
        outcome: "hit",
        resultCount: 2,
        durationMs: 12,
      },
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
      "igrep_observation",
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

  it("accepts only strict, paired canonical messages for relationship rebuild", () => {
    const rebuild = {
      scope: "relationship",
      userId: "user-1",
      characterId: "character-1",
      messages: [
        {
          id: "user-message-1",
          sessionId: "session-1",
          role: "user",
          content: "Remember the observatory.",
          createdAt: "2026-08-19T12:00:00.000Z",
        },
        {
          id: "assistant-message-1",
          sessionId: "session-1",
          role: "assistant",
          content: "Every blue-lit window.",
          createdAt: "2026-08-19T12:00:01.000Z",
        },
      ],
    } as const;
    expect(companionWorkspaceRebuildSchema.parse(rebuild)).toEqual(rebuild);
    expect(companionWorkspaceRebuildSchema.safeParse({
      ...rebuild,
      messages: [rebuild.messages[1]],
    }).success).toBe(false);
    expect(companionWorkspaceRebuildSchema.safeParse({
      ...rebuild,
      messages: [{ ...rebuild.messages[0], secret: "must-not-cross-wire" }],
    }).success).toBe(false);
  });

  it("round-trips strict relationship rebuild stream frames", () => {
    const frame = {
      protocolVersion: COMPANION_RUNTIME_PROTOCOL_VERSION,
      type: "start" as const,
      scope: "relationship" as const,
      userId: "user-1",
      characterId: "character-1",
      messageCount: 20_002,
    };
    expect(decodeCompanionWorkspaceRebuildFrame(
      encodeCompanionWorkspaceRebuildFrame(frame),
    )).toEqual(frame);
    expect(() => decodeCompanionWorkspaceRebuildFrame(`${JSON.stringify(frame)}\n{}\n`))
      .toThrow(/exactly one relationship rebuild NDJSON frame/);
  });

  it("budgets rebuild work independently of turn deadlines and monotonically by payload size", () => {
    const small = companionWorkspaceRebuildBudget({ messages: [{
      id: "user-1",
      sessionId: "session-1",
      role: "user",
      content: "short",
      createdAt: now,
    }] });
    const large = companionWorkspaceRebuildBudget({ messages: [{
      id: "user-1",
      sessionId: "session-1",
      role: "user",
      content: "x".repeat(2 * 1_048_576),
      createdAt: now,
    }] });

    expect(large.ingestTimeoutMs).toBeGreaterThan(small.ingestTimeoutMs);
    expect(small.totalTimeoutMs).toBe(small.ingestTimeoutMs + 370_000);
    expect(large.totalTimeoutMs).toBeLessThanOrEqual(
      COMPANION_WORKSPACE_REBUILD_MAX_TIMEOUT_MS,
    );
  });

  it("owns both Chat and sidecar cutover proof wires in the shared contract", () => {
    const sidecarProof = {
      entries: 0,
      legacySourceChecksum: "a".repeat(64),
      checksum: "b".repeat(64),
      igrepVersion: "0.1.132",
      cutoverWorkspaceVersion: "rebuild-1787169600000-11111111-1111-4111-8111-111111111111",
      workspaceVersion: "commit-1787169700000-22222222-2222-4222-8222-222222222222",
      status: "cutover_ready",
      recallParity: {
        probeSetChecksum: "c".repeat(64),
        total: 0,
        passed: 0,
        probes: [],
      },
      completedAt: now,
    } as const;
    expect(companionMemoryCutoverSidecarProofSchema.parse(sidecarProof)).toEqual(sidecarProof);
    expect(companionMemoryCutoverSidecarProofSchema.safeParse({
      ...sidecarProof,
      legacySourceChecksum: undefined,
    }).success).toBe(false);

    const chatProof = {
      schemaVersion: 1,
      status: "cutover_ready",
      mode: "empty",
      legacySourceChecksum: sidecarProof.legacySourceChecksum,
      importChecksum: sidecarProof.checksum,
      igrepVersion: sidecarProof.igrepVersion,
      cutoverWorkspaceVersion: sidecarProof.cutoverWorkspaceVersion,
      workspaceVersion: sidecarProof.workspaceVersion,
      recallParity: {
        probeSetChecksum: sidecarProof.recallParity.probeSetChecksum,
        total: 0,
        passed: 0,
      },
      completedAt: now,
    } as const;
    expect(companionMemoryCutoverProofSchema.parse(chatProof)).toEqual(chatProof);
    expect(companionMemoryCutoverProofSchema.safeParse({
      ...chatProof,
      mode: "imported",
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
      instance: sidecarInstance,
      provider: {
        name: "openrouter",
        baseUrl: profile.baseUrl,
        model: profile.model,
        resolved: true as const,
      },
      profiles: {
        normal: {
          name: "normal" as const,
          loaded: true as const,
          executionCompositionDigest: "b".repeat(64),
          capabilities: { memoryRead: true, memoryWrite: true, tools: true, commit: true },
        },
        private: {
          name: "private" as const,
          loaded: true as const,
          executionCompositionDigest: "c".repeat(64),
          capabilities: { memoryRead: false, memoryWrite: false, tools: true, commit: true },
        },
      },
      bridges: {
        toolReachable: true as const,
        commitReachable: true as const,
        workspaceRebuildReachable: true as const,
      },
      verification: {
        duplicateIngest: {
          replayedSessions: 1,
          duplicateDialogueFiles: 0,
        },
        crossScope: {
          probes: 2,
          leakedResults: 0,
        },
      },
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
    expect(companionEventSchema.safeParse({
      invocationId: "invocation-1",
      attemptId: "attempt-1",
      sequence: 1,
      occurredAt: now,
      type: "igrep_observation",
      operation: "search",
      outcome: "hit",
      resultCount: 0,
      durationMs: 1,
    }).success).toBe(false);
  });

  it("keeps signed DSH probe evidence content-free and exact", () => {
    const evidence = {
      ok: true,
      runtime: "dsh" as const,
      memoryBackend: "igrep-dsh" as const,
      profileDigest: "d".repeat(64),
      sidecarInstanceId: sidecarInstance.id,
      error: null,
    };
    expect(companionProbeDshEvidenceSchema.parse(evidence)).toEqual(evidence);
    expect(companionProbeDshEvidenceSchema.safeParse({
      ...evidence,
      rawTrace: { systemPrompt: "must-not-cross-the-report-boundary" },
    }).success).toBe(false);
  });
});
