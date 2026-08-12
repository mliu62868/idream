import { afterEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  captureWarmupFailure: vi.fn(),
  logger: { error: vi.fn(), info: vi.fn() },
  startWeb: vi.fn(() => ({ close: vi.fn() })),
  startWorker: vi.fn(),
  warmRuntime: vi.fn(async () => {
    throw new Error("warm-up failed");
  }),
}));

vi.mock("./instrumentation.js", () => ({
  captureChatRuntimeWarmupFailure: runtime.captureWarmupFailure,
}));
vi.mock("./web.js", () => ({ startWeb: runtime.startWeb }));
vi.mock("./worker.js", () => ({ startWorker: runtime.startWorker }));
vi.mock("./stream.js", () => ({ closeStreamPublisher: vi.fn() }));
vi.mock("./logger.js", () => ({ logger: runtime.logger }));
vi.mock("./runtime-readiness.js", () => ({
  runtimeReadiness: { snapshot: vi.fn(), stopAccepting: vi.fn() },
  warmRuntime: runtime.warmRuntime,
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

describe("chat process observability wiring", () => {
  it("captures a runtime warm-up failure before scheduling a retry", async () => {
    await import("./main.js");

    await vi.waitFor(() => {
      expect(runtime.captureWarmupFailure).toHaveBeenCalledOnce();
    });
    expect(runtime.captureWarmupFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: "warm-up failed" }),
    );
    expect(runtime.startWorker).not.toHaveBeenCalled();
  });
});
