import { describe, expect, it } from "vitest";
import { recipeDraftPayload, recipeStateLabelKey } from "./recipes-api";

describe("recipeDraftPayload", () => {
  it("trims fields, keeps mode/useCase as-is, nulls blank negativeBase", () => {
    expect(
      recipeDraftPayload({
        recipeKey: " template_image_v3 ",
        label: " Image v3 ",
        mode: "image",
        useCase: "character",
        body: " a prompt body ",
        negativeBase: "   ",
      }),
    ).toEqual({
      recipeKey: "template_image_v3",
      label: "Image v3",
      mode: "image",
      useCase: "character",
      body: "a prompt body",
      negativeBase: null,
      presetOrder: [],
      safetyHints: { source: "admin_console" },
      sampleMatrix: [],
      dryRunSummary: { source: "admin_console", status: "draft_created" },
    });
  });

  it("keeps a trimmed non-blank negativeBase", () => {
    expect(
      recipeDraftPayload({
        recipeKey: "k",
        label: "l",
        mode: "video",
        useCase: "freeplay",
        body: "b",
        negativeBase: " low quality ",
      }).negativeBase,
    ).toBe("low quality");
  });
});

describe("recipeStateLabelKey", () => {
  it("maps active/draft/archived to operator-facing phrases", () => {
    expect(recipeStateLabelKey({ status: "active" })).toBe("Published");
    expect(recipeStateLabelKey({ status: "draft" })).toBe("Ready to publish");
    expect(recipeStateLabelKey({ status: "archived" })).toBe("Archived");
  });

  it("falls back to the raw status for unknown values", () => {
    expect(recipeStateLabelKey({ status: "weird" })).toBe("weird");
  });
});
