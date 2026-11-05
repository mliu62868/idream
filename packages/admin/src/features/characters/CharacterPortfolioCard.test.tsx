import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CharacterPortfolioItem } from "@idream/shared/admin";
import { translateAdmin } from "@/components/admin/i18n";
import {
  CharacterPortfolioCard,
  characterReleasePackLabel,
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
      />,
    );
    expect(studio).toContain("Mara");
    expect(studio).not.toContain("28d QCE");
    expect(studio).not.toContain("Latest decision:");
    expect(studio).toContain("Live");
    expect(studio).not.toContain("Complete Character Assets");
  });

  it("marks an archived draft and directs recovery before image production", () => {
    const archived = {
      ...item,
      serving: { ...item.serving, state: "retired" as const, currentReleaseId: null },
      journey: { ...journey("create_primary_portrait", "visual_setup", "/admin/characters/character-1?tab=assets"), status: "blocked" as const },
    };
    expect(characterPortfolioState(archived).label).toBe("Archived");
    expect(resolveCharacterPortfolioPrimaryAction(archived)).toMatchObject({
      label: "Restore draft", href: "/admin/characters/character-1?tab=release", requiresAssets: false,
    });
    const html = renderToStaticMarkup(<CharacterPortfolioCard canOpenAssets={false} canOpenProject item={archived} />);
    expect(html).toContain("Archived");
    expect(html).toContain("Restore draft");
    expect(html).not.toContain("Create first identity portrait");
  });

  it("keeps retired published and paused characters distinct from a live production journey", () => {
    const retired = { ...item, serving: { ...item.serving, state: "retired" as const, currentReleaseId: "release-1" } };
    expect(characterPortfolioState(retired).label).toBe("Retired");
    expect(resolveCharacterPortfolioPrimaryAction(retired)).toMatchObject({ label: "Review retired character", requiresAssets: false });
    const paused = { ...item, serving: { ...item.serving, state: "paused" as const }, journey: journey("monitor_live_character", "live_operations", "/admin/characters/character-1?tab=monitor") };
    expect(characterPortfolioState(paused).label).toBe("Paused");
    expect(resolveCharacterPortfolioPrimaryAction(paused)).toMatchObject({
      label: "Review paused character", href: "/admin/characters/character-1?tab=release",
    });
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

  // SPEC: 草稿主图的可见性由「能不能看素材」决定，与看的是哪个视图无关。
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

  // SPEC: 创作者改了已发布角色（新 Revision、Release 未动），卡片主动作直达发布页准备发布。
  it("sends a live Character with a saved revision to prepare its release", () => {
    const live = journey("monitor_live_character", "live_operations", "/admin/characters/character-1?tab=monitor");
    const pendingRevision = {
      revisionId: "revision-2",
      revision: 2,
      createdAt: "2026-09-20T08:00:00.000Z",
      deepLink: "/admin/characters/character-1?tab=release",
    };
    const edited = { ...item, journey: { ...live, release: { ...live.release, pendingRevision } } } as CharacterPortfolioItem;
    expect(resolveCharacterPortfolioPrimaryAction(edited)).toMatchObject({
      eyebrow: "Unpublished revision",
      label: "Prepare release",
      href: "/admin/characters/character-1?tab=release",
    });
    expect(resolveCharacterPortfolioPrimaryAction({ ...item, journey: live }).label).not.toBe("Prepare release");
    expect(translateAdmin("zh", "Unpublished revision")).toBe("有待发布的修订");
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

  it("uses the same authoritative live action on the card", () => {
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
      label: "No action needed",
      href: "/admin/characters/character-1?tab=monitor",
      requiresAssets: false,
    });
    expect(resolveCharacterPortfolioPrimaryAction(liveItem)).toMatchObject({
      eyebrow: "Live character",
      label: "No action needed",
      href: "/admin/characters/character-1?tab=monitor",
      requiresAssets: false,
    });
  });

  // SPEC: 权威判"表现数据不可信"必须在卡片上有出口，而且比"零观测"更优先。
  // INTENT: qualityState=invalid 表示漏斗事实自相矛盾/曝光链不精确，也就是这张卡上的数字不能
  //         用来做决定。它此前在前端完全没有出口——needsAttention 只覆盖 no_data，invalid 的
  //         角色和正常角色长得一模一样，运营会照着已知有问题的数据做下架和资源分配。
  it("surfaces an invalid performance verdict ahead of a missing-telemetry one", () => {
    const action = resolveCharacterPortfolioPrimaryAction({
      ...item,
      needsAttention: true,
      operationalState: { ...item.operationalState, qualityState: "invalid" },
    });

    expect(action).toEqual({
      description:
        "The performance authority marked this Character's funnel facts invalid, so these numbers cannot support a decision.",
      eyebrow: "Performance data invalid",
      href: "/admin/characters/character-1?tab=monitor",
      label: "Inspect performance quality",
      requiresAssets: false,
    });
    // 这两句文案必须有中文，否则中文界面上印的是英文原句。
    expect(translateAdmin("zh", "Performance data invalid")).not.toBe("Performance data invalid");
    expect(translateAdmin("zh", "Inspect performance quality")).not.toBe("Inspect performance quality");
  });

  it("names a monitor action instead of sending the operator to check placements", () => {
    const action = resolveCharacterPortfolioPrimaryAction({
      ...item,
      needsAttention: true,
      attentionReason: "release_monitor_action",
    });
    expect(action).toMatchObject({
      label: "Review monitor evidence",
      href: "/admin/characters/character-1?tab=monitor",
    });
    expect(action.description).not.toContain("event delivery");
  });

  it("explains the exact telemetry problem inside the needs-attention view", () => {
    const action = resolveCharacterPortfolioPrimaryAction({
      ...item,
      needsAttention: true,
      attentionReason: "no_traffic_after_window",
    });

    expect(action).toEqual({
      description:
        "No exposure, funnel, or chat traffic in 7 days live. Check placement targeting and event delivery.",
      eyebrow: "No traffic after 7 days",
      href: "/admin/characters/character-1?tab=monitor",
      label: "Inspect live monitoring",
      requiresAssets: false,
    });
  });

  it("does not let an incidental image run outrank a live telemetry failure", () => {
    const action = resolveCharacterPortfolioPrimaryAction({
      ...item,
      needsAttention: true,
      attentionReason: "no_traffic_after_window",
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

  // requiresAssets 的动作在没有资产权限时降级成纯文本，不给一个点了会 403 的链接。
  it("degrades a permission-gated action to plain text", () => {
    const html = renderToStaticMarkup(
      <CharacterPortfolioCard
        canOpenAssets={false}
        canOpenProject
        item={item}
      />,
    );

    expect(html).toContain("Complete image pack");
    expect(html).not.toContain(
      'href="/admin/characters/character-1?tab=assets"',
    );
  });

  // SPEC: 下一步提示补洞。stale/legacy 对照 ReleasePanel；健康线上不制造待办；路线是平台问题。
  describe("next-step gaps", () => {
    const monitor = journey(
      "monitor_live_character",
      "live_operations",
      "/admin/characters/character-1?tab=monitor",
    );
    const completeLive = {
      ...monitor,
      assetPack: {
        ...monitor.assetPack,
        live: {
          availablePurposes: ["character_cover", "character_hero", "character_chat"],
          missingPurposes: [],
          completed: 3,
          total: 3,
        },
      },
    } as CharacterPortfolioItem["journey"];
    const healthy = { ...item, journey: completeLive, currentRelease: { status: "published", legacy: false } } as unknown as CharacterPortfolioItem;

    it("sends a stale live Release to publish again instead of calling it healthy", () => {
      expect(
        resolveCharacterPortfolioPrimaryAction({ ...healthy, readiness: "stale" }),
      ).toMatchObject({ label: "Publish again", href: "/admin/characters/character-1?tab=release" });
    });

    it("offers a legacy Release a way off only after every real task", () => {
      const legacy = { ...healthy, currentRelease: { status: "published", legacy: true } } as unknown as CharacterPortfolioItem;
      expect(resolveCharacterPortfolioPrimaryAction(legacy)).toMatchObject({
        eyebrow: "Legacy release",
        href: "/admin/characters/character-1?tab=release",
      });
      expect(
        resolveCharacterPortfolioPrimaryAction({
          ...legacy,
          needsAttention: true,
          attentionReason: "no_traffic_after_window",
        }).eyebrow,
      ).toBe("No traffic after 7 days");
    });

    it("says no action is needed for a healthy live Character", () => {
      expect(resolveCharacterPortfolioPrimaryAction(healthy)).toMatchObject({
        label: "No action needed",
      });
    });

    it("explains a route problem as a platform issue and links to platform operations", () => {
      const action = resolveCharacterPortfolioPrimaryAction({
        ...item,
        journey: {
          ...journey("platform_route_unavailable", "visual_setup", "/admin/ops/profiles"),
          status: "blocked",
        },
      } as CharacterPortfolioItem);
      expect(action.href).toBe("/admin/ops/profiles");
      expect(action.description).toContain("platform configuration issue");
    });

    it("gives failed and unknown image Runs their own step", () => {
      expect(
        resolveCharacterPortfolioPrimaryAction({
          ...item,
          serving: { ...item.serving, state: "inactive" },
          journey: journey("retry_failed_image_run", "image_production", "/admin/characters/character-1?tab=assets"),
        } as CharacterPortfolioItem).label,
      ).toBe("Generate again");
      expect(
        resolveCharacterPortfolioPrimaryAction({
          ...item,
          serving: { ...item.serving, state: "inactive" },
          journey: {
            ...journey("resolve_unknown_image_run", "image_production", "/admin/characters/character-1?tab=assets"),
            status: "blocked",
          },
        } as CharacterPortfolioItem).label,
      ).toBe("Check image Run");
    });

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
