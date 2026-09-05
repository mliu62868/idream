import type { PrismaClient } from "@prisma/client";
import { logger } from "@/server/lib/logger";
import { reconcileUnknownGenerationRequest } from "./unknown-reconciliation";

// SPEC: 无人认领且原执行/终态接力不再可恢复的 unknown，宽限期后结算失败并退款。
// INTENT: unknown 是「provider 结果不明」的不可改写事实，Request 会停在
//   queued/running。过去只有运营在后台点一下才能收口，于是用户看到的是一个永远
//   「排队中」的任务：不报错、不能重试、不退币，连角色都因为「还有生成在跑」而删不掉。
//   宽限期留给 provider 迟到的成功证据（late_after_* 通道仍然接得住），过了就必须
//   且确认原执行没有继续推进后，才给用户一个确定的结局——失败并把币还回去，比无限期挂着诚实。
const UNKNOWN_SETTLEMENT_GRACE_MS = 30 * 60_000;

const SWEEPER_ACTOR = {
  id: "system:generation-unknown-sweeper",
  role: "system",
} as const;

// INVARIANT: 同一个 Request 只会被自动结算一次——idempotencyKey 由 requestId +
// attemptId 决定，重复扫描命中的是 control plane 的重放分支，不会二次退款。
function sweepIdempotencyKey(requestId: string, attemptId: string) {
  return `generation-unknown-sweep:${requestId}:${attemptId}`;
}

export async function dispatchStaleUnknownGenerationRequests(
  db: PrismaClient,
  input: {
    readonly now?: Date;
    readonly limit?: number;
    readonly graceMs?: number;
  } = {},
) {
  const now = input.now ?? new Date();
  const limit = Math.min(200, Math.max(1, input.limit ?? 50));
  const graceMs = Math.max(0, input.graceMs ?? UNKNOWN_SETTLEMENT_GRACE_MS);
  const settleBefore = new Date(now.getTime() - graceMs);

  // GenerationAttempt carries requestId but no Prisma relation to the Request,
  // so the still-open filter is a second read rather than a join.
  const stale = await db.generationAttempt.findMany({
    where: { status: "unknown", finishedAt: { lte: settleBefore } },
    orderBy: [{ finishedAt: "asc" }, { id: "asc" }],
    take: limit,
    select: {
      id: true,
      requestId: true,
      errorCode: true,
      terminalRecordRef: true,
    },
  });
  const openRequests = new Map(
    (
      await db.generationJob.findMany({
        where: {
          id: { in: stale.map((attempt) => attempt.requestId) },
          status: { in: ["queued", "moderating_input", "running", "moderating_output"] },
        },
        select: { id: true, version: true },
      })
    ).map((request) => [request.id, request.version]),
  );
  const candidates = stale.flatMap((attempt) => {
    const version = openRequests.get(attempt.requestId);
    return version === undefined ? [] : [{ ...attempt, version }];
  });

  let settled = 0;
  let refunded = 0;
  let skipped = 0;
  const failures: Array<{ requestId: string; message: string }> = [];

  for (const attempt of candidates) {
    try {
      const result = await reconcileUnknownGenerationRequest({
        requestId: attempt.requestId,
        command: {
          entityVersion: attempt.version,
          resolution: "confirm_failed",
          reason:
            `Provider outcome stayed unknown for more than ${Math.round(graceMs / 60_000)} minutes; ` +
            "settled automatically as failed and refunded so the reader is not left waiting.",
          providerEvidenceRefs: [
            attempt.terminalRecordRef ?? `attempt:${attempt.id}`,
          ],
          confirmation: attempt.errorCode ?? "provider_outcome_unknown",
        },
        actor: SWEEPER_ACTOR,
        idempotencyKey: sweepIdempotencyKey(attempt.requestId, attempt.id),
        traceId: sweepIdempotencyKey(attempt.requestId, attempt.id),
        now,
      });
      settled += 1;
      if (result.resolution === "confirm_failed") refunded += result.refundAmount;
    } catch (error) {
      // A Request that moved on between the scan and the write (late provider
      // evidence, an operator getting there first) fails the version or status
      // guard. That is the guard working, not a sweep failure.
      const message = error instanceof Error ? error.message : String(error);
      skipped += 1;
      failures.push({ requestId: attempt.requestId, message });
    }
  }

  if (failures.length > 0) {
    logger.warn(
      { failures },
      "stale unknown Generation Requests could not be settled automatically",
    );
  }
  return { examined: candidates.length, settled, refunded, skipped };
}
