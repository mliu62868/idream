import { GEN_QUEUES } from "@idream/shared/contracts";

if (process.env.APP_ENV !== "test" || !process.env.BULLMQ_PREFIX?.startsWith("idream:e2e:")) {
  throw new Error("Playwright generation worker requires its run-owned test environment");
}
const mode = process.argv[2];
if (mode !== "image" && mode !== "video") {
  throw new Error("Usage: start-playwright-gen-worker.ts image|video");
}

const genModule = (file: string) => new URL(`../../../gen/src/${file}.ts`, import.meta.url).href;
const [pipeline, queue, providers, terminal, transport] = await Promise.all([
  import(genModule("pipeline")),
  import(genModule("queue")),
  import(genModule("providers")),
  import(genModule("terminal-record")),
  import(genModule("transport-execution")),
]);

// Main keeps the production Character, recipe, and workflow pins (runner
// `comfyui`, so GEN_*_PROVIDER=backend passes Gen's pin self-check). Only the
// provider I/O uses Gen's existing test seam; terminal delivery stays real.
const mockProviders = providers.createMockGenProviders();
const process_ = mode === "image" ? pipeline.processImageGenerate : pipeline.processVideoGenerate;
const worker = queue.runWorker(
  mode === "image" ? GEN_QUEUES.imageGenerate : GEN_QUEUES.videoGenerate,
  async (job: { payload: unknown; attemptsMade: number; maxAttempts: number }) => {
    await process_(job.payload, {
      providers: mockProviders,
      attemptsMade: job.attemptsMade,
      maxAttempts: job.maxAttempts,
      acknowledgeTerminalRecord: terminal.enqueueTerminalRecordRelay,
      recordTransportExecution: transport.recordTransportExecution,
    });
  },
  { concurrency: 1, workerName: `idream.e2e.${mode}.${process.env.PW_RUN_ID}` },
);
worker.on("failed", (_job: unknown, error: Error) => console.error(error));
console.log(`Playwright ${mode} worker started`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await worker.close();
    process.exit(0);
  });
}
