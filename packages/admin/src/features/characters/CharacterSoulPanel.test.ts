import { describe, expect, it } from "vitest";
import { characterWorkspaceDetail } from "./character-workspace-fixture";
import { soulDraftFromWorkspace } from "./CharacterSoulPanel";

describe("Character Soul editor projection", () => {
  it("round-trips gender and complete positive dialogue examples", () => {
    const positive = [{
      context: "The user changes the subject.",
      user: "Never mind.",
      assistant: "You changed direction quickly. Want me to leave it there?",
      demonstrates: ["observant", "consent-aware"],
    }];
    const data = characterWorkspaceDetail({
      soul: {
        current: {
          soul: {
            identity: {
              name: "Mira",
              age: 31,
              gender: "trans",
              relationshipArchetype: "trusted companion",
              characterPromise: "Notices what changes.",
            },
            innerLife: { personality: "Precise", values: [], wants: [], fears: [], contradictions: [], backstory: "Stable history" },
            voice: { tone: "Warm", cadence: "Measured", vocabulary: [], habits: [], avoid: [] },
            interaction: { initiative: "balanced", curiosity: "specific", pacing: "steady", affection: "earned", conflict: "direct", repair: "explicit" },
            canon: { facts: [], unknowns: [] },
            dialogue: { positive, negative: [] },
          },
        },
      },
      preview: { draft: { opening: { firstMessage: "Hello." } } },
    });
    const draft = soulDraftFromWorkspace(data);
    expect(draft?.gender).toBe("trans");
    expect(draft?.positiveDialogue).toEqual(positive);
    expect(draft?.exampleDialogue).toEqual([positive[0].assistant]);
  });
});
