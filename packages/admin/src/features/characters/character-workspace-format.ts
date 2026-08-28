/**
 * SPEC: 角色域独有的两条展示口径 —— 通用的（日期、时长、梦币）在 ui/format.tsx。
 * INTENT: 它们各自只有几行，但两边的面板必须给出同一个答案 —— 详情页的「线上版本」和发布页的
 *         回滚下拉曾经各算各的序号，同一个版本出现两种叫法。
 */

import type { CharacterWorkspaceDetail } from "@idream/shared/admin";

export function percent(value: number | null) {
  return value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
}

// SPEC: 线上版本与当前草稿没有差异、也没有候选 Release 时，发布链路已经闭合。
// INTENT: 这不是“准备工作不完整”；继续要求运营再提 Release 只会制造无效劳动。
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
