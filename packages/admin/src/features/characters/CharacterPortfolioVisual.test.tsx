import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CharacterPortfolioItem } from "@idream/shared/admin";
import {
  CharacterListEmptyState,
  CharacterPortfolioCard,
  CharacterPortfolioVisual,
  characterPortfolioPerformanceLabel,
  resolveCharacterPortfolioPrimaryAction,
} from "./CharacterWorkspace";

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
    nextAction: {
      code: "continue_asset_pack",
      deepLink: "/admin/characters/character-1?tab=assets",
      label: "Complete Character Assets",
    },
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
    expect(studio).toContain("Continue filling image pack");
    expect(studio).not.toContain("Complete Character Assets");
    expect(performance).toContain("28d QCE 75.0%");
    expect(performance).toContain("Latest decision:");
  });

  it("treats an existing live portrait as enablement instead of first-time setup", () => {
    const action = resolveCharacterPortfolioPrimaryAction({
      ...item,
      nextAction: {
        code: "prepare_image_production",
        deepLink: "/admin/characters/character-1?tab=assets",
        label: "Prepare image production",
      },
    }, "studio");

    expect(action).toMatchObject({
      eyebrow: "Enable image production",
      label: "Use existing portrait",
      href: "/admin/characters/character-1?tab=assets",
      requiresAssets: true,
    });
  });

  it("returns an unfinished image run to the last batch", () => {
    expect(resolveCharacterPortfolioPrimaryAction({
      ...item,
      nextAction: {
        code: "continue_image_run",
        deepLink: "/admin/characters/character-1?tab=assets",
        label: "Continue active image run",
      },
    }, "studio")).toMatchObject({
      eyebrow: "Batch in progress",
      label: "Continue last batch",
      href: "/admin/characters/character-1?tab=assets",
      requiresAssets: true,
    });
  });

  it("routes a completed live character to more images in Studio and monitoring in Performance", () => {
    const liveItem = {
      ...item,
      visualProduction: {
        ...item.visualProduction,
        draftPurposes: [],
        livePurposes: ["character_cover", "character_hero", "chat_moment"],
      },
      nextAction: {
        code: "monitor_live_character",
        deepLink: "/admin/characters/character-1?tab=monitor",
        label: "Review live character",
      },
    } as CharacterPortfolioItem;

    expect(resolveCharacterPortfolioPrimaryAction(liveItem, "studio")).toMatchObject({
      eyebrow: "Ongoing production",
      label: "Create more images",
      href: "/admin/characters/character-1?tab=assets",
      requiresAssets: true,
    });
    expect(resolveCharacterPortfolioPrimaryAction(liveItem, "performance")).toMatchObject({
      eyebrow: "Live character",
      label: "Review live character",
      href: "/admin/characters/character-1?tab=monitor",
      requiresAssets: false,
    });
  });

  it("uses Character-specific empty states instead of operations queue language", () => {
    const empty = renderToStaticMarkup(
      <CharacterListEmptyState filtered={false} onClear={() => undefined} />,
    );
    const filtered = renderToStaticMarkup(
      <CharacterListEmptyState filtered onClear={() => undefined} />,
    );

    expect(empty).toContain("No characters yet");
    expect(empty).toContain("Create the first official character to get started.");
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
