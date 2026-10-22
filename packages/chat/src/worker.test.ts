import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recovery = vi.hoisted(() => ({
  scan: vi.fn<(signal?: AbortSignal) => Promise<{ recovered: number; failed: number }>>(),
}));
vi.mock("./agent-runner.js", () => ({ recoverIncompleteAgentRuns: recovery.scan }));
vi.mock("./logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { startWorker } from "./worker.js";

describe("Chat recovery worker lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    recovery.scan.mockReset().mockResolvedValue({ recovered: 0, failed: 0 });
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("does not overlap slow recovery scans and resumes after the current scan finishes", async () => {
    const pending = Promise.withResolvers<{ recovered: number; failed: number }>();
    recovery.scan.mockReturnValueOnce(pending.promise);
    const worker = startWorker();
    try {
      await vi.advanceTimersByTimeAsync(15_000);
      expect(recovery.scan).toHaveBeenCalledOnce();
      pending.resolve({ recovered: 0, failed: 0 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(recovery.scan).toHaveBeenCalledTimes(2);
    } finally {
      pending.resolve({ recovered: 0, failed: 0 });
      await worker.close();
    }
  });

  it("fences a pending scan at close and waits for it before reporting closure", async () => {
    const pending = Promise.withResolvers<{ recovered: number; failed: number }>();
    recovery.scan.mockReturnValueOnce(pending.promise);
    const worker = startWorker();
    let closed = false;
    const closing = worker.close().then(() => { closed = true; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(recovery.scan.mock.calls[0]?.[0]?.aborted).toBe(true);
      expect(closed).toBe(false);
      pending.resolve({ recovered: 0, failed: 0 });
      await closing;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(recovery.scan).toHaveBeenCalledOnce();
    } finally {
      pending.resolve({ recovered: 0, failed: 0 });
      await closing;
    }
  });
});
