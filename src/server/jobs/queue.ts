import type { Job, Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";

export interface EnqueueJobInput {
  queue: string;
  payload: Prisma.InputJsonValue;
  priority?: number;
  maxAttempts?: number;
  dedupeKey?: string;
  nextRunAt?: Date;
}

export interface JobQueue {
  enqueue(input: EnqueueJobInput): Promise<Job>;
  claim(input: { limit: number; workerId: string; queues?: string[] }): Promise<Job[]>;
  complete(jobId: string): Promise<Job>;
  fail(jobId: string, error: Error | string): Promise<Job>;
}

function backoffDate(attempts: number) {
  const delaySeconds = Math.min(60 * 30, 2 ** Math.max(0, attempts) * 10);
  return new Date(Date.now() + delaySeconds * 1_000);
}

export class DbJobQueue implements JobQueue {
  async enqueue(input: EnqueueJobInput) {
    const data = {
      queue: input.queue,
      payload: input.payload,
      priority: input.priority ?? 5,
      maxAttempts: input.maxAttempts ?? 5,
      nextRunAt: input.nextRunAt ?? new Date(),
    };

    if (input.dedupeKey) {
      return prisma.job.upsert({
        where: { dedupeKey: input.dedupeKey },
        update: data,
        create: {
          ...data,
          dedupeKey: input.dedupeKey,
        },
      });
    }

    return prisma.job.create({ data });
  }

  async claim(input: { limit: number; workerId: string; queues?: string[] }) {
    const limit = Math.max(1, Math.min(input.limit, 100));
    const now = new Date();

    if (env.DB_PROVIDER === "postgresql") {
      return this.claimPostgres({ ...input, limit, now });
    }

    return this.claimSqlite({ ...input, limit, now });
  }

  async complete(jobId: string) {
    return prisma.job.update({
      where: { id: jobId },
      data: {
        status: "completed",
        lockedBy: null,
        lockedAt: null,
        completedAt: new Date(),
      },
    });
  }

  async fail(jobId: string, error: Error | string) {
    const message = typeof error === "string" ? error : error.message;
    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    const attempts = job.attempts + 1;
    const dead = attempts >= job.maxAttempts;

    return prisma.job.update({
      where: { id: jobId },
      data: {
        status: dead ? "dead" : "failed",
        attempts,
        lockedBy: null,
        lockedAt: null,
        nextRunAt: dead ? job.nextRunAt : backoffDate(attempts),
        lastError: message.slice(0, 2_000),
      },
    });
  }

  private async claimSqlite(input: {
    limit: number;
    workerId: string;
    queues?: string[];
    now: Date;
  }) {
    return prisma.$transaction(async (tx) => {
      const jobs = await tx.job.findMany({
        where: {
          status: { in: ["queued", "failed"] },
          nextRunAt: { lte: input.now },
          queue: input.queues ? { in: input.queues } : undefined,
        },
        orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
        take: input.limit,
      });

      if (jobs.length === 0) return [];

      const ids = jobs.map((job) => job.id);

      await tx.job.updateMany({
        where: {
          id: { in: ids },
          status: { in: ["queued", "failed"] },
        },
        data: {
          status: "running",
          lockedBy: input.workerId,
          lockedAt: input.now,
        },
      });

      return tx.job.findMany({
        where: { id: { in: ids }, lockedBy: input.workerId },
        orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
      });
    });
  }

  private async claimPostgres(input: {
    limit: number;
    workerId: string;
    queues?: string[];
    now: Date;
  }) {
    const rows =
      input.queues && input.queues.length > 0
        ? await prisma.$queryRaw<Array<{ id: string }>>`
            WITH claimed AS (
              SELECT id
              FROM jobs
              WHERE status IN ('queued', 'failed')
                AND next_run_at <= ${input.now}
                AND queue = ANY(${input.queues})
              ORDER BY priority ASC, created_at ASC
              LIMIT ${input.limit}
              FOR UPDATE SKIP LOCKED
            )
            UPDATE jobs
            SET status = 'running',
                locked_by = ${input.workerId},
                locked_at = ${input.now}
            WHERE id IN (SELECT id FROM claimed)
            RETURNING id
          `
        : await prisma.$queryRaw<Array<{ id: string }>>`
            WITH claimed AS (
              SELECT id
              FROM jobs
              WHERE status IN ('queued', 'failed')
                AND next_run_at <= ${input.now}
              ORDER BY priority ASC, created_at ASC
              LIMIT ${input.limit}
              FOR UPDATE SKIP LOCKED
            )
            UPDATE jobs
            SET status = 'running',
                locked_by = ${input.workerId},
                locked_at = ${input.now}
            WHERE id IN (SELECT id FROM claimed)
            RETURNING id
          `;

    const ids = rows.map((row) => row.id);
    if (ids.length === 0) return [];

    return prisma.job.findMany({
      where: { id: { in: ids } },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    });
  }
}

export const jobQueue: JobQueue = new DbJobQueue();
