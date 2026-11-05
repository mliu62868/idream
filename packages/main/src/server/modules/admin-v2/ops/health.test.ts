import { describe, expect, it } from "vitest";
import { serviceState, videoRouteProbe } from "./health";

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

  it("is degraded when the default route is up but another route is down", () => {
    expect(serviceState({ probeOk: true, attempts: 0, failures: 0, optionalRouteDown: true })).toBe("degraded");
    expect(serviceState({ probeOk: false, attempts: 0, failures: 0, optionalRouteDown: true })).toBe("down");
  });
});

describe("videoRouteProbe", () => {
  const up = { ok: true };
  const refused = { ok: false, detail: "fetch failed" };

  it("follows the listener that serves the default video route", () => {
    expect(videoRouteProbe("h3", { h3: refused, video: up })).toEqual({
      probeOk: false,
      detail: "h3: fetch failed",
      optionalRouteDown: false,
    });
    expect(videoRouteProbe("video", { h3: refused, video: up })).toEqual({
      probeOk: true,
      detail: "h3: fetch failed",
      optionalRouteDown: true,
    });
  });

  it("reports every down listener and stays clean when all are up", () => {
    expect(videoRouteProbe("h3", { h3: refused, video: refused })).toEqual({
      probeOk: false,
      detail: "h3: fetch failed; video: fetch failed",
      optionalRouteDown: true,
    });
    expect(videoRouteProbe("h3", { h3: up, video: up })).toEqual({
      probeOk: true,
      detail: null,
      optionalRouteDown: false,
    });
  });
});
