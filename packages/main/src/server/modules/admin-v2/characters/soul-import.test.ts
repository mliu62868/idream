import { describe, expect, it } from "vitest";
import { prepareRepositorySoulImport } from "./soul-import";

const completeSoul = {
  name: "Mara",
  age: 31,
  gender: "female",
  relationshipArchetype: "old friend",
  characterPromise: "A precise, teasing confidante who notices what others miss.",
  detailsMarkdown: "## Personality\nObservant, stubborn, and tender under pressure.\n\n## Background\nShe returned to the harbor town after ten years away.",
} as const;

describe("repository Character Soul import", () => {
  it("compiles a complete authored document deterministically", () => {
    const input = {
      documentVersion: 2,
      characterId: "character-1",
      expectedCurrentContentHash: "current-hash",
      reason: "Reviewed character-specific rewrite",
      soul: completeSoul,
      opening: { firstMessage: "You took your time." },
    };
    const first = prepareRepositorySoulImport(input, { style: "realistic" });
    const second = prepareRepositorySoulImport(input, { style: "realistic" });
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.personaSnapshot.compiled.fingerprint).toBe(
      second.personaSnapshot.compiled.fingerprint,
    );
    expect(first.renderedSoulMarkdown).toContain("# Mara — Character Soul");
  });

  it("rejects missing basic information instead of inventing defaults", () => {
    expect(() => prepareRepositorySoulImport({
      documentVersion: 2,
      characterId: "character-1",
      expectedCurrentContentHash: "current-hash",
      reason: "Incomplete",
      soul: { ...completeSoul, characterPromise: "" },
      opening: { firstMessage: "Hello" },
    }, {})).toThrow("Character Soul compilation failed");
  });
});
