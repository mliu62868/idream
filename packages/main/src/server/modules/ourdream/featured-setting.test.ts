import { describe, expect, it } from "vitest";
import {
  FEATURED_CHARACTER_LIMIT,
  parseFeaturedSetting,
} from "./featured-setting";

describe("Featured setting canonical parser", () => {
  it("treats a missing setting as a clean empty configuration", () => {
    expect(parseFeaturedSetting(undefined)).toEqual({
      characterIds: [],
      diagnostics: [],
    });
  });

  it("trims, deduplicates, caps, and preserves first-seen order", () => {
    const overflowId = "character-overflow";
    const rawIds: unknown[] = [
      " character-b ",
      "character-a",
      "character-b",
      "",
      42,
      ...Array.from(
        { length: FEATURED_CHARACTER_LIMIT - 2 },
        (_, index) => `character-${index}`,
      ),
      overflowId,
    ];

    const result = parseFeaturedSetting({ characterIds: rawIds });

    expect(result.characterIds).toHaveLength(FEATURED_CHARACTER_LIMIT);
    expect(result.characterIds.slice(0, 2)).toEqual([
      "character-b",
      "character-a",
    ]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "character_id_duplicate",
      "character_id_blank",
      "character_id_not_string",
      "character_id_overflow",
    ]);
    expect(result.diagnostics.at(-1)).toMatchObject({
      id: overflowId,
      code: "character_id_overflow",
    });
  });

  it("diagnoses malformed historical setting shapes", () => {
    expect(parseFeaturedSetting(null).diagnostics).toEqual([
      expect.objectContaining({ code: "setting_not_object" }),
    ]);
    expect(parseFeaturedSetting({ characterIds: "character-a" }).diagnostics)
      .toEqual([
        expect.objectContaining({ code: "character_ids_not_array" }),
      ]);
  });
});
