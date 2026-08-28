import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  characterWorkspaceAreaForTab,
  characterWorkspaceAreaLabel,
  characterWorkspaceAreaTabs,
  characterWorkspaceTabLabel,
} from "./CharacterWorkspace";

const workspaceSource = readFileSync(
  new URL("./CharacterWorkspace.tsx", import.meta.url),
  "utf8",
);

describe("Character production entry", () => {

  it("uses operator-facing tab labels instead of raw route keys", () => {
    expect(characterWorkspaceTabLabel("project")).toBe("Overview");
    expect(characterWorkspaceTabLabel("assets")).toBe("Images");
    expect(characterWorkspaceTabLabel("video")).toBe("Videos");
    expect(characterWorkspaceTabLabel("voice")).toBe("Voice");
    expect(characterWorkspaceTabLabel("preview")).toBe("Launch preview");
    expect(characterWorkspaceTabLabel("monitor")).toBe("Live monitoring");
  });

  it("groups the existing deep links into settings, assets, and operations", () => {
    expect(characterWorkspaceAreaLabel("settings")).toBe("Character settings");
    expect(characterWorkspaceAreaLabel("assets")).toBe("Character assets");
    expect(characterWorkspaceAreaLabel("operations")).toBe("Character operations");
    expect(characterWorkspaceAreaTabs.settings).toEqual([
      "project",
      "soul",
      "visual",
      "voice",
    ]);
    expect(characterWorkspaceAreaTabs.assets).toEqual(["assets", "video"]);
    expect(characterWorkspaceAreaTabs.operations).toEqual([
      "preview",
      "release",
      "monitor",
    ]);
    expect(characterWorkspaceAreaForTab("visual")).toBe("settings");
    expect(characterWorkspaceAreaForTab("video")).toBe("assets");
    expect(characterWorkspaceAreaForTab("release")).toBe("operations");
  });

  it("uses three primary areas and keeps one compact mobile page selector", () => {
    expect(workspaceSource).toContain('aria-label={t("Character workspace area")}');
    expect(workspaceSource).not.toContain("<CharacterJourneyRail");
    expect(workspaceSource).toContain('aria-label={t("Workspace page")}');
    expect(workspaceSource).toContain('className="mt-3 block sm:hidden"');
    expect(workspaceSource).toContain(
      'className="mt-3 hidden gap-1 overflow-x-auto border-b border-[var(--ad-border)] sm:flex"',
    );
  });



});

// SPEC: 工作台顶部必须直接说清角色线上状态；以前只有折叠的「技术状态」，运营开页看不出
// 一个 live 角色和一个草稿角色的区别。
