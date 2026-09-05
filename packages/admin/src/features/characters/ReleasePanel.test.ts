import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  characterReleaseCheckLabel,
  characterReleaseConfirmationVisible,
  characterReleaseDraftBlockers,
  releaseBlockerGuidance,
  releaseBlockersFromError,
} from "./ReleasePanel";
import { AdminV2RequestError } from "@/lib/admin-v2-api";
import { characterWorkspaceDetail } from "./character-workspace-fixture";

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

  it("turns release authority failures into an exact operator repair action", () => {
    expect(
      releaseBlockersFromError(
        new AdminV2RequestError(
          "Character is not ready to publish",
          409,
          "conflict",
          { blockers: ["release_asset_source_authority"] },
        ),
      ),
    ).toEqual(["release_asset_source_authority"]);
    expect(
      releaseBlockerGuidance(
        "release_asset_source_authority",
        "character-1",
      ),
    ).toEqual({
      blocker: "release_asset_source_authority",
      message: "Check the selected images and their sources before publishing.",
      action: "Open image library",
      href: "/admin/characters/character-1?tab=assets",
    });
  });

  it("allows a complete draft pack without manual review", () => {
    const data = characterWorkspaceDetail({
      project: {
        draftAssetPack: {
          character_cover: "cover",
          character_hero: "hero",
          character_chat: "chat",
        },
        draftAssetSelections: {
          character_cover: {
            assetId: "cover",
            runId: "cover-run",
            itemId: "cover-item",
            reviewDecisionId: null,
            generationJobId: "cover-job",
            bootstrapIdentity: true,
            generationRouteFingerprint: null,
            routeCurrent: true,
          },
          character_hero: {
            assetId: "hero",
            runId: "hero-run",
            itemId: "hero-item",
            reviewDecisionId: null,
            generationJobId: "hero-job",
            bootstrapIdentity: false,
            generationRouteFingerprint: "route-1",
            routeCurrent: true,
          },
          character_chat: {
            assetId: "chat",
            runId: "chat-run",
            itemId: "chat-item",
            reviewDecisionId: null,
            generationJobId: "chat-job",
            bootstrapIdentity: false,
            generationRouteFingerprint: "route-1",
            routeCurrent: true,
          },
        },
        draftAssetRouteAuthority: { releaseReady: true },
      },
      preview: { draft: { assetPackReady: true } },
    });

    expect(characterReleaseDraftBlockers(data)).toEqual([]);
  });
});
