import { Prisma } from "@prisma/client";
import {
  generationProviderIdempotencyKey,
  generationTerminalRecordRef,
  generationTerminalRecordSchema,
  idempotencyKeys,
  imageGeneratePayloadSchema,
  MAIN_QUEUES,
  MAIN_TO_CHAT_EVENTS,
  videoGeneratePayloadSchema,
} from "@idream/shared/contracts";
import { bullMqJobIdForDedupeKey, jobQueue } from "@/server/jobs/queue";
import type { QueueJob } from "@/server/jobs/queue";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { appendCanonicalMetricEvent } from "@/server/modules/admin-v2/metrics/event-writer";
import { createClassifiedAnalyticsEvent } from "@/server/modules/admin-v2/metrics/classified-event-writer";
import { providers } from "@/server/providers";
import {
  markProductionItemFailed,
  markProductionItemGenerated,
} from "@/server/modules/admin/content-production-state";
import {
  aiFinalizePayloadSchema,
  type AiFinalizePayload,
} from "./schemas";
import { recordGenerationAttemptEvent } from "./generation-attempt-events";
import {
  transitionGenerationRequest,
  transitionGenerationRequestWithDisposition,
} from "./generation-request-transition";
import { ensureGenerationSettlementLinks } from "./generation-settlement";
import { postDreamcoinEntry } from "@/server/modules/admin/billing/ledger";
import { recordMainToChatEvent } from "@/processes/chat-outbox";
import {
  deliverGenerationArtifacts,
  lateArtifactDisposition,
  projectAttemptArtifactDisposition,
} from "./generation-evidence-transition-authority";
import {
  dispatchGenerationAttemptOutbox,
} from "@/server/modules/generation/generation-attempt-authority";
import {
  MAIN_OUTBOX_GENERATION_DISPATCH_EVENT_TYPES,
} from "@/server/events/main-outbox-transport";
import { removeGenerationAttemptQueueJob } from "./generation-attempt-queue";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import { consumeGenerationTerminalRelay } from "./generation-terminal-relay";
import { validateGenerationTerminalRelaySnapshot } from "./generation-terminal-relay-validation";

export const localAiQueueNames = [
  MAIN_QUEUES.generationTerminalIngest,
  MAIN_QUEUES.aiFinalize,
] as const;

export interface LocalAiDrainResult {
  workerId: string;
  claimed: Array<{
    id: string;
    queue: string;
    status: string;
    error?: string;
  }>;
  processed: number;
}

function unscoredGeneratedImageQuality() {
  return generatedImageQualityEvidence(
    "not_provided",
    { status: "unscored" as const, reason: "worker_did_not_provide_evidence" },
  );
}

function generatedImageQualityEvidence(
  evaluatorVersion: string,
  artifact: { status: "unscored"; reason: string },
) {
  return {
    schemaVersion: "1" as const,
    evaluatorVersion,
    artifact,
    faceCount: { status: "unscored" as const, reason: "evaluator_unavailable" },
    identity: { status: "unscored" as const, reason: "evaluator_unavailable" },
    intent: { status: "unscored" as const, reason: "evaluator_unavailable" },
  };
}

export async function drainLocalAiPipeline(input: {
  limit?: number;
  workerId?: string;
  queues?: string[];
} = {}): Promise<LocalAiDrainResult> {
  const workerId = input.workerId ?? `local-ai-${cryptoRandomId()}`;
  const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
  const queues = input.queues ?? [...localAiQueueNames];
  const claimedSummary: LocalAiDrainResult["claimed"] = [];
  let processed = 0;

  for (let index = 0; index < limit; index += 1) {
    let claimed = false;

    for (const queue of queues) {
      const result = await jobQueue.processNext({
        queue,
        workerId,
        processor: processLocalAiJob,
      });
      if (!result.job) continue;

      claimed = true;
      claimedSummary.push({
        id: result.job.id,
        queue: result.job.queue,
        status: result.status,
        ...(result.error ? { error: result.error } : {}),
      });
      if (result.status === "completed") processed += 1;
      break;
    }

    if (!claimed) break;
  }

  return { workerId, claimed: claimedSummary, processed };
}

export async function reconcileStaleGenerationJobs(input: {
  now?: Date;
  timeoutMs?: number;
  videoTimeoutMs?: number;
  limit?: number;
  generationJobIds?: readonly string[];
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
    return { scanned: 0, enqueued: 0, quarantined: 0, cutoff, videoCutoff };
  }
  const idFilter = input.generationJobIds
    ? Prisma.sql`AND request.id IN (${Prisma.join([...input.generationJobIds])})`
    : Prisma.empty;
  const candidates = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT request.id
    FROM generation_jobs request
    WHERE request.status IN ('queued', 'moderating_input', 'running', 'moderating_output')
      AND (
        (request.mode = 'video' AND request."updatedAt" < ${videoCutoff}) OR
        (request.mode <> 'video' AND request."updatedAt" < ${cutoff})
      )
      ${idFilter}
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

  return { scanned: jobs.length, enqueued, quarantined, cutoff, videoCutoff };
}

type GenerationQueueFact = {
  readonly queue: "ai.image.generate" | "ai.video.generate";
  readonly dedupeKey: string;
};

type StaleGenerationDecision =
  | { readonly kind: "none" }
  | {
      readonly kind: "redispatch";
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
    const [transport, latestAttemptEvent, dispatchRows] = await Promise.all([
      transportCandidate
        ? tx.generationTransportExecution.findUnique({
            where: { id: transportCandidate.id },
          })
        : null,
      tx.generationAttemptEvent.findFirst({
        where: { attemptId: attempt.id },
        orderBy: { sequence: "desc" },
        select: { occurredAt: true },
      }),
      tx.mainOutboxEvent.findMany({
        where: {
          aggregateId: job.id,
          eventType: { in: [...MAIN_OUTBOX_GENERATION_DISPATCH_EVENT_TYPES] },
        },
        orderBy: { createdAt: "desc" },
      }),
    ]);
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
    if (!transport) {
      return dispatch && queue
        ? {
            kind: "redispatch",
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
};

// INTENT: Redis and Blob probes must never run while PostgreSQL authority rows
// are locked. An unavailable dependency conservatively defers this stale row;
// the next bounded scan can decide after authority is reachable again.
async function probeRecoverableTerminalEvidence(
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
      select: { id: true, attemptNo: true, provider: true },
    }),
    prisma.mainOutboxEvent.findMany({
      where: {
        aggregateId: generationJobId,
        eventType: { in: [...MAIN_OUTBOX_GENERATION_DISPATCH_EVENT_TYPES] },
      },
      orderBy: { createdAt: "desc" },
      select: { payload: true },
    }),
  ]);
  if (!job || !attempt) {
    return {
      attemptId: null,
      defer: false,
      sourceDispatchRecoverable: false,
    };
  }
  const dispatch = dispatchRows.find(
    (row) => jsonRecord(row.payload).attemptId === attempt.id,
  );
  const queue = dispatch ? generationQueueFact(dispatch.payload) : null;
  try {
    const recovery = await hasRecoverableTerminalEvidence({
      job,
      attempt,
      dispatch,
      queue,
    });
    return { attemptId: attempt.id, ...recovery };
  } catch {
    return {
      attemptId: attempt.id,
      defer: true,
      sourceDispatchRecoverable: false,
    };
  }
}

async function hasRecoverableTerminalEvidence(input: {
  readonly job: { id: string; mode: string };
  readonly attempt: {
    id: string;
    attemptNo: number;
    provider: string | null;
  };
  readonly dispatch: { payload: Prisma.JsonValue } | undefined;
  readonly queue: GenerationQueueFact | null;
}) {
  let sourceDispatchRecoverable = false;
  // Source first, relay last: if recovery changes failed -> waiting ->
  // completed while this probe runs, the final relay read observes the durable
  // admission that allowed source completion.
  if (input.queue && input.dispatch) {
    const source = await jobQueue.getByDedupeKey(
      input.queue.queue,
      input.queue.dedupeKey,
    );
    if (source && RECOVERABLE_QUEUE_STATES.has(source.state)) {
      const queueInput = jsonRecord(jsonRecord(input.dispatch.payload).queueInput);
      const parsed = input.job.mode === "video"
        ? videoGeneratePayloadSchema.safeParse(source.payload)
        : imageGeneratePayloadSchema.safeParse(source.payload);
      if (
        parsed.success &&
        parsed.data.generationJobId === input.job.id &&
        parsed.data.attemptId === input.attempt.id &&
        parsed.data.attemptNo === input.attempt.attemptNo &&
        parsed.data.provider === input.attempt.provider &&
        source.id === bullMqJobIdForDedupeKey(input.queue.dedupeKey) &&
        source.dedupeKey === input.queue.dedupeKey &&
        canonicalSha256(queueInput.payload) === canonicalSha256(source.payload)
      ) {
        if (source.state !== "failed") {
          sourceDispatchRecoverable = true;
        } else if (await hasExactBlobTerminal(input, parsed.data)) {
          return { defer: true, sourceDispatchRecoverable: false };
        }
      }
    }
  }

  const relayKey = idempotencyKeys.generationTerminalRelay(input.attempt.id);
  const relay = await jobQueue.getByDedupeKey(
    MAIN_QUEUES.generationTerminalIngest,
    relayKey,
  );
  if (!relay || !RECOVERABLE_QUEUE_STATES.has(relay.state)) {
    return { defer: false, sourceDispatchRecoverable };
  }
  const validation = validateGenerationTerminalRelaySnapshot(relay);
  const exactRelay = validation.valid &&
    validation.payload.terminalRecord.generationJobId === input.job.id &&
    validation.payload.terminalRecord.attemptNo === input.attempt.attemptNo &&
    validation.payload.terminalRecord.provider === input.attempt.provider;
  return {
    defer: exactRelay,
    sourceDispatchRecoverable,
  };
}

async function hasExactBlobTerminal(
  input: Parameters<typeof hasRecoverableTerminalEvidence>[0],
  payload: { requestId: string; model: string },
) {
  const blob = providers.blob;
  if (!blob.getPrivate) throw new Error("blob terminal read unavailable");
  const loaded = await blob.getPrivate({
    key: generationTerminalRecordRef(input.attempt.id),
  });
  if (!loaded.ok) {
    if (loaded.error.code === "not_found") return false;
    throw new Error(loaded.error.message);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(loaded.data.body));
  } catch {
    return false;
  }
  const terminal = generationTerminalRecordSchema.safeParse(decoded);
  return terminal.success &&
    terminal.data.attemptId === input.attempt.id &&
    terminal.data.attemptNo === input.attempt.attemptNo &&
    terminal.data.generationJobId === input.job.id &&
    terminal.data.requestId === payload.requestId &&
    terminal.data.provider === input.attempt.provider &&
    terminal.data.mode === input.job.mode &&
    terminal.data.model === payload.model &&
    terminal.data.providerIdempotencyKey ===
      generationProviderIdempotencyKey(input.attempt.id);
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
    if (!["completed", "failed"].includes(queued.state)) return 0;
    const finishedAt = queued.finishedOn ? new Date(queued.finishedOn) : null;
    if (finishedAt && finishedAt >= decision.staleCutoff) return 0;
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

async function processLocalAiJob(job: QueueJob) {
  if (job.queue === MAIN_QUEUES.generationTerminalIngest) {
    await consumeGenerationTerminalRelay(job.payload);
    return;
  }
  if (job.queue === MAIN_QUEUES.aiFinalize) {
    return processFinalize(job.payload);
  }

  throw new Error(`Main cannot execute generation queue: ${job.queue}`);
}

type GenerationFinalizePayload = Extract<
  AiFinalizePayload,
  { kind: `generation.${string}` }
>;

function isGenerationFinalize(
  payload: AiFinalizePayload,
): payload is GenerationFinalizePayload {
  return payload.kind.startsWith("generation.");
}

async function processFinalize(payloadValue: Prisma.JsonValue) {
  const payload = aiFinalizePayloadSchema.parse(payloadValue);
  if (!isGenerationFinalize(payload)) return;

  // INTENT: the raw queue value travels alongside the parsed one because the
  // durable terminal-record match is a statement about the delivered wire bytes.
  // Hashing the parsed projection instead would make the check depend on which
  // fields the current schema happens to retain.
  switch (payload.kind) {
    case "generation.completed":
      return finalizeGenerationCompleted(payload, payloadValue);
    case "generation.failed":
      return finalizeGenerationFailed(payload, payloadValue);
    case "generation.unknown":
      return finalizeGenerationUnknown(payload, payloadValue);
    case "generation.blocked":
      return finalizeGenerationBlocked(payload, payloadValue);
    default: {
      // INVARIANT: every generation.* finalize kind is routed above. This
      // assignment stops compiling the moment one is added and left unhandled —
      // falling through silently would strand the Request and its held funds.
      const unhandled: never = payload;
      throw new Error(
        `Unhandled generation finalize kind: ${(unhandled as { kind: string }).kind}`,
      );
    }
  }
}

async function finalizeGenerationCompleted(
  payload: Extract<AiFinalizePayload, { kind: "generation.completed" }>,
  rawPayload: Prisma.JsonValue,
) {
  const job = await prisma.generationJob.findUnique({
    where: { id: payload.generationJobId },
  });
  if (!job) return;
  const resolved = await resolveGenerationAttemptForFinalize(job.id, payload, rawPayload);
  await removeGenerationAttemptQueueJob({
    requestId: job.id,
    attemptId: resolved.attempt.id,
  });
  if (!resolved.isLatest) return;
  const attemptId = resolved.attempt.id;
  if (job.status === "completed") return;
  if (["failed", "blocked", "cancelled", "refunded"].includes(job.status)) {
    await prisma.$transaction(async (tx) => {
      if (attemptId) {
        const validationState =
          lateArtifactDisposition({ requestStatus: job.status }) ??
            "late_after_failed";
        await projectAttemptArtifactDisposition(tx, {
          requestId: job.id,
          attemptId,
          targetId: job.userId,
          validationState,
          deliveryStatus: "suppressed",
          occurredAt: new Date(),
        });
        await markGenerationTerminalRecordDelivered(tx, attemptId);
      }
      await appendGenerationEvent(tx, job.id, "late_artifact_archived", "Provider artifacts arrived after a terminal Request outcome and were suppressed", { attemptId: attemptId ?? null, requestStatus: job.status, assetCount: payload.assets.length });
    });
    return;
  }

  if (!await markGenerationModeratingOutput(job.id, payload.assets.length)) return;

  const outputModeration = await moderateText(
    "generation_job",
    payload.generationJobId,
    payload.assets.map((asset) => asset.key).join(" "),
    "output",
  );
  if (outputModeration.status === "blocked") {
    await refundGeneration(
      job.userId,
      job.id,
      job.costDreamcoins,
      "blocked",
      "output_blocked",
      job.sourceType,
      job.sourceId,
      attemptId,
      {
        attemptOutcome: "blocked",
        retryability: "not_retryable",
        terminalRecordRef: payload.terminalRecordRef,
        terminalRecordChecksum: payload.terminalRecordChecksum,
      },
    );
    return;
  }

  const existingAssets = await prisma.mediaAsset.count({
    where: { sourceJobId: payload.generationJobId },
  });

  await prisma.$transaction(async (tx) => {
    if (existingAssets === 0) {
      for (const [index, asset] of payload.assets.entries()) {
        const mediaId = `media_${cryptoRandomId()}`;
        const providerKey = typeof asset.providerKey === "string" ? asset.providerKey : asset.key;
        const displayUrl =
          `/user-content/${mediaRouteToken(mediaId)}/content${mediaFileExtension(asset.contentType)}`;
        await tx.mediaAsset.create({
          data: {
            id: mediaId,
            ownerId: job.userId,
            sourceJobId: job.id,
            characterId: job.characterId,
            type: payload.mode,
            url: displayUrl,
            thumbnailUrl: payload.mode === "image" ? displayUrl : null,
            storageKey: asset.key,
            contentType: asset.contentType,
            width: asset.width,
            height: asset.height,
            providerAssetId: providerKey,
            sourcePromptHash: job.prompt ? promptHash(job.prompt) : null,
            prompt: job.prompt,
            visibility: "private",
            safetyStatus: outputModeration.status,
            metadata: toInputJson({
              index,
              provider: payload.provider ?? job.provider ?? "unknown",
              providerKey,
              synthetic: payload.provider?.startsWith("mock") ?? false,
              contentType: asset.contentType,
              width: asset.width,
              height: asset.height,
              seconds: asset.seconds,
              usage: payload.usage,
              storageKey: asset.key,
              ...(job.sourceType === "character_preview"
                ? { source: "character_preview" }
                : {}),
              visualProfileId: job.visualProfileId,
              visualProfileVersion: job.visualProfileVersion,
              consistencyMode: job.consistencyMode,
              seed: job.seed,
              referenceAssetIds: job.referenceAssetIds,
              quality: asset.quality ?? unscoredGeneratedImageQuality(),
            }),
          },
        });
        await appendGenerationEvent(tx, job.id, "image_quality_scored", "Image quality evidence recorded", {
          mediaAssetId: mediaId,
          assetIndex: index,
          quality: asset.quality ?? unscoredGeneratedImageQuality(),
        });
      }
    }

    await appendGenerationEvent(tx, job.id, "moderation_passed", "Output moderation passed", {
      assets: payload.assets.length,
    });

    // INVARIANT: content_production jobs are never debited, so they must never be
    // credited on refund — their costDreamcoins is record-keeping only.
    const missingOutputs = Math.max(0, job.outputCount - payload.assets.length);
    if (missingOutputs > 0 && job.costDreamcoins > 0 && job.sourceType !== "content_production_item") {
      const refundAmount = Math.ceil((job.costDreamcoins * missingOutputs) / job.outputCount);
      await postDreamcoinEntry(tx, {
        kind: "refund",
        userId: job.userId,
        amount: refundAmount,
        sourceId: job.id,
        idempotencyKey: `generation:${job.id}:partial-refund`,
      });
      await appendGenerationEvent(tx, job.id, "refunded", "Partial generation refund issued", {
        amount: refundAmount,
        missingOutputs,
      });
    }

    const completedAt = new Date();
    await transitionGenerationRequest(tx, {
      requestId: job.id,
      to: "completed",
      expected: { from: "moderating_output" },
      data: {
        completedAt,
        finishedAt: completedAt,
        deliveredOutputCount: Math.min(job.outputCount, payload.assets.length),
        errorCode: null,
      },
    });
    if (attemptId) {
      await recordGenerationAttemptEvent(tx, {
        eventId: `${attemptId}:terminal`,
        attemptId,
        eventType: "generation.attempt.succeeded.v1",
        outcome: "succeeded",
        occurredAt: completedAt,
        payload: {
          requestId: job.id,
          assetCount: payload.assets.length,
          expectedOutputCount: job.outputCount,
          terminalRecordChecksum: payload.terminalRecordChecksum ?? null,
        },
        terminalRecordRef: payload.terminalRecordRef ?? null,
      });
    }
    if (attemptId) {
      await markGenerationTerminalRecordDelivered(tx, attemptId);
    }
    await appendGenerationEvent(tx, job.id, "completed", "Generation job completed", {
      assets: payload.assets.length,
      requested: job.outputCount,
    });
    const persistedAssets = await tx.mediaAsset.findMany({
      where: { sourceJobId: job.id },
      select: { id: true, width: true, height: true, metadata: true },
    });
    const persistedAssetsByOrdinal = new Map<number, (typeof persistedAssets)[number]>();
    for (const asset of persistedAssets) {
      const ordinal = mediaAssetGenerationOrdinal(asset.metadata);
      if (ordinal === null) continue;
      if (persistedAssetsByOrdinal.has(ordinal)) {
        throw Errors.conflict("Generation produced duplicate MediaAsset ordinals", {
          requestId: job.id,
          ordinal,
        });
      }
      persistedAssetsByOrdinal.set(ordinal, asset);
    }
    const deliveredAssets = payload.assets.map((_, ordinal) => {
      const asset = persistedAssetsByOrdinal.get(ordinal);
      if (!asset) {
        throw Errors.conflict("Generation Artifact ordinal has no persisted MediaAsset", {
          requestId: job.id,
          ordinal,
        });
      }
      return asset;
    });
    const productionAsset = deliveredAssets[0];
    if (productionAsset) {
      await markProductionItemGenerated(tx, {
        jobId: job.id,
        mediaAssetId: productionAsset.id,
      });
    }
    if (attemptId) {
      await deliverGenerationArtifacts(tx, {
        requestId: job.id,
        attemptId,
        targetId: job.userId,
        assets: deliveredAssets.map((asset, ordinal) => ({
          ordinal,
          assetId: asset.id,
        })),
        occurredAt: completedAt,
      });
    }
    if (deliveredAssets.length > 0) {
      await appendLocalCanonicalProductEvent(tx, {
        sourceEventId: `generation-delivery:${job.id}:v2`,
        eventType: "generation.delivery.completed.v2",
        occurredAt: completedAt,
        userId: job.userId,
        context: { characterId: job.characterId, characterReleaseId: null },
        payload: {
          requestId: job.id,
          artifactId: deliveredAssets[0].id,
          userId: job.userId,
          expectedOutputCount: job.outputCount,
          deliveredOutputCount: deliveredAssets.length,
          valid: true,
          displayable: true,
        },
      });
    }
    const chatAsset = deliveredAssets[0];
    if (chatAsset && job.sourceType === "chat_image" && job.sourceId) {
      await recordMainToChatEvent({
        eventId: `chat_image_completed_${job.sourceId}_${job.id}_${chatAsset.id}`,
        eventType: MAIN_TO_CHAT_EVENTS.chatImageCompleted,
        aggregateType: "chat_attachment",
        aggregateId: job.sourceId,
        payload: {
          version: 1,
          kind: "chat.image.completed",
          attachmentId: job.sourceId,
          generationJobId: job.id,
          mediaAssetId: chatAsset.id,
          width: chatAsset.width,
          height: chatAsset.height,
          summary: chatImageCompletedSummary(job),
        },
      }, tx);
    }
    if (!payload.terminalRecordRef) {
      await appendLocalCanonicalProductEvent(tx, {
        sourceEventId: `ai-usage:${attemptId ?? job.id}:v2`,
        eventType: "ai.usage.recorded.v2",
        occurredAt: completedAt,
        userId: job.userId,
        context: { characterId: job.characterId, characterReleaseId: null },
        payload: {
          invocationId: attemptId ?? job.id,
          requestId: job.id,
          ...(attemptId ? { attemptId } : {}),
          userId: job.userId,
          provider: payload.provider ?? job.provider ?? "local-pipeline",
          model: payload.model ?? job.model ??
            (typeof payload.usage.model === "string" ? payload.usage.model : "unknown"),
          usage: payload.usage,
          pricingVersion: null,
        },
      });
    }
  });

  await trackEvent("generation_completed", { jobId: job.id, mode: payload.mode }, { userId: job.userId });
}

async function appendLocalCanonicalProductEvent(
  tx: Prisma.TransactionClient,
  input: {
    sourceEventId: string;
    eventType: string;
    occurredAt: Date;
    userId: string;
    context: Readonly<Record<string, unknown>>;
    payload: Readonly<Record<string, unknown>>;
  },
) {
  await appendCanonicalMetricEvent(tx, input);
}

async function finalizeGenerationFailed(
  payload: Extract<AiFinalizePayload, { kind: "generation.failed" }>,
  rawPayload: Prisma.JsonValue,
) {
  const job = await prisma.generationJob.findUnique({
    where: { id: payload.generationJobId },
  });
  if (!job) return;
  const resolved = await resolveGenerationAttemptForFinalize(job.id, payload, rawPayload);
  await removeGenerationAttemptQueueJob({
    requestId: job.id,
    attemptId: resolved.attempt.id,
  });
  if (!resolved.isLatest) return;
  if (["completed", "failed", "blocked", "refunded", "cancelled"].includes(job.status)) return;
  await refundGeneration(
    job.userId,
    job.id,
    job.costDreamcoins,
    "failed",
    payload.error.code,
    job.sourceType,
    job.sourceId,
    resolved.attempt.id,
    {
      attemptOutcome: "failed",
      retryability: payload.error.retryability,
      terminalRecordRef: payload.terminalRecordRef,
      terminalRecordChecksum: payload.terminalRecordChecksum,
    },
  );
}

// SPEC: an ambiguous provider outcome settles nothing. No refund is issued and
// no business retry is allowed until an operator reconciles the provider request.
// INVARIANT: reachable only from the generation.unknown finalize variant, so a
// plain failure can never be routed here (and vice versa).
async function finalizeGenerationUnknown(
  payload: Extract<AiFinalizePayload, { kind: "generation.unknown" }>,
  rawPayload: Prisma.JsonValue,
) {
  const job = await prisma.generationJob.findUnique({
    where: { id: payload.generationJobId },
  });
  if (!job) return;
  const resolved = await resolveGenerationAttemptForFinalize(job.id, payload, rawPayload);
  await removeGenerationAttemptQueueJob({
    requestId: job.id,
    attemptId: resolved.attempt.id,
  });
  if (!resolved.isLatest) return;
  const attemptId = resolved.attempt.id;
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`
      SELECT id FROM generation_jobs WHERE id = ${job.id} FOR UPDATE
    `);
    const current = await tx.generationJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    if (
      !["queued", "moderating_input", "running", "moderating_output"].includes(
        current.status,
      )
    ) return;
    const latest = await tx.generationAttempt.findFirst({
      where: { requestId: current.id },
      orderBy: [{ attemptNo: "desc" }, { createdAt: "desc" }],
      select: { id: true },
    });
    if (latest?.id !== attemptId) return;
    const attempt = await tx.generationAttempt.findUniqueOrThrow({
      where: { id: attemptId },
    });
    if (attempt.status !== "unknown") {
      await recordGenerationAttemptEvent(tx, {
        eventId: `${attemptId}:terminal`,
        attemptId,
        eventType: "generation.attempt.unknown.v1",
        outcome: "unknown",
        occurredAt: attempt.finishedAt ?? new Date(),
        payload: {
          requestId: current.id,
          requestOutcome: "needs_reconciliation",
          errorCode: payload.error.code,
          terminalRecordChecksum: payload.terminalRecordChecksum,
        },
        terminalRecordRef: payload.terminalRecordRef,
        errorCode: payload.error.code,
        errorClass: "ambiguous_provider_outcome",
        errorSignature: `ambiguous_provider_outcome:${payload.error.code}`,
        retryability: payload.error.retryability ?? "operator_retry",
        operatorGuidance:
          "Reconcile the provider request before settlement or business retry.",
      });
    }
    await markGenerationTerminalRecordDelivered(tx, attemptId);
    await tx.generationJobEvent.upsert({
      where: { id: `generation_request_unknown_${attemptId}` },
      create: {
        id: `generation_request_unknown_${attemptId}`,
        jobId: current.id,
        type: "provider_outcome_unknown",
        message: "Provider outcome is unknown and requires operator reconciliation",
        metadata: toInputJson({
          attemptId,
          errorCode: payload.error.code,
          terminalRecordRef: payload.terminalRecordRef,
          terminalRecordChecksum: payload.terminalRecordChecksum,
        }),
      },
      update: {},
    });
  });
}

async function finalizeGenerationBlocked(
  payload: Extract<AiFinalizePayload, { kind: "generation.blocked" }>,
  rawPayload: Prisma.JsonValue,
) {
  const job = await prisma.generationJob.findUnique({
    where: { id: payload.generationJobId },
  });
  if (!job) return;
  const resolved = await resolveGenerationAttemptForFinalize(job.id, payload, rawPayload);
  await removeGenerationAttemptQueueJob({
    requestId: job.id,
    attemptId: resolved.attempt.id,
  });
  if (!resolved.isLatest) return;
  if (["completed", "failed", "blocked", "refunded", "cancelled"].includes(job.status)) return;
  await refundGeneration(
    job.userId,
    job.id,
    job.costDreamcoins,
    "blocked",
    payload.policyCode,
    job.sourceType,
    job.sourceId,
    resolved.attempt.id,
    {
      attemptOutcome: "blocked",
      retryability: "not_retryable",
      terminalRecordRef: payload.terminalRecordRef,
      terminalRecordChecksum: payload.terminalRecordChecksum,
      moderation: {
        layer: payload.layer,
        policyCode: payload.policyCode,
        message: payload.message,
      },
    },
  );
}

async function resolveGenerationAttemptForFinalize(
  jobId: string,
  payload: Extract<
    AiFinalizePayload,
    {
      kind:
        | "generation.completed"
        | "generation.failed"
        | "generation.unknown"
        | "generation.blocked";
    }
  >,
  rawPayload: Prisma.JsonValue,
) {
  const [attempt, latestAttempt, terminalOutbox] = await Promise.all([
    prisma.generationAttempt.findFirst({
      where: {
        id: payload.attemptId,
        requestId: jobId,
        attemptNo: payload.attemptNo,
      },
    }),
    prisma.generationAttempt.findFirst({
      where: { requestId: jobId },
      orderBy: [{ attemptNo: "desc" }, { createdAt: "desc" }],
      select: { id: true },
    }),
    prisma.mainOutboxEvent.findUnique({
      where: { id: `generation_terminal_record_${payload.attemptId}` },
    }),
  ]);
  if (!attempt) {
    throw Errors.conflict(
      "Generation finalize Attempt identity does not belong to the Request",
      {
        requestId: jobId,
        attemptId: payload.attemptId,
        attemptNo: payload.attemptNo,
      },
    );
  }
  if (
    !terminalOutbox ||
    terminalOutbox.eventType !== "generation.terminal_record.accepted.v1" ||
    terminalOutbox.aggregateType !== "generation_attempt" ||
    terminalOutbox.aggregateId !== attempt.id ||
    canonicalSha256(terminalOutbox.payload) !== canonicalSha256(rawPayload)
  ) {
    throw Errors.conflict(
      "Generation finalize payload does not match its durable terminal record",
      { requestId: jobId, attemptId: attempt.id },
    );
  }
  return { attempt, isLatest: latestAttempt?.id === attempt.id };
}

// P4 Task 5: what the chat agent should recall having sent. sourceMeta.promptHint
// (the raw human-facing request, set on chat.image.requested — see service.ts
// buildChatImagePrompt) is preferred: job.prompt is the fully-composed generation
// prompt (character description + style directives), which at a 200-char clip
// would truncate away the actual request. job.prompt is the fallback for the rare
// case a job carries no hint. No extra query — job is already loaded.
function chatImageCompletedSummary(job: {
  prompt: string | null;
  sourceMeta: Prisma.JsonValue | null;
}): string | undefined {
  const sourceMeta =
    job.sourceMeta && typeof job.sourceMeta === "object" && !Array.isArray(job.sourceMeta)
      ? (job.sourceMeta as Record<string, unknown>)
      : {};
  const promptHint = typeof sourceMeta.promptHint === "string" ? sourceMeta.promptHint : null;
  const raw = promptHint?.trim() || job.prompt?.trim();
  if (!raw) return undefined;
  return raw.length <= 200 ? raw : `${raw.slice(0, 199)}…`;
}

async function markGenerationModeratingOutput(generationJobId: string, assetCount: number) {
  return prisma.$transaction(async (tx) => {
    const result = await transitionGenerationRequestWithDisposition(tx, {
      requestId: generationJobId,
      to: "moderating_output",
      expected: { from: ["queued", "moderating_input", "running", "moderating_output"] },
      onConflict: "return-null",
    });
    if (!result) return false;
    if (result.disposition === "applied") {
      await appendGenerationEvent(
        tx,
        generationJobId,
        "provider_completed",
        "Provider returned assets",
        { assetCount },
      );
      await appendGenerationEvent(
        tx,
        generationJobId,
        "moderating_output",
        "Output moderation started",
        { assetCount },
      );
    }
    return true;
  });
}

async function moderateText(
  targetType: string,
  targetId: string,
  content: string,
  layer: string,
) {
  const result = await providers.moderation.check({
    targetType: "text",
    content,
  });
  if (!result.ok) throw new Error(result.error.message);

  await prisma.moderationEvent.create({
    data: {
      targetType,
      targetId,
      layer,
      status: result.data.status,
      policyCode: result.data.policyCode,
      confidence: result.data.confidence,
      details: {},
    },
  });

  return result.data;
}

async function refundGeneration(
  userId: string,
  jobId: string,
  cost: number,
  status: "failed" | "blocked",
  errorCode: string,
  sourceType: string,
  sourceId: string | null,
  attemptId?: string,
  // INVARIANT: refunding settles a Request as failed/blocked, so the Attempt
  // outcome recorded here is never the ambiguous one — an unknown provider
  // outcome holds the funds and goes to operator reconciliation instead.
  terminal: {
    attemptOutcome?: "failed" | "blocked";
    retryability?: "retryable" | "not_retryable" | "operator_retry";
    terminalRecordRef?: string;
    terminalRecordChecksum?: string;
    moderation?: { layer: string; policyCode: string; message: string };
  } = {},
) {
  // INVARIANT: content_production jobs are never debited, so they must never be
  // credited on refund — their costDreamcoins is record-keeping only (ops batches
  // don't charge a wallet on creation).
  const isDebitedJob = sourceType !== "content_production_item";
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "generation_jobs" WHERE id = ${jobId} FOR UPDATE`;
    const transitioned = await transitionGenerationRequest(tx, {
      requestId: jobId,
      to: status,
      expected: { from: ["queued", "moderating_input", "running", "moderating_output"] },
      data: {
        errorCode,
        completedAt: null,
        finishedAt: new Date(),
        deliveredOutputCount: 0,
      },
      onConflict: "return-null",
    });
    if (!transitioned) return false;
    if (sourceType === "chat_image" && sourceId) {
      await recordMainToChatEvent({
        eventId: `chat_image_failed_${sourceId}_${jobId}_${status}_${errorCode}`,
        eventType: MAIN_TO_CHAT_EVENTS.chatImageFailed,
        aggregateType: "chat_attachment",
        aggregateId: sourceId,
        payload: {
          version: 1,
          kind: "chat.image.failed",
          attachmentId: sourceId,
          generationJobId: jobId,
          status,
          errorCode,
        },
      }, tx);
    }
    if (terminal.moderation) {
      await tx.moderationEvent.create({
        data: {
          targetType: "generation_job",
          targetId: jobId,
          layer: terminal.moderation.layer,
          status: "blocked",
          policyCode: terminal.moderation.policyCode,
          confidence: 1,
          details: toInputJson({ message: terminal.moderation.message }),
        },
      });
    }
    const settlement = isDebitedJob ? await ensureGenerationSettlementLinks(tx, jobId) : { refundable: 0 };
    const refundAmount = Math.min(cost, settlement.refundable);
    if (refundAmount > 0 && isDebitedJob) {
      await postDreamcoinEntry(tx, {
        kind: "refund",
        userId,
        amount: refundAmount,
        sourceId: jobId,
        idempotencyKey: `generation:${jobId}:refund`,
      });
    }
    if (attemptId) {
      await projectAttemptArtifactDisposition(tx, {
        requestId: jobId,
        attemptId,
        targetId: userId,
        validationState: status === "blocked" ? "rejected" : "invalid",
        deliveryStatus: "failed",
        occurredAt: new Date(),
      });
      const attempt = await tx.generationAttempt.findFirstOrThrow({
        where: { id: attemptId, requestId: jobId },
      });
      const finishedAt = attempt.finishedAt ?? new Date();
      const attemptOutcome = terminal.attemptOutcome ?? "failed";
      if (attempt.status !== attemptOutcome) {
        if (["succeeded", "failed", "blocked", "cancelled", "unknown"].includes(attempt.status)) {
          throw new Error(
            `Generation Attempt ${attemptId} already ended as ${attempt.status}, cannot settle Request as ${attemptOutcome}`,
          );
        }
        await recordGenerationAttemptEvent(tx, {
          eventId: `${attemptId}:terminal`,
          attemptId,
          eventType: `generation.attempt.${attemptOutcome}.v1`,
          outcome: attemptOutcome,
          occurredAt: finishedAt,
          payload: {
            requestId: jobId,
            requestOutcome: status,
            errorCode,
            refundAmount,
            terminalRecordChecksum: terminal.terminalRecordChecksum ?? null,
          },
          terminalRecordRef: terminal.terminalRecordRef ?? null,
          errorCode,
          retryability: terminal.retryability ?? (status === "failed" ? "retryable" : "not_retryable"),
        });
      }
      await markGenerationTerminalRecordDelivered(tx, attemptId);
    }
    await markProductionItemFailed(tx, jobId);
    await appendGenerationEvent(tx, jobId, status, `Generation job ${status}`, {
      errorCode,
    });
    await appendGenerationEvent(tx, jobId, "refunded", "Dreamcoins refunded", {
      amount: refundAmount,
    });
    return true;
  });
}

async function markGenerationTerminalRecordDelivered(
  tx: Prisma.TransactionClient,
  attemptId: string,
) {
  await tx.mainOutboxEvent.updateMany({
    where: { id: `generation_terminal_record_${attemptId}` },
    data: { status: "delivered", deliveredAt: new Date() },
  });
}

async function appendGenerationEvent(
  tx: Prisma.TransactionClient,
  jobId: string,
  type: string,
  message: string,
  metadata: Record<string, unknown>,
) {
  return tx.generationJobEvent.create({
    data: {
      jobId,
      type,
      message,
      metadata: toInputJson(metadata),
    },
  });
}


function promptHash(value: string) {
  let hash = 5381;
  for (const char of value) hash = (hash * 33) ^ char.charCodeAt(0);
  return `prompt_${Math.abs(hash)}`;
}

async function trackEvent(
  name: string,
  props: unknown,
  ctx: { userId?: string; anonymousId?: string },
) {
  return createClassifiedAnalyticsEvent(prisma, {
    userId: ctx.userId,
    anonymousId: ctx.anonymousId,
    name,
    props,
    sourceService: "main-worker",
  });
}

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function mediaAssetGenerationOrdinal(metadata: Prisma.JsonValue | null) {
  if (metadata === null || Array.isArray(metadata) || typeof metadata !== "object") {
    return null;
  }
  const ordinal = metadata.index;
  return typeof ordinal === "number" && Number.isInteger(ordinal) && ordinal >= 0
    ? ordinal
    : null;
}

function cryptoRandomId() {
  return `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function mediaFileExtension(contentType: string | undefined) {
  const extensions: Record<string, string> = {
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
  };
  return contentType ? (extensions[contentType] ?? "") : "";
}

function mediaRouteToken(id: string) {
  return Buffer.from(id, "utf8").toString("base64url");
}
