import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { jobQueue, type JobQueue } from "@/server/jobs/queue";
import { dispatchPendingGenerationTerminalRecords } from "./generation-terminal-record-ingest";
import {
  assessGenerationQueueDrainReadiness,
  GENERATION_CUTOVER_QUEUES,
} from "./generation-dispatch-cutover";

const DEFAULT_DRAIN_TIMEOUT_MS = 35 * 60 * 1_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

type CutoverQueue = Pick<
  JobQueue,
  "pause" | "resume" | "inspectPaused" | "inspectInFlight"
>;

type GenerationCutoverQueueControlOptions = {
  readonly db?: PrismaClient;
  readonly queue?: CutoverQueue;
  readonly dispatchPendingTerminalRecords?: () => Promise<number>;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
};

// INVARIANT: returning from this function means every generation queue is
// globally paused, no handler is active, and no terminal ACK remains between
// Postgres and the paused finalize queue. Every failure path remains fail-closed.
export async function pauseAndDrainGenerationCutoverQueues(
  options: GenerationCutoverQueueControlOptions = {},
) {
  const db = options.db ?? prisma;
  const queue = options.queue ?? jobQueue;
  const dispatchPending =
    options.dispatchPendingTerminalRecords ??
    (() => dispatchPendingGenerationTerminalRecords());
  const timeoutMs = options.timeoutMs ?? cutoverDrainTimeoutMs();
  const pollIntervalMs =
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const wait = options.sleep ?? sleep;
  const deadline = now() + timeoutMs;

  try {
    await queue.pause(GENERATION_CUTOVER_QUEUES);
    while (true) {
      const report = await assessGenerationQueueDrainReadiness(db, {
        queueInspector: queue,
        dispatchPendingTerminalRecords: dispatchPending,
      });
      if (
        !GENERATION_CUTOVER_QUEUES.every((queueName) =>
          report.queues.some(
            (snapshot) => snapshot.queue === queueName && snapshot.paused,
          )
        )
      ) {
        throw new Error(
          `Generation cutover queue pause verification failed: ${JSON.stringify(report.queues)}`,
        );
      }
      if (report.ok) return report;

      if (
        report.activeBullRows.length === 0 &&
        report.pendingTerminalOutboxes > 0
      ) {
        const dispatched = await dispatchPending();
        if (dispatched > 0) continue;
      }

      if (now() >= deadline) {
        throw new Error(
          `Generation cutover queue drain timed out after ${timeoutMs}ms: ${JSON.stringify(report)}`,
        );
      }
      await wait(pollIntervalMs);
    }
  } catch (error) {
    await bestEffortPause(queue);
    throw error;
  }
}

// INVARIANT: partial resume is not an allowed state. If resume or verification
// fails, best-effort rollback globally pauses the whole queue set again.
export async function resumeGenerationCutoverQueues(
  options: Pick<GenerationCutoverQueueControlOptions, "queue"> = {},
) {
  const queue = options.queue ?? jobQueue;
  try {
    await queue.resume(GENERATION_CUTOVER_QUEUES);
    const snapshots = await queue.inspectPaused(GENERATION_CUTOVER_QUEUES);
    const resumed = GENERATION_CUTOVER_QUEUES.every((queueName) =>
      snapshots.some(
        (snapshot) => snapshot.queue === queueName && !snapshot.paused,
      )
    );
    if (!resumed) {
      throw new Error(
        `Generation cutover queue resume verification failed: ${JSON.stringify(snapshots)}`,
      );
    }
    return snapshots;
  } catch (error) {
    await bestEffortPause(queue);
    throw error;
  }
}

async function bestEffortPause(queue: Pick<JobQueue, "pause">) {
  // Attempt every queue independently: one unavailable Redis keyspace/queue
  // must not prevent rollback from pausing the remaining modalities.
  await Promise.allSettled(
    GENERATION_CUTOVER_QUEUES.map((queueName) => queue.pause([queueName])),
  );
}

function cutoverDrainTimeoutMs() {
  const configured = Number.parseInt(
    process.env.GENERATION_CUTOVER_DRAIN_TIMEOUT_MS ?? "",
    10,
  );
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_DRAIN_TIMEOUT_MS;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
