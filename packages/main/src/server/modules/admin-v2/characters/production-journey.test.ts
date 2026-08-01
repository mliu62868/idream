import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  projectCharacterProductionJourneys,
  projectCharacterProductionJourneySnapshot,
  type CharacterProductionPurpose,
} from "./production-journey";

const allPurposes: readonly CharacterProductionPurpose[] = [
  "character_cover",
  "character_hero",
  "character_chat",
];

function journey(overrides: Partial<Parameters<typeof projectCharacterProductionJourneySnapshot>[0]> = {}) {
  return projectCharacterProductionJourneySnapshot({
    characterId: "character-1",
    asOf: new Date("2026-07-31T12:00:00.000Z"),
    hasVisualProfile: true,
    referenceCount: 1,
    routeQualified: true,
    hasActiveImageRun: false,
    draftPurposes: [],
    livePurposes: [],
    servingState: "inactive",
    currentReleaseId: null,
    candidateReleaseId: null,
    activeCommand: null,
    ...overrides,
  });
}

describe("Character Production Journey", () => {
  it("loads a page in a bounded number of queries instead of once per Character", async () => {
    const run = async (count: number) => {
      let queries = 0;
      const findMany = <T>(rows: T[]) => async () => {
        queries += 1;
        return rows;
      };
      const ids = Array.from({ length: count }, (_, index) => `character-${index}`);
      const db = {
        characterProject: {
          findMany: findMany(ids.map((characterId, index) => ({
            id: `project-${index}`,
            characterId,
            draftAssetPack: {},
            updatedAt: new Date("2026-07-31T00:00:00.000Z"),
          }))),
        },
        characterServing: { findMany: findMany([]) },
        characterVisualProfile: { findMany: findMany([]) },
        contentProductionBatch: { findMany: findMany([]) },
        controlPlaneCommand: { findMany: findMany([]) },
        characterRelease: { findMany: findMany([]) },
      } as unknown as PrismaClient;
      const result = await projectCharacterProductionJourneys(
        db,
        ids,
        new Date("2026-07-31T12:00:00.000Z"),
      );
      return { queries, size: result.size };
    };
    await expect(run(1)).resolves.toEqual({ queries: 6, size: 1 });
    await expect(run(25)).resolves.toEqual({ queries: 6, size: 25 });
  });

  it("gives an active durable command exclusive priority", () => {
    const result = journey({
      hasVisualProfile: false,
      hasActiveImageRun: true,
      activeCommand: {
        id: "command-1",
        type: "character.release.publish",
        status: "verifying",
        needsReconciliation: true,
      },
    });
    expect(result).toMatchObject({
      stage: "release_review",
      status: "blocked",
      primaryAction: {
        code: "recover_active_command",
        deepLink: "/admin/characters/character-1?tab=release",
        command: { id: "command-1", needsReconciliation: true },
      },
      blockers: [{ code: "command_needs_reconciliation" }],
    });
  });

  it("keeps an active image command in the image-production stage", () => {
    const result = journey({
      activeCommand: {
        id: "command-image-1",
        type: "character.image.generate",
        status: "running",
        needsReconciliation: false,
      },
    });
    expect(result).toMatchObject({
      stage: "image_production",
      status: "in_progress",
      primaryAction: {
        code: "recover_active_command",
        deepLink: "/admin/characters/character-1?tab=assets",
      },
    });
    expect(result.steps[1]).toMatchObject({ code: "image_assets", state: "current" });
  });

  it("uses a live portrait to establish identity instead of starting from zero", () => {
    expect(journey({
      hasVisualProfile: false,
      servingState: "live",
      currentReleaseId: "release-live",
      livePurposes: ["character_cover"],
    })).toMatchObject({
      stage: "visual_setup",
      primaryAction: { code: "prepare_image_production" },
      release: { servingState: "live", currentReleaseId: "release-live" },
    });
  });

  it("blocks on the earliest missing visual authority before active image work", () => {
    const result = journey({ referenceCount: 0, hasActiveImageRun: true });
    expect(result.primaryAction).toMatchObject({
      code: "complete_image_route",
      deepLink: "/admin/characters/character-1?tab=visual#visual-reference-set",
    });
    expect(result.steps[0]).toMatchObject({ code: "visual_identity", state: "blocked" });
  });

  it("continues the active run before selecting another missing purpose", () => {
    expect(journey({ hasActiveImageRun: true }).primaryAction.code).toBe("continue_image_run");
  });

  it("keeps live truth while directing an incomplete live pack back to assets", () => {
    const result = journey({
      servingState: "live",
      currentReleaseId: "release-live",
      livePurposes: ["character_cover"],
    });
    expect(result).toMatchObject({
      stage: "image_production",
      primaryAction: { code: "continue_asset_pack" },
      assetPack: { live: { completed: 1, missingPurposes: ["character_hero", "character_chat"] } },
      release: { servingState: "live", currentReleaseId: "release-live" },
    });
    expect(result.steps[3]).toMatchObject({ code: "release", state: "complete" });
  });

  it("moves a completed draft through Release review, then monitors an unchanged live pack", () => {
    expect(journey({
      draftPurposes: allPurposes,
      candidateReleaseId: "release-candidate",
    }).primaryAction.code).toBe("review_candidate_release");
    expect(journey({
      servingState: "live",
      currentReleaseId: "release-live",
      livePurposes: allPurposes,
    })).toMatchObject({
      stage: "live_operations",
      status: "live",
      primaryAction: { code: "monitor_live_character" },
    });
  });
});
