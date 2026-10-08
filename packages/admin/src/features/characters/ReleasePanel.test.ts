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
      preview: { draft: { assetPackReady: true, opening: { firstMessage: "You made it." } } },
    });

    expect(characterReleaseDraftBlockers(data)).toEqual([]);
  });

  it("predicts every release check the workspace can see", () => {
    const blockers = (overrides: Parameters<typeof characterWorkspaceDetail>[0]) =>
      characterReleaseDraftBlockers(characterWorkspaceDetail({
        project: { draftAssetRouteAuthority: { releaseReady: true } },
        preview: { draft: { assetPackReady: true, opening: { firstMessage: "Hi." } } },
        ...overrides,
      }));
    const visualBlocker = (code: string) => ({ code, message: code, deepLink: "/admin/characters/character-fixture?tab=visual" });

    expect(blockers({})).toEqual([]);
    expect(blockers({ soul: { valid: false } })).toEqual(["soul_snapshot_valid"]);
    // Warnings fail soul_release_policy too; the backend does not filter by severity.
    expect(blockers({ soul: { current: { diagnostics: [{ code: "w", path: [], severity: "warning", message: "w" }] } } }))
      .toEqual(["soul_release_policy"]);
    expect(blockers({ soul: { current: { schemaVersion: 2 } } })).toEqual(["soul_release_policy"]);
    expect(blockers({ preview: { draft: { assetPackReady: true, opening: { firstMessage: "  " } } } })).toEqual(["opening_complete"]);
    expect(blockers({ visual: { readiness: { blockers: [
      visualBlocker("reference_set_not_active"), visualBlocker("generation_route_stale"), visualBlocker("visual_traits_incomplete"),
    ] } } })).toEqual(["reference_set_not_active", "generation_route_stale"]);
    expect(blockers({ project: { draftAssetRouteAuthority: { releaseReady: true, releaseBlockers: ["qualified_generation_route_missing"] } } }))
      .toEqual(["qualified_generation_route_missing"]);
  });

  it("routes every proposal blocker code to its fix, never back to the release tab", () => {
    const href = (blocker: string) => releaseBlockerGuidance(blocker, "c1").href;
    expect(href("approved_avatar_missing")).toBe("/admin/characters/c1?tab=assets");
    expect(href("revision_missing")).toBe("/admin/characters/c1?tab=soul");
    expect(href("release_generation_authority_kind")).toBe("/admin/characters/c1?tab=visual");
    // No identity yet: the first portrait is created in Images, same as the journey says.
    expect(href("visual_identity_missing")).toBe("/admin/characters/c1?tab=assets");
    expect(href("active_visual_profile_missing_or_unsealed")).toBe("/admin/characters/c1?tab=assets");
    expect(href("reference_set_not_active")).toBe("/admin/characters/c1?tab=visual");
    for (const blocker of ["character_missing", "project_missing", "companion_product_contract", "snapshot_hash_matches", "something_new"]) {
      expect(releaseBlockerGuidance(blocker, "c1")).toMatchObject({ href: null, action: null });
    }
    expect(characterReleaseCheckLabel("companion_product_contract")).toBe("Companion product contract");
  });
});
