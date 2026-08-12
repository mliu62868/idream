import { describe, expect, it } from "vitest";
import {
  MAIN_TO_CHAT_EVENTS,
  characterModerationRemovalEventId,
  characterModerationRemovedPayloadSchema,
  characterModerationRestorationEventId,
  characterModerationRestorationPayloadSchema,
} from "./index";

describe("moderation restoration durable contract", () => {
  it("binds one restoration request to the exact moderation removal event", () => {
    const removalEventId = characterModerationRemovalEventId("decision-1");

    expect(removalEventId).toBe("moderation_character_removed_decision-1");
    expect(characterModerationRestorationEventId("appeal-1")).toBe(
      "moderation_character_restoration_appeal-1",
    );
    expect(MAIN_TO_CHAT_EVENTS.characterModerationRestorationRequested).toBe(
      "character.moderation_restoration.requested.v1",
    );
    expect(
      characterModerationRemovedPayloadSchema.parse({
        version: 1,
        binding: "moderation_decision",
        characterId: "character-1",
        moderationDecisionId: "decision-1",
        previousRemovalEventId: null,
      }),
    ).toEqual({
      version: 1,
      binding: "moderation_decision",
      characterId: "character-1",
      moderationDecisionId: "decision-1",
      previousRemovalEventId: null,
    });
    expect(
      characterModerationRestorationPayloadSchema.parse({
        version: 1,
        binding: "removal_event",
        appealId: "appeal-1",
        characterId: "character-1",
        moderationDecisionId: "decision-1",
        removalEventId,
      }),
    ).toEqual({
      version: 1,
      binding: "removal_event",
      appealId: "appeal-1",
      characterId: "character-1",
      moderationDecisionId: "decision-1",
      removalEventId,
    });
  });

  it("rejects restoration payloads without exact causal identities", () => {
    expect(
      characterModerationRestorationPayloadSchema.safeParse({
        version: 1,
        binding: "removal_event",
        characterId: "character-1",
      }).success,
    ).toBe(false);
  });
});
