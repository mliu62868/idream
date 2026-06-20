// SPEC: Slim BullMQ wrapper for the generation service. Two jobs only:
//   - enqueue(queue, payload, {dedupeKey, maxAttempts})  → produce app.ai.finalize
//   - runWorker(queue, handler)                          → consume ai.*.generate
// INTENT: Ported from packages/main jobs/queue.ts but stripped of Prisma — gen
// has no DB, payloads are plain JSON. dedupeKey → deterministic jobId so
// at-least-once delivery of finalize collapses to exactly-once.
import { Buffer } from "node:buffer";
import { type Job as BullJob, type JobsOptions, Queue, Worker } from "bullmq";
import type { RedisOptions } from "ioredis";
import { env } from "./env";

export type JsonPayload = Record<string, unknown>;

export interface EnqueueInput {
  queue: string;
  payload: JsonPayload;
  dedupeKey?: string;
  maxAttempts?: number;
  priority?: number;
}

/** Inject-able enqueue signature — pipeline depends on this, not on BullMQ. */
export type EnqueueFn = (input: EnqueueInput) => Promise<void>;

type BullJobData = {
  payload: JsonPayload;
  dedupeKey?: string;
  queue: string;
};

const defaultBackoffDelayMs = 30_000;
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

function dedupeKeyToJobId(dedupeKey: string): string {
  return `dedupe_${Buffer.from(dedupeKey, "utf8").toString("base64url")}`;
}

function enqueueOptions(input: EnqueueInput): JobsOptions {
  return {
    jobId: input.dedupeKey ? dedupeKeyToJobId(input.dedupeKey) : undefined,
    priority: input.priority,
    attempts: input.maxAttempts ?? 5,
    backoff: { type: "exponential", delay: defaultBackoffDelayMs },
    removeOnComplete,
    removeOnFail: false,
  };
}

/** Real BullMQ enqueue — opens a short-lived Queue, adds the job, closes. */
export const enqueue: EnqueueFn = async (input) => {
  const queue = new Queue<BullJobData>(input.queue, {
    connection: redisOptions(),
    prefix: env.BULLMQ_PREFIX,
  });
  try {
    await queue.add(
      input.queue,
      { payload: input.payload, dedupeKey: input.dedupeKey, queue: input.queue },
      enqueueOptions(input),
    );
  } finally {
    await queue.close();
  }
};

export interface QueueJob {
  payload: JsonPayload;
  attemptsMade: number;
  maxAttempts: number;
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
        payload: bullJob.data.payload,
        attemptsMade: bullJob.attemptsMade,
        maxAttempts: bullJob.opts.attempts ?? 1,
      });
    },
    {
      concurrency: options.concurrency ?? 2,
      connection: redisOptions(),
      prefix: env.BULLMQ_PREFIX,
    },
  );
}
