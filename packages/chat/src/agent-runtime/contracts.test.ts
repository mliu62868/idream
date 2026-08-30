import { describe, expect, it } from "vitest";
import {
  companionCommitAckSchema,
  companionEventSchema,
  companionInvocationSchema,
  companionTerminalCandidateSchema,
  companionToolReservationSchema,
  preparedTurnSchema,
} from "./contracts";

const preparedTurn = {
  version: 3 as const,
  model: "model-1",
  characterName: "Mira",
  messages: [
    { id: "system-1", sourceKind: "plugin" as const, role: "system" as const, content: "Be Mira." },
    { id: "user-1", sourceKind: "current_user" as const, role: "user" as const, content: "Hello" },
  ],
  tools: [],
  profile: {
    tier: "free",
    adapter: "openai-compatible-v1",
    provider: "openai",
    baseUrl: "http://127.0.0.1:8061/v1",
    model: "model-1",
    supportsTools: true,
    maxOutputTokens: 100,
    timeout: { firstTokenMs: 1_000, idleMs: 1_000 },
    sampling: { temperature: 0.9, topP: 0.95, repetitionPenalty: 1.05 },
  },
  budget: { maxInputTokens: 1_000, usedInputTokens: 10, dropped: [] },
  trace: {
    characterContentVersionId: "content-1",
    characterReleaseId: "release-1",
    soulFingerprint: "a".repeat(64),
    compilerVersion: "soul-v1",
    sceneVersion: 1,
    contextRevision: "1",
  },
};

describe("embedded companion runtime contracts", () => {
  it("keeps the prepared turn strict, credential-free, and current-user anchored", () => {
    expect(preparedTurnSchema.safeParse(preparedTurn).success).toBe(true);
    expect(preparedTurnSchema.safeParse({
      ...preparedTurn,
      profile: { ...preparedTurn.profile, apiKey: "secret" },
    }).success).toBe(false);
    expect(preparedTurnSchema.safeParse({
      ...preparedTurn,
      messages: [...preparedTurn.messages].reverse(),
    }).success).toBe(false);
  });

  it("pins one invocation without a sidecar transport contract", () => {
    expect(companionInvocationSchema.safeParse({
      invocationId: "invocation-1",
      attemptId: "attempt-1",
      sessionId: "session-1",
      userId: "user-1",
      characterId: "character-1",
      preparedTurn,
      memoryMode: "normal",
      expectedProfileDigest: "b".repeat(64),
      deadlineAt: "2026-08-28T12:05:00.000Z",
    }).success).toBe(true);
  });

  it("keeps durable tool reservations content-free", () => {
    expect(companionToolReservationSchema.safeParse({
      attemptId: "attempt-1",
      callId: "call-1",
      name: "generate_image_async",
      argumentsDigest: "c".repeat(64),
    }).success).toBe(true);
    expect(companionToolReservationSchema.safeParse({
      attemptId: "attempt-1",
      callId: "call-1",
      name: "generate_image_async",
      argumentsDigest: "c".repeat(64),
      arguments: { prompt: "must not persist" },
    }).success).toBe(false);
  });

  it("fails closed on unknown runtime events", () => {
    const identity = {
      invocationId: "invocation-1",
      attemptId: "attempt-1",
      sequence: 1,
      occurredAt: "2026-08-28T12:00:00.000Z",
    };
    expect(companionEventSchema.safeParse({ ...identity, type: "heartbeat" }).success).toBe(true);
    expect(companionEventSchema.safeParse({ ...identity, type: "assistant/chunk" }).success).toBe(false);
  });

  it("requires terminal tool counts and an explicit Main commit ACK", () => {
    const candidate = {
      attemptId: "attempt-1",
      content: "Hello",
      finishReason: "stop" as const,
      provider: "openai",
      model: "model-1",
      usage: { promptTokens: 10, completionTokens: 2, reasoningTokens: 0 },
      execution: { steps: 1, toolCalls: 0 },
      tools: [],
      completedAt: "2026-08-28T12:00:00.000Z",
    };
    expect(companionTerminalCandidateSchema.safeParse(candidate).success).toBe(true);
    expect(companionTerminalCandidateSchema.safeParse({
      ...candidate,
      execution: { steps: 1, toolCalls: 1 },
    }).success).toBe(false);
    expect(companionCommitAckSchema.safeParse({
      attemptId: "attempt-1",
      accepted: true,
      status: "committed",
      terminalMessageId: "assistant-1",
      committedAt: "2026-08-28T12:00:01.000Z",
    }).success).toBe(true);
  });
});

