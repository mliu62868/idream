export interface ShadowTaskHandle {
  cancel(reason?: string): void;
  onSettled(): Promise<void>;
}

type ShadowTask = (signal: AbortSignal) => Promise<void>;
type QueuedCancellation = (reason: string) => Promise<void> | void;

// INVARIANT: shadow work may consume spare capacity, but can never consume an
// unbounded number of Chat generate workers or heap-backed queue entries.
export interface ShadowExecutor {
  submit(task: ShadowTask, onQueuedCancellation?: QueuedCancellation): ShadowTaskHandle | null;
  cancel(reason?: string): void;
  onIdle(): Promise<void>;
}

interface QueuedShadowTask {
  task: ShadowTask;
  onQueuedCancellation?: QueuedCancellation;
  controller: AbortController;
  state: "queued" | "active" | "cancelling" | "settled";
  settled: Promise<void>;
  resolveSettled: () => void;
}

export class BoundedShadowExecutor implements ShadowExecutor {
  readonly #concurrency: number;
  readonly #maxQueued: number;
  readonly #queue: QueuedShadowTask[] = [];
  readonly #activeEntries = new Set<QueuedShadowTask>();
  readonly #cancellationDrains = new Set<Promise<void>>();
  readonly #idleWaiters = new Set<() => void>();
  #active = 0;
  #accepting = true;

  constructor(input: { concurrency: number; maxQueued: number }) {
    if (!Number.isInteger(input.concurrency) || input.concurrency < 1) {
      throw new Error("shadow executor concurrency must be a positive integer");
    }
    if (!Number.isInteger(input.maxQueued) || input.maxQueued < 0) {
      throw new Error("shadow executor maxQueued must be a non-negative integer");
    }
    this.#concurrency = input.concurrency;
    this.#maxQueued = input.maxQueued;
  }

  submit(task: ShadowTask, onQueuedCancellation?: QueuedCancellation): ShadowTaskHandle | null {
    if (!this.#accepting) return null;
    if (this.#active >= this.#concurrency && this.#queue.length >= this.#maxQueued) {
      return null;
    }
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    const entry: QueuedShadowTask = {
      task,
      onQueuedCancellation,
      controller: new AbortController(),
      state: "queued",
      settled,
      resolveSettled,
    };
    this.#queue.push(entry);
    this.#pump();
    return {
      cancel: (reason = "cancelled") => this.#cancelTask(entry, reason),
      onSettled: () => entry.settled,
    };
  }

  cancel(reason = "cancelled"): void {
    this.#accepting = false;
    for (const entry of [...this.#queue]) this.#cancelTask(entry, reason);
    for (const entry of this.#activeEntries) entry.controller.abort(reason);
    this.#resolveIdleIfNeeded();
  }

  onIdle(): Promise<void> {
    if (this.#isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.add(resolve));
  }

  #cancelTask(entry: QueuedShadowTask, reason: string): void {
    if (entry.state === "settled" || entry.state === "cancelling") return;
    if (entry.state === "active") {
      entry.controller.abort(reason);
      return;
    }
    const index = this.#queue.indexOf(entry);
    if (index >= 0) this.#queue.splice(index, 1);
    entry.state = "cancelling";
    entry.controller.abort(reason);
    // The owner owns domain evidence. A queued task has never entered its task
    // body, so cancellation gets a separate cleanup callback and idle is
    // withheld until that evidence write has settled.
    const drain = Promise.resolve()
      .then(() => entry.onQueuedCancellation?.(reason))
      .then(() => undefined)
      .catch(() => {
        // The owner logs persistence failures. Capacity must still converge.
      })
      .finally(() => {
        this.#cancellationDrains.delete(drain);
        this.#settle(entry);
        this.#pump();
        this.#resolveIdleIfNeeded();
      });
    this.#cancellationDrains.add(drain);
  }

  #pump(): void {
    while (this.#active < this.#concurrency) {
      const entry = this.#queue.shift();
      if (!entry) break;
      entry.state = "active";
      this.#active += 1;
      this.#activeEntries.add(entry);
      void entry.task(entry.controller.signal)
        .catch(() => {
          // The owner task records its own domain error. The executor's only
          // responsibility is capacity and liveness.
        })
        .finally(() => {
          this.#activeEntries.delete(entry);
          this.#active -= 1;
          this.#settle(entry);
          this.#pump();
          this.#resolveIdleIfNeeded();
        });
    }
  }

  #settle(entry: QueuedShadowTask): void {
    if (entry.state === "settled") return;
    entry.state = "settled";
    entry.resolveSettled();
  }

  #isIdle(): boolean {
    return this.#active === 0 &&
      this.#queue.length === 0 &&
      this.#cancellationDrains.size === 0;
  }

  #resolveIdleIfNeeded(): void {
    if (!this.#isIdle()) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }
}
