// SPEC: gen-finalizer owns Main-side terminal ingest and finalization.
// packages/gen is the sole image/video provider executor in every topology.
import { randomUUID } from "node:crypto";
import { MAIN_QUEUES } from "@idream/shared/contracts";
import {
  drainLocalAiPipeline,
  reconcileStaleGenerationJobs,
} from "@/server/ai/local-pipeline";
import { logger } from "@/server/lib/logger";
import { dispatchPendingGenerationTerminalRecords } from "@/server/ai/generation-terminal-record-ingest";
import { redriveFailedGenerationTerminalRelays } from "@/server/ai/generation-terminal-relay";
import { scanDueUnknownGenerationReviews } from "@/server/modules/admin-v2/jobs/unknown-review-reminder";

const BUSY_DELAY_MS = 50;
const IDLE_DELAY_MS = 1_000;
const RECONCILE_INTERVAL_MS = 60_000;
const FINALIZER_QUEUES = [
  MAIN_QUEUES.generationTerminalIngest,
  MAIN_QUEUES.aiFinalize,
] as const;

let running = true;
let reconciling = false;
let lastReconcileAt = 0;
let nextQueueOffset = 0;

export async function runFinalizerLoop(): Promise<void> {
  logger.info("gen-finalizer started");
  while (running) {
    const workerId = `finalizer-${randomUUID()}`;
    let processed = 0;
    try {
      const result = await drainLocalAiPipeline({
        // One claimed row per loop keeps SIGTERM bounded by the current
        // authority transition instead of an arbitrary 25-row batch.
        limit: 1,
        workerId,
        queues: finalizerQueuesForIteration(),
      });
      processed = result.processed;
    } catch (err) {
      logger.error({ err }, "finalizer drain failed");
    }
    await maybeReconcileStaleJobs();
    await dispatchPendingGenerationTerminalRecords().catch((err) => logger.error({ err }, "generation terminal record dispatch failed"));
    await sleep(processed > 0 ? BUSY_DELAY_MS : IDLE_DELAY_MS);
  }
}

function finalizerQueuesForIteration(): string[] {
  const offset = nextQueueOffset;
  nextQueueOffset = (nextQueueOffset + 1) % FINALIZER_QUEUES.length;
  return [
    ...FINALIZER_QUEUES.slice(offset),
    ...FINALIZER_QUEUES.slice(0, offset),
  ];
}

// SPEC: periodically recover stale dispatches and quarantine expired provider
// leases. This loop never invents a provider failure from GenerationJob age.
async function maybeReconcileStaleJobs(now = Date.now()): Promise<void> {
  if (reconciling || now - lastReconcileAt < RECONCILE_INTERVAL_MS) return;
  reconciling = true;
  lastReconcileAt = now;
  try {
    const result = await reconcileStaleGenerationJobs();
    if (result.enqueued > 0 || result.quarantined > 0) {
      logger.info(
        { enqueued: result.enqueued, quarantined: result.quarantined },
        "finalizer reconciled stale generation authority",
      );
    }
  } catch (err) {
    logger.error({ err }, "finalizer stale reconcile failed");
  }
  try {
    const relay = await redriveFailedGenerationTerminalRelays();
    if (relay.redriven > 0) {
      logger.warn(
        { redriven: relay.redriven },
        "finalizer redrove exhausted generation terminal relays",
      );
    }
    if (relay.deferredPaused > 0) {
      logger.info(
        { deferredPaused: relay.deferredPaused },
        "generation terminal relay redrive deferred while queue is paused",
      );
    }
    if (relay.invalid.length > 0) {
      logger.error(
        { invalid: relay.invalid },
        "invalid failed generation terminal relays remain blocked",
      );
    }
    if (relay.retryErrors.length > 0) {
      logger.error(
        { retryErrors: relay.retryErrors },
        "generation terminal relay redrive races require another scan",
      );
    }
  } catch (err) {
    logger.error({ err }, "generation terminal relay redrive scan failed");
  }
  try {
    const reviews = await scanDueUnknownGenerationReviews();
    if (reviews.reminded > 0) {
      logger.info(
        { reminded: reviews.reminded },
        "finalizer projected due unknown generation reviews",
      );
    }
  } catch (err) {
    logger.error({ err }, "finalizer unknown review reminder scan failed");
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

export async function awaitFinalizerShutdown(
  loopPromise: Promise<void>,
): Promise<void> {
  stopFinalizerLoop();
  await loopPromise;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const loopPromise = runFinalizerLoop();
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = () => {
    if (shutdownPromise) return;
    logger.info("gen-finalizer shutting down");
    shutdownPromise = awaitFinalizerShutdown(loopPromise)
      .then(() => process.exit(0))
      .catch((err) => {
        logger.error({ err }, "gen-finalizer graceful shutdown failed");
        process.exit(1);
      });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  void loopPromise.catch((err) => {
    if (shutdownPromise) return;
    logger.error({ err }, "gen-finalizer loop exited unexpectedly");
    process.exit(1);
  });
}
