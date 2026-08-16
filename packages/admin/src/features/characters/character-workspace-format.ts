/**
 * SPEC: 跨面板共用的两条展示口径。
 * INTENT: 它们各自只有几行，但两边的面板必须给出同一个答案 —— 详情页的「线上版本」和发布页的
 *         回滚下拉曾经各算各的序号，同一个版本出现两种叫法。
 */

export function percent(value: number | null) {
  return value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
}

// SPEC: 毫秒 → 运营读的时长。视频生成预估和媒体操作证据表用的是同一条口径。
// INTENT: 两边各写过一份实现，其中一份不夹 0（负数会渲染成 "-3s"）。
export function formatDurationMs(durationMs: number) {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

// SPEC: 发布卡片与回滚下拉必须让运营一眼分辨"哪个更新"。
// INTENT: CharacterRelease.version 是行级乐观锁计数（每次改动 +1），不是发布序号——
// 直接渲染成 "Release v{version}" 会出现"v2 比 v1 更早发布"这种读反的顺序。
// 这里按发布时间给出单调递增的序号；version 仍用于命令的并发校验，只在技术证据里出现。
export function characterReleaseOrdinals(
  items: readonly { readonly release: { id: string; publishedAt: string | null; createdAt: string } }[],
) {
  const stamp = (release: { publishedAt: string | null; createdAt: string }) =>
    Date.parse(release.publishedAt ?? release.createdAt);
  return new Map(
    [...items]
      .sort((left, right) => stamp(left.release) - stamp(right.release))
      .map((item, index) => [item.release.id, index + 1] as const),
  );
}
