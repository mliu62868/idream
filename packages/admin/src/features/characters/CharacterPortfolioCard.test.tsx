import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CharacterPortfolioItem } from "@idream/shared/admin";
import { translateAdmin } from "@/components/admin/i18n";
import {
  CharacterPortfolioCard,
  characterPortfolioPerformanceLabel,
  characterPortfolioState,
  resolveCharacterPortfolioPrimaryAction,
} from "./CharacterPortfolioCard";

function journey(
  code: CharacterPortfolioItem["journey"]["primaryAction"]["code"],
  stage: CharacterPortfolioItem["journey"]["stage"],
  deepLink: string,
): CharacterPortfolioItem["journey"] {
  const stateFor = (stepStage: CharacterPortfolioItem["journey"]["stage"]) =>
    stepStage === stage ? "current" as const : "upcoming" as const;
  return {
    projectionVersion: 1,
    asOf: "2026-07-31T12:00:00.000Z",
    stage,
    status: stage === "live_operations" ? "live" : "in_progress",
    steps: [
      { code: "visual_identity", state: "complete", deepLink: "/admin/characters/character-1?tab=visual" },
      { code: "image_assets", state: stateFor("image_production"), deepLink: "/admin/characters/character-1?tab=assets" },
      { code: "preview_qa", state: stateFor("preview_qa"), deepLink: "/admin/characters/character-1?tab=preview" },
      { code: "release", state: "complete", deepLink: "/admin/characters/character-1?tab=release" },
      { code: "live_monitor", state: stateFor("live_operations"), deepLink: "/admin/characters/character-1?tab=monitor" },
    ],
    blockers: [],
    primaryAction: { code, deepLink, command: null },
    assetPack: {
      draft: { availablePurposes: ["character_cover"], missingPurposes: ["character_hero", "character_chat"], completed: 1, total: 3 },
      live: { availablePurposes: ["character_cover", "character_hero"], missingPurposes: ["character_chat"], completed: 2, total: 3 },
    },
    release: { servingState: "live", currentReleaseId: "release-1", candidateReleaseId: null },
  };
}

const t = (key: string, values?: Record<string, string | number>) =>
  translateAdmin("en", key, values);

describe("Character Portfolio card", () => {
  const item = {
    characterId: "character-1",
    name: "Mara",
    serving: { state: "live" },
    readiness: "ready",
    project: {
      audience: "Companion",
      phase: "live_management",
      ownerId: "operator-ana",
      updatedAt: "2026-07-31T12:00:00.000Z",
    },
    visualProduction: {
      primaryImageUrl: "/media/mara.webp",
      primaryImageSource: "live",
      draftPurposes: ["character_cover"],
      livePurposes: ["character_cover", "character_hero"],
      totalPurposes: 3,
      deepLink: "/admin/characters/character-1?tab=assets",
    },
    performance: [{
      window: "28d",
      placementId: null,
      maturity: "mature",
      qceRate: 0.75,
      sameCharacterD7: null,
    }],
    journey: journey("continue_asset_pack", "image_production", "/admin/characters/character-1?tab=assets"),
    latestDecision: { decision: "promote" },
  } as unknown as CharacterPortfolioItem;

  it("keeps portfolio evidence out of the primary Character workspace", () => {
    const studio = renderToStaticMarkup(
      <CharacterPortfolioCard
        canOpenAssets
        canOpenProject
        item={item}
        mode="studio"
      />,
    );
    const performance = renderToStaticMarkup(
      <CharacterPortfolioCard
        canOpenAssets
        canOpenProject
        item={item}
        mode="performance"
      />,
    );

    expect(studio).toContain("Mara");
    expect(studio).not.toContain("28d QCE");
    expect(studio).not.toContain("Latest decision:");
    expect(studio).toContain("Live");
    expect(studio).not.toContain("Complete Character Assets");
    expect(performance).toContain("28d QCE 75.0%");
    expect(performance).toContain("Latest decision:");
  });


  it("treats an existing live portrait as enablement instead of first-time setup", () => {
    const action = resolveCharacterPortfolioPrimaryAction({
      ...item,
      journey: journey("prepare_image_production", "visual_setup", "/admin/characters/character-1?tab=assets"),
    });

    expect(action).toMatchObject({
      eyebrow: "Enable image production",
      label: "Use existing portrait",
      href: "/admin/characters/character-1?tab=assets",
      requiresAssets: true,
    });
  });


  it("returns an unfinished image run to the image still in progress", () => {
    expect(resolveCharacterPortfolioPrimaryAction({
      ...item,
      journey: journey("continue_image_run", "image_production", "/admin/characters/character-1?tab=assets"),
    })).toMatchObject({
      // 运营面说人话：不用 batch/run 这类工程词（与周围 image route / image pack 文案一致）。
      eyebrow: "Image in progress",
      label: "Continue current image",
      href: "/admin/characters/character-1?tab=assets",
      requiresAssets: true,
    });
  });


  it("uses the same authoritative live action in Studio and Performance", () => {
    const liveItem = {
      ...item,
      visualProduction: {
        ...item.visualProduction,
        draftPurposes: [],
        livePurposes: ["character_cover", "character_hero", "chat_moment"],
      },
      journey: journey("monitor_live_character", "live_operations", "/admin/characters/character-1?tab=monitor"),
    } as CharacterPortfolioItem;

    expect(resolveCharacterPortfolioPrimaryAction(liveItem)).toMatchObject({
      eyebrow: "Live character",
      label: "Review live character",
      href: "/admin/characters/character-1?tab=monitor",
      requiresAssets: false,
    });
    expect(resolveCharacterPortfolioPrimaryAction(liveItem)).toMatchObject({
      eyebrow: "Live character",
      label: "Review live character",
      href: "/admin/characters/character-1?tab=monitor",
      requiresAssets: false,
    });
  });


  // 这里原本断言 roster 卡片"只有一个状态词和一个目的地"，并 not.toContain 下一步动作。
  // 那是刻意的极简，但代价是运营在列表上看不出任何一张卡还差什么——journey 投影每条都下发了
  // primaryAction / blockers / assetPack，前端一个字段没渲染。改成断言这些字段真的到了页面上。
  it("puts the journey next action, blockers, and pack progress on the roster tile", () => {
    const blocked = {
      ...item,
      journey: {
        ...item.journey,
        blockers: [
          { code: "assets_incomplete", message: "Draft image pack is missing 2 images", deepLink: "/admin/characters/character-1?tab=assets" },
          { code: "preview_stale", message: "Launch preview is stale", deepLink: "/admin/characters/character-1?tab=preview" },
        ],
      },
    } as CharacterPortfolioItem;
    const html = renderToStaticMarkup(
      <CharacterPortfolioCard
        canOpenAssets
        canOpenProject
        item={blocked}
        mode="studio"
      />,
    );

    expect(characterPortfolioState(item)).toMatchObject({ label: "Live" });
    expect(html).toContain('data-layout="roster"');
    expect(html).toContain('href="/admin/characters/character-1"');
    expect(html).toContain("Continue filling image pack");
    expect(html).toContain('href="/admin/characters/character-1?tab=assets"');
    expect(html).toContain("Draft image pack is missing 2 images · +1 more");
    expect(html).toContain("operator-ana");
    expect(html).toContain("Draft 1/3");
    expect(html).toContain("Live 2/3");
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
        mode="studio"
      />,
    );

    expect(html).not.toMatch(/<a\s[^>]*>(?:(?!<\/a>)[\s\S])*<a\s/);
  });

  // requiresAssets 的动作在没有资产权限时降级成纯文本，不给一个点了会 403 的链接。
  it("degrades a permission-gated action to plain text", () => {
    const html = renderToStaticMarkup(
      <CharacterPortfolioCard
        canOpenAssets={false}
        canOpenProject
        item={item}
        mode="studio"
      />,
    );

    expect(html).toContain("Continue filling image pack");
    expect(html).not.toContain('href="/admin/characters/character-1?tab=assets"');
  });


  it("collapses an immature empty metric into one useful sentence", () => {
    expect(characterPortfolioPerformanceLabel(t, {
      maturity: "immature",
      qceRate: null,
      sameCharacterD7: null,
    })).toBe(
      "28d performance will appear after sufficient live traffic.",
    );
  });


  it("shows only measured portfolio metrics", () => {
    expect(characterPortfolioPerformanceLabel(t, {
      maturity: "mature",
      qceRate: 0.75,
      sameCharacterD7: null,
    })).toBe("28d QCE 75.0% · mature");
  });


  it("translates the performance label instead of emitting raw English", () => {
    const zh = (key: string, values?: Record<string, string | number>) =>
      translateAdmin("zh", key, values);

    expect(characterPortfolioPerformanceLabel(zh, {
      maturity: "mature",
      qceRate: 0.75,
      sameCharacterD7: null,
    })).toBe("28 天 QCE 75.0% · 证据充分");
  });
});
