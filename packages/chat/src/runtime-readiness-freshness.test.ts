import { describe, expect, it, vi } from "vitest";
import { RuntimeReadiness } from "./runtime-readiness.js";

describe("RuntimeReadiness dependency freshness", () => {
  it("reprobes a previously green runtime after its observation expires", async () => {
    let now = 1_000;
    const readiness = new RuntimeReadiness({ now: () => now, ttlMs: 100 });
    const recover = vi.fn(async () => readiness.markReady());
    readiness.configureFullWarmupRecovery(recover);
    readiness.markReady();

    expect(readiness.canAcceptTurns()).toBe(true);
    now += 101;
    expect(readiness.canAcceptTurns()).toBe(false);

    await readiness.refreshDependencies();
    expect(recover).toHaveBeenCalledOnce();
    expect(readiness.canAcceptTurns()).toBe(true);
    expect(readiness.snapshot()).toMatchObject({ fresh: true, observedAt: new Date(now).toISOString() });
  });

  it("coalesces concurrent stale probes and remains closed when recovery fails", async () => {
    let now = 2_000;
    const readiness = new RuntimeReadiness({ now: () => now, ttlMs: 100 });
    readiness.markReady();
    now += 101;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const recover = vi.fn(async () => {
      await gate;
      readiness.markFailed("redis unavailable");
      throw new Error("redis unavailable");
    });
    readiness.configureFullWarmupRecovery(recover);

    const first = readiness.refreshDependencies();
    const second = readiness.refreshDependencies();
    release();
    await Promise.all([first, second]);

    expect(recover).toHaveBeenCalledOnce();
    expect(readiness.canAcceptTurns()).toBe(false);
    expect(readiness.snapshot()).toMatchObject({ warmed: false, fresh: false, reason: "redis unavailable" });
  });
});
