import { incidentDetailSchema, incidentRecoveryChecksSchema } from "@idream/shared/admin";
import {
  eligibleOccurrenceIds,
  incidentCanCreateActionPlan,
  incidentRouteActionAvailable,
  isIncidentAction,
  occurrenceSnapshot,
} from "./eligibility";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { actorWithPermission, queryParams } from "@/server/modules/admin-v2/shared/authority";
import { adminAuditDto } from "@/server/modules/admin-v2/shared/dto";
import { assertIncidentReadable, incidentReadScopeWhere } from "./scope";

function record(value: Prisma.JsonValue | null) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function iso(value: Date | null) {
  return value?.toISOString() ?? null;
}

function incidentDto(row: Awaited<ReturnType<typeof prisma.opsIncident.findUniqueOrThrow>>) {
  const mitigation = record(row.mitigation);
  const impact = record(row.impact);
  const verification = record(mitigation.verification as Prisma.JsonValue | null);
  const checks = incidentRecoveryChecksSchema.safeParse(verification.checks);
  return {
    id: row.id,
    signature: row.signature,
    signatureVersion: row.signatureVersion,
    status: row.status,
    severity: row.severity,
    ownerId: row.ownerId,
    firstSeenAt: row.firstSeen.toISOString(),
    lastSeenAt: row.lastSeen.toISOString(),
    impact: {
      affectedRequests: Number(impact.affectedRequests ?? 0),
      affectedUsers: Number(impact.affectedUsers ?? 0),
      failedCostMicros: Number(impact.failedCostMicros ?? 0),
      refundMicros: Number(impact.refundMicros ?? 0),
      refundDreamcoins: Number(impact.refundDreamcoins ?? 0),
    },
    lastKnownGoodAt: typeof mitigation.lastKnownGoodAt === "string" ? mitigation.lastKnownGoodAt : null,
    slaDueAt: iso(row.slaDueAt),
    suspectedCause: row.suspectedCause,
    causeConfidence: row.confidence,
    recommendedActions: Array.isArray(mitigation.recommendedActions)
      ? mitigation.recommendedActions.filter((item): item is string => typeof item === "string")
      : [],
    runbookUrl: typeof mitigation.runbookUrl === "string" ? mitigation.runbookUrl : null,
    rollbackTarget: typeof mitigation.rollbackTarget === "string" ? mitigation.rollbackTarget : null,
    recoveryVerification: {
      state: row.verificationState,
      checkedAt: typeof verification.checkedAt === "string" ? verification.checkedAt : null,
      evidenceRefs: Array.isArray(verification.evidenceRefs)
        ? verification.evidenceRefs.filter((item): item is string => typeof item === "string")
        : [],
      checks: checks.success ? checks.data : null,
    },
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listIncidents(request: Request) {
  const actor = await actorWithPermission(request, "ops.incident.read");
    const query = queryParams(request, "GET /api/v2/admin/incidents");
    const scope = await incidentReadScopeWhere(prisma, actor);
    const where: Prisma.OpsIncidentWhereInput = { AND: [scope, {
      status: query.status,
      severity: query.severity,
      ownerId: query.ownerId,
      ...(query.cursor ? { id: { gt: query.cursor } } : {}),
      ...(query.search
        ? {
            OR: [
              { signature: { contains: query.search, mode: "insensitive" } },
              { suspectedCause: { contains: query.search, mode: "insensitive" } },
            ],
          }
        : {}),
    }] };
    const rows = await prisma.opsIncident.findMany({
      where,
      orderBy: { id: "asc" },
      take: query.limit + 1,
    });
    const hasNextPage = rows.length > query.limit;
    const items = rows.slice(0, query.limit).map(incidentDto);
  return ok({
      items,
      pageInfo: { endCursor: hasNextPage ? items.at(-1)?.id ?? null : null, hasNextPage },
      asOf: new Date().toISOString(),
      freshness: "fresh",
  });
}

export async function getIncidentDetail(request: Request, incidentId: string) {
  const actor = await actorWithPermission(request, "ops.incident.read");
  const incident = await prisma.opsIncident.findUnique({ where: { id: incidentId } });
  if (!incident) throw Errors.notFound("Incident not found");
  if (!await assertIncidentReadable(prisma, actor, incident.id)) {
    throw Errors.forbidden("Incident is outside the actor's assigned scope");
  }
  const [occurrences, actionPlans, activity, postmortem] = await Promise.all([
    prisma.opsIncidentOccurrence.findMany({
      where: { incidentId },
      orderBy: [{ observedAt: "desc" }, { id: "desc" }],
    }),
    prisma.incidentActionPlan.findMany({
      where: { incidentId },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    prisma.adminAuditLog.findMany({
      where: { targetType: "ops_incident", targetId: incidentId },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    prisma.incidentPostmortem.findUnique({ where: { incidentId } }),
  ]);
  const occurrenceAssignments = await prisma.opsIncidentOccurrenceAssignment.findMany({
    where: { occurrenceId: { in: occurrences.map((row) => row.id) } },
    orderBy: { createdAt: "asc" },
  });

  // SPEC: 把 occurrences 反查成「这次事故打到了哪些人」。
  // INTENT: impact.affectedUsers 只是个计数，运营要联系受影响的人时拿不到名单。
  // INVARIANT: 反查不到的单独计数，不许并进名单也不许丢。requestId 是裸 String、没有外键
  //            （不变式 `attempt_without_request` 就是在数这类孤儿），所以"请求行不在了"
  //            是真实状态；抹掉它们会让运营以为名单是全的。
  const occurrenceRequestIds = [...new Set(
    occurrences.flatMap((row) => (row.requestId ? [row.requestId] : [])),
  )];
  const requestOwners = occurrenceRequestIds.length > 0
    ? await prisma.generationJob.findMany({
      where: { id: { in: occurrenceRequestIds } },
      select: {
        id: true,
        userId: true,
        user: { select: { role: true, dataClass: true } },
      },
    })
    : [];
  const ownerByRequestId = new Map(requestOwners.map((row) => [row.id, {
    userId: row.userId,
    customerRecordAvailable:
      row.user.role === "user" && row.user.dataClass === "customer",
  }]));
  const occurrencesByUser = new Map<string, number>();
  const customerRecordByUser = new Map<string, boolean>();
  let unattributableOccurrences = 0;
  for (const occurrence of occurrences) {
    const owner = occurrence.requestId ? ownerByRequestId.get(occurrence.requestId) : undefined;
    if (!owner) {
      unattributableOccurrences += 1;
      continue;
    }
    occurrencesByUser.set(owner.userId, (occurrencesByUser.get(owner.userId) ?? 0) + 1);
    customerRecordByUser.set(owner.userId, owner.customerRecordAvailable);
  }
  const affectedUsers = [...occurrencesByUser.entries()]
    .map(([userId, occurrenceCount]) => ({
      userId,
      occurrenceCount,
      customerRecordAvailable: customerRecordByUser.get(userId) ?? false,
    }))
    // 影响最重的排前面；同数按 userId 稳定排序，免得每次刷新顺序都在跳。
    .sort((left, right) => right.occurrenceCount - left.occurrenceCount
      || left.userId.localeCompare(right.userId));
  // SPEC: 详情页只推荐此刻真的有对象可作用的缓解动作。
  // INTENT: `mitigation.recommendedActions` 是建事故那一刻写死的常量，对每个生成类事故都是
  //         同一对 ["retry_eligible","pause_route"]，从不看事故自己的事实。实测这个事故的两条
  //         occurrence 都是 `unknown / not_retryable / ambiguous_non_replayable`——重放可能
  //         二次扣费或二次交付，所以被明确判成不可重试；控制台仍然推荐它，点下去只有一句
  //         400 "Incident action has no eligible occurrences"。这里拿预览用的同一份判据
  //         （eligibility.ts）过一遍，把点了必然失败的动作摘掉。
  // INVARIANT: 只做**减法**。这里不会推荐一个快照里没写过的动作——快照是运营与事故策略之间
  //            的约定，能不能执行是另一回事，两者都成立才留下。
  //            列表页不做这件事：那要按事故各查一次 occurrence + attempt + ledger。
  const snapshot = await occurrenceSnapshot(prisma, incidentId);
  const dto = incidentDto(incident);
  const actionable: string[] = [];
  if (incidentCanCreateActionPlan(incident.status)) {
    for (const action of dto.recommendedActions) {
      if (!isIncidentAction(action) || eligibleOccurrenceIds(action, snapshot).length === 0) continue;
      if (
        (action === "pause_route" || action === "rollback") &&
        !await incidentRouteActionAvailable(prisma, {
          action,
          mitigation: incident.mitigation,
          targetVersion: action === "rollback" ? dto.rollbackTarget : null,
        })
      ) continue;
      actionable.push(action);
    }
  }

  return ok(incidentDetailSchema.parse({
    incident: { ...dto, recommendedActions: actionable },
    occurrences: occurrences.map((row) => ({
      id: row.id,
      incidentId: row.incidentId,
      requestId: row.requestId,
      attemptId: row.attemptId,
      transportExecutionId: row.transportExecutionId,
      observedAt: row.observedAt.toISOString(),
      assignmentHistory: occurrenceAssignments.filter((assignment) => assignment.occurrenceId === row.id).map((assignment) => ({
        id: assignment.id,
        fromIncidentId: assignment.fromIncidentId,
        toIncidentId: assignment.toIncidentId,
        action: assignment.action,
        actorId: assignment.actorId,
        reason: assignment.reason,
        createdAt: assignment.createdAt.toISOString(),
      })),
    })),
    affectedUsers,
    unattributableOccurrences,
    actionPlans: actionPlans.map(serializeIncidentActionPlan),
    postmortem: postmortem ? {
      id: postmortem.id,
      summary: postmortem.summary,
      rootCause: postmortem.rootCause,
      contributingFactors: postmortem.contributingFactors,
      correctiveActions: postmortem.correctiveActions,
      evidenceRefs: postmortem.evidenceRefs,
      createdById: postmortem.createdById,
      createdAt: postmortem.createdAt.toISOString(),
    } : null,
    activity: activity.map(adminAuditDto),
  }));
}

// SPEC: 行动方案的对外形状。表列名和契约字段名对不上（eligibleIds→eligibleOccurrenceIds、
//       eligibleIdsHash→occurrenceSetHash、impactSnapshot→impact、createdById→createdBy），
//       而契约是 .strict() 的，所以**必须**经过这里才能出网。
// INTENT: 抽出来是因为 previewIncidentActionPlan 曾经直接把 Prisma 行当响应返回
//         （incidents/service.ts:536），路由声明的响应契约是 incidentActionPlanSchema，
//         于是每一次预览都在写完 plan / 审计 / outbox 之后再报 500 ——
//         实测 `POST /incidents/:id/action-plans/preview {"action":"pause_route"}` 连打两次
//         返回两个 500，库里却多了两行 incident_action_plans。运营既拿不到 planId，
//         也就永远调不到 `/action-plans/:planId/execute`（确认串是 `${incidentId}:${planId}:${action}`），
//         整条事故缓解链路在控制台里不可达，而重试只会继续堆垃圾行。
export function serializeIncidentActionPlan(row: {
  readonly id: string;
  readonly incidentId: string;
  readonly action: string;
  readonly incidentVersion: number;
  readonly eligibleIdsHash: string;
  // Prisma 把这三列存成 Json，类型是 JsonValue；契约在出网时再校验形状，这里只做改名与透传。
  readonly eligibleIds: unknown;
  readonly skippedIds: unknown;
  readonly impactSnapshot: unknown;
  readonly targetVersion: string | null;
  readonly expiresAt: Date;
  readonly createdById: string;
  readonly createdAt: Date;
}) {
  return {
    id: row.id,
    incidentId: row.incidentId,
    action: row.action,
    incidentVersion: row.incidentVersion,
    occurrenceSetHash: row.eligibleIdsHash,
    eligibleOccurrenceIds: row.eligibleIds,
    skippedOccurrenceIds: row.skippedIds,
    impact: row.impactSnapshot,
    targetVersion: row.targetVersion,
    expiresAt: row.expiresAt.toISOString(),
    createdBy: row.createdById,
    createdAt: row.createdAt.toISOString(),
  };
}
