import { randomUUID } from "node:crypto";
import { Prisma, type GenerationAttempt, type GenerationJob } from "@prisma/client";
import { GENERATION_REQUEST_CANCELLABLE_STATUSES } from "@idream/shared/catalog";
import { MAIN_OUTBOX_GENERATION_DISPATCH_EVENT_TYPES } from "@/server/events/main-outbox-transport";
import { jsonRecord } from "@/server/modules/ourdream/json-values";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import {
  recordGenerationAttemptEvent,
} from "./generation-attempt-events";
import {
  cancelGenerationAttemptDispatchOutboxes,
  reserveRetryGenerationAttempt,
} from "@/server/modules/generation/generation-attempt-authority";
import { refundGenerationRequest } from "./generation-refund";
import { transitionGenerationRequest } from "./generation-request-transition";
import { removeGenerationAttemptQueueJob } from "./generation-attempt-queue";

// SPEC: 一次 Attempt 再也不会改变的状态集合，只有这一处定义。
// 以前 ai/generation-request-lifecycle.ts 内联了一份、modules/chat/video-cancel.ts
// 用 `status !== "queued" || startedAt !== null` 另起一套，两套无人对账。
export const GENERATION_ATTEMPT_TERMINAL_STATUSES = [
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
  "unknown",
] as const;

// SPEC: 谁有资格取消，是一个判别变体；取消本身的五步顺序只写一遍。
// - operator: 运营在精确版本上取消，允许的来源状态是 CANCELLABLE 集合。
// - before_dispatch: 用户只能在 dispatch 尚未被触碰时取消，因为 dispatch 超时之后
//   供应商可能已经收到提交，只有「派发事实未被动过」才证明取消停住了付费执行。
export type GenerationCancellationGuard =
  | { readonly kind: "operator"; readonly expectedVersion: number }
  | { readonly kind: "before_dispatch" };

/**
 * 取消一次 Generation Request 的唯一结算路径：锁 Request → 判前置 → 状态迁移 →
 * Attempt 终态事件 → 撤销 dispatch outbox → 退款。
 *
 * INVARIANT: generation_jobs 的行锁在本函数内部取。ADR-13 §2.1.4 记录过「调用方
 * 必须先上锁」这类约定的代价（6 个退款调用点漏了 1 个，40 币退回 80），所以锁跟着
 * 权威走，而不是跟着注释走。退款仍然只经 refundGenerationRequest 这一个入口。
 */
export async function settleGenerationRequestCancellation(
  tx: Prisma.TransactionClient,
  input: {
    readonly requestId: string;
    readonly userId?: string;
    readonly expectSourceType?: string;
    readonly guard: GenerationCancellationGuard;
    readonly reason: string;
    readonly cancelledAt: Date;
  },
): Promise<{
  readonly job: GenerationJob;
  readonly attempt: GenerationAttempt | null;
  readonly cancelled: GenerationJob;
  readonly refundAmount: number;
}> {
  await tx.$queryRaw`SELECT id FROM "generation_jobs" WHERE id = ${input.requestId} FOR UPDATE`;
  const job = await tx.generationJob.findFirst({
    where: {
      id: input.requestId,
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.expectSourceType ? { sourceType: input.expectSourceType } : {}),
    },
  });
  if (!job) throw Errors.notFound("Generation Request not found");
  const attempt = await tx.generationAttempt.findFirst({
    where: { requestId: job.id },
    orderBy: { attemptNo: "desc" },
  });
  const guard = input.guard;
  if (guard.kind === "operator" && job.version !== guard.expectedVersion) {
    throw Errors.conflict("Generation Request changed before cancellation");
  }
  if (guard.kind === "before_dispatch") await assertGenerationDispatchUntouched(tx, job, attempt);

  const cancelled = await transitionGenerationRequest(tx, {
    requestId: job.id,
    to: "cancelled",
    expected: guard.kind === "operator"
      ? { from: GENERATION_REQUEST_CANCELLABLE_STATUSES, version: guard.expectedVersion }
      : { from: "queued", version: job.version },
    data: { completedAt: null, finishedAt: input.cancelledAt, deliveredOutputCount: 0 },
  });
  if (!cancelled) throw Errors.conflict("Generation Request changed before cancellation");
  if (attempt && !(GENERATION_ATTEMPT_TERMINAL_STATUSES as readonly string[]).includes(attempt.status)) {
    await recordGenerationAttemptEvent(tx, {
      eventId: `${attempt.id}:terminal`,
      attemptId: attempt.id,
      eventType: "generation.attempt.cancelled.v1",
      outcome: "cancelled",
      occurredAt: input.cancelledAt,
      payload: { requestId: job.id, reason: input.reason },
      retryability: "not_retryable",
    });
  }
  if (attempt) {
    await cancelGenerationAttemptDispatchOutboxes(tx, {
      requestId: job.id,
      attemptId: attempt.id,
      cancelledAt: input.cancelledAt,
      reason: input.reason,
    });
  }
  const refundAmount = await refundGenerationRequest(tx, {
    requestId: job.id,
    userId: job.userId,
    cause: { kind: "cancel" },
  });
  return { job, attempt, cancelled, refundAmount };
}

// 派发超时之后供应商可能已经接单，所以「未被触碰的 dispatch」是唯一能证明
// 取消真的停住了付费执行的事实。
async function assertGenerationDispatchUntouched(
  tx: Prisma.TransactionClient,
  job: GenerationJob,
  attempt: GenerationAttempt | null,
) {
  const dispatches = attempt
    ? await tx.mainOutboxEvent.findMany({
        where: {
          aggregateType: "generation_request",
          aggregateId: job.id,
          eventType: { in: [...MAIN_OUTBOX_GENERATION_DISPATCH_EVENT_TYPES] },
        },
        select: { status: true, attempts: true, payload: true },
      })
    : [];
  const exact = dispatches.filter((item) => jsonRecord(item.payload).attemptId === attempt?.id);
  if (
    job.status !== "queued" || !attempt || attempt.status !== "queued" || attempt.startedAt !== null ||
    exact.length === 0 || exact.some((item) => item.status !== "pending" || item.attempts !== 0)
  ) {
    throw Errors.conflict(
      "This video has already entered processing and can no longer be cancelled. Its result will stay in this chat.",
      { reason: "processing_started" },
    );
  }
}

export async function cancelGenerationRequest(input: {
  readonly requestId: string;
  readonly expectedVersion: number;
  readonly actor: { readonly id: string; readonly role: string };
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly traceId: string;
}) {
  const scope = `${env.APP_ENV}:${input.actor.id}`;
  const requestHash = canonicalSha256({ commandType: "generation.request.cancel", requestId: input.requestId, expectedVersion: input.expectedVersion, reason: input.reason });
  const existing = await prisma.controlPlaneCommand.findUnique({ where: { scope_idempotencyKey: { scope, idempotencyKey: input.idempotencyKey } } });
  if (existing) {
    if (existing.requestHash !== requestHash) throw Errors.conflict("Idempotency key is bound to another Generation Request cancellation");
    await removeLatestGenerationAttemptQueueJob(input.requestId);
    return existing.result;
  }
  const result = await prisma.$transaction(async (tx) => {
    const cancelledAt = new Date();
    const { job, cancelled, refundAmount } = await settleGenerationRequestCancellation(tx, {
      requestId: input.requestId,
      guard: { kind: "operator", expectedVersion: input.expectedVersion },
      reason: input.reason,
      cancelledAt,
    });
    const response = { requestId: job.id, status: cancelled.status, version: cancelled.version, finishedAt: cancelledAt.toISOString(), refundAmount };
    const command = await tx.controlPlaneCommand.create({ data: { scope, idempotencyKey: input.idempotencyKey, commandType: "generation.request.cancel", targetType: "generation_request", targetId: job.id, actorId: input.actor.id, requestId: input.traceId, requestHash, requestPayload: toInputJson({ expectedVersion: input.expectedVersion, reason: input.reason }), expectedVersion: input.expectedVersion, retryMode: "idempotent", status: "succeeded", result: toInputJson(response), finishedAt: cancelledAt } });
    await tx.adminAuditLog.create({ data: { actorId: input.actor.id, actorRole: input.actor.role, action: "generation.request.cancelled", targetType: "generation_request", targetId: job.id, reason: input.reason, before: toInputJson({ status: job.status, version: job.version }), after: toInputJson({ ...response, commandId: command.id }), requestId: input.traceId } });
    await tx.mainOutboxEvent.create({ data: { eventType: "generation.request.cancelled.v2", aggregateType: "generation_request", aggregateId: job.id, payload: toInputJson({ ...response, commandId: command.id }) } });
    return response;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  await removeLatestGenerationAttemptQueueJob(input.requestId);
  return result;
}

export async function retryGenerationRequest(input: {
  readonly requestId: string;
  readonly expectedVersion: number;
  readonly actor: { readonly id: string; readonly role: string };
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly traceId: string;
}) {
  const scope = `${env.APP_ENV}:${input.actor.id}`;
  const requestHash = canonicalSha256({
    commandType: "generation.request.retry",
    requestId: input.requestId,
    expectedVersion: input.expectedVersion,
    reason: input.reason,
  });
  const existing = await prisma.controlPlaneCommand.findUnique({
    where: { scope_idempotencyKey: { scope, idempotencyKey: input.idempotencyKey } },
  });
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw Errors.conflict("Idempotency key is bound to another Generation Request retry");
    }
    return existing.result;
  }

  return prisma.$transaction(async (tx) => {
    const commandId = randomUUID();
    const reservation = await reserveRetryGenerationAttempt(tx, {
      requestId: input.requestId,
      expectedRequestVersion: input.expectedVersion,
      sourceCommandId: commandId,
      dispatch: {
        outboxId: `generation_retry_${commandId}`,
        eventType: "generation.retry.dispatch.v2",
        payload: { commandId },
      },
    });
    const { attempt, request: updated } = reservation;
    const job = reservation.previousRequest;
    const latest = reservation.previousAttempt;
    const result = {
      commandId,
      requestId: job.id,
      attemptId: attempt.id,
      attemptNo: attempt.attemptNo,
      status: "queued" as const,
      version: updated.version,
    };
    await tx.controlPlaneCommand.create({
      data: {
        id: commandId,
        scope,
        idempotencyKey: input.idempotencyKey,
        commandType: "generation.request.retry",
        targetType: "generation_request",
        targetId: job.id,
        actorId: input.actor.id,
        requestId: input.traceId,
        requestHash,
        requestPayload: toInputJson({ expectedVersion: input.expectedVersion, reason: input.reason }),
        expectedVersion: input.expectedVersion,
        retryMode: "idempotent",
        status: "succeeded",
        result: toInputJson(result),
        finishedAt: new Date(),
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "generation.request.retry",
        targetType: "generation_request",
        targetId: job.id,
        reason: input.reason,
        before: toInputJson({
          status: job.status,
          version: job.version,
          latestAttemptId: latest?.id ?? null,
          latestAttemptNo: latest?.attemptNo ?? null,
        }),
        after: toInputJson(result),
        requestId: input.traceId,
      },
    });
    return result;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

async function removeLatestGenerationAttemptQueueJob(requestId: string) {
  try {
    const attempt = await prisma.generationAttempt.findFirst({
      where: { requestId },
      orderBy: [{ attemptNo: "desc" }, { createdAt: "desc" }],
      select: { id: true },
    });
    if (!attempt) return;
    await removeGenerationAttemptQueueJob({
      requestId,
      attemptId: attempt.id,
    });
  } catch {
    // The durable cancelled authority suppresses any late worker result. Queue
    // removal is an optimization and is retried by idempotent command replay.
  }
}
