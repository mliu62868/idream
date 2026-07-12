import {
  generationJobListResponseSchema,
  generationJobQuerySchema,
  type GenerationJobSort,
} from "@idream/shared/admin";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { actorWithPermission } from "@/server/modules/admin/service";

const jobCursorSchema = z.object({
  version: z.literal(1),
  sort: z.enum(["created_desc", "created_asc", "updated_desc", "cost_desc"]),
  primary: z.union([z.string().min(1), z.number().int().nonnegative()]),
  id: z.string().min(1),
  queryHash: z.string().length(64),
}).strict();

type JobCursor = z.infer<typeof jobCursorSchema>;

function encodeCursor(cursor: JobCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string, sort: GenerationJobSort, queryHash: string) {
  try {
    const cursor = jobCursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (cursor.sort !== sort || cursor.queryHash !== queryHash) throw new Error("query mismatch");
    return cursor;
  } catch {
    throw Errors.badRequest("Generation Job cursor is invalid for the selected query");
  }
}

function cursorQueryHash(query: ReturnType<typeof generationJobQuerySchema.parse>) {
  return createHash("sha256").update(JSON.stringify({
    search: query.search ?? null,
    mode: query.mode,
    legacyStatus: query.legacyStatus ?? null,
    provider: query.provider ?? null,
    sourceType: query.sourceType ?? null,
    userId: query.userId ?? null,
    characterId: query.characterId ?? null,
    sort: query.sort,
  })).digest("hex");
}

function baseWhere(query: ReturnType<typeof generationJobQuerySchema.parse>): Prisma.GenerationJobWhereInput {
  return {
    mode: query.mode === "all" ? undefined : query.mode,
    status: query.legacyStatus,
    provider: query.provider,
    sourceType: query.sourceType,
    userId: query.userId,
    characterId: query.characterId,
    ...(query.search ? {
      OR: [
        { id: { contains: query.search, mode: "insensitive" } },
        { userId: { contains: query.search, mode: "insensitive" } },
        { characterId: { contains: query.search, mode: "insensitive" } },
        { provider: { contains: query.search, mode: "insensitive" } },
        { model: { contains: query.search, mode: "insensitive" } },
        { profileId: { contains: query.search, mode: "insensitive" } },
        { recipeId: { contains: query.search, mode: "insensitive" } },
        { sourceId: { contains: query.search, mode: "insensitive" } },
        { errorCode: { contains: query.search, mode: "insensitive" } },
      ],
    } : {}),
  };
}

function sortOrder(sort: GenerationJobSort): Prisma.GenerationJobOrderByWithRelationInput[] {
  if (sort === "created_asc") return [{ createdAt: "asc" }, { id: "asc" }];
  if (sort === "updated_desc") return [{ updatedAt: "desc" }, { id: "desc" }];
  if (sort === "cost_desc") return [{ costDreamcoins: "desc" }, { id: "desc" }];
  return [{ createdAt: "desc" }, { id: "desc" }];
}

function cursorWhere(cursor: JobCursor): Prisma.GenerationJobWhereInput {
  if (cursor.sort === "created_asc") {
    const primary = new Date(String(cursor.primary));
    if (Number.isNaN(primary.getTime())) throw Errors.badRequest("Generation Job cursor timestamp is invalid");
    return { OR: [{ createdAt: { gt: primary } }, { createdAt: primary, id: { gt: cursor.id } }] };
  }
  if (cursor.sort === "created_desc") {
    const primary = new Date(String(cursor.primary));
    if (Number.isNaN(primary.getTime())) throw Errors.badRequest("Generation Job cursor timestamp is invalid");
    return { OR: [{ createdAt: { lt: primary } }, { createdAt: primary, id: { lt: cursor.id } }] };
  }
  if (cursor.sort === "updated_desc") {
    const primary = new Date(String(cursor.primary));
    if (Number.isNaN(primary.getTime())) throw Errors.badRequest("Generation Job cursor timestamp is invalid");
    return { OR: [{ updatedAt: { lt: primary } }, { updatedAt: primary, id: { lt: cursor.id } }] };
  }
  if (typeof cursor.primary !== "number") throw Errors.badRequest("Generation Job cost cursor is invalid");
  return {
    OR: [
      { costDreamcoins: { lt: cursor.primary } },
      { costDreamcoins: cursor.primary, id: { lt: cursor.id } },
    ],
  };
}

function cursorForRow(
  row: { id: string; createdAt: Date; updatedAt: Date; costDreamcoins: number },
  sort: GenerationJobSort,
  queryHash: string,
) {
  const primary = sort === "cost_desc"
    ? row.costDreamcoins
    : sort === "updated_desc"
      ? row.updatedAt.toISOString()
      : row.createdAt.toISOString();
  return encodeCursor({ version: 1, sort, primary, id: row.id, queryHash });
}

function facetRows(rows: Array<{ value: string | null; count: number }>) {
  return rows
    .flatMap((row) => {
      const value = row.value?.trim();
      return value ? [{ value, count: row.count }] : [];
    })
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

function attemptStatus(value: string) {
  return ["queued", "running", "succeeded", "failed", "cancelled"].includes(value) ? value : "unknown";
}

function requestOutcome(
  legacyStatus: string,
  expectedOutputCount: number,
  deliveredCount: number,
  latestAttemptStatus: string | null,
) {
  if (legacyStatus === "cancelled") return "cancelled";
  if (legacyStatus === "blocked") return "blocked";
  if (legacyStatus === "queued") return "accepted";
  if (["moderating_input", "running", "moderating_output"].includes(legacyStatus)) {
    return latestAttemptStatus === "failed" ? "needs_reconciliation" : "processing";
  }
  if (legacyStatus === "failed") return deliveredCount > 0 ? "partially_succeeded" : "failed";
  if (deliveredCount >= expectedOutputCount && expectedOutputCount > 0) return "succeeded";
  if (deliveredCount > 0) return "partially_succeeded";
  return "needs_reconciliation";
}

export async function listGenerationJobsV2(request: Request) {
  await actorWithPermission(request, "generation.job.read");
  const url = new URL(request.url);
  const query = generationJobQuerySchema.parse(Object.fromEntries(url.searchParams));
  const filters = baseWhere(query);
  const queryHash = cursorQueryHash(query);
  const cursor = query.cursor ? decodeCursor(query.cursor, query.sort, queryHash) : null;
  const pageWhere: Prisma.GenerationJobWhereInput = cursor ? { AND: [filters, cursorWhere(cursor)] } : filters;

  const [rows, totals, statusGroups, modeGroups, providerGroups, sourceGroups] = await Promise.all([
    prisma.generationJob.findMany({
      where: pageWhere,
      orderBy: sortOrder(query.sort),
      take: query.limit + 1,
      include: { _count: { select: { assets: true } } },
    }),
    prisma.generationJob.aggregate({
      where: filters,
      _count: { _all: true },
      _sum: { costDreamcoins: true, outputCount: true, deliveredOutputCount: true },
    }),
    prisma.generationJob.groupBy({ by: ["status"], where: filters, _count: { _all: true } }),
    prisma.generationJob.groupBy({ by: ["mode"], where: filters, _count: { _all: true } }),
    prisma.generationJob.groupBy({ by: ["provider"], where: filters, _count: { _all: true } }),
    prisma.generationJob.groupBy({ by: ["sourceType"], where: filters, _count: { _all: true } }),
  ]);
  const hasNextPage = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const pageIds = page.map((row) => row.id);
  const [attempts, deliveryGroups, settlementLinks] = pageIds.length > 0 ? await Promise.all([
    prisma.generationAttempt.findMany({
      where: { requestId: { in: pageIds } },
      orderBy: [{ requestId: "asc" }, { attemptNo: "desc" }],
    }),
    prisma.generationDelivery.groupBy({
      by: ["requestId", "status"],
      where: { requestId: { in: pageIds } },
      _count: { _all: true },
    }),
    prisma.generationSettlementLink.findMany({
      where: { requestId: { in: pageIds } },
      select: { requestId: true, ledgerEntryId: true },
    }),
  ]) : [[], [], []];
  const ledgerEntries = settlementLinks.length > 0 ? await prisma.dreamcoinLedger.findMany({
    where: { id: { in: settlementLinks.map((link) => link.ledgerEntryId) } },
    select: { id: true, delta: true, reason: true },
  }) : [];
  const latestAttemptByRequest = new Map<string, (typeof attempts)[number]>();
  for (const attempt of attempts) {
    if (!latestAttemptByRequest.has(attempt.requestId)) latestAttemptByRequest.set(attempt.requestId, attempt);
  }
  const deliveriesByRequest = new Map<string, Record<string, number>>();
  for (const group of deliveryGroups) {
    const counts = deliveriesByRequest.get(group.requestId) ?? {};
    counts[group.status] = group._count._all;
    deliveriesByRequest.set(group.requestId, counts);
  }
  const ledgerById = new Map(ledgerEntries.map((entry) => [entry.id, entry]));
  const settlementByRequest = new Map<string, { captured: number; refunded: number }>();
  for (const link of settlementLinks) {
    const entry = ledgerById.get(link.ledgerEntryId);
    if (!entry) continue;
    const amounts = settlementByRequest.get(link.requestId) ?? { captured: 0, refunded: 0 };
    if (entry.reason === "generation_spend" && entry.delta < 0) amounts.captured += -entry.delta;
    if (entry.reason === "refund" && entry.delta > 0) amounts.refunded += entry.delta;
    settlementByRequest.set(link.requestId, amounts);
  }
  const response = generationJobListResponseSchema.parse({
    items: page.map((row) => {
      const latestAttempt = latestAttemptByRequest.get(row.id) ?? null;
      const deliveries = deliveriesByRequest.get(row.id) ?? {};
      const deliveredCount = deliveries.delivered ?? 0;
      const settlement = settlementByRequest.get(row.id) ?? { captured: 0, refunded: 0 };
      const settlementView = settlement.captured === 0
        ? "not_required"
        : settlement.refunded >= settlement.captured
          ? "refunded"
          : settlement.refunded > 0
            ? "partially_refunded"
            : "captured";
      return {
      id: row.id,
      userId: row.userId,
      characterId: row.characterId,
      derivedFromJobId: row.derivedFromJobId,
      mode: row.mode,
      requestOutcome: requestOutcome(row.status, row.outputCount, deliveredCount, latestAttempt?.status ?? null),
      legacyStatus: row.status,
      latestAttempt: latestAttempt ? {
        id: latestAttempt.id,
        attemptNo: latestAttempt.attemptNo,
        status: attemptStatus(latestAttempt.status),
        provider: latestAttempt.provider?.trim() || null,
        errorCode: latestAttempt.errorCode?.trim() || null,
        retryability: latestAttempt.retryability?.trim() || null,
        operatorGuidance: latestAttempt.operatorGuidance?.trim() || null,
        startedAt: latestAttempt.startedAt?.toISOString() ?? null,
        finishedAt: latestAttempt.finishedAt?.toISOString() ?? null,
      } : null,
      delivery: {
        expectedOutputCount: row.outputCount,
        deliveredCount,
        pendingCount: deliveries.pending ?? 0,
        failedCount: deliveries.failed ?? 0,
        suppressedCount: deliveries.suppressed ?? 0,
      },
      settlement: {
        view: settlementView,
        capturedDreamcoins: settlement.captured,
        refundedDreamcoins: settlement.refunded,
      },
      provider: row.provider?.trim() || null,
      model: row.model?.trim() || null,
      profileId: row.profileId?.trim() || null,
      profileVersion: row.profileVersion,
      recipeId: row.recipeId?.trim() || null,
      recipeVersion: row.recipeVersion,
      sourceType: row.sourceType.trim() || "unknown",
      sourceId: row.sourceId?.trim() || null,
      errorCode: row.errorCode?.trim() || null,
      outputCount: row.outputCount,
      deliveredOutputCount: row.deliveredOutputCount,
      assetCount: row._count.assets,
      costDreamcoins: row.costDreamcoins,
      promptHidden: Boolean(row.prompt),
      negativePromptHidden: Boolean(row.negativePrompt),
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
      };
    }),
    pageInfo: {
      endCursor: hasNextPage && last ? cursorForRow(last, query.sort, queryHash) : null,
      hasNextPage,
    },
    facets: {
      legacyStatuses: facetRows(statusGroups.map((row) => ({ value: row.status, count: row._count._all }))),
      modes: facetRows(modeGroups.map((row) => ({ value: row.mode, count: row._count._all }))),
      providers: facetRows(providerGroups.map((row) => ({ value: row.provider, count: row._count._all }))),
      sourceTypes: facetRows(sourceGroups.map((row) => ({ value: row.sourceType, count: row._count._all }))),
    },
    summary: {
      totalCount: totals._count._all,
      totalCostDreamcoins: totals._sum.costDreamcoins ?? 0,
      totalOutputCount: totals._sum.outputCount ?? 0,
      totalDeliveredOutputCount: totals._sum.deliveredOutputCount ?? 0,
    },
    asOf: new Date().toISOString(),
    freshness: "fresh",
  });
  return ok(response, { headers: { "Cache-Control": "no-store" } });
}
