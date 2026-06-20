// SPEC: gen/video process entry. Consumes ai.video.generate; for each job runs
// the pipeline (provider → blob → enqueue app.ai.finalize). Long-running with
// graceful shutdown: SIGTERM/SIGINT close the worker so in-flight jobs drain.
import { GEN_QUEUES } from "@idream/shared/contracts";
import { logger } from "./logger";
import { processVideoGenerate } from "./pipeline";
import { enqueue, runWorker } from "./queue";

const worker = runWorker(GEN_QUEUES.videoGenerate, async (job) => {
  await processVideoGenerate(job.payload, { enqueue });
});

worker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, err: err.message }, "video generate job failed");
});
worker.on("completed", (job) => {
  logger.info({ jobId: job.id }, "video generate job completed");
});

logger.info({ queue: GEN_QUEUES.videoGenerate }, "gen/video worker started");

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "gen/video shutting down");
  await worker.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
