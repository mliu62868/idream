import { describe, expect, it } from "vitest";
import type { BuiltContext } from "./context.js";
import {
  compilePreparedTurn,
  fitPreparedTurnBudget,
  toPreparedTurnWire,
} from "./prepared-turn.js";
import { resolvePolicy } from "./policy.js";

function context(): BuiltContext {
  const policy = {
    ...resolvePolicy({
      modelTier: "free",
      memoryMultiplier: 1,
      unlimitedMessages: false,
      voiceEnabled: false,
      imageToolEnabled: false,
    }),
    maxContextChars: 4_000,
    imageToolEnabled: false,
  };
  return {
    persona: {
      characterId: "character-1",
      creatorId: null,
      name: "Mara",
      age: 31,
      description: "A precise adult companion.",
      systemPrompt: "Stay specific and grounded.",
      relationship: "trusted companion",
      visibility: "public",
      status: "approved",
      deletedAt: null,
      voiceId: null,
      updatedAt: new Date("2026-08-05T00:00:00Z"),
      visualProfileId: null,
      visualProfileVersion: null,
      identityPrompt: null,
      imageToolEnabled: false,
      characterContentVersionId: "content-1",
      characterReleaseId: "release-1",
      soulFingerprint: "fingerprint",
      compilerVersion: "character-soul-1",
    },
    policy,
    sessionSummary: `summary ${"s".repeat(1_000)}`,
    recentMessages: Array.from({ length: 8 }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `turn ${index} ${"t".repeat(600)}`,
    })),
    boundaries: ["Never invent canon."],
    longTermMemories: [`memory ${"m".repeat(2_000)}`],
    relationship: null,
    scene: {
      schemaVersion: 1,
      version: 1,
      location: "the library",
      time: "tonight",
      participants: ["Mara"],
      emotionalBeat: "calm",
      unresolvedThreads: [],
    },
    sceneVersion: 1,
    openingMessage: null,
    dropped: [],
    canUpdateSessionSummary: true,
    sessionContextRevision: 0n,
    fileContextRevision: 0n,
  };
}

describe("PreparedTurn budget", () => {
  it("counts all adapter input and degrades memory, summary, then transcript", () => {
    const result = fitPreparedTurnBudget(context());
    expect(result.budget.usedInputTokens).toBeLessThanOrEqual(result.budget.maxInputTokens);
    expect(result.budget.dropped).toEqual(["memory", "summary", "transcript"]);
    expect(result.context.longTermMemories).toEqual([]);
    expect(result.context.sessionSummary).toBeNull();
    expect(result.context.recentMessages.length).toBeLessThan(8);
    expect(result.context.recentMessages[0]?.role).toBe("user");
    expect(result.context.recentMessages.length % 2).toBe(0);
  });

  it("serializes stable replay/current ids and a credential-free pinned profile", () => {
    const source = context();
    source.sessionSummary = null;
    source.longTermMemories = [];
    source.recentMessages = [
      { id: "user-history", role: "user", content: "Earlier" },
      { id: "assistant-history", role: "assistant", content: "Reply" },
      { id: "user-current", role: "user", content: "Now" },
    ];
    const prepared = compilePreparedTurn(source, "user-current");

    const wire = toPreparedTurnWire(prepared);

    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
    expect(wire.messages.map(({ id, sourceKind, role }) => ({ id, sourceKind, role })))
      .toEqual([
        expect.objectContaining({ sourceKind: "plugin", role: "system" }),
        { id: "user-history", sourceKind: "replay", role: "user" },
        { id: "assistant-history", sourceKind: "replay", role: "assistant" },
        { id: "user-current", sourceKind: "current_user", role: "user" },
      ]);
    expect(wire.profile).not.toHaveProperty("apiKey");
    expect(wire.profile).toMatchObject({
      adapter: source.policy.modelProfile.adapter,
      model: source.policy.modelProfile.model,
      maxOutputTokens: source.policy.modelProfile.maxOutputTokens,
    });
  });
});
