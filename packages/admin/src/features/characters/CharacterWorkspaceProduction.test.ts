import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  characterNoDataDiagnosis,
  characterReleaseConfirmationVisible,
  characterWorkspaceTabLabel,
} from "./CharacterWorkspace";

const workspaceSource = readFileSync(
  new URL("./CharacterWorkspace.tsx", import.meta.url),
  "utf8",
);

describe("Character production entry", () => {
  it("keeps destructive Serving confirmation available without a Release candidate", () => {
    expect(characterReleaseConfirmationVisible({
      hasCandidate: false,
      hasReleasableQaRun: false,
      servingState: "live",
    })).toBe(true);
    expect(characterReleaseConfirmationVisible({
      hasCandidate: false,
      hasReleasableQaRun: false,
      servingState: null,
    })).toBe(false);
  });

  it("uses operator-facing tab labels instead of raw route keys", () => {
    expect(characterWorkspaceTabLabel("project")).toBe("Details");
    expect(characterWorkspaceTabLabel("assets")).toBe("Images");
    expect(characterWorkspaceTabLabel("video")).toBe("Video");
    expect(characterWorkspaceTabLabel("voice")).toBe("Voice");
    expect(characterWorkspaceTabLabel("preview")).toBe("Launch preview");
  });

  it("replaces the clipped mobile tab strip with one complete page selector", () => {
    expect(workspaceSource).toContain('aria-label={t("Workspace page")}');
    expect(workspaceSource).toContain('className="mt-4 block sm:hidden"');
    expect(workspaceSource).toContain(
      'className="mt-4 hidden gap-1 overflow-x-auto border-b border-[var(--ad-border)] sm:flex"',
    );
  });

  it("separates the live release, candidate, and collapsed history", () => {
    expect(workspaceSource).toContain('t("Current live release")');
    expect(workspaceSource).toContain('t("Release candidate")');
    expect(workspaceSource).toContain('t("Release history")');
    expect(workspaceSource).toContain('const historical = ["superseded", "withdrawn"]');
  });


});

// SPEC: 工作台顶部必须直接说清角色线上状态；以前只有折叠的「技术状态」，运营开页看不出
// 一个 live 角色和一个草稿角色的区别。
describe("Character operations facts", () => {

  // SPEC: 零观测要给运营一个动作，不是一个状态。窗口没走完 = 等；窗口走完了还是零 = 查投放。
  it("turns zero observations into either wait or investigate", () => {
    expect(characterNoDataDiagnosis({
      qualityState: "no_data", maturity: "immature", window: "7d",
    })).toMatchObject({ alert: false });
    expect(characterNoDataDiagnosis({
      qualityState: "no_data", maturity: "insufficient_data", window: "7d",
    })).toMatchObject({ alert: true });
  });

  it("stays silent when the metric is not a no-data metric", () => {
    expect(characterNoDataDiagnosis({
      qualityState: "invalid", maturity: "insufficient_data", window: "7d",
    })).toBeNull();
    expect(characterNoDataDiagnosis({
      qualityState: "certified", maturity: "mature", window: "28d",
    })).toBeNull();
  });



});
