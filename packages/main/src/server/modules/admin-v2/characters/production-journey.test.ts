import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  imageRunIssueFromItems,
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
        characterContentVersion: { findMany: findMany([]) },
      } as unknown as PrismaClient;
      const result = await projectCharacterProductionJourneys(
        db,
        ids,
        new Date("2026-07-31T12:00:00.000Z"),
      );
      return { queries, size: result.size };
    };
    await expect(run(1)).resolves.toEqual({ queries: 9, size: 1 });
    await expect(run(25)).resolves.toEqual({ queries: 9, size: 25 });
  });

  // SPEC: 已上线角色的项目里出现比线上 Release 更新的 Revision（创作者改了已发布角色），
  //       运营要看到「有待发布的修订」并能直接去发布页。
  describe("pending Revision signal", () => {
    async function project(input: {
      releaseRevisionId: string;
      releaseCreatedAt?: Date;
      revisions: Array<{ id: string; revision: number; createdAt: Date }>;
      otherReleases?: Array<{ id: string; revisionId: string; status: string; publishedAt: Date | null }>;
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
          publishedAt: input.releaseCreatedAt ?? new Date("2026-09-01T00:00:00.000Z"),
        }, ...(input.otherReleases ?? []).map((release) => ({
          ...release, projectId: "project-1", releasePlacementManifest: {}, createdAt: new Date("2026-09-10T00:00:00.000Z"),
        }))] },
        characterRevision: { findMany: async () => input.revisions.map((revision) => ({ ...revision, projectId: "project-1" })) },
        characterContentVersion: { findMany: async () => [] },
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

    // SPEC: 回滚到旧 Release 后，被回滚掉的 Revision 是运营的决定，不算待发布。
    it("stays quiet after a rollback away from a Revision that already went live", async () => {
      await expect(project({
        releaseRevisionId: rev1.id,
        revisions: [rev2, rev1],
        otherReleases: [{ id: "release-rolled-back", revisionId: rev2.id, status: "superseded", publishedAt: new Date("2026-09-21T00:00:00.000Z") }],
      })).resolves.toBeNull();
    });

    it("still flags a Revision whose Release was prepared but never went live", async () => {
      await expect(project({
        releaseRevisionId: rev1.id,
        revisions: [rev2, rev1],
        otherReleases: [{ id: "release-withdrawn", revisionId: rev2.id, status: "withdrawn", publishedAt: null }],
      })).resolves.toMatchObject({ revisionId: "revision-2" });
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

  it("monitors a live Character whose draft pack still equals the published pack", () => {
    // Publishing does not clear the draft pack; the live card must not send the operator back to Preview.
    const live = {
      servingState: "live" as const,
      currentReleaseId: "release-live",
      livePurposes: allPurposes,
      draftPurposes: allPurposes,
    };
    expect(journey({ ...live, draftPackMatchesLive: true }).primaryAction.code)
      .toBe("monitor_live_character");
    expect(journey({ ...live, servingState: "paused", draftPackMatchesLive: true }).primaryAction.code)
      .toBe("monitor_live_character");
    expect(journey({ ...live, draftPackMatchesLive: false }).primaryAction.code)
      .toBe("preview_character");
    expect(journey({
      servingState: "live",
      currentReleaseId: "release-live",
      livePurposes: allPurposes,
      pendingRevision: { id: "revision-2", revision: 2, createdAt: new Date("2026-10-01T00:00:00Z") },
    }).primaryAction.code).toBe("preview_character");
    expect(journey({
      ...live,
      draftPackMatchesLive: true,
      pendingRevision: { id: "revision-2", revision: 2, createdAt: new Date("2026-10-01T00:00:00Z") },
    }).primaryAction.code).toBe("preview_character");
  });

  // SPEC: 暂停的角色保留 Release。空草稿不是「该补图」，而是和线上一样只剩恢复或继续隐藏的决定。
  it("does not send a paused Character with an empty draft back to filling images", () => {
    expect(
      journey({ servingState: "paused", currentReleaseId: "release-1", livePurposes: allPurposes }).primaryAction.code,
    ).toBe("monitor_live_character");
    // 线上包本身不齐时才补图。
    expect(
      journey({ servingState: "paused", currentReleaseId: "release-1", livePurposes: ["character_cover"] }).primaryAction.code,
    ).toBe("continue_asset_pack");
  });

  // SPEC: 路线不合格是平台问题。把运营带到角色页的只读路线区，他在那里什么也做不了。
  it("sends an unqualified route to platform operations instead of the read-only route section", () => {
    const blocked = journey({ routeQualified: false });
    expect(blocked.status).toBe("blocked");
    expect(blocked.primaryAction).toMatchObject({
      code: "platform_route_unavailable",
      deepLink: "/admin/ops/profiles",
    });
    expect(blocked.blockers[0]).toMatchObject({
      code: "generation_route_unqualified",
      deepLink: "/admin/ops/profiles",
    });
    expect(blocked.blockers[0].message).toContain("platform");
    // 缺参考集是运营能修的，留在角色页。
    expect(journey({ referenceCount: 0 }).primaryAction).toMatchObject({
      code: "complete_image_route",
      deepLink: "/admin/characters/character-1?tab=visual#visual-reference-set",
    });
  });

  it("keeps a healthy live Character quiet even if its route later lost qualification", () => {
    expect(
      journey({
        routeQualified: false,
        servingState: "live",
        currentReleaseId: "release-1",
        livePurposes: allPurposes,
      }),
    ).toMatchObject({ status: "live", blockers: [], primaryAction: { code: "monitor_live_character" } });
    // 有活要干时才拦。
    expect(
      journey({
        routeQualified: false,
        servingState: "live",
        currentReleaseId: "release-1",
        livePurposes: allPurposes,
        pendingRevision: { id: "revision-2", revision: 2, createdAt: new Date("2026-10-01T00:00:00Z") },
      }).primaryAction.code,
    ).toBe("platform_route_unavailable");
  });

  // SPEC: Journey 曾只看 queued/running：失败的 Run 被说成「继续补图」，未知结局被说成「继续当前图片」。
  it("gives a failed or unknown image Run its own next step", () => {
    expect(journey({ imageRunIssue: "failed" })).toMatchObject({
      status: "in_progress",
      primaryAction: { code: "retry_failed_image_run", deepLink: "/admin/characters/character-1?tab=assets" },
      blockers: [{ code: "image_run_failed" }],
    });
    // 未知结局排在进行中之前：Job 可能永远停在 running，再生成又可能重复扣费。
    expect(journey({ imageRunIssue: "unknown", hasActiveImageRun: true })).toMatchObject({
      status: "blocked",
      primaryAction: { code: "resolve_unknown_image_run" },
      blockers: [{ code: "image_run_outcome_unknown" }],
    });
    // 进行中的下一轮优先于上一轮的失败。
    expect(journey({ imageRunIssue: "failed", hasActiveImageRun: true }).primaryAction.code).toBe("continue_image_run");
    // 健康线上角色不因历史失败被制造待办。
    expect(
      journey({
        imageRunIssue: "failed",
        servingState: "live",
        currentReleaseId: "release-1",
        livePurposes: allPurposes,
      }).primaryAction.code,
    ).toBe("monitor_live_character");
  });

  it("classifies a Run by its item outcomes", () => {
    const item = { status: "queued", mediaAssetId: null, jobStatus: "running", jobErrorCode: null, attemptUnknown: false };
    expect(imageRunIssueFromItems([])).toBeNull();
    expect(imageRunIssueFromItems([item])).toBeNull();
    expect(imageRunIssueFromItems([{ ...item, status: "failed", jobStatus: "failed" }])).toBe("failed");
    expect(imageRunIssueFromItems([{ ...item, attemptUnknown: true }])).toBe("unknown");
    expect(imageRunIssueFromItems([{ ...item, attemptUnknown: true }, { ...item, mediaAssetId: "asset-1", status: "generated" }])).toBeNull();
    expect(imageRunIssueFromItems([{ ...item, status: "failed", jobStatus: "failed" }, item])).toBeNull();
  });

  it("takes a complete image pack directly to preview without manual review", () => {
    expect(
      journey({
        draftPurposes: allPurposes,
      }),
    ).toMatchObject({
      stage: "preview",
      status: "ready",
      primaryAction: { code: "preview_character", deepLink: "/admin/characters/character-1?tab=preview" },
      blockers: [],
    });
  });

  // SPEC: Release refuses a draft whose Soul is unreadable, in an old format, or has no
  // opening; the card and header must say so instead of "Ready to preview".
  it("sends a complete pack with a blocked Soul to the persona editor, not Preview", () => {
    expect(journey({ draftPurposes: allPurposes, soulBlocker: "soul_release_policy" })).toMatchObject({
      stage: "preview",
      status: "blocked",
      primaryAction: { code: "repair_character_soul", deepLink: "/admin/characters/character-1?tab=soul" },
      blockers: [{ code: "soul_release_policy", deepLink: "/admin/characters/character-1?tab=soul" }],
    });
    // Image work still comes first; a live unchanged Character keeps monitoring.
    expect(journey({ draftPurposes: ["character_cover"], soulBlocker: "opening_complete" }).primaryAction.code)
      .toBe("continue_asset_pack");
  });

  it("keeps an active image run ahead of reviewing the previous selected pack", () => {
    expect(
      journey({
        draftPurposes: allPurposes,
        hasActiveImageRun: true,
      }).primaryAction.code,
    ).toBe("continue_image_run");
  });
});
