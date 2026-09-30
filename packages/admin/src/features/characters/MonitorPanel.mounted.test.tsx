// @vitest-environment happy-dom

import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminI18nProvider } from "@/components/admin/i18n";
import {
  characterWorkspaceDetail,
  withCharacterWorkspaceDetail,
} from "./character-workspace-fixture";
import { MonitorPanel } from "./MonitorPanel";
import { characterMonitorNeedsAttention } from "./character-workspace-format";
import { characterWorkspacePermissions, type RunCommittedCharacterMutation } from "./character-workspace-permissions";

type WorkspaceRelease = CharacterWorkspaceDetail["releases"][number]["release"];

// SPEC: 完整的 release 投影；用例只覆盖自己关心的字段。
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

const releaseId = "editorial-release:alexa-reeves:a5c8ca4f";

const workspace = characterWorkspaceDetail({
  character: { id: "alexa-reeves" },
  serving: { state: "live", currentReleaseId: releaseId },
  releases: [{ release: workspaceRelease({ id: releaseId }), checks: [], monitors: [] }],
});

const monitorWorkspace = withCharacterWorkspaceDetail(workspace, {
  releases: [{ release: workspaceRelease({ id: releaseId }), checks: [], monitors: [] }],
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

describe("Character release monitor — zh operators", () => {
  it("shows failed checks before raw evidence, preserves nested facts, and navigates to review without a write", () => {
    const monitored = withCharacterWorkspaceDetail(monitorWorkspace, {
      releases: [{
        release: workspaceRelease({ id: releaseId }), checks: [], monitors: [{
          id: "monitor-24h", window: "24h", status: "action_required",
          baseline: { releaseId: "previous-release" },
          observed: {
            uniqueUsers: 0, exchangeCount: 0, generationCount: 0, failedGenerations: 0,
            generationFailureRate: null, latencyP95Ms: null,
            operationalChecks: { releaseReadinessReady: true, servingProjectionLive: false },
            releaseAssetSlots: { character_avatar: { assetId: "avatar-9", renderable: true } },
          },
          verification: { recommendation: "rollback_review", asOf: "2026-09-13T12:00:00.000Z" },
          startedAt: "2026-09-12T12:00:00.000Z", finishedAt: null,
        }],
      }],
    });
    const openRelease = vi.fn();
    const runMutation: RunCommittedCharacterMutation = vi.fn(async () => { throw new Error("Unexpected write"); });
    act(() => root.render(
      <AdminI18nProvider locale="zh">
        <MonitorPanel data={monitored} onOpenVisual={() => undefined} onOpenRelease={openRelease}
          permissions={characterWorkspacePermissions(new Set(), false)} runCommittedMutation={runMutation} />
      </AdminI18nProvider>,
    ));
    expect(characterMonitorNeedsAttention(monitored)).toBe(true);
    expect(container.textContent).toContain("2 项运营检查中 1 项通过");
    expect(container.textContent).toContain("客户可用的角色状态");
    expect(container.textContent).not.toContain("[object Object]");
    expect(container.textContent).not.toContain("rollback_review先");
    const raw = container.querySelector("pre");
    expect(raw?.textContent).toContain("avatar-9");
    expect(raw?.textContent).toContain("previous-release");
    expect(raw?.closest("details")?.open).toBe(false);
    const failureRate = [...container.querySelectorAll("dt")].find((label) => label.textContent === "生成失败率");
    expect(failureRate?.nextElementSibling?.textContent).toBe("不可用");
    const review = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "复核发布与回滚");
    act(() => review?.click());
    expect(openRelease).toHaveBeenCalledOnce();
    expect(runMutation).not.toHaveBeenCalled();
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
            onOpenRelease={() => undefined}
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
