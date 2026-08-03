// SPEC: 一条 AdminCase 的紧急度由它的 priority 推出，规则只写在这里。
// INTENT: 这条规则此前有两份逐字相同的实现 —— cases/service.ts 在 backfill 时把它写进
// `resolution.severity` 持久化，Today 队列在排序/投影时又算了一遍。两份不一致时，同一个
// case 的结案记录说 critical、运营队列却按 high 排，从结果上分不出哪个是对的。
export type CaseSeverity = "critical" | "high" | "medium" | "low";

export function caseSeverityForPriority(priority: string): CaseSeverity {
  if (priority === "urgent") return "critical";
  if (priority === "high") return "high";
  if (priority === "low") return "low";
  return "medium";
}
