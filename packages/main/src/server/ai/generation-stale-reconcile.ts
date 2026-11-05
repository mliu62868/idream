// SPEC: decides what happens to a Request that stopped producing evidence: leave it,
// redispatch it, or quarantine it as unknown. It never decides a provider outcome from
// time alone while a worker still holds the source row.
import { Prisma } from "@prisma/client";
import {
  idempotencyKeys,
  MAIN_QUEUES,
  type GenerationTerminalRecord,
} from "@idream/shared/contracts";
import { bullMqJobIdForDedupeKey, jobQueue } from "@/server/jobs/queue";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { recordGenerationAttemptEvent } from "./generation-attempt-events";
import {
  dispatchGenerationAttemptOutbox,
} from "@/server/modules/generation/generation-attempt-authority";
import {
  MAIN_OUTBOX_GENERATION_DISPATCH_EVENT_TYPES,
} from "@/server/events/main-outbox-transport";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import {
  validateGenerationTerminalRelaySnapshot,
} from "./generation-terminal-relay-validation";
import {
  checkExactGenerationDispatchAuthority,
  generationDispatchForAttempt,
  generationTerminalRecordEvidence,
  readAttemptTerminalRecord,
  type ExactGenerationDispatchAuthority,
  type GenerationDispatchJobAuthority,
  type GenerationDispatchOutboxRow,
  type PinnedGenerationAttempt,
} from "./generation-dispatch-evidence-authority";
import { toInputJson } from "./generation-finalize-events";

export async function reconcileStaleGenerationJobs(input: {
  now?: Date;
  timeoutMs?: number;
  videoTimeoutMs?: number;
  limit?: number;
  generationJobIds?: readonly string[];
  // INTENT: a queued row or a deferred executing one stays eligible while legitimately
  // old. Without a cursor a full page of those hides the real stale rows behind them.
  cursor?: { readonly updatedAt: Date; readonly id: string } | null;
} = {}) {
  const now = input.now ?? new Date();
  const timeoutMs =
    input.timeoutMs ??
    env.JOB_STALE_TIMEOUT_MS;
  const videoTimeoutMs =
    input.videoTimeoutMs ??
    env.VIDEO_JOB_STALE_TIMEOUT_MS;
  const cutoff = new Date(now.getTime() - timeoutMs);
  const videoCutoff = new Date(now.getTime() - videoTimeoutMs);
  const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
  if (input.generationJobIds?.length === 0) {
    return { scanned: 0, enqueued: 0, quarantined: 0, cutoff, videoCutoff, nextCursor: null };
  }
  const idFilter = input.generationJobIds
    ? Prisma.sql`AND request.id IN (${Prisma.join([...input.generationJobIds])})`
    : Prisma.empty;
  const afterCursor = input.cursor
    ? Prisma.sql`AND (request."updatedAt", request.id) > (${input.cursor.updatedAt}, ${input.cursor.id})`
    : Prisma.empty;
  const candidates = await prisma.$queryRaw<Array<{ id: string; updatedAt: Date }>>(Prisma.sql`
    SELECT request.id, request."updatedAt"
    FROM generation_jobs request
    WHERE request.status IN ('queued', 'moderating_input', 'running', 'moderating_output')
      AND (
        (request.mode = 'video' AND request."updatedAt" < ${videoCutoff}) OR
        (request.mode <> 'video' AND request."updatedAt" < ${cutoff})
      )
      ${idFilter}
      ${afterCursor}
      AND EXISTS (
        SELECT 1
        FROM generation_attempts active_attempt
        WHERE active_attempt.id = (
          SELECT latest_attempt.id
          FROM generation_attempts latest_attempt
          WHERE latest_attempt."requestId" = request.id
          ORDER BY latest_attempt."attemptNo" DESC, latest_attempt."createdAt" DESC
          LIMIT 1
        )
          AND active_attempt.status IN ('queued', 'running')
          AND active_attempt."terminalRecordRef" IS NULL
      )
    ORDER BY request."updatedAt" ASC, request.id ASC
    LIMIT ${limit}
  `);
  const rows = candidates.length > 0
    ? await prisma.generationJob.findMany({
        where: { id: { in: candidates.map((candidate) => candidate.id) } },
      })
    : [];
  const jobsById = new Map(rows.map((job) => [job.id, job]));
  const jobs = candidates.flatMap((candidate) => {
    const job = jobsById.get(candidate.id);
    return job ? [job] : [];
  });

  let enqueued = 0;
  let quarantined = 0;
  for (const job of jobs) {
    const recoveryProbe = await probeRecoverableTerminalEvidence(job.id);
    const decision = await inspectAndQuarantineStaleGeneration({
      generationJobId: job.id,
      cutoff,
      videoCutoff,
      timeoutMs,
      videoTimeoutMs,
      recoveryProbe,
    });
    if (decision.kind === "redispatch") {
      enqueued += await recoverStaleGenerationDispatch(decision, now);
    } else if (decision.kind === "quarantined") {
      if (decision.created) quarantined += 1;
      if (decision.queue) {
        await jobQueue.removeByDedupeKey(
          decision.queue.queue,
          decision.queue.dedupeKey,
        );
      }
    }
  }

  const last = candidates.at(-1);
  // A short page means the scan reached the end; the next one starts over.
  const nextCursor = last && candidates.length === limit ? { updatedAt: last.updatedAt, id: last.id } : null;
  return { scanned: jobs.length, enqueued, quarantined, cutoff, videoCutoff, nextCursor };
}

type GenerationQueueFact = {
  readonly queue: "ai.image.generate" | "ai.video.generate";
  readonly dedupeKey: string;
};

type StaleGenerationDecision =
  | { readonly kind: "none" }
  | {
      readonly kind: "redispatch";
      readonly generationJobId: string;
      readonly attemptId: string;
      readonly outboxId: string;
      readonly outboxStatus: string;
      readonly outboxUpdatedAt: Date;
      readonly staleCutoff: Date;
      readonly queue: GenerationQueueFact;
    }
  | {
      readonly kind: "quarantined";
      readonly created: boolean;
      readonly queue: GenerationQueueFact | null;
    };

// INVARIANT: the Job, latest Attempt, and latest Transport are re-read while
// holding the same lock order used by terminal ingest. A stale snapshot outside
// this transaction can only nominate work; it cannot decide an outcome.
async function inspectAndQuarantineStaleGeneration(input: {
  readonly generationJobId: string;
  readonly cutoff: Date;
  readonly videoCutoff: Date;
  readonly timeoutMs: number;
  readonly videoTimeoutMs: number;
  readonly recoveryProbe: RecoverableTerminalProbe;
}): Promise<StaleGenerationDecision> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`
      SELECT id FROM generation_jobs
      WHERE id = ${input.generationJobId}
      FOR UPDATE
    `);
    const job = await tx.generationJob.findUnique({
      where: { id: input.generationJobId },
    });
    if (
      !job ||
      !["queued", "moderating_input", "running", "moderating_output"].includes(job.status)
    ) {
      return { kind: "none" };
    }
    const staleCutoff = job.mode === "video" ? input.videoCutoff : input.cutoff;
    if (job.updatedAt >= staleCutoff) return { kind: "none" };

    const attemptCandidate = await tx.generationAttempt.findFirst({
      where: { requestId: job.id },
      orderBy: { attemptNo: "desc" },
    });
    if (!attemptCandidate) return { kind: "none" };
    await tx.$queryRaw(Prisma.sql`
      SELECT id FROM generation_attempts
      WHERE id = ${attemptCandidate.id}
      FOR UPDATE
    `);
    const attempt = await tx.generationAttempt.findUniqueOrThrow({
      where: { id: attemptCandidate.id },
    });
    if (attempt.terminalRecordRef || isTerminalAttempt(attempt.status)) {
      return { kind: "none" };
    }

    const transportCandidate = await tx.generationTransportExecution.findFirst({
      where: { attemptId: attempt.id },
      orderBy: { transportAttemptNo: "desc" },
    });
    if (transportCandidate) {
      await tx.$queryRaw(Prisma.sql`
        SELECT id FROM generation_transport_executions
        WHERE id = ${transportCandidate.id}
        FOR UPDATE
      `);
    }
    const transport = transportCandidate
      ? await tx.generationTransportExecution.findUnique({
          where: { id: transportCandidate.id },
        })
      : null;
    const latestAttemptEvent = await tx.generationAttemptEvent.findFirst({
      where: { attemptId: attempt.id },
      orderBy: { sequence: "desc" },
      select: { occurredAt: true },
    });
    const dispatchRows = await tx.mainOutboxEvent.findMany({
      where: {
        aggregateId: job.id,
        eventType: { in: [...MAIN_OUTBOX_GENERATION_DISPATCH_EVENT_TYPES] },
      },
      orderBy: { createdAt: "desc" },
    });
    const dispatch = dispatchRows.find(
      (row) => jsonRecord(row.payload).attemptId === attempt.id,
    );
    const queue = dispatch ? generationQueueFact(dispatch.payload) : null;
    const evidenceAt = latestDate(
      attempt.createdAt,
      attempt.startedAt,
      latestAttemptEvent?.occurredAt,
      transport?.startedAt,
      transport?.finishedAt,
      dispatch?.updatedAt,
    );
    if (evidenceAt >= staleCutoff || transport?.terminalRecordRef) {
      return { kind: "none" };
    }
    // A queued source row is only recovery authority before provider entry, or
    // after an explicitly failed retryable transport. Once a running transport
    // lease expires, replaying that source could invoke an ambiguous provider
    // outcome twice; only an exact Blob terminal or relay may defer quarantine.
    const sourceDispatchCanStillRun =
      !transport || transport.status === "failed";
    if (
      input.recoveryProbe.attemptId === attempt.id &&
      (
        input.recoveryProbe.defer ||
        (
          input.recoveryProbe.sourceDispatchRecoverable &&
          sourceDispatchCanStillRun
        )
      )
    ) {
      return { kind: "none" };
    }
    // SPEC: Main hears nothing between `running` and the terminal record, so a long
    // render looks exactly like a dead one. An active source row tells them apart:
    // Bull returns a dead worker's row to waiting within one stall interval, so this
    // is the original invocation still running, not a candidate for replay.
    // Quarantining it discarded finished renders as late artifacts and held the
    // user's coins for operator review.
    const staleThresholdMs = job.mode === "video" ? input.videoTimeoutMs : input.timeoutMs;
    const executionCeiling = new Date(
      staleCutoff.getTime() - staleThresholdMs * (ACTIVE_SOURCE_STALE_MULTIPLIER - 1),
    );
    if (
      input.recoveryProbe.attemptId === attempt.id &&
      input.recoveryProbe.sourceExecuting &&
      evidenceAt >= executionCeiling
    ) {
      return { kind: "none" };
    }
    if (
      input.recoveryProbe.attemptId === attempt.id &&
      input.recoveryProbe.sourceExhausted
    ) {
      // Bull exhaustion proves only that execution stopped. Without a Gen
      // terminal record it cannot prove whether a provider call happened.
      const result = await recordGenerationAttemptEvent(tx, {
        eventId: `${attempt.id}:source-exhausted-outcome-unknown`,
        attemptId: attempt.id,
        eventType: "generation.attempt.unknown.v1",
        outcome: "unknown",
        occurredAt: evidenceAt,
        payload: { requestId: job.id, reason: "source_exhausted_without_terminal_record" },
        errorClass: "generation_source_exhausted",
        errorCode: "generation_source_exhausted",
        errorSignature: `generation_source_exhausted:${attempt.provider ?? "unresolved"}`,
        retryability: "operator_retry",
        operatorGuidance: "Inspect the exhausted source job and reconcile provider execution before refunding or retrying.",
      });
      await tx.generationJobEvent.upsert({
        where: { id: `generation_request_unknown_${attempt.id}` },
        create: {
          id: `generation_request_unknown_${attempt.id}`,
          jobId: job.id,
          type: "provider_outcome_unknown",
          message: "Generation execution stopped without terminal evidence and requires operator reconciliation",
          metadata: toInputJson({ attemptId: attempt.id, errorCode: "generation_source_exhausted" }),
        },
        update: {},
      });
      // Retain the failed source row for inspection; never reset its budget.
      return { kind: "quarantined", created: result.disposition === "created", queue: null };
    }
    if (!transport) {
      return dispatch && queue
        ? {
            kind: "redispatch",
            generationJobId: job.id,
            attemptId: attempt.id,
            outboxId: dispatch.id,
            outboxStatus: dispatch.status,
            outboxUpdatedAt: dispatch.updatedAt,
            staleCutoff,
            queue,
          }
        : { kind: "none" };
    }

    const thresholdMs = job.mode === "video"
      ? input.videoTimeoutMs
      : input.timeoutMs;
    const occurredAt = new Date(evidenceAt.getTime() + thresholdMs);
    const originalTransportStatus = transport.status;
    if (transport.status === "running") {
      const quarantinedTransport = await tx.generationTransportExecution.updateMany({
        where: {
          id: transport.id,
          status: "running",
          terminalRecordRef: transport.terminalRecordRef,
        },
        data: { status: "unknown", finishedAt: occurredAt },
      });
      if (quarantinedTransport.count !== 1) return { kind: "none" };
    }
    const result = await recordGenerationAttemptEvent(tx, {
      eventId: `${attempt.id}:stale-provider-outcome-unknown`,
      attemptId: attempt.id,
      eventType: "generation.attempt.unknown.v1",
      outcome: "unknown",
      occurredAt,
      payload: {
        requestId: job.id,
        transportExecutionId: transport.id,
        transportStatus: originalTransportStatus,
        lastEvidenceAt: evidenceAt.toISOString(),
        reason: "provider_execution_lease_expired_without_terminal_record",
      },
      errorClass: "stale_provider_outcome",
      errorCode: "stale_provider_outcome",
      errorSignature: `stale_provider_outcome:${attempt.provider ?? "unresolved"}`,
      retryability: "operator_retry",
      operatorGuidance:
        "Reconcile the provider request before settling, refunding, or retrying this generation.",
    });
    return {
      kind: "quarantined",
      created: result.disposition === "created",
      queue,
    };
  });
}

// How far past the stale threshold a live execution may run before Main stops
// trusting its Bull lock. Matches Gen's own total wait budget (6x the execution
// budget), so this only fires when every worker is gone and nothing can reclaim the row.
const ACTIVE_SOURCE_STALE_MULTIPLIER = 6;

const RECOVERABLE_QUEUE_STATES = new Set([
  "waiting",
  "prioritized",
  "delayed",
  "active",
  "paused",
  "waiting-children",
  "failed",
]);

type RecoverableTerminalProbe = {
  readonly attemptId: string | null;
  readonly defer: boolean;
  readonly sourceDispatchRecoverable: boolean;
  readonly sourceExhausted: boolean;
  /** A worker holds this Attempt's exact source row under its Bull lock right now. */
  readonly sourceExecuting: boolean;
};

// INTENT: Redis and Blob probes must never run while PostgreSQL authority rows
// are locked. An unavailable dependency conservatively defers this stale row;
// the next bounded scan can decide after authority is reachable again.
export async function probeRecoverableTerminalEvidence(
  generationJobId: string,
): Promise<RecoverableTerminalProbe> {
  const [job, attempt, dispatchRows] = await Promise.all([
    prisma.generationJob.findUnique({
      where: { id: generationJobId },
      select: { id: true, mode: true },
    }),
    prisma.generationAttempt.findFirst({
      where: { requestId: generationJobId },
      orderBy: { attemptNo: "desc" },
      select: {
        id: true,
        requestId: true,
        attemptNo: true,
        provider: true,
        profileKey: true,
        profileVersion: true,
        workflowKey: true,
        workflowVersion: true,
      },
    }),
    prisma.mainOutboxEvent.findMany({
      where: {
        aggregateId: generationJobId,
        eventType: { in: [...MAIN_OUTBOX_GENERATION_DISPATCH_EVENT_TYPES] },
      },
      orderBy: { createdAt: "desc" },
      select: { aggregateType: true, aggregateId: true, payload: true },
    }),
  ]);
  if (!job || !attempt) {
    return {
      attemptId: null,
      defer: false,
      sourceDispatchRecoverable: false,
      sourceExhausted: false,
      sourceExecuting: false,
    };
  }
  const dispatch = generationDispatchForAttempt(dispatchRows, attempt.id);
  try {
    const recovery = await hasRecoverableTerminalEvidence({
      job,
      attempt,
      dispatch,
    });
    return { attemptId: attempt.id, ...recovery };
  } catch {
    return {
      attemptId: attempt.id,
      defer: true,
      sourceDispatchRecoverable: false,
      sourceExhausted: false,
      sourceExecuting: false,
    };
  }
}

// SPEC: recovery may only defer quarantine to evidence the exact immutable
// dispatch envelope could have produced — the same judgement terminal ingest
// applies. A row whose envelope is no longer exact can never be admitted, so
// deferring on it would strand the Request instead of reconciling it.
async function hasRecoverableTerminalEvidence(input: {
  readonly job: GenerationDispatchJobAuthority;
  readonly attempt: PinnedGenerationAttempt;
  readonly dispatch: GenerationDispatchOutboxRow | undefined;
}) {
  const resolved = input.dispatch
    ? checkExactGenerationDispatchAuthority({
        job: input.job,
        attempt: input.attempt,
        dispatch: input.dispatch,
      })
    : null;
  if (!input.dispatch || !resolved?.ok) {
    return { defer: false, sourceDispatchRecoverable: false, sourceExhausted: false, sourceExecuting: false };
  }
  const { authority } = resolved;
  const envelope = {
    job: input.job,
    attempt: input.attempt,
    dispatch: input.dispatch,
    authority,
  };

  let sourceDispatchRecoverable = false;
  let sourceExhausted = false;
  let sourceExecuting = false;
  // Source first, relay last: if recovery changes failed -> waiting ->
  // completed while this probe runs, the final relay read observes the durable
  // admission that allowed source completion.
  const source = await jobQueue.getByDedupeKey(
    authority.queue,
    authority.dedupeKey,
  );
  if (
    source &&
    RECOVERABLE_QUEUE_STATES.has(source.state) &&
    source.id === bullMqJobIdForDedupeKey(authority.dedupeKey) &&
    source.dedupeKey === authority.dedupeKey &&
    canonicalSha256(authority.queueInput.payload) ===
      canonicalSha256(source.payload)
  ) {
    if (source.state !== "failed") {
      sourceDispatchRecoverable = true;
      sourceExecuting = source.state === "active";
    } else if (await hasExactBlobTerminal(envelope)) {
      return { defer: true, sourceDispatchRecoverable: false, sourceExhausted: false, sourceExecuting: false };
    } else {
      // A failed source already replaced once is not replaced again.
      sourceExhausted = source.attemptsMade >= source.maxAttempts ||
        Boolean(await prisma.generationJobEvent.findUnique({
          where: { id: failedSourceReplacementEventId(input.attempt.id) },
          select: { id: true },
        }));
    }
  }

  const relay = await jobQueue.getByDedupeKey(
    MAIN_QUEUES.generationTerminalIngest,
    idempotencyKeys.generationTerminalRelay(input.attempt.id),
  );
  if (!relay || !RECOVERABLE_QUEUE_STATES.has(relay.state)) {
    return { defer: false, sourceDispatchRecoverable, sourceExhausted, sourceExecuting };
  }
  const validation = validateGenerationTerminalRelaySnapshot(relay);
  return {
    defer: validation.valid &&
      exactAttemptTerminalEvidence(envelope, validation.payload.terminalRecord),
    sourceDispatchRecoverable,
    sourceExhausted,
    sourceExecuting,
  };
}

type ExactGenerationDispatchEnvelope = {
  readonly job: GenerationDispatchJobAuthority;
  readonly attempt: PinnedGenerationAttempt;
  readonly dispatch: GenerationDispatchOutboxRow;
  readonly authority: ExactGenerationDispatchAuthority;
};

// INTENT: an unreachable Blob store is not "no evidence" — it throws so the
// caller defers this stale row to the next bounded scan.
async function hasExactBlobTerminal(envelope: ExactGenerationDispatchEnvelope) {
  const read = await readAttemptTerminalRecord(envelope.attempt.id);
  if (!read.ok) {
    if (read.code === "unavailable") throw new Error(read.message);
    return false;
  }
  return exactAttemptTerminalEvidence(envelope, read.record);
}

function exactAttemptTerminalEvidence(
  envelope: ExactGenerationDispatchEnvelope,
  record: GenerationTerminalRecord,
) {
  return record.mode === envelope.authority.mode &&
    checkExactGenerationDispatchAuthority({
      job: envelope.job,
      attempt: envelope.attempt,
      dispatch: envelope.dispatch,
      evidence: generationTerminalRecordEvidence(record),
    }).ok;
}

async function recoverStaleGenerationDispatch(
  decision: Extract<StaleGenerationDecision, { kind: "redispatch" }>,
  now: Date,
) {
  const queued = await jobQueue.getByDedupeKey(
    decision.queue.queue,
    decision.queue.dedupeKey,
  );
  if (queued) {
    // A redispatch decision exists only without a transport, so Gen never
    // reached the provider. A completed or failed source row (for example one
    // that stalled past its limit while the host slept) has stopped running.
    if (queued.state !== "completed" && queued.state !== "failed") return 0;
    const finishedAt = queued.finishedOn ? new Date(queued.finishedOn) : null;
    if (finishedAt && finishedAt >= decision.staleCutoff) return 0;
    if (queued.state === "failed" && !(await claimFailedSourceReplacement(decision))) return 0;
    const removed = await jobQueue.removeByDedupeKey(
      decision.queue.queue,
      decision.queue.dedupeKey,
    );
    if (!removed) return 0;
  }
  const released = await prisma.mainOutboxEvent.updateMany({
    where: {
      id: decision.outboxId,
      status: decision.outboxStatus,
      updatedAt: decision.outboxUpdatedAt,
    },
    data: {
      status: "pending",
      nextRunAt: now,
      deliveredAt: null,
      lastError: Prisma.DbNull,
    },
  });
  if (released.count !== 1) return 0;
  const recovered = await dispatchGenerationAttemptOutbox(prisma, {
    outboxIds: [decision.outboxId],
    limit: 1,
    now,
  });
  return recovered.delivered;
}

const FAILED_SOURCE_REPLACED_EVENT = "failed_source_replaced";

// INVARIANT: a failed source row is replaced at most once per Attempt. The
// unique event is written before the row is removed; if the replacement fails
// again, the recovery probe treats the source as exhausted so the Request is
// settled through unknown-outcome reconciliation instead of looping.
async function claimFailedSourceReplacement(
  decision: Extract<StaleGenerationDecision, { kind: "redispatch" }>,
) {
  try {
    await prisma.generationJobEvent.create({
      data: {
        id: failedSourceReplacementEventId(decision.attemptId),
        jobId: decision.generationJobId,
        type: FAILED_SOURCE_REPLACED_EVENT,
        message: "A failed Generation source that never reached the provider was replaced once",
        metadata: toInputJson({ attemptId: decision.attemptId, queue: decision.queue.queue }),
      },
    });
    return true;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
    throw error;
  }
}

function failedSourceReplacementEventId(attemptId: string) {
  return `generation_request_failed_source_replaced_${attemptId}`;
}

function isTerminalAttempt(status: string) {
  return ["succeeded", "failed", "blocked", "cancelled", "unknown"].includes(status);
}

function latestDate(...values: Array<Date | null | undefined>) {
  const milliseconds = values.flatMap((value) => value ? [value.getTime()] : []);
  return new Date(Math.max(...milliseconds));
}

function generationQueueFact(value: Prisma.JsonValue): GenerationQueueFact | null {
  const queueInput = jsonRecord(jsonRecord(value).queueInput);
  const queue = queueInput.queue;
  const dedupeKey = queueInput.dedupeKey;
  if (
    (queue !== "ai.image.generate" && queue !== "ai.video.generate") ||
    typeof dedupeKey !== "string" ||
    dedupeKey.length === 0
  ) {
    return null;
  }
  return { queue, dedupeKey };
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
