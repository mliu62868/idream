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

describe("OpenAI-compatible DSH adapter", () => {
  it("pins OpenRouter routing and preserves streamed usage and finish", async () => {
    let requestBody: Record<string, unknown> | undefined;
    let authorization = "";
    const provider = createServer(async (request, response) => {
      authorization = request.headers.authorization ?? "";
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({
        id: "provider-request-1",
        provider: "DeepSeek",
        choices: [{ delta: { content: "Blue windows" }, finish_reason: null }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: "provider-request-1",
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: "provider-request-1",
        choices: [],
        usage: {
          prompt_tokens: 13,
          completion_tokens: 7,
          prompt_tokens_details: { cached_tokens: 3 },
          completion_tokens_details: { reasoning_tokens: 2 },
        },
      })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
    servers.push(provider);
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("missing provider address");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;

    const adapter = new OpenAiCompatibleAdapter({
      profile: {
        tier: "test",
        adapter: "openai-compatible-v1",
        provider: "openrouter",
        baseUrl,
        model: "deepseek/test",
        supportsTools: true,
        maxOutputTokens: 256,
        timeout: { firstTokenMs: 1_000, idleMs: 1_000, completionMs: 5_000 },
        sampling: {
          temperature: 0.9,
          topP: 0.95,
          repetitionPenalty: 1.05,
          structuredTemperature: 0.2,
        },
      },
      apiKey: "provider-secret",
      openRouterProviderOnly: ["DeepSeek"],
    });
    const options: GenerateOptions = {
      provider: "openrouter",
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

  it("fails closed when an OpenRouter stream cannot prove finish and provider attribution", async () => {
    const provider = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({
        id: "provider-request-2",
        choices: [{ delta: { content: "Unattributed text" }, finish_reason: null }],
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
        timeout: { firstTokenMs: 1_000, idleMs: 1_000, completionMs: 5_000 },
        sampling: {
          temperature: 0.9,
          topP: 0.95,
          repetitionPenalty: 1.05,
          structuredTemperature: 0.2,
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
        // Drain the full provider stream so the terminal invariant is evaluated.
      }
    })()).rejects.toThrow(/finish reason/);
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
        timeout: { firstTokenMs: 1_000, idleMs: 1_000, completionMs: 5_000 },
        sampling: {
          temperature: 0.9,
          topP: 0.95,
          repetitionPenalty: 1.05,
          structuredTemperature: 0.2,
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
});
