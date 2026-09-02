// Startup recovery for durable local AgentRuns. Admission executes immediately;
// there is no Chat DB queue or product outbox.
import { recoverIncompleteAgentRuns } from "./agent-runner.js";
import { logger } from "./logger.js";

export function startWorker() {
  let closed = false;
  const recover = () => void recoverIncompleteAgentRuns()
    .then(({ recovered, failed }) => {
      if (closed) return;
      if (recovered > 0) logger.info({ recovered }, "recovered incomplete AgentRuns");
      if (failed > 0) logger.warn({ failed }, "skipped invalid AgentRun recovery inputs");
    })
    .catch((error) => logger.error({ err: error }, "AgentRun recovery failed"));
  recover();
  const timer = setInterval(recover, 5_000);
  timer.unref();
  return {
    async close() {
      closed = true;
      clearInterval(timer);
    },
  };
}
