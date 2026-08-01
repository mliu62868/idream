import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CharacterPortfolioItem } from "@idream/shared/admin";
import {
  CharacterListEmptyState,
  CharacterPortfolioCard,
  CharacterPortfolioVisual,
  characterPortfolioPerformanceLabel,
  characterPortfolioState,
  resolveCharacterPortfolioPrimaryAction,
} from "./CharacterWorkspace";

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

describe("Character Portfolio role-image summary", () => {
  const item = {
    characterId: "character-1",
    name: "Mara",
    serving: { state: "live" },
    readiness: "ready",
    project: { audience: "Companion", phase: "live_management" },
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
    expect(studio).not.toContain("Continue filling image pack");
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

  it("renders a free roster item with one factual state and one direct destination", () => {
    const html = renderToStaticMarkup(
      <CharacterPortfolioCard
        canOpenAssets
        canOpenProject
        item={item}
        mode="studio"
      />,
    );

    expect(characterPortfolioState(item)).toMatchObject({ label: "Live" });
    expect(html).toContain('data-layout="roster"');
    expect(html).toContain('href="/admin/characters/character-1"');
    expect(html).not.toContain("Next");
    expect(html).not.toContain("Image pack");
    expect(html).not.toContain("Visual identity");
    expect(html).not.toContain("Continue filling image pack");
    expect(html).not.toContain("28d QCE");
  });

  it("uses Character-specific empty states instead of operations queue language", () => {
    const empty = renderToStaticMarkup(
      <CharacterListEmptyState filtered={false} onClear={() => undefined} />,
    );
    const filtered = renderToStaticMarkup(
      <CharacterListEmptyState filtered onClear={() => undefined} />,
    );

    // SPEC: 筛「需要处理」而零结果是好消息，语气必须和"没找到"分开——运营每天点它就为看这句。
    const attentionClear = renderToStaticMarkup(
      <CharacterListEmptyState attentionOnly filtered onClear={() => undefined} />,
    );
    expect(attentionClear).toContain("No character needs attention right now");
    expect(attentionClear).not.toContain("No characters match these filters");

    expect(empty).toContain("No characters yet");
    expect(empty).toContain("No characters are available yet.");
    expect(filtered).toContain("No characters match these filters");
    expect(filtered).toContain("Clear filters to return to all characters.");
    expect(`${empty}${filtered}`).not.toMatch(/queue|incident|case|authority/i);
  });

  it("collapses an immature empty metric into one useful sentence", () => {
    expect(characterPortfolioPerformanceLabel({
      maturity: "immature",
      qceRate: null,
      sameCharacterD7: null,
    })).toBe(
      "28d performance will appear after sufficient live traffic.",
    );
  });

  it("shows only measured portfolio metrics", () => {
    expect(characterPortfolioPerformanceLabel({
      maturity: "mature",
      qceRate: 0.75,
      sameCharacterD7: null,
    })).toBe("28d QCE 75.0% · mature");
  });

  it("shows the real primary portrait and the separate three-image workflow", () => {
    const html = renderToStaticMarkup(
      <CharacterPortfolioVisual
        canOpenAssets
        name="Mara"
        visualProduction={{
          primaryImageUrl: "/media/mara.webp",
          primaryImageSource: "draft",
          draftPurposes: ["character_cover"],
          livePurposes: ["character_cover", "character_hero"],
          totalPurposes: 3,
          deepLink: "/admin/characters/character-1?tab=assets",
        }}
      />,
    );
    expect(html).toContain('src="/media/mara.webp"');
    expect(html).toContain('alt="Mara primary role portrait"');
    expect(html).toContain("Draft 1 of 3");
    expect(html).toContain("Live 2 of 3");
    expect(html).toContain("Draft portrait");
    expect(html).toContain(
      'href="/admin/characters/character-1?tab=assets"',
    );
    expect(html).toContain(
      'aria-label="Mara: open role-image assets, Draft 1 of 3, Live 2 of 3"',
    );
  });

  it("keeps a missing portrait factual instead of rendering an initial", () => {
    const html = renderToStaticMarkup(
      <CharacterPortfolioVisual
        canOpenAssets
        name="New Character"
        visualProduction={{
          primaryImageUrl: null,
          primaryImageSource: null,
          draftPurposes: [],
          livePurposes: [],
          totalPurposes: 3,
          deepLink: "/admin/characters/character-2?tab=assets",
        }}
      />,
    );
    expect(html).toContain("Draft 0 of 3");
    expect(html).not.toContain(">N<");
  });

  it("does not expose the Assets deep link without project access", () => {
    const html = renderToStaticMarkup(
      <CharacterPortfolioVisual
        canOpenAssets={false}
        name="Restricted Character"
        visualProduction={{
          primaryImageUrl: "/media/restricted.webp",
          primaryImageSource: "live",
          draftPurposes: [],
          livePurposes: ["character_cover"],
          totalPurposes: 3,
          deepLink: "/admin/characters/restricted?tab=assets",
        }}
      />,
    );
    expect(html).not.toContain('href="/admin/characters/restricted?tab=assets"');
  });

  it("does not render a draft portrait without Assets permission", () => {
    const html = renderToStaticMarkup(
      <CharacterPortfolioVisual
        canOpenAssets={false}
        name="Restricted Draft"
        visualProduction={{
          primaryImageUrl: "/media/restricted-draft.webp",
          primaryImageSource: "draft",
          draftPurposes: [],
          livePurposes: [],
          totalPurposes: 3,
          deepLink: "/admin/characters/restricted-draft?tab=assets",
        }}
      />,
    );
    expect(html).not.toContain("/media/restricted-draft.webp");
    expect(html).not.toContain("Draft portrait");
    expect(html).toContain("No primary role portrait");
  });
});
