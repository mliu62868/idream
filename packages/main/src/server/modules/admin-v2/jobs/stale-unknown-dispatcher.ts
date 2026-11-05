import { Prisma, type PrismaClient } from "@prisma/client";
import { UNKNOWN_SETTLEMENT_GRACE_MS } from "@/lib/generation-failure-copy";
import { validatedUnknownSuccessResolution } from "@/server/ai/generation-unknown-resolution-evidence";
import { logger } from "@/server/lib/logger";
import { reconcileUnknownGenerationRequest } from "./unknown-reconciliation";

// SPEC: 无人认领且原执行/终态接力不再可恢复的 unknown，宽限期后结算失败并退款。
// INTENT: unknown 是「provider 结果不明」的不可改写事实，Request 会停在
//   queued/running。过去只有运营在后台点一下才能收口，于是用户看到的是一个永远
//   「排队中」的任务：不报错、不能重试、不退币，连角色都因为「还有生成在跑」而删不掉。
//   宽限期留给 provider 迟到的成功证据（late_after_* 通道仍然接得住），过了就必须
//   且确认原执行没有继续推进后，才给用户一个确定的结局——失败并把币还回去，比无限期挂着诚实。
// INVARIANT: 宽限期与用户文案（Generate 卡片、帮助中心）同源，见 generation-failure-copy。
// SPEC: 宽限期内迟到的成功证据已通过校验时，sweeper 走运营同一条 adopt 路径交付，不退款。
// INTENT: confirm_failed 不允许覆盖已恢复的成功，于是这类 Request 每轮都被拒绝：
//   既不交付也不退款，一直占着并发名额并阻塞视频序列，而文案承诺它会自动结算。

const SWEEPER_ACTOR = {
  id: "system:generation-unknown-sweeper",
  role: "system",
} as const;

// INVARIANT: 同一个 Request 只会被自动结算一次——idempotencyKey 由 requestId +
// attemptId 决定，重复扫描命中的是 control plane 的重放分支，不会二次退款。
function sweepIdempotencyKey(requestId: string, attemptId: string) {
  return `generation-unknown-sweep:${requestId}:${attemptId}`;
}

// Separate from the failure key: an adoption that fails moderation or its projection
// check leaves no command behind, and a later scan must be able to try again.
function sweepAdoptionIdempotencyKey(requestId: string, attemptId: string) {
  return `generation-unknown-sweep-adopt:${requestId}:${attemptId}`;
}

export type StaleUnknownSweepCursor = {
  readonly finishedAt: Date;
  readonly id: string;
};

export async function dispatchStaleUnknownGenerationRequests(
  db: PrismaClient,
  input: {
    readonly now?: Date;
    readonly limit?: number;
    readonly graceMs?: number;
    readonly cursor?: StaleUnknownSweepCursor | null;
  } = {},
) {
  const now = input.now ?? new Date();
  const limit = Math.min(200, Math.max(1, input.limit ?? 50));
  const graceMs = Math.max(0, input.graceMs ?? UNKNOWN_SETTLEMENT_GRACE_MS);
  const settleBefore = new Date(now.getTime() - graceMs);
  // INTENT: a row the sweep cannot settle yet stays eligible and stays oldest. Without
  // a cursor a full page of those hides every newer row from every later scan.
  const afterCursor = input.cursor
    ? Prisma.sql`AND (a."finishedAt", a.id) > (${input.cursor.finishedAt}, ${input.cursor.id})`
    : Prisma.empty;

  // Filter before LIMIT: immutable unknown attempts from settled requests must
  // not permanently fill the oldest page. Only the latest attempt can be reconciled.
  const candidates = await db.$queryRaw<Array<{
    id: string; requestId: string; errorCode: string | null;
    terminalRecordRef: string | null; version: number; finishedAt: Date;
  }>>`
    SELECT a.id, a."requestId", a."errorCode", a."terminalRecordRef", j.version, a."finishedAt"
    FROM generation_attempts a
    JOIN generation_jobs j ON j.id = a."requestId"
    WHERE a.status = 'unknown' AND a."finishedAt" <= ${settleBefore}
      AND j.status IN ('queued', 'moderating_input', 'running', 'moderating_output')
      AND NOT EXISTS (
        SELECT 1 FROM generation_attempts newer
        WHERE newer."requestId" = a."requestId" AND newer."attemptNo" > a."attemptNo"
      )
      ${afterCursor}
    ORDER BY a."finishedAt" ASC, a.id ASC
    LIMIT ${limit}
  `;

  let settled = 0;
  let adopted = 0;
  let refunded = 0;
  let skipped = 0;
  const failures: Array<{ requestId: string; message: string }> = [];

  for (const attempt of candidates) {
    try {
      const recoveredSuccess = await validatedUnknownSuccessResolution(db, attempt.id);
      const idempotencyKey = recoveredSuccess
        ? sweepAdoptionIdempotencyKey(attempt.requestId, attempt.id)
        : sweepIdempotencyKey(attempt.requestId, attempt.id);
      const result = await reconcileUnknownGenerationRequest({
        requestId: attempt.requestId,
        command: {
          entityVersion: attempt.version,
          resolution: recoveredSuccess ? "adopt_succeeded" : "confirm_failed",
          reason: recoveredSuccess
            ? "A validated provider success arrived after the outcome was recorded unknown; adopted automatically and delivered."
            : `Provider outcome stayed unknown for more than ${Math.round(graceMs / 60_000)} minutes; ` +
              "settled automatically as failed and refunded so the reader is not left waiting.",
          providerEvidenceRefs: [
            recoveredSuccess?.payload.terminalRecordRef ?? attempt.terminalRecordRef ?? `attempt:${attempt.id}`,
          ],
          confirmation: attempt.errorCode ?? "provider_outcome_unknown",
        },
        actor: SWEEPER_ACTOR,
        idempotencyKey,
        traceId: idempotencyKey,
        now,
      });
      settled += 1;
      if (recoveredSuccess) adopted += 1;
      // Adoption can also refund the outputs a partial result did not deliver.
      refunded += result.refundAmount;
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
  // A short page means the scan reached the end; the next one starts over, and a row
  // skipped above comes round again.
  const last = candidates.at(-1);
  const nextCursor = last && candidates.length === limit ? { finishedAt: last.finishedAt, id: last.id } : null;
  return { examined: candidates.length, settled, adopted, refunded, skipped, nextCursor };
}
