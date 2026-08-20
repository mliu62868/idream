import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmAdapter, LlmError, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  companionNdjsonFrameSchema,
  releasedKnowledgeDigest,
  type CompanionInvocation,
  type CompanionRuntimeResponse,
} from "@idream/shared/chat/companion-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanionEngine as RuntimeCompanionEngine } from "./engine";
import { companionCompositionDigest, companionIgrepConfig } from "./composition";
import { createCompanionServer, type CompanionServer } from "./server";
import { AttemptWorkspaceStore, relationshipWorkspacePath } from "./workspace";

const AUTH_TOKEN = "engine-test-secret";
const IGREP_LLM = { url: "https://maintenance.example/v1", model: "maintenance-model" };
const temporary: string[] = [];
const servers: CompanionServer[] = [];

// Engine unit tests exercise the DSH programmatic loop, not the host's global
// igrep installation. The real CLI boundary is covered by igrep tests and E2E.
class CompanionEngine extends RuntimeCompanionEngine {
  constructor(options: ConstructorParameters<typeof RuntimeCompanionEngine>[0]) {
    super({
      observeWake: async () => ({ outcome: "hit", resultCount: 1 }),
      ...options,
    });
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class OneStepAdapter extends LlmAdapter {
  calls: GenerateOptions[] = [];

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options);
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "Tonight, every blue-lit window remembers us." };
    yield {
      type: "block-end",
      index: 0,
      block: { type: "text", text: "Tonight, every blue-lit window remembers us." },
    };
    yield { type: "usage", usage: { inputTokens: 21, outputTokens: 9, reasoningTokens: 2 } };
    yield {
      type: "finish",
      reason: { kind: "stop" },
      replayState: { response: { id: "provider-request-1", provider: "DeepSeek" } },
    };
  }
}

class ToolThenTextAdapter extends LlmAdapter {
  calls: GenerateOptions[] = [];

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options);
    if (this.calls.length === 1) {
      const args = JSON.stringify({ prompt: "Mira at the blue-lit observatory tonight" });
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text: "I'll frame it for you. " };
      yield {
        type: "block-end",
        index: 0,
        block: { type: "text", text: "I'll frame it for you. " },
      };
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
      yield { type: "usage", usage: { inputTokens: 20, outputTokens: 5 } };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "I sent the observatory view to the image studio." };
    yield {
      type: "block-end",
      index: 0,
      block: { type: "text", text: "I sent the observatory view to the image studio." },
    };
    yield { type: "usage", usage: { inputTokens: 31, outputTokens: 11 } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

class MemorySearchThenTextAdapter extends LlmAdapter {
  private calls = 0;

  constructor(private readonly terminalFailureStatus?: number) {
    super();
  }

  async *stream(): AsyncIterable<StreamChunk> {
    this.calls += 1;
    if (this.calls === 1) {
      const args = JSON.stringify({ query: "observatory" });
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield {
        type: "tool-call-delta",
        index: 0,
        id: "call-memory-1" as never,
        name: "memory_search",
        argumentsDelta: args,
      };
      yield {
        type: "block-end",
        index: 0,
        block: {
          type: "tool-call",
          id: "call-memory-1" as never,
          name: "memory_search",
          arguments: args,
        },
      };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }
    if (this.terminalFailureStatus) {
      throw new LlmError(
        "PRIVATE_PROVIDER_BODY_SENTINEL",
        "PROVIDER_HTTP_ERROR",
        { status: this.terminalFailureStatus },
      );
    }
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "The observatory memory is here." };
    yield {
      type: "block-end",
      index: 0,
      block: { type: "text", text: "The observatory memory is here." },
    };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

class BlockingAdapter extends LlmAdapter {
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await new Promise<never>((_resolve, reject) => {
      const rejectAbort = () => reject(options.signal?.reason ?? new Error("aborted"));
      if (options.signal?.aborted) rejectAbort();
      else options.signal?.addEventListener("abort", rejectAbort, { once: true });
    });
  }
}

class ProviderMustNotRunAdapter extends LlmAdapter {
  calls = 0;

  async *stream(): AsyncIterable<StreamChunk> {
    this.calls += 1;
    throw new Error("provider must not execute");
  }
}

class PrivateFailureAdapter extends LlmAdapter {
  async *stream(): AsyncIterable<StreamChunk> {
    throw new Error("PRIVATE_PROVIDER_BODY_SENTINEL");
  }
}

class ProviderHttpFailureAdapter extends LlmAdapter {
  constructor(private readonly status: number) {
    super();
  }

  async *stream(): AsyncIterable<StreamChunk> {
    throw new LlmError(
      "PRIVATE_PROVIDER_BODY_SENTINEL",
      "PROVIDER_HTTP_ERROR",
      { status: this.status },
    );
  }
}

function invocation(memoryMode: "normal" | "private" = "private"): CompanionInvocation {
  const knowledgeAuthority = {
    characterId: "character-1",
    characterContentVersionId: "ccv-1",
    characterReleaseId: "release-1",
    files: [] as [],
  };
  const releasedKnowledge = {
    ...knowledgeAuthority,
    digest: releasedKnowledgeDigest(knowledgeAuthority),
  };
  return {
    invocationId: `inv-${memoryMode}`,
    attemptId: `attempt-${memoryMode}`,
    sessionId: "chat-session-1",
    userId: "user-1",
    characterId: "character-1",
    memoryMode,
    expectedProfileDigest: companionCompositionDigest(
      memoryMode === "private" ? "private" : "normal",
      companionIgrepConfig(memoryMode === "private" ? "private" : "normal", "igrep"),
      { maxSteps: 8, igrepLlm: IGREP_LLM },
    ),
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    preparedTurn: {
      version: 2,
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
          id: "user:old",
          sourceKind: "replay",
          role: "user",
          content: "Do you remember the observatory?",
        },
        {
          id: "assistant:old",
          sourceKind: "replay",
          role: "assistant",
          content: "Every blue-lit window.",
        },
        {
          id: "user:current",
          sourceKind: "current_user",
          role: "user",
          content: "What does it look like tonight?",
        },
      ],
      tools: [],
      profile: {
        tier: "test",
        adapter: "openai-compatible-v1",
        provider: "openrouter",
        baseUrl: "https://example.invalid/v1",
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
      budget: { maxInputTokens: 8_000, usedInputTokens: 120, dropped: [] },
      releasedKnowledge,
      trace: {
        characterContentVersionId: "ccv-1",
        characterReleaseId: "release-1",
        soulFingerprint: "a".repeat(64),
        compilerVersion: "soul-v1",
        sceneVersion: 1,
        relationshipVersion: 2,
        fileContextRevision: "3",
        releasedKnowledgeDigest: releasedKnowledge.digest,
      },
    },
  };
}

async function listen(server: CompanionServer): Promise<string> {
  server.http.listen(0, "127.0.0.1");
  await once(server.http, "listening");
  const address = server.http.address();
  if (!address || typeof address === "string") throw new Error("missing test address");
  return `http://127.0.0.1:${address.port}`;
}

async function frames(
  response: Response,
  onFrame?: (frame: CompanionRuntimeResponse) => Promise<void>,
): Promise<CompanionRuntimeResponse[]> {
  if (!response.body) throw new Error("response body is missing");
  const output: CompanionRuntimeResponse[] = [];
  let buffer = "";
  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const frame = companionNdjsonFrameSchema.parse(JSON.parse(line));
      if (frame.type === "run" || frame.type === "cancel" || frame.type === "tool_result" || frame.type === "commit_ack") {
        throw new Error("response contained a request frame");
      }
      output.push(frame);
      await onFrame?.(frame);
    }
  }
  if (buffer) throw new Error("response ended with a partial frame");
  return output;
}

async function dialogueCount(workspace: string): Promise<number> {
  try {
    return (await readdir(join(workspace, ".igrep", "mem", "memory", "dialogues"))).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

function disposalWritingPlugin(configs: Record<string, unknown>[]) {
  const rows = new Map<object, string[]>();
  const persist = (session: { header?: { cwd?: string; id?: string } }) => {
    const cwd = session.header?.cwd;
    if (!cwd) return;
    const directory = join(cwd, ".igrep", "mem", "memory", "dialogues");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, `${session.header?.id ?? "session"}.jsonl`),
      `${(rows.get(session) ?? []).join("\n")}\n`,
    );
  };
  return {
    name: "igrep",
    apply(ctx: { on(name: string, listener: (...args: never[]) => void): void }, config: Record<string, unknown>) {
      configs.push(config);
      if (config.ingest !== true) return;
      ctx.on("session/event", ((session: object, event: { type: string; data: unknown }) => {
        const list = rows.get(session) ?? [];
        if (event.type === "user/message") {
          const data = event.data as { source?: { kind?: string }; content?: Array<{ type: string; text?: string }> };
          if (data.source?.kind === "user") {
            list.push(data.content?.find((block) => block.type === "text")?.text ?? "");
          }
        } else if (event.type === "assistant/message") {
          const data = event.data as { message?: { content?: Array<{ type: string; text?: string }> } };
          list.push(data.message?.content?.find((block) => block.type === "text")?.text ?? "");
        }
        rows.set(session, list);
      }) as never);
      ctx.on("agent/turn-stopping", (({ agent }: { agent: { session: { header?: { cwd?: string; id?: string } } } }) => {
        persist(agent.session);
      }) as never);
      // Mirrors @igrep/dsh-plugin@0.1.0: dispose writes even when a prepended
      // Chat commit gate rejected the turn.
      ctx.on("session/disposed", ((session: { header?: { cwd?: string; id?: string } }) => {
        persist(session);
      }) as never);
    },
  };
}

describe("programmatic DSH companion runtime", () => {
  it("keeps failed invocation frames content-free", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-private-failure-"));
    temporary.push(root);
    const engine = new CompanionEngine({
      workspaces: new AttemptWorkspaceStore({
        canonicalRoot: join(root, "canonical"),
        privateRoot: join(root, "private"),
        memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
      }),
      plugin: async () => ({ name: "igrep", apply() {} }),
      adapter: () => new PrivateFailureAdapter(),
      igrepCommand: "igrep",
      igrepLlm: IGREP_LLM,
    });
    const observed: CompanionRuntimeResponse[] = [];

    await engine.run(invocation("private"), (frame) => observed.push(frame));

    const failed = observed.find((frame) =>
      frame.type === "event" && frame.event.type === "failed"
    );
    expect(failed).toMatchObject({
      type: "event",
      event: {
        type: "failed",
        error: {
          code: "invocation_failed",
          message: "companion invocation failed",
          retryable: false,
        },
      },
    });
    expect(JSON.stringify(observed)).not.toContain("PRIVATE_PROVIDER_BODY_SENTINEL");
  });

  it.each([
    [401, "provider_http_401", false],
    [429, "provider_http_429", true],
  ] as const)("keeps provider HTTP %s taxonomy without its body", async (status, code, retryable) => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-provider-taxonomy-"));
    temporary.push(root);
    const engine = new CompanionEngine({
      workspaces: new AttemptWorkspaceStore({
        canonicalRoot: join(root, "canonical"),
        privateRoot: join(root, "private"),
        memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
      }),
      plugin: async () => ({ name: "igrep", apply() {} }),
      adapter: () => new ProviderHttpFailureAdapter(status),
      igrepCommand: "igrep",
      igrepLlm: IGREP_LLM,
    });
    const observed: CompanionRuntimeResponse[] = [];

    await engine.run(invocation("private"), (frame) => observed.push(frame));

    expect(observed).toContainEqual(expect.objectContaining({
      type: "event",
      event: expect.objectContaining({
        type: "failed",
        error: {
          code,
          message: "companion provider request failed",
          retryable,
        },
      }),
    }));
    expect(JSON.stringify(observed)).not.toContain("PRIVATE_PROVIDER_BODY_SENTINEL");
  });

  it.each(["normal", "private"] as const)(
    "rejects a stale %s profile before composition, workspace or adapter initialization",
    async (memoryMode) => {
      const root = await mkdtemp(join(tmpdir(), "chat-agent-profile-drift-"));
      temporary.push(root);
      const adapter = new ProviderMustNotRunAdapter();
      let applyCalls = 0;
      let adapterFactoryCalls = 0;
      const workspaces = new AttemptWorkspaceStore({
        canonicalRoot: join(root, "canonical"),
        privateRoot: join(root, "private"),
        memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
      });
      const prepare = vi.spyOn(workspaces, "prepare");
      const engine = new CompanionEngine({
        workspaces,
        plugin: async () => ({
          name: "igrep",
          resolveConfig(config) {
            return { ...config, resolvedMarker: true };
          },
          apply() {
            applyCalls += 1;
          },
        }),
        adapter: () => {
          adapterFactoryCalls += 1;
          return adapter;
        },
        igrepCommand: "igrep",
        igrepLlm: IGREP_LLM,
      });
      const run = invocation(memoryMode);
      run.expectedProfileDigest = "f".repeat(64);
      const observed: CompanionRuntimeResponse[] = [];

      await engine.run(run, (frame) => observed.push(frame));

      expect(applyCalls).toBe(0);
      expect(prepare).not.toHaveBeenCalled();
      expect(adapterFactoryCalls).toBe(0);
      expect(adapter.calls).toBe(0);
      expect(observed).toContainEqual(expect.objectContaining({
        type: "event",
        event: expect.objectContaining({
          type: "failed",
          error: {
            code: "profile_digest_mismatch",
            message: "companion preflight failed",
            retryable: false,
          },
        }),
      }));
    },
  );

  it("emits content-free sidecar identity and authoritative igrep result metrics", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-igrep-observation-"));
    temporary.push(root);
    const instance = {
      id: "11111111-1111-4111-8111-111111111111",
      startedAt: "2026-08-19T11:59:00.000Z",
    };
    const engine = new CompanionEngine({
      instance,
      workspaces: new AttemptWorkspaceStore({
        canonicalRoot: join(root, "canonical"),
        privateRoot: join(root, "private"),
        memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
      }),
      plugin: async () => ({
        name: "igrep",
        inject: ["tools", "systemPrompt"],
        apply(ctx) {
          ctx.systemPrompt.section({
            name: "tool:memory_search",
            order: 122,
            text: "Recall prior facts. {{igrep_memory_profile}}",
          });
          ctx.systemPrompt.variable("igrep_memory_profile", () => "resident-profile");
          ctx.tools.register(defineTool({
            name: "memory_search",
            description: "Search memory.",
            parameters: { query: { type: "string", required: true } },
            output: {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  results: {
                    type: "array",
                    required: true,
                    items: { type: "string" },
                  },
                },
              },
              render: (_args, value) => [{ type: "text", text: value.results.join("\n") }],
            },
            async execute() {
              return {
                results: Array.from({ length: 9 }, (_, index) =>
                  `result-${index} idreamrecall_${index.toString(16).padStart(32, "0")}`
                ),
              };
            },
          }));
        },
      }),
      adapter: () => new MemorySearchThenTextAdapter(),
      igrepCommand: "igrep",
      observeWake: async () => ({ outcome: "hit", resultCount: 1 }),
      igrepLlm: IGREP_LLM,
    });
    const server = createCompanionServer({
      authToken: AUTH_TOKEN,
      readiness: async () => { throw new Error("not used"); },
      invocation: engine,
    });
    servers.push(server);
    const baseUrl = await listen(server);
    const run = invocation("normal");
    const response = await fetch(`${baseUrl}/v1/invocations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${AUTH_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ protocolVersion: 1, type: "run", invocation: run }),
    });
    const observed = await frames(response, async (frame) => {
      if (frame.type !== "commit") return;
      await fetch(`${baseUrl}/v1/invocations/${run.invocationId}/commit`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${AUTH_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          protocolVersion: 1,
          type: "commit_ack",
          invocationId: run.invocationId,
          ack: {
            attemptId: run.attemptId,
            accepted: false,
            status: "rejected",
            error: { code: "terminal_cas_conflict", message: "test rejection" },
          },
        }),
      });
    });
    const events = observed.flatMap((frame) => frame.type === "event" ? [frame.event] : []);
    expect(events.find((event) => event.type === "started")).toMatchObject({
      instance,
      profileDigest: run.expectedProfileDigest,
    });
    expect(events[0]?.type).toBe("started");
    expect(events.find((event) =>
      event.type === "igrep_observation" && event.operation === "wake"
    )).toMatchObject({
      operation: "wake",
      outcome: "hit",
      resultCount: 1,
      durationMs: expect.any(Number),
    });
    expect(events.find((event) =>
      event.type === "igrep_observation" && event.operation === "memory"
    )).toMatchObject({
      operation: "memory",
      outcome: "hit",
      resultCount: 9,
      evidenceMatches: 8,
      durationMs: expect.any(Number),
    });
    expect(JSON.stringify(events.filter((event) => event.type === "igrep_observation")))
      .not.toContain("observatory");
    expect(JSON.stringify(events.filter((event) => event.type === "igrep_observation")))
      .not.toContain("idreamrecall_0123456789abcdef0123456789abcdef");
  });

  it("classifies an igrep memory failure without leaking its error", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-igrep-failure-"));
    temporary.push(root);
    const engine = new CompanionEngine({
      workspaces: new AttemptWorkspaceStore({
        canonicalRoot: join(root, "canonical"),
        privateRoot: join(root, "private"),
        memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
      }),
      plugin: async () => ({
        name: "igrep",
        inject: ["tools"],
        apply(ctx) {
          ctx.tools.register(defineTool({
            name: "memory_search",
            description: "Search memory.",
            parameters: { query: { type: "string", required: true } },
            output: {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  results: { type: "array", required: true, items: { type: "string" } },
                },
              },
              render: () => [],
            },
            async execute() {
              throw new Error("PRIVATE_IGREP_DIAGNOSTIC_SENTINEL");
            },
          }));
        },
      }),
      adapter: () => new MemorySearchThenTextAdapter(),
      igrepCommand: "igrep",
      igrepLlm: IGREP_LLM,
    });
    const run = invocation("normal");
    const observed: CompanionRuntimeResponse[] = [];

    await engine.run(run, (frame) => {
      observed.push(frame);
      if (frame.type !== "commit") return;
      void engine.accept({
        protocolVersion: 1,
        type: "commit_ack",
        invocationId: run.invocationId,
        ack: {
          attemptId: run.attemptId,
          accepted: false,
          status: "rejected",
          error: { code: "terminal_cas_conflict", message: "lost authority" },
        },
      });
    });

    expect(observed).toContainEqual(expect.objectContaining({
      type: "event",
      event: expect.objectContaining({
        type: "failed",
        error: {
          code: "igrep_memory_failed",
          message: "companion memory tool failed",
          retryable: true,
        },
      }),
    }));
    expect(JSON.stringify(observed)).not.toContain("PRIVATE_IGREP_DIAGNOSTIC_SENTINEL");
  });

  it("reports a terminal provider failure ahead of an earlier igrep tool failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-mixed-failure-"));
    temporary.push(root);
    const engine = new CompanionEngine({
      workspaces: new AttemptWorkspaceStore({
        canonicalRoot: join(root, "canonical"),
        privateRoot: join(root, "private"),
        memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
      }),
      plugin: async () => ({
        name: "igrep",
        inject: ["tools"],
        apply(ctx) {
          ctx.tools.register(defineTool({
            name: "memory_search",
            description: "Search memory.",
            parameters: { query: { type: "string", required: true } },
            output: {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  results: { type: "array", required: true, items: { type: "string" } },
                },
              },
              render: () => [],
            },
            async execute() {
              throw new Error("PRIVATE_IGREP_DIAGNOSTIC_SENTINEL");
            },
          }));
        },
      }),
      adapter: () => new MemorySearchThenTextAdapter(429),
      igrepCommand: "igrep",
      igrepLlm: IGREP_LLM,
    });
    const observed: CompanionRuntimeResponse[] = [];

    await engine.run(invocation("normal"), (frame) => observed.push(frame));

    expect(observed).toContainEqual(expect.objectContaining({
      type: "event",
      event: expect.objectContaining({
        type: "failed",
        error: {
          code: "provider_http_429",
          message: "companion provider request failed",
          retryable: true,
        },
      }),
    }));
    expect(JSON.stringify(observed)).not.toContain("PRIVATE_PROVIDER_BODY_SENTINEL");
    expect(JSON.stringify(observed)).not.toContain("PRIVATE_IGREP_DIAGNOSTIC_SENTINEL");
  });

  it("preserves replay roles, current-user authority and the Chat-owned system prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-engine-"));
    temporary.push(root);
    const adapter = new OneStepAdapter();
    const engine = new CompanionEngine({
      workspaces: new AttemptWorkspaceStore({
        canonicalRoot: join(root, "canonical"),
        privateRoot: join(root, "private"),
        memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
      }),
      plugin: async () => ({ name: "igrep", apply() {} }),
      adapter: () => adapter,
      igrepCommand: "igrep",
      igrepLlm: IGREP_LLM,
    });
    const server = createCompanionServer({
      authToken: AUTH_TOKEN,
      readiness: async () => { throw new Error("not used"); },
      invocation: engine,
    });
    servers.push(server);
    const baseUrl = await listen(server);
    const run = invocation();
    const response = await fetch(`${baseUrl}/v1/invocations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${AUTH_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ protocolVersion: 1, type: "run", invocation: run }),
    });
    expect(response.status).toBe(200);

    const collectedPromise = frames(response);
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const activeCall = adapter.calls[0];
      if (!activeCall) continue;
      const commitResponse = await fetch(`${baseUrl}/v1/invocations/${run.invocationId}/commit`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${AUTH_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          protocolVersion: 1,
          type: "commit_ack",
          invocationId: run.invocationId,
          ack: {
            attemptId: run.attemptId,
            accepted: true,
            status: "committed",
            terminalMessageId: "assistant-terminal-1",
            committedAt: new Date().toISOString(),
          },
        }),
      });
      expect(commitResponse.status).toBe(200);
      break;
    }
    const collected = await collectedPromise;

    expect(collected.map((frame) => frame.type)).toContain("commit");
    expect(collected.find((frame) => frame.type === "commit")).toMatchObject({
      candidate: {
        attribution: { requestId: "provider-request-1", actualProvider: "DeepSeek" },
        execution: { steps: 1, toolCalls: 0 },
      },
    });
    expect(collected.some((frame) => frame.type === "event" && frame.event.type === "terminal_candidate")).toBe(true);
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]?.system).toContain("Pinned Mira Soul and Chat relationship boundary.");
    expect(adapter.calls[0]?.system).not.toContain("DeepSeek Harness");
    expect(adapter.calls[0]?.messages.map((message) => [message.role, message.content[0]])).toEqual([
      ["user", { type: "text", text: "Do you remember the observatory?" }],
      ["assistant", { type: "text", text: "Every blue-lit window." }],
      ["user", { type: "text", text: "What does it look like tonight?" }],
    ]);
    expect(await readdir(join(root, "private"))).toEqual([]);
    await expect(readdir(join(root, "canonical"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("[Gate T] runs a real two-step DSH tool loop and reuses an identical tool result", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-tool-"));
    temporary.push(root);
    const adapter = new ToolThenTextAdapter();
    const run = invocation();
    run.invocationId = "inv-tool";
    run.attemptId = "attempt-tool";
    run.preparedTurn.tools.push({
      name: "generate_image_async",
      description: "Generate a companion image asynchronously.",
      parameters: {
        type: "object",
        properties: { prompt: { type: "string" } },
        required: ["prompt"],
      },
    });
    const engine = new CompanionEngine({
      workspaces: new AttemptWorkspaceStore({
        canonicalRoot: join(root, "canonical"),
        privateRoot: join(root, "private"),
        memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
      }),
      plugin: async () => ({ name: "igrep", apply() {} }),
      adapter: () => adapter,
      igrepCommand: "igrep",
      igrepLlm: IGREP_LLM,
    });
    const server = createCompanionServer({
      authToken: AUTH_TOKEN,
      readiness: async () => { throw new Error("not used"); },
      invocation: engine,
    });
    servers.push(server);
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/v1/invocations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${AUTH_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ protocolVersion: 1, type: "run", invocation: run }),
    });
    const controls: number[] = [];
    const collected = await frames(response, async (frame) => {
      if (frame.type === "tool_call") {
        const resultFrame = {
          protocolVersion: 1 as const,
          type: "tool_result" as const,
          invocationId: run.invocationId,
          result: {
            attemptId: run.attemptId,
            callId: frame.call.callId,
            name: frame.call.name,
            outcome: "succeeded" as const,
            output: { artifactId: "artifact-1", status: "queued" },
          },
        };
        for (let replay = 0; replay < 2; replay += 1) {
          const control = await fetch(
            `${baseUrl}/v1/invocations/${run.invocationId}/tool-result`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${AUTH_TOKEN}`,
                "content-type": "application/json",
              },
              body: JSON.stringify(resultFrame),
            },
          );
          controls.push(control.status);
        }
      } else if (frame.type === "commit") {
        const control = await fetch(`${baseUrl}/v1/invocations/${run.invocationId}/commit`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${AUTH_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            protocolVersion: 1,
            type: "commit_ack",
            invocationId: run.invocationId,
            ack: {
              attemptId: run.attemptId,
              accepted: true,
              status: "committed",
              terminalMessageId: "assistant-tool-terminal",
              committedAt: new Date().toISOString(),
            },
          }),
        });
        controls.push(control.status);
      }
    });

    expect(controls).toEqual([200, 200, 200]);
    expect(collected.filter((frame) => frame.type === "tool_call")).toHaveLength(1);
    expect(collected.find((frame) => frame.type === "commit")).toMatchObject({
      candidate: {
        content: "I'll frame it for you. I sent the observatory view to the image studio.",
        execution: { steps: 2, toolCalls: 1 },
      },
    });
    const streamed = collected
      .filter((frame) => frame.type === "event" && frame.event.type === "text_delta")
      .map((frame) => frame.type === "event" && frame.event.type === "text_delta"
        ? frame.event.delta
        : "")
      .join("");
    expect(streamed).toBe(
      "I'll frame it for you. I sent the observatory view to the image studio.",
    );
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1]?.messages.at(-1)).toMatchObject({
      role: "user",
      source: { kind: "tool", callId: "call-image-1" },
    });
    expect(collected.some((frame) => frame.type === "event" && frame.event.type === "tool_finished")).toBe(true);
  });

  it("[Gate T] projects a failed Chat tool outcome as a DSH tool error before the recovery step", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-tool-error-"));
    temporary.push(root);
    const adapter = new ToolThenTextAdapter();
    const run = invocation();
    run.invocationId = "inv-tool-error";
    run.attemptId = "attempt-tool-error";
    run.preparedTurn.tools.push({
      name: "generate_image_async",
      description: "Generate a companion image asynchronously.",
      parameters: {
        type: "object",
        properties: { prompt: { type: "string" } },
        required: ["prompt"],
      },
    });
    const engine = new CompanionEngine({
      workspaces: new AttemptWorkspaceStore({
        canonicalRoot: join(root, "canonical"),
        privateRoot: join(root, "private"),
        memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
      }),
      plugin: async () => ({ name: "igrep", apply() {} }),
      adapter: () => adapter,
      igrepCommand: "igrep",
      igrepLlm: IGREP_LLM,
    });
    const server = createCompanionServer({
      authToken: AUTH_TOKEN,
      readiness: async () => { throw new Error("not used"); },
      invocation: engine,
    });
    servers.push(server);
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/v1/invocations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${AUTH_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ protocolVersion: 1, type: "run", invocation: run }),
    });
    const collected = await frames(response, async (frame) => {
      if (frame.type === "tool_call") {
        const control = await fetch(
          `${baseUrl}/v1/invocations/${run.invocationId}/tool-result`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${AUTH_TOKEN}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              protocolVersion: 1,
              type: "tool_result",
              invocationId: run.invocationId,
              result: {
                attemptId: run.attemptId,
                callId: frame.call.callId,
                name: frame.call.name,
                outcome: "failed",
                error: {
                  code: "image_entitlement_denied",
                  message: "image generation is unavailable for this turn",
                  retryable: false,
                },
              },
            }),
          },
        );
        expect(control.status).toBe(200);
      } else if (frame.type === "commit") {
        const control = await fetch(`${baseUrl}/v1/invocations/${run.invocationId}/commit`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${AUTH_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            protocolVersion: 1,
            type: "commit_ack",
            invocationId: run.invocationId,
            ack: {
              attemptId: run.attemptId,
              accepted: true,
              status: "committed",
              terminalMessageId: "assistant-tool-error-terminal",
              committedAt: new Date().toISOString(),
            },
          }),
        });
        expect(control.status).toBe(200);
      }
    });

    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1]?.messages.at(-1)).toMatchObject({
      role: "user",
      source: { kind: "tool", callId: "call-image-1" },
      content: [{
        type: "tool-result",
        toolCallId: "call-image-1",
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("image_entitlement_denied") }],
      }],
    });
    expect(collected).toContainEqual(expect.objectContaining({
      type: "event",
      event: expect.objectContaining({
        type: "tool_finished",
        callId: "call-image-1",
        outcome: "failed",
      }),
    }));
  });

  it("[Gate T] classifies a timed-out effectful tool as unknown and lets DSH recover in the next step", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-tool-timeout-"));
    temporary.push(root);
    const adapter = new ToolThenTextAdapter();
    const run = invocation();
    run.invocationId = "inv-tool-timeout";
    run.attemptId = "attempt-tool-timeout";
    run.preparedTurn.profile.timeout.completionMs = 20;
    run.preparedTurn.tools.push({
      name: "generate_image_async",
      description: "Generate a companion image asynchronously.",
      parameters: {
        type: "object",
        properties: { prompt: { type: "string" } },
        required: ["prompt"],
      },
    });
    const engine = new CompanionEngine({
      workspaces: new AttemptWorkspaceStore({
        canonicalRoot: join(root, "canonical"),
        privateRoot: join(root, "private"),
        memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
      }),
      plugin: async () => ({ name: "igrep", apply() {} }),
      adapter: () => adapter,
      igrepCommand: "igrep",
      igrepLlm: IGREP_LLM,
    });
    const server = createCompanionServer({
      authToken: AUTH_TOKEN,
      readiness: async () => { throw new Error("not used"); },
      invocation: engine,
    });
    servers.push(server);
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/v1/invocations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${AUTH_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ protocolVersion: 1, type: "run", invocation: run }),
    });
    const collected = await frames(response, async (frame) => {
      if (frame.type !== "commit") return;
      const control = await fetch(`${baseUrl}/v1/invocations/${run.invocationId}/commit`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${AUTH_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          protocolVersion: 1,
          type: "commit_ack",
          invocationId: run.invocationId,
          ack: {
            attemptId: run.attemptId,
            accepted: true,
            status: "committed",
            terminalMessageId: "assistant-tool-timeout-terminal",
            committedAt: new Date().toISOString(),
          },
        }),
      });
      expect(control.status).toBe(200);
    });

    expect(collected.filter((frame) => frame.type === "tool_call")).toHaveLength(1);
    expect(collected).toContainEqual(expect.objectContaining({
      type: "event",
      event: expect.objectContaining({
        type: "tool_finished",
        callId: "call-image-1",
        outcome: "unknown",
      }),
    }));
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1]?.messages.at(-1)).toMatchObject({
      content: [{
        type: "tool-result",
        isError: true,
        content: [{ type: "text", text: "Error: tool call timed out after 20ms" }],
      }],
    });
    expect(collected.find((frame) => frame.type === "commit")).toMatchObject({
      candidate: { execution: { steps: 2, toolCalls: 1 } },
    });
  });

  it.each(["normal"] as const)(
    "does not promote a rejected %s turn even when the plugin writes on session disposal",
    async (memoryMode) => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-reject-"));
    temporary.push(root);
    const configs: Record<string, unknown>[] = [];
    const run = invocation(memoryMode);
    run.invocationId = "inv-reject";
    run.attemptId = "attempt-reject";
    const engine = new CompanionEngine({
      workspaces: new AttemptWorkspaceStore({
        canonicalRoot: join(root, "canonical"),
        privateRoot: join(root, "private"),
        memoryProbe: { status: async (workspace) => ({ dialogueFiles: await dialogueCount(workspace) }) },
      }),
      plugin: async () => disposalWritingPlugin(configs),
      adapter: () => new OneStepAdapter(),
      igrepCommand: "igrep",
      igrepLlm: IGREP_LLM,
    });
    const server = createCompanionServer({
      authToken: AUTH_TOKEN,
      readiness: async () => { throw new Error("not used"); },
      invocation: engine,
    });
    servers.push(server);
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/v1/invocations`, {
      method: "POST",
      headers: { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ protocolVersion: 1, type: "run", invocation: run }),
    });
    const collected = await frames(response, async (frame) => {
      if (frame.type !== "commit") return;
      const control = await fetch(`${baseUrl}/v1/invocations/${run.invocationId}/commit`, {
        method: "POST",
        headers: { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          protocolVersion: 1,
          type: "commit_ack",
          invocationId: run.invocationId,
          ack: {
            attemptId: run.attemptId,
            accepted: false,
            status: "rejected",
            error: { code: "terminal_cas_conflict", message: "lost authority" },
          },
        }),
      });
      expect(control.status).toBe(200);
    });

    const canonicalWorkspace = relationshipWorkspacePath(
      join(root, "canonical"),
      run.userId,
      run.characterId,
    );
    expect(await dialogueCount(canonicalWorkspace)).toBe(0);
    expect(configs).toContainEqual(expect.objectContaining({
      ingest: true,
      wake: true,
      webProvider: false,
      webTool: false,
    }));
    expect(collected.some((frame) => frame.type === "event" && frame.event.type === "failed")).toBe(true);
    },
  );

  it("promotes normal memory only after commit acceptance and observable ingest", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-promote-"));
    temporary.push(root);
    const run = invocation("normal");
    run.invocationId = "inv-accept";
    run.attemptId = "attempt-accept";
    const engine = new CompanionEngine({
      workspaces: new AttemptWorkspaceStore({
        canonicalRoot: join(root, "canonical"),
        privateRoot: join(root, "private"),
        memoryProbe: { status: async (workspace) => ({ dialogueFiles: await dialogueCount(workspace) }) },
      }),
      plugin: async () => disposalWritingPlugin([]),
      adapter: () => new OneStepAdapter(),
      igrepCommand: "igrep",
      igrepLlm: IGREP_LLM,
    });
    const server = createCompanionServer({
      authToken: AUTH_TOKEN,
      readiness: async () => { throw new Error("not used"); },
      invocation: engine,
    });
    servers.push(server);
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/v1/invocations`, {
      method: "POST",
      headers: { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ protocolVersion: 1, type: "run", invocation: run }),
    });
    await frames(response, async (frame) => {
      if (frame.type !== "commit") return;
      const canonicalWorkspace = relationshipWorkspacePath(
        join(root, "canonical"),
        run.userId,
        run.characterId,
      );
      expect(await dialogueCount(canonicalWorkspace)).toBe(0);
      const control = await fetch(`${baseUrl}/v1/invocations/${run.invocationId}/commit`, {
        method: "POST",
        headers: { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          protocolVersion: 1,
          type: "commit_ack",
          invocationId: run.invocationId,
          ack: {
            attemptId: run.attemptId,
            accepted: true,
            status: "committed",
            terminalMessageId: "assistant-accepted",
            committedAt: new Date().toISOString(),
          },
        }),
      });
      expect(control.status).toBe(200);
    });

    const canonicalWorkspace = relationshipWorkspacePath(
      join(root, "canonical"),
      run.userId,
      run.characterId,
    );
    expect(await dialogueCount(canonicalWorkspace)).toBe(1);
    const canonicalTarget = await realpath(join(canonicalWorkspace, ".igrep"));
    const dialogueFile = (await readdir(join(canonicalTarget, "mem", "memory", "dialogues")))[0];
    const content = await readFile(join(canonicalTarget, "mem", "memory", "dialogues", dialogueFile ?? "missing"), "utf8");
    expect(content).toContain("What does it look like tonight?");
    expect(content).toContain("Tonight, every blue-lit window remembers us.");
  });

  it.each([
    ["user", 30_000],
    ["timeout", 40],
  ] as const)("converges a %s cancellation and removes its private workspace", async (reason, deadlineMs) => {
    const root = await mkdtemp(join(tmpdir(), `chat-agent-cancel-${reason}-`));
    temporary.push(root);
    const run = invocation("private");
    run.invocationId = `inv-cancel-${reason}`;
    run.attemptId = `attempt-cancel-${reason}`;
    run.deadlineAt = new Date(Date.now() + deadlineMs).toISOString();
    const engine = new CompanionEngine({
      workspaces: new AttemptWorkspaceStore({
        canonicalRoot: join(root, "canonical"),
        privateRoot: join(root, "private"),
        memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
      }),
      plugin: async () => ({ name: "igrep", apply() {} }),
      adapter: () => new BlockingAdapter(),
      igrepCommand: "igrep",
      igrepLlm: IGREP_LLM,
    });
    const server = createCompanionServer({
      authToken: AUTH_TOKEN,
      readiness: async () => { throw new Error("not used"); },
      invocation: engine,
    });
    servers.push(server);
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/v1/invocations`, {
      method: "POST",
      headers: { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ protocolVersion: 1, type: "run", invocation: run }),
    });
    let cancelSent = false;
    const collected = await frames(response, async (frame) => {
      if (reason !== "user" || cancelSent || frame.type !== "event" || frame.event.type !== "started") return;
      cancelSent = true;
      const control = await fetch(`${baseUrl}/v1/invocations/${run.invocationId}/cancel`, {
        method: "POST",
        headers: { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          protocolVersion: 1,
          type: "cancel",
          invocationId: run.invocationId,
          reason: "user",
        }),
      });
      expect(control.status).toBe(200);
    });
    expect(collected.filter((frame) => frame.type === "event" && frame.event.type === "cancelled"))
      .toEqual([expect.objectContaining({ event: expect.objectContaining({ reason }) })]);
    expect(await readdir(join(root, "private"))).toEqual([]);
  });

  it.each([
    ["user", 30_000],
    ["timeout", 80],
  ] as const)(
    "abandons a queued relationship workspace when the second invocation is cancelled by %s",
    async (reason, deadlineMs) => {
      const root = await mkdtemp(join(tmpdir(), `chat-agent-workspace-wait-${reason}-`));
      temporary.push(root);
      let adapterFactoryCalls = 0;
      const engine = new CompanionEngine({
        workspaces: new AttemptWorkspaceStore({
          canonicalRoot: join(root, "canonical"),
          privateRoot: join(root, "private"),
          memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
        }),
        plugin: async () => ({ name: "igrep", apply() {} }),
        adapter: () => {
          adapterFactoryCalls += 1;
          return new BlockingAdapter();
        },
        igrepCommand: "igrep",
        igrepLlm: IGREP_LLM,
      });
      const first = invocation("normal");
      first.invocationId = `inv-workspace-holder-${reason}`;
      first.attemptId = `attempt-workspace-holder-${reason}`;
      const firstFrames: CompanionRuntimeResponse[] = [];
      const firstRun = engine.run(first, (frame) => firstFrames.push(frame));

      try {
        await vi.waitFor(() => {
          expect(firstFrames).toContainEqual(expect.objectContaining({
            type: "event",
            event: expect.objectContaining({ type: "started" }),
          }));
        });

        const second = invocation("normal");
        second.invocationId = `inv-workspace-waiter-${reason}`;
        second.attemptId = `attempt-workspace-waiter-${reason}`;
        second.deadlineAt = new Date(Date.now() + deadlineMs).toISOString();
        const secondFrames: CompanionRuntimeResponse[] = [];
        const secondRun = engine.run(second, (frame) => secondFrames.push(frame));

        if (reason === "user") {
          await new Promise((resolve) => setTimeout(resolve, 25));
          await engine.accept({
            protocolVersion: 1,
            type: "cancel",
            invocationId: second.invocationId,
            reason: "user",
          });
        }

        expect(await Promise.race([
          secondRun.then(() => "settled" as const),
          new Promise<"stalled">((resolve) => setTimeout(() => resolve("stalled"), 500)),
        ])).toBe("settled");
        expect(secondFrames).toContainEqual(expect.objectContaining({
          type: "event",
          event: expect.objectContaining({ type: "cancelled", reason }),
        }));
        expect(adapterFactoryCalls).toBe(1);

        await engine.accept({
          protocolVersion: 1,
          type: "cancel",
          invocationId: first.invocationId,
          reason: "user",
        });
        await firstRun;
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(adapterFactoryCalls).toBe(1);

        const successor = invocation("normal");
        successor.invocationId = second.invocationId;
        successor.attemptId = `attempt-workspace-successor-${reason}`;
        const successorFrames: CompanionRuntimeResponse[] = [];
        const successorRun = engine.run(successor, (frame) => successorFrames.push(frame));
        await vi.waitFor(() => {
          expect(successorFrames).toContainEqual(expect.objectContaining({
            type: "event",
            event: expect.objectContaining({ type: "started" }),
          }));
        });
        expect(adapterFactoryCalls).toBe(2);
        await engine.accept({
          protocolVersion: 1,
          type: "cancel",
          invocationId: successor.invocationId,
          reason: "user",
        });
        await successorRun;
      } finally {
        await engine.shutdown();
        await firstRun;
      }
    },
  );

  it("cancels active DSH turns as shutdown before closing the HTTP server", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-shutdown-"));
    temporary.push(root);
    const run = invocation("private");
    run.invocationId = "inv-shutdown";
    run.attemptId = "attempt-shutdown";
    const engine = new CompanionEngine({
      workspaces: new AttemptWorkspaceStore({
        canonicalRoot: join(root, "canonical"),
        privateRoot: join(root, "private"),
        memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
      }),
      plugin: async () => ({ name: "igrep", apply() {} }),
      adapter: () => new BlockingAdapter(),
      igrepCommand: "igrep",
      igrepLlm: IGREP_LLM,
    });
    const server = createCompanionServer({
      authToken: AUTH_TOKEN,
      readiness: async () => { throw new Error("not used"); },
      invocation: engine,
    });
    servers.push(server);
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/v1/invocations`, {
      method: "POST",
      headers: { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ protocolVersion: 1, type: "run", invocation: run }),
    });
    const collectedPromise = frames(response);
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    const collected = await collectedPromise;
    expect(collected.some((frame) => frame.type === "event"
      && frame.event.type === "cancelled"
      && frame.event.reason === "shutdown")).toBe(true);
    expect(await readdir(join(root, "private"))).toEqual([]);
  });

  it("never promotes a rebuilt workspace after the Chat completion channel aborts", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-rebuild-abort-"));
    temporary.push(root);
    const workspaces = new AttemptWorkspaceStore({
      canonicalRoot: join(root, "canonical"),
      privateRoot: join(root, "private"),
      memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
    });
    const identity = { userId: "user-abort", characterId: "character-abort" };
    await workspaces.rebuildRelationship(identity, async (workspace) => {
      await writeFile(join(workspace, ".igrep", "old.txt"), "old authority");
    });
    const controller = new AbortController();
    const engine = new CompanionEngine({
      workspaces,
      plugin: async () => ({ name: "igrep", apply() {} }),
      adapter: () => new OneStepAdapter(),
      igrepCommand: "igrep",
      igrepLlm: IGREP_LLM,
      rebuilder: {
        rebuild: async (workspace) => {
          await writeFile(join(workspace, ".igrep", "new.txt"), "must not promote");
          controller.abort(new Error("Chat transaction disconnected"));
          return { sessions: 0, messages: 0 };
        },
      },
    });

    await expect(engine.rebuild({
      scope: "relationship",
      ...identity,
      messages: [],
    }, controller.signal)).rejects.toThrow(/Chat transaction disconnected/);

    const relationship = relationshipWorkspacePath(
      join(root, "canonical"),
      identity.userId,
      identity.characterId,
    );
    expect(await readFile(join(await realpath(join(relationship, ".igrep")), "old.txt"), "utf8"))
      .toBe("old authority");
    await expect(readFile(join(await realpath(join(relationship, ".igrep")), "new.txt"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bounds normal and private agents independently", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-capacity-"));
    temporary.push(root);
    const engine = new CompanionEngine({
      workspaces: new AttemptWorkspaceStore({
        canonicalRoot: join(root, "canonical"),
        privateRoot: join(root, "private"),
        memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
      }),
      plugin: async () => ({ name: "igrep", apply() {} }),
      adapter: () => new BlockingAdapter(),
      igrepCommand: "igrep",
      igrepLlm: IGREP_LLM,
      maxConcurrentAgents: { normal: 1, private: 1 },
    });
    const firstPrivate = invocation("private");
    firstPrivate.invocationId = "inv-capacity-private-1";
    firstPrivate.attemptId = "attempt-capacity-private-1";
    const secondPrivate = invocation("private");
    secondPrivate.invocationId = "inv-capacity-private-2";
    secondPrivate.attemptId = "attempt-capacity-private-2";
    const firstNormal = invocation("normal");
    firstNormal.invocationId = "inv-capacity-normal-1";
    firstNormal.attemptId = "attempt-capacity-normal-1";
    const secondNormal = invocation("normal");
    secondNormal.invocationId = "inv-capacity-normal-2";
    secondNormal.attemptId = "attempt-capacity-normal-2";

    const privateRun = engine.run(firstPrivate, () => undefined);
    await expect(engine.run(secondPrivate, () => undefined))
      .rejects.toThrow(/private.*capacity/);
    const normalRun = engine.run(firstNormal, () => undefined);
    await expect(engine.run(secondNormal, () => undefined))
      .rejects.toThrow(/normal.*capacity/);

    await engine.shutdown();
    await Promise.all([privateRun, normalRun]);
  });
});
