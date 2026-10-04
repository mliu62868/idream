import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmAdapter, LlmError, type GenerateOptions, type StreamChunk, type TokenUsage } from "@deepseek-ai/dsh-llm";
import type {
  CompanionEvent,
  CompanionInvocation,
  CompanionTerminalCandidate,
  CompanionToolCall,
  CompanionToolResult,
} from "./contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { companionCompositionDigest, companionIgrepConfig } from "./composition";
import {
  CompanionEngine,
  CompanionCapacityError,
  type CompanionEngineOptions,
  type CompanionRuntimePort,
} from "./engine";
import { AttemptWorkspaceStore } from "./workspace";
import { OpenAiCompatibleAdapter } from "./openai-adapter";
import { compilePreparedTurn } from "../prepared-turn";
import { resolvePolicy } from "../policy";
import type { BuiltContext } from "../context";

const IGREP_LLM = { url: "https://maintenance.example/v1", model: "maintenance-model" };
const temporary: string[] = [];

// A fence is a Chat-wide durable fact under CHAT_FS_ROOT. Give every test its
// own root so one test's fenced user cannot reject another test's invocation.
beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-fence-engine-"));
  temporary.push(root);
  process.env.CHAT_FS_ROOT = root;
});

afterEach(async () => {
  delete process.env.CHAT_FS_ROOT;
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
  calls = 0;

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

/** 与工具调用同一步说话：这正是用户读到的那句台词的来源。 */
class LeadInThenToolAdapter extends LlmAdapter {
  calls = 0;

  constructor(private readonly leadIn: string) {
    super();
  }

  async *stream(): AsyncIterable<StreamChunk> {
    this.calls += 1;
    const args = JSON.stringify({ prompt: "Mira at the blue-lit observatory tonight" });
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: this.leadIn };
    yield { type: "block-end", index: 0, block: { type: "text", text: this.leadIn } };
    yield { type: "block-start", index: 1, blockType: "tool-call" };
    yield {
      type: "tool-call-delta",
      index: 1,
      id: "call-image-1" as never,
      name: "generate_image_async",
      argumentsDelta: args,
    };
    yield {
      type: "block-end",
      index: 1,
      block: {
        type: "tool-call",
        id: "call-image-1" as never,
        name: "generate_image_async",
        arguments: args,
      },
    };
    yield { type: "finish", reason: { kind: "tool-calls" } };
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

class UnreachableProviderAdapter extends LlmAdapter {
  async *stream(): AsyncIterable<StreamChunk> {
    throw new LlmError("OpenAI-compatible provider is unreachable", "TRANSPORT");
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
      version: 5,
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
        replyLocale: "en",
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

  constructor(
    private readonly text: string,
    private readonly nativeCall = false,
    private readonly usages: readonly (TokenUsage | undefined)[] = [],
    private readonly provisionalText = "",
  ) { super(); }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    if (this.nativeCall && this.requests.length === 1) {
      if (this.provisionalText) {
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: this.provisionalText };
        yield { type: "block-end", index: 0, block: { type: "text", text: this.provisionalText } };
      }
      const index = this.provisionalText ? 1 : 0;
      const args = JSON.stringify({ query: "rooftop code word" });
      yield { type: "block-start", index, blockType: "tool-call" };
      yield { type: "tool-call-delta", index, id: "memory-1" as never,
        name: "memory_search", argumentsDelta: args };
      yield { type: "block-end", index, block: { type: "tool-call",
        id: "memory-1" as never, name: "memory_search", arguments: args } };
      if (this.usages[0]) yield { type: "usage", usage: this.usages[0] };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: this.text };
    yield { type: "block-end", index: 0, block: { type: "text", text: this.text } };
    const usage = this.usages[this.requests.length - 1];
    if (usage) yield { type: "usage", usage };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

const recallMarker = "idreamrecall_08a47391c06ac75d765597abfd2af7c5";
const recallHit = { citation: "memory/dialogues/deepseek-harness-rooftop.jsonl#L1", snippet: `The rooftop code word is ${recallMarker}.`, sourceClass: "dialogue", score: 1 };
// The engine speaks the real igrep protocol; only the subprocess is replaced,
// so wake/recall parsing and note rendering stay under test here.
const memoryPorts: Partial<CompanionEngineOptions> = {
  runIgrep: async ({ args }) => {
    if (args.includes("wake")) return { markdownContext: "" };
    if (args.includes("reproject")) {
      const workspace = args[args.indexOf("--workspace") + 1]!;
      const at = "2026-09-30T23:55:00.000Z";
      for (const directory of ["dialogues", "sessions"]) await mkdir(join(workspace, ".igrep/mem/memory", directory), { recursive: true });
      await writeFile(join(workspace, ".igrep/mem/memory/sessions/deepseek-harness-rooftop.jsonl"), JSON.stringify({
        schema: "igrep.mem.session/1", agent: "deepseek-harness", id: "event-1", session_id: "rooftop", turn_index: 1,
        role: "user", content: recallHit.snippet, source_at: { instant_utc: at },
      }) + "\n");
      await writeFile(join(workspace, ".igrep/mem/memory/dialogues/deepseek-harness-rooftop.jsonl"), JSON.stringify([at, recallHit.snippet]) + "\n");
      return { provider: "igrep", action: "reproject", migrated: false };
    }
    return { results: [recallHit] };
  },
};

function port(input?: {
  executeTool?: (call: CompanionToolCall) => Promise<CompanionToolResult>;
  commit?: CompanionRuntimePort["commit"];
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
  it.each([
    { missingAttempt: 1, zero: false, expected: null },
    { missingAttempt: 2, zero: false, expected: null },
    { missingAttempt: 0, zero: false, expected: { promptTokens: 80, completionTokens: 20, reasoningTokens: 0 } },
    { missingAttempt: 0, zero: true, expected: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 } },
  ])("preserves complete or unknown usage across real forced-tool adapter attempts: $missingAttempt $zero", async ({ missingAttempt, zero, expected }) => {
    const value = requiredImageInvocation();
    let requests = 0;
    const adapter = new OpenAiCompatibleAdapter({
      profile: value.preparedTurn.profile, apiKey: "fixture-key", requiredToolName: "generate_image_async",
      fetch: async () => {
        requests++;
        return new Response(`data: ${JSON.stringify({
          choices: [{ delta: { content: requests === 1 ? "I will frame the view." : '{"prompt":"Mira at the observatory","subject":"companion"}' }, finish_reason: "stop" }],
          ...(requests === missingAttempt ? {} : { usage: { input_tokens: zero ? 0 : 40, output_tokens: zero ? 0 : 10 } }),
        })}\n\ndata: [DONE]\n\n`);
      },
    });
    const runtime = await engine(adapter);
    const connection = port();
    await runtime.run(value, connection.runtimePort);
    expect(requests).toBe(2);
    expect(connection.candidates).toHaveLength(1);
    expect(connection.candidates[0]).toMatchObject({ usage: expected, execution: { toolCalls: 1 } });
    expect(connection.events.some(event => event.type === "failed")).toBe(false);
    // The local acknowledgement is measured zero; a missing physical receipt
    // still leaves the terminal total unknown and never publishes a partial sum.
    expect(connection.events.filter(event => event.type === "usage").map(event => event.usage)).toEqual([
      ...(expected === null ? [] : [expected]),
      { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 },
    ]);
  });

  it.each(["normal", "private"] as const)("rejects %s pool pressure before execution without producing a failure event", async (mode) => {
    const runtime = await engine(new BlockingAdapter(), undefined, { ...memoryPorts, maxConcurrentAgents: { normal: 1, private: 1 } });
    const value = mode === "normal" ? normalInvocation() : invocation();
    const running = port();
    const first = runtime.run(value, running.runtimePort);
    await waitFor(() => running.events.some(event => event.type === "started"));
    const deferred = port();
    const overflow = runtime.run({ ...value, invocationId: "overflow", attemptId: "overflow", userId: "another-user" }, deferred.runtimePort);
    await expect(overflow).rejects.toBeInstanceOf(CompanionCapacityError);
    await expect(overflow).rejects.toMatchObject({
      name: "CompanionCapacityError", pool: mode,
    });
    expect(deferred.events).toEqual([]);
    expect(deferred.candidates).toEqual([]);
    runtime.cancel(value.invocationId, "user");
    await first;
  });

  it("fits a compiled free-tier Turn after actual DSH memory composition and records the final physical request", async () => {
    const policy = resolvePolicy({ modelTier: "free", unlimitedMessages: false, voiceEnabled: false, imageToolEnabled: false });
    const source: BuiltContext = {
      userLocale: "en", hasRecentImageContext: false,
      persona: {
        characterId: "character-1", creatorId: null, name: "Mara", age: 31,
        description: "A precise adult companion.", systemPrompt: "Stay specific and grounded.",
        visibility: "public", status: "approved", deletedAt: null, voiceId: null,
        visualProfileId: null, visualProfileVersion: null, identityPrompt: null,
        imageToolEnabled: false, contentVersion: null, release: null,
        characterContentVersionId: "content-1", characterReleaseId: null,
        soulFingerprint: "a".repeat(64), compilerVersion: "character-soul-3",
      },
      policy: { ...policy, modelProfile: { ...policy.modelProfile, adapter: "openai-compatible-v1", provider: "openai", baseUrl: "https://provider.example/v1", model: "fixture", supportsTools: true } },
      recentMessages: Array.from({ length: 7 }, (_, index) => ({
        id: `message-${index}`, role: index % 2 === 0 ? "user" : "assistant",
        // Leave just enough room for the pinned product contract. The additional
        // DSH memory guidance and tool schema must still force one whole exchange out.
        content: index === 6 ? "How are you tonight?" : `Established fact ${index}: ${"t".repeat(3_500)}`,
      })),
      scene: { schemaVersion: 1, version: 1, location: "the library", time: "tonight", participants: ["Mara"], emotionalBeat: "calm", unresolvedThreads: [] },
      sceneVersion: 1, lastExchangeAt: null, dropped: [], contextRevision: 0n,
    };
    const { context: _context, ...preparedTurn } = compilePreparedTurn(source, "message-6", new Date("2026-08-24T15:04:00Z"));
    expect(preparedTurn.budget.usedInputTokens).toBeLessThan(preparedTurn.budget.maxInputTokens);
    expect(preparedTurn.budget.dropped).toEqual([]);
    const value = { ...normalInvocation(), preparedTurn };
    let body = "";
    let requests = 0;
    const runtime = await engine(new OneStepAdapter(), undefined, {
      ...memoryPorts,
      plugin: async () => ({ name: "igrep", inject: ["tools"], apply(ctx) {
        ctx.tools.register({ name: "memory_search", description: "Recall shared facts.",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
          output: { schema: { type: "object", properties: {} }, render: () => [] },
          async execute() { return { results: [] }; },
        });
      } }),
      adapter: (profile, requiredToolName, requestPolicy) => new OpenAiCompatibleAdapter({
        profile, requiredToolName, ...requestPolicy, apiKey: "fixture-key",
        fetch: async (_url, init) => {
          requests += 1;
          body = String(init?.body);
          return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "Ready." }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
        },
      }),
    });
    const connection = port();
    await runtime.run(value, connection.runtimePort);
    expect(requests).toBe(1);
    expect(connection.candidates).toHaveLength(1);
    expect(connection.events.some(event => event.type === "failed")).toBe(false);
    const request = JSON.parse(body) as { messages: unknown[]; tools: unknown[] };
    const evidence = connection.candidates[0]?.modelRequests?.[0];
    expect(evidence?.droppedReplayMessageIds).toEqual(["message-0", "message-1"]);
    expect(evidence?.bodyDigest).toBe(createHash("sha256").update(body).digest("hex"));
    expect(evidence?.estimatedInputTokens).toBe(Math.ceil(JSON.stringify({ messages: request.messages, tools: request.tools }).length / 4));
    expect(evidence?.estimatedInputTokens).toBeLessThanOrEqual(preparedTurn.budget.maxInputTokens);
    const wire = JSON.stringify(request.messages);
    expect(wire).not.toContain("Established fact 0:");
    expect(wire).not.toContain("Established fact 1:");
    for (const text of ["Established fact 2:", "Established fact 5:", "Stay specific and grounded.", "the library", "How are you tonight?", "memory_search"]) expect(wire).toContain(text);
    expect(source.recentMessages).toHaveLength(7);
  });

  it.each(["normal", "private"] as const)("rebinds only normal memory snapshots before reads (%s)", async (mode) => {
    const operations: string[] = [];
    const adapter = new MemoryReplyAdapter("Ready.");
    const runtime = await engine(adapter, undefined, {
      runIgrep: async (options) => {
        operations.push(options.args[1]!);
        return options.args[1] === "reproject"
          ? { provider: "igrep", action: "reproject", migrated: false }
          : options.args[1] === "wake" ? { markdownContext: "" } : { results: [] };
      },
    });
    const connection = port();
    await runtime.run(mode === "normal" ? normalInvocation() : invocation(), connection.runtimePort);
    expect(operations).toEqual(mode === "normal" ? ["reproject", "wake", "memory-search"] : []);
    expect(connection.candidates).toHaveLength(1);
  });

  it("does not call the model when snapshot reproject fails", async () => {
    const adapter = new MemoryReplyAdapter("Must not execute.");
    const runtime = await engine(adapter, undefined, { runIgrep: async () => { throw new Error("snapshot binding unavailable"); } });
    const connection = port();
    await runtime.run(normalInvocation(), connection.runtimePort);
    expect(adapter.requests).toHaveLength(0);
    expect(connection.candidates).toHaveLength(0);
    expect(connection.events.at(-1)).toMatchObject({ type: "failed" });
  });

  it.each([false, true])("preserves group speakers through DSH into the provider request (image=%s)", async (image) => {
    const value = image ? requiredImageInvocation() : invocation();
    const speakers = [
      { characterId: "briar", sessionId: "briar-session", name: "Briar" },
      { characterId: "cedar", sessionId: "cedar-session", name: "Cedar" },
    ];
    value.preparedTurn.messages.splice(1, 0,
      { id: "prior-user", sourceKind: "replay", role: "user", content: "Who brought what?" },
      { id: "prior-briar", sourceKind: "replay", role: "assistant", speaker: speakers[0], content: "I brought the cup." },
      { id: "prior-cedar", sourceKind: "replay", role: "assistant", speaker: speakers[1], content: "I moved the book." },
      { id: "preferences:current", sourceKind: "plugin", role: "user", content: "Saved interaction preferences: use a single short sentence." },
    );
    const requests: Array<{ messages: unknown[] }> = [];
    const adapter = new OpenAiCompatibleAdapter({
      profile: value.preparedTurn.profile,
      apiKey: "fixture-key",
      ...(image ? { requiredToolName: "generate_image_async" as const } : {}),
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)) as { messages: unknown[] });
        return new Response(`data: ${JSON.stringify({ choices: [{
          delta: image ? { tool_calls: [{ index: 0, id: "image-1", function: {
            name: "generate_image_async", arguments: JSON.stringify({ prompt: "A rainy observatory portrait" }),
          } }] } : { content: "Briar brought the cup; Cedar moved the book." },
          finish_reason: image ? "tool_calls" : "stop",
        }] })}\n\ndata: [DONE]\n\n`);
      },
    });
    const runtime = await engine(adapter);
    const connection = port();
    await runtime.run(value, connection.runtimePort);
    expect(connection.events.filter(event => event.type === "failed")).toEqual([]);
    const request = JSON.stringify(requests[0]?.messages);
    if (image) {
      for (const speaker of speakers) expect(request).toContain(JSON.stringify(speaker).replaceAll('"', '\\"'));
    } else {
      // Native turns: each Character line is an assistant message under its own name.
      for (const speaker of speakers) expect(request).toContain(`${speaker.name}: I `);
      // Saved preferences ride inside the current user message, ahead of the user's own words.
      const last = requests[0]!.messages.at(-1) as { role: string; content: string };
      expect(last.role).toBe("user");
      expect(last.content.startsWith("Saved interaction preferences:")).toBe(true);
    }
    expect(request.indexOf("I brought the cup.")).toBeLessThan(request.indexOf("I moved the book."));
  });

  it.each(["normal", "private"] as const)("restricts plugin tools in %s mode at presentation and dispatch", async (mode) => {
    let writes = 0;
    const denied: boolean[] = [];
    const adapter = new MemoryReplyAdapter("I can read only the permitted memories.");
    const runtime = await engine(adapter, undefined, {
      ...memoryPorts,
      plugin: async () => ({ name: "igrep", inject: ["tools"], apply(ctx) {
        for (const name of ["memory_search", "memory_record", "unexpected_plugin_tool"]) {
          ctx.tools.register({ name, description: name,
            parameters: { type: "object", properties: {} },
            output: { schema: { type: "object", properties: {} }, render: () => [] },
            async execute() { if (name !== "memory_search") writes += 1; return {}; },
          });
        }
        ctx.on("agent/created", async ({ agent }) => {
          for (const name of ["memory_record", "unexpected_plugin_tool"]) {
            const result = await ctx.tools.execute({ name, arguments: {}, callId: `blocked-${name}` as never, agent, signal: new AbortController().signal });
            denied.push(result.isError === true);
          }
        });
      } }),
    });
    const connection = port();
    await runtime.run(mode === "normal" ? normalInvocation() : invocation(), connection.runtimePort);
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0]?.tools?.map(tool => tool.name) ?? []).toEqual(mode === "normal" ? ["memory_search"] : []);
    expect(writes).toBe(0);
    expect(denied).toEqual([true, true]);
    expect(connection.candidates).toHaveLength(1);
  });

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
    'Example:\n\n```text\n\n{memory_search: "rooftop code word"}\n```',
    'Example:\n\n```text\n\n{memory_search: "rooftop code word"}',
    'Example:\n\n    {memory_search: "rooftop code word"}',
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

  it.each([
    { finalUsage: { inputTokens: 30, outputTokens: 7, reasoningTokens: 2 }, expected: { promptTokens: 55, completionTokens: 11, reasoningTokens: 3 } },
    { finalUsage: undefined, expected: null },
  ])("accounts for every model step around native memory_search, including missing final usage: $finalUsage", async ({ finalUsage, expected }) => {
    let executed = 0;
    const adapter = new MemoryReplyAdapter(`We chose ${recallMarker}.`, true, [
      { inputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 2, outputTokens: 4, reasoningTokens: 1 },
      finalUsage,
    ]);
    const runtime = await engine(adapter, undefined, {
      ...memoryPorts,
      plugin: async () => ({ name: "igrep", inject: ["tools"], apply(ctx) {
        ctx.tools.register({
          name: "memory_search", description: "Recall a shared conversation.",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
          output: { schema: { type: "object", properties: { results: { type: "array", items: { type: "object", properties: {
            citation: { type: "string" }, snippet: { type: "string" }, sourceClass: { type: "string" }, score: { type: "number" },
          }, required: ["citation", "snippet", "sourceClass", "score"] } } }, required: ["results"] }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
          async execute() { executed += 1; return { results: [recallHit] }; },
        });
      } }),
    });
    const connection = port();
    await runtime.run(normalInvocation(), connection.runtimePort);
    expect(executed).toBe(1);
    expect(adapter.requests).toHaveLength(2);
    expect(JSON.stringify(adapter.requests[1].messages)).toContain('"role":"tool"');
    expect(connection.candidates[0]?.content).toBe(`We chose ${recallMarker}.`);
    expect(connection.candidates[0]?.usage).toEqual(expected);
    expect(connection.events.some(event => event.type === "failed")).toBe(false);
  });

  it.each([false, true])("binds native memory_search to original dated sources and blocks invalid citations (invalid=%s)", async (invalid) => {
    const original = "Yesterday (2026-09-30), I wrote 'tomorrow we meet' in an old letter.";
    const adapter = new MemoryReplyAdapter("The old letter said tomorrow.", true, [], "I am checking the old letter.");
    const runtime = await engine(adapter, undefined, {
      runIgrep: async (options) => {
        if (options.args.includes("reproject")) {
          const workspace = options.args[options.args.indexOf("--workspace") + 1]!;
          const name = "deepseek-harness-dated.jsonl";
          for (const directory of ["dialogues", "sessions"]) await mkdir(join(workspace, ".igrep/mem/memory", directory), { recursive: true });
          await writeFile(join(workspace, ".igrep/mem/memory/sessions", name), JSON.stringify({
            schema: "igrep.mem.session/1", agent: "deepseek-harness", id: "event-1", session_id: "dated", turn_index: 1,
            role: "user", content: original, source_at: { instant_utc: "2026-10-01T00:05:00.000Z", timezone: "UTC" },
          }) + "\n");
          await writeFile(join(workspace, ".igrep/mem/memory/dialogues", name), JSON.stringify([
            "2026-10-01T00:05:00.000Z", original.replace("tomorrow", "tomorrow（2026-10-02）"),
          ]) + "\n");
          return { provider: "igrep", action: "reproject", migrated: false };
        }
        return options.args.includes("wake") ? { markdownContext: "" } : { results: [] };
      },
      plugin: async () => ({ name: "igrep", inject: ["tools"], apply(ctx) {
        ctx.tools.register({
          name: "memory_search", description: "Recall attributed conversations.",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
          output: {
            schema: { type: "object", properties: { results: { type: "array", items: { type: "object", properties: {
              citation: { type: "string" }, snippet: { type: "string" }, sourceClass: { type: "string" }, score: { type: "number" },
            }, required: ["citation", "snippet", "sourceClass", "score"] } }, warnings: { type: "array", items: { type: "string" } } }, required: ["results"] },
            render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
          },
          async execute() { return { results: [{
            citation: `memory/dialogues/deepseek-harness-${invalid ? "foreign" : "dated"}.jsonl#L1`,
            snippet: original.replace("tomorrow", "tomorrow（2026-10-02）"), sourceClass: "dialogue", score: 1,
          }], warnings: [] }; },
        });
      } }),
    });
    const connection = port();
    await runtime.run(normalInvocation(), connection.runtimePort);
    expect(adapter.requests).toHaveLength(invalid ? 1 : 2);
    const messages = JSON.stringify(adapter.requests.at(-1)!.messages);
    expect(messages).not.toContain("tomorrow（2026-10-02）");
    if (invalid) {
      expect(connection.candidates).toHaveLength(0);
      expect(connection.events).toContainEqual(expect.objectContaining({ type: "igrep_observation", operation: "memory", outcome: "failure" }));
      expect(connection.events).toContainEqual(expect.objectContaining({ type: "text_reset" }));
    } else {
      expect(messages).toContain(original);
      expect(messages).toContain("2026-10-01T00:05:00.000Z");
      expect(connection.candidates).toHaveLength(1);
      expect(connection.events.some(event => event.type === "failed")).toBe(false);
    }
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

  it("lets the Character answer when Main rejects the image action", async () => {
    const adapter = new ToolThenTextAdapter(undefined, "One at a time, love. Let me finish the one I'm already making for you.");
    const runtime = await engine(adapter);
    const connection = port({
      executeTool: async (call) => ({
        attemptId: call.attemptId,
        callId: call.callId,
        name: call.name,
        outcome: "failed",
        error: { code: "rate_limited", message: "another image is still generating", retryable: true },
      }),
    });

    await runtime.run(requiredImageInvocation(), connection.runtimePort);

    expect(connection.events.filter((event) => event.type === "failed")).toEqual([]);
    expect(connection.events).toContainEqual(expect.objectContaining({ type: "tool_finished", outcome: "failed" }));
    expect(adapter.calls).toBe(2);
    expect(connection.candidates).toHaveLength(1);
    expect(connection.candidates[0]).toMatchObject({
      content: "One at a time, love. Let me finish the one I'm already making for you.",
      execution: { steps: 2, toolCalls: 1 },
      tools: [expect.objectContaining({ name: "generate_image_async" })],
    });
  });

  it.each([
    { scene: "It is night.", request: "Take a fully clothed photo the next morning.", prompt: "A fully clothed morning portrait." },
    { scene: "It is a rainy morning.", request: "Take a fully clothed photo.", prompt: "A fully clothed portrait on a rainy morning." },
    { scene: "The book is left of the cup; the lamp is right of the vase.", request: "Take a fully clothed photo.", prompt: "A fully clothed portrait. The book is left of the cup; the lamp is right of the vase." },
  ])("preserves authorized scene direction without inferring contradictions from isolated words: $scene", async ({ scene, request, prompt }) => {
    const value = requiredImageInvocation();
    value.preparedTurn.requiredAction!.requestedNudity = "none";
    value.preparedTurn.messages.splice(1, 0, {
      id: "user:scene", sourceKind: "replay", role: "user", content: scene,
    });
    value.preparedTurn.messages.at(-1)!.content = request;
    const calls: CompanionToolCall[] = [];
    const runtime = await engine(new ToolThenTextAdapter(prompt));
    const connection = port({ executeTool: async (call) => {
      calls.push(call);
      return { attemptId: call.attemptId, callId: call.callId, name: call.name,
        outcome: "succeeded", output: { generationJobId: "authorized-scene" } };
    } });
    await runtime.run(value, connection.runtimePort);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.arguments).toMatchObject({ prompt });
    expect(connection.candidates).toHaveLength(1);
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

  // A `failed` outcome is a known product rejection and lets the Character
  // answer (see "lets the Character answer when Main rejects the image action");
  // only an unacknowledged action still fails the Turn.
  it("does not confirm an image when Main reports unknown", async () => {
    const outcome = "unknown" as const;
    const adapter = new ToolThenTextAdapter();
    const runtime = await engine(adapter);
    const connection = port({ executeTool: async (call) => ({
      attemptId: call.attemptId, callId: call.callId, name: call.name,
      outcome, error: { code: "main_effect_unconfirmed", message: "Unconfirmed", retryable: true },
    }) });
    await runtime.run(requiredImageInvocation(), connection.runtimePort);
    expect(adapter.calls).toBe(1);
    expect(connection.candidates).toEqual([]);
    expect(connection.events.some(event => event.type === "text_delta")).toBe(false);
    expect(connection.events.at(-1)?.type).toBe("failed");
  });

  it("confirms an accepted image in the user's script without asking the caption provider", async () => {
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
    const adapter = new ToolThenTextAdapter(
      "A concrete selfie at the observatory tonight",
      "Je peux te renvoyer la dernière photo.",
    );
    const runtime = await engine(adapter);
    const connection = port();

    await runtime.run(invocation, connection.runtimePort);

    expect(adapter.calls).toBe(1);
    expect(connection.candidates[0]).toMatchObject({
      content: "等我一下……",
      acknowledgement: { version: "image-action-ack-1", locale: "zh" },
    });
    expect(connection.events).not.toContainEqual(expect.objectContaining({
      type: "text_delta",
      delta: expect.stringContaining("Je peux"),
    }));
    expect(connection.events.some(event => event.type === "failed")).toBe(false);
  });

  it("keeps the Character's sentence from the tool step without appending the system receipt", async () => {
    const adapter = new LeadInThenToolAdapter(
      "Elbow-deep in clay tonight, so give me a second to wash my hands.",
    );
    const runtime = await engine(adapter);
    const connection = port();

    await runtime.run(requiredImageInvocation(), connection.runtimePort);

    // 不额外要一次模型：台词来自工具那一步。
    expect(adapter.calls).toBe(1);
    expect(connection.candidates[0]).toMatchObject({
      content: "Elbow-deep in clay tonight, so give me a second to wash my hands.",
      acknowledgement: { version: "image-action-ack-1", locale: "en" },
    });
    expect(connection.events.some(event => event.type === "failed")).toBe(false);
  });

  it("does not leave a lead-in colon dangling once the receipt is gone", async () => {
    const adapter = new LeadInThenToolAdapter("Hold still, let me grab the camera:");
    const runtime = await engine(adapter);
    const connection = port();

    await runtime.run(requiredImageInvocation(), connection.runtimePort);

    expect(connection.candidates[0]).toMatchObject({ content: "Hold still, let me grab the camera…" });
  });

  it("drops a tool-step sentence that announces the image already arrived", async () => {
    const adapter = new LeadInThenToolAdapter("Here's your selfie, hope you like it.");
    const runtime = await engine(adapter);
    const connection = port();

    await runtime.run(requiredImageInvocation(), connection.runtimePort);

    expect(adapter.calls).toBe(1);
    expect(connection.candidates[0]).toMatchObject({
      content: "Give me a moment…",
    });
    expect(connection.events).not.toContainEqual(expect.objectContaining({
      type: "text_delta",
      delta: expect.stringContaining("Here's your selfie"),
    }));
    expect(connection.events.some(event => event.type === "failed")).toBe(false);
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

  it("classifies a fixed dynamic input overflow without claiming a provider outage", async () => {
    const adapter = new class extends LlmAdapter {
      async *stream(): AsyncIterable<StreamChunk> {
        throw new LlmError("assembled model request exceeds the prepared input budget", "INPUT_BUDGET_EXCEEDED");
      }
    }();
    const runtime = await engine(adapter);
    const connection = port();
    await runtime.run(invocation(), connection.runtimePort);
    expect(connection.candidates).toEqual([]);
    expect(connection.events.at(-1)).toMatchObject({ type: "failed", error: { code: "input_budget_exceeded", retryable: false } });
  });

  // A stopped model server used to surface as non-retryable invocation_failed.
  it("reports an unreachable model endpoint as a retryable provider outage", async () => {
    const runtime = await engine(new UnreachableProviderAdapter());
    const connection = port();

    await runtime.run(invocation(), connection.runtimePort);

    expect(connection.events.at(-1)).toMatchObject({
      type: "failed",
      error: { code: "provider_unavailable", retryable: true },
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

  it("passes the active cancellation signal through a pending terminal projection", async () => {
    const runtime = await engine(new OneStepAdapter());
    const committing = Promise.withResolvers<void>();
    let projectionSignal: AbortSignal | undefined;
    const connection = port({ commit: async (_candidate, signal) => {
      projectionSignal = signal;
      committing.resolve();
      await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
      throw new Error("cancelled projection must not settle");
    } });
    const running = runtime.run(invocation(), connection.runtimePort);
    await committing.promise;
    expect(projectionSignal?.aborted).toBe(false);
    expect(runtime.cancel(invocation().invocationId, "user")).toBe(true);
    await running;
    expect(projectionSignal?.aborted).toBe(true);
    expect(connection.candidates).toEqual([]);
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
