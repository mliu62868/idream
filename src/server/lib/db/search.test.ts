import { describe, expect, it } from "vitest";
import { nameMatch, normalizeSearchQuery } from "./search";

describe("db search helpers", () => {
  it("normalizes whitespace and emits portable contains filters", () => {
    expect(normalizeSearchQuery("  Melissa   Burke  ")).toBe("Melissa Burke");
    expect(nameMatch("  Melissa   Burke  ")).toEqual({
      contains: "Melissa Burke",
    });
    expect(nameMatch("   ")).toBeUndefined();
  });
});
