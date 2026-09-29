import { describe, expect, it } from "vitest";
import { serviceState } from "./health";

describe("serviceState", () => {
  it("is down whenever the live probe fails, whatever the traffic says", () => {
    expect(serviceState({ probeOk: false, attempts: 0, failures: 0 })).toBe("down");
    expect(serviceState({ probeOk: false, attempts: 50, failures: 0 })).toBe("down");
  });

  it("is degraded when a live service fails at least a fifth of a meaningful hour", () => {
    expect(serviceState({ probeOk: true, attempts: 10, failures: 2 })).toBe("degraded");
    expect(serviceState({ probeOk: true, attempts: 10, failures: 1 })).toBe("ok");
  });

  it("does not paint the front page red for one or two isolated failures", () => {
    expect(serviceState({ probeOk: true, attempts: 2, failures: 2 })).toBe("ok");
  });
});
