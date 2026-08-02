import { describe, expect, it, vi } from "vitest";
import { awaitFinalizerShutdown } from "./finalizer";

describe("gen-finalizer graceful shutdown", () => {
  it("does not complete shutdown before the current loop iteration settles", async () => {
    let settleLoop: (() => void) | undefined;
    const loopPromise = new Promise<void>((resolve) => {
      settleLoop = resolve;
    });
    const shutdownSettled = vi.fn();

    const shutdown = awaitFinalizerShutdown(loopPromise).then(shutdownSettled);
    await Promise.resolve();
    expect(shutdownSettled).not.toHaveBeenCalled();

    settleLoop?.();
    await shutdown;
    expect(shutdownSettled).toHaveBeenCalledTimes(1);
  });
});
