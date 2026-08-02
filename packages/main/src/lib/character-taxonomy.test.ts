import { describe, expect, it } from "vitest";
import { CHARACTER_STYLES, GENDERS } from "@idream/shared/catalog";
import {
  CHARACTER_STYLE_FILTER_VALUES,
  GENDER_FILTER_VALUES,
  characterStyleFilterOptions,
  characterStyleFormOptions,
  genderFilterOptions,
  genderFormOptions,
} from "./character-taxonomy";

describe("character taxonomy", () => {
  // Regression: four hand-copied lists (community filter, explore header filter,
  // explore URL parser, create form) all omitted `other`, so those characters
  // could neither be created nor filtered for.
  it("offers every catalog style, including other", () => {
    expect(characterStyleFormOptions.map((option) => option.value)).toEqual([
      ...CHARACTER_STYLES,
    ]);
    expect(characterStyleFormOptions).toContainEqual({ label: "Other", value: "other" });
    expect(CHARACTER_STYLE_FILTER_VALUES).toContain("other");
    expect(characterStyleFilterOptions.map((option) => option.value)).toEqual([
      "any",
      ...CHARACTER_STYLES,
    ]);
  });

  it("offers every catalog gender", () => {
    expect(genderFormOptions.map((option) => option.value)).toEqual([...GENDERS]);
    expect(genderFilterOptions.map((option) => option.value)).toEqual(["any", ...GENDERS]);
    expect(GENDER_FILTER_VALUES).toContain("any");
  });

  it("labels every option", () => {
    for (const option of [...characterStyleFilterOptions, ...genderFilterOptions]) {
      expect(option.label.trim()).not.toBe("");
    }
  });

  it("only the filter lists carry the any escape hatch", () => {
    expect(characterStyleFormOptions.map((option) => option.value)).not.toContain("any");
    expect(genderFormOptions.map((option) => option.value)).not.toContain("any");
  });
});
