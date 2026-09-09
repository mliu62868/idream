import { once } from "node:events";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { GenerateOptions } from "@deepseek-ai/dsh-llm";
import { OpenAiCompatibleAdapter, type OpenAiCompatibleAdapterOptions } from "./openai-adapter";

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
        source: { kind: "plugin", plugin: "idream", form: "replay" } as never,
        content: [{ type: "text", text: "Old image request" }],
      }, {
        id: "old-assistant" as never,
        role: "assistant",
        source: { kind: "model", provider: "openai", model: "deepseek/test" },
        content: [{ type: "text", text: "Old canned acknowledgement" }],
      }, {
        id: "old-tool-source" as never,
        role: "user",
        source: { kind: "tool", callId: "old-call" as never },
        content: [{ type: "text", text: "Tool-only diagnostic: move the scene to a desert" }],
      }, {
        id: "state:current" as never,
        role: "user",
        source: { kind: "plugin", plugin: "idream", form: "context" } as never,
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
        ? { content: requests.length === 1 ? "I will make the image." : JSON.stringify({ prompt: "A clothed portrait at the rainy window with the blue notebook beside it" }) }
        : { tool_calls: [{ index: 0, id: "current-image-call", function: { name: "generate_image_async", arguments: JSON.stringify({ prompt: "A clothed portrait at the rainy window with the blue notebook beside it" }) } }] };
      return new Response([
        `data: ${JSON.stringify({ id: `scene-request-${requests.length}`, provider: "DeepSeek", choices: [{ delta, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: jsonMode ? "stop" : "tool_calls" }] })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""));
    }) as typeof fetch, { requiredToolName: "generate_image_async" });
    for await (const _chunk of adapter.stream({
      provider: "openrouter", model: "deepseek/test", system: "Character and image skill",
      messages: [{
        id: "prior-user" as never, role: "user", source: { kind: "plugin", plugin: "idream", form: "replay" } as never,
        content: [{ type: "text", text: userFact }],
      }, {
        id: "prior-assistant" as never, role: "assistant", source: { kind: "model", provider: "openai", model: "deepseek/test" },
        content: [{ type: "text", text: assistantFact }],
      }, {
        id: "state:current" as never, role: "user", source: { kind: "plugin", plugin: "idream", form: "context" } as never,
        content: [{ type: "text", text: "Current Scene: location unknown; time unknown" }],
      }, {
        id: "recall:current" as never, role: "user", source: { kind: "plugin", plugin: "idream", form: "context" } as never,
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
      expect(JSON.parse(latestUserRecord)).toEqual({ source: "conversation", role: "user", content: userFact });
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
          id: "past-user" as never, role: "user", source: { kind: "plugin", plugin: "idream", form: "replay" } as never,
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
    })()).rejects.toThrow(/connection reset/);
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
              prompt: "Adult woman taking a full nude mirror selfie in warm bedroom light",
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
    expect(chunks.some((chunk) => chunk.type === "text-delta")).toBe(false);
    expect(chunks).toContainEqual(expect.objectContaining({
      type: "tool-call-delta",
      name: "generate_image_async",
      argumentsDelta: JSON.stringify({
        prompt: "Adult woman taking a full nude mirror selfie in warm bedroom light",
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
