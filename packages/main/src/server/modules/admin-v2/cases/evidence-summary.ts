function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function caseEvidenceSummary(sourceType: string, snapshot: Record<string, unknown>): string {
  const text = (key: string) => typeof snapshot[key] === "string" ? snapshot[key].trim() : "";
  const description = text("description") || text("appealText") || text("body") || text("resolutionNotes");
  if (description) return [text("subject"), description].filter(Boolean).join("\n\n");
  if (sourceType === "dreamcoin_ledger") {
    return `梦币变动：${typeof snapshot.delta === "number" ? snapshot.delta : "未知"}；变动后余额：${typeof snapshot.balanceAfter === "number" ? snapshot.balanceAfter : "未知"}。${text("reason")}`;
  }
  if (sourceType === "subscription_snapshot") {
    const plan = object(snapshot.plan);
    return `订阅：${typeof plan.name === "string" ? plan.name : "未记录方案"}；状态：${text("status") || "未记录"}；本期截止：${text("currentPeriodEnd") || "未记录"}。${snapshot.cancelAtPeriodEnd === true ? "已安排到期取消。" : ""}`;
  }
  if (sourceType === "case_resolution") {
    const resolution = object(snapshot.resolution);
    return typeof resolution.summary === "string" && resolution.summary.trim() ? resolution.summary : "此工单之前的解决结果已保留，可用于核对本次复发。";
  }
  if (sourceType === "case_recurrence") return "此问题在上一轮处理结束后再次出现，已关联前一轮工单。";
  if (sourceType === "support_resolution") return `支持请求处理结果：${text("sourceStatus") || "未记录详细说明"}。`;
  return text("subject") || "来源已记录，但没有提供可阅读的说明；可展开来源详情追溯。";
}
