import { once } from "node:events";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModels, isContextOverflow, normalizeContext, type AssistantMessageEvent, type Tool } from "@earendil-works/pi-ai";
import type { InvocationOptions } from "./openai-adapter";
import type { ModelInputMessage } from "./model-request-format";
import { formatCompanionMessages } from "./pi-context";
import { OpenAiCompatibleAdapter, type OpenAiCompatibleAdapterOptions } from "./openai-adapter";
import type { CompanionModelRequestEvidence } from "./contracts";

interface RequestFixture extends InvocationOptions {
  messages: readonly ModelInputMessage[];
  systemPrompt?: string;
  tools?: readonly Tool[];
  pinned?: readonly ModelInputMessage[];
}

async function* streamRequest(adapter: OpenAiCompatibleAdapter, request: RequestFixture): AsyncIterable<AssistantMessageEvent> {
  const { messages, pinned = [], systemPrompt = "", tools = [], ...options } = request;
  for await (const event of adapter.stream(formatCompanionMessages(messages, pinned, systemPrompt, tools, "character-1"), options)) {
    if (event.type === "error") {
      const error = adapter.getError(event.error);
      if (error?.code === "CONTEXT_WINDOW_EXCEEDED") expect(isContextOverflow(event.error)).toBe(true);
      throw error ?? new Error(event.error.errorMessage);
    }
    yield event;
  }
}

function terminal(events: readonly AssistantMessageEvent[]) {
  const event = events.at(-1);
  if (event?.type !== "done") throw new Error("Provider did not produce a native terminal event");
  return event.message;
}

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
  for await (const _chunk of streamRequest(adapter, { messages: [] })) {
    // Drain the stream so response limits and terminal validation run.
  }
}

describe("OpenAI-compatible Pi adapter", () => {
  it("waits for durable dispatch evidence before making the physical request", async () => {
    const gate = Promise.withResolvers<void>();
    const request = vi.fn(async () => new Response('data: {"choices":[{"delta":{"content":"Done."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
    const observeRequest = vi.fn(() => gate.promise);
    const adapter = adapterFor("https://provider.example/v1", request, { observeRequest });
    const running = drain(adapter);
    await vi.waitFor(() => expect(observeRequest).toHaveBeenCalledOnce());
    expect(request).not.toHaveBeenCalled();
    gate.resolve();
    await running;
    expect(request).toHaveBeenCalledOnce();
  });

  it("does not send or report usage when dispatch evidence cannot be persisted", async () => {
    const request = vi.fn(), observeUsage = vi.fn();
    const adapter = adapterFor("https://provider.example/v1", request, {
      observeRequest: async () => { throw new Error("journal write failed"); }, observeUsage,
    });
    await expect(drain(adapter)).rejects.toThrow("journal write failed");
    expect(request).not.toHaveBeenCalled();
    expect(observeUsage).not.toHaveBeenCalled();
  });

  it("preserves measured totals when the provider omits the reasoning subtotal", async () => {
    const adapter = adapterFor("https://provider.example/v1", async () => new Response(
      'data: {"choices":[{"delta":{"reasoning_content":"Private thought","content":"Done."},"finish_reason":"stop"}],"usage":{"prompt_tokens":13,"completion_tokens":7}}\n\ndata: [DONE]\n\n'));
    const chunks = [];
    for await (const chunk of streamRequest(adapter, { messages: [] })) chunks.push(chunk);
    expect(adapter.getUsage(terminal(chunks))).toEqual({ inputTokens: 13, outputTokens: 7 });
  });

  it.each([
    { requestLimit: undefined, thinkingLimit: 1_024 },
    { requestLimit: 512, thinkingLimit: 512 },
    { requestLimit: 128, thinkingLimit: 128 },
    { requestLimit: 2_048, thinkingLimit: 1_024 },
  ])("uses the shared thinking budget and explicit request cap: $requestLimit", async ({ requestLimit, thinkingLimit }) => {
    const bodies: Array<Record<string, unknown>> = [];
    const adapter = adapterFor("https://provider.example/v1", async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response('data: {"choices":[{"delta":{"content":"Done."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }, { profile: {
      tier: "test", adapter: "openai-compatible-v1", provider: "local", baseUrl: "https://provider.example/v1",
      model: "fixture", supportsTools: true, maxOutputTokens: 1_024, answerMaxOutputTokens: 256,
      timeout: { firstTokenMs: 1_000, idleMs: 1_000 }, sampling: { temperature: 0.9, topP: 0.95, repetitionPenalty: 1.05 },
    } });
    const messages = [{ id: "now", sourceKind: "current_user" as const, role: "user" as const, content: "Current question" }];
    for await (const _event of streamRequest(adapter, { messages, maxTokens: requestLimit })) { /* drain */ }
    expect(bodies[0]).toMatchObject({ max_tokens: thinkingLimit, chat_template_kwargs: { enable_thinking: true } });
    expect(bodies[0]).not.toHaveProperty("thinking_budget");
    for await (const _event of streamRequest(adapter, { messages, purpose: "compaction", maxTokens: requestLimit })) { /* drain */ }
    expect(bodies[1]).toMatchObject({ max_tokens: requestLimit ?? 1_024, chat_template_kwargs: { enable_thinking: false } });
    expect(bodies[1]).not.toHaveProperty("thinking_budget");
  });

  it.each([false, true])("keeps tool evidence with companion thinking enabled (%s)", async currentResult => {
    const bodies: Array<Record<string, unknown>> = [];
    const adapter = adapterFor("https://provider.example/v1", async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response('data: {"choices":[{"delta":{"content":"The original wording."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    const roundTrip: ModelInputMessage[] = [
      { id: "read", sourceKind: "plugin", role: "assistant", content: "", tool_calls: [
        { id: "read-1", type: "function", function: { name: "session_recall", arguments: "{}" } },
      ] },
      { id: "read-result", sourceKind: "plugin", role: "tool", tool_call_id: "read-1", content: "The original wording." },
    ];
    const current: ModelInputMessage = { id: "current", sourceKind: "current_user", role: "user", content: "Quote the original wording." };
    for await (const _event of streamRequest(adapter, { messages: currentResult ? [current, ...roundTrip] : [...roundTrip, current] })) { /* drain */ }
    expect(bodies[0]).toMatchObject({ max_tokens: 16, chat_template_kwargs: { enable_thinking: true } });
    expect(bodies[0]).not.toHaveProperty("thinking_budget");
    expect(bodies[0]!.messages).toContainEqual({ role: "tool", tool_call_id: "read-1", content: "The original wording." });
  });

  it("runs through Pi Models with the pinned capacity and explicit compaction policy", async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: string }>; temperature: number; max_tokens: number }> = [];
    const adapter = adapterFor("https://provider.example/v1", async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response('data: {"choices":[{"delta":{"content":"Complete."},"finish_reason":"stop"}],"usage":{"prompt_tokens":13,"completion_tokens":7}}\n\ndata: [DONE]\n\n');
    }, { maxInputTokens: 2_000 });
    const provider = adapter.asProvider();
    const models = createModels();
    models.setProvider(provider);
    const model = models.getModel("openrouter", "deepseek/test")!;
    expect(model.contextWindow).toBe(2_016);
    expect(model.reasoning).toBe(false);
    const context = normalizeContext({ systemPrompt: "Pinned Soul", messages: [{ role: "user", content: "Current request", timestamp: 1 }] });
    const result = await models.completeSimple(model, context, { maxTokens: 9 });
    expect(result.stopReason).toBe("stop");
    expect(adapter.getAttribution(result)).toBeUndefined();
    expect(adapter.getUsage(result)).toMatchObject({ inputTokens: 13, outputTokens: 7 });
    expect(bodies.at(-1)).toMatchObject({ messages: [{ role: "system", content: "Pinned Soul" }, { role: "user", content: "Current request" }], max_tokens: 9, temperature: 0.9 });

    await adapter.asProvider({ purpose: "compaction" }).stream(model, context, { maxTokens: 19 }).result();
    expect(bodies.at(-1)).toMatchObject({ max_tokens: 19, temperature: 0 });
    const mismatched = await provider.stream({ ...model, id: "different-model" }, context).result();
    expect(adapter.getError(mismatched)).toMatchObject({ code: "INVALID_ROUTE" });
    expect(bodies).toHaveLength(2);
  });

  it("uses Pi's current system sections and tool additions and removals on the physical request", async () => {
    let body = "";
    const evidence: CompanionModelRequestEvidence[] = [];
    const adapter = adapterFor("https://provider.example/v1", async (_url, init) => {
      body = String(init?.body);
      return new Response('data: {"choices":[{"delta":{"content":"Done."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }, { observeRequest: value => { evidence.push(value); } });
    const context = normalizeContext({ systemPrompt: "Pinned Soul", tools: [{ name: "old_tool", description: "Old", parameters: { type: "object" } }], messages: [] });
    const result = await adapter.stream([...context.messages, {
      role: "system", content: "Runtime guidance", sections: { state: "Current state" }, timestamp: 1,
      toolsRemoved: [{ name: "old_tool" }], toolsAdded: [{ name: "new_tool", description: "Current", parameters: { type: "object" } }],
    }]).result();
    expect(result.stopReason).toBe("stop");
    const wire = JSON.parse(body) as { messages: Array<{ content: string }>; tools: Array<{ function: { name: string } }> };
    expect(wire.messages[0]!.content).toContain("Pinned Soul");
    expect(wire.messages[0]!.content).toContain("Runtime guidance");
    expect(wire.messages[0]!.content).toContain("Current state");
    expect(wire.tools.map(tool => tool.function.name)).toEqual(["new_tool"]);
    expect(evidence[0]!.bodyDigest).toBe(createHash("sha256").update(body).digest("hex"));
    expect(evidence[0]!.systemPromptDigest).toBe(createHash("sha256").update(wire.messages[0]!.content).digest("hex"));
  });

  it.each([undefined, { prompt_tokens: 13, completion_tokens: 7 }])("observes each rejected physical request once, with its actual usage receipt: %j", async usage => {
    const observeUsage = vi.fn();
    const adapter = adapterFor("https://provider.example/v1", async () => new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Rejected." }, finish_reason: "content_filter" }], usage })}\n\ndata: [DONE]\n\n`,
    ), { observeUsage });
    const result = await adapter.stream([]).result();
    const expected = usage ? { inputTokens: 13, outputTokens: 7 } : undefined;
    expect(adapter.getError(result)).toMatchObject({ code: "INVALID_RESPONSE" });
    expect(observeUsage).toHaveBeenCalledExactlyOnceWith(expected, expect.objectContaining({
      bodyDigest: expect.stringMatching(/^[a-f0-9]{64}$/), systemPromptDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      estimatedInputTokens: expect.any(Number),
    }));
    expect(adapter.getUsage(result)).toEqual(expected);
    // Persisted Pi counters cannot substitute for a measured receipt.
    expect(adapter.getUsage(structuredClone(result))).toBeUndefined();
  });

  it("retains usage reported in the same frame as a provider failure", async () => {
    const observeUsage = vi.fn();
    const adapter = adapterFor("https://provider.example/v1", async () => new Response(
      `data: ${JSON.stringify({ error: { code: "request_failed" }, usage: { prompt_tokens: 13, completion_tokens: 7 } })}\n\n`,
    ), { observeUsage });
    const result = await adapter.stream([]).result();
    expect(adapter.getError(result)).toMatchObject({ code: "PROVIDER_STREAM_ERROR" });
    expect(observeUsage).toHaveBeenCalledExactlyOnceWith({ inputTokens: 13, outputTokens: 7 }, expect.any(Object));
  });

  it.each([400, 413, 422])("routes a provider HTTP %s context overflow to Pi compaction", async (status) => {
    const adapter = adapterFor("https://provider.example/v1", async () => new Response(JSON.stringify({ error: { code: "context_length_exceeded", message: "maximum context length exceeded" } }), { status }));
    await expect(drain(adapter)).rejects.toMatchObject({ code: "CONTEXT_WINDOW_EXCEEDED", status });
  });

  it("routes an in-band streamed context overflow to the same recovery path", async () => {
    const adapter = adapterFor("https://provider.example/v1", async () => new Response('data: {"error":{"code":"context_length_exceeded"}}\n\ndata: [DONE]\n\n'));
    await expect(drain(adapter)).rejects.toMatchObject({ code: "CONTEXT_WINDOW_EXCEEDED" });
  });

  it("bounds reading a stalled provider error body by the first-token deadline", async () => {
    const adapter = adapterFor("https://provider.example/v1", async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), { status: 400 }));
    await expect(drain(adapter)).rejects.toMatchObject({ code: "MODEL_FIRST_TOKEN_TIMEOUT" });
  });

  it("restores current Scene and request when overflow compaction retains only a tool tail", async () => {
    let body = "";
    const adapter = adapterFor("https://provider.example/v1", async (_url, init) => {
      body = String(init?.body);
      return new Response('data: {"choices":[{"delta":{"content":"Ready."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    for await (const _chunk of streamRequest(adapter, { messages: [
      { id: "pi.compaction:handoff", sourceKind: "plugin", role: "user", content: "Prior summary." },
      { id: "tool-output", sourceKind: "replay", role: "tool", content: "Cedar Finch.", tool_call_id: "recall" },
    ],
      pinned: [
        { id: "state:current", sourceKind: "plugin", role: "user", content: "Scene: the library." },
        { id: "current", sourceKind: "current_user", role: "user", content: "Quote the boat's name exactly." },
      ] })) { /* drain */ }
    expect(JSON.parse(body).messages).toEqual([
      { role: "user", content: "Context for this reply (earlier messages are already answered):\n<context>\nPrior summary.\n\nScene: the library.\n</context>" },
      { role: "user", content: "Quote the boat's name exactly." },
      { role: "tool", tool_call_id: "recall", content: "Cedar Finch." },
    ]);
  });

  it("uses the pinned current edit when compaction removed its user message from the surface", async () => {
    const bodies: Array<{ messages: Array<{ content?: string }>; tool_choice: unknown }> = [];
    const current = "Remove the hat from this photo.";
    const adapter = adapterFor("https://provider.example/v1", async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response('data: {"choices":[{"delta":{"content":"I can help with that."},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3}}\n\ndata: [DONE]\n\n');
    });
    const chunks: AssistantMessageEvent[] = [];
    for await (const chunk of streamRequest(adapter, { messages: [{ id: "pi.compaction:handoff", sourceKind: "plugin", role: "user", content: "Earlier photo discussion." }],
      tools: [{ name: "edit_last_image", description: "Edit image", parameters: { type: "object", properties: {} } }],
      pinned: [{ id: "current", sourceKind: "current_user", role: "user", content: current }] })) chunks.push(chunk);

    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.tool_choice).toBe("auto");
    expect(JSON.stringify(bodies[0]?.messages)).toContain(current);
    expect(chunks.some(chunk => chunk.type === "toolcall_delta")).toBe(false);
  });

  it.each([
    { requestLimit: undefined, expectedLimit: 256 },
    { requestLimit: 128, expectedLimit: 128 },
    { requestLimit: 2_048, expectedLimit: 256 },
  ])("keeps structured projection non-thinking and bounded: $requestLimit", async ({ requestLimit, expectedLimit }) => {
    const responseFormat = { type: "json_schema" as const, json_schema: {
      name: "scene_changes", strict: true as const,
      schema: { type: "object", properties: { changes: { type: "array" } }, required: ["changes"] },
    } };
    const bodies: Record<string, unknown>[] = [];
    const evidence: { bodyDigest: string }[] = [];
    const adapter = adapterFor("https://provider.example/v1", async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response('data: {"choices":[{"delta":{"content":"{\\\"changes\\\":[]}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }, { responseFormat, observeRequest: value => { evidence.push(value); }, profile: {
      tier: "test", adapter: "openai-compatible-v1", provider: "local", baseUrl: "https://provider.example/v1",
      model: "fixture", supportsTools: true, maxOutputTokens: 1_024, answerMaxOutputTokens: 256,
      timeout: { firstTokenMs: 1_000, idleMs: 1_000 }, sampling: { temperature: 0.9, topP: 0.95, repetitionPenalty: 1.05 },
    } });
    for await (const _event of streamRequest(adapter, { messages: [], maxTokens: requestLimit })) { /* drain */ }
    expect(bodies[0]?.response_format).toEqual(responseFormat);
    expect(bodies[0]?.max_tokens).toBe(expectedLimit);
    expect(bodies[0]?.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(bodies[0]).not.toHaveProperty("thinking_budget");
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

  it("assembles fragmented native tool names before dispatch", async () => {
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
    });
    const chunks: AssistantMessageEvent[] = [];
    for await (const chunk of streamRequest(adapter, { messages: [],
      tools: [{ name: "generate_image_async", description: "Generate", parameters: { type: "object" } }] })) chunks.push(chunk);

    expect(requests).toBe(1);
    expect(chunks).toContainEqual(expect.objectContaining({
      type: "toolcall_delta", delta: 'window portrait"}',
    }));
    expect(chunks).toContainEqual(expect.objectContaining({ type: "toolcall_end", contentIndex: 0, toolCall: {
      type: "toolCall", id: "fragmented-call", name: "generate_image_async", arguments: { prompt: "A rainy window portrait" },
    } }));
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
    const chunks: AssistantMessageEvent[] = [];
    for await (const chunk of streamRequest(adapter, { messages: [] })) chunks.push(chunk);
    expect(adapter.getUsage(terminal(chunks))).toEqual({ inputTokens: 3, outputTokens: 2 });
    expect(chunks.at(-1)).toMatchObject({ type: "done", reason: "stop" });
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
    const chunks: AssistantMessageEvent[] = [];
    for await (const chunk of streamRequest(adapter, { messages: [] })) chunks.push(chunk);
    expect(adapter.getUsage(terminal(chunks))).toBeUndefined();
    expect(chunks.at(-1)).toMatchObject({ type: "done", reason: "stop" });
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
    const chunks: AssistantMessageEvent[] = [];
    for await (const chunk of streamRequest(adapter, { messages: [] })) chunks.push(chunk);
    expect(adapter.getUsage(terminal(chunks))).toBeUndefined();
    expect(chunks.at(-1)).toMatchObject({ type: "done", reason: "stop" });
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
    const chunks: AssistantMessageEvent[] = [];
    for await (const chunk of streamRequest(adapter, { messages: [] })) chunks.push(chunk);
    expect(adapter.getUsage(terminal(chunks))).toBeUndefined();
    expect(chunks.at(-1)).toMatchObject({ type: "done", reason: "stop" });
  });

  it.each([undefined, null])("retains measured usage across an ordinary %j usage placeholder", async usage => {
    const adapter = adapterFor("https://provider.example/v1", async () => new Response([
      'data: {"choices":[{"delta":{"content":"Done."},"finish_reason":null}],"usage":{"prompt_tokens":13,"completion_tokens":1}}\n\n',
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`,
    ].join("")));
    const chunks: AssistantMessageEvent[] = [];
    for await (const chunk of streamRequest(adapter, { messages: [] })) chunks.push(chunk);
    expect(adapter.getUsage(terminal(chunks))).toEqual({ inputTokens: 13, outputTokens: 1 });
  });

  it.each([
    { name: "explicit zero", usage: { prompt_tokens: 0, completion_tokens: 0 }, inputTokens: 0, outputTokens: 0 },
    { name: "provider aliases", usage: { input_tokens: 13, output_tokens: 7 }, inputTokens: 13, outputTokens: 7 },
    { name: "explicit zero reasoning", usage: { prompt_tokens: 13, completion_tokens: 7, completion_tokens_details: { reasoning_tokens: 0 } }, inputTokens: 13, outputTokens: 7 },
    { name: "canonical zero with aliases", usage: { prompt_tokens: 0, completion_tokens: 0, input_tokens: 13, output_tokens: 7 }, inputTokens: 0, outputTokens: 0 },
  ])("preserves $name counts as known usage", async ({ usage, inputTokens, outputTokens }) => {
    const adapter = adapterFor("https://provider.example/v1", async () => new Response(
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`,
    ));
    const chunks: AssistantMessageEvent[] = [];
    for await (const chunk of streamRequest(adapter, { messages: [] })) chunks.push(chunk);
    expect(adapter.getUsage(terminal(chunks))).toEqual({ inputTokens, outputTokens,
      ...(usage.completion_tokens_details ? { reasoningTokens: usage.completion_tokens_details.reasoning_tokens } : {}) });
  });

  it("rejects dynamic Pi context exceeding the prepared budget before contacting a provider", async () => {
    let requests = 0;
    const observeUsage = vi.fn();
    const adapter = adapterFor("https://provider.example/v1", async () => {
      requests += 1;
      return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
    }, { maxInputTokens: 20, observeUsage });
    await expect((async () => {
      for await (const _chunk of streamRequest(adapter, { messages: [],
      systemPrompt: "Dynamic resident memory ".repeat(40) })) {}
    })()).rejects.toThrow(/input budget/);
    expect(requests).toBe(0);
    expect(observeUsage).not.toHaveBeenCalled();
  });

  it("preserves all pinned replay until Pi handles overflow with image tools available", async () => {
    const requests: { messages: unknown[]; tools: unknown[] }[] = [];
    const evidence: CompanionModelRequestEvidence[] = [];
    const adapter = adapterFor("https://provider.example/v1", async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      const args = JSON.stringify({ prompt: "A fully clothed rainy library portrait", subject: "companion" });
      return new Response(`data: ${JSON.stringify({ choices: [{
        delta: { tool_calls: [{ index: 0, id: "image-1", function: { name: "generate_image_async", arguments: args } }] },
        finish_reason: "tool_calls",
      }] })}\n\ndata: [DONE]\n\n`);
    }, { maxInputTokens: 1_000, observeRequest: value => { evidence.push(value); } });
    const drainRequest = async () => {
    for await (const _chunk of streamRequest(adapter, { systemPrompt: "Pinned Soul.",
      messages: [
        { id: "old-user", sourceKind: "replay", role: "user", content: `OLD_USER ${"x".repeat(2_000)}` },
        { id: "old-assistant", sourceKind: "replay", role: "assistant", content: `OLD_ASSISTANT ${"y".repeat(2_000)}` },
        { id: "next-user", sourceKind: "replay", role: "user", content: "The notebook is on the table." },
        { id: "next-assistant", sourceKind: "replay", role: "assistant", content: "I lit the lamp." },
        { id: "state:current", sourceKind: "plugin", role: "user", content: "Scene: the rainy library." },
        { id: "recall:current", sourceKind: "plugin", role: "user", content: "Your notebook is called Harbor Finch." },
        { id: "current", sourceKind: "current_user", role: "user", content: "Send me a fully clothed photo." },
      ],
      tools: [{ name: "generate_image_async", description: "Generate", parameters: { type: "object", properties: { prompt: { type: "string" } } } }] })) { /* drain */ }
    };
    await expect(drainRequest()).rejects.toMatchObject({ code: "CONTEXT_WINDOW_EXCEEDED" });
    expect(requests).toHaveLength(0);
    expect(evidence).toHaveLength(0);
  });

  it.each([1_000, 20])("keeps the current tool call and result fixed when fitting replay history (budget=%i)", async (maxInputTokens) => {
    let body = "";
    const adapter = adapterFor("https://provider.example/v1", async (_url, init) => {
      body = String(init?.body);
      return new Response('data: {"choices":[{"delta":{"content":"Okay"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }, { maxInputTokens });
    const args = JSON.stringify({ query: `EXACT_QUERY ${"q".repeat(500)}` });
    const result = `EXACT_RESULT ${"m".repeat(1_500)}`;
    const drainRequest = async () => {
      for await (const _chunk of streamRequest(adapter, { systemPrompt: "Pinned Soul.",
      messages: [
          { id: "old-user", sourceKind: "replay", role: "user", content: `OLD_USER ${"x".repeat(2_000)}` },
          { id: "old-assistant", sourceKind: "replay", role: "assistant", content: `OLD_ASSISTANT ${"y".repeat(2_000)}` },
          { id: "current", sourceKind: "current_user", role: "user", content: "What did I tell you?" },
          { id: "current-call", sourceKind: "replay", role: "assistant", content: "", tool_calls: [{ id: "lookup", type: "function", function: { name: "memory_search", arguments: args } }] },
          { id: "current-result", sourceKind: "replay", role: "tool", content: result, tool_call_id: "lookup" },
        ] })) { /* drain */ }
    };
    await expect(drainRequest()).rejects.toMatchObject({ code: "CONTEXT_WINDOW_EXCEEDED" });
    expect(body).toBe("");
  });

  it("records the exact serialized provider request and assembled system digest", async () => {
    const observed: unknown[] = [];
    let body = "";
    const adapter = adapterFor("https://provider.example/v1", async (_input, init) => {
      body = String(init?.body);
      return new Response('data: {"choices":[{"delta":{"content":"Okay"},"finish_reason":"stop"}]}\n\n');
    }, { maxInputTokens: 2_000, observeRequest: value => { observed.push(value); } });
    for await (const _chunk of streamRequest(adapter, { messages: [],
      systemPrompt: "Product rules\nPi memory guidance\nResident profile" })) {}
    expect(observed).toEqual([expect.objectContaining({
      bodyDigest: createHash("sha256").update(body).digest("hex"),
      systemPromptDigest: createHash("sha256").update("Product rules\nPi memory guidance\nResident profile").digest("hex"),
      maxInputTokens: 2_000,
    })]);
  });

  it("keeps the shared thinking budget before and after an image tool call", async () => {
    const choices: unknown[] = [];
    const tokenLimits: unknown[] = [];
    const thinkingBudgets: unknown[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      choices.push((JSON.parse(String(init?.body)) as Record<string, unknown>).tool_choice);
      tokenLimits.push((JSON.parse(String(init?.body)) as Record<string, unknown>).max_tokens);
      thinkingBudgets.push((JSON.parse(String(init?.body)) as Record<string, unknown>).thinking_budget);
      const firstStep = choices.length === 1;
      return new Response(firstStep
        ? [
            `data: ${JSON.stringify({
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: "image-1",
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
      fetch: fetchImpl,
    });
    const options: RequestFixture = { messages: [
        { id: "old-call", sourceKind: "replay", role: "assistant", content: "", tool_calls: [{ id: "old-image", type: "function", function: { name: "generate_image_async", arguments: "{}" } }] },
        { id: "old-result", sourceKind: "replay", role: "tool", content: "Accepted.", tool_call_id: "old-image" },
        { id: "current", sourceKind: "current_user", role: "user", content: "Send me another photo." },
      ],
      tools: [{
        name: "generate_image_async",
        description: "Generate an image",
        parameters: { type: "object", properties: {} },
      }] };

    for await (const _chunk of streamRequest(adapter, options)) { /* drain */ }
    for await (const _chunk of streamRequest(adapter, { ...options,
      messages: [
      ...options.messages,
      { id: "call", sourceKind: "replay", role: "assistant", content: "", tool_calls: [{ id: "image-1", type: "function", function: { name: "generate_image_async", arguments: "{}" } }] },
      { id: "result", sourceKind: "replay", role: "tool", content: "Accepted.", tool_call_id: "image-1" },
    ] })) { /* drain */ }

    expect(choices).toEqual([
      "auto",
      "auto",
    ]);
    expect(tokenLimits).toEqual([256, 256]);
    expect(thinkingBudgets).toEqual([undefined, undefined]);
  });

  it("preserves committed dialogue, Scene and recall in the native image decision request", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const userFact = "I place a blue notebook beside the window while the rain continues outside.";
    const assistantFact = "Rain taps the window; the notebook stays where you put it.";
    const recalledFact = "Earlier user fact: the exact notebook label is cedar-7301; it was placed beside the window.";
    const currentRequest = "Generate one fully clothed picture of yourself in our current scene with the blue notebook visible.";
    const adapter = adapterFor("https://provider.example/v1", (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const delta = { tool_calls: [{ index: 0, id: "current-image-call", function: { name: "generate_image_async", arguments: JSON.stringify({ prompt: "A clothed portrait at the rainy window with the blue notebook beside it", subject: "companion" }) } }] };
      return new Response([
        `data: ${JSON.stringify({ id: `scene-request-${requests.length}`, provider: "DeepSeek", choices: [{ delta, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""));
    }) as typeof fetch);
    for await (const _chunk of streamRequest(adapter, { systemPrompt: "Character and image skill",
      messages: [{ id: "prior-user", sourceKind: "replay", role: "user", content: userFact }, { id: "prior-assistant", sourceKind: "replay", role: "assistant", content: assistantFact }, { id: "state:current", sourceKind: "plugin", role: "user", content: "Current Scene: location unknown; time unknown" }, { id: "recall:current", sourceKind: "plugin", role: "user", content: recalledFact }, { id: "current-user", sourceKind: "current_user", role: "user", content: currentRequest }],
      tools: [{ name: "generate_image_async", description: "Generate an image", parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] } }] })) { /* drain the actual native adapter */ }
    expect(requests).toHaveLength(1);
    for (const request of requests) {
      const serialized = JSON.stringify(request.messages);
      expect(serialized).toContain(userFact);
      expect(serialized).toContain(assistantFact);
      expect(serialized).toContain(recalledFact);
      expect(serialized).toContain(currentRequest);
      expect(request.messages).toEqual([
        { role: "system", content: "Character and image skill" },
        { role: "user", content: userFact },
        { role: "assistant", content: assistantFact },
        { role: "user", content: `Context for this reply (earlier messages are already answered):\n<context>\nCurrent Scene: location unknown; time unknown\n\n${recalledFact}\n</context>` },
        { role: "user", content: currentRequest },
      ]);
    }
  });

  it("enforces the input budget on image continuity before a provider call", async () => {
    let contacted = false;
    const adapter = adapterFor("https://provider.example/v1", async () => {
      contacted = true;
      throw new Error("provider must not be contacted");
    }, { maxInputTokens: 200 });
    await expect((async () => {
      for await (const _chunk of streamRequest(adapter, { messages: [{ id: "past-user", sourceKind: "replay", role: "user", content: "Earlier rain and notebook facts. ".repeat(100) }, { id: "current-user", sourceKind: "current_user", role: "user", content: "Generate a photo in our current scene." }],
      tools: [{ name: "generate_image_async", description: "Generate", parameters: { type: "object", properties: {} } }] })) { /* drain */ }
    })()).rejects.toThrow("assembled model request exceeds the prepared input budget");
    expect(contacted).toBe(false);
  });

  it("classifies a request that never reached the provider as TRANSPORT", async () => {
    const adapter = adapterFor("http://127.0.0.1:9/v1", (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch);
    await expect(drain(adapter)).rejects.toMatchObject({ code: "TRANSPORT" });
  });

  it("keeps automatic tool choice on an explicit retry after a failed transport", async () => {
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
      fetch: fetchImpl,
    });
    const options: RequestFixture = { messages: [],
      tools: [{
        name: "generate_image_async",
        description: "Generate an image",
        parameters: { type: "object", properties: {} },
      }] };

    await expect((async () => {
      for await (const _chunk of streamRequest(adapter, options)) { /* drain */ }
    })()).rejects.toMatchObject({ code: "TRANSPORT" });
    for await (const _chunk of streamRequest(adapter, options)) { /* drain */ }

    expect(choices).toEqual([
      "auto",
      "auto",
    ]);
  });

  it.each(["I would rather talk for now.", '{"name":"generate_image_async","arguments":{"prompt":"a selfie"}}'])("does not force a call or synthesize one from text: %s", async text => {
    const request = vi.fn<typeof fetch>(async () => new Response(`data: ${JSON.stringify({
      choices: [{ delta: { content: text }, finish_reason: "stop" }],
    })}\n\ndata: [DONE]\n\n`));
    const adapter = adapterFor("https://provider.example/v1", request);
    const chunks: AssistantMessageEvent[] = [];
    for await (const chunk of streamRequest(adapter, { messages: [],
      tools: [{ name: "generate_image_async", description: "Generate", parameters: { type: "object" } }] })) chunks.push(chunk);
    expect(request).toHaveBeenCalledOnce();
    expect(chunks).toContainEqual(expect.objectContaining({ type: "text_delta", delta: text }));
    expect(chunks.some(chunk => chunk.type === "toolcall_delta")).toBe(false);
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body)).tool_choice).toBe("auto");
  });

  it("keeps the Character's sentence that a native tool call arrived with", async () => {
    const adapter = adapterFor("https://provider.example/v1", async () => new Response(
      [
        `data: ${JSON.stringify({ id: "native-1", choices: [{ delta: { content: "Elbow-deep in clay — give me a second." } }] })}`,
        `data: ${JSON.stringify({ id: "native-1", choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "generate_image_async", arguments: JSON.stringify({ prompt: "A potter beside her kiln", subject: "companion" }) } }] } }] })}`,
        `data: ${JSON.stringify({ id: "native-1", choices: [{ delta: {}, finish_reason: "tool_calls" }] })}`,
        "",
      ].map((line) => line ? `${line}\n\n` : "").join(""),
    ));
    const chunks: AssistantMessageEvent[] = [];
    for await (const chunk of streamRequest(adapter, { messages: [],
      tools: [{ name: "generate_image_async", description: "Reserved image action", parameters: { type: "object", properties: {} } }] })) chunks.push(chunk);

    // 台词写在工具结果出现之前；运行时再决定它能不能留给用户看。
    expect(chunks).toContainEqual(expect.objectContaining({
      type: "text_delta",
      delta: "Elbow-deep in clay — give me a second.",
    }));
    expect(chunks.some((chunk) =>
      chunk.type === "toolcall_end" && chunk.toolCall.name === "generate_image_async")).toBe(true);
  });

  it("rejects an unpinned provider before accepting its native tool call", async () => {
    let requests = 0;
    const adapter = new OpenAiCompatibleAdapter({
      profile: {
        tier: "test", adapter: "openai-compatible-v1", provider: "openai",
        baseUrl: "https://openrouter.ai/api/v1", model: "deepseek/test", supportsTools: true,
        maxOutputTokens: 256, timeout: { firstTokenMs: 1_000, idleMs: 1_000 },
        sampling: { temperature: 0.9, topP: 0.95, repetitionPenalty: 1.05 },
      },
      apiKey: "provider-secret", openRouterProviderOnly: ["DeepSeek"],
      fetch: (async () => {
        requests += 1;
        return new Response(`data: ${JSON.stringify({
          id: "unexpected-provider-request", provider: "OtherProvider",
          choices: [{ delta: { tool_calls: [{ index: 0, id: "edit-1", function: { name: "edit_last_image", arguments: JSON.stringify({ instruction: "Make the notebook green" }) } }] }, finish_reason: "tool_calls" }],
        })}\n\ndata: [DONE]\n\n`, { status: 200 });
      }) as typeof fetch,
    });
    await expect((async () => {
      for await (const _chunk of streamRequest(adapter, { messages: [],
      tools: [{ name: "edit_last_image", description: "Edit the image", parameters: { type: "object", properties: {} } }] })) { /* drain */ }
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
    const options: RequestFixture = { systemPrompt: "Pinned Soul",
      messages: [{ id: "user-1", sourceKind: "current_user", role: "user", content: "Show me the observatory" }],
      tools: [{
        name: "generate_image_async",
        description: "Generate an image",
        parameters: { type: "object", properties: {} },
      }],
      maxTokens: 256 };
    const chunks = [];
    for await (const chunk of streamRequest(adapter, options)) chunks.push(chunk);

    expect(authorization).toBe("Bearer provider-secret");
    expect(requestBody).toMatchObject({
      model: "deepseek/test",
      stream: true,
      temperature: 0.9,
      top_p: 0.95,
      repetition_penalty: 1.05,
      chat_template_kwargs: { enable_thinking: true },
      tool_choice: "auto",
      provider: { only: ["DeepSeek"], allow_fallbacks: false },
    });
    expect(adapter.getUsage(terminal(chunks))).toEqual({ inputTokens: 10, outputTokens: 7, cacheReadTokens: 3, reasoningTokens: 2 });
    expect(chunks.at(-1)).toMatchObject({ type: "done", reason: "stop" });
    expect(adapter.getAttribution(terminal(chunks))).toEqual({ requestId: "provider-request-1", actualProvider: "DeepSeek" });
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

    for await (const _chunk of streamRequest(adapter, { messages: [] })) {
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
    for await (const _chunk of streamRequest(adapter, { messages: [] })) {
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
      for await (const _chunk of streamRequest(adapter, { messages: [] })) {
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
      for await (const _chunk of streamRequest(adapter, { messages: [] })) {
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
      for await (const _chunk of streamRequest(adapter, { messages: [] })) {
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
      expect(outcome).toMatchObject({ code: "PROVIDER_HTTP_ERROR", status: 503 });
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
        for await (const _chunk of streamRequest(adapter, { messages: [],
      signal: source.signal })) { /* drain */ }
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
