// SPEC: gen/video process entry. Consumes ai.video.generate; for each job runs
// the pipeline (provider → blob terminal record → durable Main relay). Long-running with
// graceful shutdown: SIGTERM/SIGINT close the worker so in-flight jobs drain.
import { captureGenerationRuntimeFailure } from "./instrumentation";
import { GEN_QUEUES } from "@idream/shared/contracts";
import { env } from "./env";
import { logger } from "./logger";
import { processVideoGenerate } from "./pipeline";
import { assertProductionProviderReady, providers } from "./providers";
import { runWorker } from "./queue";
import { startGenerationSourceRecovery } from "./failed-source-recovery";
import { enqueueTerminalRecordRelay } from "./terminal-record";
import { recordTransportExecution } from "./transport-execution";
import { videoWorkerIdentity } from "./worker-identity";

// A mock video provider means this host runs no video worker: the topology omits
// it, and asserting production readiness at module load would THROW
// (APP_ENV=production + mock), crash-looping the process. Exit cleanly instead. With
// a real provider the readiness assertion below still gates a misconfigured deploy.
if (env.VIDEO_PROVIDER === "mock") {
  logger.info({ provider: env.VIDEO_PROVIDER }, "gen/video disabled (mock provider) — worker not started");
  process.exit(0);
}

assertProductionProviderReady("video");

const videoWorkerName = videoWorkerIdentity({
  appEnv: env.APP_ENV,
  pid: process.pid,
  runId: process.env.GEN_VIDEO_WORKER_RUN_ID,
  slot: process.env.NODE_APP_INSTANCE,
});

const sourceRecovery = startGenerationSourceRecovery({
  mode: "video",
  blob: providers.blob,
  onResult: (result) => {
    if (result.recovered > 0 || result.invalid.length > 0 || result.retryErrors.length > 0) {
      logger.warn(result, "video failed-source recovery scan completed");
    }
  },
  onError: (err) => {
    captureGenerationRuntimeFailure({
      boundary: "source-recovery",
      error: err,
      mode: "video",
    });
    logger.error({ err }, "video failed-source recovery scan failed");
  },
});

const worker = runWorker(
  GEN_QUEUES.videoGenerate,
  async (job) => {
    await processVideoGenerate(job.payload, {
      attemptsMade: job.attemptsMade,
      maxAttempts: job.maxAttempts,
      acknowledgeTerminalRecord: enqueueTerminalRecordRelay,
      recordTransportExecution,
    });
  },
  // One at a time: a second active render could only sit on the device lease for
  // ten minutes or more. Left in Bull's waiting list it stays out of the lease race,
  // so an image waits behind the running video and not behind the next one too.
  { workerName: videoWorkerName, concurrency: 1 },
);

worker.on("failed", (job, err) => {
  captureGenerationRuntimeFailure({
    boundary: "worker",
    error: err,
    jobId: job?.id ? String(job.id) : undefined,
    mode: "video",
  });
  logger.error({ jobId: job?.id, err: err.message }, "video generate job failed");
});
worker.on("completed", (job) => {
  logger.info({ jobId: job.id }, "video generate job completed");
});

logger.info({ queue: GEN_QUEUES.videoGenerate }, "gen/video worker started");

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "gen/video shutting down");
  await sourceRecovery.close();
  await worker.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
