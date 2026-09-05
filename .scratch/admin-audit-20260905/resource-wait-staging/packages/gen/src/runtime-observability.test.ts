import { afterEach, describe, expect, it, vi } from "vitest";

type FailureCallback = (job: { id?: string } | undefined, error: Error) => void;
type RecoveryCallback = (error: unknown) => void;

const runtime = vi.hoisted(() => ({
  captureFailure: vi.fn(),
  recoveryErrors: new Map<string, RecoveryCallback>(),
  workerFailures: new Map<string, FailureCallback>(),
}));

vi.mock("./instrumentation", () => ({
  captureGenerationRuntimeFailure: runtime.captureFailure,
}));
vi.mock("@idream/shared/contracts", () => ({
  GEN_QUEUES: { imageGenerate: "image", videoGenerate: "video" },
}));
vi.mock("./logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("./pipeline", () => ({
  processImageGenerate: vi.fn(),
  processVideoGenerate: vi.fn(),
}));
vi.mock("./providers", () => ({
  assertProductionProviderReady: vi.fn(),
  providers: { blob: {} },
}));
vi.mock("./queue", () => ({
  runWorker: vi.fn((queue: string) => ({
    close: vi.fn(),
    on: vi.fn((event: string, callback: FailureCallback) => {
      if (event === "failed") runtime.workerFailures.set(queue, callback);
    }),
  })),
}));
vi.mock("./failed-source-recovery", () => ({
  startGenerationSourceRecovery: vi.fn(
    (input: { mode: string; onError: RecoveryCallback }) => {
      runtime.recoveryErrors.set(input.mode, input.onError);
      return { close: vi.fn() };
    },
  ),
}));
vi.mock("./terminal-record", () => ({ enqueueTerminalRecordRelay: vi.fn() }));
vi.mock("./transport-execution", () => ({ recordTransportExecution: vi.fn() }));
vi.mock("./env", () => ({
  env: { APP_ENV: "production", VIDEO_PROVIDER: "comfyui" },
}));
vi.mock("./worker-identity", () => ({
  imageWorkerIdentity: vi.fn(() => "image-worker"),
  videoWorkerIdentity: vi.fn(() => "video-worker"),
}));

const originalSignalListeners = {
  SIGINT: new Set(process.listeners("SIGINT")),
  SIGTERM: new Set(process.listeners("SIGTERM")),
};

afterEach(() => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    for (const listener of process.listeners(signal)) {
      if (!originalSignalListeners[signal].has(listener)) {
        process.removeListener(signal, listener);
      }
    }
  }
});

describe("generation process observability wiring", () => {
  it("captures image and video recovery and worker failures", async () => {
    await import("./image");
    await import("./video");

    const imageRecoveryError = new Error("image recovery failed");
    const imageWorkerError = new Error("image worker failed");
    const videoRecoveryError = new Error("video recovery failed");
    const videoWorkerError = new Error("video worker failed");

    runtime.recoveryErrors.get("image")?.(imageRecoveryError);
    runtime.workerFailures.get("image")?.({ id: "image-job" }, imageWorkerError);
    runtime.recoveryErrors.get("video")?.(videoRecoveryError);
    runtime.workerFailures.get("video")?.({ id: "video-job" }, videoWorkerError);

    expect(runtime.captureFailure.mock.calls).toEqual([
      [{ boundary: "source-recovery", error: imageRecoveryError, mode: "image" }],
      [{ boundary: "worker", error: imageWorkerError, jobId: "image-job", mode: "image" }],
      [{ boundary: "source-recovery", error: videoRecoveryError, mode: "video" }],
      [{ boundary: "worker", error: videoWorkerError, jobId: "video-job", mode: "video" }],
    ]);
  });
});
