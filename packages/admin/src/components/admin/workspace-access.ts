import type { AdminPermissionKey } from "@idream/shared/admin/permissions";

// SPEC: 导航项到权限的映射，admin 独有。
// INTENT: 曾住在 @idream/shared —— 但它只有 admin 一个消费者，是「放错包的模块」而非跨服务契约。
// 权限 key 本身仍是 shared 的（main 侧签发、admin 侧消费），只有这张映射表归 admin。
export const ADMIN_V2_WORKSPACE_ACCESS = {
  today: { allOf: ["dashboard.read"] },
  character_workspace: { allOf: ["character.project.read", "character.release.read", "character.performance.read"] },
  character_performance: { allOf: ["character.performance.read"] },
  creative_runs: { allOf: ["creative.run.read"] },
  customers: { allOf: ["customer.read"] },
  cases: { allOf: ["case.read"] },
  experiments: { allOf: ["experiment.manage"] },
  incidents: { allOf: ["ops.incident.read"] },
  generation_jobs: { allOf: ["generation.job.read"] },
  metrics: { allOf: ["analytics.metric.read"] },
} as const satisfies Record<string, { readonly allOf: readonly AdminPermissionKey[] }>;

export type AdminV2WorkspaceAccessKey = keyof typeof ADMIN_V2_WORKSPACE_ACCESS;
