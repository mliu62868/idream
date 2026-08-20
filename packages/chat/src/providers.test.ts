import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
});

describe("Chat-owned moderation provider", () => {
  it("passes ordinary content and blocks the fixed underage terms", async () => {
    process.env = { ...originalEnv, MODERATION_PROVIDER: "mock" };
    const { createProviders } = await import("./providers.js");
    const moderation = createProviders().moderation;

    await expect(moderation.check({ targetType: "text", content: "hello" }))
      .resolves.toEqual({ status: "passed", confidence: 0.5 });
    await expect(moderation.check({ targetType: "text", content: "minor" }))
      .resolves.toMatchObject({ status: "blocked", policyCode: "age_under_18" });
  });

  it("wires the configured safety gateway", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      status: "blocked",
      policyCode: "UNDERAGE",
      confidence: 0.99,
    }));
    vi.stubGlobal("fetch", fetchMock);
    process.env = {
      ...originalEnv,
      MODERATION_PROVIDER: "safety-gateway",
      MODERATION_SERVICE_URL: "https://safety.internal.example.com",
      MODERATION_API_KEY: "moderation-api-key",
    };
    const { createProviders } = await import("./providers.js");

    await expect(createProviders().moderation.check({
      targetType: "text",
      content: "unsafe prompt",
    })).resolves.toEqual({
      status: "blocked",
      policyCode: "UNDERAGE",
      confidence: 0.99,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fails closed when the safety gateway is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({}, { status: 503 })));
    process.env = {
      ...originalEnv,
      MODERATION_PROVIDER: "safety-gateway",
      MODERATION_SERVICE_URL: "https://safety.internal.example.com",
      MODERATION_API_KEY: "moderation-api-key",
    };
    const { createProviders } = await import("./providers.js");

    await expect(createProviders().moderation.check({
      targetType: "text",
      content: "prompt needing a decision",
    })).resolves.toEqual({
      status: "blocked",
      policyCode: "moderation_unavailable",
      confidence: 1,
    });
  });

  it("rejects an incomplete safety-gateway configuration", async () => {
    process.env = {
      ...originalEnv,
      MODERATION_PROVIDER: "safety-gateway",
      MODERATION_SERVICE_URL: "",
      MODERATION_API_KEY: "moderation-api-key",
    };
    const { createProviders } = await import("./providers.js");
    expect(() => createProviders()).toThrow(
      "MODERATION_SERVICE_URL is required when MODERATION_PROVIDER=safety-gateway",
    );
  });
});
