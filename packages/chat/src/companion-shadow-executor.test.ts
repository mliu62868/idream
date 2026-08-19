import { describe, expect, it, vi } from "vitest";
import { BoundedShadowExecutor } from "./companion-shadow-executor.js";

describe("bounded DSH shadow executor", () => {
  it("rejects work beyond active and queued capacity and exposes an idle drain", async () => {
    const executor = new BoundedShadowExecutor({ concurrency: 1, maxQueued: 1 });
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const second = vi.fn(async () => {});

    expect(executor.submit(() => first)).toBe(true);
    expect(executor.submit(second)).toBe(true);
    expect(executor.submit(async () => {})).toBe(false);
    let drained = false;
    const drain = executor.onIdle().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    releaseFirst();
    await drain;
    expect(second).toHaveBeenCalledOnce();
    expect(drained).toBe(true);
  });

  it("aborts active work, drops queued work, and then becomes idle", async () => {
    const executor = new BoundedShadowExecutor({ concurrency: 1, maxQueued: 1 });
    const queued = vi.fn(async () => {});
    let observedReason: unknown;
    expect(executor.submit(async (signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          observedReason = signal.reason;
          resolve();
        }, { once: true });
      });
    })).toBe(true);
    expect(executor.submit(queued)).toBe(true);

    executor.cancel("shutdown");
    await executor.onIdle();

    expect(observedReason).toBe("shutdown");
    expect(queued).not.toHaveBeenCalled();
    expect(executor.submit(async () => {})).toBe(false);
  });
});
