// SPEC: gen-finalizer (design §10). Long-running drain of the main-side AI queues
// — app.ai.finalize (settle assets + dreamcoins + output moderation) plus the
// in-monolith image/video/memory queues. Wraps the already-tested
// drainLocalAiPipeline in a poll loop with backoff when idle + graceful shutdown.
// Replaces the cron-poked /api/internal/worker route for a standalone process.
import { randomUUID } from "node:crypto";
import { drainLocalAiPipeline } from "@/server/ai/local-pipeline";
import { logger } from "@/server/lib/logger";

const BUSY_DELAY_MS = 50;
const IDLE_DELAY_MS = 1_000;

let running = true;

export async function runFinalizerLoop(): Promise<void> {
  logger.info("gen-finalizer started");
  while (running) {
    const workerId = `finalizer-${randomUUID()}`;
    let processed = 0;
    try {
      const result = await drainLocalAiPipeline({ limit: 25, workerId });
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
