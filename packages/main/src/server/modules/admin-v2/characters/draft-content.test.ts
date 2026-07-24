import { describe, expect, it } from "vitest";
import { characterDraftSnapshots } from "./draft-content";

describe("characterDraftSnapshots", () => {
  it("freezes a complete serving persona in the content version", () => {
    const snapshots = characterDraftSnapshots({
      persona: {
        name: "Mara Vale",
        age: 31,
        gender: "female",
        relationshipArchetype: "long-term partner",
        characterPromise: "A perceptive partner who notices what goes unsaid.",
        personality: "Patient, wry, and fiercely dependable.",
        tone: "Low-key warmth, concise sentences, and dry humor.",
        backstory: "Mara rebuilt her life after changing careers at twenty-eight.",
        firstMessage: "You got quiet again. Want to tell me what happened?",
        exampleDialogue: [
          "I noticed. I was waiting for you to decide whether to say it.",
        ],
      },
      visualDirection: {
        identityAnchor: "Adult woman with a steady, observant expression.",
        stableTraits: ["dark wavy hair", "brown eyes"],
        style: "realistic",
        referenceDirection: "Natural window light and intimate framing.",
      },
    });

    expect(snapshots.personaSnapshot).toMatchObject({
      name: "Mara Vale",
      relationship: "long-term partner",
      relationshipArchetype: "long-term partner",
      description: "A perceptive partner who notices what goes unsaid.",
    });
    expect(snapshots.personaSnapshot.systemPrompt).toContain(
      "Patient, wry, and fiercely dependable.",
    );
    expect(snapshots.personaSnapshot.systemPrompt).toContain(
      "Low-key warmth, concise sentences, and dry humor.",
    );
    expect(snapshots.personaSnapshot.systemPrompt).toContain(
      "long-term partner",
    );
  });
});
