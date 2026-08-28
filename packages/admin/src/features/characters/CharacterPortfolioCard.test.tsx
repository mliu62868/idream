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
        deepLink: "/admin/characters/character-1?tab=preview",
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
    primaryAction: { code, deepLink, command: null },
    assetPack: {
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
    },
  };
}

const t = (key: string, values?: Record<string, string | number>) =>
  translateAdmin("en", key, values);

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
      "continue_asset_pack",
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
    expect(performance).not.toContain("Latest decision:");
    expect(performance).not.toContain("Companion");
    expect(performance).not.toContain("live management");
  });

  // SPEC: 草稿主图的可见性由「能不能看素材」决定，与看的是哪个视图无关。
  // INTENT: 「角色表现」曾把 canOpenAssets 硬编码成 false，于是主图来源为 draft 的角色
  //         在那里只剩灰色占位（同一角色在「角色」里有图），requiresAssets 的下一步动作
  //         也一并降级成「仅表现数据」。这两个症状同源，一起钉住。
  it("shows a draft portrait in performance mode to an operator who may open assets", () => {
    const draftItem = {
      ...item,
      visualProduction: {
        ...item.visualProduction,
        primaryImageSource: "draft",
      },
    } as unknown as CharacterPortfolioItem;
    const withAssets = renderToStaticMarkup(
      <CharacterPortfolioCard
        canOpenAssets
        canOpenProject
        item={draftItem}
        mode="performance"
      />,
    );
    const withoutAssets = renderToStaticMarkup(
      <CharacterPortfolioCard
        canOpenAssets={false}
        canOpenProject
        item={draftItem}
        mode="performance"
      />,
    );

    expect(withAssets).toContain("/media/mara.webp");
    expect(withAssets).not.toContain("No primary role portrait");
    expect(withoutAssets).not.toContain("/media/mara.webp");
    expect(withoutAssets).toContain("No primary role portrait");
  });

  it("treats an existing live portrait as enablement instead of first-time setup", () => {
    const action = resolveCharacterPortfolioPrimaryAction({
      ...item,
      serving: { ...item.serving, state: "inactive" },
      journey: journey(
        "prepare_image_production",
        "visual_setup",
        "/admin/characters/character-1?tab=assets",
      ),
    });

    expect(action).toMatchObject({
      eyebrow: "Enable image production",
      label: "Use existing portrait",
      href: "/admin/characters/character-1?tab=assets",
      requiresAssets: true,
    });
  });

  it("returns an unfinished image run to the image still in progress", () => {
    expect(
      resolveCharacterPortfolioPrimaryAction({
        ...item,
        serving: { ...item.serving, state: "inactive" },
        journey: journey(
          "continue_image_run",
          "image_production",
          "/admin/characters/character-1?tab=assets",
        ),
      }),
    ).toMatchObject({
      // 运营面说人话：不用 batch/run 这类工程词（与周围 image route / image pack 文案一致）。
      eyebrow: "Image in progress",
      label: "Continue current image",
      href: "/admin/characters/character-1?tab=assets",
      requiresAssets: true,
    });
  });

  it("uses the same authoritative live action in Studio and Performance", () => {
    const liveJourney = journey(
      "monitor_live_character",
      "live_operations",
      "/admin/characters/character-1?tab=monitor",
    );
    const liveItem = {
      ...item,
      visualProduction: {
        ...item.visualProduction,
        draftPurposes: [],
        livePurposes: ["character_cover", "character_hero", "chat_moment"],
      },
      journey: {
        ...liveJourney,
        assetPack: {
          ...liveJourney.assetPack,
          live: {
            availablePurposes: [
              "character_cover",
              "character_hero",
              "character_chat",
            ],
            missingPurposes: [],
            completed: 3,
            total: 3,
          },
        },
      },
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

  it("explains the exact telemetry problem inside the needs-attention view", () => {
    const action = resolveCharacterPortfolioPrimaryAction({
      ...item,
      needsAttention: true,
    });

    expect(action).toEqual({
      description:
        "This live Character has no exposure or funnel events after the 7-day observation window.",
      eyebrow: "No telemetry after 7 days",
      href: "/admin/characters/character-1?tab=monitor",
      label: "Inspect live monitoring",
      requiresAssets: false,
    });
  });

  it("does not let an incidental image run outrank a live telemetry failure", () => {
    const action = resolveCharacterPortfolioPrimaryAction({
      ...item,
      needsAttention: true,
      journey: journey(
        "continue_image_run",
        "image_production",
        "/admin/characters/character-1?tab=assets",
      ),
    });

    expect(action).toMatchObject({
      label: "Inspect live monitoring",
      href: "/admin/characters/character-1?tab=monitor",
      requiresAssets: false,
    });
  });

  it("keeps an explicit production blocker ahead of telemetry attention", () => {
    const blockedJourney = journey(
      "complete_image_route",
      "visual_setup",
      "/admin/characters/character-1?tab=visual",
    );
    const action = resolveCharacterPortfolioPrimaryAction({
      ...item,
      needsAttention: true,
      journey: { ...blockedJourney, status: "blocked" },
    });

    expect(action).toMatchObject({
      label: "Complete image route setup",
      href: "/admin/characters/character-1?tab=visual",
    });
  });

  it("keeps a live Release blocker ahead of telemetry attention", () => {
    const action = resolveCharacterPortfolioPrimaryAction({
      ...item,
      needsAttention: true,
      readiness: "blocked",
      operationalState: {
        ...item.operationalState,
        blockers: [
          {
            code: "release_blocked",
            message: "Current release is blocked",
            deepLink: "/admin/characters/character-1?tab=monitor",
          },
        ],
      },
    });

    expect(action).toMatchObject({
      label: "Resolve live release blocker",
      href: "/admin/characters/character-1?tab=monitor",
    });
  });

  it("turns an incomplete historical live pack into an explicit remediation action", () => {
    const action = resolveCharacterPortfolioPrimaryAction(item);

    expect(action).toMatchObject({
      eyebrow: "Live with an incomplete image pack",
      label: "Complete image pack",
      href: "/admin/characters/character-1?tab=assets",
      requiresAssets: true,
    });
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
            deepLink: "/admin/characters/character-1?tab=preview",
          },
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

    expect(html).toContain("Complete image pack");
    expect(html).not.toContain(
      'href="/admin/characters/character-1?tab=assets"',
    );
  });

  it("collapses an immature empty metric into one useful sentence", () => {
    expect(
      characterPortfolioPerformanceLabel(t, {
        maturity: "immature",
        qceRate: null,
        sameCharacterD7: null,
      }),
    ).toBe("28d performance will appear after sufficient live traffic.");
  });

  it("shows only measured portfolio metrics", () => {
    expect(
      characterPortfolioPerformanceLabel(t, {
        maturity: "mature",
        qceRate: 0.75,
        sameCharacterD7: null,
      }),
    ).toBe("28d QCE 75.0% · mature");
  });

  it("translates the performance label instead of emitting raw English", () => {
    const zh = (key: string, values?: Record<string, string | number>) =>
      translateAdmin("zh", key, values);

    expect(
      characterPortfolioPerformanceLabel(zh, {
        maturity: "mature",
        qceRate: 0.75,
        sameCharacterD7: null,
      }),
    ).toBe("28 天 QCE 75.0% · 证据充分");
  });
});
