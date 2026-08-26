import { resolveChatModelProfile } from "@idream/shared";
import {
  COMPANION_DSH_COMMIT,
  COMPANION_DSH_VERSION,
  COMPANION_IGREP_PLUGIN_VERSION,
  COMPANION_RUNTIME_PROTOCOL_VERSION,
  companionToolCallSchema,
  type CompanionInvocation,
  type CompanionTerminalCandidate,
  type CompanionToolCall,
} from "@idream/shared/chat/companion-runtime";
import type { ChatPrismaClient } from "../src/db.js";
import {
  processGenerate,
  type GenerateHooks,
  type GeneratePayload,
} from "../src/generate.js";
import type {
  CompanionRuntime,
  CompanionRuntimePort,
} from "../src/companion-runtime.js";
import { probeCompanionSidecar } from "../src/companion-sidecar-readiness.js";

const TEST_DSH_NORMAL_DIGEST = "a".repeat(64);
const TEST_DSH_PRIVATE_DIGEST = "b".repeat(64);
const TEST_IGREP_VERSION = "9.8.7";
const TEST_DSH_TOOL_CALLS_ENV = "CHAT_TEST_DSH_TOOL_CALLS_JSON";

let readinessVerified = false;

/** Populate the same authenticated digest cache production generation requires. */
async function verifyTestCompanionSidecar(): Promise<void> {
  if (readinessVerified) return;
  const profile = resolveChatModelProfile(process.env);
  await probeCompanionSidecar({
    baseUrl: process.env.DSH_AGENT_URL ?? "http://127.0.0.1:3101",
    token: process.env.DSH_AGENT_TOKEN ?? "test-dsh-token",
    expectedProvider: profile.provider,
    expectedBaseUrl: profile.baseUrl,
    expectedModel: profile.model,
    full: true,
    fetchImpl: async () => Response.json(testReadiness()),
  });
  readinessVerified = true;
}

export async function processGenerateWithTestDsh(
  payload: GeneratePayload,
  prisma: ChatPrismaClient,
  hooks: GenerateHooks = {},
) {
  await verifyTestCompanionSidecar();
  return processGenerate(payload, prisma, {
    ...hooks,
    runtimeFactory: () => new TestDshRuntime(),
  });
}

export function testCompanionSidecarProbe() {
  return async () => {
    await verifyTestCompanionSidecar();
    return testReadiness();
  };
}

export function testCompanionWorkspaceFetch(): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    if (url.endsWith("/v1/workspaces/rebuild/prepare")) {
      // Consume the real NDJSON stream: transport failures must remain visible
      // in DB integration tests instead of becoming detached fixture promises.
      await new Response(init?.body).text();
      return Response.json({
        ok: true,
        rebuilt: {
          rebuildId: "77777777-7777-4777-8777-777777777777",
          sessions: 0,
          messages: 0,
        },
      });
    }
    if (url.endsWith("/v1/workspaces/rebuild/promote")) {
      return Response.json({ ok: true, rebuilt: { sessions: 0, messages: 0 } });
    }
    if (url.endsWith("/v1/workspaces/rebuild/discard")) {
      return Response.json({ ok: true });
    }
    if (url.endsWith("/v1/workspaces/purge")) {
      return Response.json({ ok: true, purged: 0 });
    }
    if (url.endsWith("/v1/workspaces/memory-cutover-proof")) {
      return Response.json({ ok: true, proof: null });
    }
    return Response.json({ ok: false, error: "unexpected companion workspace test URL" }, {
      status: 404,
    });
  };
}

export async function withTestDshToolCalls<T>(
  calls: readonly Omit<CompanionToolCall, "attemptId">[],
  run: () => Promise<T>,
): Promise<T> {
  const previous = process.env[TEST_DSH_TOOL_CALLS_ENV];
  process.env[TEST_DSH_TOOL_CALLS_ENV] = JSON.stringify(calls);
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env[TEST_DSH_TOOL_CALLS_ENV];
    } else {
      process.env[TEST_DSH_TOOL_CALLS_ENV] = previous;
    }
  }
}

class TestDshRuntime implements CompanionRuntime {
  async cancel(): Promise<void> {}

  async run(
    invocation: CompanionInvocation,
    port: CompanionRuntimePort,
    signal?: AbortSignal,
  ): Promise<void> {
    let sequence = 0;
    const eventBase = () => ({
      invocationId: invocation.invocationId,
      attemptId: invocation.attemptId,
      sequence: ++sequence,
      occurredAt: new Date().toISOString(),
    });
    await port.emit({
      ...eventBase(),
      type: "started",
      instance: testReadiness().instance,
      profileDigest: invocation.memoryMode === "private"
        ? TEST_DSH_PRIVATE_DIGEST
        : TEST_DSH_NORMAL_DIGEST,
    });
    if (signal?.aborted) throw new Error("test companion invocation aborted");

    const lastUser = [...invocation.preparedTurn.messages]
      .reverse()
      .find((message) => message.role === "user");
    const toolCalls = testToolCalls(invocation);
    for (const call of toolCalls) {
      await port.executeTool(call);
      if (signal?.aborted) throw new Error("test companion invocation aborted");
    }
    const content = `Mock ${invocation.preparedTurn.characterName || "character"} reply: ${lastUser?.content ?? ""}`.trim();
    await port.emit({ ...eventBase(), type: "text_delta", delta: content });
    const usage = {
      promptTokens: invocation.preparedTurn.budget.usedInputTokens,
      completionTokens: Math.max(1, Math.ceil(content.length / 4)),
      reasoningTokens: 0,
    };
    await port.emit({ ...eventBase(), type: "usage", usage });
    const candidate: CompanionTerminalCandidate = {
      attemptId: invocation.attemptId,
      content,
      finishReason: "stop",
      provider: invocation.preparedTurn.profile.provider,
      model: invocation.preparedTurn.profile.model,
      usage,
      execution: { steps: 1 + toolCalls.length, toolCalls: toolCalls.length },
      completedAt: new Date().toISOString(),
    };
    await port.emit({ ...eventBase(), type: "terminal_candidate", candidate });
    await port.commit(candidate);
  }
}

function testToolCalls(invocation: CompanionInvocation): CompanionToolCall[] {
  const raw = process.env[TEST_DSH_TOOL_CALLS_ENV];
  if (!raw) return [];
  const configured = JSON.parse(raw) as Array<Omit<CompanionToolCall, "attemptId">>;
  const allowed = new Set(invocation.preparedTurn.tools.map((tool) => tool.name));
  return configured.flatMap((call) => {
    if (!allowed.has(call.name)) return [];
    return companionToolCallSchema.parse({
      ...call,
      attemptId: invocation.attemptId,
    });
  });
}

function testReadiness() {
  const profile = resolveChatModelProfile(process.env);
  return {
    protocolVersion: COMPANION_RUNTIME_PROTOCOL_VERSION,
    service: "dsh-companion" as const,
    ready: true as const,
    checkedAt: new Date().toISOString(),
    dshVersion: COMPANION_DSH_VERSION,
    dshCommit: COMPANION_DSH_COMMIT,
    igrepVersion: TEST_IGREP_VERSION,
    pluginVersion: COMPANION_IGREP_PLUGIN_VERSION,
    instance: {
      id: "11111111-1111-4111-8111-111111111111",
      startedAt: "2026-08-19T11:59:00.000Z",
    },
    provider: {
      name: profile.provider,
      baseUrl: profile.baseUrl,
      model: profile.model,
      resolved: true as const,
    },
    profiles: {
      normal: {
        name: "normal" as const,
        loaded: true as const,
        executionCompositionDigest: TEST_DSH_NORMAL_DIGEST,
        capabilities: {
          memoryRead: true as const,
          memoryWrite: true as const,
          tools: true as const,
          commit: true as const,
        },
      },
      private: {
        name: "private" as const,
        loaded: true as const,
        executionCompositionDigest: TEST_DSH_PRIVATE_DIGEST,
        capabilities: {
          memoryRead: false as const,
          memoryWrite: false as const,
          tools: true as const,
          commit: true as const,
        },
      },
    },
    bridges: {
      toolReachable: true as const,
      commitReachable: true as const,
      workspaceRebuildReachable: true as const,
    },
    verification: {
      duplicateIngest: { replayedSessions: 1, duplicateDialogueFiles: 0 as const },
      crossScope: { probes: 1, leakedResults: 0 as const },
    },
  };
}
