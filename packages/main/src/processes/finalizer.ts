// SPEC: gen-finalizer (design §10). Long-running drain of the main-side AI
// queues. Current main-web enqueue writes the DB-backed local queue, so this
// process drains generation plus finalization by default. When a deployment
// moves image/video generation to a separate queue worker, set
// GEN_FINALIZER_QUEUES=app.ai.finalize.
import { randomUUID } from "node:crypto";
import {
  drainLocalAiPipeline,
  localAiQueueNames,
  reconcileStaleGenerationJobs,
} from "@/server/ai/local-pipeline";
import { logger } from "@/server/lib/logger";

const BUSY_DELAY_MS = 50;
const IDLE_DELAY_MS = 1_000;
const RECONCILE_INTERVAL_MS = 60_000;
const DEFAULT_FINALIZER_QUEUES = [...localAiQueueNames];

let running = true;
let reconciling = false;
let lastReconcileAt = 0;

export async function runFinalizerLoop(): Promise<void> {
  logger.info("gen-finalizer started");
  const queues = finalizerQueues();
  while (running) {
    const workerId = `finalizer-${randomUUID()}`;
    let processed = 0;
    try {
      const result = await drainLocalAiPipeline({ limit: 25, workerId, queues });
      processed = result.processed;
    } catch (err) {
      logger.error({ err }, "finalizer drain failed");
    }
    await maybeReconcileStaleJobs();
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

function finalizerQueues(): string[] {
  const configured =
    process.env.GEN_FINALIZER_QUEUES ?? process.env.LOCAL_AI_DRAIN_QUEUES;
  if (!configured) return [...DEFAULT_FINALIZER_QUEUES];
  return configured
    .split(",")
    .map((queue) => queue.trim())
    .filter(Boolean);
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
