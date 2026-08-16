// SPEC: the dead-letter authority — the failed/blocked Generation Requests an operator triages,
//       and the two dispositions available to them: requeue a retryable failure, or discard it
//       and settle whatever the customer was charged.
// INTENT: migrated from the v1 `generation/dead-letter` and `generation/jobs/:id/{requeue,discard}`
//         dispatcher branches. Requeue reserves a retry attempt through the Generation attempt
//         authority rather than rewriting a status, which is why nothing here writes
//         `generationJob.status`.
// INVARIANT: discard settles before it marks. A discarded request that was never refunded would
//            leave the customer paying for output they never received.
import type { Prisma } from "@prisma/client";
import { refundGenerationRequest } from "@/server/ai/generation-refund";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import {
  OPERATIONAL_USER_DATA_SCOPE,
  operationalGenerationJobWhere,
} from "@/server/modules/metric-data-scope";
import type { ExistingGenerationJob } from "@/server/modules/generation/attempt-dispatch";
import { reserveRetryGenerationAttempt } from "@/server/modules/generation/generation-attempt-authority";
import {
  actorWithPermission,
  jsonBody,
  queryParams,
  type AdminActor,
} from "@/server/modules/admin-v2/shared/authority";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import {
  type AdminKeysetPaging,
  paginateAdminKeyset,
} from "@/server/modules/admin-v2/shared/list-cursor";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { deriveGenerationJobState } from "./job-state";
import { adminRequestId } from "./model-profiles";

const DEFAULT_DEAD_LETTER_STATUSES = ["failed", "blocked"];

export async function listGenerationDeadLetter(request: Request) {
  await actorWithPermission(request, "ops.queue.read");
  const query = queryParams(request, "GET /api/v2/admin/generation/dead-letter");
  const statuses = query.status && query.status !== "all"
    ? query.status.split(",").map((status) => status.trim()).filter(Boolean)
    : DEFAULT_DEAD_LETTER_STATUSES;
  const mode = query.mode && query.mode !== "all" ? query.mode : undefined;
  const limit = query.limit ?? 100;
  const queryIdentity = { search: query.search, statuses, errorCode: query.errorCode, mode };
  const where: Prisma.GenerationJobWhereInput = operationalGenerationJobWhere({
    status: { in: statuses },
    errorCode: query.errorCode ? { contains: query.errorCode } : undefined,
    mode,
    events: { none: { type: "discarded" } },
    AND: query.search
      ? [{
          OR: [
            { id: { contains: query.search } },
            { userId: { contains: query.search } },
            { errorCode: { contains: query.search } },
            { provider: { contains: query.search } },
          ],
        }]
      : [],
  });
  const { items: page, pageInfo } = await paginateAdminKeyset({
    scope: "generation_dead_letter",
    queryIdentity,
    cursor: query.cursor,
    before: query.before,
    limit,
    keys: [
      { field: "updatedAt", direction: "desc", type: "datetime", value: (job) => job.updatedAt },
      { field: "id", direction: "desc", value: (job) => job.id },
    ],
    fetch: (paging: AdminKeysetPaging<Prisma.GenerationJobOrderByWithRelationInput>) =>
      prisma.generationJob.findMany({
        where: { AND: [where, ...paging.cursorWhere] },
        include: { assets: true, events: { orderBy: { createdAt: "asc" } } },
        orderBy: paging.orderBy,
        take: paging.take,
      }),
    count: () => prisma.generationJob.count({ where }),
  });
  const refundedIds = await refundedJobIds(prisma, page.map((job) => job.id));
  return {
    items: page.map((job) => ({
      id: job.id,
      userId: job.userId,
      mode: job.mode,
      status: job.status,
      provider: job.provider,
      errorCode: job.errorCode,
      costDreamcoins: job.costDreamcoins,
      ledgerState: refundedIds.has(job.id) ? ("refunded" as const) : ("reserved" as const),
      retryEligibility: retryEligibilityOf(job, refundedIds.has(job.id)),
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    })),
    pageInfo,
    dataScope: OPERATIONAL_USER_DATA_SCOPE,
    asOf: new Date().toISOString(),
    freshness: "fresh" as const,
  };
}

export async function requeueGenerationDeadLetterBatch(request: Request) {
  const actor = await actorWithPermission(request, "generation.job.requeue");
  const body = await jsonBody(request, "generationDeadLetterBatchRequestSchema+idempotency-key");
  if (body.confirmation !== body.jobIds.join(",")) {
    throw Errors.badRequest("Batch requeue confirmation did not match selected jobs");
  }
  const requestId = adminRequestId(request);
  return executeAtomicIdempotentMutation({
    environment: env.APP_ENV,
    actor,
    idempotencyKey: requireIdempotencyKey(request),
    requestId,
    commandType: "ops.deadletter.requeue",
    target: { type: "generation_job_batch", id: `${body.jobIds.length} jobs` },
    payload: body,
    mutate: async (tx) => {
      const jobs = await tx.generationJob.findMany({
        where: operationalGenerationJobWhere({ id: { in: [...body.jobIds] } }),
        include: { assets: true, events: { orderBy: { createdAt: "asc" } } },
      });
      const refundedIds = await refundedJobIds(tx, [...body.jobIds]);
      const requeued: string[] = [];
      const skipped: { id: string; reason: string }[] = [];
      for (const job of jobs) {
        const eligibility = retryEligibilityOf(job, refundedIds.has(job.id));
        if (!eligibility.eligible) {
          skipped.push({ id: job.id, reason: eligibility.reason });
          continue;
        }
        await stageGenerationRetry(tx, { actor, requestId, job, reason: body.reason });
        requeued.push(job.id);
      }
      for (const id of missingIds([...body.jobIds], jobs)) skipped.push({ id, reason: "not_found" });
      await writeDeadLetterAudit(tx, actor, requestId, {
        action: "ops.deadletter.requeue",
        targetType: "generation_job_batch",
        targetId: `${body.jobIds.length} jobs`,
        reason: body.reason,
        after: { requeued, skipped },
      });
      return { requeued, skipped };
    },
  });
}

export async function discardGenerationDeadLetterBatch(request: Request) {
  const actor = await actorWithPermission(request, "ops.deadletter.write");
  const body = await jsonBody(request, "generationDeadLetterBatchRequestSchema+idempotency-key");
  if (body.confirmation !== body.jobIds.join(",")) {
    throw Errors.badRequest("Batch discard confirmation did not match selected jobs");
  }
  const requestId = adminRequestId(request);
  return executeAtomicIdempotentMutation({
    environment: env.APP_ENV,
    actor,
    idempotencyKey: requireIdempotencyKey(request),
    requestId,
    commandType: "ops.deadletter.discard",
    target: { type: "generation_job_batch", id: `${body.jobIds.length} jobs` },
    payload: body,
    mutate: async (tx) => {
      const jobs = await tx.generationJob.findMany({
        where: operationalGenerationJobWhere({ id: { in: [...body.jobIds] } }),
      });
      const discarded: string[] = [];
      const refundedNow: string[] = [];
      const skipped: { id: string; reason: string }[] = [];
      for (const job of jobs) {
        if (!isDiscardable(job.status)) {
          skipped.push({ id: job.id, reason: "not_discardable" });
          continue;
        }
        const didRefund = await refundDiscardableJob(tx, job);
        discarded.push(job.id);
        if (didRefund) refundedNow.push(job.id);
      }
      for (const id of missingIds([...body.jobIds], jobs)) skipped.push({ id, reason: "not_found" });
      await writeDeadLetterAudit(tx, actor, requestId, {
        action: "ops.deadletter.discard",
        targetType: "generation_job_batch",
        targetId: `${body.jobIds.length} jobs`,
        reason: body.reason,
        after: { discarded, refunded: refundedNow, skipped },
      });
      return { discarded, refunded: refundedNow, skipped };
    },
  });
}

export async function requeueGenerationDeadLetterJob(request: Request, jobId: string) {
  const actor = await actorWithPermission(request, "generation.job.requeue");
  const body = await jsonBody(request, "generationDeadLetterRequeueRequestSchema+idempotency-key");
  if (body.confirmation !== jobId) {
    throw Errors.badRequest("Confirmation did not match requeue target");
  }
  const requestId = adminRequestId(request);
  return executeAtomicIdempotentMutation({
    environment: env.APP_ENV,
    actor,
    idempotencyKey: requireIdempotencyKey(request),
    requestId,
    commandType: "ops.deadletter.requeue.item",
    target: { type: "generation_job", id: jobId },
    payload: body,
    mutate: async (tx) => {
      const job = await tx.generationJob.findFirst({
        where: operationalGenerationJobWhere({ id: jobId }),
        include: { assets: true, events: { orderBy: { createdAt: "asc" } } },
      });
      if (!job) throw Errors.notFound("Generation job not found");
      const refunds = await refundedJobIds(tx, [job.id]);
      const eligibility = retryEligibilityOf(job, refunds.has(job.id));
      if (!eligibility.eligible) {
        throw Errors.conflict("Generation job is not eligible for retry", {
          reason: eligibility.reason,
        });
      }
      const attempt = await stageGenerationRetry(tx, {
        actor,
        requestId,
        job,
        reason: body.reason ?? "Operator requeue requested",
      });
      return { queued: true as const, attemptId: attempt.id, attemptNo: attempt.attemptNo };
    },
  });
}

export async function discardGenerationDeadLetterJob(request: Request, jobId: string) {
  const actor = await actorWithPermission(request, "ops.deadletter.write");
  const body = await jsonBody(request, "generationConfigCommandRequestSchema+idempotency-key");
  if (body.confirmation !== jobId) {
    throw Errors.badRequest("Confirmation did not match discard target");
  }
  const requestId = adminRequestId(request);
  return executeAtomicIdempotentMutation({
    environment: env.APP_ENV,
    actor,
    idempotencyKey: requireIdempotencyKey(request),
    requestId,
    commandType: "ops.deadletter.discard.item",
    target: { type: "generation_job", id: jobId },
    payload: body,
    mutate: async (tx) => {
      const job = await tx.generationJob.findFirst({
        where: operationalGenerationJobWhere({ id: jobId }),
      });
      if (!job) throw Errors.notFound("Generation job not found");
      if (!isDiscardable(job.status)) {
        throw Errors.badRequest("Only failed, blocked, or refunded jobs can be discarded");
      }
      const refunded = await refundDiscardableJob(tx, job);
      await writeDeadLetterAudit(tx, actor, requestId, {
        action: "ops.deadletter.discard",
        targetType: "generation_job",
        targetId: job.id,
        reason: body.reason,
        before: { status: job.status, errorCode: job.errorCode },
        after: {
          status: job.status,
          settlement: refunded ? "refunded" : "already_settled",
          refunded,
        },
      });
      return { discarded: true as const, refunded };
    },
  });
}

function isDiscardable(status: string) {
  return ["failed", "blocked", "refunded"].includes(status);
}

function retryEligibilityOf(
  job: {
    status: string;
    completedAt: Date | null;
    finishedAt: Date | null;
    errorCode: string | null;
    costDreamcoins: number;
    assets: { id: string; safetyStatus: string; deletedAt: Date | null }[];
    events: { createdAt: Date; type: string }[];
  },
  refunded: boolean,
) {
  return deriveGenerationJobState({
    status: job.status,
    completedAt: job.completedAt,
    finishedAt: job.finishedAt,
    errorCode: job.errorCode,
    assets: job.assets,
    events: job.events,
    ledgerEntries: refunded ? [{ reason: "refund", delta: job.costDreamcoins }] : [],
  }).retryEligibility;
}

async function refundDiscardableJob(
  tx: Prisma.TransactionClient,
  job: { id: string; userId: string; costDreamcoins: number; errorCode: string | null },
) {
  await tx.$queryRaw`SELECT id FROM "generation_jobs" WHERE id = ${job.id} FOR UPDATE`;
  const amount = await refundGenerationRequest(tx, {
    requestId: job.id,
    userId: job.userId,
    cause: { kind: "operator_manual" },
    requested: job.costDreamcoins,
  });
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
  return amount > 0;
}

async function refundedJobIds(
  db: Pick<Prisma.TransactionClient, "dreamcoinLedger">,
  jobIds: readonly string[],
) {
  if (jobIds.length === 0) return new Set<string>();
  const refunds = await db.dreamcoinLedger.findMany({
    where: { sourceId: { in: [...jobIds] }, reason: "refund" },
    select: { sourceId: true },
  });
  return new Set(refunds.map((entry) => entry.sourceId).filter((id): id is string => Boolean(id)));
}

function missingIds(requested: readonly string[], found: readonly { id: string }[]) {
  const foundIds = new Set(found.map((job) => job.id));
  return requested.filter((id) => !foundIds.has(id));
}

async function stageGenerationRetry(
  tx: Prisma.TransactionClient,
  input: {
    readonly actor: AdminActor;
    readonly requestId: string;
    readonly job: ExistingGenerationJob & {
      readonly status: string;
      readonly errorCode?: string | null;
      readonly version: number;
    };
    readonly reason: string;
  },
) {
  const {
    attempt,
    request: updated,
    previousRequest: current,
    previousAttempt: latest,
  } = await reserveRetryGenerationAttempt(tx, {
    requestId: input.job.id,
    expectedRequestVersion: input.job.version,
    eligibleLatestStatuses: ["failed"],
    dispatch: { eventType: "generation.retry.dispatch.v2" },
  });
  await writeDeadLetterAudit(tx, input.actor, input.requestId, {
    action: "ops.deadletter.requeue.item",
    targetType: "generation_job",
    targetId: current.id,
    reason: input.reason,
    before: {
      status: current.status,
      errorCode: current.errorCode,
      version: current.version,
      latestAttemptId: latest?.id ?? null,
      latestAttemptNo: latest?.attemptNo ?? null,
    },
    after: {
      status: updated.status,
      version: updated.version,
      attemptId: attempt.id,
      attemptNo: attempt.attemptNo,
      dispatchState: "pending",
    },
  });
  return attempt;
}

async function writeDeadLetterAudit(
  tx: Prisma.TransactionClient,
  actor: AdminActor,
  requestId: string,
  input: {
    readonly action: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly reason?: string;
    readonly before?: unknown;
    readonly after?: unknown;
  },
) {
  await tx.adminAuditLog.create({
    data: {
      actorId: actor.id,
      actorRole: actor.role,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      reason: input.reason,
      before: input.before === undefined ? undefined : toInputJson(input.before),
      after: input.after === undefined ? undefined : toInputJson(input.after),
      requestId,
    },
  });
}
