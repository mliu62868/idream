// @vitest-environment happy-dom

import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { characterPortfolioDecisionSchema } from "@idream/shared/admin";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdminI18nProvider } from "@/components/admin/i18n";
import {
  characterWorkspaceDetail,
  withCharacterWorkspaceDetail,
} from "./character-workspace-fixture";
import {
  characterPerformanceHasObservations,
  MonitorPanel,
  PerformancePanel,
  portfolioDecisions,
} from "./CharacterWorkspace";

type WorkspaceRelease = CharacterWorkspaceDetail["releases"][number]["release"];
type ContributionMargin =
  CharacterWorkspaceDetail["performance"][number]["contributionMargin"];

// SPEC: 完整的 release / 毛利投影；各用例只覆盖自己关心的字段。
// INTENT: 这两处都在数组里，覆盖时整条替换——契约给它们加字段，这里必须补上。
function workspaceRelease(overrides: Partial<WorkspaceRelease> = {}): WorkspaceRelease {
  return {
    id: "character-release",
    projectId: "project-1",
    revisionId: "revision-1",
    characterContentVersionId: "content-version-1",
    visualProfileId: null,
    visualProfileVersion: null,
    referenceSetRevisionId: null,
    generationProvenance: {},
    releasePlacementManifest: {},
    snapshotHash: "snapshot-hash",
    readiness: "ready",
    legacy: false,
    status: "published",
    publishedAt: "2026-07-16T12:00:00.000Z",
    supersedesId: null,
    rollbackOfReleaseId: null,
    version: 1,
    createdAt: "2026-07-16T12:00:00.000Z",
    updatedAt: "2026-07-16T12:00:00.000Z",
    ...overrides,
  };
}

function contributionMargin(
  overrides: Partial<ContributionMargin> = {},
): ContributionMargin {
  return {
    valueMicros: null,
    currency: null,
    attributedRevenueMicros: null,
    refundMicros: null,
    creditMicros: null,
    variableCostMicros: null,
    qualityState: "no_data",
    evidence: [],
    ...overrides,
  };
}

type WorkspaceReleaseEntry = CharacterWorkspaceDetail["releases"][number];
type PerformanceWindow = CharacterWorkspaceDetail["performance"][number];

function releaseEntry(release: WorkspaceRelease): WorkspaceReleaseEntry {
  return { release, checks: [], monitors: [] };
}

function performanceWindow(
  overrides: Partial<PerformanceWindow> = {},
): PerformanceWindow {
  return {
    characterContentVersionId: "content-version-1",
    characterReleaseId: "character-release",
    placementId: null,
    window: "7d",
    windowStart: "2026-07-09T00:00:00.000Z",
    windowEnd: "2026-07-16T00:00:00.000Z",
    eligibleImpressions: 0,
    detailViews: 0,
    firstSuccessfulExchanges: 0,
    qceCount: 0,
    relationshipActivations: 0,
    sameCharacterD7EligiblePairs: 0,
    sameCharacterD7Returns: 0,
    paidAttributions: 0,
    detailCtr: null,
    chatStartRate: null,
    qceRate: null,
    sameCharacterD7: null,
    sampleSize: 0,
    maturity: "immature",
    qualityState: "no_data",
    coverageState: "unavailable",
    latestDataAt: null,
    evidence: [],
    contributionMargin: contributionMargin(),
    ...overrides,
  };
}

const releaseId = "editorial-release:alexa-reeves:a5c8ca4f";

const workspace = characterWorkspaceDetail({
  character: { id: "alexa-reeves" },
  serving: { state: "live", currentReleaseId: releaseId },
  releases: [releaseEntry(workspaceRelease({ id: releaseId }))],
  performance: [performanceWindow({ characterReleaseId: releaseId })],
  portfolio: { latestDecision: null },
});

const brokenPipelineWorkspace = withCharacterWorkspaceDetail(workspace, {
  performance: [{
    ...workspace.performance[0],
    qualityState: "invalid",
    coverageState: "invalid",
  }],
});

// 观察窗口已经走完，却还是一条观测都没有 —— 这不是"再等等"，是投放或埋点没通。
const staleNoDataWorkspace = withCharacterWorkspaceDetail(workspace, {
  performance: [{ ...workspace.performance[0], maturity: "insufficient_data" }],
});

const repeatedNoDataWorkspace = withCharacterWorkspaceDetail(workspace, {
  performance: [
    { ...workspace.performance[0], maturity: "insufficient_data" },
    {
      ...workspace.performance[0],
      maturity: "insufficient_data",
      placementId: "character_avatar",
    },
  ],
});

const monitorWorkspace = withCharacterWorkspaceDetail(workspace, {
  releases: [releaseEntry(workspaceRelease({ id: releaseId }))],
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(data: CharacterWorkspaceDetail = workspace) {
  act(() => {
    root.render(
      <AdminI18nProvider locale="zh">
        <PerformancePanel
          data={data}
          permissions={{ writeProject: true } as never}
          runCommittedMutation={(async () => ({ result: undefined, refreshed: false })) as never}
        />
      </AdminI18nProvider>,
    );
  });
}

describe("Character performance panel — zh operators", () => {
  // SPEC: <option> 的 value 必须是后端枚举原值。曾经缺 value 属性，只因当时枚举没有译文才没炸；
  // 一补译文就会把「维持」当决策提交，被 characterPortfolioDecisionSchema 拒掉。
  it("submits the contract enum while showing the translated label", () => {
    render();
    const options = [...container.querySelectorAll<HTMLOptionElement>("select option")]
      .filter((option) => portfolioDecisions.includes(option.value as never));
    expect(options.map((option) => option.value))
      .toEqual([...characterPortfolioDecisionSchema.options]);
    expect(options.map((option) => option.textContent))
      .toEqual(["推广", "维持", "改进", "暂停", "下线"]);
  });

  // SPEC: 「还没有观测」和「观测口径坏了」必须在卡片上一眼分得开——前者等，后者查。
  // 两者以前都渲染成「不可用」，运营无从判断该不该找人。
  it("separates a character with no observations from a broken measurement pipeline", () => {
    render();
    expect(container.textContent).toContain("距发布还不满 7d 观察窗口");
    expect(container.textContent).toContain("暂无表现数据");
    expect(container.textContent).not.toContain("口径异常");
    expect(container.textContent).not.toContain("immature");

    render(brokenPipelineWorkspace);
    expect(container.textContent).toContain("口径异常");
    expect(container.textContent).not.toContain("观察窗口");
  });

  // SPEC: 同样是零观测，窗口没走完只是"等"，窗口走完了就是"查"——卡片必须说得出区别。
  it("escalates zero observations once the whole window has closed", () => {
    render();
    expect(container.textContent).toContain("距发布还不满 7d 观察窗口");
    expect(container.textContent).not.toContain("检查铺位定向与事件上报");

    render(staleNoDataWorkspace);
    expect(container.textContent).toContain("整个 7d 窗口零观测");
    expect(container.textContent).toContain("检查铺位定向与事件上报");
  });

  it("states a repeated no-data diagnosis once above compact metric rows", () => {
    render(repeatedNoDataWorkspace);
    expect(container.textContent?.match(/整个 7d 窗口零观测/g)).toHaveLength(1);
    expect(container.textContent).toContain("暂无表现数据");
    expect(container.textContent).toContain("正在监控 2 个窗口");
    expect(container.querySelectorAll("article")).toHaveLength(0);
  });

  it("shows metric rows only after real observation data arrives", () => {
    expect(characterPerformanceHasObservations(workspace.performance)).toBe(false);
    expect(characterPerformanceHasObservations([
      { ...workspace.performance[0], sampleSize: 1 },
    ])).toBe(true);
  });

  it("seeds the decision record with translated prose instead of English", () => {
    render();
    const textareas = [...container.querySelectorAll("textarea")].map((node) => node.value);
    expect(textareas.some((value) => value.includes("这个角色应该怎么处理"))).toBe(true);
    expect(textareas.some((value) => value.includes("同角色 D7 退化"))).toBe(true);
  });

  // SPEC: 护栏卡的窗口名由 route_qualification 拼出来，状态是枚举，两处都曾漏翻成
  // 「route qualification 护栏 / not required」——中英混排就出现在运营最常看的这一屏。
  it("translates the release guardrail window and its empty status", () => {
    act(() => {
      root.render(
        <AdminI18nProvider locale="zh">
          <MonitorPanel
            data={monitorWorkspace}
            onOpenVisual={() => undefined}
            permissions={{ reviewRelease: true } as never}
            runCommittedMutation={(async () => ({ result: undefined, refreshed: false })) as never}
          />
        </AdminI18nProvider>,
      );
    });
    expect(container.textContent).toContain("图片线路资格");
    expect(container.textContent).toContain("无需处理");
    expect(container.textContent).not.toContain("route qualification");
    expect(container.textContent).not.toContain("not required");
  });
});
