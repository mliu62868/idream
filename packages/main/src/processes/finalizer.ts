// SPEC: gen-finalizer owns Main-side finalization only. packages/gen is the
// sole image/video provider executor in every deployment topology.
import { randomUUID } from "node:crypto";
import {
  drainLocalAiPipeline,
  reconcileStaleGenerationJobs,
} from "@/server/ai/local-pipeline";
import { logger } from "@/server/lib/logger";
import { dispatchPendingGenerationManifests } from "@/server/ai/generation-manifest-ingest";

const BUSY_DELAY_MS = 50;
const IDLE_DELAY_MS = 1_000;
const RECONCILE_INTERVAL_MS = 60_000;
const FINALIZER_QUEUES = ["app.ai.finalize"] as const;

let running = true;
let reconciling = false;
let lastReconcileAt = 0;

export async function runFinalizerLoop(): Promise<void> {
  logger.info("gen-finalizer started");
  while (running) {
    const workerId = `finalizer-${randomUUID()}`;
    let processed = 0;
    try {
      const result = await drainLocalAiPipeline({
        limit: 25,
        workerId,
        queues: [...FINALIZER_QUEUES],
      });
      processed = result.processed;
    } catch (err) {
      logger.error({ err }, "finalizer drain failed");
    }
    await maybeReconcileStaleJobs();
    await dispatchPendingGenerationManifests().catch((err) => logger.error({ err }, "generation manifest dispatch failed"));
    await sleep(processed > 0 ? BUSY_DELAY_MS : IDLE_DELAY_MS);
  }
}

// SPEC: periodically recover orphaned queued/running generation jobs that no
// worker will ever finalize (e.g. a crash mid-generation). Throttled to once per
// RECONCILE_INTERVAL_MS and guarded so a slow pass can't overlap itself.
async function maybeReconcileStaleJobs(now = Date.now()): Promise<void> {
  if (reconciling || now - lastReconcileAt < RECONCILE_INTERVAL_MS) return;
  reconciling = true;
  lastReconcileAt = now;
  try {
    const result = await reconcileStaleGenerationJobs();
    if (result.enqueued > 0) {
      logger.info({ enqueued: result.enqueued }, "finalizer reconciled stale generation jobs");
    }
  } catch (err) {
    logger.error({ err }, "finalizer stale reconcile failed");
  } finally {
    reconciling = false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function stopFinalizerLoop(): void {
  running = false;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const shutdown = () => {
    logger.info("gen-finalizer shutting down");
    stopFinalizerLoop();
    setTimeout(() => process.exit(0), 200);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  void runFinalizerLoop();
}
