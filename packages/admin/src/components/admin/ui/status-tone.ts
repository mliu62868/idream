// SPEC: 状态字符串 → 视觉基调。红色只留给真错误（spec §4.1）。
// SPEC: 全后台只有这一张表。StatusPill（内容/生成/账务列表）与 WorkspaceUi 的 StatusBadge
//       （案件/事件队列）都从这里取色。
// INTENT: 曾经有两张表：WorkspaceUi 自带一份四档私有映射，neutral 是**蓝色**，而且不认识
//         approved / active / succeeded —— 同一个 active，Placements 页是绿的、Cases 页是蓝的。
//         下面的词表是两份的并集；删词等于让某个页面的状态回退成灰色，不要删。
export type StatusTone = "success" | "pending" | "danger" | "info" | "neutral";

const TONE_BY_STATUS: Record<string, StatusTone> = {
  approved: "success", active: "success", published: "success",
  succeeded: "success", ready: "success", enabled: "success",
  // 队列侧的"办完了"：合规通过、事件收敛、案件关闭。
  passed: "success", resolved: "success", closed: "success",
  draft: "pending", pending: "pending", in_review: "pending",
  queued: "pending", paused: "pending", submitted: "pending", generated: "pending",
  // 队列侧的"该看一眼但还不是错误"：优先级偏高、刚检出、超时未处理、缓解中。
  high: "pending", detected: "pending", overdue: "pending", mitigating: "pending",
  failed: "danger", rejected: "danger", removed: "danger", blocked: "danger",
  critical: "danger", urgent: "danger", overridden: "danger",
  running: "info", processing: "info", generating: "info",
  archived: "neutral", disabled: "neutral",
};

export function statusTone(status: string): StatusTone {
  return TONE_BY_STATUS[status.toLowerCase()] ?? "neutral";
}

// SPEC: tone 的类名也只有一份 —— 两个徽章组件形状不同（pill 是圆角胶囊、badge 是方角），
//       但颜色语义必须逐字相同。
export const STATUS_TONE_CLASS: Record<StatusTone, string> = {
  success: "bg-[var(--ad-green-bg)] text-[var(--ad-green-text)]",
  pending: "bg-[var(--ad-yellow-bg)] text-[var(--ad-yellow-text)]",
  danger: "bg-[var(--ad-red-bg)] text-[var(--ad-red-text)]",
  info: "bg-[var(--ad-blue-bg)] text-[var(--ad-blue-text)]",
  neutral: "bg-black/[0.05] text-[var(--ad-text-muted)]",
};
