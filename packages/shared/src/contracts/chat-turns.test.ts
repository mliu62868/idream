import { describe, expect, it } from "vitest";
import {
  chatExecutionSnapshotSchema,
  chatTerminalCommitSchema,
  chatToolEffectSchema,
  chatContextDirectivesSchema,
  userChatPersonaResponseSchema,
  DEFAULT_CHAT_EXPERIENCE,
} from "./chat-turns";

const snapshot = {
  version: 1,
  turnId: "turn-1",
  sessionId: "session-1",
  userMessageId: "user-message-1",
  assistantMessageId: "assistant-message-1",
  attempt: 1,
  userId: "user-1",
  characterId: "character-1",
  characterContentVersionId: "content-1",
  characterReleaseId: "release-1",
  characterVisualProfileId: "visual-1",
  characterVisualProfileVersion: 2,
  memoryEnabled: true,
  contextRevision: 0,
  userContent: "Hello",
  recentTurns: [],
  sceneVersion: 0,
  scene: null,
} as const;

describe("Chat execution snapshot", () => {
  it("keeps historical reply defaults implicit and accepts only versioned expression preferences", () => {
    expect(chatExecutionSnapshotSchema.parse(snapshot)).not.toHaveProperty("experience");
    expect(chatExecutionSnapshotSchema.parse({ ...snapshot, experience: DEFAULT_CHAT_EXPERIENCE }).experience).toEqual(DEFAULT_CHAT_EXPERIENCE);
    const experience = { responseLength: "short", interactionIntensity: "gentle", version: 1 };
    expect(chatExecutionSnapshotSchema.parse({ ...snapshot, experience }).experience).toEqual(experience);
    expect(chatExecutionSnapshotSchema.parse({ ...snapshot, experience: { ...experience, sceneGeneration: "advance" } }).experience?.sceneGeneration).toBe("advance");
    for (const invalid of [
      { ...experience, version: 0 },
      { ...experience, responseLength: "unlimited" },
      { ...experience, interactionIntensity: "unrestricted" },
      { ...experience, imageToolEnabled: true },
      { ...experience, sceneGeneration: "auto-image" },
    ]) {
      expect(chatExecutionSnapshotSchema.safeParse({ ...snapshot, experience: invalid }).success).toBe(false);
    }
  });

  it("accepts a bounded, versioned global persona without adding it to historical snapshots", () => {
    expect(chatExecutionSnapshotSchema.parse(snapshot)).not.toHaveProperty("userPersona");
    const userPersona = { name: "Robin", description: "A botanist with a blue notebook.", enabled: true, version: 2 };
    expect(chatExecutionSnapshotSchema.parse({ ...snapshot, userPersona }).userPersona).toEqual(userPersona);
    expect(chatExecutionSnapshotSchema.parse({ ...snapshot, userPersona: { ...userPersona, enabled: false } }).userPersona?.enabled).toBe(false);
    for (const invalid of [
      { ...userPersona, version: 0 }, { ...userPersona, name: "x".repeat(81) },
      { ...userPersona, description: "x".repeat(1_501) }, { ...userPersona, name: " ", description: " " },
      { ...userPersona, characterReleaseId: "forged" },
    ]) expect(chatExecutionSnapshotSchema.safeParse({ ...snapshot, userPersona: invalid }).success).toBe(false);
    expect(userChatPersonaResponseSchema.safeParse({ persona: userPersona, version: 1 }).success).toBe(false);
    expect(userChatPersonaResponseSchema.parse({ persona: null, version: 3 })).toEqual({ persona: null, version: 3 });
  });

  it("accepts historical context without settings, and bounds each explicit user context kind", () => {
    expect(chatExecutionSnapshotSchema.parse(snapshot)).not.toHaveProperty("contextDirectives");
    const pin = { id: "pin", kind: "pinned_memory", content: "My notebook is blue.", version: 1 };
    expect(chatExecutionSnapshotSchema.parse({ ...snapshot, contextDirectives: [pin] }).contextDirectives).toEqual([pin]);
    expect(chatContextDirectivesSchema.safeParse([{ ...pin, content: "x".repeat(501) }]).success).toBe(false);
    expect(chatContextDirectivesSchema.safeParse(Array.from({ length: 9 }, (_, i) => ({ ...pin, id: `pin-${i}` }))).success).toBe(false);
    expect(chatContextDirectivesSchema.safeParse([pin, pin]).success).toBe(false);
    expect(chatContextDirectivesSchema.safeParse([{ ...pin, kind: "custom_instruction", content: "x".repeat(1_501) }]).success).toBe(false);
    expect(chatContextDirectivesSchema.safeParse([{ ...pin, kind: "custom_instruction" }, { ...pin, id: "other", kind: "custom_instruction" }]).success).toBe(false);
  });

  it("requires the immutable visual profile id and version to be pinned together", () => {
    expect(chatExecutionSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(chatExecutionSnapshotSchema.safeParse({
      ...snapshot,
      characterVisualProfileVersion: null,
    }).success).toBe(false);
    expect(chatExecutionSnapshotSchema.safeParse({
      ...snapshot,
      characterVisualProfileId: null,
    }).success).toBe(false);
  });

  it("requires exact product prompt attribution on every Chat terminal", () => {
    const terminal = {
      version: 1,
      turnId: "turn-1",
      sessionId: "session-1",
      assistantMessageId: "assistant-message-1",
      attempt: 1,
      status: "sent",
      content: "Hello",
      model: "model-1",
      promptTokens: 10,
      completionTokens: 2,
      sceneVersion: 0,
      scene: null,
      terminalEvidence: { authority: "dsh_terminal_candidate" },
    };
    expect(chatTerminalCommitSchema.safeParse(terminal).success).toBe(false);
    expect(chatTerminalCommitSchema.safeParse({
      ...terminal,
      terminalEvidence: {
        authority: "dsh_terminal_candidate",
        prompt: {
          productPromptVersion: "companion-product-1",
          preparedTurnVersion: 4,
          systemPromptDigest: "a".repeat(64),
          soulFingerprint: "b".repeat(64),
        },
      },
    }).success).toBe(true);
  });

  it("carries explicit effect scope and image intent instead of encoding them in callId", () => {
    expect(chatToolEffectSchema.parse({
      version: 2,
      turnId: "turn-1",
      attempt: 1,
      callId: "provider-call-9",
      name: "generate_image_async",
      effectScope: "turn_action",
      intent: { requestedNudity: "full" },
      arguments: { prompt: "A concrete observatory scene" },
    })).toMatchObject({
      callId: "provider-call-9",
      effectScope: "turn_action",
      intent: { requestedNudity: "full" },
    });
  });
});
