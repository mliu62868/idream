import { Buffer } from "node:buffer";
import { Job as BullJob, Queue, Worker, type JobsOptions } from "bullmq";
import type { RedisOptions } from "ioredis";
import type { Prisma } from "@prisma/client";
import { env } from "@/server/lib/env";

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

export interface ProcessNextJobResult {
  job: QueueJob | null;
  status: "completed" | "failed" | "empty";
  error?: string;
}

export interface JobQueue {
  enqueue(input: EnqueueJobInput): Promise<QueueJob>;
  processNext(input: {
    queue: string;
    workerId: string;
    processor: (job: QueueJob) => Promise<void>;
    idleTimeoutMs?: number;
  }): Promise<ProcessNextJobResult>;
  getByDedupeKey(queue: string, dedupeKey: string): Promise<QueueJobSnapshot | null>;
  removeByDedupePrefix(prefix: string, queues: string[]): Promise<number>;
  obliterate(queue: string): Promise<void>;
}

type BullJobData = {
  payload: Prisma.JsonValue;
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

function createQueue(queueName: string) {
  return new Queue<BullJobData>(queueName, {
    connection: redisOptions(),
    prefix: env.BULLMQ_PREFIX,
  });
}

function dedupeKeyToJobId(dedupeKey: string) {
  return `dedupe_${Buffer.from(dedupeKey, "utf8").toString("base64url")}`;
}

function enqueueOptions(input: EnqueueJobInput): JobsOptions {
  const delay = input.nextRunAt
    ? Math.max(0, input.nextRunAt.getTime() - Date.now())
    : undefined;
  return {
    jobId: input.dedupeKey ? dedupeKeyToJobId(input.dedupeKey) : undefined,
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
      },
    );

    const token = `${input.workerId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      const bullJob = await worker.getNextJob(token, { block: false });
      if (!bullJob) return { job: null, status: "empty" };

      const job = toQueueJob(input.queue, bullJob);
      try {
        await input.processor(job);
        await bullJob.moveToCompleted({ ok: true, workerId: input.workerId }, token, false);
        return { job, status: "completed" };
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        await bullJob.moveToFailed(normalized, token, false);
        return { job, status: "failed", error: normalized.message };
      }
    } finally {
      await worker.close();
    }
  }

  async getByDedupeKey(queueName: string, dedupeKey: string) {
    const queue = createQueue(queueName);
    try {
      const job = await queue.getJob(dedupeKeyToJobId(dedupeKey));
      if (!job) return null;
      return toQueueJobSnapshot(queueName, job, await job.getState());
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
          if (!job.data.dedupeKey?.startsWith(prefix)) continue;
          await job.remove();
          removed += 1;
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
