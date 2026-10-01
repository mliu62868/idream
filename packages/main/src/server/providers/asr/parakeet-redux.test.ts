import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "@/server/lib/env";
import { asrReady, requestAsr } from "./parakeet-redux";
const id = "db1bb2a6-67f9-414e-85c2-2a3b28d12a3c";
const scope = { userId: "u", conversationId: "session:s", requestId: id };
const original = { provider: env.ASR_PROVIDER, token: env.PARAKEET_ASR_API_TOKEN };
beforeEach(() => { env.ASR_PROVIDER = "parakeet-redux"; env.PARAKEET_ASR_API_TOKEN = "private-test-token"; });
afterEach(() => { env.ASR_PROVIDER = original.provider; env.PARAKEET_ASR_API_TOKEN = original.token; vi.unstubAllGlobals(); });
describe("resident ASR adapter", () => {
  it("requires actual authenticated readiness rather than configuration", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ready: false })));
    expect(await asrReady()).toBe(false);
  });
  it("rejects an unrelated or stale ready runtime", async () => {
    const health = { ready: true, model: "moondream/parakeet-redux", modelRevision: "2bf128600aac4b16946f7ed8372e56117fe5e23b", runtimeVersion: "2.6.1" };
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ ...health, modelRevision: "stale" })).mockResolvedValueOnce(Response.json(health));
    vi.stubGlobal("fetch", fetchMock);
    expect(await asrReady()).toBe(false);
    expect(await asrReady()).toBe(true);
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBe("Bearer private-test-token");
  });
  it("passes audio and bound identity without product context; normalizes expiry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ requestId: id, status: "completed", text: "Hello", audioDurationMs: 1000, expiresAt: Date.now() + 120_000 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await requestAsr("POST", scope, new Blob(["audio"], { type: "audio/webm" }));
    expect(result.status).toBe("completed");
    const init = fetchMock.mock.calls[0][1];
    expect(init.headers["x-asr-conversation-id"]).toBe("session:s");
    expect(init.headers.authorization).toBe("Bearer private-test-token");
    expect(init.body).toBeInstanceOf(Blob);
  });
  it("never delivers a different request identity", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ requestId: "a4e1cd61-d38d-452e-94bc-dd50b9346161", status: "cancelled" })));
    await expect(requestAsr("GET", scope)).rejects.toMatchObject({ code: "unavailable" });
  });
  it("maps gateway hard rate limits and preserves retry delay", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ detail: "user_busy" }, { status: 429, headers: { "retry-after": "2" } })));
    await expect(requestAsr("POST", scope, new Blob(["audio"]))).rejects.toMatchObject({ code: "rate_limited", details: { errorCode: "user_busy", retryAfterMs: 2000 } });
  });
});
