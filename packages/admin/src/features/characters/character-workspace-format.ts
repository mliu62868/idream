/**
 * SPEC: 角色域共用的展示判断；通用日期、时长、梦币在 ui/format.tsx。
 * INTENT: 详情、监控与发布面板必须对同一个版本给出一致的状态和称呼。
 */

import type { CharacterWorkspaceDetail } from "@idream/shared/admin";

export function characterReleaseMonitorNeedsAttention(
  monitor: CharacterWorkspaceDetail["releases"][number]["monitors"][number],
) {
  return monitor.status === "action_required" || monitor.verification.recommendation === "rollback_review";
}

// INVARIANT: 历史版本的告警不能触发当前线上版本的处置入口。
export function characterMonitorNeedsAttention(
  data: Pick<CharacterWorkspaceDetail, "serving" | "releases">,
) {
  return data.releases.find(({ release }) => release.id === data.serving?.currentReleaseId)
    ?.monitors.some(characterReleaseMonitorNeedsAttention) ?? false;
}

// A paused or retired character can have published history without a live preview.
export function characterHasPublishedRelease(
  data: Pick<CharacterWorkspaceDetail, "journey" | "preview" | "releases">,
) {
  return Boolean(data.preview.live || data.journey.release.currentReleaseId) ||
    data.releases.some(({ release }) => release.status === "published" || release.publishedAt !== null);
}

export function percent(value: number | null) {
  return value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
}

// SPEC: 线上版本与当前草稿没有差异、也没有候选 Release 时，没有待发布的内容修改。
// INVARIANT: 内容一致不证明运行资格仍有效；发布面板独立处理 current Release stale。
export function characterHasNoUnpublishedChanges(
  data: Pick<CharacterWorkspaceDetail, "journey" | "preview">,
) {
  return (
    Boolean(data.preview.live) &&
    data.preview.changedFields.length === 0 &&
    data.journey.release.candidateReleaseId === null
  );
}

// SPEC: 发布卡片与回滚下拉必须让运营一眼分辨"哪个更新"。
// INTENT: CharacterRelease.version 是行级乐观锁计数（每次改动 +1），不是发布序号——
// 直接渲染成 "Release v{version}" 会出现"v2 比 v1 更早发布"这种读反的顺序。
// 这里按发布时间给出单调递增的序号；version 仍用于命令的并发校验，只在技术证据里出现。
export function characterReleaseOrdinals(
  items: readonly {
    readonly release: {
      id: string;
      publishedAt: string | null;
      createdAt: string;
    };
  }[],
) {
  const stamp = (release: { publishedAt: string | null; createdAt: string }) =>
    Date.parse(release.publishedAt ?? release.createdAt);
  return new Map(
    [...items]
      .sort((left, right) => stamp(left.release) - stamp(right.release))
      .map((item, index) => [item.release.id, index + 1] as const),
  );
}
