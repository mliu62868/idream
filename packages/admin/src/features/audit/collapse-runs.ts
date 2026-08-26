// SPEC: 把「与上一条完全同类」的相邻审计条目折掉，只留每一串里的第一条。
// INTENT: 一次批量操作会往审计日志里写几十条只有 ID 和毫秒不同的记录。实测首屏十几行全是
//         同一个 `character.image_readiness.repaired` / 同一个 system 操作人 / 同一句 reason
//         ——运营翻不到别的事件，日志的价值正好被它自己淹掉。
// INTENT: 只折叠**相邻**的，不跨页、不重排序。审计日志的价值就在那条时间线上，
//         一旦按 key 分组重排，"这件事发生在那件事之后"就读不出来了。
// INVARIANT: 这是纯展示层的过滤。总条数、游标翻页与 CSV 导出仍按权威返回的原始条数走 ——
//            折叠让人看得见，不让人少拿数据。

export type AuditRunRecord = {
  readonly action?: unknown;
  readonly actorId?: unknown;
  readonly reason?: unknown;
  readonly targetType?: unknown;
};

/**
 * 同类的定义：谁、做了什么、为什么、对哪一类目标。
 * 目标 ID 与时间刻意不进签名——一次批量操作正是"同一个动作打在一批目标上"。
 */
function signature(record: AuditRunRecord) {
  return [record.action, record.actorId, record.reason, record.targetType]
    .map((part) => (typeof part === "string" ? part : ""))
    .join("\0");
}

export function collapseAuditRuns<T extends AuditRunRecord>(
  records: readonly T[],
): { visible: T[]; hidden: number } {
  const visible: T[] = [];
  let previous: string | null = null;
  let hidden = 0;
  for (const record of records) {
    const current = signature(record);
    // 空签名（三个字段都缺）不参与折叠——那说明这条记录本身信息不全，不该被当成重复吞掉。
    if (previous !== null && current === previous && current.replaceAll("\0", "") !== "") {
      hidden += 1;
      continue;
    }
    visible.push(record);
    previous = current;
  }
  return { visible, hidden };
}
