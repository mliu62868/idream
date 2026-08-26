import { describe, expect, it } from "vitest";
import { officialCharacterSeeds } from "./official-cold-start-content";

describe("official character persona seeds", () => {
  it("defines a complete, chat-ready persona for every official character", () => {
    expect(officialCharacterSeeds).toHaveLength(16);

    for (const character of officialCharacterSeeds) {
      expect(character.relationship.trim(), character.id).not.toBe("");
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
});
