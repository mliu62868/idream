import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BasicCompactionEngine from "@deepseek-ai/dsh-compaction-basic";
import { LlmAdapter, LlmError, type GenerateOptions, type StreamChunk, type TokenUsage } from "@deepseek-ai/dsh-llm";
import type {
  CompanionEvent,
  CompanionInvocation,
  CompanionTerminalCandidate,
  CompanionToolCall,
  CompanionToolResult,
} from "./contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { companionCompositionDigest, companionIgrepConfig } from "./composition";
import {
  CompanionEngine,
  CompanionCapacityError,
  buildReplaySeed,
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
    private readonly reply = "Give me a moment, love.",
    private readonly requestedNudity: "unspecified" | "none" | "full" = "full",
  ) {
    super();
  }

  async *stream(): AsyncIterable<StreamChunk> {
    this.calls += 1;
    if (this.calls === 1) {
      const args = JSON.stringify({ prompt: this.imagePrompt, subject: "companion", requestedNudity: this.requestedNudity });
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
    if (this.calls > 1) {
      const text = "Give me a moment, love.";
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text };
      yield { type: "block-end", index: 0, block: { type: "text", text } };
      yield { type: "finish", reason: { kind: "stop" } };
      return;
    }
    const args = JSON.stringify({ prompt: "Mira at the blue-lit observatory tonight", subject: "companion" });
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
      version: 6,
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
    },
  };
}

function imageInvocation(): CompanionInvocation {
  const value = invocation(true);
  value.preparedTurn.messages.at(-1)!.content = "Send me a nude photo at the observatory.";
  return value;
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
    plugin: async () => ({ name: "igrep", Compaction: BasicCompactionEngine, apply() {} }),
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
  ])("preserves complete or unknown usage across native image and answer requests: $missingAttempt $zero", async ({ missingAttempt, zero, expected }) => {
    const value = imageInvocation();
    let requests = 0;
    const adapter = new OpenAiCompatibleAdapter({
      profile: value.preparedTurn.profile, apiKey: "fixture-key",
      fetch: async () => {
        requests++;
        return new Response(`data: ${JSON.stringify({
          choices: [{ delta: requests === 1
            ? { tool_calls: [{ index: 0, id: "image-1", function: { name: "generate_image_async", arguments: JSON.stringify({ prompt: "Mira at the observatory", subject: "companion" }) } }] }
            : { content: "Give me a moment, love." }, finish_reason: requests === 1 ? "tool_calls" : "stop" }],
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
    // Every physical request contributes its own receipt; unknown usage
    // cannot become a known terminal sum by omitting that request.
    expect(connection.events.filter(event => event.type === "usage").map(event => event.usage)).toEqual(
      [1, 2].filter(attempt => attempt !== missingAttempt).map(() => ({ promptTokens: zero ? 0 : 40, completionTokens: zero ? 0 : 10, reasoningTokens: 0 })),
    );
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

  it.each([true, false])("compacts a free-tier Turn through DSH and accounts for known or missing summary usage (%s)", async (withSummaryUsage) => {
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
        // Leave room for the product contract and the distinct clock authorities. The additional
        // DSH memory guidance and tool schema must still force one whole exchange out.
        content: index === 6 ? "How are you tonight?" : `Established fact ${index}: ${"t".repeat(3_400)}`,
      })),
      scene: { schemaVersion: 1, version: 1, location: "the library", time: "tonight", participants: ["Mara"], emotionalBeat: "calm", unresolvedThreads: [] },
      sceneVersion: 1, lastExchangeAt: null, dropped: [], contextRevision: 0n,
    };
    const { context: _context, ...compiled } = compilePreparedTurn(source, "message-6", new Date("2026-08-24T15:04:00Z"));
    // Current snapshots trim old exchanges for the runtime reserve, so DSH compaction is
    // only a last resort. A snapshot admitted before that reserve (replayed on recovery)
    // still carries the whole transcript; DSH must compact it safely.
    expect(compiled.budget.dropped).toEqual(["transcript"]);
    const firstReplay = compiled.messages.findIndex(message => message.sourceKind === "replay");
    const preparedTurn = {
      ...compiled,
      messages: [...compiled.messages.slice(0, firstReplay), ...(compiled.omittedMessages ?? []), ...compiled.messages.slice(firstReplay)],
      omittedMessages: undefined,
      budget: { ...compiled.budget, dropped: [] },
    };
    const value = { ...normalInvocation(), preparedTurn };
    let body = "";
    const bodies: string[] = [];
    let requests = 0;
    const runtime = await engine(new OneStepAdapter(), undefined, {
      ...memoryPorts,
      plugin: async () => ({ name: "igrep", Compaction: BasicCompactionEngine, inject: ["tools"], apply(ctx) {
        ctx.tools.register({ name: "memory_search", description: "Recall shared facts.",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
          output: { schema: { type: "object", properties: {} }, render: () => [] },
          async execute() { return { results: [] }; },
        });
      } }),
      adapter: (profile, requestPolicy) => new OpenAiCompatibleAdapter({
        profile, ...requestPolicy, apiKey: "fixture-key",
        fetch: async (_url, init) => {
          requests += 1;
          body = String(init?.body);
          bodies.push(body);
          return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "Ready." }, finish_reason: "stop" }], ...(withSummaryUsage || requests > 1 ? { usage: { prompt_tokens: 100, completion_tokens: 2 } } : {}) })}\n\ndata: [DONE]\n\n`);
        },
      }),
    });
    const connection = port();
    await runtime.run(value, connection.runtimePort);
    expect(requests).toBe(2);
    expect(connection.candidates).toHaveLength(1);
    expect(connection.events.some(event => event.type === "failed")).toBe(false);
    expect(connection.events).toContainEqual(expect.objectContaining({ type: "igrep_observation", operation: "compaction", outcome: "hit" }));
    expect(connection.candidates[0]?.usage).toEqual(withSummaryUsage ? { promptTokens: 200, completionTokens: 4, reasoningTokens: 0 } : null);
    const request = JSON.parse(body) as { messages: unknown[]; tools: unknown[] };
    const evidence = connection.candidates[0]?.modelRequests?.at(-1);
    expect(evidence?.droppedReplayMessageIds).toBeUndefined();
    expect(connection.candidates[0]?.modelRequests?.[0]?.purpose).toBe("compaction");
    for (const text of ["Established fact 0:", "Established fact 5:"]) expect(bodies[0]).toContain(text);
    expect(evidence?.bodyDigest).toBe(createHash("sha256").update(body).digest("hex"));
    expect(evidence?.estimatedInputTokens).toBe(Math.ceil(JSON.stringify({ messages: request.messages, tools: request.tools }).length / 4));
    expect(evidence?.estimatedInputTokens).toBeLessThanOrEqual(preparedTurn.budget.maxInputTokens);
    const wire = JSON.stringify(request.messages);
    expect(wire).not.toContain("Established fact 0:");
    expect(wire).not.toContain("Established fact 1:");
    for (const text of ["Stay specific and grounded.", "the library", "How are you tonight?", "memory_search"]) expect(wire).toContain(text);
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

  it.each(["length", "empty", "oversize"].flatMap(rejection => [true, false].map(withUsage => ({ rejection, withUsage }))))(
    "accounts for a rejected $rejection summary independently of its completion anchor (receipt=$withUsage)",
    async ({ rejection, withUsage }) => {
      const value = invocation();
      value.preparedTurn.budget.maxInputTokens = 6_000;
      value.preparedTurn.messages.splice(1, 0, ...Array.from({ length: 6 }, (_, index) => ({
        id: `history-${index}`, sourceKind: "replay" as const, role: index % 2 ? "assistant" as const : "user" as const,
        content: `Long authorized history. ${"t".repeat(3_500)}`,
      })));
      let purpose: string | undefined;
      let normalCalls = 0;
      const requests: Array<string | undefined> = [];
      const runtime = await engine(new OneStepAdapter(), undefined, {
        plugin: async () => ({ name: "igrep", Compaction: BasicCompactionEngine, inject: ["tools"], apply(ctx) {
          ctx.tools.register({ name: "igrep_search", description: "Find an observation.",
            parameters: { type: "object", properties: { user_question: { type: "string" } }, required: ["user_question"] },
            output: { schema: { type: "object", properties: {} }, render: () => [{ type: "text", text: "Original observation." }] },
            async execute() { return { results: [{ citation: "controlled:1", snippet: "Original observation." }] }; },
          });
        } }),
        adapter: (profile, policy) => new OpenAiCompatibleAdapter({
          profile, ...policy, apiKey: "fixture-key",
          observeRequest: evidence => { purpose = evidence.purpose; policy.observeRequest(evidence); },
          fetch: async () => {
            requests.push(purpose);
            const compacting = purpose === "compaction";
            const firstReply = !compacting && normalCalls++ === 0;
            const delta = compacting ? { content: rejection === "empty" ? "" : rejection === "oversize" ? "x".repeat(30_000) : "Truncated summary." }
              : firstReply ? { tool_calls: [{ index: 0, id: "lookup", function: { name: "igrep_search", arguments: '{"user_question":"Recall that observation."}' } }] }
                : { content: "Good evening." };
            return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: compacting && rejection === "length" ? "length" : firstReply ? "tool_calls" : "stop" }],
              ...(!compacting || withUsage ? { usage: { prompt_tokens: 100, completion_tokens: 10 } } : {}),
            })}\n\ndata: [DONE]\n\n`);
          },
        }),
      });
      const connection = port();
      await runtime.run(value, connection.runtimePort);

      expect(requests).toEqual([undefined, "compaction", undefined]);
      expect(connection.events).toContainEqual(expect.objectContaining({ type: "igrep_observation", operation: "compaction", outcome: "failure" }));
      expect(connection.candidates).toHaveLength(1);
      expect(connection.candidates[0]?.usage).toEqual(withUsage ? { promptTokens: 300, completionTokens: 30, reasoningTokens: 0 } : null);
      expect(connection.events.filter(event => event.type === "usage")).toHaveLength(withUsage ? 3 : 2);
    },
  );

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
    const value = image ? imageInvocation() : invocation();
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
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)) as { messages: unknown[] });
        return new Response(`data: ${JSON.stringify({ choices: [{
          delta: image && requests.length === 1 ? { tool_calls: [{ index: 0, id: "image-1", function: {
            name: "generate_image_async", arguments: JSON.stringify({ prompt: "A rainy observatory portrait" }),
          } }] } : { content: "Briar brought the cup; Cedar moved the book." },
          finish_reason: image && requests.length === 1 ? "tool_calls" : "stop",
        }] })}\n\ndata: [DONE]\n\n`);
      },
    });
    const runtime = await engine(adapter);
    const connection = port();
    await runtime.run(value, connection.runtimePort);
    expect(connection.events.filter(event => event.type === "failed")).toEqual([]);
    const request = JSON.stringify(requests[0]?.messages);
    for (const speaker of speakers) expect(request).toContain(`${speaker.name}: I `);
    const last = requests[0]!.messages.at(-1) as { role: string; content: string };
    expect(last.role).toBe("user");
    expect(last.content.startsWith("Saved interaction preferences:")).toBe(true);
    expect(request.indexOf("I brought the cup.")).toBeLessThan(request.indexOf("I moved the book."));
  });

  // SPEC (2026-10-08): budget-omitted dialogue is not seeded into the live session, so
  // a long conversation does not cross DSH's compaction trigger on every turn.
  it("does not seed dialogue the PreparedTurn omitted for budget", () => {
    const value = invocation();
    value.preparedTurn.omittedMessages = [{ id: "old-1", sourceKind: "replay", role: "user", content: "An old line trimmed for budget." }];
    const texts = buildReplaySeed(value).flatMap(event => JSON.stringify(event));
    expect(texts.some(text => text.includes("An old line trimmed for budget."))).toBe(false);
  });

  it.each([false, true])("binds recalled group speakers to original events without altering passages (invalid=%s)", async (invalid) => {
    const value = invocation();
    const speakers = [
      { characterId: "briar", sessionId: "briar-session", name: "Briar" },
      { characterId: "cedar", sessionId: "cedar-session", name: "Cedar" },
      { characterId: value.characterId, sessionId: value.sessionId, name: value.preparedTurn.characterName },
    ];
    const originals = ["I brought the cup.\n原文 ␊", "I moved the book.", "I carried the map."];
    // Retained group history: omitted dialogue is no longer seeded (it stays searchable
    // through igrep_search), so speaker binding is exercised on seeded passages.
    value.preparedTurn.messages.splice(value.preparedTurn.messages.length - 1, 0, ...speakers.map((speaker, index) => ({
      id: `group-${index}`, sourceKind: "replay" as const, role: "assistant" as const,
      ...(index < 2 ? { speaker } : {}), content: originals[index]!,
    })));
    const sources = buildReplaySeed(value).filter(event => event.type === "assistant/message");
    const hits = sources.map((source, index) => ({
      id: `seq:${source.seq}#1`, ref: `seq:${invalid && index === 0 ? 999_999 : source.seq}`,
      kind: "assistant/message", title: "assistant/message", snippet: originals[index]!,
    }));
    const requests: Array<{ messages: { role: string; content: string }[] }> = [];
    const runtime = await engine(new OneStepAdapter(), undefined, {
      plugin: async () => ({ name: "igrep", Compaction: BasicCompactionEngine, inject: ["tools"], apply(ctx) {
        ctx.tools.register({ name: "session_recall", description: "Recall archived dialogue.", parameters: { type: "object", properties: {} },
          output: { schema: { type: "object", properties: {} }, render: (_args, result) => [{ type: "text", text: JSON.stringify(result) }] },
          async execute() { return { archived: { complete: true }, hits }; },
        });
      } }),
      adapter: (profile, policy) => new OpenAiCompatibleAdapter({
        profile, ...policy, apiKey: "fixture-key",
        fetch: async (_url, init) => {
          requests.push(JSON.parse(String(init?.body)));
          const first = requests.length === 1;
          return new Response(`data: ${JSON.stringify({ choices: [{ delta: first
            ? { tool_calls: [{ index: 0, id: "group-recall", function: { name: "session_recall", arguments: "{}" } }] }
            : { content: "Ready." }, finish_reason: first ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
        },
      }),
    });
    const connection = port();
    await runtime.run(value, connection.runtimePort);
    expect(connection.candidates).toHaveLength(1);
    const messages = requests[1]!.messages;
    const tool = messages.find(message => message.role === "tool")!;
    expect(connection.events).toContainEqual(expect.objectContaining({ type: "igrep_observation", operation: "session", outcome: invalid ? "failure" : "hit" }));
    if (invalid) {
      expect(tool.content).toContain("unverifiable evidence");
      expect(messages.some(message => message.role === "user" && message.content.includes("Speakers for recalled"))).toBe(false);
    } else {
      expect(JSON.parse(tool.content).hits).toEqual(hits);
      for (const [index, speaker] of speakers.entries()) {
        expect(messages.some(message => message.role === "user" && message.content.includes(`${hits[index]!.id} ${JSON.stringify(speaker)}`))).toBe(true);
      }
    }
  });

  it.each(["normal", "private"] as const)("restricts plugin tools in %s mode at presentation and dispatch", async (mode) => {
    let writes = 0;
    const denied: boolean[] = [];
    const adapter = new MemoryReplyAdapter("I can read only the permitted memories.");
    const runtime = await engine(adapter, undefined, {
      ...memoryPorts,
      plugin: async () => ({ name: "igrep", Compaction: BasicCompactionEngine, inject: ["tools"], apply(ctx) {
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
      plugin: async () => ({ name: "igrep", Compaction: BasicCompactionEngine, inject: ["tools"], apply(ctx) {
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
      plugin: async () => ({ name: "igrep", Compaction: BasicCompactionEngine, inject: ["tools"], apply(ctx) {
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

  it("logs only fixed memory failure categories and still blocks a failed native recall", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const adapter = new MemoryReplyAdapter("Must not commit.", true);
      const runtime = await engine(adapter, undefined, {
        runIgrep: async ({ args }) => args.includes("reproject")
          ? { provider: "igrep", action: "reproject", migrated: false }
          : args.includes("wake") ? { markdownContext: "" }
            : { results: [], warnings: ["PRIVATE_MEMORY_WARNING"] },
        plugin: async () => ({ name: "igrep", Compaction: BasicCompactionEngine, inject: ["tools"], apply(ctx) {
          ctx.tools.register({ name: "memory_search", description: "Recall shared facts.",
            parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
            output: { schema: { type: "object", properties: {} }, render: () => [] },
            async execute() { return { results: [], warnings: ["PRIVATE_NATIVE_WARNING"] }; },
          });
        } }),
      });
      const connection = port();
      await runtime.run(normalInvocation(), connection.runtimePort);
      expect(adapter.requests).toHaveLength(1);
      expect(connection.candidates).toHaveLength(0);
      expect(connection.events).toContainEqual(expect.objectContaining({
        type: "failed", error: expect.objectContaining({ code: "igrep_memory_failed" }),
      }));
      const lines = stderr.mock.calls.map(([line]) => String(line));
      const records = lines.map(line => JSON.parse(line));
      expect(records).toContainEqual(expect.objectContaining({ event: "companion_recall_degraded", memoryFailure: "partial_evidence" }));
      expect(records).toContainEqual(expect.objectContaining({ event: "companion_memory_tool_failed", memoryFailure: "partial_evidence" }));
      expect(lines.join("\n")).not.toContain("PRIVATE_");
    } finally {
      stderr.mockRestore();
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

  it("lets the Agent choose an exposed image tool without a host-classified required action", async () => {
    const adapter = new ToolThenTextAdapter(undefined, "Give me a moment…");
    const runtime = await engine(adapter);
    const connection = port();
    await runtime.run(invocation(true), connection.runtimePort);
    expect(connection.events.filter(event => event.type === "failed")).toEqual([]);
    expect(connection.candidates[0]?.execution.toolCalls).toBe(1);
    expect(adapter.calls).toBe(2);
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

    await runtime.run(imageInvocation(), connection.runtimePort);

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

  // SPEC (2026-10-08): a clear photo request is kept even when the Agent answers in
  // words only; the host reserves the same Turn action with the user's own words.
  it("keeps a clear photo request when the Agent answered without calling the tool", async () => {
    const runtime = await engine(new OneStepAdapter());
    const calls: CompanionToolCall[] = [];
    const connection = port({
      executeTool: async (call) => {
        calls.push(call);
        return { attemptId: call.attemptId, callId: call.callId, name: call.name, outcome: "succeeded", output: { generationJobId: "job-host" } };
      },
    });
    const value = invocation(true);
    value.preparedTurn.messages.at(-1)!.content = "Send me a selfie.";
    value.preparedTurn.imageRequest = { name: "generate_image_async", requestedNudity: "unspecified", userText: "Send me a selfie." };

    await runtime.run(value, connection.runtimePort);

    expect(calls).toEqual([expect.objectContaining({
      name: "generate_image_async",
      effectScope: "turn_action",
      callId: `host-image-request:${value.attemptId}`,
      arguments: { prompt: "The photo they asked for in this message: Send me a selfie.", subject: "companion", requestedNudity: "unspecified" },
    })]);
    expect(connection.candidates[0]).toMatchObject({ execution: { toolCalls: 1 } });
  });

  it("does not add a host photo when the Agent already called the image tool", async () => {
    const runtime = await engine(new ToolThenTextAdapter());
    const calls: CompanionToolCall[] = [];
    const connection = port({
      executeTool: async (call) => {
        calls.push(call);
        return { attemptId: call.attemptId, callId: call.callId, name: call.name, outcome: "succeeded", output: { generationJobId: "job-agent" } };
      },
    });
    const value = imageInvocation();
    value.preparedTurn.imageRequest = { name: "generate_image_async", requestedNudity: "full", userText: "Send me a nude photo at the observatory." };

    await runtime.run(value, connection.runtimePort);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.callId).not.toContain("host-image-request");
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

    await runtime.run(imageInvocation(), connection.runtimePort);

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
    const value = imageInvocation();
    value.preparedTurn.messages.splice(1, 0, {
      id: "user:scene", sourceKind: "replay", role: "user", content: scene,
    });
    value.preparedTurn.messages.at(-1)!.content = request;
    const calls: CompanionToolCall[] = [];
    const runtime = await engine(new ToolThenTextAdapter(prompt, undefined, "none"));
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

  it("forwards the Agent's structured wardrobe intent without host text classification", async () => {
    const runtime = await engine(new ToolThenTextAdapter(
      "Mira wearing a silk robe at the blue-lit observatory tonight", undefined, "none",
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

    await runtime.run(imageInvocation(), connection.runtimePort);

    expect(calls).toEqual([
      expect.objectContaining({
        effectScope: "turn_action",
        intent: { requestedNudity: "none" },
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
    await runtime.run(imageInvocation(), connection.runtimePort);
    expect(adapter.calls).toBe(1);
    expect(connection.candidates).toEqual([]);
    expect(connection.events.some(event => event.type === "text_delta")).toBe(false);
    expect(connection.events.at(-1)?.type).toBe("failed");
  });

  it("lets the Agent answer in the user's language after observing Main's result", async () => {
    const value = imageInvocation();
    value.preparedTurn.messages.at(-1)!.content = "给我一张今晚的自拍";
    const adapter = new ToolThenTextAdapter("A concrete selfie at the observatory tonight", "等我一下，今晚的我给你看。", "unspecified");
    const runtime = await engine(adapter);
    const connection = port();
    await runtime.run(value, connection.runtimePort);
    expect(adapter.calls).toBe(2);
    expect(connection.candidates[0]).toMatchObject({ content: "等我一下，今晚的我给你看。" });
    expect(connection.candidates[0]).not.toHaveProperty("acknowledgement");
    expect(connection.events.filter(event => event.type === "failed")).toEqual([]);
  });

  it("retracts provisional tool-step text and commits the Agent's observed-result answer", async () => {
    const adapter = new LeadInThenToolAdapter("Elbow-deep in clay tonight, so give me a second to wash my hands.");
    const runtime = await engine(adapter);
    const connection = port();
    await runtime.run(imageInvocation(), connection.runtimePort);
    expect(adapter.calls).toBe(2);
    expect(connection.events).toContainEqual(expect.objectContaining({ type: "text_reset" }));
    expect(connection.candidates[0]).toMatchObject({ content: "Give me a moment, love." });
    expect(connection.candidates[0]).not.toHaveProperty("acknowledgement");
    expect(connection.events.filter(event => event.type === "failed")).toEqual([]);
  });

  it("permits only one image effect even if the Agent tries a second native call", async () => {
    let requests = 0;
    const value = imageInvocation();
    const calls: CompanionToolCall[] = [];
    const adapter = new OpenAiCompatibleAdapter({ profile: value.preparedTurn.profile, apiKey: "fixture-key", fetch: async () => {
      requests++;
      return new Response(`data: ${JSON.stringify({ choices: [{
        delta: requests <= 2 ? { tool_calls: [{ index: 0, id: `image-${requests}`, function: { name: "generate_image_async", arguments: JSON.stringify({ prompt: "A portrait beside the rainy window", subject: "companion" }) } }] } : { content: "Give me a moment, love." },
        finish_reason: requests <= 2 ? "tool_calls" : "stop",
      }] })}\n\ndata: [DONE]\n\n`);
    } });
    const runtime = await engine(adapter);
    const connection = port({ executeTool: async call => {
      calls.push(call);
      return { attemptId: call.attemptId, callId: call.callId, name: call.name, outcome: "succeeded", output: { accepted: true } };
    } });
    await runtime.run(value, connection.runtimePort);
    expect(calls).toHaveLength(1);
    expect(connection.candidates[0]?.execution.toolCalls).toBe(1);
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
