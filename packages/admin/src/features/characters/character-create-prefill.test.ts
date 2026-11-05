import { describe, expect, it } from "vitest";
import { characterProjectDraftSchema, type CharacterProjectDraft } from "@idream/shared/admin";
import {
  assistSuggestion,
  fillEmptyDraftFields,
  templateSuggestion,
  withVisualDirectionDefaults,
} from "./character-create-prefill";

const empty: CharacterProjectDraft = {
  persona: { name: "", age: 18, gender: "female", characterPromise: "", detailsMarkdown: "", firstMessage: "" },
  visualDirection: { identityAnchor: "", stableTraits: [], style: "realistic", referenceDirection: "" },
};

const assist = {
  description: "A dry night-shift nurse.",
  nameIdeas: ["Mara Vale", "Elin Rowe"],
  advancedDetails: { detailsMarkdown: "## Voice", firstMessage: "Long shift?", visualBrief: "Warm low light." },
  visualDirection: { identityAnchor: "Night-shift nurse", stableTraits: ["Dark hair"] },
  failedStages: [],
  runtime: { provider: "pipeline", pipelineUrl: null, model: "m" },
} as const;

describe("fillEmptyDraftFields", () => {
  it("fills a blank draft completely enough to pass the contract", () => {
    const { draft, kept } = fillEmptyDraftFields(empty, assistSuggestion({ ...assist, nameIdeas: [...assist.nameIdeas], failedStages: [], visualDirection: { identityAnchor: "Night-shift nurse", stableTraits: ["Dark hair"] } }));
    expect(characterProjectDraftSchema.safeParse(draft).success).toBe(true);
    expect(draft.persona.name).toBe("Mara Vale");
    expect(kept).toEqual([]);
  });

  it("never overwrites what the operator already wrote and says so", () => {
    const mine: CharacterProjectDraft = {
      persona: { ...empty.persona, name: "Mine", firstMessage: "My opening" },
      visualDirection: { ...empty.visualDirection, stableTraits: ["My trait"] },
    };
    const { draft, filled, kept } = fillEmptyDraftFields(mine, assistSuggestion({ ...assist, nameIdeas: [...assist.nameIdeas], failedStages: [], visualDirection: { identityAnchor: "Nurse", stableTraits: ["Other"] } }));
    expect(draft.persona.name).toBe("Mine");
    expect(draft.persona.firstMessage).toBe("My opening");
    expect(draft.visualDirection.stableTraits).toEqual(["My trait"]);
    expect(kept).toEqual(expect.arrayContaining(["Name", "Opening message", "Features that never change"]));
    expect(filled).toContain("Short description");
  });

  it("leaves fields from failed stages empty", () => {
    const { draft } = fillEmptyDraftFields(empty, assistSuggestion({
      description: "", nameIdeas: [], advancedDetails: { detailsMarkdown: "", firstMessage: "Hi.", visualBrief: "" },
      failedStages: ["description"], runtime: { provider: "pipeline", pipelineUrl: null, model: "m" },
    }));
    expect(draft.persona.characterPromise).toBe("");
    expect(draft.persona.firstMessage).toBe("Hi.");
    expect(draft.visualDirection.stableTraits).toEqual([]);
  });
});

describe("templateSuggestion", () => {
  it("reads a seed template's face, hair, body and legacy persona", () => {
    const suggestion = templateSuggestion({
      summary: "Lives one floor up.",
      gender: "male",
      style: "anime",
      appearance: { face: { prompt: "Warm open face", eyes: "Hazel" }, hair: { prompt: "Dark waves" }, body: { type: "Athletic" } },
      advancedDetails: { description: "Neighbour.", firstMessage: "Hi.", personality: "Warm" },
    });
    expect(suggestion).toMatchObject({
      gender: "male",
      style: "anime",
      characterPromise: "Lives one floor up.",
      firstMessage: "Hi.",
      identityAnchor: "Warm open face",
      stableTraits: ["Dark waves", "Athletic", "Hazel eyes"],
    });
    expect(suggestion.detailsMarkdown).toContain("Warm");
  });

  it("reads an Admin-saved template's notes and art direction", () => {
    expect(templateSuggestion({
      summary: null,
      gender: "unknown",
      style: null,
      appearance: { notes: "Radio host\nDark hair", visualBrief: "Low light" },
      advancedDetails: { detailsMarkdown: "Mine", firstMessage: "Hi." },
    })).toMatchObject({
      gender: undefined,
      identityAnchor: "Radio host",
      stableTraits: ["Radio host", "Dark hair"],
      referenceDirection: "Low light",
      detailsMarkdown: "Mine",
    });
  });
});

describe("withVisualDirectionDefaults", () => {
  it("defaults what can be defaulted and leaves the traits to the operator", () => {
    const next = withVisualDirectionDefaults({ ...empty, persona: { ...empty.persona, characterPromise: "A dry nurse" } });
    expect(next.visualDirection.identityAnchor).toBe("A dry nurse");
    expect(next.visualDirection.referenceDirection).not.toBe("");
    expect(next.visualDirection.stableTraits).toEqual([]);
    expect(characterProjectDraftSchema.shape.visualDirection.shape.referenceDirection.safeParse(next.visualDirection.referenceDirection).success).toBe(true);
  });

  it("keeps operator text", () => {
    const filled = { ...empty, visualDirection: { ...empty.visualDirection, identityAnchor: "Mine", referenceDirection: "Mine too" } };
    expect(withVisualDirectionDefaults(filled)).toBe(filled);
  });
});
