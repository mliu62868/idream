import { describe, expect, it } from "vitest";
import { ConcurrencyWaitQueue, InferencePriorityGate } from "./execution-scheduler";

describe("InferencePriorityGate", () => {
  it("makes background maintenance yield until active foreground turns finish", async () => {
    const gate = new InferencePriorityGate();
    const order: string[] = [];
    const releaseForeground = Promise.withResolvers<void>();

    const foreground = gate.withForeground(async () => {
      order.push("fg:start");
      await releaseForeground.promise;
      order.push("fg:end");
    });

    const background = gate.waitForBackgroundSlot(undefined, 5_000).then(() => {
      order.push("bg:run");
    });

    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(order).toEqual(["fg:start"]);
    expect(gate.activeForegroundCount).toBe(1);

    releaseForeground.resolve();
    await Promise.all([foreground, background]);
    expect(gate.activeForegroundCount).toBe(0);
    expect(order).toEqual(["fg:start", "fg:end", "bg:run"]);
  });

  it("aborts immediately when background signal is cancelled while yielding", async () => {
    const gate = new InferencePriorityGate();
    const releaseForeground = Promise.withResolvers<void>();
    const foreground = gate.withForeground(() => releaseForeground.promise);
    const controller = new AbortController();

    const waiting = gate.waitForBackgroundSlot(controller.signal, 5_000);
    controller.abort(new Error("shutdown"));
    await expect(waiting).rejects.toThrow("shutdown");

    releaseForeground.resolve();
    await foreground;
  });
});

describe("ConcurrencyWaitQueue", () => {
  it("wakes queued turns in FIFO order immediately when a slot frees up", async () => {
    const queue = new ConcurrencyWaitQueue<"normal" | "private">();
    let inUse = 1;
    const isAvailable = () => inUse < 1;
    const order: string[] = [];

    const first = queue.waitForSlot("normal", isAvailable, 2_000).then((ok) => {
      if (ok) {
        inUse += 1;
        order.push("first");
      }
      return ok;
    });
    const second = queue.waitForSlot("normal", isAvailable, 2_000).then((ok) => {
      if (ok) {
        inUse += 1;
        order.push("second");
      }
      return ok;
    });

    inUse -= 1;
    queue.notify("normal");
    await expect(first).resolves.toBe(true);
    expect(order).toEqual(["first"]);

    inUse -= 1;
    queue.notify("normal");
    await expect(second).resolves.toBe(true);
    expect(order).toEqual(["first", "second"]);
  });

  it("returns false immediately when waitMs is 0", async () => {
    const queue = new ConcurrencyWaitQueue<"normal" | "private">();
    await expect(queue.waitForSlot("normal", () => false, 0)).resolves.toBe(false);
  });
});
