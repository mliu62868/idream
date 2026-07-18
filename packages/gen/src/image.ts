// SPEC: gen/image process entry. Consumes ai.image.generate; for each job runs
// the pipeline (provider → blob → enqueue app.ai.finalize). Long-running with
// graceful shutdown: SIGTERM/SIGINT close the worker so in-flight jobs drain.
import { GEN_QUEUES } from "@idream/shared/contracts";
import { logger } from "./logger";
import {
  processCharacterPreviewGenerate,
  processImageGenerate,
} from "./pipeline";
import { assertProductionProviderReady } from "./providers";
import { enqueue, runWorker } from "./queue";
import { acknowledgeCompletionManifest } from "./completion-manifest";
import { recordTransportExecution } from "./transport-execution";

assertProductionProviderReady("image");

const imageWorker = runWorker(GEN_QUEUES.imageGenerate, async (job) => {
  await processImageGenerate(job.payload, {
    enqueue,
    attemptsMade: job.attemptsMade,
    maxAttempts: job.maxAttempts,
    acknowledgeCompletion: acknowledgeCompletionManifest,
    recordTransportExecution,
  });
});

const previewWorker = runWorker(GEN_QUEUES.characterPreview, async (job) => {
  await processCharacterPreviewGenerate(job.payload, {
    enqueue,
    attemptsMade: job.attemptsMade,
    maxAttempts: job.maxAttempts,
  });
});

imageWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, err: err.message }, "image generate job failed");
});
imageWorker.on("completed", (job) => {
  logger.info({ jobId: job.id }, "image generate job completed");
});
previewWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, err: err.message }, "character preview job failed");
});
previewWorker.on("completed", (job) => {
  logger.info({ jobId: job.id }, "character preview job completed");
});

logger.info(
  { queues: [GEN_QUEUES.imageGenerate, GEN_QUEUES.characterPreview] },
  "gen/image workers started",
);

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "gen/image shutting down");
  await Promise.all([imageWorker.close(), previewWorker.close()]);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
