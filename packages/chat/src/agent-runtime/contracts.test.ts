import { describe, expect, it } from "vitest";
import {
  companionCommitAckSchema,
  companionEventSchema,
  companionInvocationSchema,
  companionTerminalCandidateSchema,
  companionToolCallSchema,
  companionToolReservationSchema,
  companionToolResultSchema,
  preparedTurnSchema,
} from "./contracts";

const preparedTurn = {
  version: 6 as const,
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
    productPromptVersion: "companion-product-1",
    systemPromptDigest: "b".repeat(64),
    characterContentVersionId: "content-1",
    characterReleaseId: "release-1",
    soulFingerprint: "a".repeat(64),
    compilerVersion: "soul-v1",
    sceneVersion: 1,
    contextRevision: "1",
  },
};

describe("embedded companion runtime contracts", () => {
  it("accepts only Main's durable media recovery facts, not an unreserved failure", () => {
    const recovered = { name: "edit_last_image", attachmentId: "prior-card", status: "awaiting_confirmation", costDreamcoins: 0,
      generationJobId: null, mediaAssetId: null, sourceMediaAssetId: "source-image", instruction: "Change the mug to red." };
    expect(preparedTurnSchema.parse({ ...preparedTurn, recoveredMediaAction: recovered }).recoveredMediaAction).toEqual(recovered);
    expect(preparedTurnSchema.parse({ ...preparedTurn, recoveredMediaAction: { ...recovered, status: "cancelled" } }).recoveredMediaAction?.status).toBe("cancelled");
    expect(preparedTurnSchema.safeParse({ ...preparedTurn, recoveredMediaAction: { ...recovered, status: "failed" } }).success).toBe(false);
    expect(preparedTurnSchema.safeParse({ ...preparedTurn, recoveredMediaAction: { ...recovered, status: "requesting" } }).success).toBe(false);
    expect(preparedTurnSchema.safeParse({ ...preparedTurn, recoveredMediaAction: { ...recovered, callId: "invented-current-call" } }).success).toBe(false);
  });

  it("accepts omitted historical dialogue but refuses new authority or duplicate identities in that prefix", () => {
    const historical = { id: "old-user", sourceKind: "replay", role: "user", content: "My boat is Cedar Finch." };
    expect(preparedTurnSchema.safeParse({ ...preparedTurn, omittedMessages: [historical] }).success).toBe(true);
    for (const invalid of [
      { ...historical, sourceKind: "current_user" },
      { ...historical, sourceKind: "plugin" },
      { ...historical, id: "user-1" },
      { ...historical, role: "tool", tool_call_id: "unbound" },
    ]) expect(preparedTurnSchema.safeParse({ ...preparedTurn, omittedMessages: [invalid] }).success).toBe(false);
    expect(preparedTurnSchema.safeParse({ ...preparedTurn, omittedMessages: [historical, historical] }).success).toBe(false);
  });

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
      name: "request_character_media",
      effectScope: "turn_action",
      intent: { requestedNudity: "full" },
      argumentsDigest: "c".repeat(64),
    }).success).toBe(true);
    expect(companionToolReservationSchema.safeParse({
      attemptId: "attempt-1",
      callId: "call-1",
      name: "request_character_media",
      effectScope: "turn_action",
      intent: { requestedNudity: "full" },
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

  it("keeps runtime timings and wake cache evidence content-free and well-formed", () => {
    const identity = { invocationId: "invocation-1", attemptId: "attempt-1", sequence: 1, occurredAt: "2026-08-28T12:00:00.000Z" };
    const runtime = (operation: string, outcome: string) => companionEventSchema.safeParse({ ...identity, type: "runtime_observation", operation, outcome, durationMs: 3 }).success;
    expect(runtime("workspace_prepare", "success")).toBe(true);
    expect(runtime("memory_reproject", "failure")).toBe(true);
    expect(runtime("media_extraction", "verified_excerpts")).toBe(true);
    expect(runtime("media_extraction", "pure_media_skip")).toBe(true);
    expect(runtime("workspace_copy", "verified_excerpts")).toBe(false);
    expect(runtime("media_extraction", "success")).toBe(false);
    expect(companionEventSchema.safeParse({ ...identity, type: "runtime_observation", operation: "workspace_prepare", outcome: "success", durationMs: 3, path: "/secret" }).success).toBe(false);
    const wake = (extra: Record<string, unknown>) => companionEventSchema.safeParse({ ...identity, type: "igrep_observation", durationMs: 0, ...extra }).success;
    expect(wake({ operation: "wake", outcome: "hit", resultCount: 1, cache: "hit" })).toBe(true);
    expect(wake({ operation: "wake", outcome: "failure", cache: "hit" })).toBe(false);
    expect(wake({ operation: "memory", outcome: "hit", resultCount: 1, cache: "hit" })).toBe(false);
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
    expect(companionTerminalCandidateSchema.parse({ ...candidate, usage: null }).usage).toBeNull();
    expect(companionTerminalCandidateSchema.parse({ ...candidate, usage: { ...candidate.usage, reasoningTokens: null } }).usage)
      .toEqual({ promptTokens: 10, completionTokens: 2, reasoningTokens: null });
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

  it("validates unified request_character_media and resend_session_media tool calls and receipts", () => {
    expect(companionToolCallSchema.safeParse({
      attemptId: "attempt-1",
      callId: "call-1",
      name: "request_character_media",
      effectScope: "turn_action",
      intent: { requestedNudity: "partial" },
      arguments: { kind: "video", subject: "companion", direction: "smiling by the neon balcony", requestedNudity: "partial", hasAudio: true },
    }).success).toBe(true);

    expect(companionToolCallSchema.safeParse({
      attemptId: "attempt-1",
      callId: "call-2",
      name: "resend_session_media",
      effectScope: "turn_action",
      intent: { requestedNudity: "unspecified" },
      arguments: { previousMediaAssetId: "media-asset-1" },
    }).success).toBe(true);

    expect(companionToolResultSchema.safeParse({
      attemptId: "attempt-1",
      callId: "call-1",
      name: "request_character_media",
      outcome: "succeeded",
      output: {
        accepted: true,
        duplicate: false,
        status: "awaiting_confirmation",
        confirmationKind: "paid_media_quote",
        kind: "video",
        attachmentId: "att-1",
        generationJobId: null,
        mediaAssetId: null,
        costDreamcoins: 30,
      },
    }).success).toBe(true);

    expect(companionToolResultSchema.safeParse({
      attemptId: "attempt-1",
      callId: "call-1",
      name: "request_character_media",
      outcome: "succeeded",
      output: {
        accepted: true,
        duplicate: false,
        status: "no_match",
        kind: "video",
        costDreamcoins: 0,
        suggestedAction: "photo_instead",
      },
    }).success).toBe(true);

    expect(companionToolResultSchema.safeParse({
      attemptId: "attempt-1",
      callId: "call-1",
      name: "request_character_media",
      outcome: "succeeded",
      output: { accepted: true, status: "completed", kind: "video" },
    }).success).toBe(false);
  });
});
