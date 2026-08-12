import { isRenderableMediaSource } from "@/lib/public-api-contracts";

export const CREATE_PREVIEW_CANDIDATE_COUNT = 4;
export const CREATE_PREVIEW_POLL_INTERVAL_MS = 1_200;
// Four production ComfyUI candidates currently take about six minutes when
// executed serially. Keep one batch bounded, while leaving enough room for
// ordinary queue variance instead of turning a healthy 90-second job into a
// client-side failure.
export const CREATE_PREVIEW_TOTAL_WAIT_MS = 12 * 60_000;

export type CreatePreviewCandidate = {
  previewJobId: string;
  assetId: string;
  url: string;
  isSynthetic: boolean;
};

export type CreatePreviewJobStatus = "queued" | "running" | "completed" | "failed";
export type CreatePreviewFailureReason =
  | "generation_failed"
  | "request_failed"
  | "timed_out";

export type CreatePreviewBatch = {
  phase: "running" | "failed" | "complete";
  currentCandidateNumber: number;
  activeRequestKey: string;
  activePreviewJobId: string;
  activeJobStatus: "queued" | "running" | null;
  candidates: CreatePreviewCandidate[];
  deadlineAt: number;
  failureReason: CreatePreviewFailureReason | null;
  errorMessage: string;
};

export type CreatePreviewJobSnapshot = {
  id: string;
  status: CreatePreviewJobStatus;
  asset: CreatePreviewCandidate | null;
  errorMessage?: string;
};

export type CreatePreviewFlowDependencies = {
  enqueue: (
    candidateNumber: number,
    requestKey: string,
    signal: AbortSignal,
  ) => Promise<{ id: string; status: "queued" | "running" }>;
  read: (
    previewJobId: string,
    signal: AbortSignal,
  ) => Promise<CreatePreviewJobSnapshot>;
  persist: (batch: CreatePreviewBatch) => void;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  isActive?: () => boolean;
  createRequestKey?: () => string;
  scheduleDeadline?: (
    onDeadline: () => void,
    milliseconds: number,
  ) => () => void;
};

class CreatePreviewFlowError extends Error {
  constructor(
    readonly reason: CreatePreviewFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "CreatePreviewFlowError";
  }
}

class CreatePreviewFlowCancelled extends Error {}

export function newCreatePreviewBatch(
  now = Date.now(),
  requestKey = createPreviewRequestKey(),
): CreatePreviewBatch {
  return {
    phase: "running",
    currentCandidateNumber: 1,
    activeRequestKey: requestKey,
    activePreviewJobId: "",
    activeJobStatus: null,
    candidates: [],
    deadlineAt: now + CREATE_PREVIEW_TOTAL_WAIT_MS,
    failureReason: null,
    errorMessage: "",
  };
}

export function retryCreatePreviewBatch(
  batch: CreatePreviewBatch,
  now = Date.now(),
  replacementRequestKey?: string,
): CreatePreviewBatch {
  return {
    ...batch,
    phase: "running",
    activeRequestKey:
      batch.failureReason === "generation_failed"
        ? (replacementRequestKey ?? createPreviewRequestKey())
        : batch.activeRequestKey,
    activeJobStatus: batch.activePreviewJobId
      ? (batch.activeJobStatus ?? "queued")
      : null,
    deadlineAt: now + CREATE_PREVIEW_TOTAL_WAIT_MS,
    failureReason: null,
    errorMessage: "",
  };
}

export async function continueCreatePreviewBatch(
  initial: CreatePreviewBatch,
  dependencies: CreatePreviewFlowDependencies,
): Promise<CreatePreviewBatch> {
  if (initial.phase !== "running") return initial;
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? defaultSleep;
  const isActive = dependencies.isActive ?? (() => true);
  const createRequestKey = dependencies.createRequestKey ?? createPreviewRequestKey;
  const scheduleDeadline =
    dependencies.scheduleDeadline ?? defaultScheduleDeadline;
  // Resuming an in-flight batch retains its original bound. Only an explicit
  // retry extends the deadline through retryCreatePreviewBatch().
  let batch = initial;
  dependencies.persist(batch);

  try {
    while (batch.currentCandidateNumber <= CREATE_PREVIEW_CANDIDATE_COUNT) {
      assertFlowActive(isActive);
      let previewJobId = batch.activePreviewJobId;
      if (!previewJobId) {
        const queued = await runBeforeBatchDeadline(
          batch,
          now,
          scheduleDeadline,
          (signal) => dependencies.enqueue(
            batch.currentCandidateNumber,
            batch.activeRequestKey,
            signal,
          ),
        );
        previewJobId = queued.id;
        if (!previewJobId) {
          throw new CreatePreviewFlowError(
            "request_failed",
            "Preview generation did not return a durable job.",
          );
        }
        batch = {
          ...batch,
          activePreviewJobId: previewJobId,
          activeJobStatus: queued.status,
        };
        // INVARIANT: persist the durable identity before the first poll. A
        // reload must resume this job instead of submitting a replacement.
        dependencies.persist(batch);
        assertFlowActive(isActive);
      }

      const candidate = await pollCreatePreviewJob(previewJobId, batch, {
        ...dependencies,
        now,
        sleep,
        isActive,
        scheduleDeadline,
        onStatus: (status) => {
          if (batch.activeJobStatus === status) return;
          batch = { ...batch, activeJobStatus: status };
          dependencies.persist(batch);
        },
      });
      assertFlowActive(isActive);
      const candidates = [
        ...batch.candidates.filter(
          (existing) => existing.previewJobId !== candidate.previewJobId,
        ),
        candidate,
      ];
      const complete = batch.currentCandidateNumber === CREATE_PREVIEW_CANDIDATE_COUNT;
      batch = {
        ...batch,
        phase: complete ? "complete" : "running",
        currentCandidateNumber: complete
          ? CREATE_PREVIEW_CANDIDATE_COUNT
          : batch.currentCandidateNumber + 1,
        activePreviewJobId: "",
        activeJobStatus: null,
        activeRequestKey: complete ? "" : createRequestKey(),
        candidates,
        failureReason: null,
        errorMessage: "",
      };
      dependencies.persist(batch);
      if (complete) return batch;
    }
    return batch;
  } catch (error) {
    if (error instanceof CreatePreviewFlowCancelled) return batch;
    const flowError =
      error instanceof CreatePreviewFlowError
        ? error
        : new CreatePreviewFlowError(
            "request_failed",
            error instanceof Error
              ? error.message
              : "Preview generation could not be checked. Try again.",
          );
    batch = {
      ...batch,
      phase: "failed",
      activePreviewJobId:
        flowError.reason === "generation_failed"
          ? ""
          : batch.activePreviewJobId,
      activeJobStatus: null,
      failureReason: flowError.reason,
      errorMessage: flowError.message,
    };
    dependencies.persist(batch);
    return batch;
  }
}

async function pollCreatePreviewJob(
  previewJobId: string,
  batch: CreatePreviewBatch,
  dependencies: CreatePreviewFlowDependencies & {
    now: () => number;
    sleep: (milliseconds: number) => Promise<void>;
    isActive: () => boolean;
    scheduleDeadline: NonNullable<CreatePreviewFlowDependencies["scheduleDeadline"]>;
    onStatus: (status: "queued" | "running") => void;
  },
) {
  while (true) {
    assertFlowActive(dependencies.isActive);
    const snapshot = await runBeforeBatchDeadline(
      batch,
      dependencies.now,
      dependencies.scheduleDeadline,
      (signal) => dependencies.read(previewJobId, signal),
    );
    assertFlowActive(dependencies.isActive);
    if (snapshot.id !== previewJobId) {
      throw new CreatePreviewFlowError(
        "request_failed",
        "Preview status did not match the active job. Try again.",
      );
    }
    if (snapshot.status === "completed") {
      if (!snapshot.asset?.assetId || !snapshot.asset.url) {
        throw new CreatePreviewFlowError(
          "generation_failed",
          "Preview completed without a usable image. Try again.",
        );
      }
      return { ...snapshot.asset, previewJobId };
    }
    if (snapshot.status === "failed") {
      throw new CreatePreviewFlowError(
        "generation_failed",
        snapshot.errorMessage || "Preview generation failed. Try again.",
      );
    }
    dependencies.onStatus(snapshot.status);
    const remaining = batch.deadlineAt - dependencies.now();
    if (remaining <= 0) throw previewTimedOutError();
    await dependencies.sleep(Math.min(CREATE_PREVIEW_POLL_INTERVAL_MS, remaining));
  }
}

async function runBeforeBatchDeadline<T>(
  batch: CreatePreviewBatch,
  now: () => number,
  scheduleDeadline: NonNullable<CreatePreviewFlowDependencies["scheduleDeadline"]>,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const remaining = batch.deadlineAt - now();
  if (remaining <= 0) throw previewTimedOutError();

  const controller = new AbortController();
  const operationPromise = operation(controller.signal);
  let cancelDeadline: () => void = () => undefined;
  const deadlinePromise = new Promise<never>((_resolve, reject) => {
    cancelDeadline = scheduleDeadline(() => {
      const timeout = previewTimedOutError();
      controller.abort(timeout);
      reject(timeout);
    }, remaining);
  });
  try {
    return await Promise.race([operationPromise, deadlinePromise]);
  } catch (error) {
    if (controller.signal.aborted) throw previewTimedOutError();
    throw error;
  } finally {
    cancelDeadline();
  }
}

function previewTimedOutError() {
  return new CreatePreviewFlowError(
    "timed_out",
    "Preview generation is taking longer than expected. Retry to keep checking the same job.",
  );
}

function assertFlowActive(isActive: () => boolean) {
  if (!isActive()) throw new CreatePreviewFlowCancelled();
}

export function parseCreatePreviewBatch(value: unknown): CreatePreviewBatch | null {
  if (!isRecord(value)) return null;
  if (value.phase !== "running" && value.phase !== "failed" && value.phase !== "complete") {
    return null;
  }
  if (
    typeof value.currentCandidateNumber !== "number" ||
    !Number.isInteger(value.currentCandidateNumber) ||
    value.currentCandidateNumber < 1 ||
    value.currentCandidateNumber > CREATE_PREVIEW_CANDIDATE_COUNT
  ) {
    return null;
  }
  if (typeof value.deadlineAt !== "number" || !Number.isFinite(value.deadlineAt)) {
    return null;
  }
  const candidates = Array.isArray(value.candidates)
    ? value.candidates.flatMap((candidate) => {
        const parsed = parseCandidate(candidate);
        return parsed ? [parsed] : [];
      })
    : [];
  if (candidates.length > CREATE_PREVIEW_CANDIDATE_COUNT) return null;
  const candidateJobIds = new Set(candidates.map((candidate) => candidate.previewJobId));
  if (candidateJobIds.size !== candidates.length) return null;
  const activeRequestKey = parseRequestKey(value.activeRequestKey);
  const activePreviewJobId = boundedString(value.activePreviewJobId, 200);
  const activeJobStatus =
    value.activeJobStatus === "queued" || value.activeJobStatus === "running"
      ? value.activeJobStatus
      : null;
  const failureReason =
    value.failureReason === "generation_failed" ||
    value.failureReason === "request_failed" ||
    value.failureReason === "timed_out"
      ? value.failureReason
      : null;
  if (activeJobStatus && !activePreviewJobId) return null;
  if (value.phase === "complete" ? Boolean(activeRequestKey) : activeRequestKey.length < 8) {
    return null;
  }
  if (activePreviewJobId && candidateJobIds.has(activePreviewJobId)) return null;
  if (
    value.phase === "complete"
      ? value.currentCandidateNumber !== CREATE_PREVIEW_CANDIDATE_COUNT ||
        candidates.length !== CREATE_PREVIEW_CANDIDATE_COUNT ||
        Boolean(activePreviewJobId) ||
        activeJobStatus !== null
      : candidates.length !== value.currentCandidateNumber - 1
  ) {
    return null;
  }
  if (value.phase === "failed" && !failureReason) return null;
  return {
    phase: value.phase,
    currentCandidateNumber: value.currentCandidateNumber,
    activeRequestKey,
    activePreviewJobId,
    activeJobStatus,
    candidates,
    deadlineAt: value.deadlineAt,
    failureReason,
    errorMessage: boundedString(value.errorMessage, 500),
  };
}

function parseCandidate(value: unknown): CreatePreviewCandidate | null {
  if (!isRecord(value)) return null;
  const previewJobId = boundedString(value.previewJobId, 200);
  const assetId = boundedString(value.assetId, 200);
  const url = boundedString(value.url, 4_000);
  if (!previewJobId || !assetId || !url || !isRenderableMediaSource(url)) return null;
  return {
    previewJobId,
    assetId,
    url,
    isSynthetic: value.isSynthetic === true,
  };
}

function boundedString(value: unknown, maximumLength: number) {
  return typeof value === "string" ? value.slice(0, maximumLength) : "";
}

function parseRequestKey(value: unknown) {
  if (typeof value !== "string" || value !== value.trim()) return "";
  return value.length >= 8 && value.length <= 160 ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultSleep(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

function defaultScheduleDeadline(onDeadline: () => void, milliseconds: number) {
  const timer = globalThis.setTimeout(onDeadline, milliseconds);
  return () => globalThis.clearTimeout(timer);
}

function createPreviewRequestKey() {
  return `create-preview:${crypto.randomUUID()}`;
}
