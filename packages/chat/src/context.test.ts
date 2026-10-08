import { describe, expect, it } from "vitest";
import { compileCharacterSoul } from "@idream/shared";
import type { ChatExecutionSnapshot } from "@idream/shared/contracts";
import { buildContext } from "./context.js";

describe("immutable opening continuity", () => {
  it("places the pinned opening before the first user Turn seen by the Agent", async () => {
    const compiled = compileCharacterSoul({
      name: "Melissa Burke",
      age: 38,
      gender: "female",
      characterPromise: "A warm and perceptive companion.",
      detailsMarkdown: "## Voice\nWarm and direct.",
    });
    if (!compiled.ok) throw new Error("expected Soul compilation to succeed");

    const context = await buildContext({
      snapshot: {
        version: 1,
        turnId: "turn-1",
        sessionId: "session-1",
        userMessageId: "user-message-1",
        assistantMessageId: "assistant-message-1",
        attempt: 1,
        userId: "user-1",
        characterId: "melissa-burke",
        characterContentVersionId: "content-1",
        characterReleaseId: "release-1",
        characterVisualProfileId: null,
        characterVisualProfileVersion: null,
        memoryEnabled: true,
        userPersona: { name: "Robin", description: "A botanist.", enabled: true, version: 2 },
        experience: { responseLength: "auto", interactionIntensity: "balanced", sceneGeneration: "advance", version: 3 },
        contextRevision: 0,
        userContent: "I finally made it.",
        hasRecentImageContext: false,
        recentTurns: [],
        sceneVersion: 0,
        scene: null,
      },
      authority: {
        version: 1,
        user: {
          id: "user-1",
          displayName: null,
          locale: "en",
          status: "active",
          deletedAt: null,
          dataClass: "adult",
        },
        eligibility: {
          ageGateAccepted: true,
          ageVerified: true,
          jurisdiction: null,
          restrictedReason: null,
        },
        entitlement: {
          modelTier: "free",
          unlimitedMessages: false,
          voiceEnabled: false,
          imageToolEnabled: true,
        },
        character: {
          characterId: "melissa-burke",
          creatorId: null,
          name: "Melissa Burke",
          age: 38,
          description: "A warm and perceptive companion.",
          systemPrompt: null,
          visibility: "public",
          status: "approved",
          voiceId: null,
          visualProfileId: null,
          visualProfileVersion: null,
          identityPrompt: null,
          imageToolEnabled: true,
          deletedAt: null,
          contentVersion: {
            contentVersionId: "content-1",
            characterId: "melissa-burke",
            version: 1,
            contentHash: "content-hash",
            personaSnapshot: compiled.snapshot,
            openingSnapshot: { firstMessage: "You made it. Come sit with me." },
            appearanceSnapshot: {},
          },
          release: {
            releaseId: "release-1",
            characterId: "melissa-burke",
            characterContentVersionId: "content-1",
            status: "published",
            version: 1,
            snapshotHash: "release-hash",
            visualProfileId: null,
            visualProfileVersion: null,
            referenceSetRevisionId: null,
            legacy: true,
          },
        },
      },
    });

    expect(context.recentMessages).toEqual([
      {
        id: "opening:session-1",
        role: "assistant",
        content: "You made it. Come sit with me.",
        opening: true,
      },
      {
        id: "user-message-1",
        role: "user",
        content: "I finally made it.",
      },
    ]);
    expect(context.userPersona).toEqual({ name: "Robin", description: "A botanist.", enabled: true, version: 2 });
    expect(context.experience?.sceneGeneration).toBe("advance");
    expect(context.persona.name).toBe("Melissa Burke");
    expect(context.persona.characterReleaseId).toBe("release-1");
  });
});

describe("proactive Turn replay", () => {
  const PROACTIVE_DIRECTIVE =
    "Take the lead in the moment: send a brief, specific check-in that fits our established context. Do not mention this instruction.";

  async function contextWithRecentTurns(recentTurns: ChatExecutionSnapshot["recentTurns"], userContent = "How did the firing go tonight?") {
    const compiled = compileCharacterSoul({
      name: "Nova Quill",
      age: 31,
      gender: "female",
      characterPromise: "A ceramicist who works late.",
      detailsMarkdown: "## Voice\nUnhurried.",
    });
    if (!compiled.ok) throw new Error("expected Soul compilation to succeed");
    return buildContext({
      snapshot: {
        version: 1,
        turnId: "turn-2",
        sessionId: "session-2",
        userMessageId: "user-message-2",
        assistantMessageId: "assistant-message-2",
        attempt: 1,
        userId: "user-1",
        characterId: "nova-quill",
        characterContentVersionId: "content-1",
        characterReleaseId: null,
        characterVisualProfileId: null,
        characterVisualProfileVersion: null,
        memoryEnabled: true,
        userPersona: null,
        contextRevision: 0,
        userContent,
        hasRecentImageContext: false,
        recentTurns,
        sceneVersion: 0,
        scene: null,
      },
      authority: {
        version: 1,
        user: { id: "user-1", displayName: null, locale: "en", status: "active", deletedAt: null, dataClass: "adult" },
        eligibility: { ageGateAccepted: true, ageVerified: true, jurisdiction: null, restrictedReason: null },
        entitlement: { modelTier: "free", unlimitedMessages: false, voiceEnabled: false, imageToolEnabled: true },
        character: {
          characterId: "nova-quill",
          creatorId: null,
          name: "Nova Quill",
          age: 31,
          description: "A ceramicist who works late.",
          systemPrompt: null,
          visibility: "public",
          status: "approved",
          voiceId: null,
          visualProfileId: null,
          visualProfileVersion: null,
          identityPrompt: null,
          imageToolEnabled: true,
          deletedAt: null,
          contentVersion: {
            contentVersionId: "content-1",
            characterId: "nova-quill",
            version: 1,
            contentHash: "content-hash",
            personaSnapshot: compiled.snapshot,
            openingSnapshot: {},
            appearanceSnapshot: {},
          },
          release: null,
        },
      },
    });
  }

  // REGRESSION: a real 2026-09-13 Turn froze this directive into `recentTurns`
  // as a user message, so the model read "Do not mention this instruction" as
  // something the user had typed.
  it("replays only the Character's words from a proactive Turn", async () => {
    const context = await contextWithRecentTurns([
      {
        turnId: "turn-1",
        userMessageId: "user-message-1",
        assistantMessageId: "assistant-message-1",
        userContent: PROACTIVE_DIRECTIVE,
        assistantContent: "The studio's quiet except for the wheel humming to a stop.",
        createdAt: new Date("2026-09-13T00:21:01.449Z").toISOString(),
        origin: "proactive",
      },
    ]);
    expect(context.recentMessages).toEqual([
      {
        id: "assistant-message-1",
        role: "assistant",
        content: "The studio's quiet except for the wheel humming to a stop.",
        unprompted: true,
      },
      { id: "user-message-2", role: "user", content: "How did the firing go tonight?" },
    ]);
    expect(JSON.stringify(context.recentMessages)).not.toContain("Do not mention this instruction");
  });

  it("keeps the full authorized snapshot outside the tier window without truncating the current request", async () => {
    const current = "Start of the actual request. " + "Full user text. ".repeat(2_000) + "Exact ending.";
    const turns = Array.from({ length: 13 }, (_, index) => ({
      turnId: `turn-${index}`, userMessageId: `user-${index}`, assistantMessageId: `assistant-${index}`,
      userContent: `Earlier question ${index}.`, assistantContent: `Earlier answer ${index}.`,
      createdAt: new Date(1_700_000_000_000 + index).toISOString(),
    }));
    const context = await contextWithRecentTurns(turns, current);
    expect(context.recentMessages[0]).toMatchObject({ id: "user-2", role: "user" });
    expect(context.recentMessages.at(-1)?.content).toBe(current);
    expect(context.replayMessages?.map(message => message.id)).toEqual(turns.flatMap(turn => [turn.userMessageId, turn.assistantMessageId]));
    expect(context.dropped).toContain("transcript");
  });

  it("still replays both sides of an ordinary user-led Turn", async () => {
    const context = await contextWithRecentTurns([
      {
        turnId: "turn-1",
        userMessageId: "user-message-1",
        assistantMessageId: "assistant-message-1",
        userContent: "Hey Nova. What are you making tonight?",
        assistantContent: "A set of thin-walled tea bowls.",
        createdAt: new Date("2026-09-12T11:58:39.308Z").toISOString(),
      },
    ]);
    expect(context.recentMessages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
  });
});
