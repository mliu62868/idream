import { afterEach, describe, expect, it, vi } from "vitest";

const oldEnv = { ...process.env };

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  process.env = { ...oldEnv };
});

describe("chat providers", () => {
  it("uses the pipeline chat provider alias for OpenAI-compatible streaming", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        'data: {"choices":[{"delta":{"content":"Pipeline reply"}}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    process.env = {
      ...oldEnv,
      CHAT_MODEL_PROVIDER: "pipeline",
      CHAT_MODEL_BASE_URL: "https://pipeline.internal.example.com/v1",
      CHAT_MODEL_API_KEY: "pipeline-api-key",
      MODERATION_PROVIDER: "mock",
    };

    const { createProviders } = await import("./providers.js");
    const providers = createProviders();
    const chunks = [];
    // P0-D: the per-turn model from policy is what the provider must send.
    for await (const chunk of providers.chat.stream({
      model: "Qwen3.5-14B-MLX-4bit",
      messages: [{ role: "user", content: "hello" }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { delta: "Pipeline reply", done: false },
      { delta: "", done: true },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://pipeline.internal.example.com/v1/chat/completions"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer pipeline-api-key",
        }),
      }),
    );
    // The request body carries the policy model, not a fixed env model.
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as { body: string };
    const body = JSON.parse(init.body);
    expect(body.model).toBe("Qwen3.5-14B-MLX-4bit");
  });

  it("wires the safety gateway moderation provider", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        status: "blocked",
        policyCode: "UNDERAGE",
        confidence: 0.99,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    process.env = {
      ...oldEnv,
      CHAT_MODEL_PROVIDER: "mock",
      MODERATION_PROVIDER: "safety-gateway",
      CHAT_MODERATION_SERVICE_URL: "https://safety.internal.example.com",
      CHAT_MODERATION_API_KEY: "moderation-api-key",
      MODERATION_SERVICE_URL: "https://safety.internal.example.com",
      MODERATION_API_KEY: "moderation-api-key",
    };

    const { createProviders } = await import("./providers.js");
    const providers = createProviders();
    const moderation = await providers.moderation.check({
      targetType: "text",
      content: "unsafe prompt",
    });

    expect(moderation).toEqual({
      status: "blocked",
      policyCode: "UNDERAGE",
      confidence: 0.99,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://safety.internal.example.com/moderation/check"),
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer moderation-api-key",
        }),
      }),
    );
  });

  it("fails closed when the safety gateway is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({}, { status: 503 })));
    process.env = {
      ...oldEnv,
      CHAT_MODEL_PROVIDER: "mock",
      MODERATION_PROVIDER: "safety-gateway",
      CHAT_MODERATION_SERVICE_URL: "https://safety.internal.example.com",
      CHAT_MODERATION_API_KEY: "moderation-api-key",
      MODERATION_SERVICE_URL: "https://safety.internal.example.com",
      MODERATION_API_KEY: "moderation-api-key",
    };

    const { createProviders } = await import("./providers.js");
    const providers = createProviders();
    const moderation = await providers.moderation.check({
      targetType: "text",
      content: "prompt needing a safety decision",
    });

    expect(moderation).toEqual({
      status: "blocked",
      policyCode: "moderation_unavailable",
      confidence: 1,
    });
  });

  it("rejects production startup when chat providers are still mock", async () => {
    vi.resetModules();
    process.env = {
      ...oldEnv,
      APP_ENV: "production",
      CHAT_MODEL_PROVIDER: "mock",
      MODERATION_PROVIDER: "mock",
      CHAT_MODERATION_PROVIDER: "mock",
    };

    await expect(import("./providers.js")).rejects.toThrow(
      /Production requires non-mock chat providers:.*CHAT_MODEL_PROVIDER.*MODERATION_PROVIDER/,
    );
  });

  it("rejects safety gateway startup without a service URL", async () => {
    process.env = {
      ...oldEnv,
      CHAT_MODEL_PROVIDER: "mock",
      MODERATION_PROVIDER: "safety-gateway",
      CHAT_MODERATION_SERVICE_URL: "",
      CHAT_MODERATION_API_KEY: "",
      MODERATION_SERVICE_URL: "",
      MODERATION_API_KEY: "moderation-api-key",
    };

    await expect(import("./providers.js")).rejects.toThrow(
      "MODERATION_SERVICE_URL is required when MODERATION_PROVIDER=safety-gateway",
    );
  });
});
