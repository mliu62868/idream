import { Job as BullJob, Queue, Worker, type JobsOptions } from "bullmq";
import type { RedisOptions } from "ioredis";
import type { Prisma } from "@prisma/client";
import { bullMqJobIdForDedupeKey } from "@idream/shared/contracts";
import { redisConnectionOptions } from "@idream/shared/env";
import { env } from "@/server/lib/env";

// INTENT: re-exported so existing importers keep their "@/server/jobs/queue"
// entry point. Gen enqueues onto these same queues, so the derivation itself
// lives in shared — two copies that drift stop deduping and double-invoke.
export { bullMqJobIdForDedupeKey };

export interface EnqueueJobInput {
  queue: string;
  payload: Prisma.InputJsonValue;
  priority?: number;
  maxAttempts?: number;
  dedupeKey?: string;
  nextRunAt?: Date;
}

export interface QueueJob {
  id: string;
  queue: string;
  payload: Prisma.JsonValue;
  attemptsMade: number;
  maxAttempts: number;
  dedupeKey?: string;
  priority?: number;
}

export interface QueueJobSnapshot extends QueueJob {
  state: string;
  failedReason?: string;
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
}

export interface QueuePauseSnapshot {
  queue: string;
  paused: boolean;
}

export interface ProcessNextJobResult {
  job: QueueJob | null;
  status: "completed" | "failed" | "empty";
  error?: string;
}

export type RetryFailedJobResult = {
  readonly status:
    | "retried"
    | "retried_paused"
    | "queue_paused"
    | "not_found"
    | "not_failed"
    | "identity_mismatch";
  readonly job: QueueJobSnapshot | null;
};

export interface JobQueue {
  enqueue(input: EnqueueJobInput): Promise<QueueJob>;
  processNext(input: {
    queue: string;
    workerId: string;
    processor: (job: QueueJob) => Promise<void>;
    idleTimeoutMs?: number;
  }): Promise<ProcessNextJobResult>;
  /**
   * Read-only deployment inspection. It never claims, retries, removes, or
   * changes a Bull row and intentionally excludes terminal history rows.
   */
  inspectInFlight(queues: readonly string[]): Promise<QueueJobSnapshot[]>;
  /** Read-only terminal failure inspection; never retries or removes rows. */
  inspectFailed(
    queues: readonly string[],
    options?: { limit?: number; offset?: number },
  ): Promise<QueueJobSnapshot[]>;
  /** Retry only the exact deterministic failed job, optionally resetting budget. */
  retryFailedByDedupeKey(input: {
    queue: string;
    dedupeKey: string;
    resetAttemptsMade?: boolean;
  }): Promise<RetryFailedJobResult>;
  pause(queues: readonly string[]): Promise<void>;
  resume(queues: readonly string[]): Promise<void>;
  inspectPaused(queues: readonly string[]): Promise<QueuePauseSnapshot[]>;
  getByDedupeKey(queue: string, dedupeKey: string): Promise<QueueJobSnapshot | null>;
  removeByDedupeKey(queue: string, dedupeKey: string): Promise<boolean>;
  removeByDedupePrefix(prefix: string, queues: string[]): Promise<number>;
  obliterate(queue: string): Promise<void>;
}

type BullMqJobQueueOptions = {
  readonly workerLockDurationMs?: number;
  readonly workerStalledIntervalMs?: number;
  readonly idlePollIntervalMs?: number;
};

type BullJobData = {
  payload: Prisma.JsonValue;
  dedupeKey?: string;
  queue: string;
};

const defaultBackoffDelayMs = 30_000;
const removeOnComplete = { age: 60 * 60 * 24, count: 10_000 };

function redisOptions(): RedisOptions {
  return redisConnectionOptions(env.REDIS_URL);
}

function createQueue(queueName: string) {
  return new Queue<BullJobData>(queueName, {
    connection: redisOptions(),
    prefix: env.BULLMQ_PREFIX,
  });
}

function enqueueOptions(input: EnqueueJobInput): JobsOptions {
  const delay = input.nextRunAt
    ? Math.max(0, input.nextRunAt.getTime() - Date.now())
    : undefined;
  return {
    jobId: input.dedupeKey
      ? bullMqJobIdForDedupeKey(input.dedupeKey)
      : undefined,
    priority: input.priority,
    attempts: input.maxAttempts ?? 5,
    backoff: { type: "exponential", delay: defaultBackoffDelayMs },
    delay,
    removeOnComplete,
    removeOnFail: false,
  };
}

function toQueueJob(queueName: string, job: BullJob<BullJobData>): QueueJob {
  return {
    id: job.id ?? "",
    queue: queueName,
    payload: job.data.payload,
    attemptsMade: job.attemptsMade,
    maxAttempts: job.opts.attempts ?? 1,
    dedupeKey: job.data.dedupeKey,
    priority: job.opts.priority,
  };
}

function toQueueJobSnapshot(
  queueName: string,
  job: BullJob<BullJobData>,
  state: string,
): QueueJobSnapshot {
  return {
    ...toQueueJob(queueName, job),
    state,
    failedReason: job.failedReason,
    timestamp: job.timestamp,
    processedOn: job.processedOn,
    finishedOn: job.finishedOn,
  };
}

export class BullMqJobQueue implements JobQueue {
  readonly #workerLockDurationMs: number;
  readonly #workerStalledIntervalMs: number;
  readonly #idlePollIntervalMs: number;

  constructor(options: BullMqJobQueueOptions = {}) {
    this.#workerLockDurationMs = positiveDuration(
      options.workerLockDurationMs,
      30_000,
    );
    this.#workerStalledIntervalMs = positiveDuration(
      options.workerStalledIntervalMs,
      30_000,
    );
    this.#idlePollIntervalMs = positiveDuration(
      options.idlePollIntervalMs,
      25,
    );
  }

  async enqueue(input: EnqueueJobInput) {
    const queue = createQueue(input.queue);
    try {
      const job = await queue.add(
        input.queue,
        {
          payload: input.payload as Prisma.JsonValue,
          dedupeKey: input.dedupeKey,
          queue: input.queue,
        },
        enqueueOptions(input),
      );
      return toQueueJob(input.queue, job);
    } finally {
      await queue.close();
    }
  }

  async processNext(input: {
    queue: string;
    workerId: string;
    processor: (job: QueueJob) => Promise<void>;
    idleTimeoutMs?: number;
  }): Promise<ProcessNextJobResult> {
    const worker = new Worker<BullJobData>(
      input.queue,
      null,
      {
        autorun: false,
        concurrency: 1,
        connection: redisOptions(),
        prefix: env.BULLMQ_PREFIX,
        lockDuration: this.#workerLockDurationMs,
        lockRenewTime: Math.max(1, Math.floor(this.#workerLockDurationMs / 2)),
        stalledInterval: this.#workerStalledIntervalMs,
      },
    );

    const token = `${input.workerId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let workerError: Error | null = null;
    worker.on("error", (error) => {
      workerError ??= error;
    });
    try {
      // Manual getNextJob does not start BullMQ's stalled checker or lock
      // manager. Start stalled recovery explicitly, then renew the exact manual
      // token while the application processor owns the job.
      await worker.startStalledCheckTimer();
      const deadline = Date.now() + Math.max(0, input.idleTimeoutMs ?? 0);
      let bullJob: BullJob<BullJobData> | undefined;
      do {
        bullJob = await worker.getNextJob(token, { block: false });
        if (bullJob || Date.now() >= deadline) break;
        if (workerError) throw workerError;
        await delay(
          Math.min(this.#idlePollIntervalMs, Math.max(1, deadline - Date.now())),
        );
      } while (Date.now() < deadline);
      if (!bullJob) return { job: null, status: "empty" };

      const job = toQueueJob(input.queue, bullJob);
      const renewal = renewManualJobLock(
        bullJob,
        token,
        this.#workerLockDurationMs,
      );
      let processorError: Error | null = null;
      try {
        await input.processor(job);
      } catch (error) {
        processorError = normalizeError(error);
      } finally {
        await renewal.stop();
      }
      const failure = processorError ?? renewal.error();
      if (failure) {
        await bullJob.moveToFailed(failure, token, false);
        return { job, status: "failed", error: failure.message };
      }
      await bullJob.moveToCompleted(
        { ok: true, workerId: input.workerId },
        token,
        false,
      );
      return { job, status: "completed" };
    } finally {
      await worker.close();
    }
  }

  async inspectInFlight(queueNames: readonly string[]) {
    const snapshots: QueueJobSnapshot[] = [];
    for (const queueName of queueNames) {
      const queue = createQueue(queueName);
      try {
        const jobs = await queue.getJobs(
          ["waiting", "prioritized", "delayed", "active", "paused", "waiting-children"],
          0,
          -1,
          true,
        );
        for (const job of jobs) {
          if (!job) continue;
          snapshots.push(
            toQueueJobSnapshot(queueName, job, await job.getState()),
          );
        }
      } finally {
        await queue.close();
      }
    }
    return snapshots;
  }

  async inspectFailed(
    queueNames: readonly string[],
    options: { limit?: number; offset?: number } = {},
  ) {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 1_000));
    let remainingOffset = Math.max(0, options.offset ?? 0);
    const snapshots: QueueJobSnapshot[] = [];
    for (const queueName of queueNames) {
      if (snapshots.length >= limit) break;
      const queue = createQueue(queueName);
      try {
        const failedCount = await queue.getFailedCount();
        if (remainingOffset >= failedCount) {
          remainingOffset -= failedCount;
          continue;
        }
        const start = remainingOffset;
        remainingOffset = 0;
        const jobs = await queue.getJobs(
          ["failed"],
          start,
          start + limit - snapshots.length - 1,
          true,
        );
        for (const job of jobs) {
          if (!job) continue;
          snapshots.push(
            toQueueJobSnapshot(queueName, job, await job.getState()),
          );
        }
      } finally {
        await queue.close();
      }
    }
    return snapshots;
  }

  async retryFailedByDedupeKey(input: {
    queue: string;
    dedupeKey: string;
    resetAttemptsMade?: boolean;
  }): Promise<RetryFailedJobResult> {
    const queue = createQueue(input.queue);
    try {
      const job = await queue.getJob(
        bullMqJobIdForDedupeKey(input.dedupeKey),
      );
      if (!job) return { status: "not_found", job: null };
      const state = await job.getState();
      if (job.data.dedupeKey !== input.dedupeKey) {
        return {
          status: "identity_mismatch",
          job: toQueueJobSnapshot(input.queue, job, state),
        };
      }
      if (state !== "failed") {
        return {
          status: "not_failed",
          job: toQueueJobSnapshot(input.queue, job, state),
        };
      }
      const paused = await queue.isPaused();
      await job.retry("failed", {
        resetAttemptsMade: input.resetAttemptsMade ?? false,
      });
      const retriedState = await job.getState();
      return {
        // BullMQ jobs in a paused queue may report "waiting". Preserve the
        // queue-level fact so callers do not claim provider work was resumed.
        status: paused || (await queue.isPaused())
          ? "retried_paused"
          : "retried",
        job: toQueueJobSnapshot(input.queue, job, retriedState),
      };
    } finally {
      await queue.close();
    }
  }

  async pause(queueNames: readonly string[]) {
    for (const queueName of queueNames) {
      const queue = createQueue(queueName);
      try {
        await queue.pause();
      } finally {
        await queue.close();
      }
    }
  }

  async resume(queueNames: readonly string[]) {
    for (const queueName of queueNames) {
      const queue = createQueue(queueName);
      try {
        await queue.resume();
      } finally {
        await queue.close();
      }
    }
  }

  async inspectPaused(queueNames: readonly string[]) {
    const snapshots: QueuePauseSnapshot[] = [];
    for (const queueName of queueNames) {
      const queue = createQueue(queueName);
      try {
        snapshots.push({ queue: queueName, paused: await queue.isPaused() });
      } finally {
        await queue.close();
      }
    }
    return snapshots;
  }

  async getByDedupeKey(queueName: string, dedupeKey: string) {
    const queue = createQueue(queueName);
    try {
      const job = await queue.getJob(bullMqJobIdForDedupeKey(dedupeKey));
      if (!job) return null;
      return toQueueJobSnapshot(queueName, job, await job.getState());
    } finally {
      await queue.close();
    }
  }

  async removeByDedupeKey(queueName: string, dedupeKey: string) {
    const queue = createQueue(queueName);
    try {
      const job = await queue.getJob(bullMqJobIdForDedupeKey(dedupeKey));
      if (!job) return false;
      try {
        await job.remove();
        return true;
      } catch (error) {
        const state = await job.getState().catch(() => "unknown");
        if (state === "active") return false;
        throw error;
      }
    } finally {
      await queue.close();
    }
  }

  async removeByDedupePrefix(prefix: string, queues: string[]) {
    let removed = 0;
    for (const queueName of queues) {
      const queue = createQueue(queueName);
      try {
        const jobs = await queue.getJobs(
          ["waiting", "prioritized", "delayed", "active", "completed", "failed", "paused"],
          0,
          -1,
          true,
        );
        for (const job of jobs) {
          if (!job?.data?.dedupeKey?.startsWith(prefix)) continue;
          try {
            await job.remove();
            removed += 1;
          } catch (error) {
            const state = await job.getState().catch(() => "unknown");
            if (state === "active") continue;
            throw error;
          }
        }
      } finally {
        await queue.close();
      }
    }
    return removed;
  }

  async obliterate(queueName: string) {
    const queue = createQueue(queueName);
    try {
      await queue.obliterate({ force: true });
    } finally {
      await queue.close();
    }
  }
}

export const jobQueue: JobQueue = new BullMqJobQueue();

function positiveDuration(value: number | undefined, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function renewManualJobLock(
  job: BullJob<BullJobData>,
  token: string,
  lockDurationMs: number,
) {
  const intervalMs = Math.max(1, Math.floor(lockDurationMs / 2));
  let stopped = false;
  let renewalError: Error | null = null;
  let inFlight: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = job.extendLock(token, lockDurationMs)
      .then((renewed) => {
        if (renewed !== 1) {
          renewalError ??= new Error(
            `BullMQ lock renewal lost ownership of job ${job.id ?? "unknown"}`,
          );
        }
      })
      .catch((error) => {
        renewalError ??= normalizeError(error);
      })
      .finally(() => {
        inFlight = null;
      });
  }, intervalMs);
  timer.unref?.();
  return {
    error: () => renewalError,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
