import {
  Prisma,
  type GenerationAttempt,
  type MainOutboxEvent,
  type PrismaClient,
} from "@prisma/client";
import { recordGenerationAttemptQueuedEvent } from "@/server/ai/generation-attempt-events";
import { transitionGenerationRequest } from "@/server/ai/generation-request-transition";
import {
  MAIN_OUTBOX_GENERATION_DISPATCH_EVENT_TYPES,
} from "@/server/events/main-outbox-transport";
import { jobQueue, type EnqueueJobInput } from "@/server/jobs/queue";
import { Errors } from "@/server/lib/errors";
import { generationWorkflowDescriptor } from "@/server/modules/admin/generation-catalog";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import {
  buildGenerationAttemptQueueInput,
  type ExistingGenerationJob,
} from "./attempt-dispatch";

export type GenerationDispatchEventType =
  (typeof MAIN_OUTBOX_GENERATION_DISPATCH_EVENT_TYPES)[number];

export type GenerationAttemptReservation = {
  readonly id?: string;
  readonly requestId: string;
  readonly attemptNo: number;
  readonly provider?: string | null;
  readonly profileKey?: string | null;
  readonly profileVersion?: number | null;
  readonly workflowKey?: string | null;
  readonly workflowVersion?: number | null;
  readonly sourceCommandId?: string | null;
  readonly creativeRunItemId?: string | null;
};

export type GenerationAttemptDispatchReservation = {
  readonly attempt: GenerationAttemptReservation;
  readonly dispatch: {
    readonly outboxId: string;
    readonly eventType: GenerationDispatchEventType;
    readonly aggregateType: "generation_request";
    readonly aggregateId: string;
    readonly payload?: Readonly<Record<string, unknown>>;
    readonly dedupeKey?: string;
  };
};

type GenerationDispatchIntent = {
  readonly outboxId?: string;
  readonly eventType: GenerationDispatchEventType;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly dedupeKey?: string;
};

export type InitialGenerationAttemptIntent = {
  readonly requestId: string;
  readonly sourceCommandId?: string | null;
  readonly creativeRunItemId?: string | null;
  readonly dispatch: GenerationDispatchIntent;
};

export type RetryGenerationAttemptIntent = {
  readonly requestId: string;
  readonly expectedRequestVersion?: number;
  readonly requireLatestAttempt?: boolean;
  readonly eligibleLatestStatuses?: readonly ("failed" | "unknown")[];
  readonly sourceCommandId?: string | null;
  readonly creativeRunItemId?: string | null;
  readonly dispatch: GenerationDispatchIntent;
};

type GenerationRetryAuthorityRequest = {
  readonly id: string;
  readonly status: string;
  readonly errorCode: string | null;
  readonly deliveredOutputCount: number;
};

type GenerationRetryAuthorityAttempt = Pick<
  GenerationAttempt,
  "id" | "status" | "retryability"
>;

type GenerationRetryAuthorityDb = Pick<
  Prisma.TransactionClient,
  "generationDelivery" | "generationJobEvent"
>;

export type GenerationAttemptRetryAuthority =
  | {
      readonly allowed: true;
      readonly basis:
        | "failed_attempt"
        | "operator_confirmed_unknown_failure"
        | "failed_request_without_attempt";
    }
  | {
      readonly allowed: false;
      readonly code:
        | "delivery_exists"
        | "request_not_failed"
        | "attempt_not_retryable"
        | "unknown_attempt_unresolved";
      readonly message: string;
      readonly details: Readonly<Record<string, unknown>>;
    };

const TERMINAL_UNKNOWN_RETRY_DECISIONS = [
  "unknown_reconciliation_adopt_succeeded",
  "unknown_reconciliation_confirm_failed",
] as const;

type DispatchQueue = {
  enqueue(input: EnqueueJobInput): Promise<unknown>;
  removeByDedupeKey(queue: string, dedupeKey: string): Promise<boolean>;
};

type GenerationDispatchIdentity = {
  readonly requestId: string;
  readonly attemptId: string;
  readonly attemptNo: number;
};

const GENERATION_DISPATCH_ACTIVE_REQUEST_STATES = new Set([
  "queued",
  "moderating_input",
  "running",
  "moderating_output",
]);

const GENERATION_DISPATCH_ACTIVE_ATTEMPT_STATES = new Set([
  "queued",
  "running",
]);

function nullable<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

function attemptReservationFact(input: GenerationAttemptReservation) {
  return {
    requestId: input.requestId,
    attemptNo: input.attemptNo,
    provider: nullable(input.provider),
    profileKey: nullable(input.profileKey),
    profileVersion: nullable(input.profileVersion),
    workflowKey: nullable(input.workflowKey),
    workflowVersion: nullable(input.workflowVersion),
    sourceCommandId: nullable(input.sourceCommandId),
    creativeRunItemId: nullable(input.creativeRunItemId),
  };
}

function storedAttemptReservationFact(attempt: GenerationAttempt) {
  return {
    requestId: attempt.requestId,
    attemptNo: attempt.attemptNo,
    provider: attempt.provider,
    profileKey: attempt.profileKey,
    profileVersion: attempt.profileVersion,
    workflowKey: attempt.workflowKey,
    workflowVersion: attempt.workflowVersion,
    sourceCommandId: attempt.sourceCommandId,
    creativeRunItemId: attempt.creativeRunItemId,
  };
}

function assertSameAttemptReservation(
  attempt: GenerationAttempt,
  input: GenerationAttemptReservation,
) {
  if (
    (input.id !== undefined && input.id !== attempt.id) ||
    canonicalSha256(storedAttemptReservationFact(attempt)) !==
      canonicalSha256(attemptReservationFact(input))
  ) {
    throw Errors.conflict(
      "Generation Attempt reservation was replayed with different authority",
      {
        attemptId: attempt.id,
        requestId: input.requestId,
        attemptNo: input.attemptNo,
      },
    );
  }
}

function dispatchPayload(
  attempt: GenerationAttempt,
  input: GenerationAttemptDispatchReservation["dispatch"],
  queueInput: EnqueueJobInput,
) {
  const supplied = input.payload ?? {};
  if ("queueInput" in supplied) {
    throw Errors.conflict(
      "Generation dispatch payload cannot override the reserved queue envelope",
    );
  }
  for (const [key, expected] of Object.entries({
    generationJobId: attempt.requestId,
    attemptId: attempt.id,
    attemptNo: attempt.attemptNo,
  })) {
    if (key in supplied && supplied[key] !== expected) {
      throw Errors.conflict(
        `Generation dispatch payload ${key} conflicts with the reserved Attempt`,
      );
    }
  }
  return {
    ...supplied,
    generationJobId: attempt.requestId,
    attemptId: attempt.id,
    attemptNo: attempt.attemptNo,
    queueInput: immutableQueueInput(queueInput),
  };
}

function immutableQueueInput(input: EnqueueJobInput) {
  return {
    queue: input.queue,
    payload: input.payload,
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.maxAttempts !== undefined
      ? { maxAttempts: input.maxAttempts }
      : {}),
    ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
    ...(input.nextRunAt
      ? { nextRunAt: input.nextRunAt.toISOString() }
      : {}),
  };
}

function assertSameOutboxReservation(
  outbox: MainOutboxEvent,
  input: GenerationAttemptDispatchReservation["dispatch"],
  payload: Readonly<Record<string, unknown>>,
) {
  if (
    outbox.eventType !== input.eventType ||
    outbox.aggregateType !== input.aggregateType ||
    outbox.aggregateId !== input.aggregateId ||
    canonicalSha256(outbox.payload) !== canonicalSha256(payload)
  ) {
    throw Errors.conflict(
      "Generation dispatch Outbox id was replayed with a different payload",
      { outboxId: input.outboxId },
    );
  }
}

// SPEC: A queued business Attempt and its dispatch intent are one atomic fact.
// INVARIANT: Reusing either identity with different immutable data fails closed.
async function persistGenerationAttemptDispatchReservation(
  tx: Prisma.TransactionClient,
  input: GenerationAttemptDispatchReservation,
): Promise<{ attempt: GenerationAttempt; outbox: MainOutboxEvent }> {
  if (!Number.isInteger(input.attempt.attemptNo) || input.attempt.attemptNo < 1) {
    throw Errors.badRequest("Generation Attempt number must be a positive integer");
  }
  const job = await tx.generationJob.findUnique({
    where: { id: input.attempt.requestId },
  });
  if (!job) {
    throw Errors.notFound("Generation request does not exist", {
      requestId: input.attempt.requestId,
    });
  }
  if (
    input.dispatch.aggregateType !== "generation_request" ||
    input.dispatch.aggregateId !== job.id
  ) {
    throw Errors.conflict(
      "Generation dispatch Outbox identity must be owned by the Generation Request",
      {
        requestId: job.id,
        aggregateType: input.dispatch.aggregateType,
        aggregateId: input.dispatch.aggregateId,
      },
    );
  }
  const provider = input.attempt.provider ?? job.provider;
  if (!provider) {
    throw Errors.conflict(
      "Generation dispatch requires a pinned provider",
      { requestId: input.attempt.requestId },
    );
  }
  const reservation = { ...input.attempt, provider };
  const attempt = await tx.generationAttempt.upsert({
    where: {
      requestId_attemptNo: {
        requestId: input.attempt.requestId,
        attemptNo: input.attempt.attemptNo,
      },
    },
    create: {
      ...(input.attempt.id ? { id: input.attempt.id } : {}),
      ...attemptReservationFact(reservation),
      status: "queued",
    },
    update: {},
  });
  assertSameAttemptReservation(attempt, reservation);
  await recordGenerationAttemptQueuedEvent(tx, attempt);

  const exactDedupeKey = generationAttemptDedupeKey(attempt);
  if (
    input.dispatch.dedupeKey !== undefined &&
    input.dispatch.dedupeKey !== exactDedupeKey
  ) {
    throw Errors.conflict(
      "Generation dispatch dedupe key must be bound to the exact Attempt",
      { attemptId: attempt.id, expectedDedupeKey: exactDedupeKey },
    );
  }

  const queueInput = await buildGenerationAttemptQueueInput(
    job as ExistingGenerationJob,
    {
      id: attempt.id,
      requestId: attempt.requestId,
      attemptNo: attempt.attemptNo,
      provider,
      profileKey: attempt.profileKey,
      profileVersion: attempt.profileVersion,
      workflowKey: attempt.workflowKey,
      workflowVersion: attempt.workflowVersion,
    },
    { dedupeKey: exactDedupeKey, db: tx },
  );
  const payload = dispatchPayload(attempt, input.dispatch, queueInput);
  const outbox = await tx.mainOutboxEvent.upsert({
    where: { id: input.dispatch.outboxId },
    create: {
      id: input.dispatch.outboxId,
      eventType: input.dispatch.eventType,
      aggregateType: input.dispatch.aggregateType,
      aggregateId: input.dispatch.aggregateId,
      payload: toInputJson(payload),
    },
    update: {},
  });
  assertSameOutboxReservation(outbox, input.dispatch, payload);
  return { attempt, outbox };
}

async function lockGenerationRequest(
  tx: Prisma.TransactionClient,
  requestId: string,
) {
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM "generation_jobs" WHERE id = ${requestId} FOR UPDATE`,
  );
  const job = await tx.generationJob.findUnique({ where: { id: requestId } });
  if (!job) {
    throw Errors.notFound("Generation request does not exist", { requestId });
  }
  return job;
}

async function generationAttemptPins(
  tx: Prisma.TransactionClient,
  job: Awaited<ReturnType<typeof lockGenerationRequest>>,
  latest?: GenerationAttempt | null,
) {
  const controls = jsonRecord(job.controls);
  const profile =
    job.profileId && job.profileVersion
      ? await tx.generationModelProfile.findFirst({
          where: {
            version: job.profileVersion,
            OR: [{ id: job.profileId }, { profileKey: job.profileId }],
          },
        })
      : null;
  const workflowKey =
    latest?.workflowKey ??
    (typeof controls.workflowKey === "string" ? controls.workflowKey : null) ??
    profile?.workflowKey ??
    profile?.pipelineModel ??
    job.model;
  const controlledWorkflowVersion = controls.workflowVersion;
  const pinnedWorkflowVersion =
    latest?.workflowVersion ??
    (typeof controlledWorkflowVersion === "number" &&
    Number.isInteger(controlledWorkflowVersion) &&
    controlledWorkflowVersion >= 0
      ? controlledWorkflowVersion
      : null);
  // INTENT: Profile-backed callers should not have to duplicate Attempt pins in
  // mutable queue controls. The reservation owns the immutable workflow fact and
  // resolves it while the exact Profile version is locked in this transaction.
  const workflow =
    pinnedWorkflowVersion === null && workflowKey
      ? await generationWorkflowDescriptor(workflowKey)
      : null;
  const configuredWorkflowVersion = jsonRecord(
    profile?.runnerConfig ?? null,
  ).workflowVersion;
  return {
    provider: latest?.provider ?? job.provider ?? profile?.runner,
    profileKey: latest?.profileKey ?? profile?.profileKey ?? job.profileId,
    profileVersion:
      latest?.profileVersion ?? profile?.version ?? job.profileVersion,
    workflowKey,
    workflowVersion:
      pinnedWorkflowVersion ??
      workflow?.version ??
      (typeof configuredWorkflowVersion === "number" &&
      Number.isSafeInteger(configuredWorkflowVersion) &&
      configuredWorkflowVersion > 0
        ? configuredWorkflowVersion
        : null),
  };
}

// SPEC: Initial callers name a Generation Request and dispatch intent only.
// This module owns the lock, immutable pins, queued Attempt, and Outbox fact.
export async function reserveInitialGenerationAttempt(
  tx: Prisma.TransactionClient,
  input: InitialGenerationAttemptIntent,
) {
  const job = await lockGenerationRequest(tx, input.requestId);
  const outboxId = input.dispatch.outboxId ?? `generation_initial_${job.id}`;
  const exactReplay = await replayInitialGenerationReservation(
    tx,
    input,
    outboxId,
  );
  if (exactReplay) return exactReplay;
  if (job.status !== "queued") {
    throw Errors.conflict(
      "Initial Generation Attempt requires a queued Generation Request",
      { requestId: job.id, status: job.status },
    );
  }
  const latest = await tx.generationAttempt.findFirst({
    where: { requestId: job.id },
    orderBy: { attemptNo: "desc" },
  });
  if (latest && latest.attemptNo !== 1) {
    throw Errors.conflict(
      "Initial Generation Attempt cannot replace an existing retry sequence",
      { requestId: job.id, latestAttemptNo: latest.attemptNo },
    );
  }
  const pins = await generationAttemptPins(tx, job, latest);
  return persistGenerationAttemptDispatchReservation(tx, {
    attempt: {
      ...(latest ? { id: latest.id } : {}),
      requestId: job.id,
      attemptNo: 1,
      ...pins,
      sourceCommandId: input.sourceCommandId,
      creativeRunItemId: input.creativeRunItemId,
    },
    dispatch: {
      ...input.dispatch,
      outboxId,
      aggregateType: "generation_request",
      aggregateId: job.id,
    },
  });
}

async function replayInitialGenerationReservation(
  tx: Prisma.TransactionClient,
  input: InitialGenerationAttemptIntent,
  outboxId: string,
) {
  const outbox = await tx.mainOutboxEvent.findUnique({
    where: { id: outboxId },
  });
  if (!outbox) return null;
  const payload = jsonRecord(outbox.payload);
  const attemptId =
    typeof payload.attemptId === "string" ? payload.attemptId : null;
  const attempt = attemptId
    ? await tx.generationAttempt.findUnique({ where: { id: attemptId } })
    : null;
  if (
    !attempt ||
    attempt.requestId !== input.requestId ||
    attempt.attemptNo !== 1 ||
    attempt.sourceCommandId !== nullable(input.sourceCommandId) ||
    attempt.creativeRunItemId !== nullable(input.creativeRunItemId) ||
    outbox.eventType !== input.dispatch.eventType ||
    outbox.aggregateType !== "generation_request" ||
    outbox.aggregateId !== input.requestId
  ) {
    throw Errors.conflict(
      "Initial Generation reservation replay conflicts with durable authority",
      { requestId: input.requestId, outboxId },
    );
  }
  const queueInput = jsonRecord(payload.queueInput as Prisma.JsonValue);
  const exactDedupeKey = generationAttemptDedupeKey(attempt);
  if (
    queueInput.dedupeKey !== exactDedupeKey ||
    (input.dispatch.dedupeKey !== undefined &&
      input.dispatch.dedupeKey !== exactDedupeKey)
  ) {
    throw Errors.conflict(
      "Initial Generation reservation does not use the exact Attempt dedupe key",
      { requestId: input.requestId, attemptId: attempt.id },
    );
  }
  const suppliedPayload = input.dispatch.payload ?? {};
  for (const [key, value] of Object.entries(suppliedPayload)) {
    if (canonicalSha256(payload[key]) !== canonicalSha256(value)) {
      throw Errors.conflict(
        "Initial Generation reservation replay changed its dispatch intent",
        { requestId: input.requestId, outboxId, key },
      );
    }
  }
  if (input.dispatch.dedupeKey) {
    if (queueInput.dedupeKey !== input.dispatch.dedupeKey) {
      throw Errors.conflict(
        "Initial Generation reservation replay changed its queue dedupe key",
        { requestId: input.requestId, outboxId },
      );
    }
  }
  return { attempt, outbox };
}

function generationAttemptDedupeKey(
  attempt: Pick<GenerationAttempt, "requestId" | "attemptNo">,
) {
  return `generation:${attempt.requestId}:attempt:${attempt.attemptNo}`;
}

// SPEC: An unknown Attempt is an immutable transport fact. A later
// confirm_failed event is separate, append-only business authority to create a
// new Attempt; it never rewrites or replays the unknown Attempt itself.
export async function resolveGenerationAttemptRetryAuthority(
  db: GenerationRetryAuthorityDb,
  input: {
    readonly request: GenerationRetryAuthorityRequest;
    readonly latestAttempt: GenerationRetryAuthorityAttempt | null;
  },
): Promise<GenerationAttemptRetryAuthority> {
  const deliveredCount = await db.generationDelivery.count({
    where: { requestId: input.request.id, status: "delivered" },
  });
  if (deliveredCount > 0 || input.request.deliveredOutputCount > 0) {
    return {
      allowed: false,
      code: "delivery_exists",
      message: "Partially delivered requests require failed-output reconciliation",
      details: {
        requestId: input.request.id,
        deliveredCount,
        deliveredOutputCount: input.request.deliveredOutputCount,
      },
    };
  }
  if (input.request.status !== "failed") {
    return {
      allowed: false,
      code: "request_not_failed",
      message: "Generation Request is not failed and cannot be retried",
      details: {
        requestId: input.request.id,
        status: input.request.status,
      },
    };
  }

  const latestAttempt = input.latestAttempt;
  if (!latestAttempt) {
    return { allowed: true, basis: "failed_request_without_attempt" };
  }
  if (latestAttempt.status === "failed") {
    if (latestAttempt.retryability === "not_retryable") {
      return {
        allowed: false,
        code: "attempt_not_retryable",
        message: "Latest Generation Attempt is explicitly non-replayable",
        details: { attemptId: latestAttempt.id },
      };
    }
    return { allowed: true, basis: "failed_attempt" };
  }
  if (latestAttempt.status !== "unknown") {
    return {
      allowed: false,
      code: "attempt_not_retryable",
      message: "Latest Generation Attempt is not safe for retry",
      details: { attemptId: latestAttempt.id, status: latestAttempt.status },
    };
  }

  const terminalDecisions = (
    await db.generationJobEvent.findMany({
      where: {
        jobId: input.request.id,
        type: { in: [...TERMINAL_UNKNOWN_RETRY_DECISIONS] },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })
  ).filter(
    (event) => jsonRecord(event.metadata).attemptId === latestAttempt.id,
  );
  const decision = terminalDecisions.length === 1 ? terminalDecisions[0] : null;
  const metadata = decision ? jsonRecord(decision.metadata) : {};
  if (
    decision?.type === "unknown_reconciliation_confirm_failed" &&
    metadata.resolution === "confirm_failed" &&
    input.request.errorCode === "operator_confirmed_provider_failure"
  ) {
    return { allowed: true, basis: "operator_confirmed_unknown_failure" };
  }
  return {
    allowed: false,
    code: "unknown_attempt_unresolved",
    message:
      "Unknown Generation Attempt requires a terminal confirm_failed decision before retry",
    details: {
      requestId: input.request.id,
      attemptId: latestAttempt.id,
      terminalDecisionCount: terminalDecisions.length,
      terminalDecisionType: decision?.type ?? null,
    },
  };
}

// SPEC: Retry callers express eligibility and business provenance only.
// INVARIANT: lock -> eligibility -> Request transition -> pinned Attempt+Outbox
// is one transaction, so no caller can race attemptNo or partially stage retry.
export async function reserveRetryGenerationAttempt(
  tx: Prisma.TransactionClient,
  input: RetryGenerationAttemptIntent,
) {
  const job = await lockGenerationRequest(tx, input.requestId);
  if (
    input.expectedRequestVersion !== undefined &&
    job.version !== input.expectedRequestVersion
  ) {
    throw Errors.conflict("Generation Request changed before retry", {
      requestId: job.id,
      expectedVersion: input.expectedRequestVersion,
      currentVersion: job.version,
    });
  }
  const latest = await tx.generationAttempt.findFirst({
    where: { requestId: job.id },
    orderBy: { attemptNo: "desc" },
  });
  if (input.requireLatestAttempt && !latest) {
    throw Errors.conflict("Generation Request has no Attempt to retry", {
      requestId: job.id,
    });
  }
  const eligible = input.eligibleLatestStatuses ?? ["failed", "unknown"];
  if (latest && !eligible.includes(latest.status as "failed" | "unknown")) {
    throw Errors.conflict("Latest Generation Attempt is not safe for retry", {
      attemptId: latest.id,
      status: latest.status,
    });
  }
  const authority = await resolveGenerationAttemptRetryAuthority(tx, {
    request: job,
    latestAttempt: latest,
  });
  if (!authority.allowed) {
    throw Errors.conflict(authority.message, {
      code: authority.code,
      ...authority.details,
    });
  }
  const request = await transitionGenerationRequest(tx, {
    requestId: job.id,
    to: "queued",
    expected: { from: "failed", version: job.version },
    data: {
      errorCode: null,
      completedAt: null,
      finishedAt: null,
      deliveredOutputCount: 0,
    },
  });
  const attemptNo = (latest?.attemptNo ?? 0) + 1;
  const pins = await generationAttemptPins(tx, job, latest);
  const reservation = await persistGenerationAttemptDispatchReservation(tx, {
    attempt: {
      requestId: job.id,
      attemptNo,
      ...pins,
      sourceCommandId: input.sourceCommandId,
      creativeRunItemId: input.creativeRunItemId,
    },
    dispatch: {
      ...input.dispatch,
      outboxId:
        input.dispatch.outboxId ?? `generation_retry_${job.id}_${attemptNo}`,
      aggregateType: "generation_request",
      aggregateId: job.id,
    },
  });
  return {
    ...reservation,
    request,
    previousRequest: job,
    previousAttempt: latest,
  };
}

function jsonRecord(value: Prisma.JsonValue): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function queueInputFromOutboxPayload(payload: Record<string, unknown>) {
  const envelope = payload.queueInput;
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    throw new Error("Generation dispatch Outbox queue envelope is missing");
  }
  const record = envelope as Record<string, unknown>;
  const queue = record.queue;
  const jobPayload = record.payload;
  if (
    (queue !== "ai.image.generate" && queue !== "ai.video.generate") ||
    typeof jobPayload !== "object" ||
    jobPayload === null ||
    Array.isArray(jobPayload)
  ) {
    throw new Error("Generation dispatch Outbox queue envelope is invalid");
  }
  const nextRunAt =
    typeof record.nextRunAt === "string" ? new Date(record.nextRunAt) : undefined;
  if (nextRunAt && Number.isNaN(nextRunAt.getTime())) {
    throw new Error("Generation dispatch Outbox nextRunAt is invalid");
  }
  return {
    queue,
    payload: jobPayload as Prisma.InputJsonValue,
    ...(typeof record.priority === "number" ? { priority: record.priority } : {}),
    ...(typeof record.maxAttempts === "number"
      ? { maxAttempts: record.maxAttempts }
      : {}),
    ...(typeof record.dedupeKey === "string"
      ? { dedupeKey: record.dedupeKey }
      : {}),
    ...(nextRunAt ? { nextRunAt } : {}),
  } satisfies EnqueueJobInput;
}

function generationDispatchIdentity(
  row: Pick<MainOutboxEvent, "aggregateType" | "aggregateId" | "payload">,
): GenerationDispatchIdentity {
  const payload = jsonRecord(row.payload);
  if (
    row.aggregateType !== "generation_request" ||
    typeof payload.generationJobId !== "string" ||
    typeof payload.attemptId !== "string" ||
    typeof payload.attemptNo !== "number" ||
    !Number.isSafeInteger(payload.attemptNo) ||
    payload.attemptNo < 1 ||
    row.aggregateId !== payload.generationJobId
  ) {
    throw new Error("Generation dispatch Outbox payload is invalid");
  }
  return {
    requestId: payload.generationJobId,
    attemptId: payload.attemptId,
    attemptNo: payload.attemptNo,
  };
}

type GenerationDispatchAuthoritySnapshot = {
  readonly authorized: boolean;
  readonly requestStatus: string | null;
  readonly attemptStatus: string | null;
  readonly reason:
    | "authorized"
    | "request_not_found"
    | "attempt_identity_mismatch"
    | "request_terminal"
    | "attempt_terminal";
};

async function lockGenerationDispatchRequest(
  tx: Prisma.TransactionClient,
  requestId: string,
) {
  return tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM "generation_jobs" WHERE id = ${requestId} FOR UPDATE
  `);
}

async function generationDispatchAuthoritySnapshot(
  tx: Prisma.TransactionClient,
  identity: GenerationDispatchIdentity,
): Promise<GenerationDispatchAuthoritySnapshot> {
  const locked = await lockGenerationDispatchRequest(tx, identity.requestId);
  if (locked.length !== 1) {
    return {
      authorized: false,
      requestStatus: null,
      attemptStatus: null,
      reason: "request_not_found",
    };
  }
  const [request, attempt] = await Promise.all([
    tx.generationJob.findUnique({
      where: { id: identity.requestId },
      select: { status: true },
    }),
    tx.generationAttempt.findUnique({
      where: { id: identity.attemptId },
      select: { requestId: true, attemptNo: true, status: true },
    }),
  ]);
  if (!request) {
    return {
      authorized: false,
      requestStatus: null,
      attemptStatus: attempt?.status ?? null,
      reason: "request_not_found",
    };
  }
  if (
    !attempt ||
    attempt.requestId !== identity.requestId ||
    attempt.attemptNo !== identity.attemptNo
  ) {
    return {
      authorized: false,
      requestStatus: request.status,
      attemptStatus: attempt?.status ?? null,
      reason: "attempt_identity_mismatch",
    };
  }
  if (!GENERATION_DISPATCH_ACTIVE_REQUEST_STATES.has(request.status)) {
    return {
      authorized: false,
      requestStatus: request.status,
      attemptStatus: attempt.status,
      reason: "request_terminal",
    };
  }
  if (!GENERATION_DISPATCH_ACTIVE_ATTEMPT_STATES.has(attempt.status)) {
    return {
      authorized: false,
      requestStatus: request.status,
      attemptStatus: attempt.status,
      reason: "attempt_terminal",
    };
  }
  return {
    authorized: true,
    requestStatus: request.status,
    attemptStatus: attempt.status,
    reason: "authorized",
  };
}

function suppressedGenerationDispatchStatus(
  snapshot: GenerationDispatchAuthoritySnapshot,
) {
  return snapshot.requestStatus === "cancelled" ||
    snapshot.attemptStatus === "cancelled"
    ? "cancelled"
    : "rejected";
}

async function suppressGenerationDispatchOutbox(
  tx: Prisma.TransactionClient,
  input: {
    readonly outboxId: string;
    readonly expectedStatus: string;
    readonly expectedNextRunAt: Date;
    readonly identity: GenerationDispatchIdentity;
    readonly snapshot: GenerationDispatchAuthoritySnapshot;
    readonly occurredAt: Date;
  },
) {
  return tx.mainOutboxEvent.updateMany({
    where: {
      id: input.outboxId,
      status: input.expectedStatus,
      nextRunAt: input.expectedNextRunAt,
    },
    data: {
      status: suppressedGenerationDispatchStatus(input.snapshot),
      nextRunAt: input.occurredAt,
      deliveredAt: null,
      lastError: toInputJson({
        code: "generation_dispatch_authority_revoked",
        reason: input.snapshot.reason,
        requestId: input.identity.requestId,
        requestStatus: input.snapshot.requestStatus,
        attemptId: input.identity.attemptId,
        attemptNo: input.identity.attemptNo,
        attemptStatus: input.snapshot.attemptStatus,
        occurredAt: input.occurredAt.toISOString(),
      }),
    },
  });
}

async function rejectMalformedGenerationDispatchOutbox(
  db: PrismaClient,
  input: {
    readonly row: MainOutboxEvent;
    readonly occurredAt: Date;
    readonly error: unknown;
  },
) {
  return db.mainOutboxEvent.updateMany({
    where: {
      id: input.row.id,
      status: input.row.status,
      nextRunAt: input.row.nextRunAt,
    },
    data: {
      status: "rejected",
      nextRunAt: input.occurredAt,
      deliveredAt: null,
      lastError: toInputJson({
        code: "generation_dispatch_payload_invalid",
        message:
          input.error instanceof Error
            ? input.error.message
            : "Generation dispatch payload is invalid",
        outboxId: input.row.id,
        originalStatus: input.row.status,
        originalNextRunAt: input.row.nextRunAt.toISOString(),
        rejectedAt: input.occurredAt.toISOString(),
      }),
    },
  });
}

// INVARIANT: Request cancellation, Attempt cancellation, refund, and removal of
// the exact Attempt's pending dispatch authority commit as one business fact.
export async function cancelGenerationAttemptDispatchOutboxes(
  tx: Prisma.TransactionClient,
  input: {
    readonly requestId: string;
    readonly attemptId: string;
    readonly cancelledAt: Date;
    readonly reason: string;
  },
) {
  const rows = await tx.mainOutboxEvent.findMany({
    where: {
      aggregateType: "generation_request",
      aggregateId: input.requestId,
      eventType: { in: [...MAIN_OUTBOX_GENERATION_DISPATCH_EVENT_TYPES] },
      status: { in: ["pending", "dispatched"] },
    },
    select: { id: true, payload: true },
  });
  const exactOutboxIds = rows
    .filter((row) => jsonRecord(row.payload).attemptId === input.attemptId)
    .map((row) => row.id);
  if (exactOutboxIds.length === 0) return 0;
  const sealed = await tx.mainOutboxEvent.updateMany({
    where: {
      id: { in: exactOutboxIds },
      status: { in: ["pending", "dispatched"] },
    },
    data: {
      status: "cancelled",
      nextRunAt: input.cancelledAt,
      deliveredAt: null,
      lastError: toInputJson({
        code: "generation_dispatch_cancelled",
        requestId: input.requestId,
        attemptId: input.attemptId,
        reason: input.reason,
        cancelledAt: input.cancelledAt.toISOString(),
      }),
    },
  });
  return sealed.count;
}

async function claimGenerationDispatchOutbox(
  db: PrismaClient,
  input: {
    readonly row: MainOutboxEvent;
    readonly identity: GenerationDispatchIdentity;
    readonly leaseExpiresAt: Date;
    readonly now: Date;
  },
) {
  return db.$transaction(async (tx) => {
    const snapshot = await generationDispatchAuthoritySnapshot(tx, input.identity);
    if (!snapshot.authorized) {
      await suppressGenerationDispatchOutbox(tx, {
        outboxId: input.row.id,
        expectedStatus: input.row.status,
        expectedNextRunAt: input.row.nextRunAt,
        identity: input.identity,
        snapshot,
        occurredAt: input.now,
      });
      return false;
    }
    const claimed = await tx.mainOutboxEvent.updateMany({
      where: {
        id: input.row.id,
        status: input.row.status,
        nextRunAt: input.row.nextRunAt,
      },
      data: {
        status: "dispatched",
        attempts: { increment: 1 },
        nextRunAt: input.leaseExpiresAt,
        lastError: Prisma.DbNull,
      },
    });
    return claimed.count === 1;
  });
}

async function verifyClaimedGenerationDispatchOutbox(
  db: PrismaClient,
  input: {
    readonly outboxId: string;
    readonly identity: GenerationDispatchIdentity;
    readonly leaseExpiresAt: Date;
    readonly now: Date;
    readonly acknowledge: boolean;
  },
) {
  return db.$transaction(async (tx) => {
    const current = await tx.mainOutboxEvent.findUnique({
      where: { id: input.outboxId },
      select: { status: true, nextRunAt: true },
    });
    const ownsClaim = Boolean(
      current &&
      current.status === "dispatched" &&
      current.nextRunAt.getTime() === input.leaseExpiresAt.getTime(),
    );
    const snapshot = await generationDispatchAuthoritySnapshot(tx, input.identity);
    if (!snapshot.authorized) {
      if (current && ownsClaim) {
        await suppressGenerationDispatchOutbox(tx, {
          outboxId: input.outboxId,
          expectedStatus: current.status,
          expectedNextRunAt: current.nextRunAt,
          identity: input.identity,
          snapshot,
          occurredAt: input.now,
        });
      }
      return "revoked" as const;
    }
    if (!ownsClaim) return "lost_claim" as const;
    if (!input.acknowledge) return "authorized" as const;
    const acknowledged = await tx.mainOutboxEvent.updateMany({
      where: {
        id: input.outboxId,
        status: "dispatched",
        nextRunAt: input.leaseExpiresAt,
      },
      data: {
        status: "delivered",
        deliveredAt: input.now,
        lastError: Prisma.DbNull,
      },
    });
    return acknowledged.count === 1
      ? "acknowledged" as const
      : "lost_claim" as const;
  });
}

// SPEC: This is the only production boundary that may enqueue a GenerationAttempt.
// BullMQ's deterministic dedupe key closes the enqueue-before-Outbox-ACK crash
// window. Request/Attempt authority is checked under the Request lock before
// claim, immediately before enqueue, and again before ACK. Cancellation seals
// the Outbox under the same lock; a row enqueued in the narrow external-system
// window is removed by its exact Attempt key.
export async function dispatchGenerationAttemptOutbox(
  db: PrismaClient,
  input: {
    readonly limit?: number;
    readonly outboxIds?: readonly string[];
    readonly queue?: DispatchQueue;
    readonly now?: Date;
  } = {},
) {
  const now = input.now ?? new Date();
  const rows = await db.mainOutboxEvent.findMany({
    where: {
      eventType: {
        in: [...MAIN_OUTBOX_GENERATION_DISPATCH_EVENT_TYPES],
      },
      status: { in: ["pending", "dispatched"] },
      nextRunAt: { lte: now },
      ...(input.outboxIds ? { id: { in: [...input.outboxIds] } } : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: Math.min(100, Math.max(1, input.limit ?? 25)),
  });
  let delivered = 0;
  let failed = 0;
  for (const row of rows) {
    const leaseExpiresAt = new Date(now.getTime() + 60_000);
    const payload = jsonRecord(row.payload);
    let queueInput: EnqueueJobInput | null = null;
    let identity: GenerationDispatchIdentity | null = null;
    let enqueued = false;
    try {
      identity = generationDispatchIdentity(row);
      queueInput = queueInputFromOutboxPayload(payload);
    } catch (error) {
      await rejectMalformedGenerationDispatchOutbox(db, {
        row,
        occurredAt: now,
        error,
      });
      failed += 1;
      continue;
    }
    try {
      const claimed = await claimGenerationDispatchOutbox(db, {
        row,
        identity,
        leaseExpiresAt,
        now,
      });
      if (!claimed) continue;

      const authorizedBeforeEnqueue = await verifyClaimedGenerationDispatchOutbox(
        db,
        {
          outboxId: row.id,
          identity,
          leaseExpiresAt,
          now,
          acknowledge: false,
        },
      );
      if (authorizedBeforeEnqueue !== "authorized") continue;

      if (input.queue) {
        await input.queue.enqueue(queueInput);
      } else {
        await jobQueue.enqueue(queueInput);
      }
      enqueued = true;
      const verification = await verifyClaimedGenerationDispatchOutbox(db, {
        outboxId: row.id,
        identity,
        leaseExpiresAt,
        now,
        acknowledge: true,
      });
      if (verification === "acknowledged") {
        delivered += 1;
        continue;
      }
      if (verification === "revoked" && queueInput.dedupeKey) {
        if (input.queue) {
          await input.queue.removeByDedupeKey(
            queueInput.queue,
            queueInput.dedupeKey,
          );
        } else {
          await jobQueue.removeByDedupeKey(
            queueInput.queue,
            queueInput.dedupeKey,
          );
        }
      }
    } catch (error) {
      await db.mainOutboxEvent.updateMany({
        where: {
          id: row.id,
          status: "dispatched",
          nextRunAt: leaseExpiresAt,
        },
        data: {
          status: "pending",
          nextRunAt: new Date(now.getTime() + 30_000),
          lastError: toInputJson({
            message:
              error instanceof Error
                ? error.message
                : "Generation dispatch failed",
          }),
        },
      });
      if (enqueued && queueInput?.dedupeKey && identity) {
        const snapshot = await db.generationAttempt.findUnique({
          where: { id: identity.attemptId },
          select: { status: true },
        });
        if (snapshot?.status === "cancelled") {
          const removal = input.queue
            ? input.queue.removeByDedupeKey(
                queueInput.queue,
                queueInput.dedupeKey,
              )
            : jobQueue.removeByDedupeKey(
                queueInput.queue,
                queueInput.dedupeKey,
              );
          await removal.catch(() => false);
        }
      }
      failed += 1;
    }
  }
  return { examined: rows.length, delivered, failed };
}
