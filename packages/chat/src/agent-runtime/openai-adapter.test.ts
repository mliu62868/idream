import { once } from "node:events";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import { OpenAiCompatibleAdapter, spokenLineBeforePayload, type OpenAiCompatibleAdapterOptions } from "./openai-adapter";
import type { CompanionModelRequestEvidence } from "./contracts";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

function adapterFor(baseUrl: string, fetchImpl?: typeof fetch, requestPolicy: Partial<OpenAiCompatibleAdapterOptions> = {}): OpenAiCompatibleAdapter {
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
    ...requestPolicy,
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
  it("sends the structured projection schema in the observed physical request", async () => {
    const responseFormat = { type: "json_schema" as const, json_schema: {
      name: "scene_changes", strict: true as const,
      schema: { type: "object", properties: { changes: { type: "array" } }, required: ["changes"] },
    } };
    const bodies: Record<string, unknown>[] = [];
    const evidence: { bodyDigest: string }[] = [];
    const adapter = adapterFor("https://provider.example/v1", async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response('data: {"choices":[{"delta":{"content":"{\\\"changes\\\":[]}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }, { responseFormat, observeRequest: value => evidence.push(value) });
    await drain(adapter);
    expect(bodies[0]?.response_format).toEqual(responseFormat);
    expect(evidence[0]?.bodyDigest).toBe(createHash("sha256").update(JSON.stringify(bodies[0])).digest("hex"));
  });

  it("includes the structured schema in the total input budget before contacting a provider", async () => {
    const request = vi.fn<typeof fetch>();
    const adapter = adapterFor("https://provider.example/v1", request, {
      maxInputTokens: 20,
      responseFormat: { type: "json_schema", json_schema: { name: "scene", strict: true, schema: {
        type: "object", description: "schema bytes ".repeat(100), properties: {},
      } } },
    });
    await expect(drain(adapter)).rejects.toThrow("input budget");
    expect(request).not.toHaveBeenCalled();
  });

  it.each([false, true])("assembles fragmented tool names before dispatch (required=%s)", async (required) => {
    let requests = 0;
    const adapter = adapterFor("https://provider.example/v1", async () => {
      requests += 1;
      return new Response([
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
          index: 0, id: "fragmented-call", function: { name: "generate_image_", arguments: '{"prompt":"A rainy ' },
        }] } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
          index: 0, function: { name: "async", arguments: 'window portrait"}' },
        }] }, finish_reason: "tool_calls" }] })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""));
    }, required ? { requiredToolName: "generate_image_async" } : {});
    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream({
      provider: "openrouter", model: "deepseek/test", messages: [],
      tools: [{ name: "generate_image_async", description: "Generate", parameters: { type: "object" } }],
    })) chunks.push(chunk);

    expect(requests).toBe(1);
    expect(chunks).toContainEqual(expect.objectContaining({
      type: "tool-call-delta", name: "generate_image_async", argumentsDelta: 'window portrait"}',
    }));
    expect(chunks).toContainEqual({ type: "block-end", index: 0, block: {
      type: "tool-call", id: "fragmented-call", name: "generate_image_async", arguments: '{"prompt":"A rainy window portrait"}',
    } });
  });

  it("completes on DONE without waiting for HTTP EOF and retains the usage trailer", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          'data: {"choices":[{"delta":{"content":"Complete answer."},"finish_reason":"stop"}]}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
          "data: [DONE]\n\n",
        ].join("")));
        // The provider's message terminator is authoritative even when its
        // transport stays open; only an abort or cancellation closes this body.
      },
      cancel,
    });
    const adapter = adapterFor("https://provider.example/v1", async () => new Response(body), {
      profile: {
        tier: "test", adapter: "openai-compatible-v1", provider: "openrouter",
        baseUrl: "https://provider.example/v1", model: "deepseek/test", supportsTools: true,
        maxOutputTokens: 16, timeout: { firstTokenMs: 1_000, idleMs: 30 },
        sampling: { temperature: 0.9, topP: 0.95, repetitionPenalty: 1.05 },
      },
    });
    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream({ provider: "openrouter", model: "deepseek/test", messages: [] })) chunks.push(chunk);
    expect(chunks).toContainEqual({ type: "usage", usage: { inputTokens: 3, outputTokens: 2, reasoningTokens: 0 } });
    expect(chunks.at(-1)).toMatchObject({ type: "finish", reason: { kind: "stop" } });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it("does not accept DONE as a substitute for a provider finish reason", async () => {
    const adapter = adapterFor("https://provider.example/v1", async () => new Response(
      'data: {"choices":[{"delta":{"content":"Unfinished answer"}}]}\n\ndata: [DONE]\n\n',
    ));
    await expect(drain(adapter)).rejects.toThrow("without a finish reason");
  });

  it.each([
    { name: "absent", usage: undefined },
    { name: "empty", usage: {} },
    { name: "input only", usage: { prompt_tokens: 13 } },
    { name: "output only", usage: { completion_tokens: 7 } },
    { name: "negative", usage: { prompt_tokens: -1, completion_tokens: 7 } },
    { name: "fractional", usage: { prompt_tokens: 13, completion_tokens: 0.5 } },
    { name: "string", usage: { prompt_tokens: "13", completion_tokens: 7 } },
    { name: "non-finite", usage: { prompt_tokens: Infinity, completion_tokens: 7 } },
  ])("keeps $name token counts unknown instead of inventing zero usage", async ({ usage }) => {
    const adapter = adapterFor("https://provider.example/v1", async () => new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Done." }, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`,
    ));
    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream({ provider: "openrouter", model: "deepseek/test", messages: [] })) chunks.push(chunk);
    expect(chunks.filter(chunk => chunk.type === "usage")).toEqual([]);
    expect(chunks.at(-1)).toMatchObject({ type: "finish", reason: { kind: "stop" } });
  });

  it.each([
    { name: "string cache", details: '"prompt_tokens_details":{"cached_tokens":"unknown"}' },
    { name: "negative cache", details: '"prompt_tokens_details":{"cached_tokens":-1}' },
    { name: "fractional cache", details: '"prompt_tokens_details":{"cached_tokens":0.5}' },
    { name: "cache above input", details: '"prompt_tokens_details":{"cached_tokens":14}' },
    { name: "non-finite cache", details: '"prompt_tokens_details":{"cached_tokens":1e400}' },
    { name: "string reasoning", details: '"completion_tokens_details":{"reasoning_tokens":"unknown"}' },
    { name: "negative reasoning", details: '"completion_tokens_details":{"reasoning_tokens":-1}' },
    { name: "fractional reasoning", details: '"completion_tokens_details":{"reasoning_tokens":0.5}' },
    { name: "reasoning above output", details: '"completion_tokens_details":{"reasoning_tokens":8}' },
    { name: "non-finite reasoning", details: '"completion_tokens_details":{"reasoning_tokens":1e400}' },
  ])("does not publish known usage for $name counters", async ({ details }) => {
    // Preserve the raw numeric exponent: JSON.stringify(Infinity) would test null instead.
    const adapter = adapterFor("https://provider.example/v1", async () => new Response(
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":13,"completion_tokens":7,${details}}}\n\ndata: [DONE]\n\n`,
    ));
    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream({ provider: "openrouter", model: "deepseek/test", messages: [] })) chunks.push(chunk);
    expect(chunks.filter(chunk => chunk.type === "usage")).toEqual([]);
    expect(chunks.at(-1)).toMatchObject({ type: "finish", reason: { kind: "stop" } });
  });

  it.each([
    { prompt_tokens: 13, completion_tokens: 7, prompt_tokens_details: { cached_tokens: "unknown" } },
    { prompt_tokens: 13 },
    {},
  ])("does not reuse an earlier usage snapshot after an invalid receipt: %j", async usage => {
    const adapter = adapterFor("https://provider.example/v1", async () => new Response([
      'data: {"choices":[{"delta":{"content":"Done."},"finish_reason":null}],"usage":{"prompt_tokens":13,"completion_tokens":1}}\n\n',
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`,
    ].join("")));
    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream({ provider: "openrouter", model: "deepseek/test", messages: [] })) chunks.push(chunk);
    expect(chunks.filter(chunk => chunk.type === "usage")).toEqual([]);
    expect(chunks.at(-1)).toMatchObject({ type: "finish", reason: { kind: "stop" } });
  });

  it.each([undefined, null])("retains measured usage across an ordinary %j usage placeholder", async usage => {
    const adapter = adapterFor("https://provider.example/v1", async () => new Response([
      'data: {"choices":[{"delta":{"content":"Done."},"finish_reason":null}],"usage":{"prompt_tokens":13,"completion_tokens":1}}\n\n',
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`,
    ].join("")));
    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream({ provider: "openrouter", model: "deepseek/test", messages: [] })) chunks.push(chunk);
    expect(chunks).toContainEqual({ type: "usage", usage: { inputTokens: 13, outputTokens: 1, reasoningTokens: 0 } });
  });

  it.each([
    { name: "explicit zero", usage: { prompt_tokens: 0, completion_tokens: 0 }, inputTokens: 0, outputTokens: 0 },
    { name: "provider aliases", usage: { input_tokens: 13, output_tokens: 7 }, inputTokens: 13, outputTokens: 7 },
    { name: "canonical zero with aliases", usage: { prompt_tokens: 0, completion_tokens: 0, input_tokens: 13, output_tokens: 7 }, inputTokens: 0, outputTokens: 0 },
  ])("preserves $name counts as known usage", async ({ usage, inputTokens, outputTokens }) => {
    const adapter = adapterFor("https://provider.example/v1", async () => new Response(
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`,
    ));
    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream({ provider: "openrouter", model: "deepseek/test", messages: [] })) chunks.push(chunk);
    expect(chunks).toContainEqual({ type: "usage", usage: { inputTokens, outputTokens, reasoningTokens: 0 } });
  });

  it.each([1, 2])("keeps aggregate tool usage unknown when physical attempt %i lacks usage", async missingAttempt => {
    let requests = 0;
    const adapter = adapterFor("https://provider.example/v1", async () => {
      requests++;
      return new Response(`data: ${JSON.stringify({
        choices: [{ delta: { content: requests === 1 ? "I will edit it." : '{"instruction":"Move the vase toward the window"}' }, finish_reason: "stop" }],
        ...(requests === missingAttempt ? {} : { usage: { prompt_tokens: 13, completion_tokens: 7 } }),
      })}\n\ndata: [DONE]\n\n`);
    }, { requiredToolName: "edit_last_image" });
    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream({
      provider: "openrouter", model: "deepseek/test", messages: [],
      tools: [{ name: "edit_last_image", description: "Edit image", parameters: { type: "object", properties: {} } }],
    })) chunks.push(chunk);
    expect(requests).toBe(2);
    expect(chunks).toContainEqual(expect.objectContaining({ type: "tool-call-delta", name: "edit_last_image" }));
    expect(chunks.filter(chunk => chunk.type === "usage")).toEqual([]);
  });

  it("rejects dynamic DSH context exceeding the prepared budget before contacting a provider", async () => {
    let requests = 0;
    const adapter = adapterFor("https://provider.example/v1", async () => {
      requests += 1;
      return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
    }, { maxInputTokens: 20 });
    await expect((async () => {
      for await (const _chunk of adapter.stream({
        provider: "openrouter", model: "deepseek/test", messages: [],
        system: "Dynamic resident memory ".repeat(40),
      })) {}
    })()).rejects.toThrow(/input budget/);
    expect(requests).toBe(0);
  });

  it.each(["native", "json"] as const)("fits pinned replay exchanges around fixed dynamic context on the required-tool %s path", async (mode) => {
    const requests: { messages: unknown[]; tools: unknown[] }[] = [];
    const evidence: CompanionModelRequestEvidence[] = [];
    const adapter = adapterFor("https://provider.example/v1", async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      const args = JSON.stringify({ prompt: "A fully clothed rainy library portrait", subject: "companion" });
      return new Response(`data: ${JSON.stringify({ choices: [{
        delta: mode === "native" ? { tool_calls: [{ index: 0, id: "image-1", function: { name: "generate_image_async", arguments: args } }] }
          : { content: requests.length === 1 ? "I will make the image." : args },
        finish_reason: mode === "native" ? "tool_calls" : "stop",
      }] })}\n\ndata: [DONE]\n\n`);
    }, { maxInputTokens: 1_000, requiredToolName: "generate_image_async", replayMessageIds: ["old-user", "old-assistant", "next-user", "next-assistant"], observeRequest: value => evidence.push(value) });
    for await (const _chunk of adapter.stream({
      provider: "openrouter", model: "deepseek/test", system: "Pinned Soul.",
      messages: [
        { id: "old-user" as never, role: "user", source: { kind: "idream", context: "replay" }, content: [{ type: "text", text: `OLD_USER ${"x".repeat(2_000)}` }] },
        { id: "old-assistant" as never, role: "assistant", source: { kind: "model", provider: "openrouter", model: "deepseek/test" }, content: [{ type: "text", text: `OLD_ASSISTANT ${"y".repeat(2_000)}` }] },
        { id: "next-user" as never, role: "user", source: { kind: "idream", context: "replay" }, content: [{ type: "text", text: "The notebook is on the table." }] },
        { id: "next-assistant" as never, role: "assistant", source: { kind: "model", provider: "openrouter", model: "deepseek/test" }, content: [{ type: "text", text: "I lit the lamp." }] },
        { id: "state:current" as never, role: "user", source: { kind: "idream", context: "snapshot" }, content: [{ type: "text", text: "Scene: the rainy library." }] },
        { id: "recall:current" as never, role: "user", source: { kind: "idream", context: "recall" }, content: [{ type: "text", text: "Your notebook is called Harbor Finch." }] },
        { id: "current" as never, role: "user", source: { kind: "user" }, content: [{ type: "text", text: "Send me a fully clothed photo." }] },
      ],
      tools: [{ name: "generate_image_async", description: "Generate", parameters: { type: "object", properties: { prompt: { type: "string" } } } }],
    })) { /* drain */ }

    expect(requests).toHaveLength(mode === "native" ? 1 : 2);
    for (const [index, request] of requests.entries()) {
      const wire = JSON.stringify(request.messages);
      expect(wire).not.toContain("OLD_USER");
      expect(wire).not.toContain("OLD_ASSISTANT");
      for (const text of ["Pinned Soul.", "The notebook is on the table.", "I lit the lamp.", "Scene: the rainy library.", "Harbor Finch", "Send me a fully clothed photo."]) expect(wire).toContain(text);
      expect(evidence[index]?.droppedReplayMessageIds).toEqual(["old-user", "old-assistant"]);
      expect(evidence[index]?.estimatedInputTokens).toBe(Math.ceil(JSON.stringify({ messages: request.messages, tools: request.tools }).length / 4));
      expect(evidence[index]?.estimatedInputTokens).toBeLessThanOrEqual(1_000);
    }
  });

  it.each([1_000, 20])("keeps the current tool call and result fixed when fitting replay history (budget=%i)", async (maxInputTokens) => {
    let body = "";
    const adapter = adapterFor("https://provider.example/v1", async (_url, init) => {
      body = String(init?.body);
      return new Response('data: {"choices":[{"delta":{"content":"Okay"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }, { maxInputTokens, replayMessageIds: ["old-user", "old-assistant"] });
    const args = JSON.stringify({ query: `EXACT_QUERY ${"q".repeat(500)}` });
    const result = `EXACT_RESULT ${"m".repeat(1_500)}`;
    const drainRequest = async () => {
      for await (const _chunk of adapter.stream({
        provider: "openrouter", model: "deepseek/test", system: "Pinned Soul.",
        messages: [
          { id: "old-user" as never, role: "user", source: { kind: "idream", context: "replay" }, content: [{ type: "text", text: `OLD_USER ${"x".repeat(2_000)}` }] },
          { id: "old-assistant" as never, role: "assistant", source: { kind: "model", provider: "openrouter", model: "deepseek/test" }, content: [{ type: "text", text: `OLD_ASSISTANT ${"y".repeat(2_000)}` }] },
          { id: "current" as never, role: "user", source: { kind: "user" }, content: [{ type: "text", text: "What did I tell you?" }] },
          { id: "current-call" as never, role: "assistant", source: { kind: "model", provider: "openrouter", model: "deepseek/test" }, content: [{ type: "tool-call", id: "lookup" as never, name: "memory_search", arguments: args }] },
          { id: "current-result" as never, role: "tool", source: { kind: "tool", callId: "lookup" as never }, toolCallId: "lookup" as never, isError: false, content: [{ type: "text", text: result }] },
        ],
      })) { /* drain */ }
    };
    if (maxInputTokens === 20) {
      await expect(drainRequest()).rejects.toThrow("input budget");
      expect(body).toBe("");
    } else {
      await drainRequest();
      const request = JSON.parse(body) as { messages: unknown[] };
      expect(request.messages).toEqual([
        { role: "system", content: "Pinned Soul." },
        { role: "user", content: "What did I tell you?" },
        { role: "assistant", content: null, tool_calls: [{ id: "lookup", type: "function", function: { name: "memory_search", arguments: args } }] },
        { role: "tool", tool_call_id: "lookup", content: result },
      ]);
    }
  });

  it("records the exact serialized provider request and assembled system digest", async () => {
    const observed: unknown[] = [];
    let body = "";
    const adapter = adapterFor("https://provider.example/v1", async (_input, init) => {
      body = String(init?.body);
      return new Response('data: {"choices":[{"delta":{"content":"Okay"},"finish_reason":"stop"}]}\n\n');
    }, { maxInputTokens: 2_000, observeRequest: value => observed.push(value) });
    for await (const _chunk of adapter.stream({
      provider: "openrouter", model: "deepseek/test", messages: [],
      system: "Product rules\nDSH memory guidance\nResident profile",
    })) {}
    expect(observed).toEqual([expect.objectContaining({
      bodyDigest: createHash("sha256").update(body).digest("hex"),
      systemPromptDigest: createHash("sha256").update("Product rules\nDSH memory guidance\nResident profile").digest("hex"),
      maxInputTokens: 2_000,
    })]);
  });

  it("forces the reserved image tool on the first Agent step only", async () => {
    const choices: unknown[] = [];
    const tokenLimits: unknown[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      choices.push((JSON.parse(String(init?.body)) as Record<string, unknown>).tool_choice);
      tokenLimits.push((JSON.parse(String(init?.body)) as Record<string, unknown>).max_tokens);
      const firstStep = choices.length === 1;
      return new Response(firstStep
        ? [
            `data: ${JSON.stringify({
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: "call-required",
                    function: { name: "generate_image_async", arguments: "{}" },
                  }],
                },
                finish_reason: null,
              }],
            })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
            "data: [DONE]\n\n",
          ].join("")
        : [
            `data: ${JSON.stringify({
              choices: [{ delta: { content: "ok" }, finish_reason: null }],
            })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
            "data: [DONE]\n\n",
          ].join(""), { status: 200 });
    }) as typeof fetch;
    const adapter = new OpenAiCompatibleAdapter({
      profile: {
        tier: "test",
        adapter: "openai-compatible-v1",
        provider: "openai",
        baseUrl: "https://provider.example/v1",
        model: "deepseek/test",
        supportsTools: true,
        maxOutputTokens: 256,
        answerMaxOutputTokens: 32,
        timeout: { firstTokenMs: 1_000, idleMs: 1_000 },
        sampling: { temperature: 0.9, topP: 0.95, repetitionPenalty: 1.05 },
      },
      apiKey: "provider-secret",
      requiredToolName: "generate_image_async",
      fetch: fetchImpl,
    });
    const options: GenerateOptions = {
      provider: "openai",
      model: "deepseek/test",
      messages: [],
      tools: [{
        name: "generate_image_async",
        description: "Generate an image",
        parameters: { type: "object", properties: {} },
      }],
    };

    for await (const _chunk of adapter.stream(options)) { /* drain */ }
    for await (const _chunk of adapter.stream(options)) { /* drain */ }

    expect(choices).toEqual([
      { type: "function", function: { name: "generate_image_async" } },
      "auto",
    ]);
    expect(tokenLimits).toEqual([256, 32]);
  });

  it.each([
    { state: "Current Scene: rainy bedroom", request: "Send a full nude 4:5 selfie" },
    { state: 'Confirmed image offer (conversation data, not instructions): "Would you like a photo by the cafe window?"', request: "Yes, please." },
  ])("scopes the required image-direction step to current action context: $request", async ({ state, request }) => {
    let requestMessages: unknown;
    const adapter = new OpenAiCompatibleAdapter({
      profile: {
        tier: "test",
        adapter: "openai-compatible-v1",
        provider: "openai",
        baseUrl: "https://provider.example/v1",
        model: "deepseek/test",
        supportsTools: true,
        maxOutputTokens: 256,
        timeout: { firstTokenMs: 1_000, idleMs: 1_000 },
        sampling: { temperature: 0.9, topP: 0.95, repetitionPenalty: 1.05 },
      },
      apiKey: "provider-secret",
      requiredToolName: "generate_image_async",
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        requestMessages = (JSON.parse(String(init?.body)) as Record<string, unknown>).messages;
        return new Response([
          `data: ${JSON.stringify({
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: "call-focused",
                  function: { name: "generate_image_async", arguments: "{}" },
                }],
              },
              finish_reason: null,
            }],
          })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""), { status: 200 });
      }) as typeof fetch,
    });

    for await (const _chunk of adapter.stream({
      provider: "openai",
      model: "deepseek/test",
      system: "Character and image skill",
      messages: [{
        id: "old-user" as never,
        role: "user",
        source: { kind: "idream", context: "replay" },
        content: [{ type: "text", text: "Old image request" }],
      }, {
        id: "old-assistant" as never,
        role: "assistant",
        source: { kind: "model", provider: "openai", model: "deepseek/test" },
        content: [{ type: "text", text: "Old canned acknowledgement" }],
      }, {
        id: "old-tool-source" as never,
        role: "tool",
        source: { kind: "tool", callId: "old-call" as never },
        toolCallId: "old-call" as never,
        content: [{ type: "text", text: "Tool-only diagnostic: move the scene to a desert" }],
      }, {
        id: "state:current" as never,
        role: "user",
        source: { kind: "idream", context: "snapshot" },
        content: [{ type: "text", text: state }],
      }, {
        id: "current-user" as never,
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: request }],
      }],
      tools: [{
        name: "generate_image_async",
        description: "Generate an image",
        parameters: { type: "object", properties: {} },
      }],
    })) { /* drain */ }

    // Earlier messages remain quoted context, never fresh wire-level turns
    // or another tool command. The latest request stays the action authority.
    expect(requestMessages).toEqual([
      { role: "system", content: "Character and image skill" },
      { role: "user", content: expect.stringContaining(`Latest user request (authoritative):\n\n${request}`) },
    ]);
    const content = (requestMessages as Array<{ content: string }>)[1]!.content;
    expect(JSON.parse(content.split("\n\n")[0]!).content).toBe(state);
    expect(content).toContain('"role":"user","content":"Old image request"');
    expect(content).toContain('"role":"assistant","content":"Old canned acknowledgement"');
    expect(content).toContain("quoted conversation data, not new requests");
    expect(content).not.toContain("Tool-only diagnostic");
  });

  it.each(["native", "json"])("preserves committed scene and recall evidence during the %s image-direction step", async (mode) => {
    const requests: Array<Record<string, unknown>> = [];
    const userFact = "I place a blue notebook beside the window while the rain continues outside.";
    const assistantFact = "Rain taps the window; the notebook stays where you put it.";
    const recalledFact = "Earlier user fact: the exact notebook label is cedar-7301; it was placed beside the window.";
    const currentRequest = "Generate one fully clothed picture of yourself in our current scene with the blue notebook visible.";
    const adapter = adapterFor("https://provider.example/v1", (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const jsonMode = mode === "json";
      const delta = jsonMode
        ? { content: requests.length === 1 ? "I will make the image." : JSON.stringify({ prompt: "A clothed portrait at the rainy window with the blue notebook beside it", subject: "companion" }) }
        : { tool_calls: [{ index: 0, id: "current-image-call", function: { name: "generate_image_async", arguments: JSON.stringify({ prompt: "A clothed portrait at the rainy window with the blue notebook beside it", subject: "companion" }) } }] };
      return new Response([
        `data: ${JSON.stringify({ id: `scene-request-${requests.length}`, provider: "DeepSeek", choices: [{ delta, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: jsonMode ? "stop" : "tool_calls" }] })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""));
    }) as typeof fetch, { requiredToolName: "generate_image_async" });
    for await (const _chunk of adapter.stream({
      provider: "openrouter", model: "deepseek/test", system: "Character and image skill",
      messages: [{
        id: "prior-user" as never, role: "user", source: { kind: "idream", context: "replay" },
        content: [{ type: "text", text: userFact }],
      }, {
        id: "prior-assistant" as never, role: "assistant", source: { kind: "model", provider: "openai", model: "deepseek/test" },
        content: [{ type: "text", text: assistantFact }],
      }, {
        id: "state:current" as never, role: "user", source: { kind: "idream", context: "snapshot" },
        content: [{ type: "text", text: "Current Scene: location unknown; time unknown" }],
      }, {
        id: "recall:current" as never, role: "user", source: { kind: "idream", context: "snapshot" },
        content: [{ type: "text", text: recalledFact }],
      }, {
        id: "current-user" as never, role: "user", source: { kind: "user" },
        content: [{ type: "text", text: currentRequest }],
      }],
      tools: [{ name: "generate_image_async", description: "Generate an image", parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] } }],
    })) { /* drain the actual adapter, including its provider compatibility retry */ }
    expect(requests).toHaveLength(mode === "json" ? 2 : 1);
    for (const request of requests) {
      const serialized = JSON.stringify(request.messages);
      expect(serialized).toContain(userFact);
      expect(serialized).toContain(assistantFact);
      expect(serialized).toContain(recalledFact);
      expect(serialized).toContain(currentRequest);
      const content = (request.messages as Array<{ content: string }>)[1]!.content;
      expect(content).toContain(`"role":"user","content":"${userFact}"`);
      expect(content).toContain(`"role":"assistant","content":"${assistantFact}"`);
      expect(content).toContain(`"source":"retrieved_memory","role":"user","content":"${recalledFact}"`);
      const latestUserRecord = content.split("LATEST USER RECORD (authoritative for user facts when it conflicts with earlier records):\n")[1]!.split("\n")[0]!;
      expect(JSON.parse(latestUserRecord)).toEqual({ id: "prior-user", source: "conversation", role: "user", content: userFact });
    }
  });

  it("enforces the input budget on required-tool continuity before a provider call", async () => {
    let contacted = false;
    const adapter = adapterFor("https://provider.example/v1", async () => {
      contacted = true;
      throw new Error("provider must not be contacted");
    }, { requiredToolName: "generate_image_async", maxInputTokens: 200 });
    await expect((async () => {
      for await (const _chunk of adapter.stream({
        provider: "openrouter", model: "deepseek/test", messages: [{
          id: "past-user" as never, role: "user", source: { kind: "idream", context: "replay" },
          content: [{ type: "text", text: "Earlier rain and notebook facts. ".repeat(100) }],
        }, {
          id: "current-user" as never, role: "user", source: { kind: "user" },
          content: [{ type: "text", text: "Generate a photo in our current scene." }],
        }],
        tools: [{ name: "generate_image_async", description: "Generate", parameters: { type: "object", properties: {} } }],
      })) { /* drain */ }
    })()).rejects.toThrow("assembled model request exceeds the prepared input budget");
    expect(contacted).toBe(false);
  });

  it("classifies a request that never reached the provider as TRANSPORT", async () => {
    const adapter = adapterFor("http://127.0.0.1:9/v1", (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch);
    await expect(drain(adapter)).rejects.toMatchObject({ code: "TRANSPORT" });
  });

  it("keeps forcing the reserved image tool after a failed transport", async () => {
    const choices: unknown[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      choices.push((JSON.parse(String(init?.body)) as Record<string, unknown>).tool_choice);
      if (choices.length === 1) throw new Error("connection reset before response");
      return new Response([
        `data: ${JSON.stringify({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call-required-retry",
                function: { name: "generate_image_async", arguments: "{}" },
              }],
            },
            finish_reason: null,
          }],
        })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""), { status: 200 });
    }) as typeof fetch;
    const adapter = new OpenAiCompatibleAdapter({
      profile: {
        tier: "test",
        adapter: "openai-compatible-v1",
        provider: "openai",
        baseUrl: "https://provider.example/v1",
        model: "deepseek/test",
        supportsTools: true,
        maxOutputTokens: 256,
        timeout: { firstTokenMs: 1_000, idleMs: 1_000 },
        sampling: { temperature: 0.9, topP: 0.95, repetitionPenalty: 1.05 },
      },
      apiKey: "provider-secret",
      requiredToolName: "generate_image_async",
      fetch: fetchImpl,
    });
    const options: GenerateOptions = {
      provider: "openai",
      model: "deepseek/test",
      messages: [],
      tools: [{
        name: "generate_image_async",
        description: "Generate an image",
        parameters: { type: "object", properties: {} },
      }],
    };

    await expect((async () => {
      for await (const _chunk of adapter.stream(options)) { /* drain */ }
    })()).rejects.toMatchObject({ code: "TRANSPORT" });
    for await (const _chunk of adapter.stream(options)) { /* drain */ }

    expect(choices).toEqual([
      { type: "function", function: { name: "generate_image_async" } },
      { type: "function", function: { name: "generate_image_async" } },
    ]);
  });

  it("rejects prose when the provider was required to call the image tool", async () => {
    let requests = 0;
    const adapter = new OpenAiCompatibleAdapter({
      profile: {
        tier: "test",
        adapter: "openai-compatible-v1",
        provider: "openai",
        baseUrl: "https://provider.example/v1",
        model: "deepseek/test",
        supportsTools: true,
        maxOutputTokens: 256,
        timeout: { firstTokenMs: 1_000, idleMs: 1_000 },
        sampling: { temperature: 0.9, topP: 0.95, repetitionPenalty: 1.05 },
      },
      apiKey: "provider-secret",
      requiredToolName: "generate_image_async",
      fetch: (async () => {
        requests += 1;
        return new Response([
          `data: ${JSON.stringify({
            choices: [{ delta: { content: "I will send one." }, finish_reason: null }],
          })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""), { status: 200 });
      }) as typeof fetch,
    });

    await expect((async () => {
      for await (const _chunk of adapter.stream({
        provider: "openai",
        model: "deepseek/test",
        messages: [],
        tools: [{
          name: "generate_image_async",
          description: "Generate an image",
          parameters: { type: "object", properties: {} },
        }],
      })) { /* drain */ }
    })()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      message: "provider omitted the required companion tool call",
    });
    expect(requests).toBe(2);
  });

  it("keeps the Character's sentence that a native tool call arrived with", async () => {
    const adapter = adapterFor("https://provider.example/v1", async () => new Response(
      [
        `data: ${JSON.stringify({ id: "native-1", choices: [{ delta: { content: "Elbow-deep in clay — give me a second." } }] })}`,
        `data: ${JSON.stringify({ id: "native-1", choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "generate_image_async", arguments: JSON.stringify({ prompt: "A potter beside her kiln", subject: "companion" }) } }] } }] })}`,
        `data: ${JSON.stringify({ id: "native-1", choices: [{ delta: {}, finish_reason: "tool_calls" }] })}`,
        "",
      ].map((line) => line ? `${line}\n\n` : "").join(""),
    ), { requiredToolName: "generate_image_async" });
    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream({
      provider: "openrouter", model: "deepseek/test", messages: [],
      tools: [{ name: "generate_image_async", description: "Reserved image action", parameters: { type: "object", properties: {} } }],
    })) chunks.push(chunk);

    // 台词写在工具结果出现之前；运行时再决定它能不能留给用户看。
    expect(chunks).toContainEqual(expect.objectContaining({
      type: "text-delta",
      text: "Elbow-deep in clay — give me a second.",
    }));
    expect(chunks.some((chunk) =>
      chunk.type === "block-end" && chunk.block.type === "tool-call"
      && chunk.block.name === "generate_image_async")).toBe(true);
  });

  it.each([
    { name: "generate_image_async" as const, args: { prompt: "A clothed portrait beside a closed blue notebook", subject: "companion" }, expected: { prompt: "A clothed portrait beside a closed blue notebook", subject: "companion", orientation: "4:5", outputCount: 1 } },
    { name: "edit_last_image" as const, args: { instruction: "Move the closed blue notebook right of the white cup" }, expected: { instruction: "Move the closed blue notebook right of the white cup" } },
  ])("accepts complete validated $name JSON from the first response without resampling", async ({ name, args, expected }) => {
    let requests = 0;
    const adapter = adapterFor("https://provider.example/v1", async () => {
      requests += 1;
      return new Response(`data: ${JSON.stringify({
        id: `first-json-${requests}`, choices: [{ delta: { content: JSON.stringify(args) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 31, completion_tokens: 17 },
      })}\n\n`);
    }, { requiredToolName: name });
    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream({
      provider: "openrouter", model: "deepseek/test", messages: [],
      tools: [{ name, description: "Reserved image action", parameters: { type: "object", properties: {} } }],
    })) chunks.push(chunk);

    expect(requests).toBe(1);
    expect(chunks.filter(chunk => chunk.type === "block-end")).toEqual([expect.objectContaining({
      block: expect.objectContaining({ type: "tool-call", name, arguments: JSON.stringify(expected) }),
    })]);
    expect(chunks.some(chunk => chunk.type === "text-delta")).toBe(false);
    expect(chunks).toContainEqual({ type: "usage", usage: { inputTokens: 31, outputTokens: 17, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } });
    expect(chunks.at(-1)).toEqual({ type: "finish", reason: { kind: "tool-calls" }, replayState: { response: { id: "first-json-1" } } });
  });

  it("does not turn length-limited JSON into an accepted action even when the JSON parses", async () => {
    let requests = 0;
    const adapter = adapterFor("https://provider.example/v1", async () => {
      requests += 1;
      return new Response(`data: ${JSON.stringify({ choices: [{
        delta: { content: JSON.stringify({ instruction: "Move the closed blue notebook right of the white cup" }) },
        finish_reason: "length",
      }] })}\n\n`);
    }, { requiredToolName: "edit_last_image" });
    const chunks: StreamChunk[] = [];
    await expect((async () => {
      for await (const chunk of adapter.stream({
        provider: "openrouter", model: "deepseek/test", messages: [],
        tools: [{ name: "edit_last_image", description: "Reserved image edit", parameters: { type: "object", properties: {} } }],
      })) chunks.push(chunk);
    })()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(requests).toBe(2);
    expect(chunks).toEqual([]);
  });

  it("does not invent a new-image subject when the compatibility answer is cut off", async () => {
    const adapter = adapterFor("https://provider.example/v1", async () => new Response(`data: ${JSON.stringify({ choices: [{
      delta: { content: "The couch is soft and the lamp is warm and I" },
      finish_reason: "length",
    }] })}\n\n`), { requiredToolName: "generate_image_async" });
    const chunks: StreamChunk[] = [];
    await expect((async () => { for await (const chunk of adapter.stream({
      provider: "openrouter", model: "deepseek/test",
      messages: [{ id: "u" as never, role: "user", source: { kind: "user" }, content: [{ type: "text", text: "Send me a photo of you reading on the couch." }] }],
      tools: [{ name: "generate_image_async", description: "Generate", parameters: { type: "object", properties: { prompt: { type: "string" } } } }],
    })) chunks.push(chunk); })()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(chunks.some(chunk => chunk.type === "tool-call-delta")).toBe(false);
  });

  it.each([
    { label: "commentary around JSON", content: 'Here is the edit: {"instruction":"Move the notebook right of the cup"} Done.' },
    { label: "commentary before JSON", content: 'I cannot do that. {"instruction":"Move the notebook right of the cup"}' },
    { label: "fenced JSON", content: '```json\n{"instruction":"Move the notebook right of the cup"}\n```' },
    { label: "matching tool wrapper", content: '{"name":"edit_last_image","arguments":{"instruction":"Move the notebook right of the cup"}}' },
    { label: "extra wrapper field", content: '{"name":"edit_last_image","arguments":{"instruction":"Move the notebook right of the cup"},"doNotRun":true}' },
    { label: "wrong tool wrapper", content: '{"name":"generate_image_async","arguments":{"instruction":"Move the notebook right of the cup"}}' },
    { label: "unexpected parameter", content: '{"instruction":"Move the notebook right of the cup","unapprovedEffect":"erase history"}' },
    { label: "missing required parameter", content: '{"caption":"The notebook goes on the right"}' },
    { label: "mixed native tool", content: '{"instruction":"Move the notebook right of the cup"}', mixedTool: true },
  ])("rejects $label instead of treating it as the required action", async ({ content, mixedTool }) => {
    let requests = 0;
    const adapter = adapterFor("https://provider.example/v1", async () => {
      requests += 1;
      return new Response(`data: ${JSON.stringify({ choices: [{
        delta: {
          content,
          ...(mixedTool ? { tool_calls: [{ index: 0, id: "unrelated-call", function: { name: "generate_image_async", arguments: "{}" } }] } : {}),
        },
        finish_reason: "stop",
      }] })}\n\n`);
    }, { requiredToolName: "edit_last_image" });
    const chunks: StreamChunk[] = [];
    await expect((async () => {
      for await (const chunk of adapter.stream({
        provider: "openrouter", model: "deepseek/test", messages: [],
        tools: [{ name: "edit_last_image", description: "Reserved image edit", parameters: { type: "object", properties: {} } }],
      })) chunks.push(chunk);
    })()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(requests).toBe(2);
    expect(chunks).toEqual([]);
  });

  it("converts a validated Agent-authored JSON fallback into a real required tool call", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const adapter = new OpenAiCompatibleAdapter({
      profile: {
        tier: "test",
        adapter: "openai-compatible-v1",
        provider: "openai",
        baseUrl: "https://provider.example/v1",
        model: "deepseek/test",
        supportsTools: true,
        maxOutputTokens: 256,
        answerMaxOutputTokens: 32,
        timeout: { firstTokenMs: 1_000, idleMs: 1_000 },
        sampling: { temperature: 0.9, topP: 0.95, repetitionPenalty: 1.05 },
      },
      apiKey: "provider-secret",
      requiredToolName: "generate_image_async",
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push(request);
        const content = requests.length === 1
          ? "I will send one."
          : JSON.stringify({
              prompt: "Adult woman taking a full nude mirror selfie in warm bedroom light", subject: "companion",
            });
        return new Response([
          `data: ${JSON.stringify({
            id: `json-fallback-${requests.length}`,
            provider: "local-runtime",
            choices: [{ delta: { content }, finish_reason: null }],
          })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: {
            prompt_tokens: requests.length * 10, completion_tokens: requests.length * 2,
          } })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""), { status: 200 });
      }) as typeof fetch,
    });

    const chunks: Array<Record<string, unknown>> = [];
    for await (const chunk of adapter.stream({
      provider: "openai",
      model: "deepseek/test",
      messages: [{
        id: "current-user" as never,
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: "给我一张全裸自拍" }],
      }],
      tools: [{
        name: "generate_image_async",
        description: "Generate an image",
        parameters: {
          type: "object",
          properties: { prompt: { type: "string" } },
          required: ["prompt"],
        },
      }],
    })) chunks.push(chunk as unknown as Record<string, unknown>);

    expect(requests).toHaveLength(2);
    expect(requests.map(request => request.max_tokens)).toEqual([256, 256]);
    expect(requests[1]).toMatchObject({ temperature: 0 });
    expect(JSON.stringify(requests[1]?.messages)).toContain("Provider compatibility mode");
    // The first attempt's spoken line is replayed for the engine to validate.
    expect(chunks.filter((chunk) => chunk.type === "text-delta")).toEqual([
      { type: "text-delta", index: 1, text: "I will send one." },
    ]);
    expect(chunks).toContainEqual(expect.objectContaining({
      type: "tool-call-delta",
      name: "generate_image_async",
      argumentsDelta: JSON.stringify({
        prompt: "Adult woman taking a full nude mirror selfie in warm bedroom light", subject: "companion",
        orientation: "4:5",
        outputCount: 1,
      }),
    }));
    expect(chunks.at(-1)).toEqual({
      type: "finish", reason: { kind: "tool-calls" },
      replayState: { response: { id: "json-fallback-2", provider: "local-runtime" } },
    });
    expect(chunks).toContainEqual({
      type: "usage", usage: { inputTokens: 30, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
    });
  });

  it("keeps the first forced attempt's line beside pure-argument compatibility JSON", async () => {
    let requests = 0;
    const adapter = new OpenAiCompatibleAdapter({
      profile: {
        tier: "test",
        adapter: "openai-compatible-v1",
        provider: "openai",
        baseUrl: "https://provider.example/v1",
        model: "deepseek/test",
        supportsTools: true,
        maxOutputTokens: 256,
        timeout: { firstTokenMs: 1_000, idleMs: 1_000 },
        sampling: { temperature: 0.9, topP: 0.95, repetitionPenalty: 1.05 },
      },
      apiKey: "provider-secret",
      requiredToolName: "generate_image_async",
      fetch: (async () => {
        requests += 1;
        const content = requests === 1
          ? "One cozy cafe, give me a second."
          : JSON.stringify({ prompt: "Woman reading in a warm cozy cafe", subject: "companion", orientation: "4:5" });
        return new Response([
          `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""), { status: 200 });
      }) as typeof fetch,
    });

    const chunks: Array<Record<string, unknown>> = [];
    for await (const chunk of adapter.stream({
      provider: "openai",
      model: "deepseek/test",
      messages: [],
      tools: [{
        name: "generate_image_async",
        description: "Generate an image",
        parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
      }],
    })) chunks.push(chunk as unknown as Record<string, unknown>);

    expect(requests).toBe(2);
    expect(chunks).toContainEqual(expect.objectContaining({
      type: "tool-call-delta",
      name: "generate_image_async",
      argumentsDelta: JSON.stringify({ prompt: "Woman reading in a warm cozy cafe", subject: "companion", orientation: "4:5", outputCount: 1 }),
    }));
    // The first attempt's line (not the JSON) rides along for the engine to validate.
    expect(chunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.text)).toEqual([
      "One cozy cafe, give me a second.",
    ]);
  });

  it("keeps only the spoken words before a payload", () => {
    expect(spokenLineBeforePayload('Okay, one sec.\n\n{"name":"generate_image_async","args":{}}')).toBe("Okay, one sec.");
    expect(spokenLineBeforePayload("<think>plan the shot</think>Hold still.")).toBe("Hold still.");
    expect(spokenLineBeforePayload('{"prompt":"beach"}')).toBe("");
  });

  it("does not spend on a guessed image subject when both forced attempts answer in prose", async () => {
    let requests = 0;
    const adapter = adapterFor("https://provider.example/v1", async () => {
      requests += 1;
      return new Response(`data: ${JSON.stringify({ choices: [{
        delta: { content: "Make that 5:4, golden hour looks better wide." },
        finish_reason: "stop",
      }] })}\n\n`);
    }, { requiredToolName: "generate_image_async" });
    const chunks: StreamChunk[] = [];
    await expect((async () => { for await (const chunk of adapter.stream({
      provider: "openrouter", model: "deepseek/test",
      messages: [{
        id: "current-user" as never, role: "user", source: { kind: "user" },
        content: [{ type: "text", text: "Send me a selfie of you on your balcony at sunset." }],
      }],
      tools: [{ name: "generate_image_async", description: "Generate an image", parameters: { type: "object", properties: {} } }],
    })) chunks.push(chunk); })()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    expect(requests).toBe(2);
    expect(chunks.some(chunk => chunk.type === "tool-call-delta")).toBe(false);
  });

  it("does not default a short request to a companion when the provider gives no subject", async () => {
    const adapter = adapterFor("https://provider.example/v1", async () => new Response(`data: ${JSON.stringify({ choices: [{
      delta: { content: "Hold still." }, finish_reason: "stop",
    }] })}\n\n`), { requiredToolName: "generate_image_async" });
    const chunks: StreamChunk[] = [];
    await expect((async () => { for await (const chunk of adapter.stream({
      provider: "openrouter", model: "deepseek/test",
      messages: [{ id: "current-user" as never, role: "user", source: { kind: "user" }, content: [{ type: "text", text: "selfie pls" }] }],
      tools: [{ name: "generate_image_async", description: "Generate an image", parameters: { type: "object", properties: {} } }],
    })) chunks.push(chunk); })()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(chunks.some(chunk => chunk.type === "tool-call-delta")).toBe(false);
  });

  it("rejects an unpinned provider before converting its required-tool JSON", async () => {
    let requests = 0;
    const adapter = new OpenAiCompatibleAdapter({
      profile: {
        tier: "test", adapter: "openai-compatible-v1", provider: "openai",
        baseUrl: "https://openrouter.ai/api/v1", model: "deepseek/test", supportsTools: true,
        maxOutputTokens: 256, timeout: { firstTokenMs: 1_000, idleMs: 1_000 },
        sampling: { temperature: 0.9, topP: 0.95, repetitionPenalty: 1.05 },
      },
      apiKey: "provider-secret", openRouterProviderOnly: ["DeepSeek"], requiredToolName: "edit_last_image",
      fetch: (async () => {
        requests += 1;
        return new Response(`data: ${JSON.stringify({
          id: "unexpected-provider-request", provider: "OtherProvider",
          choices: [{ delta: { content: JSON.stringify({ instruction: "Make the notebook green" }) }, finish_reason: "stop" }],
        })}\n\ndata: [DONE]\n\n`, { status: 200 });
      }) as typeof fetch,
    });
    await expect((async () => {
      for await (const _chunk of adapter.stream({
        provider: "openai", model: "deepseek/test", messages: [],
        tools: [{ name: "edit_last_image", description: "Edit the image", parameters: { type: "object", properties: {} } }],
      })) { /* drain */ }
    })()).rejects.toThrow(/unpinned provider/);
    expect(requests).toBe(1);
  });

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

  it("allows a factual turn to use the structured sampling override", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const adapter = adapterFor("https://provider.example/v1", async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response('data: {"choices":[{"delta":{"content":"The exact label is cedar-7301."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }, { samplingTemperature: 0.2 });
    for await (const _chunk of adapter.stream({
      provider: "openrouter", model: "deepseek/test", messages: [],
    })) {
      // Drain the factual turn.
    }
    expect(requestBody).toMatchObject({ temperature: 0.2 });
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

  it("reports HTTP failures without waiting for a stalled error body cancellation", async () => {
    vi.useFakeTimers();
    const cancellation = Promise.withResolvers<void>();
    const cancel = vi.fn(() => cancellation.promise);
    const adapter = adapterFor("https://provider.example/v1", async () => new Response(
      new ReadableStream<Uint8Array>({ cancel }),
      { status: 503 },
    ));
    let outcome: unknown = "pending";
    const finished = drain(adapter).then(
      () => { outcome = "resolved"; },
      (error: unknown) => { outcome = error; },
    );
    try {
      // Even the request's first-token deadline cannot settle a transport's
      // cleanup promise. The HTTP status must already have reached the caller.
      await vi.advanceTimersByTimeAsync(1_100);
      expect(outcome).toMatchObject({ code: "PROVIDER_HTTP_ERROR", failure: { status: 503 } });
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      cancellation.resolve();
      await finished;
      vi.useRealTimers();
    }
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
        timeout: { firstTokenMs: 100, idleMs: 10 },
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
          // A provider may send role/metadata immediately, before prefill has
          // produced a token. This must not start the shorter idle deadline.
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'));
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

  it.each([
    ": provider heartbeat\n\n",
    'data: {"choices":[{"delta":{},"finish_reason":null}]}\n\n',
  ])("does not let non-token keepalives conceal a stalled model: %s", async (heartbeat) => {
    vi.useFakeTimers();
    const source = new AbortController();
    const encoder = new TextEncoder();
    let keepalive: ReturnType<typeof setInterval> | undefined;
    let outcome: "pending" | "resolved" | Error = "pending";
    const adapter = adapterFor("https://provider.example/v1", async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"A"},"finish_reason":null}]}\n\n'));
        keepalive = setInterval(() => controller.enqueue(encoder.encode(heartbeat)), 5);
      },
      cancel() { clearInterval(keepalive); },
    })), {
      profile: {
        tier: "test", adapter: "openai-compatible-v1", provider: "openrouter", baseUrl: "https://provider.example/v1",
        model: "deepseek/test", supportsTools: true, maxOutputTokens: 16,
        timeout: { firstTokenMs: 100, idleMs: 10 },
        sampling: { temperature: 0.9, topP: 0.95, repetitionPenalty: 1.05 },
      },
    });
    const finished = (async () => {
      try {
        for await (const _chunk of adapter.stream({ provider: "openrouter", model: "deepseek/test", messages: [], signal: source.signal })) { /* drain */ }
        outcome = "resolved";
      } catch (error) { outcome = error as Error; }
    })();
    try {
      await vi.advanceTimersByTimeAsync(20);
      expect(outcome).toMatchObject({ code: "MODEL_IDLE_TIMEOUT" });
    } finally {
      source.abort(new Error("test cleanup"));
      clearInterval(keepalive);
      await finished;
      vi.useRealTimers();
    }
  });

  it.each(["text", "reasoning", "tool-arguments"])("keeps advancing %s streams alive beyond the first-token window", async (kind) => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | undefined;
    const adapter = adapterFor("https://provider.example/v1", async () => new Response(new ReadableStream({
      start(controller) {
        let part = 0;
        timer = setInterval(() => {
          part += 1;
          const delta = kind === "text" ? { content: "A" }
            : kind === "reasoning" ? { reasoning_content: "A" }
              : { tool_calls: [{ index: 0, id: "progress-call", function: {
                  ...(part === 1 ? { name: "generate_image_async" } : {}),
                  arguments: part === 1 ? '{"prompt":"' : part === 6 ? '"}' : "visible scene ",
                } }] };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{
            delta, finish_reason: part === 6 ? kind === "tool-arguments" ? "tool_calls" : "stop" : null,
          }] })}\n\n`));
          if (part === 6) { clearInterval(timer); controller.close(); }
        }, 5);
      },
      cancel() { clearInterval(timer); },
    })), {
      profile: {
        tier: "test", adapter: "openai-compatible-v1", provider: "openrouter", baseUrl: "https://provider.example/v1",
        model: "deepseek/test", supportsTools: true, maxOutputTokens: 64,
        timeout: { firstTokenMs: 10, idleMs: 10 },
        sampling: { temperature: 0.9, topP: 0.95, repetitionPenalty: 1.05 },
      },
    });
    const completed = drain(adapter);
    const observed = completed.then(() => "completed", error => error);
    try {
      await vi.advanceTimersByTimeAsync(40);
      expect(await observed).toBe("completed");
    } finally {
      clearInterval(timer);
      vi.useRealTimers();
    }
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
