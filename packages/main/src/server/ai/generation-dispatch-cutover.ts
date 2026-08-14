import type {
  GenerationAttempt,
  GenerationJob,
  MainOutboxEvent,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import {
  aiFinalizePayloadSchema,
  generationDispatchRequestId,
  generationTerminalFinalizeDedupeKey,
  generationTerminalRecordChecksum,
  generationTerminalRecordIngestSchema,
  GENERATION_CUTOVER_QUEUES,
  GEN_QUEUES,
  idempotencyKeys,
  MAIN_QUEUES,
} from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import { MAIN_OUTBOX_GENERATION_DISPATCH_EVENT_TYPES } from "@/server/events/main-outbox-transport";
import {
  bullMqJobIdForDedupeKey,
  jobQueue,
  type JobQueue,
  type QueueJobSnapshot,
} from "@/server/jobs/queue";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import {
  checkExactGenerationDispatchAuthority,
  generationDispatchForAttempt,
  generationTerminalRecordEvidence,
  readAttemptTerminalRecord,
  type ExactGenerationDispatchAuthority,
} from "./generation-dispatch-evidence-authority";
import { validateGenerationTerminalRelaySnapshot } from "./generation-terminal-relay-validation";
import { validateGenerationFinalizeRelaySnapshot } from "./generation-finalize-relay-validation";
import { dispatchPendingGenerationTerminalRecords } from "./generation-terminal-record-ingest";
import { isAcknowledgedLegacyFailedGenerationSourceResidue } from "./generation-failed-source-repair";

const ACTIVE_GENERATION_STATUSES = [
  "queued",
  "moderating_input",
  "running",
  "moderating_output",
] as const;

const NON_TERMINAL_BULL_STATES = new Set([
  "waiting",
  "prioritized",
  "delayed",
  "active",
  "paused",
  "waiting-children",
]);
const NON_TERMINAL_ATTEMPT_STATUSES = new Set(["queued", "running"]);
const TERMINAL_FINALIZE_KINDS: readonly string[] = [
  "generation.completed",
  "generation.failed",
  "generation.unknown",
  "generation.blocked",
];

// INVARIANT: in-flight 扫描与 failed 扫描必须覆盖同一组队列。这里曾是两份逐字相同的列表，
// 往其中一份加队列而漏掉另一份，会让新队列上的 failed row 不再被检查 —— 一个 fail-open 的口子，
// 且编译期与测试都不会响。现在只有一份。
export { GENERATION_CUTOVER_QUEUES } from "@idream/shared/contracts";

export type GenerationDispatchCutoverIssue = {
  readonly generationJobId: string | null;
  readonly attemptId: string | null;
  readonly outboxId?: string;
  readonly queue?: string;
  readonly bullJobId?: string;
  readonly reason?: string;
  readonly code:
    | "active_request_without_attempt"
    | "active_attempt_without_dispatch"
    | "legacy_or_invalid_dispatch_envelope"
    | "legacy_or_invalid_terminal_outbox"
    | "active_terminal_attempt_without_finalize"
    | "unknown_attempt_without_finalization_evidence"
    | "active_request_terminal_attempt_mismatch"
    | "failed_generation_source_pending_redrive"
    | "failed_terminal_relay_pending_redrive"
    | "failed_finalize_pending_redrive"
    | "legacy_or_invalid_terminal_relay"
    | "legacy_or_invalid_bull_job";
};

type GenerationDispatchCutoverOptions = {
  readonly generationJobIds?: readonly string[];
  readonly terminalRecordProbe?: (attemptId: string) => Promise<boolean>;
  readonly queueInspector?: Pick<
    JobQueue,
    "inspectInFlight" | "getByDedupeKey"
  > & Partial<Pick<JobQueue, "inspectFailed">>;
};

type GenerationQueueDrainOptions = {
  readonly terminalRecordProbe?: (attemptId: string) => Promise<boolean>;
  readonly queueInspector?: Pick<
    JobQueue,
    "inspectInFlight" | "inspectPaused"
  > & Partial<Pick<JobQueue, "inspectFailed">>;
  readonly dispatchPendingTerminalRecords?: () => Promise<number>;
};

type GenerationJobAuthority = Pick<GenerationJob, "id" | "mode" | "status">;

type ExactGenerationBullRow = {
  readonly job: GenerationJobAuthority;
  readonly attempt: GenerationAttempt;
  readonly dispatch: MainOutboxEvent;
  readonly authority: ExactGenerationDispatchAuthority;
};

// SPEC: deployments that make Attempt identity mandatory must prove every
// in-flight Request and every real Bull row already use the exact immutable
// Attempt envelope. Inspection is read-only: legacy rows are drained or
// reconciled explicitly; the gate never removes or re-dispatches queue work.
export async function assessGenerationDispatchCutoverReadiness(
  db: PrismaClient = prisma,
  options: GenerationDispatchCutoverOptions = {},
) {
  const queueInspector = options.queueInspector ?? jobQueue;
  const [
    activeJobs,
    inFlightBullRows,
    failedRecoveryRows,
    unscopedPendingTerminalOutboxes,
  ] =
    await Promise.all([
    db.generationJob.findMany({
      where: {
        status: { in: [...ACTIVE_GENERATION_STATUSES] },
        ...(options.generationJobIds
          ? { id: { in: [...options.generationJobIds] } }
          : {}),
      },
      select: { id: true, mode: true, status: true },
      orderBy: { createdAt: "asc" },
    }),
      queueInspector.inspectInFlight(GENERATION_CUTOVER_QUEUES),
      inspectAllFailedRecoveryRows(queueInspector),
      db.mainOutboxEvent.findMany({
        where: {
          eventType: "generation.terminal_record.accepted.v1",
          status: { in: ["pending", "dispatched"] },
        },
        orderBy: { createdAt: "asc" },
      }),
    ]);

  const scopedJobIds = options.generationJobIds
    ? new Set(options.generationJobIds)
    : null;
  const pendingTerminalOutboxes = scopedJobIds
    ? unscopedPendingTerminalOutboxes.filter((row) => {
        const payload = jsonRecord(row.payload);
        return scopedJobIds.has(stringValue(payload.generationJobId) ?? "");
      })
    : unscopedPendingTerminalOutboxes;

  const rowJobIds = inFlightBullRows
    .map((row) => generationBullRowIdentity(row)?.generationJobId ?? null)
    .filter((value): value is string => value !== null);
  const failedRowJobIds = failedRecoveryRows
    .map((row) => generationBullRowIdentity(row).generationJobId)
    .filter((value): value is string => value !== null);
  const activeJobIds = activeJobs.map((job) => job.id);
  const terminalOutboxJobIds = pendingTerminalOutboxes
    .map((row) => stringValue(jsonRecord(row.payload).generationJobId))
    .filter((value): value is string => value !== null);
  const authorityJobIds = [
    ...new Set([
      ...activeJobIds,
      ...rowJobIds,
      ...failedRowJobIds,
      ...terminalOutboxJobIds,
    ]),
  ];
  const knownJobs = authorityJobIds.length === 0
    ? []
    : await db.generationJob.findMany({
        where: { id: { in: authorityJobIds } },
        select: { id: true, mode: true, status: true },
      });
  const jobsById = new Map(
    [...activeJobs, ...knownJobs].map((job) => [job.id, job]),
  );
  const attempts = authorityJobIds.length === 0
    ? []
    : await db.generationAttempt.findMany({
        where: { requestId: { in: authorityJobIds } },
        orderBy: [{ requestId: "asc" }, { attemptNo: "desc" }],
      });
  const attemptIds = attempts.map((attempt) => attempt.id);
  const [dispatchOutboxes, relatedTerminalOutboxes] = await Promise.all([
    authorityJobIds.length === 0
      ? []
      : db.mainOutboxEvent.findMany({
          where: {
            aggregateId: { in: authorityJobIds },
            eventType: { in: [...MAIN_OUTBOX_GENERATION_DISPATCH_EVENT_TYPES] },
          },
          orderBy: { createdAt: "desc" },
        }),
    attemptIds.length === 0
      ? []
      : db.mainOutboxEvent.findMany({
          where: {
            aggregateId: { in: attemptIds },
            eventType: "generation.terminal_record.accepted.v1",
          },
          orderBy: { createdAt: "desc" },
        }),
  ]);
  const terminalOutboxes = [
    ...new Map(
      [...relatedTerminalOutboxes, ...pendingTerminalOutboxes].map((row) => [
        row.id,
        row,
      ]),
    ).values(),
  ];

  const latestAttemptByJob = new Map<string, GenerationAttempt>();
  const attemptsById = new Map<string, GenerationAttempt>();
  for (const attempt of attempts) {
    attemptsById.set(attempt.id, attempt);
    if (!latestAttemptByJob.has(attempt.requestId)) {
      latestAttemptByJob.set(attempt.requestId, attempt);
    }
  }

  const activeTerminalAttempts = activeJobs.flatMap((job) => {
    const attempt = latestAttemptByJob.get(job.id);
    return attempt?.terminalRecordRef ? [{ job, attempt }] : [];
  });
  const activeUnknownTerminalAttempts = activeTerminalAttempts.filter(
    ({ attempt }) => attempt.status === "unknown",
  );
  const [finalizeRowEntries, unknownAttemptEvents, unknownRequestEvents] =
    await Promise.all([
      Promise.all(
      activeTerminalAttempts.map(async ({ attempt }) => {
        const dedupeKey = generationTerminalFinalizeDedupeKey(attempt.id);
        return [
          attempt.id,
          await queueInspector.getByDedupeKey("app.ai.finalize", dedupeKey),
        ] as const;
      }),
      ),
      activeUnknownTerminalAttempts.length === 0
        ? []
        : db.generationAttemptEvent.findMany({
            where: {
              attemptId: {
                in: activeUnknownTerminalAttempts.map(({ attempt }) =>
                  attempt.id
                ),
              },
              eventType: "generation.attempt.unknown.v1",
            },
          }),
      activeUnknownTerminalAttempts.length === 0
        ? []
        : db.generationJobEvent.findMany({
            where: {
              jobId: {
                in: activeUnknownTerminalAttempts.map(({ job }) => job.id),
              },
              type: "provider_outcome_unknown",
            },
          }),
    ]);
  const finalizeRowsByAttempt = new Map(
    finalizeRowEntries,
  );

  const issues: GenerationDispatchCutoverIssue[] = [];
  const ignoredFailedSourceHistory = new Set<string>();
  const recoverableFailedRows = new Set<string>();
  for (const job of activeJobs) {
    const attempt = latestAttemptByJob.get(job.id) ?? null;
    if (!attempt) {
      issues.push({
        generationJobId: job.id,
        attemptId: null,
        code: "active_request_without_attempt",
      });
      continue;
    }
    const dispatch = generationDispatchForAttempt(dispatchOutboxes, attempt.id);
    if (!dispatch) {
      issues.push({
        generationJobId: job.id,
        attemptId: attempt.id,
        code: "active_attempt_without_dispatch",
      });
      continue;
    }
    if (!checkExactGenerationDispatchAuthority({ job, attempt, dispatch }).ok) {
      issues.push({
        generationJobId: job.id,
        attemptId: attempt.id,
        code: "legacy_or_invalid_dispatch_envelope",
      });
    }
  }

  const invalidTerminalOutboxIds = new Set<string>();
  for (const { job, attempt } of activeTerminalAttempts) {
    const terminalOutbox = terminalOutboxes.find(
      (row) => row.aggregateId === attempt.id,
    );
    if (
      !terminalOutbox ||
      !validTerminalOutbox({
        outbox: terminalOutbox,
        jobsById,
        attemptsById,
        latestAttemptByJob,
        dispatchOutboxes,
      })
    ) {
      if (terminalOutbox) invalidTerminalOutboxIds.add(terminalOutbox.id);
      issues.push({
        generationJobId: job.id,
        attemptId: attempt.id,
        ...(terminalOutbox ? { outboxId: terminalOutbox.id } : {}),
        code: "legacy_or_invalid_terminal_outbox",
      });
      continue;
    }

    const finalizeRow = finalizeRowsByAttempt.get(attempt.id) ?? null;
    if (attempt.status === "unknown") {
      if (
        !validUnknownFinalizationEvidence({
          job,
          attempt,
          terminalOutbox,
          attemptEvents: unknownAttemptEvents,
          requestEvents: unknownRequestEvents,
        })
      ) {
        issues.push({
          generationJobId: job.id,
          attemptId: attempt.id,
          outboxId: terminalOutbox.id,
          code: "unknown_attempt_without_finalization_evidence",
        });
        continue;
      }
      if (finalizeRow?.state === "failed") continue;
      if (
        finalizeRow &&
        ((!NON_TERMINAL_BULL_STATES.has(finalizeRow.state) &&
            finalizeRow.state !== "completed") ||
          !exactInFlightBullRow({
            row: finalizeRow,
            jobsById,
            attemptsById,
            latestAttemptByJob,
            dispatchOutboxes,
            terminalOutboxes,
          }))
      ) {
        issues.push({
          generationJobId: job.id,
          attemptId: attempt.id,
          queue: "app.ai.finalize",
          bullJobId: finalizeRow.id,
          code: "legacy_or_invalid_bull_job",
        });
      }
      continue;
    }

    if (!NON_TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) {
      issues.push({
        generationJobId: job.id,
        attemptId: attempt.id,
        code: "active_request_terminal_attempt_mismatch",
      });
      continue;
    }

    if (finalizeRow?.state === "failed") continue;

    if (
      !finalizeRow ||
      !NON_TERMINAL_BULL_STATES.has(finalizeRow.state) ||
      !exactInFlightBullRow({
        row: finalizeRow,
        jobsById,
        attemptsById,
        latestAttemptByJob,
        dispatchOutboxes,
        terminalOutboxes,
      })
    ) {
      issues.push({
        generationJobId: job.id,
        attemptId: attempt.id,
        queue: "app.ai.finalize",
        ...(finalizeRow ? { bullJobId: finalizeRow.id } : {}),
        code: "active_terminal_attempt_without_finalize",
      });
    }
  }

  for (const outbox of pendingTerminalOutboxes) {
    if (invalidTerminalOutboxIds.has(outbox.id)) continue;
    if (
      !validTerminalOutbox({
        outbox,
        jobsById,
        attemptsById,
        latestAttemptByJob,
        dispatchOutboxes,
      })
    ) {
      const payload = jsonRecord(outbox.payload);
      issues.push({
        generationJobId: stringValue(payload.generationJobId),
        attemptId: stringValue(payload.attemptId),
        outboxId: outbox.id,
        code: "legacy_or_invalid_terminal_outbox",
      });
    }
  }

  for (const row of inFlightBullRows) {
    if (
      !exactInFlightBullRow({
        row,
        jobsById,
        attemptsById,
        latestAttemptByJob,
        dispatchOutboxes,
        terminalOutboxes,
        requireLatest: false,
      })
    ) {
      const identity = generationBullRowIdentity(row);
      issues.push({
        generationJobId: identity?.generationJobId ?? null,
        attemptId: identity?.attemptId ?? null,
        queue: row.queue,
        bullJobId: row.id,
        code: "legacy_or_invalid_bull_job",
      });
    }
  }

  for (const row of failedRecoveryRows) {
    const identity = generationBullRowIdentity(row);
    const exact = exactInFlightBullRow({
      row,
      jobsById,
      attemptsById,
      latestAttemptByJob,
      dispatchOutboxes,
      terminalOutboxes,
      requireLatest: false,
    });
    if (row.queue === MAIN_QUEUES.generationTerminalIngest) {
      const validation = validateGenerationTerminalRelaySnapshot(row);
      if (validation.valid && exact) {
        recoverableFailedRows.add(`${row.queue}:${row.id}`);
        continue;
      }
      issues.push({
        generationJobId: identity.generationJobId,
        attemptId: identity.attemptId,
        queue: row.queue,
        bullJobId: row.id,
        ...(!validation.valid ? { reason: validation.reason } : {}),
        code:
          validation.valid && exact
            ? "failed_terminal_relay_pending_redrive"
            : "legacy_or_invalid_terminal_relay",
      });
      continue;
    }
    if (row.queue === MAIN_QUEUES.aiFinalize) {
      const validation = await validateGenerationFinalizeRelaySnapshot(row, db);
      if (validation.valid && exact) {
        recoverableFailedRows.add(`${row.queue}:${row.id}`);
        continue;
      }
      issues.push({
        generationJobId: identity.generationJobId,
        attemptId: identity.attemptId,
        queue: row.queue,
        bullJobId: row.id,
        ...(!validation.valid ? { reason: validation.reason } : {}),
        code: validation.valid && exact
          ? "failed_finalize_pending_redrive"
          : "legacy_or_invalid_bull_job",
      });
      continue;
    }
    if (row.queue === GEN_QUEUES.videoGenerate && !exact) {
      const acknowledgement =
        await isAcknowledgedLegacyFailedGenerationSourceResidue(db, row, {
          terminalRecordProbe: options.terminalRecordProbe,
        });
      if (acknowledgement.acknowledged) {
        ignoredFailedSourceHistory.add(`${row.queue}:${row.id}`);
        continue;
      }
    }
    if (exact && !NON_TERMINAL_ATTEMPT_STATUSES.has(exact.attempt.status)) {
      ignoredFailedSourceHistory.add(`${row.queue}:${row.id}`);
      continue;
    }
    if (exact && await hasExactAttemptTerminalRecord(exact)) {
      recoverableFailedRows.add(`${row.queue}:${row.id}`);
      continue;
    }
    issues.push({
      generationJobId: identity.generationJobId,
      attemptId: identity.attemptId,
      queue: row.queue,
      bullJobId: row.id,
      code: exact
        ? "failed_generation_source_pending_redrive"
        : "legacy_or_invalid_bull_job",
    });
  }

  return {
    ok: issues.length === 0,
    activeRequests: activeJobs.length,
    inFlightBullRows: inFlightBullRows.length,
    pendingTerminalOutboxes: pendingTerminalOutboxes.length,
    ...(failedRecoveryRows.length >
        ignoredFailedSourceHistory.size + recoverableFailedRows.size
      ? {
          failedRecoveryRows: failedRecoveryRows
            .filter((row) =>
              !ignoredFailedSourceHistory.has(`${row.queue}:${row.id}`) &&
              !recoverableFailedRows.has(`${row.queue}:${row.id}`)
            )
            .map((row) => ({
            queue: row.queue,
            bullJobId: row.id,
            state: row.state,
            failedReason: row.failedReason ?? null,
          })),
        }
      : {}),
    ...(ignoredFailedSourceHistory.size > 0
      ? {
          ignoredHistory: failedRecoveryRows
            .filter((row) => ignoredFailedSourceHistory.has(`${row.queue}:${row.id}`))
            .map((row) => ({ queue: row.queue, bullJobId: row.id })),
        }
      : {}),
    ...(recoverableFailedRows.size > 0
      ? {
          recoverableFailedRows: failedRecoveryRows
            .filter((row) => recoverableFailedRows.has(`${row.queue}:${row.id}`))
            .map((row) => ({ queue: row.queue, bullJobId: row.id })),
        }
      : {}),
    issues,
  } as const;
}

// SPEC: after global queue pause, the deploy may stop workers only when no
// provider/finalizer handler is active and every accepted terminal is durably
// carried by the paused ingest/finalize queues or its Main Outbox.
export async function assessGenerationQueueDrainReadiness(
  db: PrismaClient = prisma,
  options: GenerationQueueDrainOptions = {},
) {
  const queueInspector = options.queueInspector ?? jobQueue;
  const queues = await queueInspector.inspectPaused(GENERATION_CUTOVER_QUEUES);
  const rowsBeforeFence = await queueInspector.inspectInFlight(
    GENERATION_CUTOVER_QUEUES,
  );
  const activeBeforeFence = rowsBeforeFence.some((row) => row.state === "active");
  if (!activeBeforeFence) {
    const dispatchPending = options.dispatchPendingTerminalRecords ??
      (db === prisma
        ? () => dispatchPendingGenerationTerminalRecords()
        : async () => 0);
    await dispatchPending();
  }
  const rowsAfterFence = await queueInspector.inspectInFlight(
    GENERATION_CUTOVER_QUEUES,
  );
  const pendingTerminalOutboxes = await db.mainOutboxEvent.count({
    where: {
      eventType: "generation.terminal_record.accepted.v1",
      status: { in: ["pending", "dispatched"] },
    },
  });
  const failedRecoveryRows = await inspectAllFailedRecoveryRows(queueInspector);
  const rows = [
    ...new Map(
      [...rowsBeforeFence, ...rowsAfterFence].map((row) => [
        `${row.queue}:${row.id}`,
        row,
      ]),
    ).values(),
  ];
  const failedClassification = await classifyDrainFailedRows(
    db,
    failedRecoveryRows,
    options.terminalRecordProbe,
  );
  const activeBullRows = rows
    .filter((row) => row.state === "active")
    .map((row) => {
      const identity = generationBullRowIdentity(row);
      return {
        queue: row.queue,
        bullJobId: row.id,
        generationJobId: identity?.generationJobId ?? null,
        attemptId: identity?.attemptId ?? null,
      };
    });
  const allQueuesPaused = GENERATION_CUTOVER_QUEUES.every((queue) =>
    queues.some((snapshot) => snapshot.queue === queue && snapshot.paused)
  );

  return {
    ok:
      allQueuesPaused &&
      activeBullRows.length === 0 &&
      failedClassification.blocking.length === 0 &&
      pendingTerminalOutboxes === 0,
    queues,
    activeBullRows,
    pendingTerminalOutboxes,
    ...(failedClassification.blocking.length > 0
      ? {
          failedRecoveryRows: failedClassification.blocking.map((row) => {
            const identity = generationBullRowIdentity(row);
            return {
              queue: row.queue,
              bullJobId: row.id,
              generationJobId: identity.generationJobId,
              attemptId: identity.attemptId,
              failedReason: row.failedReason ?? null,
            };
          }),
        }
      : {}),
    ...(failedClassification.ignoredHistory.length > 0
      ? {
          ignoredHistory: failedClassification.ignoredHistory.map((row) => {
            const identity = generationBullRowIdentity(row);
            return {
              queue: row.queue,
              bullJobId: row.id,
              generationJobId: identity.generationJobId,
              attemptId: identity.attemptId,
            };
          }),
        }
      : {}),
    ...(failedClassification.recoverableCarriers.length > 0
      ? {
          recoverableFailedRows: failedClassification.recoverableCarriers.map(
            (row) => ({ queue: row.queue, bullJobId: row.id }),
          ),
        }
      : {}),
  } as const;
}

async function classifyDrainFailedRows(
  db: PrismaClient,
  rows: readonly QueueJobSnapshot[],
  terminalRecordProbe?: (attemptId: string) => Promise<boolean>,
) {
  const sourceRows = rows.filter(
    (row) => row.queue === GEN_QUEUES.imageGenerate || row.queue === GEN_QUEUES.videoGenerate,
  );
  const jobIds = rows
    .map((row) => generationBullRowIdentity(row).generationJobId)
    .filter((value): value is string => value !== null);
  if (jobIds.length === 0) {
    return { blocking: [...rows], ignoredHistory: [], recoverableCarriers: [] };
  }
  const [jobs, attempts, dispatchOutboxes] = await Promise.all([
    db.generationJob.findMany({
      where: { id: { in: jobIds } },
      select: { id: true, mode: true, status: true },
    }),
    db.generationAttempt.findMany({
      where: { requestId: { in: jobIds } },
      orderBy: [{ requestId: "asc" }, { attemptNo: "desc" }],
    }),
    db.mainOutboxEvent.findMany({
      where: {
        aggregateId: { in: jobIds },
        eventType: { in: [...MAIN_OUTBOX_GENERATION_DISPATCH_EVENT_TYPES] },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const attemptsById = new Map(attempts.map((attempt) => [attempt.id, attempt]));
  const latestAttemptByJob = new Map<string, GenerationAttempt>();
  for (const attempt of attempts) {
    if (!latestAttemptByJob.has(attempt.requestId)) {
      latestAttemptByJob.set(attempt.requestId, attempt);
    }
  }
  const ignoredHistory: QueueJobSnapshot[] = [];
  const recoverableCarriers: QueueJobSnapshot[] = [];
  const blocking: QueueJobSnapshot[] = [];
  for (const row of rows) {
    if (row.queue === MAIN_QUEUES.generationTerminalIngest) {
      const exact = exactInFlightBullRow({
        row,
        jobsById,
        attemptsById,
        latestAttemptByJob,
        dispatchOutboxes,
        terminalOutboxes: [],
        requireLatest: false,
      });
      if (exact && validateGenerationTerminalRelaySnapshot(row).valid) {
        recoverableCarriers.push(row);
      } else blocking.push(row);
      continue;
    }
    if (row.queue === MAIN_QUEUES.aiFinalize) {
      const validation = await validateGenerationFinalizeRelaySnapshot(row, db);
      if (validation.valid) recoverableCarriers.push(row);
      else blocking.push(row);
      continue;
    }
    if (!sourceRows.includes(row)) {
      blocking.push(row);
      continue;
    }
    const exact = exactInFlightBullRow({
      row,
      jobsById,
      attemptsById,
      latestAttemptByJob,
      dispatchOutboxes,
      terminalOutboxes: [],
      requireLatest: false,
    });
    if (row.queue === GEN_QUEUES.videoGenerate && !exact) {
      const acknowledgement =
        await isAcknowledgedLegacyFailedGenerationSourceResidue(db, row, {
          terminalRecordProbe,
        });
      if (acknowledgement.acknowledged) {
        ignoredHistory.push(row);
        continue;
      }
    }
    if (exact && !NON_TERMINAL_ATTEMPT_STATUSES.has(exact.attempt.status)) {
      ignoredHistory.push(row);
    } else if (exact && await hasExactAttemptTerminalRecord(exact)) {
      recoverableCarriers.push(row);
    } else blocking.push(row);
  }
  return { blocking, ignoredHistory, recoverableCarriers };
}

async function inspectAllFailedRecoveryRows(
  queueInspector: Pick<JobQueue, "inspectInFlight"> &
    Partial<Pick<JobQueue, "inspectFailed">>,
) {
  if (!queueInspector.inspectFailed) return [];
  const rows: QueueJobSnapshot[] = [];
  const seen = new Set<string>();
  for (let offset = 0; ; offset += 100) {
    const page = await queueInspector.inspectFailed(
      GENERATION_CUTOVER_QUEUES,
      { limit: 100, offset },
    );
    const unseen = page.filter((row) => !seen.has(`${row.queue}:${row.id}`));
    unseen.forEach((row) => seen.add(`${row.queue}:${row.id}`));
    rows.push(...unseen);
    if (page.length < 100 || unseen.length === 0) break;
  }
  return rows;
}

// SPEC: a Bull row is exact only when Redis and PostgreSQL agree on the same
// immutable Attempt envelope. The envelope judgement itself is delegated; what
// stays here is the cross-storage reconciliation that neither type nor schema
// can express — which Bull row carries which Outbox row.
function exactInFlightBullRow(input: {
  readonly row: QueueJobSnapshot;
  readonly jobsById: ReadonlyMap<string, GenerationJobAuthority>;
  readonly attemptsById: ReadonlyMap<string, GenerationAttempt>;
  readonly latestAttemptByJob: ReadonlyMap<string, GenerationAttempt>;
  readonly dispatchOutboxes: readonly MainOutboxEvent[];
  readonly terminalOutboxes: readonly MainOutboxEvent[];
  readonly requireLatest?: boolean;
}): ExactGenerationBullRow | null {
  const identity = generationBullRowIdentity(input.row);
  if (
    !identity.generationJobId ||
    !identity.attemptId ||
    identity.attemptNo === null
  ) return null;
  const { generationJobId, attemptId, attemptNo } = identity;
  const job = input.jobsById.get(generationJobId);
  const attempt = input.attemptsById.get(attemptId);
  if (
    !job ||
    !attempt ||
    attempt.requestId !== generationJobId ||
    attempt.attemptNo !== attemptNo ||
    ((input.requireLatest ?? true) &&
      input.latestAttemptByJob.get(generationJobId)?.id !== attempt.id)
  ) {
    return null;
  }
  const dispatch = generationDispatchForAttempt(
    input.dispatchOutboxes,
    attempt.id,
  );
  if (!dispatch) return null;
  const resolved = checkExactGenerationDispatchAuthority({
    job,
    attempt,
    dispatch,
  });
  if (!resolved.ok) return null;
  const exact: ExactGenerationBullRow = {
    job,
    attempt,
    dispatch,
    authority: resolved.authority,
  };

  if (input.row.queue === MAIN_QUEUES.generationTerminalIngest) {
    const parsed = generationTerminalRecordIngestSchema.safeParse(
      input.row.payload,
    );
    if (!parsed.success) return null;
    const relay = parsed.data;
    const carriesExactEvidence =
      generationTerminalRecordChecksum(relay.terminalRecord) ===
        relay.terminalRecordChecksum &&
      relay.terminalRecord.mode === resolved.authority.mode &&
      checkExactGenerationDispatchAuthority({
        job,
        attempt,
        dispatch,
        evidence: generationTerminalRecordEvidence(relay.terminalRecord),
      }).ok &&
      validBullDedupe(
        input.row,
        idempotencyKeys.generationTerminalRelay(attempt.id),
      );
    return carriesExactEvidence ? exact : null;
  }

  if (input.row.queue === MAIN_QUEUES.aiFinalize) {
    const payload = jsonRecord(input.row.payload);
    const parsed = aiFinalizePayloadSchema.safeParse(input.row.payload);
    if (
      !parsed.success ||
      !TERMINAL_FINALIZE_KINDS.includes(parsed.data.kind) ||
      payload.requestId !== generationDispatchRequestId(attempt.id) ||
      payload.mode !== resolved.authority.mode
    ) {
      return null;
    }
    const terminalOutbox = input.terminalOutboxes.find(
      (row) =>
        row.aggregateId === attempt.id &&
        canonicalSha256(row.payload) === canonicalSha256(input.row.payload),
    );
    const carriedByOutbox = Boolean(
      terminalOutbox &&
        validTerminalOutbox({
          outbox: terminalOutbox,
          jobsById: input.jobsById,
          attemptsById: input.attemptsById,
          latestAttemptByJob: input.latestAttemptByJob,
          dispatchOutboxes: input.dispatchOutboxes,
          requireLatest: input.requireLatest,
        }) &&
        validBullDedupe(
          input.row,
          generationTerminalFinalizeDedupeKey(attempt.id),
        ),
    );
    return carriedByOutbox ? exact : null;
  }

  const carriesExactEnvelope =
    input.row.queue === resolved.authority.queue &&
    canonicalSha256(resolved.authority.queueInput.payload) ===
      canonicalSha256(input.row.payload) &&
    validBullDedupe(input.row, resolved.authority.dedupeKey);
  return carriesExactEnvelope ? exact : null;
}

// SPEC: recovery may only defer to a Blob terminal record that the exact
// immutable envelope could have produced. An unreachable Blob store is treated
// as "no evidence" here — the gate reports rather than acts on it.
async function hasExactAttemptTerminalRecord(exact: ExactGenerationBullRow) {
  const read = await readAttemptTerminalRecord(exact.attempt.id);
  if (!read.ok) return false;
  return (
    read.record.mode === exact.authority.mode &&
    checkExactGenerationDispatchAuthority({
      job: exact.job,
      attempt: exact.attempt,
      dispatch: exact.dispatch,
      evidence: generationTerminalRecordEvidence(read.record),
    }).ok
  );
}

function generationBullRowIdentity(row: QueueJobSnapshot): {
  readonly generationJobId: string | null;
  readonly attemptId: string | null;
  readonly attemptNo: number | null;
} {
  if (row.queue === MAIN_QUEUES.generationTerminalIngest) {
    const relay = generationTerminalRecordIngestSchema.safeParse(row.payload);
    if (!relay.success) {
      return { generationJobId: null, attemptId: null, attemptNo: null };
    }
    return {
      generationJobId: relay.data.terminalRecord.generationJobId,
      attemptId: relay.data.terminalRecord.attemptId,
      attemptNo: relay.data.terminalRecord.attemptNo,
    };
  }
  const payload = jsonRecord(row.payload);
  const generationJobId = stringValue(payload.generationJobId);
  const attemptId = stringValue(payload.attemptId);
  const attemptNo = positiveInteger(payload.attemptNo);
  return { generationJobId, attemptId, attemptNo };
}

function validUnknownFinalizationEvidence(input: {
  readonly job: GenerationJobAuthority;
  readonly attempt: GenerationAttempt;
  readonly terminalOutbox: MainOutboxEvent;
  readonly attemptEvents: readonly {
    readonly attemptId: string;
    readonly eventType: string;
    readonly outcome: string | null;
    readonly terminalScope: string | null;
  }[];
  readonly requestEvents: readonly {
    readonly jobId: string;
    readonly type: string;
    readonly metadata: Prisma.JsonValue;
  }[];
}) {
  const parsed = aiFinalizePayloadSchema.safeParse(input.terminalOutbox.payload);
  if (
    !parsed.success ||
    parsed.data.kind !== "generation.unknown" ||
    input.terminalOutbox.status !== "delivered" ||
    input.terminalOutbox.deliveredAt === null
  ) {
    return false;
  }
  const terminalAttemptEvent = input.attemptEvents.some(
    (event) =>
      event.attemptId === input.attempt.id &&
      event.eventType === "generation.attempt.unknown.v1" &&
      event.outcome === "unknown" &&
      event.terminalScope === "terminal",
  );
  const requestEvent = input.requestEvents.some((event) => {
    const metadata = jsonRecord(event.metadata);
    return event.jobId === input.job.id &&
      event.type === "provider_outcome_unknown" &&
      metadata.attemptId === input.attempt.id &&
      metadata.terminalRecordRef === input.attempt.terminalRecordRef;
  });
  return terminalAttemptEvent && requestEvent;
}

// SPEC: a terminal Outbox row is exact only when the Attempt it names still
// points at the same terminal record and its dispatch envelope is exact.
function validTerminalOutbox(input: {
  readonly outbox: MainOutboxEvent;
  readonly jobsById: ReadonlyMap<string, GenerationJobAuthority>;
  readonly attemptsById: ReadonlyMap<string, GenerationAttempt>;
  readonly latestAttemptByJob: ReadonlyMap<string, GenerationAttempt>;
  readonly dispatchOutboxes: readonly MainOutboxEvent[];
  readonly requireLatest?: boolean;
}) {
  const parsed = aiFinalizePayloadSchema.safeParse(input.outbox.payload);
  if (!parsed.success || !TERMINAL_FINALIZE_KINDS.includes(parsed.data.kind)) {
    return false;
  }
  const payload = jsonRecord(parsed.data);
  const generationJobId = stringValue(payload.generationJobId);
  const attemptId = stringValue(payload.attemptId);
  const attemptNo = positiveInteger(payload.attemptNo);
  if (!generationJobId || !attemptId || attemptNo === null) return false;
  const job = input.jobsById.get(generationJobId);
  const attempt = input.attemptsById.get(attemptId);
  if (
    input.outbox.aggregateType !== "generation_attempt" ||
    input.outbox.aggregateId !== attemptId ||
    !job ||
    !attempt ||
    attempt.requestId !== generationJobId ||
    attempt.attemptNo !== attemptNo ||
    ((input.requireLatest ?? true) &&
      input.latestAttemptByJob.get(generationJobId)?.id !== attempt.id) ||
    payload.requestId !== generationDispatchRequestId(attempt.id) ||
    payload.mode !== job.mode ||
    payload.terminalRecordRef !== attempt.terminalRecordRef
  ) {
    return false;
  }
  const dispatch = generationDispatchForAttempt(
    input.dispatchOutboxes,
    attempt.id,
  );
  return Boolean(
    dispatch &&
      checkExactGenerationDispatchAuthority({ job, attempt, dispatch }).ok,
  );
}

function validBullDedupe(row: QueueJobSnapshot, expected: string) {
  return row.dedupeKey === expected &&
    row.id === bullMqJobIdForDedupeKey(expected);
}

function positiveInteger(value: unknown) {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
    ? value
    : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function jsonRecord(value: Prisma.JsonValue | unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
