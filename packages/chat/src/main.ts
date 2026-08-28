// SPEC: chat process entry (design §10/§12). ONE process = chat/web + chat/worker
// (instances:1 — writes local files). pm2 runs this as `chat`.
import { captureChatRuntimeWarmupFailure } from "./instrumentation.js";
import { startWeb } from "./web.js";
import { startWorker } from "./worker.js";
import { closeStreamPublisher } from "./stream.js";
import { logger } from "./logger.js";
import {
  runtimeReadiness,
  warmRuntime,
} from "./runtime-readiness.js";
import { cancelActiveCompanionInvocations } from "./companion-runtime.js";
import { isCompanionSidecarUnavailableError } from "./companion-sidecar-readiness.js";

const server = startWeb();
let worker: ReturnType<typeof startWorker> | null = null;
let warmupRetry: ReturnType<typeof setTimeout> | null = null;
let shuttingDown = false;
let sidecarUnavailableSince: number | null = null;
let lastWarmupErrorAt: number | null = null;
const WARMUP_RETRY_MS = 5_000;
const WARMUP_ERROR_INTERVAL_MS = 60_000;

function clearWarmupFailureState(): void {
  sidecarUnavailableSince = null;
  lastWarmupErrorAt = null;
}

function reportWarmupFailure(error: unknown, message: string): void {
  const now = Date.now();
  if (isCompanionSidecarUnavailableError(error)) {
    if (sidecarUnavailableSince === null) {
      sidecarUnavailableSince = now;
      logger.warn(
        { reason: error.message, retryInMs: WARMUP_RETRY_MS },
        "chat runtime dependency is not ready; waiting",
      );
      return;
    }
    if (now - sidecarUnavailableSince < WARMUP_ERROR_INTERVAL_MS) return;
  } else {
    sidecarUnavailableSince = null;
  }
  if (
    lastWarmupErrorAt !== null &&
    now - lastWarmupErrorAt < WARMUP_ERROR_INTERVAL_MS
  ) return;
  lastWarmupErrorAt = now;
  captureChatRuntimeWarmupFailure(error);
  logger.error({ err: error }, message);
}

runtimeReadiness.configureFullWarmupRecovery(async () => {
  if (shuttingDown) throw new Error("chat is shutting down");
  try {
    await warmRuntime();
    clearWarmupFailureState();
    logger.info(runtimeReadiness.snapshot(), "chat runtime recovered");
  } catch (error) {
    reportWarmupFailure(error, "chat runtime recovery warm-up failed");
    throw error;
  }
});

async function startRuntime(): Promise<void> {
  if (shuttingDown || worker) return;
  try {
    await warmRuntime();
    if (shuttingDown) return;
    clearWarmupFailureState();
    worker = startWorker();
    logger.info(runtimeReadiness.snapshot(), "chat runtime ready");
  } catch (error) {
    reportWarmupFailure(error, "chat runtime warm-up failed; staying unready");
    if (!shuttingDown) {
      warmupRetry = setTimeout(() => void startRuntime(), WARMUP_RETRY_MS);
      warmupRetry.unref();
    }
  }
}

void startRuntime();

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  runtimeReadiness.stopAccepting();
  if (warmupRetry) clearTimeout(warmupRetry);
  logger.info({ signal }, "chat shutting down");
  await cancelActiveCompanionInvocations("shutdown");
  await Promise.all([
    worker?.close().catch((err) => logger.error({ err }, "worker close failed")),
    server.stop(true),
  ]);
  await closeStreamPublisher().catch((err) => logger.error({ err }, "stream publisher close failed"));
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
