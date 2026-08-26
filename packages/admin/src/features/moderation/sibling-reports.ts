// SPEC: 把当前这页举报按「同一个被举报对象」分组，算出每条举报还有几条同目标的兄弟。
// INTENT: `POST /api/v1/reports` 匿名可提交且不去重（service.ts:692 的注释写明了这是已知设计），
//         实测（已排除队友审计探针后）`feed_item:character:lola-moonstruck` 有 3 条举报，
//         全部来自**同一个人**——一次投诉在队列里变成三份独立的活。
//         而 `POST /api/v2/admin/moderation/reports/:id/decision` 只改 reportId 这一条
//         （moderation/decision.ts:230-240），`actioned` 时却调 applyModerationAction(targetType,
//         targetId) 把**整个目标**处置掉。于是同目标的剩余举报仍然躺在队列里、看不出已经被处置过，
//         审核员几分钟后再点开一条，会对着一个已经下架的对象重新裁决——两条互相矛盾的审计记录
//         落在同一个 targetId 上，实测无人拦得住。
// INVARIANT: 这份分组**只覆盖已加载的这一页**。队列是游标分页的，前端拿不到全量计数，
//            所以文案必须说「本页」，不许说成"共有 N 条"。凭空放大一个数字，比不给这个信号更糟。

export type SiblingReportRow = {
  readonly id?: unknown;
  readonly targetType?: unknown;
  readonly targetId?: unknown;
};

/** 同目标分组的键。targetType 与 targetId 都为空的行不参与分组——那是坏数据，不是"同一个目标"。 */
function targetKey(row: SiblingReportRow) {
  const type = typeof row.targetType === "string" ? row.targetType : "";
  const id = typeof row.targetId === "string" ? row.targetId : "";
  return type || id ? `${type}:${id}` : "";
}

/**
 * 返回 reportId → 本页同目标的**其他**举报条数。
 * 只收录 >0 的条目，调用点据此决定要不要画那个提示。
 */
export function siblingReportCounts(rows: readonly SiblingReportRow[]): ReadonlyMap<string, number> {
  const byTarget = new Map<string, string[]>();
  for (const row of rows) {
    const key = targetKey(row);
    if (!key) continue;
    const id = typeof row.id === "string" ? row.id : "";
    if (!id) continue;
    const bucket = byTarget.get(key);
    if (bucket) bucket.push(id);
    else byTarget.set(key, [id]);
  }
  const counts = new Map<string, number>();
  for (const ids of byTarget.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) counts.set(id, ids.length - 1);
  }
  return counts;
}
