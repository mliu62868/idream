// Startup recovery for durable local AgentRuns. Admission executes immediately;
// there is no Chat DB queue or product outbox.
import { recoverIncompleteAgentRuns } from "./agent-runner.js";
import { logger } from "./logger.js";

export function startWorker() {
  const controller = new AbortController();
  let inFlight: Promise<void> | undefined;
  const recover = () => {
    if (controller.signal.aborted || inFlight) return;
    inFlight = recoverIncompleteAgentRuns(controller.signal)
      .then(({ recovered, failed }) => {
        if (controller.signal.aborted) return;
        if (recovered > 0) logger.info({ recovered }, "recovered incomplete AgentRuns");
        if (failed > 0) logger.warn({ failed }, "skipped invalid AgentRun recovery inputs");
      })
      .catch((error) => logger.error({ err: error }, "AgentRun recovery failed"))
      .finally(() => { inFlight = undefined; });
  };
  recover();
  const timer = setInterval(recover, 5_000);
  timer.unref();
  return {
    async close() {
      controller.abort();
      clearInterval(timer);
      await inFlight;
    },
  };
}
