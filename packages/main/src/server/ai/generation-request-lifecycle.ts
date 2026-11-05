import { randomUUID } from "node:crypto";
import { Prisma, type GenerationAttempt, type GenerationJob } from "@prisma/client";
import { GENERATION_REQUEST_CANCELLABLE_STATUSES } from "@idream/shared/catalog";
import { MAIN_OUTBOX_GENERATION_DISPATCH_EVENT_TYPES } from "@/server/events/main-outbox-transport";
import { jsonRecord } from "@/server/modules/ourdream/json-values";
import { markProductionItemFailed } from "@/server/modules/content-production-state";
import { transitionToolEffectAttachment } from "@/server/modules/chat/tool-effect-attachment";
import { lockChatScope } from "@/server/modules/chat/turn-scope";
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
import { lockGenerationRequestForSettlement } from "./generation-settlement";
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
// - before_provider_entry: 用户只能在任何 provider 执行都不可能已开始时取消。
export type GenerationCancellationGuard =
  | { readonly kind: "operator"; readonly expectedVersion: number }
  | { readonly kind: "before_provider_entry" };

/**
 * 取消一次 Generation Request 的唯一结算路径：锁 User → Request → 判前置 → 状态迁移 →
 * Attempt 终态事件 → 撤销 dispatch outbox → 退款 → 聊天附件终态。
 *
 * INVARIANT: users 和 generation_jobs 的行锁在本函数内部依次取。ADR-13 §2.1.4 记录过「调用方
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
  const job = await lockGenerationRequestForSettlement(tx, input.requestId);
  if (
    (input.userId && job.userId !== input.userId) ||
    (input.expectSourceType && job.sourceType !== input.expectSourceType)
  ) throw Errors.notFound("Generation Request not found");
  const attempt = await tx.generationAttempt.findFirst({
    where: { requestId: job.id },
    orderBy: { attemptNo: "desc" },
  });
  const guard = input.guard;
  // Concurrent user cancellations may both pass the caller's fast replay read.
  // Decide replay under the settlement locks before checking dispatch eligibility;
  // operator commands retain their stricter version-based conflict semantics.
  if (guard.kind === "before_provider_entry" && job.status === "cancelled") {
    return { job, attempt, cancelled: job, refundAmount: 0 };
  }
  if (guard.kind === "operator" && job.version !== guard.expectedVersion) {
    throw Errors.conflict("Generation Request changed before cancellation");
  }
  if (guard.kind === "before_provider_entry") await assertNoGenerationProviderEntry(tx, job, attempt);

  const cancelled = await transitionGenerationRequest(tx, {
    requestId: job.id,
    to: "cancelled",
    expected: guard.kind === "operator"
      ? { from: GENERATION_REQUEST_CANCELLABLE_STATUSES, version: guard.expectedVersion }
      : { from: "queued", version: job.version },
    data: { completedAt: null, finishedAt: input.cancelledAt, deliveredOutputCount: 0 },
  });
  if (!cancelled) throw Errors.conflict("Generation Request changed before cancellation");
  // A Creative Run item has no other writer once its request is cancelled; leaving it
  // queued keeps the Run active forever and Admin keeps surfacing it as current work.
  await markProductionItemFailed(tx, job.id);
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
  await reconcileCancelledChatAttachments(tx, cancelled);
  return { job, attempt, cancelled, refundAmount };
}

async function reconcileCancelledChatAttachments(tx: Prisma.TransactionClient, job: GenerationJob) {
  if (job.status !== "cancelled" || !["chat_image", "chat_video"].includes(job.sourceType)) return;
  const pointers = await tx.chatTurnAttachment.findMany({
    where: {
      generationJobId: job.id,
      kind: job.sourceType === "chat_image" ? "generated_image" : "generated_video",
      status: "accepted",
    },
    select: { id: true },
  });
  for (const pointer of pointers) {
    // Settlement already owns user → Request locks. Preserve the Chat lock
    // order and finish hidden/old-attempt attachments as well as visible ones.
    const scope = await lockChatScope(tx, {
      userId: job.userId,
      at: { attachment: pointer.id },
      allowDeletedSession: true,
    });
    if (scope.attachment?.generationJobId === job.id && scope.attachment.status === "accepted") {
      await transitionToolEffectAttachment(tx, scope.attachment, { to: "cancelled", errorCode: null });
    }
  }
}

// SPEC: Gen 进入 provider 之前必须先让 Main 在 Request 锁下接受 `running` 传输事件，而
// 这个事件和 Attempt.startedAt 在同一事务落库。所以 `startedAt IS NULL` 就是「不可能有
// 任何 provider 执行已开始」的证明，排在 Bull 里或等设备租约都属于这个状态。
// INTENT: 这里曾要求 dispatch 还是 pending 且 attempts=0，理由是派发超时后供应商可能已接
// 单。但派发只把任务写进 Bull，从不碰 provider，内联派发在下单请求返回前就把 attempts 加一，
// 于是视频一被接受就再也无法取消，币可能被占满整段排队时间。
// INVARIANT: exact dispatch 必须存在。缺失的 Attempt 属于待修复的异常，不靠用户取消掩盖。
export function canCancelGenerationBeforeProviderEntry(
  job: Pick<GenerationJob, "status">,
  attempt: Pick<GenerationAttempt, "id" | "status" | "startedAt"> | null,
  dispatches: readonly { payload: Prisma.JsonValue }[],
) {
  return job.status === "queued" && attempt?.status === "queued" && attempt.startedAt === null &&
    dispatches.some((item) => jsonRecord(item.payload).attemptId === attempt.id);
}

// INVARIANT: 调用方已持有 Request 锁，Main 接受 `running` 事件时取同一把锁，所以这里的判断
// 与 worker 进入 provider 的判断不可能同时成立。输掉竞争的一方只会看到确定的拒绝。
async function assertNoGenerationProviderEntry(
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
        select: { payload: true },
      })
    : [];
  const transports = attempt
    ? await tx.generationTransportExecution.count({ where: { attemptId: attempt.id } })
    : 0;
  if (transports > 0 || !canCancelGenerationBeforeProviderEntry(job, attempt, dispatches)) {
    throw Errors.conflict(
      `This ${job.mode} has already started rendering and can no longer be cancelled. Its result will appear here when it's ready.`,
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
    // Older operator cancellations settled the Request but left its attachment
    // accepted. An exact replay repairs that residue without repeating money writes.
    await prisma.$transaction(async (tx) => {
      const job = await lockGenerationRequestForSettlement(tx, input.requestId);
      await reconcileCancelledChatAttachments(tx, job);
    });
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

export async function removeLatestGenerationAttemptQueueJob(requestId: string) {
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
    // A row a worker already holds cannot be removed; Main rejects that worker
    // at its next waiting or running event instead.
  }
}
