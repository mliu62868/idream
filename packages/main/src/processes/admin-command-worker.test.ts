import { describe, expect, it } from "vitest";
import { shouldDispatchStaleUnknownSweep } from "./admin-command-worker";

describe("admin command worker stale unknown cadence", () => {
  it("runs at the interval boundary but not on every busy iteration", () => {
    expect(shouldDispatchStaleUnknownSweep(10_000, 69_999)).toBe(false);
    expect(shouldDispatchStaleUnknownSweep(10_000, 70_000)).toBe(true);
  });
});
