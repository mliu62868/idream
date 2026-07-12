import type {
  Appeal,
  ContentReport,
  GenerationAttempt,
  Prisma,
  PrismaClient,
  SupportRequest,
} from "@prisma/client";
import { adminBackfillResultSchema } from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import {
  applyCustomerCaseBackfill,
  applyReviewCaseBackfill,
  transformCustomerCaseBackfill,
  transformReviewCaseBackfill,
  type ReviewCaseBackfillSource,
} from "@/server/modules/admin-v2/cases/service";
import {
  applyGenerationIncidentBackfill,
  transformGenerationIncidentBackfill,
} from "@/server/modules/admin-v2/incidents/service";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";

export const PRODUCTION_BACKFILL_DOMAINS = [
  "generation_incident_v1",
  "customer_case_v1",
  "review_case_v1",
] as const;

export type ProductionBackfillDomain = (typeof PRODUCTION_BACKFILL_DOMAINS)[number];
export type ProductionBackfillMode = "dry_run" | "apply";

type BackfillActor = { readonly id: string; readonly role: string };
type BackfillContinuationInput = { readonly runId: string; readonly batchKey?: string };
type BackfillStartInput = {
  readonly dryRun: boolean;
  readonly cursor?: string;
  readonly batchSize?: number;
  readonly stableRunId?: string;
  readonly optionsHash?: string;
  readonly batchKey?: string;
};
type ActorBackfillStartInput = BackfillStartInput & { readonly actor: BackfillActor };
type IncidentBackfillStartInput = BackfillStartInput & { readonly actor?: BackfillActor };

export interface ProductionBackfillOptions {
  readonly runId?: string;
  readonly batchKey?: string;
  readonly expectedDomain?: ProductionBackfillDomain;
  readonly stableRunId?: string;
  readonly optionsHash?: string;
  readonly domain?: ProductionBackfillDomain;
  readonly mode?: ProductionBackfillMode;
  readonly batchSize?: number;
  readonly initialCursor?: string;
  readonly stopAtId?: string;
  readonly actor?: BackfillActor;
}

type BackfillSummary = {
  scanned: number;
  eligible: number;
  applied: number;
  unavailable: number;
  mismatch: number;
  skipped: number;
};

type BackfillBatchState = {
  readonly activeKey?: string;
  readonly lastCompletedKey?: string;
};

function batchStateOf(value: Prisma.JsonValue): BackfillBatchState {
  const state = record(value).httpBatch;
  if (!state || typeof state !== "object" || Array.isArray(state)) return {};
  const source = state as Record<string, unknown>;
  return {
    activeKey: typeof source.activeKey === "string" ? source.activeKey : undefined,
    lastCompletedKey: typeof source.lastCompletedKey === "string"
      ? source.lastCompletedKey
      : undefined,
  };
}

function persistedSummary(summary: BackfillSummary, batchState: BackfillBatchState) {
  return toInputJson({ ...summary, httpBatch: batchState });
}

type IncidentCandidate = {
  readonly entityType: "generation_attempt";
  readonly entityId: string;
  readonly source: GenerationAttempt;
};
type CustomerCandidate = {
  readonly entityType: "support_request";
  readonly entityId: string;
  readonly source: SupportRequest;
};
type ReviewCandidate = {
  readonly entityType: "content_report" | "appeal";
  readonly entityId: string;
  readonly source: ReviewCaseBackfillSource;
};
type BackfillCandidate = IncidentCandidate | CustomerCandidate | ReviewCandidate;

type BackfillPlan = {
  classification: "eligible" | "unavailable" | "mismatch";
  action: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  mismatches: Array<{ code: string; detail: string }>;
};

type ReviewCursor = { contentReportId?: string; appealId?: string };

const EMPTY_SUMMARY: BackfillSummary = {
  scanned: 0,
  eligible: 0,
  applied: 0,
  unavailable: 0,
  mismatch: 0,
  skipped: 0,
};

function record(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function summaryOf(value: Prisma.JsonValue): BackfillSummary {
  const input = record(value);
  return {
    scanned: Number(input.scanned ?? 0),
    eligible: Number(input.eligible ?? 0),
    applied: Number(input.applied ?? 0),
    unavailable: Number(input.unavailable ?? 0),
    mismatch: Number(input.mismatch ?? 0),
    skipped: Number(input.skipped ?? 0),
  };
}

function actorFromRun(value: Prisma.JsonValue): BackfillActor {
  const actor = record(record(value).actor as Prisma.JsonValue | undefined);
  if (typeof actor.id !== "string" || typeof actor.role !== "string") {
    throw new Error("Backfill run has no persisted actor authority");
  }
  return { id: actor.id, role: actor.role };
}

function encodeReviewCursor(cursor: ReviewCursor): string | null {
  if (!cursor.contentReportId && !cursor.appealId) return null;
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeReviewCursor(value: string | null | undefined): ReviewCursor {
  if (!value) return {};
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    return {
      ...(typeof parsed.contentReportId === "string" ? { contentReportId: parsed.contentReportId } : {}),
      ...(typeof parsed.appealId === "string" ? { appealId: parsed.appealId } : {}),
    };
  } catch {
    throw new Error("Review Case backfill cursor is invalid");
  }
}

async function domainCounts(
  db: PrismaClient,
  domain: ProductionBackfillDomain,
  initialCursor: string | null = null,
  stopAtId: string | null = null,
) {
  if (domain === "generation_incident_v1") {
    const [sourceCount, targetCount] = await Promise.all([
      db.generationAttempt.count({ where: { status: { in: ["failed", "unknown"] }, ...boundedIdWhere(initialCursor, stopAtId) } }),
      db.opsIncidentOccurrence.count(),
    ]);
    return { sourceCount, targetCount };
  }
  if (domain === "customer_case_v1") {
    const [sourceCount, targetCount] = await Promise.all([
      db.supportRequest.count({ where: boundedIdWhere(initialCursor, stopAtId) }),
      db.adminCase.count({ where: { type: { in: ["support_request", "billing_dispute"] } } }),
    ]);
    return { sourceCount, targetCount };
  }
  const reviewCursor = decodeReviewCursor(initialCursor);
  const reviewStop = decodeReviewCursor(stopAtId);
  const [reports, appeals, targetCount] = await Promise.all([
    db.contentReport.count({ where: boundedIdWhere(reviewCursor.contentReportId ?? null, reviewStop.contentReportId ?? null) }),
    db.appeal.count({ where: boundedIdWhere(reviewCursor.appealId ?? null, reviewStop.appealId ?? null) }),
    db.adminCase.count({ where: { type: { in: ["content_report", "appeal"] } } }),
  ]);
  return { sourceCount: reports + appeals, targetCount };
}

async function snapshotStopAtId(db: PrismaClient, domain: ProductionBackfillDomain) {
  if (domain === "generation_incident_v1") {
    return (await db.generationAttempt.findFirst({
      where: { status: { in: ["failed", "unknown"] } },
      orderBy: { id: "desc" },
      select: { id: true },
    }))?.id ?? null;
  }
  if (domain === "customer_case_v1") {
    return (await db.supportRequest.findFirst({ orderBy: { id: "desc" }, select: { id: true } }))?.id ?? null;
  }
  const [report, appeal] = await Promise.all([
    db.contentReport.findFirst({ orderBy: { id: "desc" }, select: { id: true } }),
    db.appeal.findFirst({ orderBy: { id: "desc" }, select: { id: true } }),
  ]);
  return encodeReviewCursor({ contentReportId: report?.id, appealId: appeal?.id });
}

async function createRun(db: PrismaClient, options: ProductionBackfillOptions) {
  if (!options.domain || !options.mode || !options.actor) {
    throw new Error("New backfill runs require domain, mode, and actor");
  }
  const batchSize = Math.min(1_000, Math.max(1, options.batchSize ?? 100));
  const stopAtId = options.stopAtId ?? await snapshotStopAtId(db, options.domain);
  const beforeCounts = await domainCounts(db, options.domain, options.initialCursor ?? null, stopAtId);
  return db.adminBackfillRun.create({
    data: {
      id: options.stableRunId,
      domain: options.domain,
      mode: options.mode,
      status: "running",
      cursor: options.initialCursor ?? null,
      stopAtId,
      batchSize,
      optionsHash: options.optionsHash ?? canonicalSha256({
        domain: options.domain,
        mode: options.mode,
        batchSize,
        initialCursor: options.initialCursor ?? null,
        stopAtId,
        actor: options.actor,
      }),
      before: toInputJson({ ...beforeCounts, initialCursor: options.initialCursor ?? null, actor: options.actor }),
      after: {},
      summary: toInputJson(EMPTY_SUMMARY),
    },
  });
}

function boundedIdWhere(cursor: string | null, stopAtId: string | null) {
  if (cursor) return { id: { gt: cursor, ...(stopAtId ? { lte: stopAtId } : {}) } };
  return stopAtId ? { id: { lte: stopAtId } } : {};
}

async function fetchCandidates(
  db: PrismaClient,
  run: { domain: string; cursor: string | null; stopAtId: string | null; batchSize: number },
): Promise<{ batch: BackfillCandidate[]; hasMore: boolean }> {
  if (run.domain === "generation_incident_v1") {
    const rows = await db.generationAttempt.findMany({
      where: { status: { in: ["failed", "unknown"] }, ...boundedIdWhere(run.cursor, run.stopAtId) },
      orderBy: { id: "asc" },
      take: run.batchSize + 1,
    });
    return {
      batch: rows.slice(0, run.batchSize).map((source) => ({ entityType: "generation_attempt", entityId: source.id, source })),
      hasMore: rows.length > run.batchSize,
    };
  }
  if (run.domain === "customer_case_v1") {
    const rows = await db.supportRequest.findMany({
      where: boundedIdWhere(run.cursor, run.stopAtId),
      orderBy: { id: "asc" },
      take: run.batchSize + 1,
    });
    return {
      batch: rows.slice(0, run.batchSize).map((source) => ({ entityType: "support_request", entityId: source.id, source })),
      hasMore: rows.length > run.batchSize,
    };
  }
  if (run.domain !== "review_case_v1") throw new Error(`Unknown backfill domain ${run.domain}`);
  const cursor = decodeReviewCursor(run.cursor);
  const stop = decodeReviewCursor(run.stopAtId);
  const [reports, appeals] = await Promise.all([
    db.contentReport.findMany({
      where: boundedIdWhere(cursor.contentReportId ?? null, stop.contentReportId ?? null),
      orderBy: { id: "asc" },
      take: run.batchSize + 1,
    }),
    db.appeal.findMany({
      where: boundedIdWhere(cursor.appealId ?? null, stop.appealId ?? null),
      orderBy: { id: "asc" },
      take: run.batchSize + 1,
    }),
  ]);
  const merged: ReviewCandidate[] = [
    ...reports.map((row: ContentReport) => ({ entityType: "content_report" as const, entityId: row.id, source: { type: "content_report" as const, row } })),
    ...appeals.map((row: Appeal) => ({ entityType: "appeal" as const, entityId: row.id, source: { type: "appeal" as const, row } })),
  ].sort((left, right) => left.entityType.localeCompare(right.entityType) || left.entityId.localeCompare(right.entityId));
  return { batch: merged.slice(0, run.batchSize), hasMore: merged.length > run.batchSize };
}

function planCandidate(candidate: BackfillCandidate): BackfillPlan {
  if (candidate.entityType === "generation_attempt") return transformGenerationIncidentBackfill(candidate.source);
  if (candidate.entityType === "support_request") return transformCustomerCaseBackfill(candidate.source);
  return transformReviewCaseBackfill(candidate.source);
}

async function applyCandidate(
  db: PrismaClient,
  candidate: BackfillCandidate,
  actor: BackfillActor,
) {
  if (candidate.entityType === "generation_attempt") {
    await applyGenerationIncidentBackfill(db, candidate.entityId);
    return;
  }
  if (candidate.entityType === "support_request") {
    await db.$transaction((tx) => applyCustomerCaseBackfill(tx, candidate.source));
    return;
  }
  await db.$transaction((tx) => applyReviewCaseBackfill(tx, candidate.source, actor));
}

function advanceCursor(domain: string, current: string | null, batch: readonly BackfillCandidate[]) {
  if (domain !== "review_case_v1") return batch.at(-1)?.entityId ?? current;
  const cursor = decodeReviewCursor(current);
  for (const candidate of batch) {
    if (candidate.entityType === "content_report") cursor.contentReportId = candidate.entityId;
    if (candidate.entityType === "appeal") cursor.appealId = candidate.entityId;
  }
  return encodeReviewCursor(cursor);
}

async function reconciliationReport(
  db: PrismaClient,
  run: { id: string; domain: string; mode: string; before: Prisma.JsonValue },
  after: Record<string, number>,
  summary: BackfillSummary,
) {
  const items = await db.adminBackfillItem.findMany({
    where: { runId: run.id },
    orderBy: [{ entityType: "asc" }, { entityId: "asc" }],
    select: { entityType: true, entityId: true, classification: true, mismatches: true },
  });
  const mismatches = items.flatMap((item) => {
    const values = Array.isArray(item.mismatches) ? item.mismatches : [];
    return values.map((value) => ({
      entityType: item.entityType,
      entityId: item.entityId,
      classification: item.classification,
      ...(value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : { detail: String(value) }),
    }));
  });
  const before = record(run.before);
  const sourceCount = Number(before.sourceCount ?? 0);
  return {
    domain: run.domain,
    mode: run.mode,
    before,
    after,
    summary,
    coverage: {
      sourceCount,
      scanned: summary.scanned,
      ratio: sourceCount === 0 ? 1 : summary.scanned / sourceCount,
    },
    mismatches,
  };
}

export async function runProductionBackfillBatch(db: PrismaClient, options: ProductionBackfillOptions) {
  if (options.runId && (options.domain || options.mode || options.batchSize || options.initialCursor || options.stopAtId || options.actor)) {
    throw new Error("runId resumes persisted options; do not submit new backfill options");
  }
  let run = options.runId
    ? await db.adminBackfillRun.findUnique({ where: { id: options.runId } })
    : options.stableRunId
      ? await db.adminBackfillRun.findUnique({ where: { id: options.stableRunId } })
      : null;
  if (options.runId && !run) throw new Error(`Backfill run ${options.runId} was not found`);
  if (run && options.optionsHash && run.optionsHash !== options.optionsHash) {
    throw Errors.conflict("Backfill run is bound to different options", {
      runId: run.id,
      existingOptionsHash: run.optionsHash,
      submittedOptionsHash: options.optionsHash,
    });
  }
  if (!run) run = await createRun(db, options);
  if (options.expectedDomain && run.domain !== options.expectedDomain) {
    throw Errors.conflict("Backfill Run belongs to a different domain", {
      runId: run.id,
      expectedDomain: options.expectedDomain,
      actualDomain: run.domain,
    });
  }
  if (!PRODUCTION_BACKFILL_DOMAINS.includes(run.domain as ProductionBackfillDomain)) {
    throw new Error(`Backfill run ${run.id} has unsupported domain ${run.domain}`);
  }
  if (options.stableRunId && run.status === "paused") {
    return {
      runId: run.id,
      status: "paused" as const,
      nextCursor: run.cursor,
      summary: summaryOf(run.summary),
      report: {},
      reportHash: "",
    };
  }
  const priorBatchState = batchStateOf(run.summary);
  if (options.runId && options.batchKey && run.status === "paused") {
    if (priorBatchState.lastCompletedKey === options.batchKey) {
      return {
        runId: run.id,
        status: "paused" as const,
        nextCursor: run.cursor,
        summary: summaryOf(run.summary),
        report: {},
        reportHash: "",
      };
    }
    const claim = await db.adminBackfillRun.updateMany({
      where: { id: run.id, status: "paused", updatedAt: run.updatedAt },
      data: {
        status: "running",
        summary: persistedSummary(summaryOf(run.summary), {
          activeKey: options.batchKey,
          lastCompletedKey: priorBatchState.lastCompletedKey,
        }),
      },
    });
    if (claim.count !== 1) {
      throw Errors.conflict("Backfill Run batch was claimed by another continuation", {
        runId: run.id,
      });
    }
    run = await db.adminBackfillRun.findUniqueOrThrow({ where: { id: run.id } });
  } else if (options.runId && options.batchKey && run.status === "running") {
    throw Errors.conflict("Backfill Run already has an active continuation", {
      runId: run.id,
    });
  }
  if (run.status === "completed") {
    return {
      runId: run.id,
      status: "completed" as const,
      nextCursor: null,
      summary: summaryOf(run.summary),
      report: record(run.report),
      reportHash: run.reportHash ?? "",
    };
  }
  if (!["running", "paused", "failed"].includes(run.status)) {
    throw new Error(`Backfill run ${run.id} cannot resume from ${run.status}`);
  }
  if (run.status !== "running") {
    run = await db.adminBackfillRun.update({ where: { id: run.id }, data: { status: "running" } });
  }

  const domain = run.domain as ProductionBackfillDomain;
  const actor = actorFromRun(run.before);
  const { batch, hasMore } = await fetchCandidates(db, run);
  const summary = summaryOf(run.summary);
  const activeBatchState: BackfillBatchState = options.batchKey
    ? { activeKey: options.batchKey, lastCompletedKey: priorBatchState.lastCompletedKey }
    : priorBatchState;
  const dryRun = run.mode === "dry_run";
  let nextCursor = run.cursor;

  for (const candidate of batch) {
    const predicted = planCandidate(candidate);
    let plan = predicted;
    let applied = false;
    if (!dryRun && predicted.classification === "eligible") {
      try {
        await applyCandidate(db, candidate, actor);
        applied = true;
      } catch (error) {
        plan = {
          ...predicted,
          classification: "mismatch",
          mismatches: [...predicted.mismatches, {
            code: "apply_failed",
            detail: error instanceof Error ? error.message : "Unknown transformation failure",
          }],
        };
      }
    }
    summary.scanned += 1;
    summary.eligible += predicted.classification === "eligible" ? 1 : 0;
    summary.applied += applied ? 1 : 0;
    summary.unavailable += plan.classification === "unavailable" ? 1 : 0;
    summary.mismatch += plan.mismatches.length > 0 ? 1 : 0;
    const itemBody = {
      classification: plan.classification,
      action: plan.action,
      before: plan.before,
      after: plan.after,
      mismatches: plan.mismatches,
      applied,
    };
    const candidateCursor = advanceCursor(run.domain, nextCursor, [candidate]);
    await db.$transaction(async (tx) => {
      await tx.adminBackfillItem.upsert({
        where: { runId_entityType_entityId: { runId: run.id, entityType: candidate.entityType, entityId: candidate.entityId } },
        create: {
          runId: run.id,
          entityType: candidate.entityType,
          entityId: candidate.entityId,
          classification: plan.classification,
          action: plan.action,
          before: toInputJson(plan.before),
          after: toInputJson(plan.after),
          mismatches: toInputJson(plan.mismatches),
          checksum: canonicalSha256(itemBody),
          applied,
        },
        update: {},
      });
      await tx.adminBackfillRun.update({
        where: { id: run.id },
        data: { cursor: candidateCursor, summary: persistedSummary(summary, activeBatchState) },
      });
    });
    nextCursor = candidateCursor;
  }

  if (hasMore) {
    const completedBatchState = options.batchKey
      ? { lastCompletedKey: options.batchKey }
      : priorBatchState;
    await db.adminBackfillRun.update({
      where: { id: run.id },
      data: {
        status: "paused",
        cursor: nextCursor,
        summary: persistedSummary(summary, completedBatchState),
      },
    });
    return { runId: run.id, status: "paused" as const, nextCursor, summary, report: {}, reportHash: "" };
  }

  const initialCursor = typeof record(run.before).initialCursor === "string"
    ? record(run.before).initialCursor as string
    : null;
  const after = await domainCounts(db, domain, initialCursor, run.stopAtId);
  const report = await reconciliationReport(db, run, after, summary);
  const reportHash = canonicalSha256(report);
  const completedBatchState = options.batchKey
    ? { lastCompletedKey: options.batchKey }
    : priorBatchState;
  await db.adminBackfillRun.update({
    where: { id: run.id },
    data: {
      status: "completed",
      cursor: nextCursor,
      after: toInputJson(after),
      summary: persistedSummary(summary, completedBatchState),
      report: toInputJson(report),
      reportHash,
      finishedAt: new Date(),
    },
  });
  return { runId: run.id, status: "completed" as const, nextCursor: null, summary, report, reportHash };
}

function firstMismatchReason(value: Prisma.JsonValue) {
  if (!Array.isArray(value)) return "unknown_error";
  const first = value[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) return "unknown_error";
  const mismatch = first as Record<string, unknown>;
  return typeof mismatch.code === "string"
    ? mismatch.code
    : typeof mismatch.detail === "string"
      ? mismatch.detail
      : "unknown_error";
}

async function legacyItems(db: PrismaClient, runId: string) {
  return db.adminBackfillItem.findMany({ where: { runId }, orderBy: [{ entityType: "asc" }, { entityId: "asc" }] });
}

export async function backfillGenerationIncidents(
  input: BackfillContinuationInput | IncidentBackfillStartInput,
) {
  const db = prisma;
  const result = await runProductionBackfillBatch(db, "runId" in input
    ? { runId: input.runId, batchKey: input.batchKey, expectedDomain: "generation_incident_v1" }
    : {
        domain: "generation_incident_v1",
        mode: input.dryRun ? "dry_run" : "apply",
        batchSize: input.batchSize,
        initialCursor: input.cursor,
        actor: input.actor ?? { id: "system:production-backfill", role: "system" },
        batchKey: input.batchKey,
        stableRunId: input.stableRunId,
        optionsHash: input.optionsHash,
      });
  const run = await db.adminBackfillRun.findUniqueOrThrow({ where: { id: result.runId } });
  const beforeOccurrences = Number(record(run.before).targetCount ?? 0);
  const afterOccurrences = Number(
    record(run.after).targetCount ?? await db.opsIncidentOccurrence.count(),
  );
  const items = await legacyItems(db, result.runId);
  return adminBackfillResultSchema.parse({
    domain: "generation_incident_v1",
    runId: result.runId,
    status: result.status,
    optionsHash: run.optionsHash,
    dryRun: run.mode === "dry_run",
    scanned: result.summary.scanned,
    eligible: result.summary.eligible,
    applied: result.summary.applied,
    unavailable: items.filter((item) => item.classification === "unavailable").map((item) => ({ attemptId: item.entityId, reason: firstMismatchReason(item.mismatches) })),
    mismatches: items.filter((item) => item.classification === "mismatch").map((item) => ({ attemptId: item.entityId, reason: firstMismatchReason(item.mismatches) })),
    nextCursor: result.nextCursor,
    beforeOccurrences,
    afterOccurrences,
  });
}

export async function backfillCustomerCases(
  input: BackfillContinuationInput | ActorBackfillStartInput,
) {
  const db = prisma;
  const result = await runProductionBackfillBatch(db, "runId" in input
    ? { runId: input.runId, batchKey: input.batchKey, expectedDomain: "customer_case_v1" }
    : {
        domain: "customer_case_v1",
        mode: input.dryRun ? "dry_run" : "apply",
        batchSize: input.batchSize,
        initialCursor: input.cursor,
        actor: input.actor,
        batchKey: input.batchKey,
        stableRunId: input.stableRunId,
        optionsHash: input.optionsHash,
      });
  const run = await db.adminBackfillRun.findUniqueOrThrow({ where: { id: result.runId } });
  const beforeCases = Number(record(run.before).targetCount ?? 0);
  const afterCases = Number(
    record(run.after).targetCount
      ?? await db.adminCase.count({ where: { type: { in: ["support_request", "billing_dispute"] } } }),
  );
  const items = await legacyItems(db, result.runId);
  return adminBackfillResultSchema.parse({
    domain: "customer_case_v1",
    runId: result.runId,
    status: result.status,
    optionsHash: run.optionsHash,
    dryRun: run.mode === "dry_run",
    scanned: result.summary.scanned,
    eligible: result.summary.eligible,
    applied: result.summary.applied,
    unavailable: [],
    mismatches: items.filter((item) => item.classification === "mismatch").map((item) => ({ sourceType: item.entityType, sourceId: item.entityId, reason: firstMismatchReason(item.mismatches) })),
    nextCursor: result.nextCursor,
    beforeCases,
    afterCases,
  });
}

export async function backfillReviewCases(
  input: BackfillContinuationInput | ActorBackfillStartInput,
) {
  const db = prisma;
  const result = await runProductionBackfillBatch(db, "runId" in input
    ? { runId: input.runId, batchKey: input.batchKey, expectedDomain: "review_case_v1" }
    : {
        domain: "review_case_v1",
        mode: input.dryRun ? "dry_run" : "apply",
        batchSize: input.batchSize,
        initialCursor: input.cursor,
        actor: input.actor,
        batchKey: input.batchKey,
        stableRunId: input.stableRunId,
        optionsHash: input.optionsHash,
      });
  const run = await db.adminBackfillRun.findUniqueOrThrow({ where: { id: result.runId } });
  const beforeCases = Number(record(run.before).targetCount ?? 0);
  const afterCases = Number(
    record(run.after).targetCount
      ?? await db.adminCase.count({ where: { type: { in: ["content_report", "appeal"] } } }),
  );
  const items = await legacyItems(db, result.runId);
  return adminBackfillResultSchema.parse({
    domain: "review_case_v1",
    runId: result.runId,
    status: result.status,
    optionsHash: run.optionsHash,
    dryRun: run.mode === "dry_run",
    scanned: result.summary.scanned,
    eligible: result.summary.eligible,
    applied: result.summary.applied,
    unavailable: [],
    mismatches: items.filter((item) => item.classification === "mismatch").map((item) => ({ sourceType: item.entityType, sourceId: item.entityId, reason: firstMismatchReason(item.mismatches) })),
    nextCursor: result.nextCursor,
    beforeCases,
    afterCases,
  });
}
