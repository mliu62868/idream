// SPEC: Chat service BullMQ wrapper. dedupeKey → deterministic jobId so
// at-least-once producers collapse to one job (idempotency). Long-running Worker
// runner for chat/worker; one-shot drain for tests.
// INVARIANTS: dedupe is by jobId; regenerate keys carry :attempt so they are NOT
// collapsed (PLAN §3).
import { Buffer } from "node:buffer";
import { Queue, Worker, type JobsOptions, type Processor } from "bullmq";
import type { RedisOptions } from "ioredis";
import { env } from "./env.js";

export interface EnqueueInput {
  queue: string;
  payload: unknown;
  dedupeKey?: string;
  maxAttempts?: number;
  nextRunAt?: Date;
  priority?: number;
}

const DEFAULT_BACKOFF_MS = 30_000;
const removeOnComplete = { age: 60 * 60 * 24, count: 10_000 };

export function redisOptions(): RedisOptions {
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

function dedupeJobId(key: string): string {
  return `dedupe_${Buffer.from(key, "utf8").toString("base64url")}`;
}

function enqueueOptions(input: EnqueueInput): JobsOptions {
  return {
    jobId: input.dedupeKey ? dedupeJobId(input.dedupeKey) : undefined,
    priority: input.priority,
    attempts: input.maxAttempts ?? 5,
    backoff: { type: "exponential", delay: DEFAULT_BACKOFF_MS },
    delay: input.nextRunAt ? Math.max(0, input.nextRunAt.getTime() - Date.now()) : undefined,
    removeOnComplete,
    removeOnFail: false,
  };
}

export interface ChatJob<T = unknown> {
  id: string;
  payload: T;
  attemptsMade: number;
  maxAttempts: number;
  dedupeKey?: string;
}

type JobData = { payload: unknown; dedupeKey?: string };

export async function enqueue(input: EnqueueInput): Promise<{ id: string }> {
  const queue = new Queue<JobData>(input.queue, {
    connection: redisOptions(),
    prefix: env.BULLMQ_PREFIX,
  });
  try {
    const job = await queue.add(
      input.queue,
      { payload: input.payload, dedupeKey: input.dedupeKey },
      enqueueOptions(input),
    );
    return { id: job.id ?? "" };
  } finally {
    await queue.close();
  }
}

/** Long-running worker (chat/worker). Returns the Worker so callers can close it. */
export function runWorker(
  queueName: string,
  handler: (job: ChatJob) => Promise<void>,
  opts: { concurrency?: number } = {},
): Worker<JobData> {
  const processor: Processor<JobData> = async (bull) => {
    await handler({
      id: bull.id ?? "",
      payload: bull.data.payload,
      attemptsMade: bull.attemptsMade,
      maxAttempts: bull.opts.attempts ?? 1,
      dedupeKey: bull.data.dedupeKey,
    });
  };
  return new Worker<JobData>(queueName, processor, {
    connection: redisOptions(),
    prefix: env.BULLMQ_PREFIX,
    concurrency: opts.concurrency ?? 4,
  });
}

/** One-shot drain (tests): process up to `max` jobs, then return count handled. */
export async function drainQueue(
  queueName: string,
  handler: (job: ChatJob) => Promise<void>,
  max = 50,
): Promise<number> {
  const worker = new Worker<JobData>(queueName, null, {
    autorun: false,
    concurrency: 1,
    connection: redisOptions(),
    prefix: env.BULLMQ_PREFIX,
  });
  let handled = 0;
  try {
    for (let i = 0; i < max; i += 1) {
      const token = `drain-${i}-${process.pid}`;
      const bull = await worker.getNextJob(token, { block: false });
      if (!bull) break;
      try {
        await handler({
          id: bull.id ?? "",
          payload: bull.data.payload,
          attemptsMade: bull.attemptsMade,
          maxAttempts: bull.opts.attempts ?? 1,
          dedupeKey: bull.data.dedupeKey,
        });
        await bull.moveToCompleted({ ok: true }, token, false);
        handled += 1;
      } catch (error) {
        await bull.moveToFailed(error instanceof Error ? error : new Error(String(error)), token, false);
      }
    }
  } finally {
    await worker.close();
  }
  return handled;
}

export async function obliterate(queueName: string): Promise<void> {
  const queue = new Queue(queueName, { connection: redisOptions(), prefix: env.BULLMQ_PREFIX });
  try {
    await queue.obliterate({ force: true });
  } finally {
    await queue.close();
  }
}
