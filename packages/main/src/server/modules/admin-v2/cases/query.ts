import { operationsCaseDetailSchema, operationsCaseQuerySchema } from "@idream/shared/admin";
import { Prisma, type AdminCase } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { adminAuditDto } from "@/server/modules/admin-v2/shared/dto";

function record(value: Prisma.JsonValue | null) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function severity(value: Prisma.JsonValue | null) {
  const candidate = record(value).severity;
  return ["critical", "high", "medium", "low"].includes(String(candidate))
    ? String(candidate)
    : "medium";
}

export async function caseDto(row: Awaited<ReturnType<typeof prisma.adminCase.findUniqueOrThrow>>) {
  const evidence = await prisma.caseEvidence.findMany({ where: { caseId: row.id } });
  const resolution = record(row.resolution);
  const verification = record(resolution.verification as Prisma.JsonValue | null);
  const relatedCaseIds: string[] = [];
  const relatedIncidentCandidates = new Set<string>();
  const actions = Array.isArray(resolution.actions) ? resolution.actions : [];
  for (const action of actions) {
    const value = record(action as Prisma.JsonValue);
    if (value.action === "incident_escalated" && typeof value.outcomeRef === "string") {
      relatedIncidentCandidates.add(value.outcomeRef.startsWith("incident:") ? value.outcomeRef.slice("incident:".length) : value.outcomeRef);
    }
  }
  for (const item of evidence) {
    if (item.sourceType === "ops_incident") relatedIncidentCandidates.add(item.sourceId);
  }
  if (typeof resolution.recurrenceOfCaseId === "string") relatedCaseIds.push(resolution.recurrenceOfCaseId);
  if (row.type === "appeal") {
    const appealEvidence = evidence.find((item) => item.sourceType === "appeal");
    const appealSnapshot = record(appealEvidence?.snapshot ?? null);
    if (typeof appealSnapshot.originalDecisionId === "string") {
      const review = await prisma.moderationReview.findUnique({
        where: { id: appealSnapshot.originalDecisionId },
        select: { reportId: true },
      });
      if (review?.reportId) {
        const parentEvidence = await prisma.caseEvidence.findFirst({
          where: { sourceType: "content_report", sourceId: review.reportId },
          select: { caseId: true },
        });
        if (parentEvidence) relatedCaseIds.push(parentEvidence.caseId);
      }
    }
  }
  const relatedIncidents = relatedIncidentCandidates.size > 0
    ? await prisma.opsIncident.findMany({ where: { id: { in: [...relatedIncidentCandidates] } }, select: { id: true } })
    : [];
  return {
    id: row.id,
    type: row.type,
    target: { type: row.targetType, id: row.targetId },
    caseKey: row.caseKey,
    status: row.status,
    priority: row.priority,
    severity: severity(row.resolution),
    ownerId: row.ownerId,
    slaDueAt: (row.slaDueAt ?? row.createdAt).toISOString(),
    reportCount: evidence.filter((item) => item.sourceType === "content_report").length,
    messageCount: evidence.filter((item) => item.sourceType === "support_message").length,
    resolutionSummary: typeof resolution.summary === "string" ? resolution.summary : null,
    verification:
      row.resolution && typeof verification.state === "string"
        ? {
            state: verification.state,
            evidenceRefs: Array.isArray(verification.evidenceRefs)
              ? verification.evidenceRefs.filter((item): item is string => typeof item === "string")
              : [],
            verifiedAt: typeof verification.verifiedAt === "string" ? verification.verifiedAt : null,
            overrideReason: typeof verification.overrideReason === "string" ? verification.overrideReason : null,
          }
        : null,
    relatedIncidentIds: relatedIncidents.map((incident) => incident.id).sort(),
    relatedCaseIds: [...new Set(relatedCaseIds)].sort(),
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type CaseCursor = { updatedAt: string; id: string };

function decodeCaseCursor(value?: string): CaseCursor | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      updatedAt?: unknown;
      id?: unknown;
    };
    if (typeof decoded.updatedAt !== "string" || typeof decoded.id !== "string") return null;
    const updatedAt = new Date(decoded.updatedAt);
    if (Number.isNaN(updatedAt.getTime())) return null;
    return { updatedAt: updatedAt.toISOString(), id: decoded.id };
  } catch {
    return null;
  }
}

function encodeCaseCursor(row: { updatedAt: Date; id: string }) {
  return Buffer.from(JSON.stringify({ updatedAt: row.updatedAt.toISOString(), id: row.id }), "utf8").toString("base64url");
}

function scopedCaseWhere(role: string, view: string, actorId: string): Prisma.AdminCaseWhereInput {
  const where: Prisma.AdminCaseWhereInput = {};
  if (role === "support") where.type = { in: ["support_request", "billing_dispute"] };
  if (view === "mine") where.ownerId = actorId;
  if (view === "unassigned") where.ownerId = null;
  if (view === "overdue") {
    where.slaDueAt = { lt: new Date() };
    where.status = { notIn: ["resolved", "closed"] };
  }
  if (view === "appeals") where.type = "appeal";
  if (view === "recently_resolved") {
    where.status = { in: ["resolved", "closed"] };
    where.updatedAt = { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000) };
  }
  return where;
}

function supportSearchSql(search: string) {
  const pattern = `%${search}%`;
  return Prisma.sql`(
    admin_case."targetId" ILIKE ${pattern}
    OR admin_case."caseKey" ILIKE ${pattern}
    OR EXISTS (
      SELECT 1
      FROM case_evidence AS evidence
      INNER JOIN support_requests AS support_request
        ON support_request.id = evidence."sourceId"
      WHERE evidence."caseId" = admin_case.id
        AND evidence."sourceType" = 'support_request'
        AND (
          support_request."ticketId" ILIKE ${pattern}
          OR support_request.subject ILIKE ${pattern}
          OR support_request.description ILIKE ${pattern}
        )
    )
  )`;
}

async function searchedCasePage(input: {
  role: string;
  actorId: string;
  query: ReturnType<typeof operationsCaseQuerySchema.parse>;
  cursor: CaseCursor | null;
}) {
  const conditions: Prisma.Sql[] = [];
  if (input.role === "support") {
    conditions.push(Prisma.sql`admin_case.type IN ('support_request', 'billing_dispute')`);
  }
  if (input.query.view === "mine") conditions.push(Prisma.sql`admin_case."ownerId" = ${input.actorId}`);
  if (input.query.view === "unassigned") conditions.push(Prisma.sql`admin_case."ownerId" IS NULL`);
  if (input.query.view === "overdue") {
    conditions.push(Prisma.sql`admin_case."slaDueAt" < NOW()`);
    conditions.push(Prisma.sql`admin_case.status NOT IN ('resolved', 'closed')`);
  }
  if (input.query.view === "appeals") conditions.push(Prisma.sql`admin_case.type = 'appeal'`);
  if (input.query.view === "recently_resolved") {
    conditions.push(Prisma.sql`admin_case.status IN ('resolved', 'closed')`);
    conditions.push(Prisma.sql`admin_case."updatedAt" >= ${new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000)}`);
  }
  if (input.query.type) conditions.push(Prisma.sql`admin_case.type = ${input.query.type}`);
  if (input.query.status) conditions.push(Prisma.sql`admin_case.status = ${input.query.status}`);
  if (input.query.ownerId) conditions.push(Prisma.sql`admin_case."ownerId" = ${input.query.ownerId}`);
  if (input.query.priority) conditions.push(Prisma.sql`admin_case.priority = ${input.query.priority}`);
  if (input.cursor) {
    const cursorUpdatedAt = new Date(input.cursor.updatedAt);
    conditions.push(input.query.sort === "updated_asc"
      ? Prisma.sql`(admin_case."updatedAt", admin_case.id) > (${cursorUpdatedAt}, ${input.cursor.id})`
      : Prisma.sql`(admin_case."updatedAt", admin_case.id) < (${cursorUpdatedAt}, ${input.cursor.id})`);
  }
  conditions.push(supportSearchSql(input.query.search!));
  const where = Prisma.join(conditions, " AND ");
  const limit = input.query.limit + 1;
  return input.query.sort === "updated_asc"
    ? prisma.$queryRaw<AdminCase[]>(Prisma.sql`
        SELECT admin_case.*
        FROM admin_cases AS admin_case
        WHERE ${where}
        ORDER BY admin_case."updatedAt" ASC, admin_case.id ASC
        LIMIT ${limit}
      `)
    : prisma.$queryRaw<AdminCase[]>(Prisma.sql`
        SELECT admin_case.*
        FROM admin_cases AS admin_case
        WHERE ${where}
        ORDER BY admin_case."updatedAt" DESC, admin_case.id DESC
        LIMIT ${limit}
      `);
}

export async function listCases(request: Request) {
  const actor = await actorWithPermission(request, "case.read");
  const url = new URL(request.url);
  const query = operationsCaseQuerySchema.parse(Object.fromEntries(url.searchParams));
  const scope = scopedCaseWhere(actor.role, query.view, actor.id);
  const cursor = decodeCaseCursor(query.cursor);
  const cursorDirection = query.sort === "updated_asc" ? "gt" : "lt";
  const where: Prisma.AdminCaseWhereInput = {
    AND: [
      scope,
      {
        type: query.type,
        status: query.status,
        ownerId: query.ownerId ?? scope.ownerId,
        priority: query.priority,
        ...(cursor
          ? {
              OR: [
                { updatedAt: { [cursorDirection]: new Date(cursor.updatedAt) } },
                { updatedAt: new Date(cursor.updatedAt), id: { [cursorDirection]: cursor.id } },
              ],
            }
          : {}),
      },
    ],
  };
  const rows = query.search
    ? await searchedCasePage({ role: actor.role, actorId: actor.id, query, cursor })
    : await prisma.adminCase.findMany({
        where,
        orderBy: [
          { updatedAt: query.sort === "updated_asc" ? "asc" : "desc" },
          { id: query.sort === "updated_asc" ? "asc" : "desc" },
        ],
        take: query.limit + 1,
      });
  const hasNextPage = rows.length > query.limit;
  const pageRows = rows.slice(0, query.limit);
  const items = await Promise.all(pageRows.map(caseDto));
  return ok({
    items,
    pageInfo: { endCursor: hasNextPage && pageRows.at(-1) ? encodeCaseCursor(pageRows.at(-1)!) : null, hasNextPage },
    query: { ...query, cursor: query.cursor ?? null },
    asOf: new Date().toISOString(),
    freshness: "fresh",
  });
}

export async function getCaseDetail(request: Request, caseId: string) {
  const actor = await actorWithPermission(request, "case.read");
  const adminCase = await prisma.adminCase.findUnique({ where: { id: caseId } });
  if (!adminCase) throw Errors.notFound("Case not found");
  if (actor.role === "support" && !["support_request", "billing_dispute"].includes(adminCase.type)) {
    throw Errors.forbidden("Case subtype is outside the actor's permission scope");
  }
  const [evidence, decisions, activity] = await Promise.all([
    prisma.caseEvidence.findMany({ where: { caseId }, orderBy: [{ occurredAt: "asc" }, { id: "asc" }] }),
    prisma.decisionRecord.findMany({
      where: { sourceType: "admin_case", sourceId: caseId },
      orderBy: { createdAt: "desc" },
    }),
    prisma.adminAuditLog.findMany({
      where: { targetType: "admin_case", targetId: caseId },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  ]);
  return ok(operationsCaseDetailSchema.parse({
    case: await caseDto(adminCase),
    evidence: evidence.map((row) => {
      const snapshot = record(row.snapshot);
      return {
        id: row.id,
        caseId: row.caseId,
        source: { type: row.sourceType, id: row.sourceId },
        evidenceType: row.sourceType,
        summary:
          typeof snapshot.description === "string"
            ? snapshot.description
            : typeof snapshot.appealText === "string"
              ? snapshot.appealText
              : `${row.sourceType} ${row.sourceId}`,
        occurredAt: row.occurredAt.toISOString(),
        access: "full",
      };
    }),
    decisions: decisions.map((row) => ({
      ...row,
      reviewAt: row.reviewAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    activity: activity.map(adminAuditDto),
  }));
}
