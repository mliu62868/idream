// SPEC: Slim BullMQ wrapper for the generation service:
//   - runWorker(queue, handler) → consume ai.*.generate
//   - enqueueDurable(queue, payload) -> hand immutable evidence to its owner
// INTENT: Ported from packages/main jobs/queue.ts but stripped of Prisma — gen
// has no DB and only produces the Main-owned terminal relay lifecycle.
import { Buffer } from "node:buffer";
import {
  type Job as BullJob,
  Queue,
  Worker,
  type JobsOptions,
} from "bullmq";
import type { RedisOptions } from "ioredis";
import { env } from "./env";

export type JsonPayload = Record<string, unknown>;

type BullJobData = {
  payload: JsonPayload;
  dedupeKey?: string;
  queue: string;
};

export type DurableEnqueueInput = {
  readonly queue: string;
  readonly payload: JsonPayload;
  readonly dedupeKey: string;
  readonly maxAttempts: number;
};

const RELAY_BACKOFF_MS = 1_000;
const removeOnComplete = { age: 60 * 60 * 24, count: 10_000 };

function redisOptions(): RedisOptions {
  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname,
    port: url.port ? Number.parseInt(url.port, 10) : 6379,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: url.pathname && url.pathname !== "/" ? Number.parseInt(url.pathname.slice(1), 10) : 0,
    tls: url.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

export function bullMqJobIdForDedupeKey(key: string): string {
  return `dedupe_${Buffer.from(key, "utf8").toString("base64url")}`;
}

function enqueueOptions(input: DurableEnqueueInput): JobsOptions {
  return {
    jobId: bullMqJobIdForDedupeKey(input.dedupeKey),
    attempts: input.maxAttempts,
    backoff: { type: "exponential", delay: RELAY_BACKOFF_MS },
    removeOnComplete,
    removeOnFail: false,
  };
}

// SPEC: Redis acceptance, not Main HTTP availability, completes Gen's
// provider job. The Main-owned consumer retries this row independently.
export async function enqueueDurable(
  input: DurableEnqueueInput,
): Promise<{ id: string }> {
  const queue = new Queue<BullJobData>(input.queue, {
    connection: redisOptions(),
    prefix: env.BULLMQ_PREFIX,
  });
  try {
    const job = await queue.add(
      input.queue,
      {
        queue: input.queue,
        payload: input.payload,
        dedupeKey: input.dedupeKey,
      },
      enqueueOptions(input),
    );
    // A retry after an ambiguous Redis response may find an existing row. If
    // that row previously exhausted its relay attempts, revive the exact row;
    // its immutable Attempt key still prevents duplicate terminal effects.
    if ((await job.getState()) === "failed") {
      await job.retry("failed");
    }
    return { id: job.id ?? "" };
  } finally {
    await queue.close();
  }
}

export interface QueueJob {
  id: string;
  queue: string;
  payload: JsonPayload;
  attemptsMade: number;
  maxAttempts: number;
  dedupeKey?: string;
}

export interface QueueJobSnapshot extends QueueJob {
  state: string;
  failedReason?: string;
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
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

function toQueueJobSnapshot(
  queueName: string,
  job: BullJob<BullJobData>,
  state: string,
): QueueJobSnapshot {
  return {
    id: job.id ?? "",
    queue: queueName,
    payload: job.data.payload,
    attemptsMade: job.attemptsMade,
    maxAttempts: job.opts.attempts ?? 1,
    dedupeKey: job.data.dedupeKey,
    state,
    failedReason: job.failedReason,
    timestamp: job.timestamp,
    processedOn: job.processedOn,
    finishedOn: job.finishedOn,
  };
}

export async function inspectFailed(
  queueName: string,
  options: { limit?: number; offset?: number } = {},
): Promise<QueueJobSnapshot[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 100));
  const offset = Math.max(0, options.offset ?? 0);
  const queue = new Queue<BullJobData>(queueName, {
    connection: redisOptions(),
    prefix: env.BULLMQ_PREFIX,
  });
  try {
    const jobs = await queue.getJobs(
      ["failed"],
      offset,
      offset + limit - 1,
      true,
    );
    return Promise.all(jobs.filter(Boolean).map(async (job) =>
      toQueueJobSnapshot(queueName, job, await job.getState())
    ));
  } finally {
    await queue.close();
  }
}

export async function isQueuePaused(queueName: string): Promise<boolean> {
  const queue = new Queue<BullJobData>(queueName, {
    connection: redisOptions(),
    prefix: env.BULLMQ_PREFIX,
  });
  try {
    return await queue.isPaused();
  } finally {
    await queue.close();
  }
}

export async function retryFailedByDedupeKey(input: {
  queue: string;
  dedupeKey: string;
  resetAttemptsMade?: boolean;
}): Promise<RetryFailedJobResult> {
  const queue = new Queue<BullJobData>(input.queue, {
    connection: redisOptions(),
    prefix: env.BULLMQ_PREFIX,
  });
  try {
    const job = await queue.getJob(bullMqJobIdForDedupeKey(input.dedupeKey));
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
    return {
      status: paused || (await queue.isPaused()) ? "retried_paused" : "retried",
      job: toQueueJobSnapshot(input.queue, job, await job.getState()),
    };
  } finally {
    await queue.close();
  }
}

/**
 * Long-running consumer for a single queue. Returns the BullMQ Worker so the
 * process entry can close it on SIGTERM/SIGINT (graceful shutdown).
 */
export function runWorker(
  queueName: string,
  handler: (job: QueueJob) => Promise<void>,
  options: { concurrency?: number } = {},
): Worker<BullJobData> {
  return new Worker<BullJobData>(
    queueName,
    async (bullJob: BullJob<BullJobData>) => {
      await handler({
        id: bullJob.id ?? "",
        queue: queueName,
        payload: bullJob.data.payload,
        attemptsMade: bullJob.attemptsMade,
        maxAttempts: bullJob.opts.attempts ?? 1,
        dedupeKey: bullJob.data.dedupeKey,
      });
    },
    {
      concurrency: options.concurrency ?? 2,
      connection: redisOptions(),
      prefix: env.BULLMQ_PREFIX,
    },
  );
}
