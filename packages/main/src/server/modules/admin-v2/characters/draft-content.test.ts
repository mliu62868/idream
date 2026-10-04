import { describe, expect, it } from "vitest";
import { characterDraftSnapshots } from "./draft-content";

describe("characterDraftSnapshots", () => {
  it("freezes a complete serving persona in the content version", () => {
    const snapshots = characterDraftSnapshots({
      persona: {
        name: "Mara Vale",
        age: 31,
        gender: "female",
        characterPromise: "A perceptive partner who notices what goes unsaid.",
        detailsMarkdown: "## Personality\nPatient, wry, and fiercely dependable.\n\n## Voice\nLow-key warmth, concise sentences, and dry humor.\n\n## Background\nMara rebuilt her life after changing careers at twenty-eight.",
        firstMessage: "You got quiet again. Want to tell me what happened?",
      },
      visualDirection: {
        identityAnchor: "Adult woman with a steady, observant expression.",
        stableTraits: ["dark wavy hair", "brown eyes"],
        style: "realistic",
        referenceDirection: "Natural window light and intimate framing.",
      },
    });

    expect(snapshots.personaSnapshot).toMatchObject({
      schemaVersion: 3,
      soul: {
        name: "Mara Vale",
        characterPromise: "A perceptive partner who notices what goes unsaid.",
      },
      compiled: {
        compilerVersion: "character-soul-3",
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(snapshots.personaSnapshot.compiled.systemPrompt).toContain(
      "Patient, wry, and fiercely dependable.",
    );
    expect(snapshots.personaSnapshot.compiled.systemPrompt).toContain(
      "Low-key warmth, concise sentences, and dry humor.",
    );
    expect(snapshots.personaSnapshot.compiled.systemPrompt).not.toContain("Relationship");
    expect(snapshots.renderedSoulMarkdown).toContain("# Mara Vale — Character Soul");
    expect(snapshots.diagnostics).toEqual([]);
  });

  it("preserves source image and structured traits when editing the four direction fields", () => {
    const previousAppearance = {
      identityAnchor: "Old anchor", stableTraits: ["brown eyes"], style: "anime",
      referenceDirection: "Old direction", sourceImage: "/original.webp",
      structured: { bodyTraits: { height: "tall" } },
    };
    const original = structuredClone(previousAppearance);
    const visualDirection = {
      identityAnchor: "Adult radio host", stableTraits: ["brown eyes"], style: "realistic" as const,
      referenceDirection: "Warm studio light",
    };
    const snapshots = characterDraftSnapshots({ persona: {
      name: "Mara", age: 28, gender: "female", characterPromise: "A thoughtful companion",
      detailsMarkdown: "", firstMessage: "How was your day?",
    }, visualDirection }, previousAppearance);
    expect(snapshots.appearanceSnapshot).toEqual({ ...original, ...visualDirection });
    expect(previousAppearance).toEqual(original);
  });
});
