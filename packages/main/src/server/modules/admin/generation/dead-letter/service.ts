import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { ensureGenerationSettlementLinks } from "@/server/ai/generation-settlement";
import { recordGenerationAttemptQueuedEvent } from "@/server/ai/generation-attempt-events";
import { transitionGenerationRequest } from "@/server/ai/generation-request-transition";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { appendLedger } from "@/server/modules/admin/billing/ledger";
import { deriveGenerationJobState, deriveGenerationTimeline } from "@/server/modules/admin/generation-job-state";
import {
  OPERATIONAL_USER_DATA_SCOPE,
  operationalGenerationJobWhere,
} from "@/server/modules/admin/shared/metric-data-scope";
import { actorWithPermission, clampInt, jsonBody, toInputJson, writeAudit, type AdminActor } from "@/server/modules/admin/shared/legacy-primitives";
import { publicUser, redactGenerationJob as redactJob } from "@/server/modules/admin/shared/presenters";
import { decodeAdminListCursor, encodeAdminListCursor } from "@/server/modules/admin-v2/shared/list-cursor";
import type { ExistingGenerationJob } from "@/server/modules/generation/attempt-dispatch";

const requeueSchema = z.object({
  reason: z.string().trim().max(2_000).optional(),
  confirmation: z.string().trim().min(1).max(160),
});

const discardSchema = z.object({
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const deadLetterBatchSchema = z.object({
  jobIds: z.array(z.string().trim().min(1).max(160)).min(1).max(100),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(20_000),
});

export async function listGenerationJobs(request: Request) {
  await actorWithPermission(request, "generation.job.read");
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? undefined;
  const mode = url.searchParams.get("mode") ?? "image";
  const userId = url.searchParams.get("userId") ?? undefined;
  const jobs = await prisma.generationJob.findMany({
    where: operationalGenerationJobWhere({
      status,
      mode: mode === "all" ? undefined : mode,
      userId,
    }),
    include: { user: true, assets: true },
    orderBy: { createdAt: "desc" },
    take: clampInt(url.searchParams.get("limit"), 1, 100, 50),
  });
  return ok({
    items: jobs.map((job) => redactJob(job)),
    dataScope: OPERATIONAL_USER_DATA_SCOPE,
  });
}

export async function getGenerationJobDetail(request: Request, jobId: string) {
  await actorWithPermission(request, "generation.job.read");
  const job = await prisma.generationJob.findUnique({
    where: { id: jobId },
    include: { user: true, character: true, assets: true, events: { orderBy: { createdAt: "asc" } } },
  });
  if (!job) throw Errors.notFound("Generation job not found");
  const [moderationEvents, ledger] = await Promise.all([
    prisma.moderationEvent.findMany({ where: { targetType: "generation_job", targetId: job.id }, orderBy: { createdAt: "asc" } }),
    prisma.dreamcoinLedger.findMany({ where: { sourceId: job.id }, orderBy: { createdAt: "asc" } }),
  ]);
  const state = deriveGenerationJobState({
    status: job.status,
    completedAt: job.completedAt,
    finishedAt: job.finishedAt,
    errorCode: job.errorCode,
    assets: job.assets,
    events: job.events,
    ledgerEntries: ledger,
  });
  return ok({
    job: redactJob(job),
    user: publicUser(job.user),
    character: job.character ? { id: job.character.id, name: job.character.name, status: job.character.status } : null,
    assets: job.assets.map((asset) => ({
      id: asset.id,
      type: asset.type,
      url: asset.url,
      thumbnailUrl: asset.thumbnailUrl,
      safetyStatus: asset.safetyStatus,
      createdAt: asset.createdAt,
    })),
    providerError: job.errorCode ? { code: job.errorCode } : null,
    ledger,
    state,
    timeline: deriveGenerationTimeline({
      status: job.status,
      completedAt: job.completedAt,
      events: job.events,
      moderationEvents,
      ledgerEntries: ledger,
    }),
  });
}

export async function requeueGenerationJob(request: Request, jobId: string) {
  const actor = await actorWithPermission(request, "generation.job.requeue");
  const body = requeueSchema.parse(await jsonBody(request));
  if (body.confirmation !== jobId) throw Errors.badRequest("Confirmation did not match requeue target");
  const job = await prisma.generationJob.findUnique({
    where: { id: jobId },
    include: { assets: true, events: { orderBy: { createdAt: "asc" } } },
  });
  if (!job) throw Errors.notFound("Generation job not found");
  const ledger = await prisma.dreamcoinLedger.findMany({ where: { sourceId: job.id, reason: "refund" } });
  const state = deriveGenerationJobState({
    status: job.status,
    completedAt: job.completedAt,
    finishedAt: job.finishedAt,
    errorCode: job.errorCode,
    assets: job.assets,
    events: job.events,
    ledgerEntries: ledger,
  });
  if (!state.retryEligibility.eligible) {
    throw Errors.conflict("Generation job is not eligible for retry", { reason: state.retryEligibility.reason });
  }
  const attempt = await prisma.$transaction((tx) => stageGenerationRetry(tx, {
    request,
    actor,
    job,
    reason: body.reason ?? "Operator requeue requested",
  }));
  return ok({ queued: true, attemptId: attempt.id, attemptNo: attempt.attemptNo });
}

export async function discardGenerationJob(request: Request, jobId: string) {
  const actor = await actorWithPermission(request, "ops.deadletter.write");
  const body = discardSchema.parse(await jsonBody(request));
  if (body.confirmation !== jobId) throw Errors.badRequest("Confirmation did not match discard target");
  const job = await prisma.generationJob.findUnique({ where: { id: jobId } });
  if (!job) throw Errors.notFound("Generation job not found");
  if (!["failed", "blocked", "refunded"].includes(job.status)) {
    throw Errors.badRequest("Only failed, blocked, or refunded jobs can be discarded");
  }
  const refundedNow = await refundDiscardableJob(job);
  await writeAudit(request, actor, {
    action: "ops.deadletter.discard",
    targetType: "generation_job",
    targetId: job.id,
    reason: body.reason,
    before: { status: job.status, errorCode: job.errorCode },
    after: { status: job.status, settlement: refundedNow ? "refunded" : "already_settled", refunded: refundedNow },
  });
  return ok({ discarded: true, refunded: refundedNow });
}

export async function deadLetterQueue(request: Request) {
  await actorWithPermission(request, "ops.queue.read");
  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.trim() || undefined;
  const statusParam = url.searchParams.get("status");
  const statuses = statusParam && statusParam !== "all"
    ? statusParam.split(",").map((status) => status.trim()).filter(Boolean)
    : ["failed", "blocked"];
  const errorCode = url.searchParams.get("errorCode")?.trim() || undefined;
  const mode = url.searchParams.get("mode")?.trim();
  const limit = clampInt(url.searchParams.get("limit"), 1, 100, 100);
  const queryIdentity = { search, statuses, errorCode, mode: mode && mode !== "all" ? mode : undefined };
  const cursorKeys = adminListCursorKeys(url, "generation_dead_letter", queryIdentity);
  const cursorWhere: Prisma.GenerationJobWhereInput | undefined = cursorKeys ? (() => {
    const updatedAt = adminCursorDate(cursorKeys, 0, "generation_dead_letter");
    const id = adminCursorString(cursorKeys, 1, "generation_dead_letter");
    return { OR: [{ updatedAt: { lt: updatedAt } }, { updatedAt, id: { lt: id } }] };
  })() : undefined;
  const jobs = await prisma.generationJob.findMany({
    where: operationalGenerationJobWhere({
      status: { in: statuses },
      errorCode: errorCode ? { contains: errorCode } : undefined,
      mode: mode && mode !== "all" ? mode : undefined,
      events: { none: { type: "discarded" } },
      AND: [
        ...(cursorWhere ? [cursorWhere] : []),
        ...(search ? [{ OR: [
          { id: { contains: search } },
          { userId: { contains: search } },
          { errorCode: { contains: search } },
          { provider: { contains: search } },
        ] }] : []),
      ],
    }),
    include: { assets: true, events: { orderBy: { createdAt: "asc" } } },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const page = jobs.slice(0, limit);
  const refundedIds = await refundedJobIds(page.map((job) => job.id));
  return ok({
    items: page.map((job) => ({
      ...redactJob(job),
      ledgerState: refundedIds.has(job.id) ? "refunded" : "reserved",
      retryEligibility: deriveGenerationJobState({
        status: job.status,
        completedAt: job.completedAt,
        finishedAt: job.finishedAt,
        errorCode: job.errorCode,
        assets: job.assets,
        events: job.events,
        ledgerEntries: refundedIds.has(job.id) ? [{ reason: "refund", delta: job.costDreamcoins }] : [],
      }).retryEligibility,
    })),
    dataScope: OPERATIONAL_USER_DATA_SCOPE,
    pageInfo: adminListPageInfo(
      "generation_dead_letter",
      queryIdentity,
      page,
      jobs.length > limit,
      (row) => [row.updatedAt.toISOString(), row.id],
    ),
  });
}

export async function requeueDeadLetterBatch(request: Request) {
  const actor = await actorWithPermission(request, "generation.job.requeue");
  const body = deadLetterBatchSchema.parse(await jsonBody(request));
  if (body.confirmation !== deadLetterBatchConfirmation(body.jobIds)) {
    throw Errors.badRequest("Batch requeue confirmation did not match selected jobs");
  }
  const jobs = await prisma.generationJob.findMany({
    where: { id: { in: body.jobIds } },
    include: { assets: true, events: { orderBy: { createdAt: "asc" } } },
  });
  const refundedIds = await refundedJobIds(body.jobIds);
  const requeued: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const eligibleJobs: typeof jobs = [];
  for (const job of jobs) {
    const retryEligibility = deriveGenerationJobState({
      status: job.status,
      completedAt: job.completedAt,
      finishedAt: job.finishedAt,
      errorCode: job.errorCode,
      assets: job.assets,
      events: job.events,
      ledgerEntries: refundedIds.has(job.id) ? [{ reason: "refund", delta: job.costDreamcoins }] : [],
    }).retryEligibility;
    if (!retryEligibility.eligible) skipped.push({ id: job.id, reason: retryEligibility.reason });
    else {
      eligibleJobs.push(job);
      requeued.push(job.id);
    }
  }
  await prisma.$transaction(async (tx) => {
    for (const job of eligibleJobs) await stageGenerationRetry(tx, { request, actor, job, reason: body.reason });
  });
  for (const id of missingIds(body.jobIds, jobs)) skipped.push({ id, reason: "not_found" });
  await writeAudit(request, actor, {
    action: "ops.deadletter.requeue",
    targetType: "generation_job_batch",
    targetId: `${body.jobIds.length} jobs`,
    reason: body.reason,
    after: { requeued, skipped },
  });
  return ok({ requeued, skipped });
}

export async function discardDeadLetterBatch(request: Request) {
  const actor = await actorWithPermission(request, "ops.deadletter.write");
  const body = deadLetterBatchSchema.parse(await jsonBody(request));
  if (body.confirmation !== deadLetterBatchConfirmation(body.jobIds)) {
    throw Errors.badRequest("Batch discard confirmation did not match selected jobs");
  }
  const jobs = await prisma.generationJob.findMany({ where: { id: { in: body.jobIds } } });
  const discarded: string[] = [];
  const refundedNow: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const job of jobs) {
    if (!["failed", "blocked", "refunded"].includes(job.status)) {
      skipped.push({ id: job.id, reason: "not_discardable" });
      continue;
    }
    const didRefund = await refundDiscardableJob(job);
    discarded.push(job.id);
    if (didRefund) refundedNow.push(job.id);
  }
  for (const id of missingIds(body.jobIds, jobs)) skipped.push({ id, reason: "not_found" });
  await writeAudit(request, actor, {
    action: "ops.deadletter.discard",
    targetType: "generation_job_batch",
    targetId: `${body.jobIds.length} jobs`,
    reason: body.reason,
    after: { discarded, refunded: refundedNow, skipped },
  });
  return ok({ discarded, refunded: refundedNow, skipped });
}

async function refundDiscardableJob(job: { id: string; userId: string; costDreamcoins: number; errorCode: string | null }) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "generation_jobs" WHERE id = ${job.id} FOR UPDATE`;
    const settlement = await ensureGenerationSettlementLinks(tx, job.id);
    const amount = Math.min(job.costDreamcoins, settlement.refundable);
    const willRefund = amount > 0;
    if (willRefund) await appendLedger(tx, job.userId, amount, "refund", job.id, `generation:${job.id}:refund`);
    await tx.generationJob.update({
      where: { id: job.id },
      data: { errorCode: job.errorCode ?? "discarded", version: { increment: 1 } },
    });
    const existingDiscard = await tx.generationJobEvent.findFirst({
      where: { jobId: job.id, type: "discarded" },
      select: { id: true },
    });
    if (!existingDiscard) {
      await tx.generationJobEvent.create({
        data: {
          jobId: job.id,
          type: "discarded",
          message: "Operator discarded dead-letter request",
          metadata: toInputJson({ previousErrorCode: job.errorCode }),
        },
      });
    }
    return willRefund;
  });
}

async function refundedJobIds(jobIds: string[]) {
  if (jobIds.length === 0) return new Set<string>();
  const refunds = await prisma.dreamcoinLedger.findMany({
    where: { sourceId: { in: jobIds }, reason: "refund" },
    select: { sourceId: true },
  });
  return new Set(refunds.map((entry) => entry.sourceId).filter((id): id is string => Boolean(id)));
}

function missingIds(requested: string[], found: { id: string }[]) {
  const foundIds = new Set(found.map((job) => job.id));
  return requested.filter((id) => !foundIds.has(id));
}

function deadLetterBatchConfirmation(jobIds: string[]) {
  return jobIds.join(",");
}

async function stageGenerationRetry(
  tx: Prisma.TransactionClient,
  input: {
    readonly request: Request;
    readonly actor: AdminActor;
    readonly job: ExistingGenerationJob & { readonly status: string; readonly errorCode?: string | null; readonly version?: number };
    readonly reason: string;
  },
) {
  await tx.$queryRaw`SELECT id FROM "generation_jobs" WHERE id = ${input.job.id} FOR UPDATE`;
  const current = await tx.generationJob.findUniqueOrThrow({ where: { id: input.job.id } });
  if (current.status !== input.job.status) {
    throw Errors.conflict("Generation Request changed before retry staging", { expectedStatus: input.job.status, actualStatus: current.status });
  }
  const latest = await tx.generationAttempt.findFirst({ where: { requestId: current.id }, orderBy: { attemptNo: "desc" } });
  if (latest && latest.status !== "failed") {
    throw Errors.conflict("Latest Generation Attempt is not safe for operator retry", { attemptId: latest.id, attemptNo: latest.attemptNo, status: latest.status });
  }
  if (latest?.retryability === "not_retryable") {
    throw Errors.conflict("Latest Generation Attempt is explicitly non-replayable", { attemptId: latest.id, retryability: latest.retryability });
  }
  const updated = await transitionGenerationRequest(tx, {
    requestId: current.id,
    to: "queued",
    expected: { from: "failed", version: current.version },
    data: {
      errorCode: null,
      completedAt: null,
      finishedAt: null,
      deliveredOutputCount: 0,
    },
  });
  const attempt = await tx.generationAttempt.create({
    data: {
      requestId: current.id,
      attemptNo: (latest?.attemptNo ?? 0) + 1,
      provider: latest?.provider ?? current.provider,
      profileKey: latest?.profileKey ?? current.profileId,
      profileVersion: latest?.profileVersion ?? current.profileVersion,
      workflowKey: latest?.workflowKey ?? current.model,
      workflowVersion: latest?.workflowVersion,
      status: "queued",
    },
  });
  await recordGenerationAttemptQueuedEvent(tx, attempt);
  await tx.mainOutboxEvent.create({
    data: {
      id: `generation_retry_${current.id}_${attempt.attemptNo}`,
      eventType: "generation.retry.dispatch.v2",
      aggregateType: "generation_request",
      aggregateId: current.id,
      payload: toInputJson({ generationJobId: current.id, attemptId: attempt.id, attemptNo: attempt.attemptNo }),
    },
  });
  await tx.adminAuditLog.create({
    data: {
      actorId: input.actor.id,
      actorRole: input.actor.role,
      action: "ops.deadletter.requeue.item",
      targetType: "generation_job",
      targetId: current.id,
      reason: input.reason,
      before: toInputJson({ status: current.status, errorCode: current.errorCode, version: current.version, latestAttemptId: latest?.id ?? null, latestAttemptNo: latest?.attemptNo ?? null }),
      after: toInputJson({ status: updated.status, version: updated.version, attemptId: attempt.id, attemptNo: attempt.attemptNo, dispatchState: "pending" }),
      requestId: input.request.headers.get("x-request-id") ?? randomUUID(),
    },
  });
  return attempt;
}

function adminListCursorKeys(url: URL, scope: string, queryIdentity: unknown) {
  const raw = url.searchParams.get("cursor");
  return raw ? decodeAdminListCursor(raw, scope, queryIdentity) : undefined;
}

function adminCursorString(keys: readonly unknown[], index: number, scope: string) {
  const value = keys[index];
  if (typeof value !== "string" || !value) throw Errors.badRequest(`${scope} cursor key is invalid`);
  return value;
}

function adminCursorDate(keys: readonly unknown[], index: number, scope: string) {
  const value = new Date(adminCursorString(keys, index, scope));
  if (Number.isNaN(value.getTime())) throw Errors.badRequest(`${scope} cursor timestamp is invalid`);
  return value;
}

function adminListPageInfo<T>(scope: string, queryIdentity: unknown, page: readonly T[], hasNextPage: boolean, keys: (row: T) => readonly (string | number | boolean | null)[]) {
  const last = page.at(-1);
  return { endCursor: hasNextPage && last ? encodeAdminListCursor(scope, queryIdentity, keys(last)) : null, hasNextPage };
}
