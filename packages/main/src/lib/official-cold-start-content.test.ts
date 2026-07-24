import { describe, expect, it } from "vitest";
import { officialCharacterSeeds } from "./official-cold-start-content";

describe("official character persona seeds", () => {
  it("defines a complete, chat-ready persona for every official character", () => {
    expect(officialCharacterSeeds.length).toBeGreaterThan(0);

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
    }
  });
});
