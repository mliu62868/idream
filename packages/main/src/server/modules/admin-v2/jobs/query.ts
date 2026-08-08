import {
  generationJobDetailResponseSchema,
  generationJobListResponseSchema,
  type GenerationJobQuery,
  type GenerationJobListResponse,
  type GenerationJobSort,
} from "@idream/shared/admin";
import { aiFinalizePayloadSchema } from "@idream/shared/contracts";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import {
  OPERATIONAL_USER_DATA_SCOPE,
  operationalGenerationJobWhere,
} from "@/server/modules/metric-data-scope";
import { actorWithPermission, queryParams } from "@/server/modules/admin-v2/shared/authority";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";

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

function cursorQueryHash(query: GenerationJobQuery) {
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

function baseWhere(query: GenerationJobQuery): Prisma.GenerationJobWhereInput {
  return operationalGenerationJobWhere({
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
  });
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
  return ["queued", "running", "succeeded", "failed", "blocked", "cancelled"].includes(value) ? value : "unknown";
}

function requestOutcome(
  legacyStatus: string,
  expectedOutputCount: number,
  deliveredCount: number,
  latestAttemptStatus: string | null,
  latestUnknownResolution: "adopt_succeeded" | "confirm_failed" | "remain_unknown" | null,
) {
  if (latestUnknownResolution === "confirm_failed") return "failed";
  if (latestUnknownResolution === "adopt_succeeded") {
    if (deliveredCount >= expectedOutputCount && expectedOutputCount > 0) {
      return "succeeded";
    }
    return deliveredCount > 0 ? "partially_succeeded" : "failed";
  }
  if (legacyStatus === "cancelled") return "cancelled";
  if (legacyStatus === "blocked") return "blocked";
  if (legacyStatus === "queued") {
    return ["failed", "unknown"].includes(latestAttemptStatus ?? "")
      ? "needs_reconciliation"
      : "accepted";
  }
  if (["moderating_input", "running", "moderating_output"].includes(legacyStatus)) {
    return ["failed", "unknown"].includes(latestAttemptStatus ?? "")
      ? "needs_reconciliation"
      : "processing";
  }
  if (legacyStatus === "failed") {
    if (latestAttemptStatus === "unknown") return "needs_reconciliation";
    return deliveredCount > 0 ? "partially_succeeded" : "failed";
  }
  if (deliveredCount >= expectedOutputCount && expectedOutputCount > 0) return "succeeded";
  if (deliveredCount > 0) return "partially_succeeded";
  return "needs_reconciliation";
}

function unknownReconciliationResolution(
  event: { readonly type: string; readonly metadata: Prisma.JsonValue } | null,
  attemptId: string | null,
) {
  if (!attemptId || jsonRecord(event?.metadata ?? null).attemptId !== attemptId) {
    return null;
  }
  if (event?.type === "unknown_reconciliation_adopt_succeeded") {
    return "adopt_succeeded" as const;
  }
  if (event?.type === "unknown_reconciliation_confirm_failed") {
    return "confirm_failed" as const;
  }
  if (event?.type === "unknown_reconciliation_remain_unknown") {
    return "remain_unknown" as const;
  }
  return null;
}

function jsonRecord(value: Prisma.JsonValue | null) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Prisma.JsonObject
    : {};
}

function stringArray(value: Prisma.JsonValue | undefined) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function unknownReviewProjection(
  event: { readonly type: string; readonly metadata: Prisma.JsonValue } | null,
  attemptId: string | null,
  now: Date,
) {
  if (
    event?.type !== "unknown_reconciliation_remain_unknown" ||
    !attemptId ||
    jsonRecord(event.metadata).attemptId !== attemptId
  ) {
    return { status: "not_applicable" as const, nextReviewAt: null };
  }
  const value = jsonRecord(event.metadata).nextReviewAt;
  if (typeof value !== "string") {
    return { status: "not_applicable" as const, nextReviewAt: null };
  }
  const nextReviewAt = new Date(value);
  if (Number.isNaN(nextReviewAt.getTime())) {
    return { status: "not_applicable" as const, nextReviewAt: null };
  }
  return {
    status: nextReviewAt <= now ? "due" as const : "scheduled" as const,
    nextReviewAt: nextReviewAt.toISOString(),
  };
}

type JobProjectionRow = Prisma.GenerationJobGetPayload<{
  include: { _count: { select: { assets: true } } };
}>;
type AttemptRow = Prisma.GenerationAttemptGetPayload<Record<string, never>>;

function settlementView(settlement: { captured: number; refunded: number }) {
  if (settlement.captured === 0) return "not_required" as const;
  if (settlement.refunded >= settlement.captured) return "refunded" as const;
  if (settlement.refunded > 0) return "partially_refunded" as const;
  return "captured" as const;
}

function generationJobProjection(
  row: JobProjectionRow,
  latestAttempt: AttemptRow | null,
  deliveries: Readonly<Record<string, number>>,
  settlement: { captured: number; refunded: number },
  unknownReview: {
    readonly status: "not_applicable" | "scheduled" | "due";
    readonly nextReviewAt: string | null;
  },
  latestUnknownResolution: "adopt_succeeded" | "confirm_failed" | "remain_unknown" | null,
) {
  const deliveredCount = deliveries.delivered ?? 0;
  return {
    id: row.id,
    userId: row.userId,
    characterId: row.characterId,
    derivedFromJobId: row.derivedFromJobId,
    mode: row.mode,
    requestOutcome: requestOutcome(
      row.status,
      row.outputCount,
      deliveredCount,
      latestAttempt?.status ?? null,
      latestUnknownResolution,
    ),
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
    unknownReview,
    delivery: {
      expectedOutputCount: row.outputCount,
      deliveredCount,
      pendingCount: deliveries.pending ?? 0,
      failedCount: deliveries.failed ?? 0,
      suppressedCount: deliveries.suppressed ?? 0,
    },
    settlement: {
      view: settlementView(settlement),
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
}

export type GenerationJobsQueryAuthorityDb = Pick<
  Prisma.TransactionClient,
  | "generationJob"
  | "generationAttempt"
  | "generationDelivery"
  | "generationSettlementLink"
  | "dreamcoinLedger"
  | "generationJobEvent"
>;

export async function queryGenerationJobsV2Authority(input: {
  readonly db: GenerationJobsQueryAuthorityDb;
  readonly query: GenerationJobQuery;
  readonly now?: Date;
}): Promise<GenerationJobListResponse> {
  const { db, query } = input;
  const now = input.now ?? new Date();
  const filters = baseWhere(query);
  const queryHash = cursorQueryHash(query);
  const cursor = query.cursor ? decodeCursor(query.cursor, query.sort, queryHash) : null;
  const pageWhere: Prisma.GenerationJobWhereInput = cursor ? { AND: [filters, cursorWhere(cursor)] } : filters;

  const rows = await db.generationJob.findMany({
    where: pageWhere,
    orderBy: sortOrder(query.sort),
    take: query.limit + 1,
    include: { _count: { select: { assets: true } } },
  });
  const totals = await db.generationJob.aggregate({
    where: filters,
    _count: { _all: true },
    _sum: { costDreamcoins: true, outputCount: true, deliveredOutputCount: true },
  });
  const statusGroups = await db.generationJob.groupBy({ by: ["status"], where: filters, _count: { _all: true } });
  const modeGroups = await db.generationJob.groupBy({ by: ["mode"], where: filters, _count: { _all: true } });
  const providerGroups = await db.generationJob.groupBy({ by: ["provider"], where: filters, _count: { _all: true } });
  const sourceGroups = await db.generationJob.groupBy({ by: ["sourceType"], where: filters, _count: { _all: true } });
  const hasNextPage = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const pageIds = page.map((row) => row.id);
  const attempts = pageIds.length > 0
    ? await db.generationAttempt.findMany({
        where: { requestId: { in: pageIds } },
        orderBy: [{ requestId: "asc" }, { attemptNo: "desc" }],
      })
    : [];
  const deliveryGroups = pageIds.length > 0
    ? await db.generationDelivery.groupBy({
        by: ["requestId", "status"],
        where: { requestId: { in: pageIds } },
        _count: { _all: true },
      })
    : [];
  const settlementLinks = pageIds.length > 0
    ? await db.generationSettlementLink.findMany({
        where: { requestId: { in: pageIds } },
        select: { requestId: true, ledgerEntryId: true },
      })
    : [];
  const reconciliationEvents = pageIds.length > 0
    ? await db.generationJobEvent.findMany({
        where: {
          jobId: { in: pageIds },
          type: {
            in: [
              "unknown_reconciliation_adopt_succeeded",
              "unknown_reconciliation_confirm_failed",
              "unknown_reconciliation_remain_unknown",
            ],
          },
        },
        orderBy: [{ jobId: "asc" }, { createdAt: "desc" }, { id: "desc" }],
      })
    : [];
  const ledgerEntries = settlementLinks.length > 0 ? await db.dreamcoinLedger.findMany({
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
  const latestReconciliationByRequest = new Map<
    string,
    (typeof reconciliationEvents)[number]
  >();
  for (const event of reconciliationEvents) {
    if (!latestReconciliationByRequest.has(event.jobId)) {
      latestReconciliationByRequest.set(event.jobId, event);
    }
  }
  const response = generationJobListResponseSchema.parse({
    items: page.map((row) => generationJobProjection(
      row,
      latestAttemptByRequest.get(row.id) ?? null,
      deliveriesByRequest.get(row.id) ?? {},
      settlementByRequest.get(row.id) ?? { captured: 0, refunded: 0 },
      unknownReviewProjection(
        latestReconciliationByRequest.get(row.id) ?? null,
        latestAttemptByRequest.get(row.id)?.id ?? null,
        now,
      ),
      unknownReconciliationResolution(
        latestReconciliationByRequest.get(row.id) ?? null,
        latestAttemptByRequest.get(row.id)?.id ?? null,
      ),
    )),
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
    dataScope: OPERATIONAL_USER_DATA_SCOPE,
    asOf: now.toISOString(),
    freshness: "fresh",
  });
  return response;
}

export async function listGenerationJobsV2(request: Request) {
  await actorWithPermission(request, "generation.job.read");
  const query = queryParams(request, "GET /api/v2/admin/jobs");
  const response = await queryGenerationJobsV2Authority({ db: prisma, query });
  return ok(response, { headers: { "Cache-Control": "no-store" } });
}

export async function getGenerationJobV2(request: Request, requestId: string) {
  await actorWithPermission(request, "generation.job.read");
  const row = await prisma.generationJob.findFirst({
    where: operationalGenerationJobWhere({ id: requestId }),
    include: { _count: { select: { assets: true } } },
  });
  if (!row) throw Errors.notFound("Generation Request not found");
  const attempts = await prisma.generationAttempt.findMany({
    where: { requestId },
    orderBy: { attemptNo: "asc" },
  });
  const attemptIds = attempts.map((attempt) => attempt.id);
  const [
    events,
    transportExecutions,
    artifacts,
    deliveries,
    settlementLinks,
    unknownAuthorityEvents,
    terminalReceipts,
  ] = await Promise.all([
    attemptIds.length > 0 ? prisma.generationAttemptEvent.findMany({
      where: { attemptId: { in: attemptIds } },
      orderBy: [{ occurredAt: "asc" }, { sequence: "asc" }],
    }) : [],
    attemptIds.length > 0 ? prisma.generationTransportExecution.findMany({
      where: { attemptId: { in: attemptIds } },
      orderBy: [{ attemptId: "asc" }, { transportAttemptNo: "asc" }],
    }) : [],
    attemptIds.length > 0 ? prisma.generationArtifact.findMany({
      where: { attemptId: { in: attemptIds } },
      orderBy: [{ attemptId: "asc" }, { ordinal: "asc" }],
    }) : [],
    prisma.generationDelivery.findMany({
      where: { requestId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    prisma.generationSettlementLink.findMany({
      where: { requestId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    prisma.generationJobEvent.findMany({
      where: {
        jobId: requestId,
        type: {
          in: [
            "unknown_terminal_evidence_recovered",
            "unknown_terminal_resolution_evidence_recovered",
            "unknown_reconciliation_adopt_succeeded",
            "unknown_reconciliation_confirm_failed",
            "unknown_reconciliation_remain_unknown",
            "unknown_reconciliation_review_due",
          ],
        },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    attemptIds.length > 0 ? prisma.inboundEventReceipt.findMany({
      where: {
        sourceService: { in: ["gen", "gen_resolution"] },
        sourceEventId: { in: attemptIds },
      },
    }) : [],
  ]);
  const ledgerEntries = settlementLinks.length > 0 ? await prisma.dreamcoinLedger.findMany({
    where: { id: { in: settlementLinks.map((link) => link.ledgerEntryId) } },
    select: { id: true, delta: true, reason: true, createdAt: true },
  }) : [];
  const ledgerById = new Map(ledgerEntries.map((entry) => [entry.id, entry]));
  const deliveryCounts: Record<string, number> = {};
  for (const delivery of deliveries) deliveryCounts[delivery.status] = (deliveryCounts[delivery.status] ?? 0) + 1;
  const settlement = { captured: 0, refunded: 0 };
  for (const link of settlementLinks) {
    const entry = ledgerById.get(link.ledgerEntryId);
    if (!entry) continue;
    if (entry.reason === "generation_spend" && entry.delta < 0) settlement.captured += -entry.delta;
    if (entry.reason === "refund" && entry.delta > 0) settlement.refunded += entry.delta;
  }
  const latestAttempt = attempts.at(-1) ?? null;
  const providerByAttemptId = new Map(attempts.map((attempt) => [attempt.id, attempt.provider]));
  const unknownReconciliationEvents = unknownAuthorityEvents.filter((event) =>
    [
      "unknown_reconciliation_adopt_succeeded",
      "unknown_reconciliation_confirm_failed",
      "unknown_reconciliation_remain_unknown",
    ].includes(event.type)
  );
  const dueReconciliationEventIds = new Set(
    unknownAuthorityEvents
      .filter((event) => event.type === "unknown_reconciliation_review_due")
      .flatMap((event) => {
        const value = jsonRecord(event.metadata).reconciliationEventId;
        return typeof value === "string" ? [value] : [];
      }),
  );
  const latestRecoveredEvent = unknownAuthorityEvents
    .filter((event) =>
      (event.type === "unknown_terminal_evidence_recovered" ||
        event.type === "unknown_terminal_resolution_evidence_recovered") &&
      jsonRecord(event.metadata).attemptId === latestAttempt?.id
    )
    .at(-1) ?? null;
  const recoveredReceiptSource = latestRecoveredEvent?.type ===
      "unknown_terminal_resolution_evidence_recovered"
    ? "gen_resolution"
    : latestRecoveredEvent?.type === "unknown_terminal_evidence_recovered"
      ? "gen"
      : null;
  const recoveredMetadata = jsonRecord(latestRecoveredEvent?.metadata ?? null);
  const recoveredPayload = aiFinalizePayloadSchema.safeParse(
    recoveredMetadata.recoveredSuccess,
  );
  const recoveredAttemptId = typeof recoveredMetadata.attemptId === "string"
    ? recoveredMetadata.attemptId
    : null;
  const recoveredOutcome = ["succeeded", "failed", "blocked", "unknown"].includes(
    String(recoveredMetadata.terminalRecordOutcome),
  )
    ? recoveredMetadata.terminalRecordOutcome as "succeeded" | "failed" | "blocked" | "unknown"
    : null;
  const recoveredRef = typeof recoveredMetadata.terminalRecordRef === "string"
    ? recoveredMetadata.terminalRecordRef
    : null;
  const recoveredChecksum =
    typeof recoveredMetadata.terminalRecordChecksum === "string" &&
    /^[a-f0-9]{64}$/.test(recoveredMetadata.terminalRecordChecksum)
      ? recoveredMetadata.terminalRecordChecksum
      : null;
  const recoveredTransport = transportExecutions.find((execution) =>
    execution.attemptId === recoveredAttemptId
  ) ?? null;
  const recoveredArtifacts = artifacts.filter(
    (artifact) => artifact.attemptId === recoveredAttemptId,
  );
  const deliveriesByArtifactId = new Map(
    deliveries.map((delivery) => [delivery.artifactId, delivery]),
  );
  const recoveredReceipt = terminalReceipts.find(
    (receipt) =>
      receipt.sourceService === recoveredReceiptSource &&
      receipt.sourceEventId === recoveredAttemptId,
  ) ?? null;
  const recoveredAssetCount = typeof recoveredMetadata.assetCount === "number"
    ? recoveredMetadata.assetCount
    : recoveredArtifacts.length;
  const unknownTerminalEvidence =
    recoveredAttemptId && recoveredOutcome && recoveredRef && recoveredTransport
      ? {
          attemptId: recoveredAttemptId,
          outcome: recoveredOutcome,
          transportStatus: recoveredTransport.status,
          terminalRecordRef: recoveredRef,
          terminalRecordChecksum: recoveredChecksum,
          artifactCount: recoveredAssetCount,
          adoptable:
            recoveredOutcome === "succeeded" &&
            recoveredTransport.status === "unknown" &&
            latestAttempt?.id === recoveredAttemptId &&
            latestAttempt.status === "unknown" &&
            ["queued", "moderating_input", "running", "moderating_output", "failed"].includes(row.status) &&
            settlement.refunded === 0 &&
            recoveredChecksum !== null &&
            recoveredPayload.success &&
            recoveredPayload.data.kind === "generation.completed" &&
            recoveredPayload.data.attemptId === recoveredAttemptId &&
            recoveredPayload.data.generationJobId === row.id &&
            recoveredPayload.data.terminalRecordRef === recoveredRef &&
            recoveredPayload.data.terminalRecordChecksum === recoveredChecksum &&
            latestAttempt.terminalRecordRef ===
              (recoveredReceiptSource === "gen"
                ? recoveredRef
                : recoveredMetadata.originalTerminalRecordRef ?? null) &&
            recoveredTransport.terminalRecordRef ===
              (recoveredReceiptSource === "gen"
                ? recoveredRef
                : recoveredMetadata.originalTerminalRecordRef ?? null) &&
            recoveredArtifacts.length === recoveredAssetCount &&
            recoveredArtifacts.every((artifact, ordinal) =>
              artifact.ordinal === ordinal &&
              artifact.validationState === "late_after_unknown" &&
              artifact.archiveState === "archived" &&
              artifact.assetId === null &&
              artifact.terminalRecordChecksum === recoveredChecksum &&
              deliveriesByArtifactId.get(artifact.id)?.status === "suppressed"
            ) &&
            recoveredReceipt?.processingState === "processed" &&
            (recoveredReceipt.payloadHash === canonicalSha256({
              terminalRecordRef: recoveredRef,
              terminalRecordChecksum: recoveredChecksum,
            }) ||
              (recoveredReceiptSource === "gen" &&
                recoveredReceipt.payloadHash === recoveredChecksum)) &&
            (recoveredReceiptSource === "gen" ||
              (recoveredMetadata.resolutionReceiptId === recoveredReceipt.id &&
                recoveredMetadata.resolutionPayloadHash ===
                  recoveredReceipt.payloadHash)),
          adoptionBlockReason: settlement.refunded > 0
            ? "request_already_refunded"
            : !["queued", "moderating_input", "running", "moderating_output", "failed"].includes(row.status)
              ? "request_not_reconcilable"
              : null,
        }
      : null;
  const detailNow = new Date();
  const response = generationJobDetailResponseSchema.parse({
    request: generationJobProjection(
      row,
      latestAttempt,
      deliveryCounts,
      settlement,
      unknownReviewProjection(
        unknownReconciliationEvents.at(-1) ?? null,
        latestAttempt?.id ?? null,
        detailNow,
      ),
      unknownReconciliationResolution(
        unknownReconciliationEvents.at(-1) ?? null,
        latestAttempt?.id ?? null,
      ),
    ),
    attempts: attempts.map((attempt) => ({
      id: attempt.id,
      attemptNo: attempt.attemptNo,
      status: attemptStatus(attempt.status),
      provider: attempt.provider,
      profileKey: attempt.profileKey,
      profileVersion: attempt.profileVersion,
      workflowKey: attempt.workflowKey,
      workflowVersion: attempt.workflowVersion,
      errorClass: attempt.errorClass,
      errorCode: attempt.errorCode,
      errorSignature: attempt.errorSignature,
      retryability: attempt.retryability,
      operatorGuidance: attempt.operatorGuidance,
      startedAt: attempt.startedAt?.toISOString() ?? null,
      finishedAt: attempt.finishedAt?.toISOString() ?? null,
      createdAt: attempt.createdAt.toISOString(),
    })),
    transportExecutions: transportExecutions.map((execution) => ({
      id: execution.id,
      attemptId: execution.attemptId,
      transportAttemptNo: execution.transportAttemptNo,
      provider: providerByAttemptId.get(execution.attemptId)?.trim() || null,
      providerRequestId: execution.providerRequestId?.trim() || null,
      idempotencyKey: execution.idempotencyKey?.trim() || null,
      status: execution.status,
      latencyMs: execution.latencyMs,
      costMicros: execution.costMicros === null ? null : Number(execution.costMicros),
      pricingVersion: execution.pricingVersion?.trim() || null,
      terminalRecordRef: execution.terminalRecordRef?.trim() || null,
      startedAt: execution.startedAt.toISOString(),
      finishedAt: execution.finishedAt?.toISOString() ?? null,
    })),
    events: events.map((event) => ({
      id: event.id,
      attemptId: event.attemptId,
      sequence: event.sequence,
      eventType: event.eventType,
      outcome: event.outcome,
      occurredAt: event.occurredAt.toISOString(),
    })),
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      attemptId: artifact.attemptId,
      ordinal: artifact.ordinal,
      validationState: artifact.validationState,
      archiveState: artifact.archiveState,
      assetId: artifact.assetId,
      createdAt: artifact.createdAt.toISOString(),
    })),
    deliveries: deliveries.map((delivery) => ({
      id: delivery.id,
      artifactId: delivery.artifactId,
      targetType: delivery.targetType,
      targetId: delivery.targetId,
      status: delivery.status,
      deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
      createdAt: delivery.createdAt.toISOString(),
    })),
    settlementEntries: settlementLinks.flatMap((link) => {
      const entry = ledgerById.get(link.ledgerEntryId);
      return entry ? [{
        ledgerEntryId: entry.id,
        kind: link.kind,
        deltaDreamcoins: entry.delta,
        reason: entry.reason,
        createdAt: entry.createdAt.toISOString(),
      }] : [];
    }),
    unknownReconciliations: unknownReconciliationEvents.flatMap((event) => {
      const metadata = jsonRecord(event.metadata);
      const resolution = metadata.resolution;
      const attemptId = metadata.attemptId;
      const actorId = metadata.actorId;
      if (
        (
          resolution !== "adopt_succeeded" &&
          resolution !== "confirm_failed" &&
          resolution !== "remain_unknown"
        ) ||
        typeof attemptId !== "string" ||
        typeof actorId !== "string" ||
        !event.message
      ) {
        return [];
      }
      return [{
        id: event.id,
        attemptId,
        resolution,
        actorId,
        reason: event.message,
        providerEvidenceRefs: stringArray(metadata.providerEvidenceRefs),
        nextReviewAt:
          typeof metadata.nextReviewAt === "string"
            ? metadata.nextReviewAt
            : null,
        reviewStatus: resolution === "remain_unknown"
          ? dueReconciliationEventIds.has(event.id) ||
              (
                typeof metadata.nextReviewAt === "string" &&
                new Date(metadata.nextReviewAt) <= detailNow
              )
            ? "due"
            : "scheduled"
          : "not_applicable",
        refundAmount:
          typeof metadata.refundAmount === "number"
            ? metadata.refundAmount
            : 0,
        deliveredCount:
          typeof metadata.deliveredCount === "number"
            ? metadata.deliveredCount
            : 0,
        occurredAt: event.createdAt.toISOString(),
      }];
    }),
    unknownTerminalEvidence,
    asOf: detailNow.toISOString(),
    freshness: "fresh",
  });
  return ok(response, { headers: { "Cache-Control": "no-store" } });
}
