import { describe, expect, it } from "vitest";
import { starterDetailsMarkdown, starterPayload, starterPreservedFields } from "./starters-api";

const creativeFields = {
  detailsMarkdown: "",
  firstMessage: "",
  appearanceNotes: "",
  visualBrief: "",
};

describe("seed-shaped starters", () => {
  const seed = {
    appearance: {
      face: { prompt: "Warm open face", eyes: "Hazel" },
      hair: { prompt: "Dark waves" },
      body: { type: "Athletic" },
      notes: "Operator note",
      visualBrief: "Window light",
    },
    advancedDetails: { description: "Your neighbour.", personality: "Warm", firstMessage: "Hi." },
  };

  it("surfaces the seed fields the form cannot edit, without repeating the editable ones", () => {
    expect(starterPreservedFields(seed)).toEqual([
      { key: "face", text: "Warm open face · eyes: Hazel" },
      { key: "hair", text: "Dark waves" },
      { key: "body", text: "type: Athletic" },
      { key: "description", text: "Your neighbour." },
    ]);
    expect(starterPreservedFields({ appearance: { notes: "n", visualBrief: "v" }, advancedDetails: {} })).toEqual([]);
  });

  it("folds structured persona only until an operator text exists", () => {
    expect(starterDetailsMarkdown({ personality: "Warm" })).toContain("Warm");
    expect(starterDetailsMarkdown({ personality: "Warm", detailsMarkdown: "Mine" })).toBe("Mine");
    expect(starterDetailsMarkdown({ personality: "Warm", detailsMarkdown: "" })).toBe("");
  });
});

describe("starterPayload", () => {
  it("trims fields, keeps scope/reason as-is", () => {
    expect(
      starterPayload({
        name: " Luna ", summary: " short bio ", gender: " female ", style: " anime ",
        scope: "built_in", tags: "cute, elf ,, ", sortOrder: "3", reason: " ok3 ", ...creativeFields,
      }),
    ).toEqual({
      name: "Luna", summary: "short bio", gender: "female", style: "anime",
      scope: "built_in", tags: ["cute", "elf"], sortOrder: 3, reason: "ok3",
      appearance: { notes: "", visualBrief: "" },
      advancedDetails: {
        detailsMarkdown: "", firstMessage: "",
      },
    });
  });

  it("splits tags on commas, drops blanks, caps at 12", () => {
    const many = Array.from({ length: 15 }, (_, i) => `tag${i}`).join(",");
    expect(
      starterPayload({
        name: "A", summary: "", gender: "", style: "",
        scope: "community", tags: many, sortOrder: "0", reason: "abc", ...creativeFields,
      }).tags,
    ).toEqual(Array.from({ length: 12 }, (_, i) => `tag${i}`));
  });

  it("falls back to sortOrder 0 on garbage, sends empty optional fields as null so edits clear them", () => {
    const payload = starterPayload({
      name: "A", summary: "", gender: "", style: "",
      scope: "built_in", tags: "", sortOrder: "x", reason: "abc", ...creativeFields,
    });
    expect(payload.sortOrder).toBe(0);
    expect(payload.summary).toBeNull();
    expect(payload.gender).toBeNull();
    expect(payload.style).toBeNull();
  });
});
