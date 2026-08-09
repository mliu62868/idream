import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { characterReleaseConfirmationVisible } from "./ReleasePanel";

const workspaceSource = readFileSync(
  new URL("./ReleasePanel.tsx", import.meta.url),
  "utf8",
);

describe("Character release panel", () => {
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
