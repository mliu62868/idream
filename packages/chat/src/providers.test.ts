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
      { delta: "", done: true, toolCalls: [] },
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
    expect(body.max_tokens).toBe(8000);
  });

  it("sends tools in the request body and reports supportsTools per provider", async () => {
    const fetchMock = vi.fn(async () =>
      new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    process.env = {
      ...oldEnv,
      CHAT_MODEL_PROVIDER: "openai",
      CHAT_MODEL_BASE_URL: "https://openai.internal.example.com/v1",
      MODERATION_PROVIDER: "mock",
    };

    const { createProviders } = await import("./providers.js");
    const providers = createProviders();
    expect(providers.chat.supportsTools).toBe(true);

    const tools = [
      { name: "generate_image_async", description: "generate an image", parameters: { type: "object" } },
    ];
    for await (const _chunk of providers.chat.stream({
      messages: [{ role: "user", content: "hello" }],
      tools,
    })) {
      // drain
    }

    const init = (fetchMock.mock.calls[0] as unknown[])[1] as { body: string };
    const body = JSON.parse(init.body);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: { name: "generate_image_async", description: "generate an image", parameters: { type: "object" } },
      },
    ]);
  });

  it("marks the pipeline alias as not supporting tools", async () => {
    process.env = {
      ...oldEnv,
      CHAT_MODEL_PROVIDER: "pipeline",
      CHAT_MODEL_BASE_URL: "https://pipeline.internal.example.com/v1",
      MODERATION_PROVIDER: "mock",
    };

    const { createProviders } = await import("./providers.js");
    expect(createProviders().chat.supportsTools).toBe(false);
  });

  it("accumulates streamed tool_calls fragments by index into complete calls", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        [
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"generate_image_async","arguments":""}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"scene\\""}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"beach\\"}"}}]}}]}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    process.env = {
      ...oldEnv,
      CHAT_MODEL_PROVIDER: "openai",
      CHAT_MODEL_BASE_URL: "https://openai.internal.example.com/v1",
      MODERATION_PROVIDER: "mock",
    };

    const { createProviders } = await import("./providers.js");
    const providers = createProviders();
    const chunks = [];
    for await (const chunk of providers.chat.stream({
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "generate_image_async", description: "generate", parameters: {} }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks.at(-1)).toEqual({
      delta: "",
      done: true,
      toolCalls: [{ id: "call_1", name: "generate_image_async", arguments: '{"scene":"beach"}' }],
    });
  });

  it("returns an empty toolCalls array for a plain content-only stream", async () => {
    const fetchMock = vi.fn(async () =>
      new Response('data: {"choices":[{"delta":{"content":"hi there"}}]}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    process.env = {
      ...oldEnv,
      CHAT_MODEL_PROVIDER: "openai",
      CHAT_MODEL_BASE_URL: "https://openai.internal.example.com/v1",
      MODERATION_PROVIDER: "mock",
    };

    const { createProviders } = await import("./providers.js");
    const providers = createProviders();
    const chunks = [];
    for await (const chunk of providers.chat.stream({
      messages: [{ role: "user", content: "hello" }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks.at(-1)).toEqual({ delta: "", done: true, toolCalls: [] });
  });

  it("MockChatModel returns supportsTools=true and reads CHAT_MOCK_TOOL_CALLS_JSON", async () => {
    process.env = {
      ...oldEnv,
      CHAT_MODEL_PROVIDER: "mock",
      MODERATION_PROVIDER: "mock",
      CHAT_MOCK_TOOL_CALLS_JSON:
        '[{"id":"m1","name":"generate_image_async","arguments":"{\\"prompt\\":\\"selfie at beach, smiling\\"}"}]',
    };

    const { createProviders } = await import("./providers.js");
    const providers = createProviders();
    expect(providers.chat.supportsTools).toBe(true);

    const chunks = [];
    for await (const chunk of providers.chat.stream({ messages: [{ role: "user", content: "hi" }] })) {
      chunks.push(chunk);
    }

    expect(chunks.at(-1)?.toolCalls).toEqual([
      { id: "m1", name: "generate_image_async", arguments: '{"prompt":"selfie at beach, smiling"}' },
    ]);
  });

  it("MockChatModel returns an empty toolCalls array when the env seam is unset", async () => {
    process.env = {
      ...oldEnv,
      CHAT_MODEL_PROVIDER: "mock",
      MODERATION_PROVIDER: "mock",
    };
    delete process.env.CHAT_MOCK_TOOL_CALLS_JSON;

    const { createProviders } = await import("./providers.js");
    const providers = createProviders();
    const chunks = [];
    for await (const chunk of providers.chat.stream({ messages: [{ role: "user", content: "hi" }] })) {
      chunks.push(chunk);
    }

    expect(chunks.at(-1)?.toolCalls).toEqual([]);
  });

  it("uses OpenAI-compatible non-stream completions for agent tool planning", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        choices: [
          {
            message: {
              content: "{\"tool\":null}",
            },
          },
        ],
      }),
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
    const completion = await providers.chat.complete({
      model: "Qwen3.5-14B-MLX-4bit",
      messages: [{ role: "user", content: "plan tools" }],
      maxTokens: 512,
    });

    expect(completion).toEqual({ content: "{\"tool\":null}" });
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as { body: string };
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      model: "Qwen3.5-14B-MLX-4bit",
      stream: false,
      max_tokens: 512,
    });
  });

  it("times out a hung OpenAI-compatible chat provider", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async (_url: URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    process.env = {
      ...oldEnv,
      CHAT_MODEL_PROVIDER: "openai",
      CHAT_MODEL_BASE_URL: "https://pipeline.internal.example.com/v1",
      CHAT_MODEL_TIMEOUT_MS: "25",
      MODERATION_PROVIDER: "mock",
    };

    const { createProviders } = await import("./providers.js");
    const providers = createProviders();
    const next = providers.chat.stream({
      messages: [{ role: "user", content: "hello" }],
    })[Symbol.asyncIterator]().next();
    const assertion = expect(next).rejects.toThrow("Chat model request timed out after 25ms");

    await vi.advanceTimersByTimeAsync(25);
    await assertion;
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
