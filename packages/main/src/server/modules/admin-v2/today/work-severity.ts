import { Prisma } from "@prisma/client";
import type { TodaySourceType, TodayWorkItem } from "@idream/shared/admin";
import { caseSeverityForPriority } from "@/server/modules/admin-v2/cases/case-severity";

export type WorkSeverity = TodayWorkItem["severity"];

// SPEC: 「一条 Today 工作项有多紧急」这个判断，每个来源只在这个文件里表达一次。
//
// INTENT: 此前每个来源要把同一条规则写三遍 —— SQL 排序用的 severity_rank、按紧急度选行的
// WHERE 谓词、以及 projectRow 里的 TS 三段式。选行走 SQL / Prisma，投影走 TS，两侧只要有
// 一处对不上，All Work 就会同时给出两个互相矛盾的答案：totalCount 来自 SQL count，items
// 来自 TS 过滤后的结果，页面显示「共 N 条」却一条也翻不出来（或反过来，翻得出来的比宣称的多）。
//
// SQL 与 TS 无法归一成一份代码，能做到的是归一成同一个字面量：每条规则的两种表达写在相邻
// 几行，且「按紧急度选行」一律由 rank 相等推导，不再手抄第三份谓词 —— character_release
// 此前那份手抄谓词有四个分支，和 rank 表达式对着改才不会漂。
//
// INVARIANT: rankSql 的取值域必须是 SEVERITY_RANK；of() 与 where() 都由同一条规则派生。
export const SEVERITY_RANK = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
} as const satisfies Record<WorkSeverity, number>;

/** rank 是 SQL 里的整型字面量而不是绑定参数：`CASE ... THEN $1` 在 ORDER BY 位置推不出类型。 */
function rank(severity: WorkSeverity) {
  return Prisma.raw(String(SEVERITY_RANK[severity]));
}

/** `AND <rank 表达式> = <rank>`：过滤是 rank 的逆，不是另写一份谓词。 */
export function severityRankFilterSql(rankSql: Prisma.Sql, severity: WorkSeverity | undefined) {
  return severity ? Prisma.sql`AND (${rankSql}) = ${rank(severity)}` : Prisma.empty;
}

export const CASE_SEVERITY = {
  of(row: { readonly priority: string }): WorkSeverity {
    return caseSeverityForPriority(row.priority);
  },
  rankSql(table: Prisma.Sql) {
    return Prisma.sql`CASE ${table}.priority
      WHEN 'urgent' THEN ${rank("critical")}
      WHEN 'high' THEN ${rank("high")}
      WHEN 'low' THEN ${rank("low")}
      ELSE ${rank("medium")} END`;
  },
  where(severity: WorkSeverity): Prisma.AdminCaseWhereInput {
    if (severity === "critical") return { priority: "urgent" };
    if (severity === "high") return { priority: "high" };
    if (severity === "low") return { priority: "low" };
    return { priority: { notIn: ["urgent", "high", "low"] } };
  },
} as const;

export const INCIDENT_SEVERITY = {
  of(row: { readonly severity: string }): WorkSeverity {
    if (row.severity === "critical" || row.severity === "high" || row.severity === "low") {
      return row.severity;
    }
    return "medium";
  },
  rankSql(table: Prisma.Sql) {
    return Prisma.sql`CASE ${table}.severity
      WHEN 'critical' THEN ${rank("critical")}
      WHEN 'high' THEN ${rank("high")}
      WHEN 'low' THEN ${rank("low")}
      ELSE ${rank("medium")} END`;
  },
} as const;

export const CREATIVE_RUN_SEVERITY = {
  of(row: { readonly verificationState: string }): WorkSeverity {
    return row.verificationState === "failed" ? "high" : "medium";
  },
  rankSql(table: Prisma.Sql) {
    return Prisma.sql`CASE WHEN ${table}."verificationState" = 'failed'
      THEN ${rank("high")} ELSE ${rank("medium")} END`;
  },
  /** null 表示这个来源不可能是该紧急度，调用方应当直接不查它。 */
  where(severity: WorkSeverity): Prisma.ContentProductionBatchWhereInput | null {
    if (severity === "high") return { verificationState: "failed" };
    if (severity === "medium") return { verificationState: { not: "failed" } };
    return null;
  },
} as const;

/** 「这个 Release 需要运营介入」既进紧急度，也决定它是否仍然入队，所以是同一条规则的一部分。 */
export function releaseMonitorActionSql(table: Prisma.Sql) {
  return Prisma.sql`
    EXISTS (
      SELECT 1
      FROM "release_monitors" monitor
      JOIN "character_serving" serving ON serving."currentReleaseId" = ${table}.id
      WHERE monitor."releaseId" = ${table}.id
        AND (
          monitor.status = 'action_required'
          OR monitor.verification ->> 'recommendation' = 'rollback_review'
        )
    )
  `;
}

export const RELEASE_SEVERITY = {
  of(row: { readonly readiness: string; readonly monitorActionRequired: boolean }): WorkSeverity {
    if (row.monitorActionRequired || row.readiness === "blocked") return "high";
    return row.readiness === "stale" ? "medium" : "low";
  },
  rankSql(table: Prisma.Sql) {
    return Prisma.sql`CASE
      WHEN ${releaseMonitorActionSql(table)} OR ${table}.readiness = 'blocked' THEN ${rank("high")}
      WHEN ${table}.readiness = 'stale' THEN ${rank("medium")}
      ELSE ${rank("low")} END`;
  },
} as const;

/** 这些 command 状态算失败：verificationState 与紧急度都从这一个集合推。 */
export const COMMAND_FAILED_STATUSES = ["failed", "cancelled"] as const;

export const COMMAND_SEVERITY = {
  of(row: { readonly status: string }): WorkSeverity {
    return COMMAND_FAILED_STATUSES.includes(row.status as typeof COMMAND_FAILED_STATUSES[number])
      ? "high"
      : "medium";
  },
} as const;

/**
 * character_project 只作为 @提及 的目标出现，没有自己的队列，但它的紧急度同样此前 SQL / TS
 * 各写一份。
 */
export const CHARACTER_PROJECT_MENTION_SEVERITY = {
  of(row: { readonly plannedLaunchAt: Date | null }, now: Date): WorkSeverity {
    return row.plannedLaunchAt && row.plannedLaunchAt <= now ? "high" : "medium";
  },
  rankSql(table: Prisma.Sql, now: Date) {
    return Prisma.sql`CASE WHEN ${table}."plannedLaunchAt" <= ${now}
      THEN ${rank("high")} ELSE ${rank("medium")} END`;
  },
} as const;

/**
 * 只为编译期完整性：新增一个 TodaySourceType 而不声明它的紧急度规则是编译错误。
 * collaboration_mention 没有自己的紧急度 —— 它照抄被提及对象的，故显式记为 inherited。
 */
export const WORK_SOURCE_SEVERITY: Record<TodaySourceType, { readonly kind: "own" | "inherited" }> = {
  admin_case: { kind: "own" },
  ops_incident: { kind: "own" },
  control_plane_command: { kind: "own" },
  character_release: { kind: "own" },
  creative_run: { kind: "own" },
  collaboration_mention: { kind: "inherited" },
};
