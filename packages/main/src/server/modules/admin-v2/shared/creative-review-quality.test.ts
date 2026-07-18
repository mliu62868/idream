import { describe, expect, it } from "vitest";
import {
  creativeReviewQuality,
  creativeReviewQualityPassed,
} from "./creative-review-quality";

describe("Creative review visible quality evidence", () => {
  const quality = {
    artifactFree: true,
    singleSubject: true,
    intentMatch: true,
    noVisibleText: true,
  };

  it("parses canonical and exact legacy evidence without mixing lineage into quality", () => {
    const legacySuperseding = {
      ...quality,
      supersedesDecisionId: "decision-previous",
    };

    expect(creativeReviewQuality({ quality })).toEqual(quality);
    expect(creativeReviewQualityPassed({ quality })).toBe(true);
    expect(creativeReviewQuality(quality)).toEqual(quality);
    expect(creativeReviewQualityPassed(quality)).toBe(true);
    expect(creativeReviewQuality(legacySuperseding)).toEqual(quality);
    expect(creativeReviewQualityPassed(legacySuperseding)).toBe(true);
  });

  it("fails closed for missing, malformed, extra, or failing evidence", () => {
    expect(creativeReviewQualityPassed({ artifactFree: true })).toBe(false);
    expect(creativeReviewQualityPassed({
      artifactFree: true,
      singleSubject: true,
      intentMatch: false,
      noVisibleText: true,
    })).toBe(false);
    expect(creativeReviewQuality({
      quality,
      undeclared: true,
    })).toBeNull();
    expect(creativeReviewQuality({
      ...quality,
      supersedesDecisionId: "decision-previous",
      undeclared: true,
    })).toBeNull();
    expect(creativeReviewQualityPassed(null)).toBe(false);
  });
});
