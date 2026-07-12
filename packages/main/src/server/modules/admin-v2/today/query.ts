import {
  todayProjectionSchema,
  type AdminPermissionKey,
  type TodayProjection,
  type TodayWorkMode,
  type TodayWorkItem,
} from "@idream/shared/admin";
import { Prisma } from "@prisma/client";
import type {
  AdminCollaborationActivity,
  AdminCase,
  CharacterRelease,
  ContentProductionBatch,
  ControlPlaneCommand,
  OpsIncident,
  PrismaClient,
} from "@prisma/client";
import { effectivePermissions } from "@/server/admin/effective-permissions";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { AppError } from "@/server/lib/errors";
import { fail, ok } from "@/server/lib/http";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";

const QUEUE_LIMIT = 10;
const RANKING_POLICY_VERSION = "today-ranking-v1";
const ACTIVE_CASE_STATUSES = ["new", "triaged", "in_progress", "waiting", "reopened"];
const ACTIVE_INCIDENT_STATUSES = ["detected", "triaged", "mitigating", "monitoring"];
const ACTIVE_COMMAND_STATUSES = ["accepted", "running", "verifying", "failed"];
const RESOLVED_CASE_STATUSES = ["resolved", "closed"];
const RESOLVED_INCIDENT_STATUSES = ["resolved", "closed"];
const ACTIVE_RELEASE_STATUSES = ["draft", "validating", "in_review", "approved"];
const RESOLVED_RELEASE_STATUSES = ["published", "superseded", "withdrawn"];

type ProjectableRow =
  | {
      sourceType: "collaboration_mention";
      row: Pick<AdminCollaborationActivity, "id" | "targetType" | "targetId" | "actorId" | "body" | "createdAt">;
      target: {
        label: string;
        deepLink: string;
        severity: TodayWorkItem["severity"];
        priority: TodayWorkItem["priority"];
        impactSnapshot: Record<string, unknown>;
        ownerId: string;
        slaDueAt: Date | null;
        verificationState: TodayWorkItem["verificationState"];
        dataClass: TodayWorkItem["dataClass"];
      };
    }
  | { sourceType: "admin_case"; row: AdminCase }
  | { sourceType: "ops_incident"; row: OpsIncident }
  | { sourceType: "control_plane_command"; row: ControlPlaneCommand }
  | {
      sourceType: "character_release";
      row: CharacterRelease;
      project: { ownerId: string | null; characterId: string; phase: string; plannedLaunchAt: Date | null; version: number };
      monitorActionRequired?: boolean;
    }
  | { sourceType: "creative_run"; row: ContentProductionBatch };

type QueueRows = {
  totalCount: number;
  rows: ProjectableRow[];
};

type ReleaseQueueSelection =
  | {
      scope: "active";
      owner: "all" | { actorId: string } | "unassigned";
      snoozedIds: readonly string[];
    }
  | {
      scope: "recently_resolved";
      recentCutoff: Date;
    }
  | {
      scope: "watching";
      releaseIds: readonly string[];
      projectIds: readonly string[];
    };

type IncidentQueueSelection =
  | {
      scope: "active";
      actor: { id: string; role: string };
      owner: "all" | { actorId: string } | "unassigned";
      dueOrFailedBy?: Date;
      snoozedIds: readonly string[];
    }
  | {
      scope: "recently_resolved";
      actor: { id: string; role: string };
      recentCutoff: Date;
    }
  | {
      scope: "watching";
      actor: { id: string; role: string };
      incidentIds: readonly string[];
    };

type TodayReadDb = PrismaClient | Prisma.TransactionClient;

export type TodaySourceQueryDiagnostic = {
  sourceType: TodayWorkItem["sourceType"];
  lane: string;
  returnedRows: number;
  limit: number;
};

export type TodayQueryDiagnostics = {
  onSourceQuery(event: TodaySourceQueryDiagnostic): void;
};

function recordSourceQuery(
  diagnostics: TodayQueryDiagnostics | undefined,
  sourceType: TodayWorkItem["sourceType"],
  lane: string,
  returnedRows: number,
) {
  diagnostics?.onSourceQuery({ sourceType, lane, returnedRows, limit: QUEUE_LIMIT });
}

function uniqueById<Row extends { id: string }>(rows: readonly Row[]) {
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}

async function findBoundedCaseRows(input: {
  db: TodayReadDb;
  where: Prisma.AdminCaseWhereInput | null;
  pinnedIds: readonly string[];
  diagnostics?: TodayQueryDiagnostics;
}) {
  if (!input.where) return { totalCount: 0, rows: [] as AdminCase[] };
  const priorityLanes: Array<{ lane: string; where: Prisma.AdminCaseWhereInput }> = [
    { lane: "urgent", where: { priority: "urgent" } },
    { lane: "high", where: { priority: "high" } },
    { lane: "normal", where: { priority: { notIn: ["urgent", "high", "low"] } } },
    { lane: "low", where: { priority: "low" } },
  ];
  const readLane = async (lane: typeof priorityLanes[number], pinnedOnly: boolean) => {
    if (pinnedOnly && input.pinnedIds.length === 0) return [];
    const rows = await input.db.adminCase.findMany({
      where: {
        AND: [
          input.where!,
          lane.where,
          ...(pinnedOnly ? [{ id: { in: [...input.pinnedIds] } }] : []),
        ],
      },
      orderBy: [
        { slaDueAt: { sort: "asc", nulls: "last" } },
        { updatedAt: "asc" },
        { id: "asc" },
      ],
      take: QUEUE_LIMIT,
    });
    recordSourceQuery(input.diagnostics, "admin_case", `${pinnedOnly ? "pinned:" : ""}${lane.lane}`, rows.length);
    return rows;
  };
  const [totalCount, ...laneRows] = await Promise.all([
    input.db.adminCase.count({ where: input.where }),
    ...priorityLanes.flatMap((lane) => [readLane(lane, true), readLane(lane, false)]),
  ]);
  return { totalCount, rows: uniqueById(laneRows.flat()) };
}

async function findBoundedIncidentRows(input: {
  db: TodayReadDb;
  selection: IncidentQueueSelection | null;
  pinnedIds: readonly string[];
  diagnostics?: TodayQueryDiagnostics;
}) {
  if (!input.selection) return { totalCount: 0, rows: [] as OpsIncident[] };
  const actor = input.selection.actor;
  const visibilitySql = actor.role === "support"
    ? Prisma.sql`
        AND (
          incident."ownerId" = ${actor.id}
          OR EXISTS (
            SELECT 1
            FROM "ops_incident_occurrences" occurrence
            JOIN "generation_jobs" job ON job.id = occurrence."requestId"
            JOIN "admin_cases" customer_case
              ON customer_case."targetType" = 'user'
              AND customer_case."targetId" = job."userId"
              AND customer_case.type IN ('support_request', 'billing_dispute')
            WHERE occurrence."incidentId" = incident.id
          )
        )
      `
    : Prisma.empty;
  const pinnedRankSql = input.pinnedIds.length > 0
    ? Prisma.sql`CASE WHEN incident.id IN (${Prisma.join(input.pinnedIds)}) THEN 1 ELSE 0 END`
    : Prisma.sql`0`;
  const selectionSql = input.selection.scope === "active"
    ? Prisma.sql`
        AND incident.status IN (${Prisma.join(ACTIVE_INCIDENT_STATUSES)})
        ${input.selection.snoozedIds.length > 0
          ? Prisma.sql`AND incident.id NOT IN (${Prisma.join(input.selection.snoozedIds)})`
          : Prisma.empty}
        ${input.selection.owner === "all"
          ? Prisma.empty
          : input.selection.owner === "unassigned"
            ? Prisma.sql`AND incident."ownerId" IS NULL`
            : Prisma.sql`AND incident."ownerId" = ${input.selection.owner.actorId}`}
        ${input.selection.dueOrFailedBy
          ? Prisma.sql`AND (incident."slaDueAt" <= ${input.selection.dueOrFailedBy} OR incident."verificationState" = 'failed')`
          : Prisma.empty}
      `
    : input.selection.scope === "recently_resolved"
      ? Prisma.sql`
          AND incident.status IN (${Prisma.join(RESOLVED_INCIDENT_STATUSES)})
          AND incident."verificationState" IN ('passed', 'overridden')
          AND incident."updatedAt" >= ${input.selection.recentCutoff}
        `
      : input.selection.incidentIds.length > 0
        ? Prisma.sql`AND incident.id IN (${Prisma.join(input.selection.incidentIds)})`
        : Prisma.sql`AND FALSE`;
  const ranked = await input.db.$queryRaw<Array<{ id: string | null; totalCount: bigint }>>(Prisma.sql`
    WITH eligible AS (
      SELECT
        incident.id,
        ${pinnedRankSql} AS pinned_rank,
        CASE incident.severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'low' THEN 1 ELSE 2 END AS severity_rank,
        incident."slaDueAt" AS due_at,
        incident."updatedAt" AS changed_at
      FROM "ops_incidents" incident
      WHERE TRUE ${visibilitySql} ${selectionSql}
    ), ranked AS (
      SELECT id, row_number() OVER (
        ORDER BY pinned_rank DESC, severity_rank DESC, due_at ASC NULLS LAST, changed_at ASC, id ASC
      ) AS ordinal
      FROM eligible
    ), summary AS (SELECT count(*)::bigint AS total_count FROM eligible)
    SELECT ranked.id, summary.total_count AS "totalCount"
    FROM summary
    LEFT JOIN ranked ON ranked.ordinal <= ${QUEUE_LIMIT}
    ORDER BY ranked.ordinal ASC NULLS LAST
  `);
  const ids = ranked.flatMap((row) => row.id ? [row.id] : []);
  recordSourceQuery(input.diagnostics, "ops_incident", input.selection.scope, ids.length);
  const rows = ids.length > 0
    ? await input.db.opsIncident.findMany({ where: { id: { in: ids } }, take: QUEUE_LIMIT })
    : [];
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  return {
    totalCount: Number(ranked[0]?.totalCount ?? 0),
    rows: ids.flatMap((id) => {
      const row = rowsById.get(id);
      return row ? [row] : [];
    }),
  };
}

async function findBoundedCommandRows(input: {
  db: TodayReadDb;
  where: Prisma.ControlPlaneCommandWhereInput | null;
  pinnedIds: readonly string[];
  diagnostics?: TodayQueryDiagnostics;
}) {
  if (!input.where) return { totalCount: 0, rows: [] as ControlPlaneCommand[] };
  const statusLanes: Array<{ lane: string; where: Prisma.ControlPlaneCommandWhereInput }> = [
    { lane: "failed", where: { status: "failed" } },
    { lane: "non_failed", where: { status: { not: "failed" } } },
  ];
  const readLane = async (lane: typeof statusLanes[number], pinnedOnly: boolean) => {
    if (pinnedOnly && input.pinnedIds.length === 0) return [];
    const rows = await input.db.controlPlaneCommand.findMany({
      where: {
        AND: [
          input.where!,
          lane.where,
          ...(pinnedOnly ? [{ id: { in: [...input.pinnedIds] } }] : []),
        ],
      },
      orderBy: [
        { leaseExpiresAt: { sort: "asc", nulls: "last" } },
        { updatedAt: "asc" },
        { id: "asc" },
      ],
      take: QUEUE_LIMIT,
    });
    recordSourceQuery(input.diagnostics, "control_plane_command", `${pinnedOnly ? "pinned:" : ""}${lane.lane}`, rows.length);
    return rows;
  };
  const [totalCount, ...laneRows] = await Promise.all([
    input.db.controlPlaneCommand.count({ where: input.where }),
    ...statusLanes.flatMap((lane) => [readLane(lane, true), readLane(lane, false)]),
  ]);
  return { totalCount, rows: uniqueById(laneRows.flat()) };
}

async function findBoundedCreativeRows(input: {
  db: TodayReadDb;
  where: Prisma.ContentProductionBatchWhereInput | null;
  pinnedIds: readonly string[];
  diagnostics?: TodayQueryDiagnostics;
}) {
  if (!input.where) return { totalCount: 0, rows: [] as ContentProductionBatch[] };
  const verificationLanes: Array<{ lane: string; where: Prisma.ContentProductionBatchWhereInput }> = [
    { lane: "failed", where: { verificationState: "failed" } },
    { lane: "non_failed", where: { verificationState: { not: "failed" } } },
  ];
  const priorityLanes: Array<{ lane: string; where: Prisma.ContentProductionBatchWhereInput }> = [
    { lane: "urgent", where: { priority: "urgent" } },
    { lane: "high", where: { priority: "high" } },
    { lane: "normal", where: { priority: { notIn: ["urgent", "high", "low"] } } },
    { lane: "low", where: { priority: "low" } },
  ];
  const lanes = verificationLanes.flatMap((verification) => priorityLanes.map((priority) => ({
    lane: `${verification.lane}:${priority.lane}`,
    where: { AND: [verification.where, priority.where] } satisfies Prisma.ContentProductionBatchWhereInput,
  })));
  const readLane = async (lane: typeof lanes[number], pinnedOnly: boolean) => {
    if (pinnedOnly && input.pinnedIds.length === 0) return [];
    const rows = await input.db.contentProductionBatch.findMany({
      where: {
        AND: [
          input.where!,
          lane.where,
          ...(pinnedOnly ? [{ id: { in: [...input.pinnedIds] } }] : []),
        ],
      },
      orderBy: [
        { dueAt: { sort: "asc", nulls: "last" } },
        { updatedAt: "asc" },
        { id: "asc" },
      ],
      take: QUEUE_LIMIT,
    });
    recordSourceQuery(input.diagnostics, "creative_run", `${pinnedOnly ? "pinned:" : ""}${lane.lane}`, rows.length);
    return rows;
  };
  const [totalCount, ...laneRows] = await Promise.all([
    input.db.contentProductionBatch.count({ where: input.where }),
    ...lanes.flatMap((lane) => [readLane(lane, true), readLane(lane, false)]),
  ]);
  return { totalCount, rows: uniqueById(laneRows.flat()) };
}

type RankedReleaseIdRow = {
  id: string | null;
  totalCount: bigint;
  monitorActionRequired: boolean | null;
};

async function findBoundedReleaseRows(input: {
  db: TodayReadDb;
  selection: ReleaseQueueSelection | null;
  pinnedIds: readonly string[];
  diagnostics?: TodayQueryDiagnostics;
}) {
  if (!input.selection) {
    return { totalCount: 0, rows: [] as Array<Extract<ProjectableRow, { sourceType: "character_release" }> extends { row: infer Row; project: infer Project } ? { row: Row; project: Project; monitorActionRequired?: boolean } : never> };
  }
  const ownerSql = input.selection.scope === "active"
    ? input.selection.owner === "all"
      ? Prisma.empty
      : input.selection.owner === "unassigned"
        ? Prisma.sql`AND project."ownerId" IS NULL`
        : Prisma.sql`AND project."ownerId" = ${input.selection.owner.actorId}`
    : Prisma.empty;
  const snoozedSql = input.selection.scope === "active" && input.selection.snoozedIds.length > 0
    ? Prisma.sql`AND release.id NOT IN (${Prisma.join(input.selection.snoozedIds)})`
    : Prisma.empty;
  const pinnedRankSql = input.pinnedIds.length > 0
    ? Prisma.sql`CASE WHEN release.id IN (${Prisma.join(input.pinnedIds)}) THEN 1 ELSE 0 END`
    : Prisma.sql`0`;
  const monitorActionSql = Prisma.sql`
    EXISTS (
      SELECT 1
      FROM "release_monitors" monitor
      JOIN "character_serving" serving ON serving."currentReleaseId" = release.id
      WHERE monitor."releaseId" = release.id
        AND (
          monitor.status = 'action_required'
          OR monitor.verification ->> 'recommendation' = 'rollback_review'
        )
    )
  `;
  const eligibilitySql = input.selection.scope === "active"
    ? Prisma.sql`
        AND (
          release.status IN (${Prisma.join(ACTIVE_RELEASE_STATUSES)})
          OR ${monitorActionSql}
        )
      `
    : input.selection.scope === "recently_resolved"
      ? Prisma.sql`
        AND release.status IN (${Prisma.join(RESOLVED_RELEASE_STATUSES)})
        AND release."updatedAt" >= ${input.selection.recentCutoff}
        AND NOT (${monitorActionSql})
      `
      : input.selection.releaseIds.length === 0 && input.selection.projectIds.length === 0
        ? Prisma.sql`AND FALSE`
        : Prisma.sql`
          AND (
            ${input.selection.releaseIds.length > 0
              ? Prisma.sql`release.id IN (${Prisma.join(input.selection.releaseIds)})`
              : Prisma.sql`FALSE`}
            OR (
              ${input.selection.projectIds.length > 0
                ? Prisma.sql`release."projectId" IN (${Prisma.join(input.selection.projectIds)})`
                : Prisma.sql`FALSE`}
              AND (
                EXISTS (SELECT 1 FROM "character_serving" serving WHERE serving."currentReleaseId" = release.id)
                OR release.id = (
                  SELECT candidate.id
                  FROM "character_releases" candidate
                  WHERE candidate."projectId" = release."projectId"
                    AND candidate.status IN (${Prisma.join(ACTIVE_RELEASE_STATUSES)})
                  ORDER BY candidate."createdAt" DESC, candidate.id DESC
                  LIMIT 1
                )
              )
            )
          )
        `;
  const rankedIds = await input.db.$queryRaw<RankedReleaseIdRow[]>(Prisma.sql`
    WITH eligible AS (
      SELECT
        release.id,
        ${monitorActionSql} AS monitor_action_required,
        ${pinnedRankSql} AS pinned_rank,
        CASE
          WHEN ${monitorActionSql} OR release.readiness = 'blocked' THEN 3
          WHEN release.readiness = 'stale' THEN 2
          ELSE 1
        END AS severity_rank,
        project."plannedLaunchAt" AS due_at,
        release."updatedAt" AS changed_at
      FROM "character_releases" release
      JOIN "character_projects" project ON project.id = release."projectId"
      WHERE TRUE
        ${ownerSql}
        ${snoozedSql}
        ${eligibilitySql}
    ), ranked AS (
      SELECT *, row_number() OVER (
        ORDER BY pinned_rank DESC, severity_rank DESC, due_at ASC NULLS LAST, changed_at ASC, id ASC
      ) AS ordinal
      FROM eligible
    ), summary AS (
      SELECT count(*)::bigint AS total_count FROM eligible
    )
    SELECT
      ranked.id,
      summary.total_count AS "totalCount",
      ranked.monitor_action_required AS "monitorActionRequired"
    FROM summary
    LEFT JOIN ranked ON ranked.ordinal <= ${QUEUE_LIMIT}
    ORDER BY ranked.ordinal ASC NULLS LAST
  `);
  const ids = rankedIds.flatMap((row) => row.id ? [row.id] : []);
  recordSourceQuery(input.diagnostics, "character_release", input.selection.scope, ids.length);
  if (ids.length === 0) {
    return { totalCount: Number(rankedIds[0]?.totalCount ?? 0), rows: [] };
  }
  const releaseRows = await input.db.characterRelease.findMany({
    where: { id: { in: ids } },
    take: QUEUE_LIMIT,
  });
  const projects = await input.db.characterProject.findMany({
    where: { id: { in: releaseRows.map((row) => row.projectId) } },
    select: { id: true, ownerId: true, characterId: true, phase: true, plannedLaunchAt: true, version: true },
    take: QUEUE_LIMIT,
  });
  const releasesById = new Map(releaseRows.map((row) => [row.id, row]));
  const projectsById = new Map(projects.map((row) => [row.id, row]));
  const monitorById = new Map(rankedIds.flatMap((row) => row.id ? [[row.id, Boolean(row.monitorActionRequired)] as const] : []));
  return {
    totalCount: Number(rankedIds[0]?.totalCount ?? 0),
    rows: ids.flatMap((id) => {
      const row = releasesById.get(id);
      const project = row ? projectsById.get(row.projectId) : undefined;
      return row && project ? [{ row, project, monitorActionRequired: monitorById.get(id) ?? false }] : [];
    }),
  };
}

function deploymentEnvironment(): TodayWorkItem["environment"] {
  if (env.APP_ENV === "preview") return "staging";
  return env.APP_ENV;
}

function caseSeverity(priority: string): TodayWorkItem["severity"] {
  if (priority === "urgent") return "critical";
  if (priority === "high") return "high";
  if (priority === "low") return "low";
  return "medium";
}

function normalizePriority(value: string): TodayWorkItem["priority"] {
  if (value === "urgent" || value === "high" || value === "low") return value;
  return "normal";
}

function normalizeSeverity(value: string): TodayWorkItem["severity"] {
  if (value === "critical" || value === "high" || value === "low") return value;
  return "medium";
}

function normalizeVerification(value: string): TodayWorkItem["verificationState"] {
  if (value === "verifying" || value === "passed" || value === "failed" || value === "overridden") {
    return value;
  }
  return "pending";
}

function commandVerification(status: string): TodayWorkItem["verificationState"] {
  if (status === "verifying") return "verifying";
  if (status === "succeeded") return "passed";
  if (status === "failed" || status === "cancelled") return "failed";
  return "pending";
}

function asImpact(value: Prisma.JsonValue | null): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function projectRow(
  row: ProjectableRow,
  pinnedKeys: ReadonlySet<string>,
  permissions: ReadonlySet<AdminPermissionKey> = new Set(),
  preferenceVersions: ReadonlyMap<string, number> = new Map(),
): TodayWorkItem {
  const environment = deploymentEnvironment();
  if (row.sourceType === "collaboration_mention") {
    return {
      sourceType: row.sourceType,
      sourceId: row.row.id,
      title: `Mention on ${row.target.label}`,
      summary: row.row.body?.trim() || `${row.row.actorId} mentioned you`,
      severity: row.target.severity,
      priority: row.target.priority,
      impactSnapshot: {
        ...row.target.impactSnapshot,
        activityId: row.row.id,
        mentionedById: row.row.actorId,
        targetType: row.row.targetType,
        targetId: row.row.targetId,
      },
      ownerId: row.target.ownerId,
      slaDueAt: row.target.slaDueAt?.toISOString() ?? null,
      recommendedAction: "Open the mentioned context and respond or hand off",
      rankingReason: rankingReason(row.target.severity, row.target.slaDueAt, row.row.createdAt),
      deepLink: row.target.deepLink,
      verificationState: row.target.verificationState,
      lastChangedAt: row.row.createdAt.toISOString(),
      environment,
      dataClass: row.target.dataClass,
      pinned: pinnedKeys.has(`${row.sourceType}:${row.row.id}`),
      preferenceVersion: preferenceVersions.get(`${row.sourceType}:${row.row.id}`) ?? 0,
      claim: null,
    };
  }
  if (row.sourceType === "admin_case") {
    const item = row.row;
    return {
      sourceType: row.sourceType,
      sourceId: item.id,
      title: `${item.type.replaceAll("_", " ")} case`,
      summary: `${item.targetType} ${item.targetId} is ${item.status.replaceAll("_", " ")}`,
      severity: caseSeverity(item.priority),
      priority: normalizePriority(item.priority),
      impactSnapshot: { targetType: item.targetType, targetId: item.targetId, caseKey: item.caseKey },
      ownerId: item.ownerId,
      slaDueAt: item.slaDueAt?.toISOString() ?? null,
      recommendedAction: item.verificationState === "failed" ? "Reopen and verify the resolution" : "Review and advance the case",
      rankingReason: rankingReason(caseSeverity(item.priority), item.slaDueAt, item.createdAt),
      deepLink: `/admin/cases/${encodeURIComponent(item.id)}`,
      verificationState: normalizeVerification(item.verificationState),
      lastChangedAt: item.updatedAt.toISOString(),
      environment,
      dataClass: "customer",
      pinned: pinnedKeys.has(`${row.sourceType}:${item.id}`),
      preferenceVersion: preferenceVersions.get(`${row.sourceType}:${item.id}`) ?? 0,
      claim: item.ownerId === null && permissions.has("case.assign") ? { entityVersion: item.version } : null,
    };
  }
  if (row.sourceType === "ops_incident") {
    const item = row.row;
    const severity = normalizeSeverity(item.severity);
    return {
      sourceType: row.sourceType,
      sourceId: item.id,
      title: `${severity} incident: ${item.signature}`,
      summary: item.suspectedCause ?? `Incident is ${item.status}`,
      severity,
      priority: severity === "critical" ? "urgent" : severity === "high" ? "high" : "normal",
      impactSnapshot: asImpact(item.impact),
      ownerId: item.ownerId,
      slaDueAt: item.slaDueAt?.toISOString() ?? null,
      recommendedAction: item.verificationState === "failed" ? "Resume mitigation and recovery verification" : "Follow the incident action plan",
      rankingReason: rankingReason(severity, item.slaDueAt, item.firstSeen),
      deepLink: `/admin/ops/incidents/${encodeURIComponent(item.id)}`,
      verificationState: normalizeVerification(item.verificationState),
      lastChangedAt: item.updatedAt.toISOString(),
      environment,
      dataClass: "internal",
      pinned: pinnedKeys.has(`${row.sourceType}:${item.id}`),
      preferenceVersion: preferenceVersions.get(`${row.sourceType}:${item.id}`) ?? 0,
      claim: item.ownerId === null && permissions.has("ops.incident.manage") ? { entityVersion: item.version } : null,
    };
  }
  if (row.sourceType === "character_release") {
    const item = row.row;
    const severity = row.monitorActionRequired || item.readiness === "blocked" ? "high" : item.readiness === "stale" ? "medium" : "low";
    return {
      sourceType: row.sourceType,
      sourceId: item.id,
      title: `Character release ${item.status.replaceAll("_", " ")}`,
      summary: row.monitorActionRequired
        ? `${row.project.characterId} · published monitor requires action`
        : `${row.project.characterId} · ${row.project.phase.replaceAll("_", " ")} · readiness ${item.readiness}`,
      severity,
      priority: severity === "high" ? "high" : "normal",
      impactSnapshot: {
        projectId: item.projectId,
        characterId: row.project.characterId,
        readiness: item.readiness,
        snapshotHash: item.snapshotHash,
      },
      ownerId: row.project.ownerId,
      slaDueAt: row.project.plannedLaunchAt?.toISOString() ?? null,
      recommendedAction: row.monitorActionRequired ? "Investigate monitor evidence and keep or rollback" : item.readiness === "blocked" ? "Resolve release readiness blockers" : "Advance release checks",
      rankingReason: rankingReason(severity, row.project.plannedLaunchAt, item.createdAt),
      deepLink: `/admin/characters/${encodeURIComponent(row.project.characterId)}?tab=release&releaseId=${encodeURIComponent(item.id)}`,
      verificationState: row.monitorActionRequired || item.readiness === "blocked" ? "failed" : item.readiness === "ready" ? "passed" : "pending",
      lastChangedAt: item.updatedAt.toISOString(),
      environment,
      dataClass: "internal",
      pinned: pinnedKeys.has(`${row.sourceType}:${item.id}`),
      preferenceVersion: preferenceVersions.get(`${row.sourceType}:${item.id}`) ?? 0,
      claim: row.project.ownerId === null && permissions.has("character.project.write")
        ? { entityVersion: row.project.version }
        : null,
    };
  }
  if (row.sourceType === "creative_run") {
    const item = row.row;
    const severity = item.verificationState === "failed" ? "high" : "medium";
    return {
      sourceType: row.sourceType,
      sourceId: item.id,
      title: item.title,
      summary: `${item.workflowStage.replaceAll("_", " ")} · ${item.status.replaceAll("_", " ")}`,
      severity,
      priority: normalizePriority(item.priority),
      impactSnapshot: {
        purpose: item.purpose,
        targetType: item.targetType,
        targetId: item.targetId,
        totalItems: item.totalItems,
        failedItems: item.failedItems,
        approvedItems: item.approvedItems,
      },
      ownerId: item.ownerId,
      slaDueAt: item.dueAt?.toISOString() ?? null,
      recommendedAction: item.verificationState === "failed" ? "Reopen Creative verification" : "Advance the Creative Run",
      rankingReason: rankingReason(severity, item.dueAt, item.createdAt),
      deepLink: `/admin/creative/runs/${encodeURIComponent(item.id)}`,
      verificationState: normalizeVerification(item.verificationState),
      lastChangedAt: item.updatedAt.toISOString(),
      environment,
      dataClass: "internal",
      pinned: pinnedKeys.has(`${row.sourceType}:${item.id}`),
      preferenceVersion: preferenceVersions.get(`${row.sourceType}:${item.id}`) ?? 0,
      claim: item.ownerId === null && permissions.has("creative.run.write") ? { entityVersion: item.version } : null,
    };
  }
  const item = row.row;
  const verificationState = commandVerification(item.status);
  return {
    sourceType: row.sourceType,
    sourceId: item.id,
    title: item.commandType.replaceAll(".", " "),
    summary: `${item.targetType} ${item.targetId} command is ${item.status}`,
    severity: verificationState === "failed" ? "high" : "medium",
    priority: verificationState === "failed" ? "high" : "normal",
    impactSnapshot: {
      targetType: item.targetType,
      targetId: item.targetId,
      attemptCount: item.attemptCount,
      maxAttempts: item.maxAttempts,
      needsReconciliation: item.needsReconciliation,
    },
    ownerId: item.actorId,
    slaDueAt: item.leaseExpiresAt?.toISOString() ?? null,
    recommendedAction: item.needsReconciliation ? "Reconcile the uncertain downstream effect" : "Check command verification",
    rankingReason: rankingReason(verificationState === "failed" ? "high" : "medium", item.leaseExpiresAt, item.createdAt),
    deepLink: `/admin/system/audit?commandId=${encodeURIComponent(item.id)}`,
    verificationState,
    lastChangedAt: item.updatedAt.toISOString(),
    environment,
    dataClass: "audit",
    pinned: pinnedKeys.has(`${row.sourceType}:${item.id}`),
    preferenceVersion: preferenceVersions.get(`${row.sourceType}:${item.id}`) ?? 0,
    claim: null,
  };
}

function rankingReason(severity: TodayWorkItem["severity"], dueAt: Date | null, createdAt: Date) {
  const reasons = [`${severity} severity`];
  if (dueAt) reasons.push(`SLA ${dueAt.toISOString()}`);
  reasons.push(`open since ${createdAt.toISOString()}`);
  return reasons.join(" · ");
}

const severityScore = { critical: 4, high: 3, medium: 2, low: 1 } as const;
const priorityScore = { urgent: 4, high: 3, normal: 2, low: 1 } as const;

const MODE_SOURCE_ORDER: Record<TodayWorkMode, readonly TodayWorkItem["sourceType"][]> = {
  character_producer: ["collaboration_mention", "character_release", "creative_run", "control_plane_command", "admin_case", "ops_incident"],
  creative_operator: ["collaboration_mention", "creative_run", "character_release", "control_plane_command", "ops_incident", "admin_case"],
  platform_ops: ["collaboration_mention", "ops_incident", "creative_run", "control_plane_command", "character_release", "admin_case"],
  support: ["collaboration_mention", "admin_case", "ops_incident", "control_plane_command", "character_release", "creative_run"],
  moderator: ["collaboration_mention", "admin_case", "character_release", "control_plane_command", "ops_incident", "creative_run"],
  growth_analyst: ["collaboration_mention", "character_release", "creative_run", "control_plane_command", "ops_incident", "admin_case"],
  admin: ["collaboration_mention", "ops_incident", "character_release", "creative_run", "control_plane_command", "admin_case"],
};

function sortItems(items: TodayWorkItem[], now: Date, workMode: TodayWorkMode) {
  return items.sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    const severityDelta = severityScore[right.severity] - severityScore[left.severity];
    if (severityDelta !== 0) return severityDelta;
    const modeOrder = MODE_SOURCE_ORDER[workMode];
    const modeDelta = modeOrder.indexOf(left.sourceType) - modeOrder.indexOf(right.sourceType);
    if (modeDelta !== 0) return modeDelta;
    const priorityDelta = priorityScore[right.priority] - priorityScore[left.priority];
    if (priorityDelta !== 0) return priorityDelta;
    const leftDue = left.slaDueAt ? new Date(left.slaDueAt).getTime() : Number.POSITIVE_INFINITY;
    const rightDue = right.slaDueAt ? new Date(right.slaDueAt).getTime() : Number.POSITIVE_INFINITY;
    if (leftDue !== rightDue) return leftDue - rightDue;
    const leftAge = now.getTime() - new Date(left.lastChangedAt).getTime();
    const rightAge = now.getTime() - new Date(right.lastChangedAt).getTime();
    return rightAge - leftAge || left.sourceId.localeCompare(right.sourceId);
  });
}

function queue(
  rows: QueueRows,
  pinnedKeys: ReadonlySet<string>,
  preferenceVersions: ReadonlyMap<string, number>,
  now: Date,
  workMode: TodayWorkMode,
  permissions: ReadonlySet<AdminPermissionKey>,
) {
  return {
    totalCount: rows.totalCount,
    items: sortItems(rows.rows.map((row) => projectRow(row, pinnedKeys, permissions, preferenceVersions)), now, workMode).slice(0, QUEUE_LIMIT),
  };
}

function scopedCaseWhere(
  actor: { id: string; role: string },
  permissions: ReadonlySet<AdminPermissionKey>,
): Prisma.AdminCaseWhereInput | null {
  if (!permissions.has("case.read")) return null;
  return actor.role === "support" ? { type: { in: ["support_request", "billing_dispute"] } } : {};
}

function readableCommandWhere(permissions: ReadonlySet<AdminPermissionKey>): Prisma.ControlPlaneCommandWhereInput | null {
  const targets: Prisma.ControlPlaneCommandWhereInput[] = [];
  if (permissions.has("character.release.read")) targets.push({ targetType: "character_release" });
  if (permissions.has("creative.run.read")) targets.push({ targetType: "creative_run" });
  if (permissions.has("ops.incident.read")) targets.push({ targetType: "ops_incident" });
  if (permissions.has("case.read")) targets.push({ targetType: "admin_case" });
  if (permissions.has("audit.read")) {
    targets.push({ targetType: { notIn: ["character_release", "creative_run", "ops_incident", "admin_case"] } });
  }
  return targets.length > 0 ? { OR: targets } : null;
}

function sourceRows(
  cases: AdminCase[],
  incidents: OpsIncident[],
  commands: ControlPlaneCommand[],
  releases: Array<{
    row: CharacterRelease;
    project: { ownerId: string | null; characterId: string; phase: string; plannedLaunchAt: Date | null; version: number };
    monitorActionRequired?: boolean;
  }> = [],
  creativeRuns: ContentProductionBatch[] = [],
  mentions: Extract<ProjectableRow, { sourceType: "collaboration_mention" }>[] = [],
): ProjectableRow[] {
  return [
    ...mentions,
    ...cases.map((row) => ({ sourceType: "admin_case" as const, row })),
    ...incidents.map((row) => ({ sourceType: "ops_incident" as const, row })),
    ...commands.map((row) => ({ sourceType: "control_plane_command" as const, row })),
    ...releases.map(({ row, project, monitorActionRequired }) => ({ sourceType: "character_release" as const, row, project, monitorActionRequired })),
    ...creativeRuns.map((row) => ({ sourceType: "creative_run" as const, row })),
  ];
}

async function findQueueRows(input: {
  db: TodayReadDb;
  caseWhere: Prisma.AdminCaseWhereInput | null;
  incidentSelection: IncidentQueueSelection | null;
  commandWhere: Prisma.ControlPlaneCommandWhereInput | null;
  releaseSelection: ReleaseQueueSelection | null;
  creativeWhere: Prisma.ContentProductionBatchWhereInput | null;
  permissions: ReadonlySet<AdminPermissionKey>;
  mentions?: Extract<ProjectableRow, { sourceType: "collaboration_mention" }>[];
  mentionTotalCount?: number;
  pinnedIds: {
    cases: readonly string[];
    incidents: readonly string[];
    commands: readonly string[];
    releases: readonly string[];
    creativeRuns: readonly string[];
  };
  diagnostics?: TodayQueryDiagnostics;
}) {
  const commandPermissionWhere = readableCommandWhere(input.permissions);
  const commandWhere = input.commandWhere && commandPermissionWhere
    ? { AND: [input.commandWhere, commandPermissionWhere] }
    : null;
  // Any row in the global top ten must also be in its source's top ten under
  // the same total order. Query bounded, rank-preserving lanes per source,
  // retain exact counts separately, then merge the at-most-ten candidates.
  const [caseRows, incidentRows, commandRows, releaseRows, creativeRows] = await Promise.all([
    findBoundedCaseRows({
      db: input.db,
      where: input.caseWhere,
      pinnedIds: input.pinnedIds.cases,
      diagnostics: input.diagnostics,
    }),
    findBoundedIncidentRows({
      db: input.db,
      selection: input.incidentSelection,
      pinnedIds: input.pinnedIds.incidents,
      diagnostics: input.diagnostics,
    }),
    findBoundedCommandRows({
      db: input.db,
      where: commandWhere,
      pinnedIds: input.pinnedIds.commands,
      diagnostics: input.diagnostics,
    }),
    findBoundedReleaseRows({
      db: input.db,
      selection: input.releaseSelection,
      pinnedIds: input.pinnedIds.releases,
      diagnostics: input.diagnostics,
    }),
    findBoundedCreativeRows({
      db: input.db,
      where: input.creativeWhere,
      pinnedIds: input.pinnedIds.creativeRuns,
      diagnostics: input.diagnostics,
    }),
  ]);
  return {
    totalCount: caseRows.totalCount + incidentRows.totalCount + commandRows.totalCount + releaseRows.totalCount + creativeRows.totalCount + (input.mentionTotalCount ?? input.mentions?.length ?? 0),
    rows: sourceRows(caseRows.rows, incidentRows.rows, commandRows.rows, releaseRows.rows, creativeRows.rows, input.mentions),
  };
}

type MentionRow = Extract<ProjectableRow, { sourceType: "collaboration_mention" }>;

function mentionTargetFromItem(item: TodayWorkItem, ownerId: string): MentionRow["target"] {
  return {
    label: item.title,
    deepLink: item.deepLink,
    severity: item.severity,
    priority: item.priority,
    impactSnapshot: item.impactSnapshot,
    ownerId,
    slaDueAt: item.slaDueAt ? new Date(item.slaDueAt) : null,
    verificationState: item.verificationState,
    dataClass: item.dataClass,
  };
}

async function findRankedMentionIds(input: {
  db: TodayReadDb;
  actor: { id: string; role: string };
  permissions: ReadonlySet<AdminPermissionKey>;
  now: Date;
  pinnedIds: readonly string[];
  excludeIds?: readonly string[];
  onlyIds?: readonly string[];
}) {
  if (input.onlyIds && input.onlyIds.length === 0) return { totalCount: 0, ids: [] as string[] };
  const exclusionSql = input.excludeIds && input.excludeIds.length > 0
    ? Prisma.sql`AND activity.id NOT IN (${Prisma.join(input.excludeIds)})`
    : Prisma.empty;
  const onlySql = input.onlyIds
    ? Prisma.sql`AND activity.id IN (${Prisma.join(input.onlyIds)})`
    : Prisma.empty;
  const pinnedRank = input.pinnedIds.length > 0
    ? Prisma.sql`CASE WHEN activity.id IN (${Prisma.join(input.pinnedIds)}) THEN 1 ELSE 0 END`
    : Prisma.sql`0`;
  const sources: Prisma.Sql[] = [];
  if (input.permissions.has("case.read")) {
    const scope = input.actor.role === "support"
      ? Prisma.sql`AND target.type IN ('support_request', 'billing_dispute')`
      : Prisma.empty;
    sources.push(Prisma.sql`
      SELECT activity.id, ${pinnedRank} AS pinned_rank,
        CASE target.priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'low' THEN 1 ELSE 2 END AS severity_rank,
        CASE target.priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'low' THEN 1 ELSE 2 END AS priority_rank,
        target."slaDueAt" AS due_at, activity."createdAt" AS changed_at
      FROM "admin_collaboration_activities" activity
      JOIN "admin_cases" target ON target.id = activity."targetId"
      WHERE activity."targetType" = 'case' AND ${input.actor.id} = ANY(activity."mentionedIds")
        ${scope} ${exclusionSql} ${onlySql}
    `);
  }
  if (input.permissions.has("ops.incident.read")) {
    const scope = input.actor.role === "support"
      ? Prisma.sql`AND (
          target."ownerId" = ${input.actor.id}
          OR EXISTS (
            SELECT 1 FROM "ops_incident_occurrences" occurrence
            JOIN "generation_jobs" job ON job.id = occurrence."requestId"
            JOIN "admin_cases" customer_case
              ON customer_case."targetType" = 'user'
              AND customer_case."targetId" = job."userId"
              AND customer_case.type IN ('support_request', 'billing_dispute')
            WHERE occurrence."incidentId" = target.id
          )
        )`
      : Prisma.empty;
    sources.push(Prisma.sql`
      SELECT activity.id, ${pinnedRank} AS pinned_rank,
        CASE target.severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'low' THEN 1 ELSE 2 END AS severity_rank,
        CASE target.severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'low' THEN 1 ELSE 2 END AS priority_rank,
        target."slaDueAt" AS due_at, activity."createdAt" AS changed_at
      FROM "admin_collaboration_activities" activity
      JOIN "ops_incidents" target ON target.id = activity."targetId"
      WHERE activity."targetType" = 'incident' AND ${input.actor.id} = ANY(activity."mentionedIds")
        ${scope} ${exclusionSql} ${onlySql}
    `);
  }
  if (input.permissions.has("creative.run.read")) {
    sources.push(Prisma.sql`
      SELECT activity.id, ${pinnedRank} AS pinned_rank,
        CASE WHEN target."verificationState" = 'failed' THEN 3 ELSE 2 END AS severity_rank,
        CASE target.priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'low' THEN 1 ELSE 2 END AS priority_rank,
        target."dueAt" AS due_at, activity."createdAt" AS changed_at
      FROM "admin_collaboration_activities" activity
      JOIN "content_production_batches" target ON target.id = activity."targetId"
      WHERE activity."targetType" = 'creative_run' AND ${input.actor.id} = ANY(activity."mentionedIds")
        ${exclusionSql} ${onlySql}
    `);
  }
  if (input.permissions.has("character.project.read")) {
    sources.push(Prisma.sql`
      SELECT activity.id, ${pinnedRank} AS pinned_rank,
        CASE WHEN target."plannedLaunchAt" <= ${input.now} THEN 3 ELSE 2 END AS severity_rank,
        CASE WHEN target."plannedLaunchAt" <= ${input.now} THEN 3 ELSE 2 END AS priority_rank,
        target."plannedLaunchAt" AS due_at, activity."createdAt" AS changed_at
      FROM "admin_collaboration_activities" activity
      JOIN "character_projects" target ON target.id = activity."targetId"
      WHERE activity."targetType" = 'character_project' AND ${input.actor.id} = ANY(activity."mentionedIds")
        ${exclusionSql} ${onlySql}
    `);
  }
  if (sources.length === 0) return { totalCount: 0, ids: [] as string[] };
  const ranked = await input.db.$queryRaw<Array<{ id: string | null; totalCount: bigint }>>(Prisma.sql`
    WITH eligible AS (${Prisma.join(sources, " UNION ALL ")}),
    ranked AS (
      SELECT id, row_number() OVER (
        ORDER BY pinned_rank DESC, severity_rank DESC, priority_rank DESC,
          due_at ASC NULLS LAST, changed_at ASC, id ASC
      ) AS ordinal
      FROM eligible
    ), summary AS (SELECT count(*)::bigint AS total_count FROM eligible)
    SELECT ranked.id, summary.total_count AS "totalCount"
    FROM summary
    LEFT JOIN ranked ON ranked.ordinal <= ${QUEUE_LIMIT}
    ORDER BY ranked.ordinal ASC NULLS LAST
  `);
  return {
    totalCount: Number(ranked[0]?.totalCount ?? 0),
    ids: ranked.flatMap((row) => row.id ? [row.id] : []),
  };
}

async function findMentionRows(input: {
  db: TodayReadDb;
  actor: { id: string; role: string };
  permissions: ReadonlySet<AdminPermissionKey>;
  now: Date;
  pinnedIds: readonly string[];
  excludeIds?: readonly string[];
  onlyIds?: readonly string[];
  diagnostics?: TodayQueryDiagnostics;
}): Promise<{ totalCount: number; rows: MentionRow[] }> {
  const ranked = await findRankedMentionIds(input);
  recordSourceQuery(input.diagnostics, "collaboration_mention", input.onlyIds ? "watching" : "eligible", ranked.ids.length);
  if (ranked.ids.length === 0) return { totalCount: ranked.totalCount, rows: [] };
  const activities = await input.db.adminCollaborationActivity.findMany({
    where: { id: { in: ranked.ids } },
    select: {
      id: true,
      targetType: true,
      targetId: true,
      actorId: true,
      body: true,
      createdAt: true,
    },
    take: QUEUE_LIMIT,
  });

  const ids = (targetType: string) => activities
    .filter((activity) => activity.targetType === targetType)
    .map((activity) => activity.targetId);
  const caseIds = ids("case");
  const incidentIds = ids("incident");
  const projectIds = ids("character_project");
  const creativeIds = ids("creative_run");
  const [cases, incidents, projects, creativeRuns] = await Promise.all([
    input.permissions.has("case.read") && caseIds.length > 0
      ? input.db.adminCase.findMany({ where: { id: { in: caseIds } }, take: QUEUE_LIMIT })
      : [],
    input.permissions.has("ops.incident.read") && incidentIds.length > 0
      ? input.db.opsIncident.findMany({ where: { id: { in: incidentIds } }, take: QUEUE_LIMIT })
      : [],
    input.permissions.has("character.project.read") && projectIds.length > 0
      ? input.db.characterProject.findMany({ where: { id: { in: projectIds } }, take: QUEUE_LIMIT })
      : [],
    input.permissions.has("creative.run.read") && creativeIds.length > 0
      ? input.db.contentProductionBatch.findMany({ where: { id: { in: creativeIds } }, take: QUEUE_LIMIT })
      : [],
  ]);
  const casesById = new Map(cases.map((row) => [row.id, row]));
  const incidentsById = new Map(incidents.map((row) => [row.id, row]));
  const projectsById = new Map(projects.map((row) => [row.id, row]));
  const creativeById = new Map(creativeRuns.map((row) => [row.id, row]));
  const noPins = new Set<string>();

  const rows = activities.flatMap((row): MentionRow[] => {
    if (row.targetType === "case") {
      const target = casesById.get(row.targetId);
      if (!target) return [];
      const item = projectRow({ sourceType: "admin_case", row: target }, noPins);
      return [{ sourceType: "collaboration_mention", row, target: mentionTargetFromItem(item, input.actor.id) }];
    }
    if (row.targetType === "incident") {
      const target = incidentsById.get(row.targetId);
      if (!target) return [];
      const item = projectRow({ sourceType: "ops_incident", row: target }, noPins);
      return [{ sourceType: "collaboration_mention", row, target: mentionTargetFromItem(item, input.actor.id) }];
    }
    if (row.targetType === "creative_run") {
      const target = creativeById.get(row.targetId);
      if (!target) return [];
      const item = projectRow({ sourceType: "creative_run", row: target }, noPins);
      return [{ sourceType: "collaboration_mention", row, target: mentionTargetFromItem(item, input.actor.id) }];
    }
    const project = projectsById.get(row.targetId);
    if (!project) return [];
    const severity = project.plannedLaunchAt && project.plannedLaunchAt <= input.now ? "high" : "medium";
    return [{
      sourceType: "collaboration_mention",
      row,
      target: {
        label: `Character project ${project.characterId}`,
        deepLink: `/admin/characters/${encodeURIComponent(project.characterId)}?tab=project`,
        severity,
        priority: severity === "high" ? "high" : "normal",
        impactSnapshot: { projectId: project.id, characterId: project.characterId, phase: project.phase },
        ownerId: input.actor.id,
        slaDueAt: project.plannedLaunchAt,
        verificationState: "pending",
        dataClass: "internal",
      },
    }];
  });
  return { totalCount: ranked.totalCount, rows };
}

export async function buildTodayProjection(input: {
  actor: { id: string; role: string };
  permissions: ReadonlySet<AdminPermissionKey>;
  now?: Date;
  workMode?: TodayWorkMode;
  db?: TodayReadDb;
  diagnostics?: TodayQueryDiagnostics;
}): Promise<TodayProjection> {
  const db = input.db ?? prisma;
  const now = input.now ?? new Date();
  const workMode = input.workMode ?? defaultWorkMode(input.actor.role);
  const endOfToday = new Date(now);
  endOfToday.setUTCHours(23, 59, 59, 999);
  const recentCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
  const caseScope = scopedCaseWhere(input.actor, input.permissions);
  const incidentReadable = input.permissions.has("ops.incident.read");
  const releaseReadable = input.permissions.has("character.release.read");
  const creativeReadable = input.permissions.has("creative.run.read");
  const preferences = await db.operationalWorkPreference.findMany({
    where: { actorId: input.actor.id },
    select: {
      actorId: true,
      sourceType: true,
      sourceId: true,
      watching: true,
      pinned: true,
      snoozedUntil: true,
      version: true,
    },
  });
  const pinnedKeys = new Set(preferences.filter((item) => item.pinned).map((item) => `${item.sourceType}:${item.sourceId}`));
  const preferenceVersions = new Map(preferences.map((item) => [`${item.sourceType}:${item.sourceId}`, item.version]));
  const snoozed = preferences.filter((item) => item.snoozedUntil && item.snoozedUntil > now);
  const snoozedCaseIds = snoozed.filter((item) => item.sourceType === "admin_case").map((item) => item.sourceId);
  const snoozedIncidentIds = snoozed.filter((item) => item.sourceType === "ops_incident").map((item) => item.sourceId);
  const snoozedCommandIds = snoozed.filter((item) => item.sourceType === "control_plane_command").map((item) => item.sourceId);
  const snoozedMentionIds = snoozed.filter((item) => item.sourceType === "collaboration_mention").map((item) => item.sourceId);
  const snoozedReleaseIds = snoozed.filter((item) => item.sourceType === "character_release").map((item) => item.sourceId);
  const snoozedCreativeIds = snoozed.filter((item) => item.sourceType === "creative_run").map((item) => item.sourceId);
  const withoutIds = (ids: string[]) => ids.length > 0 ? { notIn: ids } : undefined;

  const activeCaseWhere = caseScope && { AND: [caseScope, { status: { in: ACTIVE_CASE_STATUSES }, id: withoutIds(snoozedCaseIds) }] };
  const activeIncidentSelection = incidentReadable
    ? {
        scope: "active" as const,
        actor: input.actor,
        owner: "all" as const,
        snoozedIds: snoozedIncidentIds,
      }
    : null;
  const actorCommandWhere = {
    actorId: input.actor.id,
    status: { in: ACTIVE_COMMAND_STATUSES },
    id: withoutIds(snoozedCommandIds),
  } satisfies Prisma.ControlPlaneCommandWhereInput;
  const activeReleaseSelection = releaseReadable
    ? {
        scope: "active" as const,
        owner: "all" as const,
        snoozedIds: snoozedReleaseIds,
      }
    : null;
  const activeCreativeWhere = creativeReadable
    ? { lifecycleState: "active", id: withoutIds(snoozedCreativeIds) }
    : null;
  const pinnedIds = {
    cases: preferences.filter((item) => item.pinned && item.sourceType === "admin_case").map((item) => item.sourceId),
    incidents: preferences.filter((item) => item.pinned && item.sourceType === "ops_incident").map((item) => item.sourceId),
    commands: preferences.filter((item) => item.pinned && item.sourceType === "control_plane_command").map((item) => item.sourceId),
    releases: preferences.filter((item) => item.pinned && item.sourceType === "character_release").map((item) => item.sourceId),
    creativeRuns: preferences.filter((item) => item.pinned && item.sourceType === "creative_run").map((item) => item.sourceId),
  };
  const mentionRows = await findMentionRows({
    db,
    actor: input.actor,
    permissions: input.permissions,
    now,
    pinnedIds: preferences.filter((item) => item.pinned && item.sourceType === "collaboration_mention").map((item) => item.sourceId),
    excludeIds: snoozedMentionIds,
    diagnostics: input.diagnostics,
  });
  const mentions = mentionRows.rows;

  const [myShift, nextBest, unassigned, recentlyResolved] = await Promise.all([
    findQueueRows({
      db,
      caseWhere: activeCaseWhere && { AND: [activeCaseWhere, { ownerId: input.actor.id }, { OR: [{ slaDueAt: { lte: endOfToday } }, { verificationState: "failed" }] }] },
      incidentSelection: activeIncidentSelection && {
        ...activeIncidentSelection,
        owner: { actorId: input.actor.id },
        dueOrFailedBy: endOfToday,
      },
      commandWhere: actorCommandWhere,
      releaseSelection: activeReleaseSelection && { ...activeReleaseSelection, owner: { actorId: input.actor.id } },
      creativeWhere: activeCreativeWhere && {
        AND: [activeCreativeWhere, { ownerId: input.actor.id }, { OR: [{ dueAt: { lte: endOfToday } }, { verificationState: "failed" }] }],
      },
      permissions: input.permissions,
      mentions,
      mentionTotalCount: mentionRows.totalCount,
      pinnedIds,
      diagnostics: input.diagnostics,
    }),
    findQueueRows({
      db,
      caseWhere: activeCaseWhere,
      incidentSelection: activeIncidentSelection,
      commandWhere: actorCommandWhere,
      releaseSelection: activeReleaseSelection,
      creativeWhere: activeCreativeWhere,
      permissions: input.permissions,
      mentions,
      mentionTotalCount: mentionRows.totalCount,
      pinnedIds,
      diagnostics: input.diagnostics,
    }),
    findQueueRows({
      db,
      caseWhere: input.permissions.has("case.assign") && activeCaseWhere
        ? { AND: [activeCaseWhere, { ownerId: null }] }
        : null,
      incidentSelection: input.permissions.has("ops.incident.manage") && activeIncidentSelection
        ? { ...activeIncidentSelection, owner: "unassigned" }
        : null,
      commandWhere: null,
      releaseSelection: input.permissions.has("character.project.write") && activeReleaseSelection
        ? { ...activeReleaseSelection, owner: "unassigned" }
        : null,
      creativeWhere: input.permissions.has("creative.run.write") && activeCreativeWhere
        ? { AND: [activeCreativeWhere, { ownerId: null }] }
        : null,
      permissions: input.permissions,
      pinnedIds,
      diagnostics: input.diagnostics,
    }),
    findQueueRows({
      db,
      caseWhere: caseScope && { AND: [caseScope, { status: { in: RESOLVED_CASE_STATUSES }, verificationState: { in: ["passed", "overridden"] }, updatedAt: { gte: recentCutoff } }] },
      incidentSelection: incidentReadable
        ? { scope: "recently_resolved", actor: input.actor, recentCutoff }
        : null,
      commandWhere: { actorId: input.actor.id, status: "succeeded", finishedAt: { gte: recentCutoff } },
      releaseSelection: releaseReadable ? { scope: "recently_resolved", recentCutoff } : null,
      creativeWhere: creativeReadable
        ? { lifecycleState: { in: ["closed", "archived"] }, verificationState: { in: ["passed", "overridden"] }, updatedAt: { gte: recentCutoff } }
        : null,
      permissions: input.permissions,
      pinnedIds,
      diagnostics: input.diagnostics,
    }),
  ]);

  const watchedPreferences = preferences.filter((item) => item.watching);
  const watchedCaseIds = watchedPreferences.filter((item) => ["admin_case", "case"].includes(item.sourceType)).map((item) => item.sourceId);
  const watchedIncidentIds = watchedPreferences.filter((item) => ["ops_incident", "incident"].includes(item.sourceType)).map((item) => item.sourceId);
  const watchedCommandIds = watchedPreferences.filter((item) => item.sourceType === "control_plane_command").map((item) => item.sourceId);
  const watchedMentionIds = new Set(watchedPreferences.filter((item) => item.sourceType === "collaboration_mention").map((item) => item.sourceId));
  const directlyWatchedReleaseIds = watchedPreferences.filter((item) => item.sourceType === "character_release").map((item) => item.sourceId);
  const watchedProjectIds = watchedPreferences.filter((item) => item.sourceType === "character_project").map((item) => item.sourceId);
  const watchedCreativeIds = watchedPreferences.filter((item) => item.sourceType === "creative_run").map((item) => item.sourceId);
  const watchedMentionRows = await findMentionRows({
    db,
    actor: input.actor,
    permissions: input.permissions,
    now,
    pinnedIds: preferences.filter((item) => item.pinned && item.sourceType === "collaboration_mention").map((item) => item.sourceId),
    onlyIds: [...watchedMentionIds],
    diagnostics: input.diagnostics,
  });
  const watching = await findQueueRows({
    db,
    caseWhere: caseScope && watchedCaseIds.length > 0
      ? { AND: [caseScope, { id: { in: watchedCaseIds } }] }
      : null,
    incidentSelection: incidentReadable && watchedIncidentIds.length > 0
      ? { scope: "watching", actor: input.actor, incidentIds: watchedIncidentIds }
      : null,
    commandWhere: watchedCommandIds.length > 0
      ? { id: { in: watchedCommandIds }, actorId: input.actor.id }
      : null,
    releaseSelection: releaseReadable && (directlyWatchedReleaseIds.length > 0 || watchedProjectIds.length > 0)
      ? {
          scope: "watching",
          releaseIds: directlyWatchedReleaseIds,
          projectIds: input.permissions.has("character.project.read") ? watchedProjectIds : [],
        }
      : null,
    creativeWhere: creativeReadable && watchedCreativeIds.length > 0
      ? { id: { in: watchedCreativeIds } }
      : null,
    permissions: input.permissions,
    mentions: watchedMentionRows.rows,
    mentionTotalCount: watchedMentionRows.totalCount,
    pinnedIds,
    diagnostics: input.diagnostics,
  });

  return todayProjectionSchema.parse({
    myShift: queue(myShift, pinnedKeys, preferenceVersions, now, workMode, input.permissions),
    nextBestActions: queue(nextBest, pinnedKeys, preferenceVersions, now, workMode, input.permissions),
    unassigned: queue(unassigned, pinnedKeys, preferenceVersions, now, workMode, input.permissions),
    watching: queue(watching, pinnedKeys, preferenceVersions, now, workMode, input.permissions),
    recentlyResolved: queue(recentlyResolved, pinnedKeys, preferenceVersions, now, workMode, input.permissions),
    asOf: now.toISOString(),
    freshness: "fresh",
    workMode,
    rankingPolicyVersion: RANKING_POLICY_VERSION,
  });
}

export async function getTodayProjection(request: Request) {
  try {
    const actor = await actorWithPermission(request, "dashboard.read");
    const permissions = await effectivePermissions(actor.id, actor.role);
    const requestedWorkMode = new URL(request.url).searchParams.get("workMode");
    const projection = await buildTodayProjection({
      actor,
      permissions,
      workMode: isWorkMode(requestedWorkMode) ? requestedWorkMode : defaultWorkMode(actor.role),
    });
    return ok(projection, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AppError) return fail(error);
    throw error;
  }
}

function defaultWorkMode(role: string): TodayWorkMode {
  if (role === "support") return "support";
  if (role === "moderator") return "moderator";
  if (role === "ops") return "platform_ops";
  if (role === "analyst") return "growth_analyst";
  return "admin";
}

function isWorkMode(value: string | null): value is TodayWorkMode {
  return value !== null && Object.hasOwn(MODE_SOURCE_ORDER, value);
}
