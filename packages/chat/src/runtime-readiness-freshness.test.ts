import { describe, expect, it, vi } from "vitest";
import { createModelEndpointProbe, RuntimeReadiness, warmRuntime } from "./runtime-readiness.js";
import { handleChatRequest } from "./web.js";

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

describe("model endpoint readiness", () => {
  it("reports /readyz unready with a readable reason while the model server is down", async () => {
    const readiness = new RuntimeReadiness();
    const probeModel = createModelEndpointProbe({
      baseUrl: "http://127.0.0.1:8061/v1",
      apiKey: "local",
      fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch,
    });
    await expect(warmRuntime({
      readiness,
      pingRedis: async () => undefined,
      probeAgentRuntime: async () => undefined,
      probeModel,
    })).rejects.toThrow("model endpoint http://127.0.0.1:8061 unreachable");

    const response = await handleChatRequest(new Request("http://chat.internal/readyz"), readiness);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, model: false, reason: "model endpoint http://127.0.0.1:8061 unreachable" });
    // Turns wait for the model; privacy purges that never call it keep working.
    expect(readiness.canAcceptTurns()).toBe(false);
    expect(readiness.canServeMaintenance()).toBe(true);
  });

  it("asks GET <baseUrl>/models at most once per 15s and reuses the outcome", async () => {
    let now = 0;
    const urls: string[] = [];
    let status = 503;
    const probe = createModelEndpointProbe({
      baseUrl: "http://model.internal/v1/",
      apiKey: "local",
      now: () => now,
      fetch: (async (url: string | URL | Request) => {
        urls.push(String(url));
        return new Response(null, { status });
      }) as typeof fetch,
    });
    await expect(probe()).rejects.toThrow("returned HTTP 503");
    status = 200;
    now += 14_000;
    await expect(probe()).rejects.toThrow("returned HTTP 503");
    now += 2_000;
    await expect(probe()).resolves.toBeUndefined();
    expect(urls).toEqual(["http://model.internal/v1/models", "http://model.internal/v1/models"]);
  });
});
