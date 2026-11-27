import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CHARACTER_WORKSPACE_TABS,
  characterWorkspaceAreaForTab,
  characterWorkspaceAreaLabel,
  characterWorkspaceAreaTabs,
  characterWorkspaceTabLabel,
} from "./CharacterWorkspace";
import {
  characterWorkspaceTabFromSearch,
  characterWorkspaceTabs,
} from "@/features/image-workflow-transport";

const workspaceSource = ["./CharacterWorkspace.tsx", "./CharacterWorkspaceNav.tsx"]
  .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
  .join("\n");

describe("Character production entry", () => {

  it("uses operator-facing tab labels instead of raw route keys", () => {
    expect(characterWorkspaceTabLabel("project")).toBe("Overview");
    expect(characterWorkspaceTabLabel("soul")).toBe("Persona");
    expect(characterWorkspaceTabLabel("visual")).toBe("Appearance & identity");
    expect(characterWorkspaceTabLabel("assets")).toBe("Images");
    expect(characterWorkspaceTabLabel("video")).toBe("Videos");
    expect(characterWorkspaceTabLabel("voice")).toBe("Voice");
    expect(characterWorkspaceTabLabel("release")).toBe("Release and preview");
    expect(characterWorkspaceTabFromSearch("?tab=preview")).toBe("release");
    expect(characterWorkspaceTabLabel("monitor")).toBe("Live monitoring");
  });

  // SPEC: 导航按 概览 ｜ 设定 ｜ 素材 ｜ 上线 分组渲染，旧 ?tab= 值与别名照旧解析。
  it("groups every existing deep link into overview, setup, assets, and go-live", () => {
    expect(characterWorkspaceAreaLabel("overview")).toBe("Overview");
    expect(characterWorkspaceAreaLabel("settings")).toBe("Setup");
    expect(characterWorkspaceAreaLabel("assets")).toBe("Assets");
    expect(characterWorkspaceAreaLabel("launch")).toBe("Go live");
    expect(characterWorkspaceAreaTabs).toEqual({
      overview: ["project"],
      settings: ["soul", "visual", "voice"],
      assets: ["assets", "video"],
      launch: ["release", "monitor"],
    });
    expect(CHARACTER_WORKSPACE_TABS).toEqual([
      "project", "soul", "visual", "voice", "assets", "video", "release", "monitor",
    ]);
    expect([...CHARACTER_WORKSPACE_TABS].sort()).toEqual([...characterWorkspaceTabs].sort());
    expect(characterWorkspaceAreaForTab("project")).toBe("overview");
    expect(characterWorkspaceAreaForTab("visual")).toBe("settings");
    expect(characterWorkspaceAreaForTab("video")).toBe("assets");
    expect(characterWorkspaceAreaForTab("release")).toBe("launch");
  });

  it("renders the grouped tab bar on desktop and a grouped mobile page selector", () => {
    expect(workspaceSource).not.toContain("<CharacterJourneyRail");
    expect(workspaceSource).not.toContain("ALL_WORKSPACE_TABS");
    expect(workspaceSource).toContain('aria-label={t("Workspace page")}');
    expect(workspaceSource).toContain('className="mt-4 block sm:hidden"');
    expect(workspaceSource).toContain("<optgroup");
    expect(workspaceSource).toContain(
      'className="mt-4 hidden items-end overflow-x-auto border-b border-[var(--ad-border)] sm:flex"',
    );
  });
});
