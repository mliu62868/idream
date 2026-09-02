import { GEN_QUEUES } from "@idream/shared/contracts";

if (process.env.APP_ENV !== "test" || !process.env.BULLMQ_PREFIX?.startsWith("idream:e2e:")) {
  throw new Error("Playwright video worker requires its run-owned test environment");
}

const genModule = (file: string) => new URL(`../../../gen/src/${file}.ts`, import.meta.url).href;
const [pipeline, queue, providers, terminal, transport] = await Promise.all([
  import(genModule("pipeline")),
  import(genModule("queue")),
  import(genModule("providers")),
  import(genModule("terminal-record")),
  import(genModule("transport-execution")),
]);

// Main keeps the production Character, recipe, and workflow pins. Only the
// provider I/O uses Gen's existing test seam; terminal delivery stays real.
const mockProviders = providers.createMockGenProviders();
const worker = queue.runWorker(
  GEN_QUEUES.videoGenerate,
  async (job: { payload: unknown; attemptsMade: number; maxAttempts: number }) => {
    await pipeline.processVideoGenerate(job.payload, {
      providers: mockProviders,
      attemptsMade: job.attemptsMade,
      maxAttempts: job.maxAttempts,
      acknowledgeTerminalRecord: terminal.enqueueTerminalRecordRelay,
      recordTransportExecution: transport.recordTransportExecution,
    });
  },
  { concurrency: 1, workerName: `idream.e2e.video.${process.env.PW_RUN_ID}` },
);
worker.on("failed", (_job: unknown, error: Error) => console.error(error));
console.log("Playwright video worker started");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await worker.close();
    process.exit(0);
  });
}
