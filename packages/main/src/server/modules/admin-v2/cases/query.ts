import { operationsCaseQuerySchema } from "@idream/shared/admin";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { actorWithPermission } from "@/server/modules/admin/service";

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
    relatedIncidentIds: [],
    relatedCaseIds,
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

export async function listCases(request: Request) {
  const actor = await actorWithPermission(request, "case.read");
  const url = new URL(request.url);
  const query = operationsCaseQuerySchema.parse(Object.fromEntries(url.searchParams));
  const scope = scopedCaseWhere(actor.role, query.view, actor.id);
  const cursor = decodeCaseCursor(query.cursor);
  const cursorDirection = query.sort === "updated_asc" ? "gt" : "lt";
  let searchedCaseIds: string[] = [];
  if (query.search) {
    const sources = await prisma.supportRequest.findMany({
      where: {
        OR: [
          { ticketId: { contains: query.search, mode: "insensitive" } },
          { subject: { contains: query.search, mode: "insensitive" } },
          { description: { contains: query.search, mode: "insensitive" } },
        ],
      },
      select: { id: true },
      take: 500,
    });
    if (sources.length > 0) {
      searchedCaseIds = (await prisma.caseEvidence.findMany({
        where: { sourceType: "support_request", sourceId: { in: sources.map((item) => item.id) } },
        select: { caseId: true },
      })).map((item) => item.caseId);
    }
  }
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
        ...(query.search
          ? {
              OR: [
                { targetId: { contains: query.search, mode: "insensitive" } },
                { caseKey: { contains: query.search, mode: "insensitive" } },
                ...(searchedCaseIds.length > 0 ? [{ id: { in: searchedCaseIds } }] : []),
              ],
            }
          : {}),
      },
    ],
  };
  const rows = await prisma.adminCase.findMany({
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
  return ok({
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
    decisions,
    activity,
  });
}
