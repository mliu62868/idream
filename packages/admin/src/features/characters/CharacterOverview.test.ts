import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { describe, expect, it } from "vitest";
import { characterWorkspaceDetail } from "./character-workspace-fixture";
import {
  characterNotLiveReasons,
  characterRecentAssets,
  characterVideoSourceBroken,
} from "./CharacterOverview";

function workspace(overrides: {
  bootstrap?: boolean;
  repairable?: boolean;
  ready?: boolean;
  missingPurposes?: string[];
  servingState?: string | null;
  changedFields?: string[];
  publishedRelease?: boolean;
  pendingRevision?: { revision: number; createdAt: string };
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
      draftAssetRouteAuthority: {
        missingPurposes: overrides.missingPurposes ?? [],
      },
    },
    journey: {
      release: {
        servingState: overrides.servingState ?? "inactive",
        currentReleaseId: overrides.servingState ? releaseId : null,
        pendingRevision: overrides.pendingRevision ?? null,
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


  // SPEC: 「为什么没上线」一屏回答，带修复入口。
  it("explains why a Character is not live with fix links", () => {
    const blocker = { code: "generation_route_unqualified", message: "Route problem", deepLink: "/admin/ops/profiles" };
    const blocked = characterWorkspaceDetail({ journey: { blockers: [blocker] } });
    expect(characterNotLiveReasons(blocked)).toEqual([
      { message: "Not published yet.", href: null },
      { message: "Route problem", href: "/admin/ops/profiles" },
    ]);
    const paused = characterWorkspaceDetail({ serving: { state: "paused" } });
    expect(characterNotLiveReasons(paused)[0]).toEqual({
      message: "Paused. Customers cannot open this character until it is resumed.",
      href: "/admin/characters/character-fixture?tab=release",
    });
    expect(characterNotLiveReasons(characterWorkspaceDetail({ serving: { state: "live" } }))).toEqual([]);
  });
});
