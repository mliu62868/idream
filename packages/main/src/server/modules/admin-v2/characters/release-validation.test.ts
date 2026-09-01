import { describe, expect, it } from "vitest";
import {
  characterReleaseBlockers,
  releaseCheckKeys,
} from "./release-validation";

describe("Character Release Companion contract gate", () => {
  it("requires the versioned deterministic Companion product canary", () => {
    expect(releaseCheckKeys).toContain("companion_product_contract");
    expect(characterReleaseBlockers([{
      key: "companion_product_contract",
      evidence: {},
    }])).toEqual(["companion_product_contract"]);
  });
});
