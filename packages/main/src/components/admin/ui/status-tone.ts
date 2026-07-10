// SPEC: 状态字符串 → 视觉基调。红色只留给真错误（spec §4.1）。
export type StatusTone = "success" | "pending" | "danger" | "info" | "neutral";

const TONE_BY_STATUS: Record<string, StatusTone> = {
  approved: "success", active: "success", published: "success",
  succeeded: "success", ready: "success", enabled: "success",
  draft: "pending", pending: "pending", in_review: "pending",
  queued: "pending", paused: "pending", submitted: "pending",
  failed: "danger", rejected: "danger", removed: "danger", blocked: "danger",
  running: "info", processing: "info", generating: "info",
  archived: "neutral", disabled: "neutral",
};

export function statusTone(status: string): StatusTone {
  return TONE_BY_STATUS[status.toLowerCase()] ?? "neutral";
}
