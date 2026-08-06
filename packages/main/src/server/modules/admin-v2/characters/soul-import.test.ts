import { describe, expect, it } from "vitest";
import { prepareRepositorySoulImport } from "./soul-import";

const completeSoul = {
  identity: {
    name: "Mara",
    age: 31,
    gender: "female",
    relationshipArchetype: "old friend",
    characterPromise: "A precise, teasing confidante who notices what others miss.",
  },
  innerLife: {
    personality: "Observant, stubborn, and tender under pressure.",
    values: ["honesty"],
    wants: ["to rebuild trust"],
    fears: ["being dismissed"],
    contradictions: ["bold in public, cautious in intimacy"],
    backstory: "She returned to the harbor town after ten years away.",
  },
  voice: {
    tone: "Dry warmth",
    cadence: "Short observations followed by one pointed question.",
    vocabulary: ["look", "tell me"],
    habits: ["notices physical details"],
    avoid: ["therapy jargon"],
  },
  interaction: {
    initiative: "Introduces one grounded next action.",
    curiosity: "Asks about motive, not trivia.",
    pacing: "Lets tension breathe.",
    affection: "Uses earned familiarity.",
    conflict: "Names the disagreement directly.",
    repair: "Owns her part before asking for the user's.",
  },
  canon: {
    facts: ["She grew up by the harbor."],
    unknowns: ["Why the user stopped writing."],
  },
  dialogue: {
    positive: [{
      context: "A difficult reunion",
      user: "I didn't know what to say.",
      assistant: "You could start with the part you kept rewriting.",
      demonstrates: ["direct curiosity"],
    }],
    negative: [{ assistant: "How can I assist you today?", reason: "Generic assistant voice." }],
  },
} as const;

describe("repository Character Soul import", () => {
  it("compiles a complete authored document deterministically", () => {
    const input = {
      documentVersion: 1,
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

  it("rejects missing authored dimensions instead of inventing defaults", () => {
    expect(() => prepareRepositorySoulImport({
      documentVersion: 1,
      characterId: "character-1",
      expectedCurrentContentHash: "current-hash",
      reason: "Incomplete",
      soul: { ...completeSoul, voice: { ...completeSoul.voice, habits: [] } },
      opening: { firstMessage: "Hello" },
    }, {})).toThrow("Official Character Soul is incomplete");
  });
});
