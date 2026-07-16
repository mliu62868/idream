import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./CreativeProductionStudio.tsx", import.meta.url),
  "utf8",
);

describe("creative production pricing truth", () => {
  it("never turns a failed pricing authority request into a zero-cost estimate", () => {
    expect(source).not.toContain(".catch(() => setPerItemCost(0))");
    expect(source).toContain("setPerItemCost(null)");
    expect(source).toContain("Pricing estimate unavailable");
    expect(source).toContain("perItemCost !== null");
  });
});
