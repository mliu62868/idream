// SPEC: gen/image process entry. Consumes ai.image.generate; for each job runs
// the pipeline (provider → blob → enqueue app.ai.finalize). Long-running with
// graceful shutdown: SIGTERM/SIGINT close the worker so in-flight jobs drain.
import { GEN_QUEUES } from "@idream/shared/contracts";
import { logger } from "./logger";
import { processImageGenerate } from "./pipeline";
import { enqueue, runWorker } from "./queue";

const worker = runWorker(GEN_QUEUES.imageGenerate, async (job) => {
  await processImageGenerate(job.payload, { enqueue });
});

worker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, err: err.message }, "image generate job failed");
});
worker.on("completed", (job) => {
  logger.info({ jobId: job.id }, "image generate job completed");
});

logger.info({ queue: GEN_QUEUES.imageGenerate }, "gen/image worker started");

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "gen/image shutting down");
  await worker.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
