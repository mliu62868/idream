import { resolveChatModelProfile } from "@idream/shared";
import {
  COMPANION_DSH_COMMIT,
  COMPANION_DSH_VERSION,
  COMPANION_IGREP_PLUGIN_VERSION,
  COMPANION_IGREP_VERSION,
  COMPANION_RUNTIME_PROTOCOL_VERSION,
  type CompanionInvocation,
  type CompanionTerminalCandidate,
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
      execution: { steps: 1, toolCalls: 0 },
      completedAt: new Date().toISOString(),
    };
    await port.emit({ ...eventBase(), type: "terminal_candidate", candidate });
    await port.commit(candidate);
  }
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
    igrepVersion: COMPANION_IGREP_VERSION,
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
