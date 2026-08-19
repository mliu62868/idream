// INVARIANT: shadow work may consume spare capacity, but can never consume an
// unbounded number of Chat generate workers or heap-backed queue entries.
export interface ShadowExecutor {
  submit(task: (signal: AbortSignal) => Promise<void>): boolean;
  cancel(reason?: string): void;
  onIdle(): Promise<void>;
}

interface QueuedShadowTask {
  task: (signal: AbortSignal) => Promise<void>;
  controller: AbortController;
}

export class BoundedShadowExecutor implements ShadowExecutor {
  readonly #concurrency: number;
  readonly #maxQueued: number;
  readonly #queue: QueuedShadowTask[] = [];
  readonly #activeControllers = new Set<AbortController>();
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

  submit(task: (signal: AbortSignal) => Promise<void>): boolean {
    if (!this.#accepting) return false;
    if (this.#active >= this.#concurrency && this.#queue.length >= this.#maxQueued) {
      return false;
    }
    this.#queue.push({ task, controller: new AbortController() });
    this.#pump();
    return true;
  }

  cancel(reason = "cancelled"): void {
    this.#accepting = false;
    for (const entry of this.#queue.splice(0)) entry.controller.abort(reason);
    for (const controller of this.#activeControllers) controller.abort(reason);
    this.#resolveIdleIfNeeded();
  }

  onIdle(): Promise<void> {
    if (this.#active === 0 && this.#queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.add(resolve));
  }

  #pump(): void {
    while (this.#active < this.#concurrency) {
      const entry = this.#queue.shift();
      if (!entry) break;
      this.#active += 1;
      this.#activeControllers.add(entry.controller);
      void entry.task(entry.controller.signal)
        .catch(() => {
          // The owner task records its own domain error. The executor's only
          // responsibility is capacity and liveness.
        })
        .finally(() => {
          this.#activeControllers.delete(entry.controller);
          this.#active -= 1;
          this.#pump();
          this.#resolveIdleIfNeeded();
        });
    }
  }

  #resolveIdleIfNeeded(): void {
    if (this.#active !== 0 || this.#queue.length !== 0) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }
}
