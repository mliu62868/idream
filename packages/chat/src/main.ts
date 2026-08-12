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

const server = startWeb();
let worker: ReturnType<typeof startWorker> | null = null;
let warmupRetry: ReturnType<typeof setTimeout> | null = null;
let shuttingDown = false;

async function startRuntime(): Promise<void> {
  if (shuttingDown || worker) return;
  try {
    await warmRuntime();
    if (shuttingDown) return;
    worker = startWorker();
    logger.info(runtimeReadiness.snapshot(), "chat runtime ready");
  } catch (error) {
    captureChatRuntimeWarmupFailure(error);
    logger.error({ err: error }, "chat runtime warm-up failed; staying unready");
    if (!shuttingDown) {
      warmupRetry = setTimeout(() => void startRuntime(), 5_000);
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
  await Promise.all([
    worker?.close().catch((err) => logger.error({ err }, "worker close failed")),
    new Promise<void>((resolve) => server.close(() => resolve())),
  ]);
  await closeStreamPublisher().catch((err) => logger.error({ err }, "stream publisher close failed"));
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
