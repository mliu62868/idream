import { describe, expect, it } from "vitest";
import { nameMatch, normalizeSearchQuery } from "./search";

describe("db search helpers", () => {
  it("normalizes whitespace and emits portable contains filters", () => {
    expect(normalizeSearchQuery("  Melissa   Burke  ")).toBe("Melissa Burke");
    expect(nameMatch("  Melissa   Burke  ")).toEqual({
      contains: "Melissa Burke",
      mode: "insensitive",
    });
    expect(nameMatch("   ")).toBeUndefined();
  });

  it("matches regardless of the case the reader typed", () => {
    // 搜索框里输入 "alexa" 必须找到 "Alexa Reeves"。
    expect(nameMatch("alexa")?.mode).toBe("insensitive");
  });
});
