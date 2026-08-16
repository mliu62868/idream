import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  characterReleaseCheckLabel,
  characterReleaseConfirmationVisible,
  characterReleaseFlowStep,
  CHARACTER_RELEASE_FLOW_STEPS,
} from "./ReleasePanel";

const workspaceSource = readFileSync(
  new URL("./ReleasePanel.tsx", import.meta.url),
  "utf8",
);

describe("Character release panel", () => {
  it("presents release checks as operator language", () => {
    expect(characterReleaseCheckLabel("release_generation_authority_kind"))
      .toBe("Generation authority");
    expect(characterReleaseCheckLabel("release_asset_review_authority"))
      .toBe("Asset review authority");
    expect(characterReleaseCheckLabel("custom_release_check"))
      .toBe("custom release check");
  });

  it("keeps destructive Serving confirmation available without a Release candidate", () => {
    expect(characterReleaseConfirmationVisible({
      hasCandidate: false,
      hasReleasableQaRun: false,
      hasRollbackSource: false,
      servingState: "live",
    })).toBe(true);
    expect(characterReleaseConfirmationVisible({
      hasCandidate: false,
      hasReleasableQaRun: false,
      hasRollbackSource: false,
      servingState: null,
    })).toBe(false);
  });

  // 回滚下拉在恒渲染的 <details> 里，确认勾选框却藏在 confirmationVisible 后面：
  // retired/inactive 且无 candidate 时按钮可点 → 报「请先勾选确认」→ 页面上没有可勾的东西。
  it("shows the confirmation gate whenever a rollback source is selectable", () => {
    expect(characterReleaseConfirmationVisible({
      hasCandidate: false,
      hasReleasableQaRun: false,
      hasRollbackSource: true,
      servingState: "retired",
    })).toBe(true);
  });

  // 每个发命令的按钮都要在 disabled 里带上确认闸，不能只靠 command() 里的运行时报错——
  // publish / schedule / rollback 原先就漏了，点下去只会得到一句「请先勾选确认」。
  it("gates every release command button on the confirmation checkbox", () => {
    const commandButtons = [
      ...workspaceSource.matchAll(/<WorkspaceButton[\s\S]*?<\/WorkspaceButton>/g),
    ]
      .map((match) => match[0])
      .filter((button) => /void (command|servingCommand)\(/.test(button));
    const ungated = commandButtons.filter(
      (button) => !button.includes("releaseConfirmed === false"),
    );

    // publish / schedule / rollback / pause / retire / resume
    expect(commandButtons.length).toBe(6);
    expect(ungated).toEqual([]);
  });

  it("tells the operator which of the four release steps they are on", () => {
    expect(CHARACTER_RELEASE_FLOW_STEPS).toEqual([
      "Propose",
      "Review",
      "Validate",
      "Publish",
    ]);
    expect(characterReleaseFlowStep({
      hasCandidate: false,
      hasReleasableQaRun: true,
      candidateStatus: null,
      candidateReadiness: null,
    })).toEqual({ step: 1, label: "Propose" });
    expect(characterReleaseFlowStep({
      hasCandidate: true,
      hasReleasableQaRun: false,
      candidateStatus: "in_review",
      candidateReadiness: "blocked",
    })).toEqual({ step: 2, label: "Review" });
    expect(characterReleaseFlowStep({
      hasCandidate: true,
      hasReleasableQaRun: false,
      candidateStatus: "approved",
      candidateReadiness: "blocked",
    })).toEqual({ step: 3, label: "Validate" });
    expect(characterReleaseFlowStep({
      hasCandidate: true,
      hasReleasableQaRun: false,
      candidateStatus: "approved",
      candidateReadiness: "ready",
    })).toEqual({ step: 4, label: "Publish" });
    // 发布流程还没开始时不画步进条——上面那块"发布准备未完成"已经在说该做什么。
    expect(characterReleaseFlowStep({
      hasCandidate: false,
      hasReleasableQaRun: false,
      candidateStatus: null,
      candidateReadiness: null,
    })).toBeNull();
  });

  it("separates the live release, candidate, and collapsed history", () => {
    expect(workspaceSource).toContain('t("Current live release")');
    expect(workspaceSource).toContain('t("Release candidate")');
    expect(workspaceSource).toContain('t("Release history")');
    expect(workspaceSource).toContain('const historical = ["superseded", "withdrawn"]');
  });
});
