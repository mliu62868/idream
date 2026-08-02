import { readFileSync } from "node:fs";
import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { describe, expect, it } from "vitest";
import {
  characterNoDataDiagnosis,
  characterOperationsFacts,
  characterReleaseOrdinals,
  characterRecentAssets,
  characterVideoSourceBroken,
  characterVisualBlockerHref,
  characterWorkspaceTabLabel,
} from "./CharacterWorkspace";

const workspaceSource = readFileSync(
  new URL("./CharacterWorkspace.tsx", import.meta.url),
  "utf8",
);

function workspace(overrides: {
  bootstrap?: boolean;
  repairable?: boolean;
  ready?: boolean;
  missingPurposes?: string[];
  servingState?: string | null;
  changedFields?: string[];
  ownerId?: string | null;
  publishedRelease?: boolean;
  anchors?: { mediaAssetId: string; available: boolean }[];
  references?: { mediaAssetId: string; available: boolean }[];
  videoSources?: { mediaAssetId: string; available: boolean }[];
}): CharacterWorkspaceDetail {
  const releaseId = "editorial-release:alexa-reeves:a5c8ca4f";
  const purposes = ["character_cover", "character_hero", "character_chat"];
  const missingPurposes = overrides.missingPurposes ?? [];
  const availablePurposes = purposes.filter((purpose) => !missingPurposes.includes(purpose));
  return {
    character: {
      id: "alexa-reeves",
      name: "Alexa Reeves",
      visibility: "public",
      imageUrl: overrides.repairable ? "/alexa.webp" : null,
    },
    project: {
      ownerId: overrides.ownerId ?? null,
      draftAssetRouteAuthority: {
        missingPurposes: overrides.missingPurposes ?? [],
      },
    },
    journey: {
      release: {
        servingState: overrides.servingState ?? "inactive",
        currentReleaseId: overrides.servingState ? releaseId : null,
      },
      assetPack: {
        draft: { availablePurposes, completed: availablePurposes.length, total: 3 },
        live: { availablePurposes, completed: availablePurposes.length, total: 3 },
      },
    },
    visual: {
      identityBootstrap: { allowed: overrides.bootstrap ?? false },
      readiness: { ready: overrides.ready ?? true },
      // anchors 与 references 故意留一张重叠（shared-1），用来盯住去重。
      anchors: overrides.anchors ?? [
        { mediaAssetId: "shared-1", available: true },
        { mediaAssetId: "anchor-2", available: true },
      ],
      references: overrides.references ?? [
        { mediaAssetId: "shared-1", available: true },
        { mediaAssetId: "reference-hidden", available: false },
      ],
      videoSources: overrides.videoSources ?? [
        { mediaAssetId: "shared-1", available: true },
      ],
      imageReadiness: overrides.repairable
        ? { state: "repairable", repair: { kind: "adopt_live_portrait" } }
        : null,
    },
    serving: overrides.servingState
      ? { state: overrides.servingState, currentReleaseId: releaseId }
      : null,
    preview: { changedFields: overrides.changedFields ?? [] },
    releases: overrides.publishedRelease
      ? [{
          release: {
            id: releaseId,
            version: 1,
            publishedAt: "2026-07-24T00:40:28.926Z",
            createdAt: "2026-07-23T00:00:00.000Z",
          },
        }]
      : [],
  } as unknown as CharacterWorkspaceDetail;
}

function factValue(data: CharacterWorkspaceDetail, label: string) {
  return characterOperationsFacts(data).find((fact) => fact.label === label);
}

describe("Character production entry", () => {
  it("flags a live character whose primary image cannot serve image-to-video", () => {
    expect(characterVideoSourceBroken(workspace({ servingState: "live" }))).toBe(true);
  });

  it("stays quiet when the live character has a usable primary image", () => {
    expect(characterVideoSourceBroken(workspace({ servingState: "live", repairable: true })))
      .toBe(false);
  });

  it("stays quiet before launch — a missing portrait is already the current production step", () => {
    expect(characterVideoSourceBroken(workspace({ servingState: null }))).toBe(false);
  });

  it("uses operator-facing tab labels instead of raw route keys", () => {
    expect(characterWorkspaceTabLabel("project")).toBe("Details");
    expect(characterWorkspaceTabLabel("assets")).toBe("Images");
    expect(characterWorkspaceTabLabel("video")).toBe("Video");
    expect(characterWorkspaceTabLabel("voice")).toBe("Voice");
    expect(characterWorkspaceTabLabel("preview")).toBe("Launch preview");
  });

  it("replaces the clipped mobile tab strip with one complete page selector", () => {
    expect(workspaceSource).toContain('aria-label={t("Workspace page")}');
    expect(workspaceSource).toContain('className="mt-4 block sm:hidden"');
    expect(workspaceSource).toContain(
      'className="mt-4 hidden gap-1 overflow-x-auto border-b border-[var(--ad-border)] sm:flex"',
    );
  });

  it("separates the live release, candidate, and collapsed history", () => {
    expect(workspaceSource).toContain('t("Current live release")');
    expect(workspaceSource).toContain('t("Release candidate")');
    expect(workspaceSource).toContain('t("Release history")');
    expect(workspaceSource).toContain('const historical = ["superseded", "withdrawn"]');
  });

  // SPEC: 阻塞入口要落到能完成动作的控件，且服务端下发的 deepLink 是权威。
  // INTENT: 前端曾自建 identity→references→route 优先级阶梯，用它覆盖掉 blocker.deepLink。
  // 优先级本来就是服务端 blockers 的下发顺序；前端只补服务端不知道的页内锚点（DOM id）。
  it("keeps the server deep link and only adds the in-page anchor it owns", () => {
    expect(characterVisualBlockerHref({
      code: "visual_identity_unsealed",
      deepLink: "/admin/characters/c1?tab=visual",
    })).toBe("/admin/characters/c1?tab=visual#visual-identity-version");
    expect(characterVisualBlockerHref({
      code: "reference_set_not_active",
      deepLink: "/admin/characters/c1?tab=visual",
    })).toBe("/admin/characters/c1?tab=visual#visual-reference-set");
  });

  it("passes a server deep link that already targets a control through untouched", () => {
    expect(characterVisualBlockerHref({
      code: "generation_route_unqualified",
      deepLink: "/admin/characters/c1?tab=visual#route-qualification-workbench",
    })).toBe("/admin/characters/c1?tab=visual#route-qualification-workbench");
    expect(characterVisualBlockerHref({
      code: "visual_anchor_missing",
      deepLink: "/admin/characters/c1?tab=visual",
    })).toBe("/admin/characters/c1?tab=visual");
  });
});

describe("Character detail assets", () => {
  it("deduplicates factual recent images without inventing placeholders", () => {
    const data = {
      character: { id: "character-1", imageUrl: "/primary.webp" },
      visual: {
        anchors: [
          { mediaAssetId: "anchor-1", available: true, url: "/primary.webp", thumbnailUrl: null },
          { mediaAssetId: "anchor-2", available: true, url: "/anchor.webp", thumbnailUrl: "/anchor-thumb.webp" },
        ],
        references: [
          { mediaAssetId: "reference-1", available: false, url: "/hidden.webp", thumbnailUrl: null },
          { mediaAssetId: "reference-2", available: true, url: "/reference.webp", thumbnailUrl: null },
        ],
      },
    } as unknown as CharacterWorkspaceDetail;

    expect(characterRecentAssets(data)).toEqual([
      { id: "character-1:primary", url: "/primary.webp" },
      { id: "anchor-2", url: "/anchor-thumb.webp" },
      { id: "reference-2", url: "/reference.webp" },
    ]);
  });
});

// SPEC: 工作台顶部必须直接说清角色线上状态；以前只有折叠的「技术状态」，运营开页看不出
// 一个 live 角色和一个草稿角色的区别。
describe("Character operations facts", () => {
  it("states the live serving posture instead of hiding it behind technical status", () => {
    const live = workspace({
      servingState: "live",
      publishedRelease: true,
      missingPurposes: ["character_hero", "character_chat"],
      changedFields: ["imageUrl", "assetPack"],
    });
    expect(factValue(live, "Serving")).toMatchObject({ value: "live", alert: false });
    // 按发布时间的序号，不是行级锁版本号（发布页显示的也是这个）。
    expect(factValue(live, "Live release")).toMatchObject({ value: "#1 · 2026-07-24" });
    expect(factValue(live, "Unpublished changes")).toMatchObject({ value: "2", alert: true });
    expect(factValue(live, "Image pack")).toMatchObject({ value: "1/3", alert: true });
    expect(factValue(live, "Owner")).toMatchObject({ value: "Unassigned", alert: true });
  });

  // SPEC: 零观测要给运营一个动作，不是一个状态。窗口没走完 = 等；窗口走完了还是零 = 查投放。
  it("turns zero observations into either wait or investigate", () => {
    expect(characterNoDataDiagnosis({
      qualityState: "no_data", maturity: "immature", window: "7d",
    })).toMatchObject({ alert: false });
    expect(characterNoDataDiagnosis({
      qualityState: "no_data", maturity: "insufficient_data", window: "7d",
    })).toMatchObject({ alert: true });
  });

  it("stays silent when the metric is not a no-data metric", () => {
    expect(characterNoDataDiagnosis({
      qualityState: "invalid", maturity: "insufficient_data", window: "7d",
    })).toBeNull();
    expect(characterNoDataDiagnosis({
      qualityState: "certified", maturity: "mature", window: "28d",
    })).toBeNull();
  });

  it("flags an unpublished character on serving and release instead of showing a blank", () => {
    const draft = workspace({ servingState: null, ownerId: "ops-anna" });
    expect(factValue(draft, "Serving")).toMatchObject({ value: "not_live", alert: true });
    expect(factValue(draft, "Live release")).toMatchObject({ value: "None published", alert: true });
    expect(factValue(draft, "Unpublished changes")).toMatchObject({ value: "None", alert: false });
    expect(factValue(draft, "Image pack")).toMatchObject({ value: "3/3", alert: false });
    expect(factValue(draft, "Owner")).toMatchObject({ value: "ops-anna", alert: false });
  });

  // SPEC: 发布序号按发布时间单调递增。
  // INTENT: CharacterRelease.version 是行级乐观锁计数，曾被当成发布号渲染，导致
  // "v2 比 v1 更早发布" —— 回滚下拉里读起来像回滚到更新的版本。
  it("numbers releases by publish time, not by the row lock version", () => {
    const ordinals = characterReleaseOrdinals([
      { release: { id: "live", publishedAt: "2026-07-24T00:40:28.924Z", createdAt: "2026-07-24T00:40:28.924Z" } },
      { release: { id: "older", publishedAt: "2026-07-20T04:13:28.650Z", createdAt: "2026-07-20T04:13:28.650Z" } },
    ]);
    expect(ordinals.get("older")).toBe(1);
    expect(ordinals.get("live")).toBe(2);
  });

  // SPEC: 还没发布的候选版本用 createdAt 排，不能因为 publishedAt 为 null 就掉到最前面。
  it("falls back to createdAt for releases that were never published", () => {
    const ordinals = characterReleaseOrdinals([
      { release: { id: "candidate", publishedAt: null, createdAt: "2026-07-28T00:00:00.000Z" } },
      { release: { id: "published", publishedAt: "2026-07-24T00:00:00.000Z", createdAt: "2026-07-01T00:00:00.000Z" } },
    ]);
    expect(ordinals.get("published")).toBe(1);
    expect(ordinals.get("candidate")).toBe(2);
  });

  // SPEC: 身份图片按资产 ID 去重；"视频源图片"数的是图片，不是视频。
  // INTENT: 原先 anchors + references 直接相加，重叠的图被数两次（真实角色 15 张显示成 16）；
  // 而 visual.videoSources 服务端就是一条 type:"image" 查询，却被标成 "Videos" —— 于是
  // "视频 15" 实际是 15 张图片，该角色只有 1 个视频。
  it("counts identity images once and never calls source images videos", () => {
    const detail = workspace({});
    // shared-1 同时在 anchors 和 references 里，available 的去重后是 shared-1 + anchor-2。
    expect(factValue(detail, "Identity images")).toMatchObject({ value: "2", alert: false });
    expect(factValue(detail, "Video source images")).toMatchObject({ value: "1", alert: false });
    expect(characterOperationsFacts(detail).some((fact) => fact.label === "Videos")).toBe(false);
  });

  it("flags a character that has no usable identity image or video source", () => {
    const empty = workspace({ anchors: [], references: [], videoSources: [] });
    expect(factValue(empty, "Identity images")).toMatchObject({ value: "0", alert: true });
    expect(factValue(empty, "Video source images")).toMatchObject({ value: "0", alert: true });
  });

  // SPEC: 详情页的线上版本标签必须和发布页一致。
  // INTENT: 两处都曾渲染行级锁版本 release.version，修发布页时漏了这里，
  // 结果详情页写 v1、发布页写 #2，同一个版本两种叫法。
  it("labels the live release with the same ordinal the Release tab shows", () => {
    const detail = workspace({ publishedRelease: true, servingState: "live" });
    const ordinal = characterReleaseOrdinals(detail.releases).get(
      detail.serving?.currentReleaseId ?? "",
    );
    expect(factValue(detail, "Live release")?.value).toContain(`#${ordinal}`);
  });
});
