import { describe, expect, it, vi } from "vitest";
import { BoundedShadowExecutor } from "./companion-shadow-executor.js";

describe("bounded DSH shadow executor", () => {
  it("rejects work beyond active and queued capacity and exposes an idle drain", async () => {
    const executor = new BoundedShadowExecutor({ concurrency: 1, maxQueued: 1 });
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const second = vi.fn(async () => {});

    expect(executor.submit(() => first)).not.toBeNull();
    expect(executor.submit(second)).not.toBeNull();
    expect(executor.submit(async () => {})).toBeNull();
    let drained = false;
    const drain = executor.onIdle().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    releaseFirst();
    await drain;
    expect(second).toHaveBeenCalledOnce();
    expect(drained).toBe(true);
  });

  it("returns a per-task cancellation handle without closing the executor", async () => {
    const executor = new BoundedShadowExecutor({ concurrency: 1, maxQueued: 1 });
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const cancelled = vi.fn(async () => {});

    expect(executor.submit(() => first)).not.toBeNull();
    const queued = executor.submit(async () => {}, cancelled);
    expect(queued).not.toBeNull();

    queued?.cancel("primary_context_changed");
    queued?.cancel("duplicate_cancel");
    await queued?.onSettled();
    expect(cancelled).toHaveBeenCalledWith("primary_context_changed");
    expect(cancelled).toHaveBeenCalledOnce();

    releaseFirst();
    await executor.onIdle();
    expect(executor.submit(async () => {})).not.toBeNull();
    await executor.onIdle();
  });

  it("aborts active work, records queued shutdown cancellation, and then becomes idle", async () => {
    const executor = new BoundedShadowExecutor({ concurrency: 1, maxQueued: 1 });
    const queuedTask = vi.fn(async () => {});
    let releaseEvidence!: () => void;
    const evidenceWritten = new Promise<void>((resolve) => { releaseEvidence = resolve; });
    const queuedCancelled = vi.fn(async () => evidenceWritten);
    let observedReason: unknown;
    expect(executor.submit(async (signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          observedReason = signal.reason;
          resolve();
        }, { once: true });
      });
    })).not.toBeNull();
    expect(executor.submit(queuedTask, queuedCancelled)).not.toBeNull();

    executor.cancel("shutdown");
    let drained = false;
    const drain = executor.onIdle().then(() => { drained = true; });
    await Promise.resolve();

    expect(observedReason).toBe("shutdown");
    expect(queuedTask).not.toHaveBeenCalled();
    expect(queuedCancelled).toHaveBeenCalledWith("shutdown");
    expect(drained).toBe(false);

    releaseEvidence();
    await drain;
    expect(executor.submit(async () => {})).toBeNull();
  });
});
