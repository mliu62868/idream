import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CharacterPortfolioVisual,
  characterPortfolioPerformanceLabel,
} from "./CharacterWorkspace";

describe("Character Portfolio role-image summary", () => {
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
