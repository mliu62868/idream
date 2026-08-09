import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { describe, expect, it } from "vitest";
import { characterWorkspaceDetail } from "./character-workspace-fixture";
import { characterReleaseOrdinals } from "./character-workspace-format";
import {
  characterOperationsFacts,
  characterRecentAssets,
  characterVideoSourceBroken,
} from "./ProjectEditor";

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

type VisualAsset = CharacterWorkspaceDetail["visual"]["anchors"][number];

// SPEC: 一条完整的视觉素材投影；各用例只覆盖自己关心的字段。
// INTENT: anchors / references 是数组，覆盖时整条替换，缺字段会被契约挡下。
function visualAsset(overrides: Partial<VisualAsset> = {}): VisualAsset {
  return {
    mediaAssetId: "visual-asset",
    role: "identity_anchor",
    available: true,
    url: "/visual-asset.webp",
    thumbnailUrl: null,
    qualityScore: null,
    identityScore: null,
    ...overrides,
  };
}

// SPEC: 工作台顶部必须直接说清角色线上状态；以前只有折叠的「技术状态」，运营开页看不出
// 一个 live 角色和一个草稿角色的区别。
describe("Character detail facts", () => {
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


  it("deduplicates factual recent images without inventing placeholders", () => {
    const data = characterWorkspaceDetail({
      character: { id: "character-1", imageUrl: "/primary.webp" },
      visual: {
        anchors: [
          visualAsset({ mediaAssetId: "anchor-1", url: "/primary.webp" }),
          visualAsset({
            mediaAssetId: "anchor-2",
            url: "/anchor.webp",
            thumbnailUrl: "/anchor-thumb.webp",
          }),
        ],
        references: [
          visualAsset({
            mediaAssetId: "reference-1",
            role: "identity_reference",
            available: false,
            url: "/hidden.webp",
          }),
          visualAsset({
            mediaAssetId: "reference-2",
            role: "identity_reference",
            url: "/reference.webp",
          }),
        ],
      },
    });

    expect(characterRecentAssets(data)).toEqual([
      { id: "character-1:primary", url: "/primary.webp" },
      { id: "anchor-2", url: "/anchor-thumb.webp" },
      { id: "reference-2", url: "/reference.webp" },
    ]);
  });


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


  it("flags an unpublished character on serving and release instead of showing a blank", () => {
    const draft = workspace({ servingState: null, ownerId: "ops-anna" });
    expect(factValue(draft, "Serving")).toMatchObject({ value: "not_live", alert: true });
    expect(factValue(draft, "Live release")).toMatchObject({ value: "None published", alert: true });
    expect(factValue(draft, "Unpublished changes")).toMatchObject({ value: "None", alert: false });
    expect(factValue(draft, "Image pack")).toMatchObject({ value: "3/3", alert: false });
    expect(factValue(draft, "Owner")).toMatchObject({ value: "ops-anna", alert: false });
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
