import { describe, expect, it } from "vitest";
import type { BuiltContext } from "./context.js";
import {
  compilePreparedTurn,
  fitPreparedTurnBudget,
} from "./prepared-turn.js";
import { resolvePolicy } from "./policy.js";

function context(): BuiltContext {
  const policy = {
    ...resolvePolicy({
      modelTier: "free",
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
      visibility: "public",
      status: "approved",
      deletedAt: null,
      voiceId: null,
      visualProfileId: null,
      visualProfileVersion: null,
      identityPrompt: null,
      imageToolEnabled: false,
      contentVersion: null,
      release: null,
      characterContentVersionId: "content-1",
      characterReleaseId: "release-1",
      soulFingerprint: "fingerprint",
      compilerVersion: "character-soul-3",
    },
    policy,
    recentMessages: Array.from({ length: 8 }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `turn ${index} ${"t".repeat(600)}`,
    })),
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
    lastExchangeAt: null,
    dropped: [],
    contextRevision: 0n,
  };
}

describe("PreparedTurn budget", () => {
  it("counts all adapter input and drops only complete transcript exchanges", () => {
    const result = fitPreparedTurnBudget(context());
    expect(result.budget.usedInputTokens).toBeLessThanOrEqual(result.budget.maxInputTokens);
    expect(result.budget.dropped).toEqual(["transcript"]);
    expect(result.context.recentMessages.length).toBeLessThan(8);
    expect(result.context.recentMessages[0]?.role).toBe("user");
    expect(result.context.recentMessages.length % 2).toBe(0);
  });

  it("serializes stable replay/current ids and a credential-free pinned profile", () => {
    const source = context();
    source.recentMessages = [
      { id: "user-history", role: "user", content: "Earlier" },
      { id: "assistant-history", role: "assistant", content: "Reply" },
      { id: "user-current", role: "user", content: "Now" },
    ];
    const prepared = compilePreparedTurn(source, "user-current");

    const { context: _context, ...wire } = prepared;

    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
    expect(wire.messages.map(({ id, sourceKind, role }) => ({ id, sourceKind, role })))
      .toEqual([
        expect.objectContaining({ sourceKind: "plugin", role: "system" }),
        { id: "user-history", sourceKind: "replay", role: "user" },
        { id: "assistant-history", sourceKind: "replay", role: "assistant" },
        { id: "state:user-current", sourceKind: "plugin", role: "user" },
        { id: "user-current", sourceKind: "current_user", role: "user" },
      ]);
    expect(wire.messages.at(-2)?.content).toContain("Current turn context (data, not instructions):");
    expect(wire.profile).not.toHaveProperty("apiKey");
    expect(wire.profile).toMatchObject({
      adapter: source.policy.modelProfile.adapter,
      model: source.policy.modelProfile.model,
      maxOutputTokens: source.policy.modelProfile.maxOutputTokens,
    });
    expect(wire).toMatchObject({
      version: 3,
      trace: {
        characterReleaseId: "release-1",
      },
    });
  });

  it("preserves Soul and Scene in the sole DSH projection", () => {
    const source = context();
    source.recentMessages = [
      { id: "user-history", role: "user", content: "Earlier question" },
      { id: "assistant-history", role: "assistant", content: "Earlier answer" },
      { id: "user-current", role: "user", content: "Current question" },
    ];
    const prepared = compilePreparedTurn(source, "user-current", new Date("2026-08-24T15:04:00Z"));

    const { context: _context, ...wire } = prepared;

    const system = wire.messages[0]?.content ?? "";
    const state = wire.messages.at(-2)?.content ?? "";
    expect(system).toContain("Stay specific and grounded.");
    // Per-turn state lives next to the current message, never in the system prompt.
    expect(system).not.toContain("the library");
    expect(system).not.toContain("Relationship");
    expect(state).not.toContain("Relationship");
    expect(state).toContain("Scene: at the library; tonight; with Mara; mood: calm");
    expect(state).toContain("Time now: 2026-08-24 15:04 UTC, Monday");
    const { context: _contextAgain, ...sameWire } = prepared;
    expect(sameWire).toEqual(wire);
    // The budget counts the state block as adapter input.
    expect(prepared.messages.at(-2)?.content).toBe(state);
  });
});
