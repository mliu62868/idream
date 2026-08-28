import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./PreviewDiff.tsx", import.meta.url),
  "utf8",
);

describe("Character launch preview", () => {
  it("is a read-only comparison with no QA workflow", () => {
    expect(source).toContain("Real user-surface renderer");
    expect(source).toContain("Current and draft assets");
    expect(source).not.toContain("Launch checks");
    expect(source).not.toContain("Technical check history");
    expect(source).not.toContain("characterQaMutation");
    expect(source).not.toContain('type="checkbox"');
  });
});
