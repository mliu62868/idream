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
  it("presents technical checks as operator language", () => {
    expect(
      characterReleaseCheckLabel("release_generation_authority_kind"),
    ).toBe("Generation authority");
    expect(characterReleaseCheckLabel("project_character_authority")).toBe(
      "Character snapshot",
    );
    expect(characterReleaseCheckLabel("custom_release_check")).toBe(
      "custom release check",
    );
  });

  it("keeps confirmation only for rollback and live operations", () => {
    expect(
      characterReleaseConfirmationVisible({
        hasRollbackSource: false,
        servingState: null,
      }),
    ).toBe(false);
    expect(
      characterReleaseConfirmationVisible({
        hasRollbackSource: true,
        servingState: "retired",
      }),
    ).toBe(true);
    expect(
      characterReleaseConfirmationVisible({
        hasRollbackSource: false,
        servingState: null,
      }),
    ).toBe(false);
  });

  it("exposes one publish action and no QA, review, validation, or schedule workflow", () => {
    expect(workspaceSource).toContain('t("Publish Character")');
    expect(workspaceSource).toContain("characterReleaseCreateMutation");
    expect(workspaceSource).toContain('submitCommand("publish"');
    expect(workspaceSource).not.toContain("qaRunId");
    expect(workspaceSource).not.toContain("characterReleaseReviewMutation");
    expect(workspaceSource).not.toContain("Validate pinned snapshot");
    expect(workspaceSource).not.toContain("Propose immutable Release");
    expect(workspaceSource).not.toContain("Schedule at");
    expect(workspaceSource).not.toContain(
      'setError(t("Tick the release confirmation before running this action."))',
    );
  });

  it("separates the live release, ready candidate, and collapsed history", () => {
    expect(workspaceSource).toContain('t("Current live release")');
    expect(workspaceSource).toContain('t("Ready to publish")');
    expect(workspaceSource).toContain('t("Release history")');
  });

  it("does not describe an unchanged live draft as release work", () => {
    expect(workspaceSource).toContain(
      "const noUnpublishedChanges = characterHasNoUnpublishedChanges(data)",
    );
    expect(workspaceSource).toContain(
      "Live and draft are identical. There is nothing to release.",
    );
  });
});
