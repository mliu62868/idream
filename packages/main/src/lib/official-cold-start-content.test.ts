import { describe, expect, it } from "vitest";
import {
  officialCharacterSeeds,
  resolveOfficialColdStartPersonaWrite,
} from "./official-cold-start-content";

describe("official character persona seeds", () => {
  it("defines a complete, chat-ready persona for every official character", () => {
    expect(officialCharacterSeeds).toHaveLength(16);

    for (const character of officialCharacterSeeds) {
      expect(character.setup.trim(), character.id).not.toBe("");
      expect(character.personality.trim(), character.id).not.toBe("");
      expect(character.tone.trim(), character.id).not.toBe("");
      expect(character.backstory.trim(), character.id).not.toBe("");
      expect(character.firstMessage.trim(), character.id).not.toBe("");
      expect(character.exampleDialogue.length, character.id).toBeGreaterThan(0);
      expect(
        character.exampleDialogue.every((line) => line.trim().length > 0),
        character.id,
      ).toBe(true);
      expect(["realistic", "anime"], character.id).toContain(character.style);
      expect(character.identityAnchor.trim(), character.id).not.toBe("");
      expect(character.stableTraits.length, character.id).toBeGreaterThan(0);
      expect(
        character.stableTraits.every((trait) => trait.trim().length > 0),
        character.id,
      ).toBe(true);
    }

    expect(
      officialCharacterSeeds
        .filter((character) => character.style === "anime")
        .map((character) => character.id),
    ).toEqual(["sophie", "diana-weird-girl", "lola-moonstruck"]);
  });

  it("keeps Raya guarded without turning trust into a product dead end", () => {
    const raya = officialCharacterSeeds.find((character) => character.id === "raya-reyes");

    expect(raya).toBeDefined();
    expect(raya?.personality).toContain("curious");
    expect(raya?.backstory).toContain(
      "Direct requests make her tease, choose, and participate instead of stalling the interaction.",
    );
    expect(raya?.backstory).toContain(
      "If she pushes back, she moves the scene forward with a concrete alternative rather than repeating a trust lecture.",
    );
    expect(raya?.backstory).toContain(
      "she acknowledges the weight first and offers a small choice such as listening, distraction, or quiet company",
    );
    expect(raya?.tone).toContain("never repetitive, scolding, or dismissive of real distress");
    expect(raya?.exampleDialogue).toContain(
      "You really are direct... Fine—one photo. Do not make me regret giving you the satisfaction.",
    );
  });

  it("refreshes legacy official personas but preserves modern operator releases", () => {
    const input = {
      seedAdvancedDetails: {
        detailsMarkdown: "new Raya persona",
        firstMessage: "new opening",
      },
      existingAdvancedDetails: {
        detailsMarkdown: "old Raya persona",
        firstMessage: "old opening",
        operatorNote: "keep this",
      },
      compiledSystemPrompt: "new compiled Soul",
      existingSystemPrompt: "old compiled Soul",
      existingPersonaComplete: true,
    };

    expect(resolveOfficialColdStartPersonaWrite({
      ...input,
      currentReleaseLegacy: true,
    })).toEqual({
      advancedDetails: {
        detailsMarkdown: "new Raya persona",
        firstMessage: "new opening",
        operatorNote: "keep this",
      },
      systemPrompt: "new compiled Soul",
    });

    expect(resolveOfficialColdStartPersonaWrite({
      ...input,
      currentReleaseLegacy: false,
    })).toEqual({
      advancedDetails: input.existingAdvancedDetails,
      systemPrompt: "old compiled Soul",
    });
  });
});
