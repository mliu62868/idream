import { describe, expect, it } from "vitest";
import { createLatestRequestGate } from "./latest-request";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("latest workspace request gate", () => {
  it("prevents an older response from overwriting the latest query result", async () => {
    const gate = createLatestRequestGate();
    const first = deferred<string>();
    const second = deferred<string>();
    const committed: string[] = [];

    const load = async (response: Promise<string>) => {
      const request = gate.begin();
      const value = await response;
      if (request.isCurrent()) committed.push(value);
    };

    const firstLoad = load(first.promise);
    const secondLoad = load(second.promise);
    second.resolve("latest query");
    await secondLoad;
    first.resolve("stale query");
    await firstLoad;

    expect(committed).toEqual(["latest query"]);
  });

  it("invalidates a pending request when its workspace is disposed", () => {
    const gate = createLatestRequestGate();
    const pending = gate.begin();

    gate.invalidate();

    expect(pending.isCurrent()).toBe(false);
  });
});
