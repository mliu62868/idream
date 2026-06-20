// SPEC: chat/worker (design §10) — one process consuming every chat queue:
// generate / memory.extract / outbox.deliver / inbox.consume / reconcile /
// maintain. Single instance (writes local files). Graceful shutdown closes all.
import type { Worker } from "bullmq";
import { CHAT_QUEUES, MAIN_TO_CHAT_QUEUE } from "@idream/shared/contracts";
import { runWorker } from "./queue.js";
import { logger } from "./logger.js";
import { processGenerate, type GeneratePayload } from "./generate.js";
import { processMemoryExtract, type MemoryExtractPayload } from "./memory.js";
import { deliverPendingOutbox } from "./outbox.js";
import { consumeInbound, type InboundEvent } from "./inbox.js";
import { reconcile } from "./reconcile.js";
import { pruneExpiredSegments } from "./maintain.js";

const RECONCILE_INTERVAL_MS = 30_000;
const MAINTAIN_INTERVAL_MS = 60 * 60_000;

export function startWorker(): { close: () => Promise<void> } {
  const workers: Worker[] = [
    runWorker(CHAT_QUEUES.generate, async (job) => {
      await processGenerate(job.payload as GeneratePayload);
    }, { concurrency: 2 }),

    runWorker(CHAT_QUEUES.memoryExtract, async (job) => {
      await processMemoryExtract(job.payload as MemoryExtractPayload);
    }),

    runWorker(CHAT_QUEUES.outboxDeliver, async () => {
      await deliverPendingOutbox();
    }),

    runWorker(MAIN_TO_CHAT_QUEUE, async (job) => {
      await consumeInbound(job.payload as InboundEvent);
    }),
  ];

  // Periodic convergence + housekeeping (single-instance, so timers are safe).
  const reconcileTimer = setInterval(() => {
    reconcile().catch((err) => logger.error({ err }, "reconcile failed"));
  }, RECONCILE_INTERVAL_MS);
  const maintainTimer = setInterval(() => {
    pruneExpiredSegments().catch((err) => logger.error({ err }, "maintain failed"));
  }, MAINTAIN_INTERVAL_MS);

  logger.info("chat/worker started");

  return {
    async close() {
      clearInterval(reconcileTimer);
      clearInterval(maintainTimer);
      await Promise.all(workers.map((w) => w.close()));
    },
  };
}
