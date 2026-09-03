import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmAdapter, LlmError, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import type {
  CompanionCommitAck,
  CompanionEvent,
  CompanionInvocation,
  CompanionTerminalCandidate,
  CompanionToolCall,
  CompanionToolResult,
} from "./contracts";
import { afterEach, describe, expect, it } from "vitest";
import { companionCompositionDigest, companionIgrepConfig } from "./composition";
import {
  CompanionEngine,
  type CompanionEngineOptions,
  type CompanionRuntimePort,
} from "./engine";
import { AttemptWorkspaceStore } from "./workspace";

const IGREP_LLM = { url: "https://maintenance.example/v1", model: "maintenance-model" };
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class OneStepAdapter extends LlmAdapter {
  async *stream(): AsyncIterable<StreamChunk> {
    const text = "Tonight, every blue-lit window remembers us.";
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "usage", usage: { inputTokens: 21, outputTokens: 9, reasoningTokens: 2 } };
    yield {
      type: "finish",
      reason: { kind: "stop" },
      replayState: { response: { id: "provider-request-1", provider: "DeepSeek" } },
    };
  }
}

class ToolThenTextAdapter extends LlmAdapter {
  private calls = 0;

  constructor(
    private readonly imagePrompt = "Mira fully nude at the blue-lit observatory tonight",
    private readonly reply = "I sent the observatory view to the image studio.",
  ) {
    super();
  }

  async *stream(): AsyncIterable<StreamChunk> {
    this.calls += 1;
    if (this.calls === 1) {
      const args = JSON.stringify({ prompt: this.imagePrompt });
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield {
        type: "tool-call-delta",
        index: 0,
        id: "call-image-1" as never,
        name: "generate_image_async",
        argumentsDelta: args,
      };
      yield {
        type: "block-end",
        index: 0,
        block: {
          type: "tool-call",
          id: "call-image-1" as never,
          name: "generate_image_async",
          arguments: args,
        },
      };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }
    const text = this.reply;
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

class BlockingAdapter extends LlmAdapter {
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await new Promise<never>((_resolve, reject) => {
      const abort = () => reject(options.signal?.reason ?? new Error("aborted"));
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

class FirstTokenTimeoutAdapter extends LlmAdapter {
  async *stream(): AsyncIterable<StreamChunk> {
    throw new LlmError("model first-token timeout", "MODEL_FIRST_TOKEN_TIMEOUT");
  }
}

function invocation(withTool = false): CompanionInvocation {
  const memoryMode = "private" as const;
  return {
    invocationId: `invocation-${withTool ? "tool" : "text"}`,
    attemptId: `attempt-${withTool ? "tool" : "text"}`,
    sessionId: "session-1",
    userId: "user-1",
    characterId: "character-1",
    memoryMode,
    expectedProfileDigest: companionCompositionDigest(
      memoryMode,
      companionIgrepConfig(memoryMode, "igrep"),
      { maxSteps: 8, igrepLlm: IGREP_LLM },
    ),
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    preparedTurn: {
      version: 4,
      model: "deepseek/test",
      characterName: "Mira",
      messages: [
        {
          id: "system:soul",
          sourceKind: "plugin",
          role: "system",
          content: "Pinned Mira Soul and Chat relationship boundary.",
        },
        {
          id: "user:current",
          sourceKind: "current_user",
          role: "user",
          content: "What does the observatory look like tonight?",
        },
      ],
      tools: withTool
        ? [{
            name: "generate_image_async",
            description: "Generate an image.",
            parameters: {
              type: "object",
              properties: { prompt: { type: "string" } },
              required: ["prompt"],
            },
          }]
        : [],
      profile: {
        tier: "test",
        adapter: "openai-compatible-v1",
        provider: "openrouter",
        baseUrl: "https://example.invalid/v1",
        model: "deepseek/test",
        supportsTools: true,
        maxOutputTokens: 256,
        timeout: { firstTokenMs: 1_000, idleMs: 1_000 },
        sampling: { temperature: 0.9, topP: 0.95, repetitionPenalty: 1.05 },
      },
      budget: { maxInputTokens: 8_000, usedInputTokens: 120, dropped: [] },
      trace: {
        productPromptVersion: "companion-product-1",
        systemPromptDigest: "b".repeat(64),
        characterContentVersionId: "content-1",
        characterReleaseId: "release-1",
        soulFingerprint: "a".repeat(64),
        compilerVersion: "soul-v1",
        sceneVersion: 1,
        contextRevision: "3",
      },
      requiredAction: null,
    },
  };
}

function requiredImageInvocation(): CompanionInvocation {
  const value = invocation(true);
  return {
    ...value,
    invocationId: "invocation-required-image",
    attemptId: "attempt-required-image",
    preparedTurn: {
      ...value.preparedTurn,
      requiredAction: {
        name: "generate_image_async",
        requestedNudity: "full",
      },
    },
  };
}

async function engine(
  adapter: LlmAdapter,
  memoryBuilder?: CompanionEngineOptions["memoryBuilder"],
  overrides: Partial<CompanionEngineOptions> = {},
): Promise<CompanionEngine> {
  const root = await mkdtemp(join(tmpdir(), "chat-runtime-engine-"));
  temporary.push(root);
  return new CompanionEngine({
    workspaces: new AttemptWorkspaceStore({
      canonicalRoot: join(root, "canonical"),
      privateRoot: join(root, "private"),
    }),
    plugin: async () => ({ name: "igrep", apply() {} }),
    adapter: () => adapter,
    igrepCommand: "igrep",
    igrepLlm: IGREP_LLM,
    ...(memoryBuilder ? { memoryBuilder } : {}),
    ...overrides,
  });
}

function normalInvocation(): CompanionInvocation {
  const value = invocation();
  return {
    ...value,
    memoryMode: "normal",
    expectedProfileDigest: companionCompositionDigest(
      "normal", companionIgrepConfig("normal", "igrep"),
      { maxSteps: 8, igrepLlm: IGREP_LLM },
    ),
  };
}

class MemoryReplyAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];

  constructor(private readonly text: string, private readonly nativeCall = false) { super(); }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    if (this.nativeCall && this.requests.length === 1) {
      const args = JSON.stringify({ query: "rooftop code word" });
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield { type: "tool-call-delta", index: 0, id: "memory-1" as never,
        name: "memory_search", argumentsDelta: args };
      yield { type: "block-end", index: 0, block: { type: "tool-call",
        id: "memory-1" as never, name: "memory_search", arguments: args } };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: this.text };
    yield { type: "block-end", index: 0, block: { type: "text", text: this.text } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

const recallMarker = "idreamrecall_08a47391c06ac75d765597abfd2af7c5";
const memoryPorts: Partial<CompanionEngineOptions> = {
  observeWake: async () => ({ outcome: "empty", resultCount: 0, profile: "" }),
  recallMemory: async () => ({ outcome: "hit", resultCount: 1,
    results: [{ citation: "dialogue:1", snippet: recallMarker, sourceClass: "dialogue" }],
    notes: [`The rooftop code word is ${recallMarker}.`] }),
};

function port(input?: {
  executeTool?: (call: CompanionToolCall) => Promise<CompanionToolResult>;
  commit?: (candidate: CompanionTerminalCandidate) => Promise<CompanionCommitAck>;
}) {
  const events: CompanionEvent[] = [];
  const candidates: CompanionTerminalCandidate[] = [];
  const runtimePort: CompanionRuntimePort = {
    emit(event) {
      events.push(event);
    },
    executeTool: input?.executeTool ?? (async (call) => ({
      attemptId: call.attemptId,
      callId: call.callId,
      name: call.name,
      outcome: "succeeded",
      output: { accepted: true },
    })),
    commit: input?.commit ?? (async (candidate) => {
      candidates.push(candidate);
      return {
        attemptId: candidate.attemptId,
        accepted: true,
        status: "committed",
        terminalMessageId: "assistant-1",
        committedAt: new Date().toISOString(),
      };
    }),
  };
  return { events, candidates, runtimePort };
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not reached");
}

describe("Chat embedded companion runtime", () => {
  it("rejects the observed unexecuted memory call despite preRecall evidence, without another model call or commit", async () => {
    const text = 'I can see the gardens below, rooftops layered against the fading light, and you here beside me. Before we decide on the trains, let me check what I remember from earlier sessions.\n\n{memory_search: "exact rooftop probe code word"}';
    const adapter = new MemoryReplyAdapter(text);
    const runtime = await engine(adapter, undefined, memoryPorts);
    const connection = port();

    await runtime.run(normalInvocation(), connection.runtimePort);

    expect(adapter.requests).toHaveLength(1);
    expect(JSON.stringify(adapter.requests[0].messages)).toContain(recallMarker);
    expect(connection.events).toContainEqual(expect.objectContaining({
      type: "igrep_observation", operation: "memory", outcome: "hit", evidenceMatches: 1,
    }));
    expect(connection.candidates).toEqual([]);
    expect(connection.events.map(event => event.type)).not.toContain("terminal_candidate");
    expect(connection.events.map(event => event.type)).not.toContain("tool_started");
    expect(connection.events.at(-2)).toMatchObject({ type: "text_reset" });
    expect(connection.events.at(-1)).toMatchObject({
      type: "failed", error: { code: "unexecuted_tool_payload", retryable: true },
    });
  });

  it.each([
    "The memory_search tool can look up a previous conversation.",
    'The literal text is \'{memory_search: "rooftop code word"}\'.',
    'An inline example is `{memory_search: "rooftop code word"}`.',
    'Example:\n\n```text\n{memory_search: "rooftop code word"}\n```',
    'Example:\n\n```text\n{memory_search: "rooftop code word"}',
    'You quoted:\n\n> {memory_search: "rooftop code word"}',
  ])("preserves ordinary memory tool mentions and quoted examples: %s", async (text) => {
    const adapter = new MemoryReplyAdapter(text);
    const runtime = await engine(adapter, undefined, memoryPorts);
    const connection = port();
    await runtime.run(normalInvocation(), connection.runtimePort);
    expect(adapter.requests).toHaveLength(1);
    expect(connection.candidates[0]?.content).toBe(text);
    expect(connection.events.some(event => event.type === "text_reset" || event.type === "failed")).toBe(false);
  });

  it("allows a native memory_search result followed by a normal final answer", async () => {
    let executed = 0;
    const adapter = new MemoryReplyAdapter(`We chose ${recallMarker}.`, true);
    const runtime = await engine(adapter, undefined, {
      ...memoryPorts,
      plugin: async () => ({ name: "igrep", inject: ["tools"], apply(ctx) {
        ctx.tools.register({
          name: "memory_search", description: "Recall a shared conversation.",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
          output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
          async execute() { executed += 1; return recallMarker; },
        });
      } }),
    });
    const connection = port();
    await runtime.run(normalInvocation(), connection.runtimePort);
    expect(executed).toBe(1);
    expect(adapter.requests).toHaveLength(2);
    expect(JSON.stringify(adapter.requests[1].messages)).toContain('"tool-result"');
    expect(connection.candidates[0]?.content).toBe(`We chose ${recallMarker}.`);
    expect(connection.events.some(event => event.type === "failed")).toBe(false);
  });

  it("streams one terminal candidate and commits it directly through Chat", async () => {
    const runtime = await engine(new OneStepAdapter());
    const connection = port();

    await runtime.run(invocation(), connection.runtimePort);

    expect(connection.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "started",
      "text_delta",
      "usage",
      "reasoning_usage",
      "terminal_candidate",
    ]));
    expect(connection.candidates).toHaveLength(1);
    expect(connection.candidates[0]).toMatchObject({
      content: "Tonight, every blue-lit window remembers us.",
      finishReason: "stop",
      execution: { steps: 1, toolCalls: 0 },
      attribution: { requestId: "provider-request-1", actualProvider: "DeepSeek" },
    });
    expect(connection.events.map((event) => event.sequence))
      .toEqual(connection.events.map((_event, index) => index + 1));
  });

  it("does not execute an unsolicited image tool even when an invocation exposes it", async () => {
    const runtime = await engine(new ToolThenTextAdapter());
    const calls: CompanionToolCall[] = [];
    const connection = port({
      executeTool: async (call) => {
        calls.push(call);
        return {
          attemptId: call.attemptId,
          callId: call.callId,
          name: call.name,
          outcome: "succeeded",
          output: { generationJobId: "job-1" },
        };
      },
    });

    await runtime.run(invocation(true), connection.runtimePort);

    expect(calls).toHaveLength(0);
    expect(connection.events.some(event => event.type === "tool_started")).toBe(false);
  });

  it("requires the Agent to author and execute the concrete image prompt", async () => {
    const runtime = await engine(new ToolThenTextAdapter());
    const calls: CompanionToolCall[] = [];
    const connection = port({
      executeTool: async (call) => {
        calls.push(call);
        return {
          attemptId: call.attemptId,
          callId: call.callId,
          name: call.name,
          outcome: "succeeded",
          output: { generationJobId: "job-required" },
        };
      },
    });

    await runtime.run(requiredImageInvocation(), connection.runtimePort);

    expect(calls).toEqual([
      expect.objectContaining({
        name: "generate_image_async",
        effectScope: "turn_action",
        intent: { requestedNudity: "full" },
        arguments: expect.objectContaining({
          prompt: "Mira fully nude at the blue-lit observatory tonight",
        }),
      }),
    ]);
    expect(connection.candidates[0]).toMatchObject({
      execution: { steps: 2, toolCalls: 1 },
      tools: [expect.objectContaining({
        effectScope: "turn_action",
        intent: { requestedNudity: "full" },
      })],
    });
  });

  it("forwards structured nudity intent even when the Agent prompt drops it", async () => {
    const runtime = await engine(new ToolThenTextAdapter(
      "Mira wearing a silk robe at the blue-lit observatory tonight",
    ));
    const calls: CompanionToolCall[] = [];
    const connection = port({
      executeTool: async (call) => {
        calls.push(call);
        return {
          attemptId: call.attemptId,
          callId: call.callId,
          name: call.name,
          outcome: "succeeded",
          output: { generationJobId: "job-structured-intent" },
        };
      },
    });

    await runtime.run(requiredImageInvocation(), connection.runtimePort);

    expect(calls).toEqual([
      expect.objectContaining({
        effectScope: "turn_action",
        intent: { requestedNudity: "full" },
        arguments: expect.objectContaining({ prompt: expect.stringContaining("silk robe") }),
      }),
    ]);
    expect(connection.candidates).toHaveLength(1);
  });

  it("does not expose a required image reply written in the wrong script", async () => {
    const value = requiredImageInvocation();
    const invocation = {
      ...value,
      preparedTurn: {
        ...value.preparedTurn,
        messages: value.preparedTurn.messages.map((message) =>
          message.sourceKind === "current_user"
            ? { ...message, content: "给我一张今晚的自拍" }
            : message,
        ),
      },
    };
    const runtime = await engine(new ToolThenTextAdapter(
      "A concrete selfie at the observatory tonight",
      "Je peux te renvoyer la dernière photo.",
    ));
    const connection = port();

    await runtime.run(invocation, connection.runtimePort);

    expect(connection.candidates).toEqual([]);
    expect(connection.events).not.toContainEqual(expect.objectContaining({
      type: "text_delta",
      delta: expect.stringContaining("Je peux"),
    }));
    expect(connection.events.at(-1)).toMatchObject({
      type: "failed",
      error: { code: "required_image_reply_language_mismatch", retryable: true },
    });
  });

  it("turns a rejected Main CAS into a failed runtime terminal", async () => {
    const runtime = await engine(new OneStepAdapter());
    const connection = port({
      commit: async (candidate) => ({
        attemptId: candidate.attemptId,
        accepted: false,
        status: "rejected",
        error: { code: "stale_attempt", message: "stale attempt" },
      }),
    });

    await runtime.run(invocation(), connection.runtimePort);

    expect(connection.events.at(-1)).toMatchObject({
      type: "failed",
      error: { code: "invocation_failed", retryable: false },
    });
  });

  it("preserves a first-token timeout as a retryable provider failure", async () => {
    const runtime = await engine(new FirstTokenTimeoutAdapter());
    const connection = port();

    await runtime.run(invocation(), connection.runtimePort);

    expect(connection.events.at(-1)).toMatchObject({
      type: "failed",
      error: { code: "provider_first_token_timeout", retryable: true },
    });
  });

  it("does not return before an asynchronous failed event is delivered", async () => {
    const runtime = await engine(new FirstTokenTimeoutAdapter());
    const connection = port();
    connection.runtimePort.emit = async (event) => {
      if (event.type === "failed") {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      connection.events.push(event);
    };

    await runtime.run(invocation(), connection.runtimePort);

    expect(connection.events.at(-1)).toMatchObject({
      type: "failed",
      error: { code: "provider_first_token_timeout" },
    });
  });

  it("cancels in-process work without a child-process control protocol", async () => {
    const runtime = await engine(new BlockingAdapter());
    const connection = port();
    const run = runtime.run(invocation(), connection.runtimePort);
    await waitFor(() => connection.events.some((event) => event.type === "started"));

    expect(runtime.cancel(invocation().invocationId, "user")).toBe(true);
    await run;

    expect(connection.events.at(-1)).toMatchObject({ type: "cancelled", reason: "user" });
  });

  it("promotes an async projection without cancelling an active turn", async () => {
    const runtime = await engine(new BlockingAdapter(), {
      async build() {
        return { sessions: 1, messages: 2 };
      },
    });
    const fence = {
      mutationId: "projection-1",
      claimToken: "11111111-1111-4111-8111-111111111111",
      authorityVersion: "1",
    };
    const source = {
      scope: "relationship" as const,
      userId: "user-1",
      characterId: "character-1",
      mode: "project" as const,
      messages: [],
      fence,
    };
    const prepared = await runtime.prepareRebuild(source);
    const connection = port();
    const active = runtime.run(invocation(), connection.runtimePort);
    await waitFor(() => connection.events.some((event) => event.type === "started"));

    await expect(runtime.promoteRebuild({
      scope: "relationship",
      userId: source.userId,
      characterId: source.characterId,
      rebuildId: prepared.rebuildId,
      fence,
    })).resolves.toEqual({ sessions: 1, messages: 2 });
    expect(runtime.cancel(invocation().invocationId, "user")).toBe(true);
    await active;
    expect(connection.events.at(-1)).toMatchObject({ type: "cancelled", reason: "user" });
  });
});
