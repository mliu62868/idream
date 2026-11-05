// SPEC: drains Main's two generation queues: terminal relays Gen wrote, and the
// finalizations ingest produces. Nothing here executes a generation; that belongs to
// packages/gen in every topology (ADR-13 §2.1).
import { MAIN_QUEUES } from "@idream/shared/contracts";
import { jobQueue } from "@/server/jobs/queue";
import type { QueueJob } from "@/server/jobs/queue";
import { consumeGenerationTerminalRelay } from "./generation-terminal-relay";
import { randomUUID } from "node:crypto";
import { processFinalize } from "./generation-finalize";

export const generationFinalizationQueueNames = [
  MAIN_QUEUES.generationTerminalIngest,
  MAIN_QUEUES.aiFinalize,
] as const;

export interface GenerationFinalizationDrainResult {
  workerId: string;
  claimed: Array<{
    id: string;
    queue: string;
    status: string;
    error?: string;
  }>;
  processed: number;
}

export async function drainGenerationFinalization(input: {
  limit?: number;
  workerId?: string;
  queues?: string[];
} = {}): Promise<GenerationFinalizationDrainResult> {
  const workerId = input.workerId ?? `generation-finalizer-${randomUUID()}`;
  const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
  const queues = input.queues ?? [...generationFinalizationQueueNames];
  const claimedSummary: GenerationFinalizationDrainResult["claimed"] = [];
  let processed = 0;

  for (let index = 0; index < limit; index += 1) {
    let claimed = false;

    for (const queue of queues) {
      const result = await jobQueue.processNext({
        queue,
        workerId,
        processor: processFinalizationJob,
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

async function processFinalizationJob(job: QueueJob) {
  if (job.queue === MAIN_QUEUES.generationTerminalIngest) {
    await consumeGenerationTerminalRelay(job.payload);
    return;
  }
  if (job.queue === MAIN_QUEUES.aiFinalize) {
    return processFinalize(job.payload);
  }

  throw new Error(`Main cannot execute generation queue: ${job.queue}`);
}
