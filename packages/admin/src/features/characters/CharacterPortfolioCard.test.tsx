import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CharacterPortfolioItem } from "@idream/shared/admin";
import { translateAdmin } from "@/components/admin/i18n";
import {
  CharacterPortfolioCard,
  characterReleasePackLabel,
  characterPortfolioState,
} from "./CharacterPortfolioCard";

function journey(
  code: CharacterPortfolioItem["journey"]["primaryAction"]["code"],
  stage: CharacterPortfolioItem["journey"]["stage"],
  deepLink: string,
): CharacterPortfolioItem["journey"] {
  const stateFor = (stepStage: CharacterPortfolioItem["journey"]["stage"]) =>
    stepStage === stage ? ("current" as const) : ("upcoming" as const);
  return {
    projectionVersion: 1,
    asOf: "2026-07-31T12:00:00.000Z",
    stage,
    status: stage === "live_operations" ? "live" : "in_progress",
    steps: [
      {
        code: "visual_identity",
        state: "complete",
        deepLink: "/admin/characters/character-1?tab=visual",
      },
      {
        code: "image_assets",
        state: stateFor("image_production"),
        deepLink: "/admin/characters/character-1?tab=assets",
      },
      {
        code: "preview",
        state: stateFor("preview"),
        deepLink: "/admin/characters/character-1?tab=release",
      },
      {
        code: "release",
        state: "complete",
        deepLink: "/admin/characters/character-1?tab=release",
      },
      {
        code: "live_monitor",
        state: stateFor("live_operations"),
        deepLink: "/admin/characters/character-1?tab=monitor",
      },
    ],
    blockers: [],
    primaryAction: { code, deepLink, command: null, readOperations: ["GET /api/v2/admin/characters/:id"], canReadTarget: true },
    hasActiveCommand: false,
    assetPack: {
      generateMissingBlocker: null,
      generateMissingPurposes: ["character_hero", "character_chat"],
      draft: {
        availablePurposes: ["character_cover"],
        missingPurposes: ["character_hero", "character_chat"],
        completed: 1,
        total: 3,
      },
      live: {
        availablePurposes: ["character_cover", "character_hero"],
        missingPurposes: ["character_chat"],
        completed: 2,
        total: 3,
      },
    },
    release: {
      servingState: "live",
      currentReleaseId: "release-1",
      candidateReleaseId: null,
      pendingRevision: null,
    },
  };
}

describe("Character Portfolio card", () => {
  const item = {
    characterId: "character-1",
    name: "Mara",
    needsAttention: false,
    serving: { state: "live" },
    readiness: "ready",
    visualProduction: {
      primaryImageUrl: "/media/mara.webp",
      primaryImageSource: "live",
      draftPurposes: ["character_cover"],
      livePurposes: ["character_cover", "character_hero"],
      totalPurposes: 3,
      deepLink: "/admin/characters/character-1?tab=assets",
    },
    performance: [
      {
        window: "28d",
        placementId: null,
        maturity: "mature",
        qceRate: 0.75,
        sameCharacterD7: null,
      },
    ],
    operationalState: {
      blockers: [],
    },
    journey: journey(
      "complete_live_asset_pack",
      "image_production",
      "/admin/characters/character-1?tab=assets",
    ),
  } as unknown as CharacterPortfolioItem;

  it("keeps portfolio evidence out of the primary Character workspace", () => {
    const studio = renderToStaticMarkup(
      <CharacterPortfolioCard
        canOpenAssets
        canOpenProject
        item={item}
      />,
    );
    expect(studio).toContain("Mara");
    expect(studio).not.toContain("28d QCE");
    expect(studio).not.toContain("Latest decision:");
    expect(studio).toContain("Live");
    expect(studio).not.toContain("Complete Character Assets");
  });

  it("shows the projected recovery action for an archived draft", () => {
    const archived = {
      ...item,
      serving: { ...item.serving, state: "retired" as const, currentReleaseId: null },
      journey: { ...journey("restore_archived_draft", "visual_setup", "/admin/characters/character-1?tab=release"), status: "blocked" as const },
    };
    expect(characterPortfolioState(archived).label).toBe("Archived");
    const html = renderToStaticMarkup(<CharacterPortfolioCard canOpenAssets={false} canOpenProject item={archived} />);
    expect(html).toContain("Archived");
    expect(html).toContain("Restore draft");
    expect(html).not.toContain("Create first identity portrait");
  });

  it("keeps retired published and paused characters distinct from a live production journey", () => {
    const retired = { ...item, serving: { ...item.serving, state: "retired" as const, currentReleaseId: "release-1" } };
    expect(characterPortfolioState(retired).label).toBe("Retired");
    const paused = { ...item, serving: { ...item.serving, state: "paused" as const }, journey: journey("monitor_live_character", "live_operations", "/admin/characters/character-1?tab=monitor") };
    expect(characterPortfolioState(paused).label).toBe("Paused");
  });

  it("keeps long Character names readable instead of visually truncating them", () => {
    const longName = "E2E Admin Operations Character With A Deliberately Long Name";
    const html = renderToStaticMarkup(
      <CharacterPortfolioCard
        canOpenAssets
        canOpenProject
        item={{ ...item, name: longName }}
      />,
    );
    expect(html).toContain(`title="${longName}"`);
    expect(html).not.toContain(
      'class="truncate text-base font-semibold text-[var(--ad-ink)]"',
    );
  });

  it.each([
    ["prepare_image_production", "assets", "Use existing portrait"],
    ["prepare_pending_release", "release", "Prepare release"],
    ["continue_image_run", "assets", "Continue current image"],
    ["monitor_live_character", "monitor", "No action needed"],
    ["inspect_performance_quality", "monitor", "Inspect performance quality"],
    ["review_release_monitor", "monitor", "Review monitor evidence"],
    ["inspect_no_traffic", "monitor", "Inspect live monitoring"],
    ["republish_stale_release", "release", "Publish again"],
    ["republish_legacy_release", "release", "Publish a checked Release"],
    ["review_retired_character", "release", "Review retired character"],
    ["review_paused_character", "release", "Review paused character"],
    ["retry_failed_image_run", "assets", "Generate again"],
    ["resolve_unknown_image_run", "assets", "Check image Run"],
  ] as const)("renders the projected action %s", (code, tab, label) => {
    const deepLink = "/admin/characters/character-1?tab=" + tab;
    const html = renderToStaticMarkup(<CharacterPortfolioCard canOpenAssets canOpenProject
      item={{ ...item, journey: journey(code, "live_operations", deepLink) }} />);
    expect(html).toContain(label);
    expect(html).toContain('href="' + deepLink + '"');
  });

  it("localizes the operational labels", () => {
    expect(translateAdmin("zh", "Unpublished revision")).toBe("有待发布的修订");
    expect(translateAdmin("zh", "Performance data invalid")).not.toBe("Performance data invalid");
    expect(translateAdmin("zh", "Inspect performance quality")).not.toBe("Inspect performance quality");
  });

  it("offers Profiles & Rollout when that target is readable without Character detail access", () => {
    const html = renderToStaticMarkup(<CharacterPortfolioCard canOpenAssets={false} canOpenProject={false}
      item={{ ...item, journey: journey("platform_route_unavailable", "visual_setup", "/admin/ops/profiles") }} />);
    expect(html).toContain("Open Profiles &amp; Rollout");
    expect(html).toContain('href="/admin/ops/profiles"');
    expect(html).not.toContain('href="/admin/characters/character-1"');
  });

  // SPEC: 列表卡只回答四件事：是谁、当前状态、素材事实、下一步去哪里。
  // INTENT: blocker 详情留在角色内处理；堆进卡片会把角色列表重新变成流程审查面板。
  it("puts one next action and asset facts on the roster tile", () => {
    const blocked = {
      ...item,
      journey: {
        ...item.journey,
        blockers: [
          {
            code: "assets_incomplete",
            message: "Draft image pack is missing 2 images",
            deepLink: "/admin/characters/character-1?tab=assets",
          },
          {
            code: "preview_stale",
            message: "Launch preview is stale",
            deepLink: "/admin/characters/character-1?tab=release",
          },
        ],
      },
    } as CharacterPortfolioItem;
    const html = renderToStaticMarkup(
      <CharacterPortfolioCard
        canOpenAssets
        canOpenProject
        item={blocked}
      />,
    );

    expect(characterPortfolioState(item)).toMatchObject({ label: "Live" });
    expect(html).toContain('data-layout="roster"');
    expect(html).toContain('href="/admin/characters/character-1"');
    expect(html).toContain("Complete image pack");
    expect(html).toContain('href="/admin/characters/character-1?tab=assets"');
    expect(html).not.toContain("Draft image pack is missing 2 images");
    expect(html).not.toContain("Image pack in progress");
    expect(html).not.toContain("operator-ana");
    expect(html).toContain("Draft 1/3");
    expect(html).toContain("Live 2/3");
    expect(html.match(/href=/g)).toHaveLength(2);
    // 组合表现证据仍然只属于 performance 模式。
    expect(html).not.toContain("28d QCE");
    expect(html).not.toContain("Latest decision:");
  });

  // 卡片外层曾是一整个 <Link>，任何深链都会变成嵌套 <a>。
  it("keeps the deep-linked action outside the character link", () => {
    const html = renderToStaticMarkup(
      <CharacterPortfolioCard
        canOpenAssets
        canOpenProject
        item={item}
      />,
    );

    expect(html).not.toMatch(/<a\s[^>]*>(?:(?!<\/a>)[\s\S])*<a\s/);
  });

  // A list-visible Character can be outside the operator's scope for the action target.
  it("degrades a permission-gated action to plain text", () => {
    const restricted = {
      ...item,
      journey: { ...item.journey, primaryAction: { ...item.journey.primaryAction, canReadTarget: false } },
    };
    const html = renderToStaticMarkup(<CharacterPortfolioCard canOpenAssets canOpenProject item={restricted} />);
    expect(html).toContain("Complete image pack");
    expect(html).not.toContain('href="/admin/characters/character-1?tab=assets"');
  });

  describe("roster presentation", () => {
    // SPEC: 暂停/退役的角色线上没人看得到，卡片不能继续写 Live x/3。
    it("does not call a paused or retired pack live", () => {
      expect(characterReleasePackLabel("live")).toBe("Live {completed}/{total}");
      expect(characterReleasePackLabel("paused")).toBe("Paused {completed}/{total}");
      expect(characterReleasePackLabel("retired")).toBe("Retired {completed}/{total}");
      const html = renderToStaticMarkup(
        <CharacterPortfolioCard
          canOpenAssets
          canOpenProject
          item={{ ...item, serving: { ...item.serving, state: "paused" } } as CharacterPortfolioItem}
        />,
      );
      expect(html).toContain("Paused 2/3");
      expect(html).not.toContain("Live 2/3");
    });

    it("renders a selection control only when the list offers bulk actions", () => {
      const plain = renderToStaticMarkup(<CharacterPortfolioCard canOpenAssets canOpenProject item={item} />);
      expect(plain).not.toContain('type="checkbox"');
      const selectable = renderToStaticMarkup(
        <CharacterPortfolioCard canOpenAssets canOpenProject item={item} onToggleSelected={() => undefined} selected />,
      );
      expect(selectable).toContain('type="checkbox"');
      expect(selectable).toContain("Select Mara");
    });
  });
});
