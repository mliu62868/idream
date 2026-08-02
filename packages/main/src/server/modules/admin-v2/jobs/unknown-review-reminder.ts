import { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";

type DueUnknownReviewRow = {
  readonly id: string;
  readonly jobId: string;
  readonly commandId: string;
  readonly attemptId: string;
  readonly nextReviewAt: Date;
};

// SPEC: scheduled unknown reviews become durable operator work when due.
// INVARIANT: one reconciliation decision emits at most one reminder event;
// repeated finalizer scans are therefore harmless.
export async function scanDueUnknownGenerationReviews(input: {
  readonly now?: Date;
  readonly limit?: number;
  readonly generationJobIds?: readonly string[];
} = {}) {
  const now = input.now ?? new Date();
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
  if (input.generationJobIds?.length === 0) {
    return { scanned: 0, reminded: 0, now };
  }
  const jobFilter = input.generationJobIds
    ? Prisma.sql`AND decision."jobId" IN (${Prisma.join([...input.generationJobIds])})`
    : Prisma.empty;
  const rows = await prisma.$queryRaw<DueUnknownReviewRow[]>(Prisma.sql`
    SELECT
      decision.id,
      decision."jobId",
      decision.metadata->>'commandId' AS "commandId",
      decision.metadata->>'attemptId' AS "attemptId",
      (decision.metadata->>'nextReviewAt')::timestamptz AS "nextReviewAt"
    FROM generation_job_events decision
    JOIN generation_jobs request ON request.id = decision."jobId"
    WHERE decision.type = 'unknown_reconciliation_remain_unknown'
      AND decision.metadata->>'commandId' IS NOT NULL
      AND decision.metadata->>'attemptId' IS NOT NULL
      AND decision.metadata->>'nextReviewAt' IS NOT NULL
      AND (decision.metadata->>'nextReviewAt')::timestamptz <= ${now}
      ${jobFilter}
      AND request.status IN ('queued', 'moderating_input', 'running', 'moderating_output', 'failed')
      AND (
        SELECT attempt.status
        FROM generation_attempts attempt
        WHERE attempt."requestId" = request.id
        ORDER BY attempt."attemptNo" DESC, attempt."createdAt" DESC
        LIMIT 1
      ) = 'unknown'
      AND NOT EXISTS (
        SELECT 1
        FROM generation_job_events later
        WHERE later."jobId" = decision."jobId"
          AND later.type IN (
            'unknown_reconciliation_adopt_succeeded',
            'unknown_reconciliation_confirm_failed',
            'unknown_reconciliation_remain_unknown'
          )
          AND (
            later."createdAt" > decision."createdAt" OR
            (later."createdAt" = decision."createdAt" AND later.id > decision.id)
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM generation_job_events reminder
        WHERE reminder.type = 'unknown_reconciliation_review_due'
          AND reminder.metadata->>'reconciliationEventId' = decision.id
      )
    ORDER BY "nextReviewAt" ASC, decision.id ASC
    LIMIT ${limit}
  `);
  if (rows.length === 0) return { scanned: 0, reminded: 0, now };
  const created = await prisma.generationJobEvent.createMany({
    data: rows.map((row) => ({
      id: `generation_unknown_review_due_${row.commandId}`,
      jobId: row.jobId,
      type: "unknown_reconciliation_review_due",
      message: "Scheduled unknown provider outcome review is due",
      metadata: toInputJson({
        reconciliationEventId: row.id,
        commandId: row.commandId,
        attemptId: row.attemptId,
        nextReviewAt: row.nextReviewAt.toISOString(),
        dueAt: now.toISOString(),
      }),
    })),
    skipDuplicates: true,
  });
  return { scanned: rows.length, reminded: created.count, now };
}
