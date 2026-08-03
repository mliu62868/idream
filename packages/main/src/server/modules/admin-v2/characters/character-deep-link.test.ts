import { describe, expect, it } from "vitest";
import {
  CHARACTER_WORKSPACE_ANCHORS,
  characterWorkspaceAnchorLink,
  characterWorkspaceLink,
  characterWorkspaceTabLink,
} from "./character-deep-link";
import { visualBlockerDeepLink } from "./workspace";

const VISUAL_BLOCKER_CODES = [
  "visual_identity_missing",
  "visual_anchor_missing",
  "visual_traits_incomplete",
  "reference_set_not_active",
  "reference_assets_unavailable",
  "generation_route_unqualified",
  "generation_route_stale",
] as const;

describe("character workspace deep links", () => {
  it("escapes the character id in every shape", () => {
    expect(characterWorkspaceLink("a/b")).toBe("/admin/characters/a%2Fb");
    expect(characterWorkspaceTabLink("a/b", "assets")).toBe(
      "/admin/characters/a%2Fb?tab=assets",
    );
    expect(characterWorkspaceAnchorLink("a/b", "visual_reference_set")).toBe(
      "/admin/characters/a%2Fb?tab=visual#visual-reference-set",
    );
  });

  it("keeps every anchor on the tab that renders it", () => {
    for (const [name, target] of Object.entries(CHARACTER_WORKSPACE_ANCHORS)) {
      expect(
        characterWorkspaceAnchorLink(
          "character-1",
          name as keyof typeof CHARACTER_WORKSPACE_ANCHORS,
        ),
      ).toBe(`/admin/characters/character-1?tab=${target.tab}#${target.id}`);
    }
  });

  // SPEC: 每个视觉阻塞项的 deepLink 都必须落在这个角色的运营台上，并直达具体控件。
  // INTENT: 路线类阻塞此前落到 `/admin/ops/profiles?characterId=…#route-qualification-workbench`
  // ——另一个页面，后面挂一个只有角色运营台才有的片段。链接依然「合法」，点了却什么都不会发生，
  // 所以只断言 code 出现过是抓不住的：这里断言链接的**形状**。
  it("points every visual blocker at a control inside this character workspace", () => {
    for (const code of VISUAL_BLOCKER_CODES) {
      const link = visualBlockerDeepLink("character-1", code);
      expect(link, code).toMatch(
        /^\/admin\/characters\/character-1\?tab=[a-z]+#[a-z-]+$/,
      );
    }

    expect(visualBlockerDeepLink("character-1", "generation_route_unqualified"))
      .toBe(
        "/admin/characters/character-1?tab=visual#route-qualification-workbench",
      );
    expect(visualBlockerDeepLink("character-1", "generation_route_stale")).toBe(
      "/admin/characters/character-1?tab=visual#route-qualification-workbench",
    );
    expect(visualBlockerDeepLink("character-1", "visual_identity_missing")).toBe(
      "/admin/characters/character-1?tab=visual#visual-identity-version",
    );
  });

  it("falls back to the visual tab for an unknown blocker code", () => {
    expect(visualBlockerDeepLink("character-1", "some_future_code")).toBe(
      "/admin/characters/character-1?tab=visual",
    );
  });
});
