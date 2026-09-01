import { describe, expect, it } from "vitest";
import {
  productionNegativePrompt,
} from "./run-create-authority";

describe("Creative Run prompt authority", () => {
  it("keeps operator exclusions in the effective negative prompt", () => {
    expect(
      productionNegativePrompt(
        "low quality",
        "different person",
        "character_cover",
        "cropped hands, visible text",
      ),
    ).toContain("cropped hands, visible text");
  });

  it("keeps video identity and operator exclusions with the stability guard", () => {
    const negative = productionNegativePrompt(
      "low quality",
      "different person",
      "character_video",
      "cropped hands, visible text",
    );

    expect(negative).toContain("different person");
    expect(negative).toContain("cropped hands, visible text");
    expect(negative).toContain("identity drift");
  });
});
