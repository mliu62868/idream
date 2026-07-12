import type { AdminPermissionKey } from "./permissions";

/** Lightweight client-safe subset of the Admin v2 authority manifest. */
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
