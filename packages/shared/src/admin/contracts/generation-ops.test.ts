import { describe, expect, it } from "vitest";
import {
  generationPresetCreateRequestSchema,
  generationPresetPatchRequestSchema,
  generationRecipeCreateRequestSchema,
  generationRecipePatchRequestSchema,
} from "./generation-ops";

describe("recipe draft request defaults", () => {
  it("applies defaults only when creating, so a partial edit does not rewrite hidden configuration or its route", () => {
    expect(generationRecipePatchRequestSchema.parse({ label: "Renamed recipe" })).toEqual({ label: "Renamed recipe" });
    expect(generationRecipeCreateRequestSchema.parse({ recipeKey: "portrait", label: "Portrait", body: "portrait prompt" })).toMatchObject({
      mode: "image", useCase: "character", presetOrder: [], safetyHints: {}, sampleMatrix: [],
    });
  });
});

describe("preset partial updates", () => {
  it.each([
    { name: "archive", input: { status: "archived" } },
    { name: "restore", input: { status: "active" } },
    { name: "label edit", input: { label: "Renamed preset" } },
  ])("does not add omitted visibility, controls or status to a $name", ({ input }) => {
    expect(generationPresetPatchRequestSchema.parse(input)).toEqual(input);
  });

  it("still accepts deliberately supplied empty controls and lifecycle changes", () => {
    const input = { controls: {}, visibility: "private", status: "archived" };
    expect(generationPresetPatchRequestSchema.parse(input)).toEqual(input);
  });

  it("keeps the existing creation defaults", () => {
    expect(generationPresetCreateRequestSchema.parse({ type: "background", label: "New preset" })).toEqual({
      type: "background", label: "New preset", controls: {}, visibility: "public", status: "active",
    });
  });
});
