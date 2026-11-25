/**
 * In-process scheduling primitives that protect live companion latency on
 * shared model servers without introducing a second durable queue:
 * 1. InferencePriorityGate yields background memory maintenance/verification
 *    while foreground user Turns are actively waiting on the model server.
 * 2. ConcurrencyWaitQueue wakes queued Turns in FIFO order as soon as an
 *    active Agent slot frees up instead of waiting for the 5s disk scanner.
 */

export const DEFAULT_BACKGROUND_YIELD_MAX_MS = 15_000;

export class InferencePriorityGate {
  private foregroundActive = 0;
  private readonly waiters = new Set<() => void>();

  get activeForegroundCount(): number {
    return this.foregroundActive;
  }

  async withForeground<T>(run: () => Promise<T>): Promise<T> {
    this.foregroundActive += 1;
    try {
      return await run();
    } finally {
      this.foregroundActive = Math.max(0, this.foregroundActive - 1);
      if (this.foregroundActive === 0) {
        const pending = [...this.waiters];
        this.waiters.clear();
        for (const wake of pending) wake();
      }
    }
  }

  async waitForBackgroundSlot(
    signal?: AbortSignal,
    maxWaitMs = DEFAULT_BACKGROUND_YIELD_MAX_MS,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (this.foregroundActive === 0 || maxWaitMs <= 0) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        this.waiters.delete(onWake);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const onWake = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(signal?.reason ?? new Error("background task aborted while yielding to foreground"));
      };
      const timer = setTimeout(onWake, maxWaitMs);
      timer.unref?.();
      this.waiters.add(onWake);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      else if (this.foregroundActive === 0) onWake();
    });
  }
}

export const sharedInferencePriorityGate = new InferencePriorityGate();

export class ConcurrencyWaitQueue<Pool extends string> {
  private readonly queues = new Map<Pool, Array<() => void>>();

  notify(pool: Pool): void {
    const queue = this.queues.get(pool);
    if (!queue || queue.length === 0) return;
    const next = queue.shift();
    if (queue.length === 0) this.queues.delete(pool);
    next?.();
  }

  notifyAll(): void {
    for (const pool of [...this.queues.keys()]) {
      const queue = this.queues.get(pool);
      this.queues.delete(pool);
      for (const wake of queue ?? []) wake();
    }
  }

  async waitForSlot(
    pool: Pool,
    isAvailable: () => boolean,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    signal?.throwIfAborted();
    if (isAvailable()) return true;
    if (waitMs <= 0) return false;
    const deadline = Date.now() + waitMs;
    while (!isAvailable()) {
      signal?.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const queue = this.queues.get(pool) ?? [];
        if (!this.queues.has(pool)) this.queues.set(pool, queue);
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          const list = this.queues.get(pool);
          if (list) {
            const index = list.indexOf(onWake);
            if (index >= 0) list.splice(index, 1);
            if (list.length === 0) this.queues.delete(pool);
          }
        };
        const onWake = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        };
        const onAbort = () => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(signal?.reason ?? new Error("aborted while waiting for agent slot"));
        };
        const timer = setTimeout(onWake, remaining);
        timer.unref?.();
        queue.push(onWake);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        else if (isAvailable()) onWake();
      });
    }
    return true;
  }
}
