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

function journey(
  overrides: Partial<
    Parameters<typeof projectCharacterProductionJourneySnapshot>[0]
  > = {},
) {
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
    pendingRevision: null,
    draftPurposesNeedingReview: [],
    activeCommand: null,
    ...overrides,
  });
}

describe("Character Production Journey", () => {
  it("loads a page in a bounded number of queries instead of once per Character", async () => {
    const run = async (count: number) => {
      let queries = 0;
      const findMany =
        <T>(rows: T[]) =>
        async () => {
          queries += 1;
          return rows;
        };
      const ids = Array.from(
        { length: count },
        (_, index) => `character-${index}`,
      );
      const db = {
        characterProject: {
          findMany: findMany(
            ids.map((characterId, index) => ({
              id: `project-${index}`,
              characterId,
              draftAssetPack: {},
              updatedAt: new Date("2026-07-31T00:00:00.000Z"),
            })),
          ),
        },
        characterServing: { findMany: findMany([]) },
        characterVisualProfile: { findMany: findMany([]) },
        contentProductionBatch: { findMany: findMany([]) },
        controlPlaneCommand: { findMany: findMany([]) },
        characterRelease: { findMany: findMany([]) },
        characterRevision: { findMany: findMany([]) },
      } as unknown as PrismaClient;
      const result = await projectCharacterProductionJourneys(
        db,
        ids,
        new Date("2026-07-31T12:00:00.000Z"),
      );
      return { queries, size: result.size };
    };
    await expect(run(1)).resolves.toEqual({ queries: 7, size: 1 });
    await expect(run(25)).resolves.toEqual({ queries: 7, size: 25 });
  });

  // SPEC: 已上线角色的项目里出现比线上 Release 更新的 Revision（创作者改了已发布角色），
  //       运营要看到「有待发布的修订」并能直接去发布页。
  describe("pending Revision signal", () => {
    async function project(input: {
      releaseRevisionId: string;
      releaseCreatedAt?: Date;
      revisions: Array<{ id: string; revision: number; createdAt: Date }>;
    }) {
      const db = {
        characterProject: { findMany: async () => [{ id: "project-1", characterId: "character-1", draftAssetPack: {}, updatedAt: new Date() }] },
        characterServing: { findMany: async () => [{ characterId: "character-1", currentReleaseId: "release-live", state: "live" }] },
        characterVisualProfile: { findMany: async () => [] },
        contentProductionBatch: { findMany: async () => [] },
        controlPlaneCommand: { findMany: async () => [] },
        characterRelease: { findMany: async () => [{
          id: "release-live", projectId: "project-1", revisionId: input.releaseRevisionId, status: "published",
          releasePlacementManifest: {}, createdAt: input.releaseCreatedAt ?? new Date("2026-09-01T00:00:00.000Z"),
        }] },
        characterRevision: { findMany: async () => input.revisions.map((revision) => ({ ...revision, projectId: "project-1" })) },
      } as unknown as PrismaClient;
      return (await projectCharacterProductionJourneys(db, ["character-1"], new Date("2026-09-23T00:00:00.000Z")))
        .get("character-1")!.release.pendingRevision;
    }
    const rev1 = { id: "revision-1", revision: 1, createdAt: new Date("2026-08-31T00:00:00.000Z") };
    const rev2 = { id: "revision-2", revision: 2, createdAt: new Date("2026-09-20T00:00:00.000Z") };

    it("flags a Revision newer than the one the live Release pins", async () => {
      await expect(project({ releaseRevisionId: rev1.id, revisions: [rev2, rev1] })).resolves.toEqual({
        revisionId: "revision-2",
        revision: 2,
        createdAt: "2026-09-20T00:00:00.000Z",
        deepLink: "/admin/characters/character-1?tab=release",
      });
    });

    it("stays quiet when the live Release pins the newest Revision", async () => {
      await expect(project({ releaseRevisionId: rev2.id, revisions: [rev2, rev1] })).resolves.toBeNull();
    });

    it("judges a legacy Release with an unknown Revision by time", async () => {
      await expect(project({ releaseRevisionId: "legacy-revision", revisions: [rev1] })).resolves.toBeNull();
      await expect(project({ releaseRevisionId: "legacy-revision", revisions: [rev2, rev1] }))
        .resolves.toMatchObject({ revisionId: "revision-2" });
    });
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
      stage: "publishing",
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
    expect(result.steps[1]).toMatchObject({
      code: "image_assets",
      state: "current",
    });
  });

  it("uses a live portrait to establish identity instead of starting from zero", () => {
    const result = journey({
      hasVisualProfile: false,
      servingState: "live",
      currentReleaseId: "release-live",
      livePurposes: ["character_cover"],
    });
    expect(result).toMatchObject({
      stage: "visual_setup",
      primaryAction: { code: "prepare_image_production" },
      release: { servingState: "live", currentReleaseId: "release-live" },
    });
    expect(result.steps[0]).toMatchObject({
      code: "visual_identity",
      deepLink: "/admin/characters/character-1?tab=assets",
    });
  });

  it("blocks on the earliest missing visual authority before active image work", () => {
    const result = journey({ referenceCount: 0, hasActiveImageRun: true });
    expect(result.primaryAction).toMatchObject({
      code: "complete_image_route",
      deepLink: "/admin/characters/character-1?tab=visual#visual-reference-set",
    });
    expect(result.steps[0]).toMatchObject({
      code: "visual_identity",
      state: "blocked",
    });
    expect(result.steps[0].deepLink).toBe(
      "/admin/characters/character-1?tab=visual",
    );
  });

  it("continues the active run before selecting another missing purpose", () => {
    expect(journey({ hasActiveImageRun: true }).primaryAction.code).toBe(
      "continue_image_run",
    );
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
      assetPack: {
        live: {
          completed: 1,
          missingPurposes: ["character_hero", "character_chat"],
        },
      },
      release: { servingState: "live", currentReleaseId: "release-live" },
    });
    expect(result.steps).toMatchObject([
      { code: "visual_identity", state: "complete" },
      { code: "image_assets", state: "current" },
      { code: "preview", state: "complete" },
      { code: "release", state: "complete" },
      { code: "live_monitor", state: "complete" },
    ]);
  });

  it("moves a completed draft through Release review, then monitors an unchanged live pack", () => {
    expect(
      journey({
        draftPurposes: allPurposes,
        candidateReleaseId: "release-candidate",
      }).primaryAction.code,
    ).toBe("publish_character");
    expect(
      journey({
        servingState: "live",
        currentReleaseId: "release-live",
        livePurposes: allPurposes,
      }),
    ).toMatchObject({
      stage: "live_operations",
      status: "live",
      primaryAction: { code: "monitor_live_character" },
    });
  });

  it("takes a complete image pack directly to preview without manual review", () => {
    expect(
      journey({
        draftPurposes: allPurposes,
        draftPurposesNeedingReview: ["character_cover", "character_hero"],
      }),
    ).toMatchObject({
      stage: "preview",
      status: "ready",
      primaryAction: { code: "preview_character", deepLink: "/admin/characters/character-1?tab=preview" },
      blockers: [],
    });
  });

  it("keeps an active image run ahead of reviewing the previous selected pack", () => {
    expect(
      journey({
        draftPurposes: allPurposes,
        draftPurposesNeedingReview: ["character_cover"],
        hasActiveImageRun: true,
      }).primaryAction.code,
    ).toBe("continue_image_run");
  });
});
