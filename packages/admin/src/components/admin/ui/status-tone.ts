// SPEC: 状态字符串 → 视觉基调。红色只留给真错误与否决结果（spec §4.1）。
// INVARIANT: 这是全后台唯一一张状态色表 —— StatusPill 和 StatusBadge 共用它。
//   合并前 features/operations/WorkspaceUi.tsx 里另有一张 4 档私表，它的 neutral 渲染成蓝色，
//   而这里的 neutral 是灰色；于是同一个 active 在 Placements 页是绿的、在 Cases 页是蓝的，
//   并且它不认识 approved / succeeded 等词，一律静默落到蓝色。
// INVARIANT: 只收录在 packages/shared/src/admin/contracts 的契约、或界面里真实渲染过的状态词。
//   每组上方的注释就是来源。查不到来源的词不要加 —— 让它落到 neutral 比编一个色档诚实。
export type StatusTone = "success" | "pending" | "danger" | "info" | "neutral";

const TONE_BY_STATUS: Record<string, StatusTone> = {
  // 完成 / 在线 / 通过。来源：characters-release.ts characterReleaseStatusSchema、
  // jobs.ts generationJobStatusSchema + generationDeliveryStatusSchema、
  // cases.ts operationsCaseStatusSchema、incidents.ts incidentStatusSchema、
  // support.ts supportRequestStatusSchema、common.ts adminVerificationStateSchema、
  // characters-common.ts characterServingStateSchema、moderation/safety-gateway.ts ModerationStatus。
  approved: "success", active: "success", published: "success", succeeded: "success",
  ready: "success", enabled: "success", passed: "success", resolved: "success",
  closed: "success", completed: "success", live: "success", delivered: "success",
  // characters-performance.ts characterProductionJourneySchema 的 steps[].state。
  // 跟 completed 同义但拼写不同 —— 五步进度条用的是 complete。
  complete: "success",
  // ReleasePanel.tsx 的 <StatusBadge tone="good" value="serving now" />：界面字面量，没有契约背书，
  // 但它确实会渲染。表里认下来，那个写死的 tone 才有机会拿掉。
  "serving now": "success",

  // 在等人、等时间，或需要有人看一眼。来源：cases.ts operationsCaseStatusSchema、
  // today.ts todaySourceStatusSchema、common.ts adminControlPlaneCommandStatusSchema +
  // adminSeveritySchema + adminReadinessSchema、incidents.ts incidentStatusSchema、
  // support.ts supportSlaStateSchema、jobs.ts generationRequestOutcomeSchema +
  // generationAttemptStatusSchema、creative.ts creativeRunItemExecutionStateSchema +
  // creativeRunItemStatusSchema + creativeExecutionOutcomeSchema、
  // characters-release.ts 发布检查 result、cases.ts CONTENT_REPORT_CASE_DECISIONS、
  // chat-operations.ts 消息安全筛选。
  draft: "pending", pending: "pending", in_review: "pending", queued: "pending",
  paused: "pending", submitted: "pending", generated: "pending", new: "pending",
  triaged: "pending", in_progress: "pending", waiting: "pending", reopened: "pending",
  accepted: "pending", provider_queued: "pending", detected: "pending", mitigating: "pending",
  overdue: "pending", due_soon: "pending", high: "pending", unknown: "pending",
  stale: "pending", flagged: "pending", escalated: "pending",
  partially_succeeded: "pending", needs_reconciliation: "pending",

  // 真错误、否决与强制处置。来源：jobs.ts generationJobStatusSchema、
  // common.ts adminSeveritySchema（critical）+ adminPrioritySchema（urgent）+
  // adminVerificationStateSchema（overridden）、access.ts accessUserStatusSchema、
  // characters-release.ts 发布检查 result（blocked）。
  failed: "danger", rejected: "danger", removed: "danger", blocked: "danger",
  critical: "danger", urgent: "danger", overridden: "danger",
  suspended: "danger", deleted: "danger",

  // 正在跑。来源：common.ts adminControlPlaneCommandStatusSchema、
  // incidents.ts incidentStatusSchema（monitoring）、
  // characters-release.ts characterReleaseStatusSchema（validating）、
  // creative.ts creativeRunItemExecutionStateSchema（dispatching / finalizing）。
  running: "info", processing: "info", generating: "info", dispatching: "info",
  monitoring: "info", verifying: "info", validating: "info", finalizing: "info",
  // characters-performance.ts 的 steps[].state：current = 运营此刻正站在这一步。
  current: "info",

  // 终态，且没人需要为它做什么。来源：characters-release.ts characterReleaseStatusSchema、
  // jobs.ts generationJobStatusSchema + generationArtifactArchiveStateSchema、
  // billing.ts 订阅状态（canceled，单 l）、grant-bundles.ts 授权状态、
  // characters-common.ts characterServingStateSchema、incidents.ts incidentStatusSchema、
  // characters-media-operations.ts 语音重采 status（skipped）。
  // cancelled / canceled 两种拼写在仓库里同时存在且都是真的：jobs.ts 用双 l，billing.ts 与
  // ApprovalsWorkspace 的筛选器用单 l。两个都收，免得其中一半悄悄变灰又变蓝。
  archived: "neutral", disabled: "neutral", superseded: "neutral", withdrawn: "neutral",
  cancelled: "neutral", canceled: "neutral", expired: "neutral", inactive: "neutral",
  retired: "neutral", duplicate: "neutral", merged: "neutral", skipped: "neutral",
  // characters-performance.ts 的 steps[].state：upcoming 还没轮到，没人需要为它做什么。
  // 它跟兜底同为 neutral，但收进表里才分得清"认识它、判定为无事"和"不认识它"——
  // 那正是这条 SEAM 要修的东西：五步状态机里三个值全部走的是后者。
  upcoming: "neutral",
};

export function statusTone(status: string): StatusTone {
  return TONE_BY_STATUS[status.toLowerCase()] ?? "neutral";
}

// SPEC: 色档 → Tailwind 类。形状（圆角、字号、大小写）由各组件自己决定，颜色只有这一处。
export const STATUS_TONE_CLASS: Record<StatusTone, string> = {
  success: "bg-[var(--ad-green-bg)] text-[var(--ad-green-text)]",
  pending: "bg-[var(--ad-yellow-bg)] text-[var(--ad-yellow-text)]",
  danger: "bg-[var(--ad-red-bg)] text-[var(--ad-red-text)]",
  info: "bg-[var(--ad-blue-bg)] text-[var(--ad-blue-text)]",
  neutral: "bg-black/[0.05] text-[var(--ad-text-muted)]",
};
