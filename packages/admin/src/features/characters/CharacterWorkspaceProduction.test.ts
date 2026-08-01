import { readFileSync } from "node:fs";
import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { describe, expect, it } from "vitest";
import {
  characterNoDataDiagnosis,
  characterOperationsFacts,
  characterRecentAssets,
  characterVideoSourceBroken,
  characterVisualReadinessTarget,
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

  it("routes a blocked visual step to the earliest executable control", () => {
    expect(characterVisualReadinessTarget([
      "generation_route_unqualified",
      "reference_set_not_active",
      "visual_identity_unsealed",
    ])).toBe("visual-identity-version");
    expect(characterVisualReadinessTarget([
      "generation_route_unqualified",
      "reference_set_not_active",
    ])).toBe("visual-reference-set");
    expect(characterVisualReadinessTarget([
      "generation_route_unqualified",
    ])).toBe("route-qualification-workbench");
    expect(characterVisualReadinessTarget([
      "visual_anchor_missing",
    ])).toBeNull();
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
    expect(factValue(live, "Live release")).toMatchObject({ value: "v1 · 2026-07-24" });
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
});
