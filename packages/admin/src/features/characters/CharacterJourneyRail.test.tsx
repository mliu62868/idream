// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { AdminI18nProvider } from "@/components/admin/i18n";
import { CharacterJourneyRail } from "./CharacterJourneyRail";

const journey = {
  projectionVersion: 1,
  asOf: "2026-07-31T12:00:00.000Z",
  stage: "image_production",
  status: "blocked",
  steps: [
    { code: "visual_identity", state: "complete", deepLink: "/admin/characters/c1?tab=visual" },
    { code: "image_assets", state: "current", deepLink: "/admin/characters/c1?tab=assets" },
    { code: "preview_qa", state: "blocked", deepLink: "/admin/characters/c1?tab=preview" },
    { code: "release", state: "upcoming", deepLink: "/admin/characters/c1?tab=release" },
    { code: "live_monitor", state: "upcoming", deepLink: "/admin/characters/c1?tab=monitor" },
  ],
  blockers: [
    {
      code: "asset_pack_incomplete",
      message: "Draft image pack is missing 2 images",
      deepLink: "/admin/characters/c1?tab=assets#draft-pack",
    },
  ],
  primaryAction: {
    code: "continue_asset_pack",
    deepLink: "/admin/characters/c1?tab=assets",
    command: null,
  },
  assetPack: {
    draft: { availablePurposes: ["character_cover"], missingPurposes: ["character_hero", "character_chat"], completed: 1, total: 3 },
    live: { availablePurposes: [], missingPurposes: ["character_cover", "character_hero", "character_chat"], completed: 0, total: 3 },
  },
  release: { servingState: "inactive", currentReleaseId: null, candidateReleaseId: null },
} as unknown as CharacterWorkspaceDetail["journey"];

describe("Character journey rail", () => {
  it("renders every projected step, its state, and its deep link", () => {
    const html = renderToStaticMarkup(
      <CharacterJourneyRail journey={journey} onOpenDeepLink={() => {}} />,
    );

    for (const label of [
      "Visual identity",
      "Image assets",
      "Launch preview",
      "Release",
      "Live monitoring",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("Done");
    expect(html).toContain("In progress");
    expect(html).toContain("Not started");
    expect(html).toContain("Blocked");
    expect(html).toContain('href="/admin/characters/c1?tab=preview"');
    expect(html).toContain('aria-current="step"');
  });

  it("surfaces blockers with a count and a resolve destination", () => {
    const html = renderToStaticMarkup(
      <CharacterJourneyRail journey={journey} onOpenDeepLink={() => {}} />,
    );

    expect(html).toContain("1 to resolve");
    expect(html).toContain("Draft image pack is missing 2 images");
    expect(html).toContain('href="/admin/characters/c1?tab=assets#draft-pack"');
  });

  it("says so plainly when nothing is blocked", () => {
    const html = renderToStaticMarkup(
      <CharacterJourneyRail
        journey={{ ...journey, blockers: [] }}
        onOpenDeepLink={() => {}}
      />,
    );

    expect(html).toContain("Nothing is blocking this character");
    expect(html).not.toContain("to resolve");
  });

  it("translates the rail rather than emitting English into a zh console", () => {
    const html = renderToStaticMarkup(
      <AdminI18nProvider locale="zh">
        <CharacterJourneyRail journey={journey} onOpenDeepLink={() => {}} />
      </AdminI18nProvider>,
    );

    expect(html).toContain("生产进度");
    expect(html).toContain("视觉身份");
    expect(html).toContain("已完成");
    expect(html).toContain("1 项待处理");
  });

  describe("in-page navigation", () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
      (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
      ).IS_REACT_ACT_ENVIRONMENT = true;
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
    });

    afterEach(async () => {
      await act(async () => root.unmount());
      container.remove();
    });

    // href 必须是真链接（可复制、可中键新开），但普通点击不能交给路由——
    // tab 是 React state，跳同一条路由只会改地址栏。
    it("hands a plain click to the workspace instead of the router", async () => {
      const onOpenDeepLink = vi.fn();
      await act(async () =>
        root.render(
          <CharacterJourneyRail
            journey={journey}
            onOpenDeepLink={onOpenDeepLink}
          />,
        ),
      );

      const step = container.querySelector<HTMLAnchorElement>(
        'a[href="/admin/characters/c1?tab=preview"]',
      );
      expect(step).not.toBeNull();
      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      await act(async () => {
        step?.dispatchEvent(event);
      });

      expect(onOpenDeepLink).toHaveBeenCalledWith(
        "/admin/characters/c1?tab=preview",
      );
      expect(event.defaultPrevented).toBe(true);
    });
  });
});
