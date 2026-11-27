import { describe, expect, it } from "vitest";
import {
  defaultGenerationConfigQuery,
  featureFlagsPath,
  generationConfigQueryFromSearch,
  generationConfigWorkspaceUrl,
  generationProfilesPath,
} from "./query";

describe("generation config query", () => {
  it("restores typed profile and feature-flag query state from the URL", () => {
    expect(generationConfigQueryFromSearch("?configSearch=flux&profileMode=image&profileStatus=draft&flagEnabled=false&profileCursor=p1&flagCursor=f1&tab=settings"))
      .toEqual({
        search: "flux",
        profileMode: "image",
        profileStatus: "draft",
        flagEnabled: "false",
        profileCursor: "p1",
        flagCursor: "f1",
        tab: "settings",
      });
  });

  it("maps URL state one-to-one to server search, filters, and cursors", () => {
    const query = generationConfigQueryFromSearch("?configSearch=flux&profileMode=image&profileStatus=active&profileCursor=next");
    expect(generationProfilesPath(query)).toBe("/api/v2/admin/generation/model-profiles?search=flux&mode=image&status=active&cursor=next&limit=25");
    expect(featureFlagsPath({ ...query, flagEnabled: "true", flagCursor: "flags" })).toBe("/api/v2/admin/feature-flags?search=flux&enabled=true&cursor=flags&limit=25");
  });

  it("preserves unrelated route state while clearing empty config values", () => {
    expect(generationConfigWorkspaceUrl("/admin/ops/profiles", "?view=config&configSearch=old", {
      ...defaultGenerationConfigQuery,
      tab: "settings",
    })).toBe("/admin/ops/profiles?view=config&tab=settings");
  });

  // SPEC: 全平台默认声音的深链（角色声音页、发布页都链过来）必须落到 Voice defaults 页签。
  it("round-trips the voice defaults tab", () => {
    expect(generationConfigQueryFromSearch("?tab=voice").tab).toBe("voice");
    expect(generationConfigWorkspaceUrl("/admin/ops/profiles", "", { ...defaultGenerationConfigQuery, tab: "voice" }))
      .toBe("/admin/ops/profiles?tab=voice");
    expect(generationConfigWorkspaceUrl("/admin/ops/profiles", "?tab=voice", defaultGenerationConfigQuery))
      .toBe("/admin/ops/profiles");
  });
});
