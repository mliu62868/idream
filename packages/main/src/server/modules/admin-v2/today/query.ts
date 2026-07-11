import {
  todayProjectionSchema,
  type AdminPermissionKey,
  type TodayProjection,
  type TodayWorkMode,
  type TodayWorkItem,
} from "@idream/shared/admin";
import type {
  AdminCase,
  CharacterRelease,
  ContentProductionBatch,
  ControlPlaneCommand,
  OpsIncident,
  Prisma,
} from "@prisma/client";
import { effectivePermissions } from "@/server/admin/effective-permissions";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { AppError } from "@/server/lib/errors";
import { fail, ok } from "@/server/lib/http";
import { actorWithPermission } from "@/server/modules/admin/service";

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
  | { sourceType: "admin_case"; row: AdminCase }
  | { sourceType: "ops_incident"; row: OpsIncident }
  | { sourceType: "control_plane_command"; row: ControlPlaneCommand }
  | {
      sourceType: "character_release";
      row: CharacterRelease;
      project: { ownerId: string | null; characterId: string; phase: string; plannedLaunchAt: Date | null };
    }
  | { sourceType: "creative_run"; row: ContentProductionBatch };

type QueueRows = {
  totalCount: number;
  rows: ProjectableRow[];
};

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

function projectRow(row: ProjectableRow, pinnedKeys: ReadonlySet<string>): TodayWorkItem {
  const environment = deploymentEnvironment();
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
    };
  }
  if (row.sourceType === "character_release") {
    const item = row.row;
    const severity = item.readiness === "blocked" ? "high" : item.readiness === "stale" ? "medium" : "low";
    return {
      sourceType: row.sourceType,
      sourceId: item.id,
      title: `Character release ${item.status.replaceAll("_", " ")}`,
      summary: `${row.project.characterId} · ${row.project.phase.replaceAll("_", " ")} · readiness ${item.readiness}`,
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
      recommendedAction: item.readiness === "blocked" ? "Resolve release readiness blockers" : "Advance release checks",
      rankingReason: rankingReason(severity, row.project.plannedLaunchAt, item.createdAt),
      deepLink: `/admin/characters/releases/${encodeURIComponent(item.id)}`,
      verificationState: item.readiness === "blocked" ? "failed" : item.readiness === "ready" ? "passed" : "pending",
      lastChangedAt: item.updatedAt.toISOString(),
      environment,
      dataClass: "internal",
      pinned: pinnedKeys.has(`${row.sourceType}:${item.id}`),
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
    deepLink: `/admin/system/commands/${encodeURIComponent(item.id)}`,
    verificationState,
    lastChangedAt: item.updatedAt.toISOString(),
    environment,
    dataClass: "audit",
    pinned: pinnedKeys.has(`${row.sourceType}:${item.id}`),
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
  character_producer: ["character_release", "creative_run", "control_plane_command", "admin_case", "ops_incident"],
  creative_operator: ["creative_run", "character_release", "control_plane_command", "ops_incident", "admin_case"],
  platform_ops: ["ops_incident", "creative_run", "control_plane_command", "character_release", "admin_case"],
  support: ["admin_case", "ops_incident", "control_plane_command", "character_release", "creative_run"],
  moderator: ["admin_case", "character_release", "control_plane_command", "ops_incident", "creative_run"],
  growth_analyst: ["character_release", "creative_run", "control_plane_command", "ops_incident", "admin_case"],
  admin: ["ops_incident", "character_release", "creative_run", "control_plane_command", "admin_case"],
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

function queue(rows: QueueRows, pinnedKeys: ReadonlySet<string>, now: Date, workMode: TodayWorkMode) {
  return {
    totalCount: rows.totalCount,
    items: sortItems(rows.rows.map((row) => projectRow(row, pinnedKeys)), now, workMode).slice(0, QUEUE_LIMIT),
  };
}

function scopedCaseWhere(
  actor: { id: string; role: string },
  permissions: ReadonlySet<AdminPermissionKey>,
): Prisma.AdminCaseWhereInput | null {
  if (!permissions.has("case.read")) return null;
  return actor.role === "support" ? { type: "support_request" } : {};
}

function scopedIncidentWhere(
  actor: { id: string; role: string },
  permissions: ReadonlySet<AdminPermissionKey>,
): Prisma.OpsIncidentWhereInput | null {
  if (!permissions.has("ops.incident.read")) return null;
  return actor.role === "support" ? { ownerId: actor.id } : {};
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
    project: { ownerId: string | null; characterId: string; phase: string; plannedLaunchAt: Date | null };
  }> = [],
  creativeRuns: ContentProductionBatch[] = [],
): ProjectableRow[] {
  return [
    ...cases.map((row) => ({ sourceType: "admin_case" as const, row })),
    ...incidents.map((row) => ({ sourceType: "ops_incident" as const, row })),
    ...commands.map((row) => ({ sourceType: "control_plane_command" as const, row })),
    ...releases.map(({ row, project }) => ({ sourceType: "character_release" as const, row, project })),
    ...creativeRuns.map((row) => ({ sourceType: "creative_run" as const, row })),
  ];
}

async function findQueueRows(input: {
  caseWhere: Prisma.AdminCaseWhereInput | null;
  incidentWhere: Prisma.OpsIncidentWhereInput | null;
  commandWhere: Prisma.ControlPlaneCommandWhereInput | null;
  releaseWhere: Prisma.CharacterReleaseWhereInput | null;
  creativeWhere: Prisma.ContentProductionBatchWhereInput | null;
  permissions: ReadonlySet<AdminPermissionKey>;
}) {
  const commandPermissionWhere = readableCommandWhere(input.permissions);
  const commandWhere = input.commandWhere && commandPermissionWhere
    ? { AND: [input.commandWhere, commandPermissionWhere] }
    : null;
  const [caseCount, cases, incidentCount, incidents, commandCount, commands, releaseCount, releaseRows, creativeCount, creativeRuns] = await Promise.all([
    input.caseWhere ? prisma.adminCase.count({ where: input.caseWhere }) : 0,
    input.caseWhere ? prisma.adminCase.findMany({ where: input.caseWhere, orderBy: { updatedAt: "desc" }, take: QUEUE_LIMIT }) : [],
    input.incidentWhere ? prisma.opsIncident.count({ where: input.incidentWhere }) : 0,
    input.incidentWhere ? prisma.opsIncident.findMany({ where: input.incidentWhere, orderBy: { updatedAt: "desc" }, take: QUEUE_LIMIT }) : [],
    commandWhere ? prisma.controlPlaneCommand.count({ where: commandWhere }) : 0,
    commandWhere ? prisma.controlPlaneCommand.findMany({ where: commandWhere, orderBy: { updatedAt: "desc" }, take: QUEUE_LIMIT }) : [],
    input.releaseWhere ? prisma.characterRelease.count({ where: input.releaseWhere }) : 0,
    input.releaseWhere ? prisma.characterRelease.findMany({ where: input.releaseWhere, orderBy: { updatedAt: "desc" }, take: QUEUE_LIMIT }) : [],
    input.creativeWhere ? prisma.contentProductionBatch.count({ where: input.creativeWhere }) : 0,
    input.creativeWhere ? prisma.contentProductionBatch.findMany({ where: input.creativeWhere, orderBy: { updatedAt: "desc" }, take: QUEUE_LIMIT }) : [],
  ]);
  const projects = releaseRows.length > 0
    ? await prisma.characterProject.findMany({
        where: { id: { in: releaseRows.map((item) => item.projectId) } },
        select: { id: true, ownerId: true, characterId: true, phase: true, plannedLaunchAt: true },
      })
    : [];
  const projectsById = new Map(projects.map((item) => [item.id, item]));
  const releases = releaseRows.flatMap((row) => {
    const project = projectsById.get(row.projectId);
    return project ? [{ row, project }] : [];
  });
  return {
    totalCount: caseCount + incidentCount + commandCount + releaseCount + creativeCount,
    rows: sourceRows(cases, incidents, commands, releases, creativeRuns),
  };
}

export async function buildTodayProjection(input: {
  actor: { id: string; role: string };
  permissions: ReadonlySet<AdminPermissionKey>;
  now?: Date;
  workMode?: TodayWorkMode;
}): Promise<TodayProjection> {
  const now = input.now ?? new Date();
  const workMode = input.workMode ?? defaultWorkMode(input.actor.role);
  const endOfToday = new Date(now);
  endOfToday.setUTCHours(23, 59, 59, 999);
  const recentCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
  const caseScope = scopedCaseWhere(input.actor, input.permissions);
  const incidentScope = scopedIncidentWhere(input.actor, input.permissions);
  const releaseReadable = input.permissions.has("character.release.read");
  const creativeReadable = input.permissions.has("creative.run.read");
  const projects = releaseReadable
    ? await prisma.characterProject.findMany({ select: { id: true, ownerId: true } })
    : [];
  const allProjectIds = projects.map((item) => item.id);
  const ownedProjectIds = projects.filter((item) => item.ownerId === input.actor.id).map((item) => item.id);
  const unassignedProjectIds = projects.filter((item) => item.ownerId === null).map((item) => item.id);
  const preferences = await prisma.operationalWorkPreference.findMany({ where: { actorId: input.actor.id } });
  const pinnedKeys = new Set(preferences.filter((item) => item.pinned).map((item) => `${item.sourceType}:${item.sourceId}`));
  const snoozed = preferences.filter((item) => item.snoozedUntil && item.snoozedUntil > now);
  const snoozedCaseIds = snoozed.filter((item) => item.sourceType === "admin_case").map((item) => item.sourceId);
  const snoozedIncidentIds = snoozed.filter((item) => item.sourceType === "ops_incident").map((item) => item.sourceId);
  const snoozedCommandIds = snoozed.filter((item) => item.sourceType === "control_plane_command").map((item) => item.sourceId);
  const snoozedReleaseIds = snoozed.filter((item) => item.sourceType === "character_release").map((item) => item.sourceId);
  const snoozedCreativeIds = snoozed.filter((item) => item.sourceType === "creative_run").map((item) => item.sourceId);
  const withoutIds = (ids: string[]) => ids.length > 0 ? { notIn: ids } : undefined;

  const activeCaseWhere = caseScope && { AND: [caseScope, { status: { in: ACTIVE_CASE_STATUSES }, id: withoutIds(snoozedCaseIds) }] };
  const activeIncidentWhere = incidentScope && { AND: [incidentScope, { status: { in: ACTIVE_INCIDENT_STATUSES }, id: withoutIds(snoozedIncidentIds) }] };
  const actorCommandWhere = {
    actorId: input.actor.id,
    status: { in: ACTIVE_COMMAND_STATUSES },
    id: withoutIds(snoozedCommandIds),
  } satisfies Prisma.ControlPlaneCommandWhereInput;
  const activeReleaseWhere = releaseReadable
    ? { status: { in: ACTIVE_RELEASE_STATUSES }, projectId: { in: allProjectIds }, id: withoutIds(snoozedReleaseIds) }
    : null;
  const activeCreativeWhere = creativeReadable
    ? { lifecycleState: "active", id: withoutIds(snoozedCreativeIds) }
    : null;

  const [myShift, nextBest, unassigned, recentlyResolved] = await Promise.all([
    findQueueRows({
      caseWhere: activeCaseWhere && { AND: [activeCaseWhere, { ownerId: input.actor.id }, { OR: [{ slaDueAt: { lte: endOfToday } }, { verificationState: "failed" }] }] },
      incidentWhere: activeIncidentWhere && { AND: [activeIncidentWhere, { ownerId: input.actor.id }, { OR: [{ slaDueAt: { lte: endOfToday } }, { verificationState: "failed" }] }] },
      commandWhere: actorCommandWhere,
      releaseWhere: activeReleaseWhere && { AND: [activeReleaseWhere, { projectId: { in: ownedProjectIds } }] },
      creativeWhere: activeCreativeWhere && {
        AND: [activeCreativeWhere, { ownerId: input.actor.id }, { OR: [{ dueAt: { lte: endOfToday } }, { verificationState: "failed" }] }],
      },
      permissions: input.permissions,
    }),
    findQueueRows({
      caseWhere: activeCaseWhere,
      incidentWhere: activeIncidentWhere,
      commandWhere: actorCommandWhere,
      releaseWhere: activeReleaseWhere,
      creativeWhere: activeCreativeWhere,
      permissions: input.permissions,
    }),
    findQueueRows({
      caseWhere: activeCaseWhere && { AND: [activeCaseWhere, { ownerId: null }] },
      incidentWhere: activeIncidentWhere && { AND: [activeIncidentWhere, { ownerId: null }] },
      commandWhere: null,
      releaseWhere: activeReleaseWhere && { AND: [activeReleaseWhere, { projectId: { in: unassignedProjectIds } }] },
      creativeWhere: activeCreativeWhere && { AND: [activeCreativeWhere, { ownerId: null }] },
      permissions: input.permissions,
    }),
    findQueueRows({
      caseWhere: caseScope && { AND: [caseScope, { status: { in: RESOLVED_CASE_STATUSES }, verificationState: { in: ["passed", "overridden"] }, updatedAt: { gte: recentCutoff } }] },
      incidentWhere: incidentScope && { AND: [incidentScope, { status: { in: RESOLVED_INCIDENT_STATUSES }, verificationState: { in: ["passed", "overridden"] }, updatedAt: { gte: recentCutoff } }] },
      commandWhere: { actorId: input.actor.id, status: "succeeded", finishedAt: { gte: recentCutoff } },
      releaseWhere: releaseReadable ? { status: { in: RESOLVED_RELEASE_STATUSES }, updatedAt: { gte: recentCutoff } } : null,
      creativeWhere: creativeReadable
        ? { lifecycleState: { in: ["closed", "archived"] }, verificationState: { in: ["passed", "overridden"] }, updatedAt: { gte: recentCutoff } }
        : null,
      permissions: input.permissions,
    }),
  ]);

  const watchedPreferences = preferences.filter((item) => item.watching);
  const watchedCaseIds = watchedPreferences.filter((item) => item.sourceType === "admin_case").map((item) => item.sourceId);
  const watchedIncidentIds = watchedPreferences.filter((item) => item.sourceType === "ops_incident").map((item) => item.sourceId);
  const watchedCommandIds = watchedPreferences.filter((item) => item.sourceType === "control_plane_command").map((item) => item.sourceId);
  const watchedReleaseIds = watchedPreferences.filter((item) => item.sourceType === "character_release").map((item) => item.sourceId);
  const watchedCreativeIds = watchedPreferences.filter((item) => item.sourceType === "creative_run").map((item) => item.sourceId);
  const commandPermissionWhere = readableCommandWhere(input.permissions);
  const [watchedCases, watchedIncidents, watchedCommands, watchedReleases, watchedCreativeRuns] = await Promise.all([
    caseScope && watchedCaseIds.length > 0 ? prisma.adminCase.findMany({ where: { AND: [caseScope, { id: { in: watchedCaseIds } }] } }) : [],
    incidentScope && watchedIncidentIds.length > 0 ? prisma.opsIncident.findMany({ where: { AND: [incidentScope, { id: { in: watchedIncidentIds } }] } }) : [],
    watchedCommandIds.length > 0 && commandPermissionWhere
      ? prisma.controlPlaneCommand.findMany({ where: { AND: [{ id: { in: watchedCommandIds }, actorId: input.actor.id }, commandPermissionWhere] } })
      : [],
    releaseReadable && watchedReleaseIds.length > 0
      ? prisma.characterRelease.findMany({ where: { id: { in: watchedReleaseIds } } })
      : [],
    creativeReadable && watchedCreativeIds.length > 0
      ? prisma.contentProductionBatch.findMany({ where: { id: { in: watchedCreativeIds } } })
      : [],
  ]);
  const watchedProjects = watchedReleases.length > 0
    ? await prisma.characterProject.findMany({
        where: { id: { in: watchedReleases.map((item) => item.projectId) } },
        select: { id: true, ownerId: true, characterId: true, phase: true, plannedLaunchAt: true },
      })
    : [];
  const watchedProjectsById = new Map(watchedProjects.map((item) => [item.id, item]));
  const projectedWatchedReleases = watchedReleases.flatMap((row) => {
    const project = watchedProjectsById.get(row.projectId);
    return project ? [{ row, project }] : [];
  });
  const watching = {
    totalCount: watchedCases.length + watchedIncidents.length + watchedCommands.length + projectedWatchedReleases.length + watchedCreativeRuns.length,
    rows: sourceRows(watchedCases, watchedIncidents, watchedCommands, projectedWatchedReleases, watchedCreativeRuns),
  };

  return todayProjectionSchema.parse({
    myShift: queue(myShift, pinnedKeys, now, workMode),
    nextBestActions: queue(nextBest, pinnedKeys, now, workMode),
    unassigned: queue(unassigned, pinnedKeys, now, workMode),
    watching: queue(watching, pinnedKeys, now, workMode),
    recentlyResolved: queue(recentlyResolved, pinnedKeys, now, workMode),
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
