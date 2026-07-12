import {
  todayProjectionSchema,
  type AdminPermissionKey,
  type TodayProjection,
  type TodayWorkMode,
  type TodayWorkItem,
} from "@idream/shared/admin";
import type {
  AdminCollaborationActivity,
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
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { incidentReadScopeWhere } from "@/server/modules/admin-v2/incidents/scope";

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
      row: AdminCollaborationActivity;
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

function projectRow(
  row: ProjectableRow,
  pinnedKeys: ReadonlySet<string>,
  permissions: ReadonlySet<AdminPermissionKey> = new Set(),
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
      claim: item.ownerId === null && permissions.has("ops.incident.manage") ? { entityVersion: item.version } : null,
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
      deepLink: `/admin/characters/${encodeURIComponent(row.project.characterId)}?tab=release&releaseId=${encodeURIComponent(item.id)}`,
      verificationState: item.readiness === "blocked" ? "failed" : item.readiness === "ready" ? "passed" : "pending",
      lastChangedAt: item.updatedAt.toISOString(),
      environment,
      dataClass: "internal",
      pinned: pinnedKeys.has(`${row.sourceType}:${item.id}`),
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
  now: Date,
  workMode: TodayWorkMode,
  permissions: ReadonlySet<AdminPermissionKey>,
) {
  return {
    totalCount: rows.totalCount,
    items: sortItems(rows.rows.map((row) => projectRow(row, pinnedKeys, permissions)), now, workMode).slice(0, QUEUE_LIMIT),
  };
}

function scopedCaseWhere(
  actor: { id: string; role: string },
  permissions: ReadonlySet<AdminPermissionKey>,
): Prisma.AdminCaseWhereInput | null {
  if (!permissions.has("case.read")) return null;
  return actor.role === "support" ? { type: { in: ["support_request", "billing_dispute"] } } : {};
}

async function scopedIncidentWhere(
  actor: { id: string; role: string },
  permissions: ReadonlySet<AdminPermissionKey>,
): Promise<Prisma.OpsIncidentWhereInput | null> {
  if (!permissions.has("ops.incident.read")) return null;
  return incidentReadScopeWhere(prisma, actor);
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
  }> = [],
  creativeRuns: ContentProductionBatch[] = [],
  mentions: Extract<ProjectableRow, { sourceType: "collaboration_mention" }>[] = [],
): ProjectableRow[] {
  return [
    ...mentions,
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
  mentions?: Extract<ProjectableRow, { sourceType: "collaboration_mention" }>[];
}) {
  const commandPermissionWhere = readableCommandWhere(input.permissions);
  const commandWhere = input.commandWhere && commandPermissionWhere
    ? { AND: [input.commandWhere, commandPermissionWhere] }
    : null;
  // Fetch the complete eligible set before applying the versioned cross-domain
  // ranking policy. A per-domain updatedAt cap is not rank-preserving: an old
  // critical/SLA-breached row can legitimately outrank every newer row.
  const [cases, incidents, commands, releaseRows, creativeRuns] = await Promise.all([
    input.caseWhere ? prisma.adminCase.findMany({ where: input.caseWhere }) : [],
    input.incidentWhere ? prisma.opsIncident.findMany({ where: input.incidentWhere }) : [],
    commandWhere ? prisma.controlPlaneCommand.findMany({ where: commandWhere }) : [],
    input.releaseWhere ? prisma.characterRelease.findMany({ where: input.releaseWhere }) : [],
    input.creativeWhere ? prisma.contentProductionBatch.findMany({ where: input.creativeWhere }) : [],
  ]);
  const projects = releaseRows.length > 0
    ? await prisma.characterProject.findMany({
        where: { id: { in: releaseRows.map((item) => item.projectId) } },
        select: { id: true, ownerId: true, characterId: true, phase: true, plannedLaunchAt: true, version: true },
      })
    : [];
  const projectsById = new Map(projects.map((item) => [item.id, item]));
  const releases = releaseRows.flatMap((row) => {
    const project = projectsById.get(row.projectId);
    return project ? [{ row, project }] : [];
  });
  return {
    totalCount: cases.length + incidents.length + commands.length + releases.length + creativeRuns.length + (input.mentions?.length ?? 0),
    rows: sourceRows(cases, incidents, commands, releases, creativeRuns, input.mentions),
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

async function findMentionRows(input: {
  actor: { id: string; role: string };
  permissions: ReadonlySet<AdminPermissionKey>;
  caseScope: Prisma.AdminCaseWhereInput | null;
  incidentScope: Prisma.OpsIncidentWhereInput | null;
  now: Date;
}): Promise<MentionRow[]> {
  const activities = await prisma.adminCollaborationActivity.findMany({
    where: { mentionedIds: { has: input.actor.id } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (activities.length === 0) return [];

  const ids = (targetType: string) => activities
    .filter((activity) => activity.targetType === targetType)
    .map((activity) => activity.targetId);
  const caseIds = ids("case");
  const incidentIds = ids("incident");
  const projectIds = ids("character_project");
  const creativeIds = ids("creative_run");
  const [cases, incidents, projects, creativeRuns] = await Promise.all([
    input.caseScope && caseIds.length > 0
      ? prisma.adminCase.findMany({ where: { AND: [input.caseScope, { id: { in: caseIds } }] } })
      : [],
    input.incidentScope && incidentIds.length > 0
      ? prisma.opsIncident.findMany({ where: { AND: [input.incidentScope, { id: { in: incidentIds } }] } })
      : [],
    input.permissions.has("character.project.read") && projectIds.length > 0
      ? prisma.characterProject.findMany({ where: { id: { in: projectIds } } })
      : [],
    input.permissions.has("creative.run.read") && creativeIds.length > 0
      ? prisma.contentProductionBatch.findMany({ where: { id: { in: creativeIds } } })
      : [],
  ]);
  const casesById = new Map(cases.map((row) => [row.id, row]));
  const incidentsById = new Map(incidents.map((row) => [row.id, row]));
  const projectsById = new Map(projects.map((row) => [row.id, row]));
  const creativeById = new Map(creativeRuns.map((row) => [row.id, row]));
  const noPins = new Set<string>();

  return activities.flatMap((row): MentionRow[] => {
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
  const incidentScope = await scopedIncidentWhere(input.actor, input.permissions);
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
  const snoozedMentionIds = snoozed.filter((item) => item.sourceType === "collaboration_mention").map((item) => item.sourceId);
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
  const allMentions = await findMentionRows({
    actor: input.actor,
    permissions: input.permissions,
    caseScope,
    incidentScope,
    now,
  });
  const snoozedMentionSet = new Set(snoozedMentionIds);
  const mentions = allMentions.filter((mention) => !snoozedMentionSet.has(mention.row.id));

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
      mentions,
    }),
    findQueueRows({
      caseWhere: activeCaseWhere,
      incidentWhere: activeIncidentWhere,
      commandWhere: actorCommandWhere,
      releaseWhere: activeReleaseWhere,
      creativeWhere: activeCreativeWhere,
      permissions: input.permissions,
      mentions,
    }),
    findQueueRows({
      caseWhere: input.permissions.has("case.assign") && activeCaseWhere
        ? { AND: [activeCaseWhere, { ownerId: null }] }
        : null,
      incidentWhere: input.permissions.has("ops.incident.manage") && activeIncidentWhere
        ? { AND: [activeIncidentWhere, { ownerId: null }] }
        : null,
      commandWhere: null,
      releaseWhere: input.permissions.has("character.project.write") && activeReleaseWhere
        ? { AND: [activeReleaseWhere, { projectId: { in: unassignedProjectIds } }] }
        : null,
      creativeWhere: input.permissions.has("creative.run.write") && activeCreativeWhere
        ? { AND: [activeCreativeWhere, { ownerId: null }] }
        : null,
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
  const watchedCaseIds = watchedPreferences.filter((item) => ["admin_case", "case"].includes(item.sourceType)).map((item) => item.sourceId);
  const watchedIncidentIds = watchedPreferences.filter((item) => ["ops_incident", "incident"].includes(item.sourceType)).map((item) => item.sourceId);
  const watchedCommandIds = watchedPreferences.filter((item) => item.sourceType === "control_plane_command").map((item) => item.sourceId);
  const watchedMentionIds = new Set(watchedPreferences.filter((item) => item.sourceType === "collaboration_mention").map((item) => item.sourceId));
  const directlyWatchedReleaseIds = watchedPreferences.filter((item) => item.sourceType === "character_release").map((item) => item.sourceId);
  const watchedProjectIds = watchedPreferences.filter((item) => item.sourceType === "character_project").map((item) => item.sourceId);
  const watchedCreativeIds = watchedPreferences.filter((item) => item.sourceType === "creative_run").map((item) => item.sourceId);
  const commandPermissionWhere = readableCommandWhere(input.permissions);
  const watchedCharacterProjects = releaseReadable && input.permissions.has("character.project.read") && watchedProjectIds.length > 0
    ? await prisma.characterProject.findMany({ where: { id: { in: watchedProjectIds } } })
    : [];
  const [watchedProjectServings, watchedProjectCandidates] = watchedCharacterProjects.length > 0
    ? await Promise.all([
        prisma.characterServing.findMany({
          where: { characterId: { in: watchedCharacterProjects.map((project) => project.characterId) } },
          select: { characterId: true, currentReleaseId: true },
        }),
        prisma.characterRelease.findMany({
          where: { projectId: { in: watchedCharacterProjects.map((project) => project.id) }, status: { in: ACTIVE_RELEASE_STATUSES } },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        }),
      ])
    : [[], []] as const;
  const candidateByProject = new Map<string, CharacterRelease>();
  for (const release of watchedProjectCandidates) {
    if (!candidateByProject.has(release.projectId)) candidateByProject.set(release.projectId, release);
  }
  const servingByCharacter = new Map(watchedProjectServings.map((serving) => [serving.characterId, serving.currentReleaseId]));
  const watchedReleaseIds = [...new Set([
    ...directlyWatchedReleaseIds,
    ...watchedCharacterProjects.flatMap((project) => {
      const currentReleaseId = servingByCharacter.get(project.characterId);
      const candidateReleaseId = candidateByProject.get(project.id)?.id;
      return [currentReleaseId, candidateReleaseId].filter((id): id is string => Boolean(id));
    }),
  ])];
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
        select: { id: true, ownerId: true, characterId: true, phase: true, plannedLaunchAt: true, version: true },
      })
    : [];
  const watchedProjectsById = new Map(watchedProjects.map((item) => [item.id, item]));
  const projectedWatchedReleases = watchedReleases.flatMap((row) => {
    const project = watchedProjectsById.get(row.projectId);
    return project ? [{ row, project }] : [];
  });
  const watchedMentions = allMentions.filter((mention) => watchedMentionIds.has(mention.row.id));
  const watching = {
    totalCount: watchedCases.length + watchedIncidents.length + watchedCommands.length + projectedWatchedReleases.length + watchedCreativeRuns.length + watchedMentions.length,
    rows: sourceRows(
      watchedCases,
      watchedIncidents,
      watchedCommands,
      projectedWatchedReleases,
      watchedCreativeRuns,
      watchedMentions,
    ),
  };

  return todayProjectionSchema.parse({
    myShift: queue(myShift, pinnedKeys, now, workMode, input.permissions),
    nextBestActions: queue(nextBest, pinnedKeys, now, workMode, input.permissions),
    unassigned: queue(unassigned, pinnedKeys, now, workMode, input.permissions),
    watching: queue(watching, pinnedKeys, now, workMode, input.permissions),
    recentlyResolved: queue(recentlyResolved, pinnedKeys, now, workMode, input.permissions),
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
