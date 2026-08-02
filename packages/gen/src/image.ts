// SPEC: gen/image process entry. Consumes ai.image.generate; for each job runs
// the pipeline (provider → blob terminal record → durable Main relay). Long-running with
// graceful shutdown: SIGTERM/SIGINT close the worker so in-flight jobs drain.
import { GEN_QUEUES } from "@idream/shared/contracts";
import { logger } from "./logger";
import { processImageGenerate } from "./pipeline";
import { assertProductionProviderReady, providers } from "./providers";
import { runWorker } from "./queue";
import { startGenerationSourceRecovery } from "./failed-source-recovery";
import { enqueueTerminalRecordRelay } from "./terminal-record";
import { recordTransportExecution } from "./transport-execution";

assertProductionProviderReady("image");

const sourceRecovery = startGenerationSourceRecovery({
  mode: "image",
  blob: providers.blob,
  onResult: (result) => {
    if (result.recovered > 0 || result.invalid.length > 0 || result.retryErrors.length > 0) {
      logger.warn(result, "image failed-source recovery scan completed");
    }
  },
  onError: (err) => logger.error({ err }, "image failed-source recovery scan failed"),
});

const imageWorker = runWorker(GEN_QUEUES.imageGenerate, async (job) => {
  await processImageGenerate(job.payload, {
    attemptsMade: job.attemptsMade,
    maxAttempts: job.maxAttempts,
    acknowledgeTerminalRecord: enqueueTerminalRecordRelay,
    recordTransportExecution,
  });
});

imageWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, err: err.message }, "image generate job failed");
});
imageWorker.on("completed", (job) => {
  logger.info({ jobId: job.id }, "image generate job completed");
});
logger.info(
  { queues: [GEN_QUEUES.imageGenerate] },
  "gen/image workers started",
);

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "gen/image shutting down");
  await sourceRecovery.close();
  await imageWorker.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
