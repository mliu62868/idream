import { describe, expect, it } from "vitest";
import { compileCharacterSoul } from "@idream/shared";
import { buildContext, fitRecentTranscript } from "./context.js";

describe("recent transcript clipping", () => {
  const opening = { id: "opening", role: "assistant" as const, content: "Welcome aboard.", opening: true as const };
  const exchange = [
    { id: "u1", role: "user" as const, content: "Hi there." },
    { id: "a1", role: "assistant" as const, content: "Hey you." },
    { id: "u2", role: "user" as const, content: "How was your day?" },
  ];

  it("keeps the session's pinned opening as the first assistant line", () => {
    const fitted = fitRecentTranscript([opening, ...exchange], 10_000);
    expect(fitted.messages.map((message) => message.id)).toEqual(["opening", "u1", "a1", "u2"]);
    expect(fitted.dropped).toBe(false);
  });

  it("still drops an orphaned assistant reply whose user turn fell out of the window", () => {
    const fitted = fitRecentTranscript(
      [{ id: "a0", role: "assistant", content: "Reply to a dropped message." }, ...exchange],
      10_000,
    );
    expect(fitted.messages.map((message) => message.id)).toEqual(["u1", "a1", "u2"]);
    expect(fitted.dropped).toBe(true);
  });
});

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
  });
});
