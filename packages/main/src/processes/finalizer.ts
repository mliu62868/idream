// SPEC: gen-finalizer (design §10). Long-running drain of the main-side AI
// queues. Current main-web enqueue writes the DB-backed local queue, so this
// process drains generation plus finalization by default. When a deployment
// moves image/video generation to a separate queue worker, set
// GEN_FINALIZER_QUEUES=app.ai.finalize.
import { randomUUID } from "node:crypto";
import { drainLocalAiPipeline, localAiQueueNames } from "@/server/ai/local-pipeline";
import { logger } from "@/server/lib/logger";

const BUSY_DELAY_MS = 50;
const IDLE_DELAY_MS = 1_000;
const DEFAULT_FINALIZER_QUEUES = [...localAiQueueNames];

let running = true;

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
    await sleep(processed > 0 ? BUSY_DELAY_MS : IDLE_DELAY_MS);
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
