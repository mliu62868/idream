import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  characterReleaseCheckLabel,
  characterReleaseConfirmationVisible,
} from "./ReleasePanel";

const workspaceSource = readFileSync(
  new URL("./ReleasePanel.tsx", import.meta.url),
  "utf8",
);

describe("Character release panel", () => {
  it("presents release checks as operator language", () => {
    expect(characterReleaseCheckLabel("release_generation_authority_kind"))
      .toBe("Generation authority");
    expect(characterReleaseCheckLabel("release_asset_review_authority"))
      .toBe("Asset review authority");
    expect(characterReleaseCheckLabel("custom_release_check"))
      .toBe("custom release check");
  });

  it("keeps destructive Serving confirmation available without a Release candidate", () => {
    expect(characterReleaseConfirmationVisible({
      hasCandidate: false,
      hasReleasableQaRun: false,
      servingState: "live",
    })).toBe(true);
    expect(characterReleaseConfirmationVisible({
      hasCandidate: false,
      hasReleasableQaRun: false,
      servingState: null,
    })).toBe(false);
  });

  it("separates the live release, candidate, and collapsed history", () => {
    expect(workspaceSource).toContain('t("Current live release")');
    expect(workspaceSource).toContain('t("Release candidate")');
    expect(workspaceSource).toContain('t("Release history")');
    expect(workspaceSource).toContain('const historical = ["superseded", "withdrawn"]');
  });
});
