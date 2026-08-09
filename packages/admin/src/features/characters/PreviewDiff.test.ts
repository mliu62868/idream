import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./PreviewDiff.tsx", import.meta.url), "utf8");

describe("Character launch preview evidence", () => {
  it("renders immutable QA evidence and repair links", () => {
    expect(source).toContain('<option value="">{t("Not run")}</option>');
    expect(source).toContain("Checks, evidence, and repair paths");
    expect(source).toContain("check.comment");
    expect(source).toContain("check.evidenceRef");
    expect(source).toContain("check.fixDeepLink");
    expect(source).toContain("activeReleaseCandidate");
    expect(source).toContain(
      "Request changes to withdraw it before recording another QA Run.",
    );
    expect(source).toContain("Regenerate under current route");
    expect(source).toContain("Complete Character Assets");
  });

  it("renders server behavior transcripts, pairwise evidence, and exact canaries", () => {
    expect(source).toContain('t("Character Soul Behavior Evaluation")');
    expect(source).toContain('t("Official character pairwise distinctiveness")');
    expect(source).toContain('t("Exact production model canaries")');
    expect(source).toContain("run.behaviorEvaluation.cases.map");
    expect(source).toContain("run.liveCanaries.map");
  });
});
