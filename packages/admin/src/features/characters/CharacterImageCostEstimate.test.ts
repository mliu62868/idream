import { describe, expect, it } from "vitest";
import { characterImageCostEstimate } from "./CharacterImageCostEstimate";

const estimates = [
  { profileKey: "profile-reference-v1", perItemCostDreamcoins: 14 },
  { profileKey: "profile-bootstrap-v1", perItemCostDreamcoins: 9 },
];

describe("characterImageCostEstimate", () => {
  it("multiplies the projected per-image price by the image count", () => {
    expect(characterImageCostEstimate({ estimates, profileKey: "profile-reference-v1", imageCount: 4 }))
      .toEqual({ perItemCostDreamcoins: 14, imageCount: 4, totalCostDreamcoins: 56 });
    expect(characterImageCostEstimate({ estimates, profileKey: "profile-bootstrap-v1", imageCount: 1 }))
      .toEqual({ perItemCostDreamcoins: 9, imageCount: 1, totalCostDreamcoins: 9 });
  });

  it("returns null instead of inventing a price", () => {
    expect(characterImageCostEstimate({ estimates, profileKey: "profile-unknown", imageCount: 2 })).toBeNull();
    expect(characterImageCostEstimate({ estimates: undefined, profileKey: "profile-reference-v1", imageCount: 2 })).toBeNull();
    expect(characterImageCostEstimate({ estimates, profileKey: undefined, imageCount: 2 })).toBeNull();
    expect(characterImageCostEstimate({ estimates, profileKey: "", imageCount: 2 })).toBeNull();
    expect(characterImageCostEstimate({ estimates, profileKey: "profile-reference-v1", imageCount: 0 })).toBeNull();
  });
});
