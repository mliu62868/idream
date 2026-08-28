// Startup recovery for durable local AgentRuns. Admission executes immediately;
// there is no Chat DB queue or product outbox.
import { listIncompleteAgentRuns } from "./agent-run-store.js";
import { startAgentRun } from "./agent-runner.js";
import { logger } from "./logger.js";

export function startWorker() {
  let closed = false;
  const recover = () => void listIncompleteAgentRuns()
    .then((runs) => {
      if (closed) return;
      let recovered = 0;
      for (const run of runs) if (startAgentRun(run.turnId, run.attempt)) recovered += 1;
      if (recovered > 0) logger.info({ recovered }, "recovered incomplete AgentRuns");
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
