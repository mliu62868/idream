// SPEC: chat process entry (design §10/§12). ONE process = chat/web + chat/worker
// (instances:1 — writes local files). pm2 runs this as `chat`.
import { startWeb } from "./web.js";
import { startWorker } from "./worker.js";
import { logger } from "./logger.js";

const server = startWeb();
const worker = startWorker();

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "chat shutting down");
  await worker.close().catch((err) => logger.error({ err }, "worker close failed"));
  server.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
