import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { GenerateOptions } from "@deepseek-ai/dsh-llm";
import { OpenAiCompatibleAdapter } from "./openai-adapter";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

function adapterFor(baseUrl: string, fetchImpl?: typeof fetch): OpenAiCompatibleAdapter {
  return new OpenAiCompatibleAdapter({
    profile: {
      tier: "test",
      adapter: "openai-compatible-v1",
      provider: "openrouter",
      baseUrl,
      model: "deepseek/test",
      supportsTools: true,
      maxOutputTokens: 16,
      timeout: { firstTokenMs: 1_000, idleMs: 1_000 },
      sampling: {
        temperature: 0.9,
        topP: 0.95,
        repetitionPenalty: 1.05,
      },
    },
    apiKey: "provider-secret",
    openRouterProviderOnly: ["DeepSeek"],
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

async function drain(adapter: OpenAiCompatibleAdapter): Promise<void> {
  for await (const _chunk of adapter.stream({
    provider: "openrouter",
    model: "deepseek/test",
    messages: [],
  })) {
    // Drain the stream so response limits and terminal validation run.
  }
}

describe("OpenAI-compatible DSH adapter", () => {
  it("pins OpenRouter routing and preserves streamed usage and finish", async () => {
    let requestBody: Record<string, unknown> | undefined;
    let authorization = "";
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const body = [
        `data: ${JSON.stringify({
        id: "provider-request-1",
        provider: "DeepSeek",
        choices: [{ delta: { content: "Blue windows" }, finish_reason: null }],
        })}\n\n`,
        `data: ${JSON.stringify({
        id: "provider-request-1",
        choices: [{ delta: {}, finish_reason: "stop" }],
        })}\n\n`,
        `data: ${JSON.stringify({
        id: "provider-request-1",
        choices: [],
        usage: {
          prompt_tokens: 13,
          completion_tokens: 7,
          prompt_tokens_details: { cached_tokens: 3 },
          completion_tokens_details: { reasoning_tokens: 2 },
        },
        })}\n\n`,
        "data: [DONE]\n\n",
      ].join("");
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const adapter = new OpenAiCompatibleAdapter({
      profile: {
        tier: "test",
        adapter: "openai-compatible-v1",
        provider: "openai",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "deepseek/test",
        supportsTools: true,
        maxOutputTokens: 256,
        timeout: { firstTokenMs: 1_000, idleMs: 1_000 },
        sampling: {
          temperature: 0.9,
          topP: 0.95,
          repetitionPenalty: 1.05,
        },
      },
      apiKey: "provider-secret",
      openRouterProviderOnly: ["DeepSeek"],
      fetch: fetchImpl,
    });
    const options: GenerateOptions = {
      provider: "openai",
      model: "deepseek/test",
      system: "Pinned Soul",
      messages: [{
        id: "user-1" as never,
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: "Show me the observatory" }],
      }],
      tools: [{
        name: "generate_image_async",
        description: "Generate an image",
        parameters: { type: "object", properties: {} },
      }],
      maxTokens: 256,
    };
    const chunks = [];
    for await (const chunk of adapter.stream(options)) chunks.push(chunk);

    expect(authorization).toBe("Bearer provider-secret");
    expect(requestBody).toMatchObject({
      model: "deepseek/test",
      stream: true,
      temperature: 0.9,
      top_p: 0.95,
      repetition_penalty: 1.05,
      chat_template_kwargs: { enable_thinking: false },
      tool_choice: "auto",
      provider: { only: ["DeepSeek"], allow_fallbacks: false },
    });
    expect(chunks).toContainEqual({
      type: "usage",
      usage: { inputTokens: 10, outputTokens: 7, cacheReadTokens: 3, reasoningTokens: 2 },
    });
    expect(chunks.at(-1)).toMatchObject({
      type: "finish",
      reason: { kind: "stop" },
      replayState: { response: { id: "provider-request-1", provider: "DeepSeek" } },
    });
  });

  it("keeps the same conversational sampling when no tools are exposed", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const provider = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({
        id: "provider-request-dialogue",
        provider: "DeepSeek",
        choices: [{ delta: { content: "Hello" }, finish_reason: "stop" }],
      })}\n\ndata: [DONE]\n\n`);
    });
    servers.push(provider);
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("missing provider address");
    const adapter = new OpenAiCompatibleAdapter({
      profile: {
        tier: "test",
        adapter: "openai-compatible-v1",
        provider: "openrouter",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "deepseek/test",
        supportsTools: true,
        maxOutputTokens: 16,
        timeout: { firstTokenMs: 1_000, idleMs: 1_000 },
        sampling: {
          temperature: 0.9,
          topP: 0.95,
          repetitionPenalty: 1.05,
        },
      },
      apiKey: "provider-secret",
      openRouterProviderOnly: ["DeepSeek"],
    });

    for await (const _chunk of adapter.stream({
      provider: "openrouter",
      model: "deepseek/test",
      messages: [],
    })) {
      // Drain the response so the request body is observable.
    }

    expect(requestBody).toMatchObject({ temperature: 0.9 });
  });

  it("fails closed when an OpenRouter stream cannot prove finish and provider attribution", async () => {
    const responseBody = `data: ${JSON.stringify({
        id: "provider-request-2",
        choices: [{ delta: { content: "Unattributed text" }, finish_reason: "stop" }],
      })}\n\ndata: [DONE]\n\n`;
    const adapter = new OpenAiCompatibleAdapter({
      profile: {
        tier: "test",
        adapter: "openai-compatible-v1",
        provider: "openai",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "deepseek/test",
        supportsTools: true,
        maxOutputTokens: 16,
        timeout: { firstTokenMs: 1_000, idleMs: 1_000 },
        sampling: {
          temperature: 0.9,
          topP: 0.95,
          repetitionPenalty: 1.05,
        },
      },
      apiKey: "provider-secret",
      openRouterProviderOnly: ["DeepSeek"],
      fetch: (async () => new Response(responseBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as typeof fetch,
    });

    await expect((async () => {
      for await (const _chunk of adapter.stream({
        provider: "openai",
        model: "deepseek/test",
        messages: [],
      })) {
        // Drain the full provider stream so the terminal invariant is evaluated.
      }
    })()).rejects.toThrow(/attribution/);
  });

  it("rejects provider-specific terminal reasons instead of treating them as complete", async () => {
    const provider = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({
        id: "provider-request-filtered",
        provider: "DeepSeek",
        choices: [{ delta: {}, finish_reason: "content_filter" }],
      })}\n\ndata: [DONE]\n\n`);
    });
    servers.push(provider);
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("missing provider address");
    const adapter = new OpenAiCompatibleAdapter({
      profile: {
        tier: "test",
        adapter: "openai-compatible-v1",
        provider: "openrouter",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "deepseek/test",
        supportsTools: true,
        maxOutputTokens: 16,
        timeout: { firstTokenMs: 1_000, idleMs: 1_000 },
        sampling: {
          temperature: 0.9,
          topP: 0.95,
          repetitionPenalty: 1.05,
        },
      },
      apiKey: "provider-secret",
      openRouterProviderOnly: ["DeepSeek"],
    });

    await expect((async () => {
      for await (const _chunk of adapter.stream({
        provider: "openrouter",
        model: "deepseek/test",
        messages: [],
      })) {
        // Drain the stream so terminal validation runs.
      }
    })()).rejects.toThrow(/unsupported finish_reason content_filter/);
  });

  it("never includes a provider error body in the thrown failure", async () => {
    const sentinel = "PRIVATE_USER_PROMPT_SENTINEL";
    let bodyRead = false;
    let bodyCancelled = false;
    const adapter = adapterFor("http://127.0.0.1:1/v1", (async () => ({
      ok: false,
      status: 422,
      body: {
        async cancel() {
          bodyCancelled = true;
        },
      },
      async text() {
        bodyRead = true;
        return sentinel.repeat(100_000);
      },
    }) as Response) as typeof fetch);

    let thrown: unknown;
    try {
      for await (const _chunk of adapter.stream({
        provider: "openrouter",
        model: "deepseek/test",
        messages: [],
      })) {
        // Drain until the provider failure is surfaced.
      }
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("OpenAI-compatible provider returned HTTP 422");
    expect(bodyRead).toBe(false);
    expect(bodyCancelled).toBe(true);
    expect(JSON.stringify(thrown)).not.toContain(sentinel);
    expect((thrown as Error).message).not.toContain(sentinel);
  });

  it("cancels a stalled provider body when the first-token timeout fires", async () => {
    let bodyCancelled = false;
    const adapter = new OpenAiCompatibleAdapter({
      profile: {
        tier: "test",
        adapter: "openai-compatible-v1",
        provider: "openrouter",
        baseUrl: "http://127.0.0.1:1/v1",
        model: "deepseek/test",
        supportsTools: true,
        maxOutputTokens: 16,
        timeout: { firstTokenMs: 10, idleMs: 10 },
        sampling: {
          temperature: 0.9,
          topP: 0.95,
          repetitionPenalty: 1.05,
        },
      },
      apiKey: "provider-secret",
      openRouterProviderOnly: ["DeepSeek"],
      fetch: (async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => {
            try {
              controller.close();
            } catch {
              // The timeout path must already have cancelled this stream.
            }
          }, 100);
        },
        cancel() {
          bodyCancelled = true;
        },
      }), { status: 200 })) as typeof fetch,
    });

    await expect(drain(adapter)).rejects.toThrow(/timeout/);
    expect(bodyCancelled).toBe(true);
  });

  it("allows the first token until its own deadline", async () => {
    const encoder = new TextEncoder();
    const adapter = new OpenAiCompatibleAdapter({
      profile: {
        tier: "test",
        adapter: "openai-compatible-v1",
        provider: "openrouter",
        baseUrl: "http://127.0.0.1:1/v1",
        model: "deepseek/test",
        supportsTools: true,
        maxOutputTokens: 16,
        timeout: { firstTokenMs: 100, idleMs: 100 },
        sampling: {
          temperature: 0.9,
          topP: 0.95,
          repetitionPenalty: 1.05,
        },
      },
      apiKey: "provider-secret",
      openRouterProviderOnly: ["DeepSeek"],
      fetch: (async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => {
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                id: "provider-request-slow-first-token",
                provider: "DeepSeek",
                choices: [{ delta: { content: "Still here" }, finish_reason: "stop" }],
              })}\n\ndata: [DONE]\n\n`));
              controller.close();
            } catch {
              // The red implementation cancels the stream before firstTokenMs.
            }
          }, 30);
        },
      }), { status: 200 })) as typeof fetch,
    });

    await expect(drain(adapter)).resolves.toBeUndefined();
  });

  it("does not wait for a stalled provider-body cancellation after timeout", async () => {
    let bodyCancelled = false;
    const adapter = new OpenAiCompatibleAdapter({
      profile: {
        tier: "test",
        adapter: "openai-compatible-v1",
        provider: "openrouter",
        baseUrl: "http://127.0.0.1:1/v1",
        model: "deepseek/test",
        supportsTools: true,
        maxOutputTokens: 16,
        timeout: { firstTokenMs: 10, idleMs: 10 },
        sampling: {
          temperature: 0.9,
          topP: 0.95,
          repetitionPenalty: 1.05,
        },
      },
      apiKey: "provider-secret",
      openRouterProviderOnly: ["DeepSeek"],
      fetch: (async () => new Response(new ReadableStream<Uint8Array>({
        pull() {
          return new Promise(() => {});
        },
        cancel() {
          bodyCancelled = true;
          return new Promise(() => {});
        },
      }), { status: 200 })) as typeof fetch,
    });

    await expect(drain(adapter)).rejects.toThrow(/timeout/);
    expect(bodyCancelled).toBe(true);
  });

  it("aborts an SSE stream whose undelimited event exceeds the byte limit", async () => {
    const provider = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${"x".repeat(1_100_000)}`);
    });
    servers.push(provider);
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("missing provider address");
    const adapter = adapterFor(`http://127.0.0.1:${address.port}/v1`);

    await expect(drain(adapter)).rejects.toMatchObject({
      code: "PROVIDER_STREAM_LIMIT",
      message: "provider SSE event exceeded the configured byte limit",
    });
  });

  it("aborts cumulative decoded output before block state can grow without bound", async () => {
    const provider = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const delta = "y".repeat(60_000);
      for (let index = 0; index < 36; index += 1) {
        response.write(`data: ${JSON.stringify({
          id: "provider-request-limit",
          provider: "DeepSeek",
          choices: [{ delta: { content: delta }, finish_reason: null }],
        })}\n\n`);
      }
      response.end();
    });
    servers.push(provider);
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("missing provider address");
    const adapter = adapterFor(`http://127.0.0.1:${address.port}/v1`);

    await expect(drain(adapter)).rejects.toMatchObject({
      code: "PROVIDER_STREAM_LIMIT",
      message: "provider output exceeded the configured byte limit",
    });
  });
});
