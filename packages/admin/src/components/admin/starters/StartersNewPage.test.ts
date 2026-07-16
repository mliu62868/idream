import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./StartersNewPage.tsx", import.meta.url), "utf8");

describe("StartersNewPage AI assist failure state", () => {
  it("shows AI-assist failures beside the action without mutating the draft in the catch branch", () => {
    expect(source).toContain("assistError");
    expect(source).toContain('role="alert"');

    const catchStart = source.indexOf("} catch (assistError) {");
    const catchEnd = source.indexOf("} finally {", catchStart);
    const catchBranch = source.slice(catchStart, catchEnd);

    expect(catchStart).toBeGreaterThan(-1);
    expect(catchBranch).toContain("setAssistError(");
    expect(catchBranch).not.toContain("patch(");
  });
});
