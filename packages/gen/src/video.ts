// SPEC: gen/video process entry. Consumes ai.video.generate; for each job runs
// the pipeline (provider → blob → enqueue app.ai.finalize). Long-running with
// graceful shutdown: SIGTERM/SIGINT close the worker so in-flight jobs drain.
import { GEN_QUEUES } from "@idream/shared/contracts";
import { env } from "./env";
import { logger } from "./logger";
import { processVideoGenerate } from "./pipeline";
import { assertProductionProviderReady } from "./providers";
import { enqueue, runWorker } from "./queue";

// Video generation is deferred (V1.1). In the intended deferred state the provider
// is mock and there is nothing to consume — and asserting production readiness at
// module load would THROW (APP_ENV=production + mock), crash-looping the process.
// Exit cleanly instead. When video is ENABLED (non-mock) the readiness assertion
// below still gates a misconfigured deploy before the worker starts.
if (env.VIDEO_PROVIDER === "mock") {
  logger.info({ provider: env.VIDEO_PROVIDER }, "gen/video disabled (mock provider) — worker not started");
  process.exit(0);
}

assertProductionProviderReady("video");

const worker = runWorker(GEN_QUEUES.videoGenerate, async (job) => {
  await processVideoGenerate(job.payload, {
    enqueue,
    attemptsMade: job.attemptsMade,
    maxAttempts: job.maxAttempts,
  });
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
