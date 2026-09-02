import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequiredImageAction } from "@idream/shared/chat/image-action";
import type { AgentRunInput, AgentRunRecoveryScan } from "./agent-run-store.js";

const store = vi.hoisted(() => ({
  admitAgentRun: vi.fn(async () => ({ duplicate: false, terminal: false })),
  appendAgentRunEvent: vi.fn(async () => undefined),
  completeAgentRun: vi.fn(async () => undefined),
  fenceAgentRunAttempt: vi.fn(async () => undefined),
  isAgentRunTombstoned: vi.fn(async () => false),
  listIncompleteAgentRuns: vi.fn<() => Promise<AgentRunRecoveryScan>>(
    async () => ({ runs: [], failures: [] }),
  ),
  readAgentRunCompletion: vi.fn(async () => null),
  readAgentRunInput: vi.fn(),
  readAgentRunProposal: vi.fn(async () => null),
  writeAgentRunProposal: vi.fn(async () => undefined),
}));
const runtime = vi.hoisted(() => ({
  runCompanion: vi.fn(),
}));
const imageAction = vi.hoisted(() => ({
  requiredImageActionForUserRequest: vi.fn<() => RequiredImageAction | null>(() => null),
}));
const productContext = vi.hoisted(() => ({
  imageToolEnabled: true,
  userLocale: "en",
}));
const stream = vi.hoisted(() => ({
  appendStreamEvent: vi.fn<(key: string, event: unknown) => Promise<void>>(
    async () => undefined,
  ),
}));

vi.mock("./agent-run-store.js", () => store);
vi.mock("./agent-runtime/runtime.js", () => ({
  agentRuntimeProfileDigest: vi.fn(async () => "profile-digest"),
  agentRuntimeVersions: vi.fn(async () => ({
    igrepVersion: "igrep-test",
    pluginVersion: "plugin-test",
  })),
  runCompanion: runtime.runCompanion,
}));
vi.mock("./prepared-turn.js", () => ({
  prepareCompanionTurn: vi.fn(async ({ snapshot }) => ({
    version: 4,
    characterName: "Companion",
    context: {
      policy: { imageToolEnabled: productContext.imageToolEnabled },
      userLocale: productContext.userLocale,
      scene: {
        schemaVersion: 1,
        version: 0,
        location: null,
        time: null,
        participants: [],
        emotionalBeat: null,
        unresolvedThreads: [],
      },
    },
    requiredAction: productContext.imageToolEnabled
      ? imageAction.requiredImageActionForUserRequest()
      : null,
    messages: [
      {
        id: "system-1",
        role: "system",
        content: "System prompt",
        sourceKind: "plugin",
      },
      {
        id: snapshot.userMessageId,
        role: "user",
        content: snapshot.userContent,
        sourceKind: "current_user",
      },
    ],
    tools: [],
    profile: { provider: "openai", model: "test-model" },
    trace: {
      productPromptVersion: "companion-product-1",
      systemPromptDigest: "a".repeat(64),
      soulFingerprint: "b".repeat(64),
    },
  })),
}));
vi.mock("./stream.js", () => ({
  appendStreamEvent: stream.appendStreamEvent,
  streamKey: vi.fn((id: string) => `stream:${id}`),
}));
vi.mock("./env.js", () => ({
  env: {
    AGENT_RUN_DEADLINE_MS: 30_000,
    INTERNAL_TOKEN: "test-token",
    MAIN_INTERNAL_BASE_URL: "http://main.test",
  },
}));
vi.mock("@idream/shared/chat/image-action", async (importOriginal) => ({
  ...await importOriginal<typeof import("@idream/shared/chat/image-action")>(),
  requiredImageActionForUserRequest:
    imageAction.requiredImageActionForUserRequest,
}));

import {
  acceptAgentRun,
  cancelAgentRunsForUser,
  recoverIncompleteAgentRuns,
} from "./agent-runner.js";

function agentRunInput(userContent = "hello"): AgentRunInput {
  return {
    schemaVersion: 1,
    admittedAt: "2026-08-28T11:59:00.000Z",
    snapshot: {
      version: 1,
      turnId: "turn-1",
      sessionId: "session-1",
      userMessageId: "user-message-1",
      assistantMessageId: "assistant-1",
      attempt: 1,
      userId: "user-1",
      characterId: "character-1",
      characterContentVersionId: "content-1",
      characterReleaseId: "release-1",
      characterVisualProfileId: null,
      characterVisualProfileVersion: null,
      memoryEnabled: true,
      contextRevision: 0,
      userContent,
      hasRecentImageContext: false,
      recentTurns: [],
      sceneVersion: 0,
      scene: null,
    },
    authority: {
      version: 1,
      user: {
        id: "user-1",
        displayName: null,
        locale: "en",
        status: "active",
        deletedAt: null,
        dataClass: "customer",
      },
      eligibility: {
        ageGateAccepted: true,
        ageVerified: true,
        jurisdiction: null,
        restrictedReason: null,
      },
      entitlement: {
        modelTier: "free",
        unlimitedMessages: false,
        voiceEnabled: false,
        imageToolEnabled: true,
      },
    },
  };
}

describe("AgentRun account-erasure drain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    productContext.imageToolEnabled = true;
    productContext.userLocale = "en";
    imageAction.requiredImageActionForUserRequest.mockReturnValue(null);
    store.admitAgentRun.mockResolvedValue({ duplicate: false, terminal: false });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      accepted: true,
      duplicate: false,
      terminalMessageId: "assistant-1",
      committedAt: "2026-08-28T12:00:00.000Z",
    })));
    store.readAgentRunInput.mockResolvedValue(agentRunInput());
  });

  it("recovers valid runs while reporting neighboring invalid evidence", async () => {
    const completed = Promise.withResolvers<void>();
    store.listIncompleteAgentRuns.mockResolvedValueOnce({
      runs: [{ turnId: "turn-1", attempt: 1, userId: "user-1" }],
      failures: [{
        evidencePath: "runs/corrupt-turn/1/input.json",
        reason: "invalid JSON",
      }],
    });
    store.completeAgentRun.mockImplementationOnce(async () => {
      completed.resolve();
    });
    runtime.runCompanion.mockRejectedValueOnce(new Error("fixture runtime failure"));

    await expect(recoverIncompleteAgentRuns()).resolves.toEqual({ recovered: 1, failed: 1 });
    await completed.promise;
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.readAgentRunInput).toHaveBeenCalledWith("turn-1", 1);
  });

  it("waits for the user's active writer to finish after aborting it", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    runtime.runCompanion.mockImplementation(async (_invocation, _port, signal: AbortSignal) => {
      started.resolve();
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await release.promise;
      throw signal.reason;
    });

    await expect(acceptAgentRun(agentRunInput())).resolves.toEqual({
      duplicate: false,
      terminal: false,
    });
    await started.promise;
    let drained = false;
    const draining = cancelAgentRunsForUser("user-1").then((count) => {
      drained = true;
      return count;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);

    release.resolve();
    await expect(draining).resolves.toBe(1);
    expect(store.writeAgentRunProposal).toHaveBeenCalledOnce();
    await expect(cancelAgentRunsForUser("user-1")).resolves.toBe(0);
  });

  it("routes a required image action through the Agent-authored prompt and caption", async () => {
    const completed = Promise.withResolvers<void>();
    store.completeAgentRun.mockImplementationOnce(async () => {
      completed.resolve();
    });
    store.readAgentRunInput.mockResolvedValue(agentRunInput("给我一个你的裸照"));
    imageAction.requiredImageActionForUserRequest.mockReturnValue({
      name: "generate_image_async",
      requestedNudity: "full",
    });
    runtime.runCompanion.mockImplementation(async (invocation, port) => {
      await port.executeTool({
        attemptId: invocation.attemptId,
        callId: "model-tool-call-1",
        name: "generate_image_async",
        effectScope: "turn_action",
        intent: { requestedNudity: "full" },
        arguments: {
          prompt: "Candid fully nude portrait by a rain-lit bedroom window, relaxed pose, intimate eye contact, warm practical light",
          orientation: "4:5",
          outputCount: 1,
        },
      });
      const content = "靠近一点，只给你看。";
      await port.emit({
        invocationId: invocation.invocationId,
        attemptId: invocation.attemptId,
        sequence: 1,
        occurredAt: "2026-08-28T12:00:00.000Z",
        type: "text_delta",
        delta: content,
      });
      await port.commit({
        attemptId: invocation.attemptId,
        content,
        finishReason: "stop",
        provider: "openai",
        model: "test-model",
        usage: { promptTokens: 20, completionTokens: 8, reasoningTokens: 0 },
        execution: { steps: 2, toolCalls: 1 },
        tools: [{
          attemptId: invocation.attemptId,
          callId: "model-tool-call-1",
          name: "generate_image_async",
          effectScope: "turn_action",
          intent: { requestedNudity: "full" },
          argumentsDigest: "c".repeat(64),
        }],
        completedAt: "2026-08-28T12:00:01.000Z",
      });
    });

    await expect(acceptAgentRun(agentRunInput("给我一个你的裸照"))).resolves.toEqual({
      duplicate: false,
      terminal: false,
    });
    await completed.promise;

    const streamPayloads = stream.appendStreamEvent.mock.calls.map(([, event]) => event);
    expect(streamPayloads).toContainEqual(expect.objectContaining({
      type: "delta",
      delta: "靠近一点，只给你看。",
    }));
    expect(store.writeAgentRunProposal).toHaveBeenCalledWith(
      "turn-1",
      1,
      expect.objectContaining({
        terminal: expect.objectContaining({
          status: "sent",
          content: "靠近一点，只给你看。",
          model: "test-model",
          terminalEvidence: expect.objectContaining({
            authority: "dsh_terminal_candidate",
            prompt: expect.objectContaining({
              productPromptVersion: "companion-product-1",
            }),
            tools: [expect.objectContaining({
              callId: "model-tool-call-1",
              name: "generate_image_async",
            })],
          }),
        }),
      }),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(runtime.runCompanion).toHaveBeenCalledOnce();
    const toolRequest = vi.mocked(fetch).mock.calls.find(([input]) =>
      String(input).endsWith("/api/internal/chat/tool-effects")
    );
    expect(JSON.parse(String(toolRequest?.[1]?.body))).toMatchObject({
      version: 2,
      effectScope: "turn_action",
      intent: { requestedNudity: "full" },
      arguments: {
        prompt: expect.stringContaining("fully nude"),
      },
    });
  });

  it("fails the turn instead of inventing a generic image prompt when the Agent fails", async () => {
    const completed = Promise.withResolvers<void>();
    store.completeAgentRun.mockImplementationOnce(async () => {
      completed.resolve();
    });
    store.readAgentRunInput.mockResolvedValue(agentRunInput("Send me a photo"));
    imageAction.requiredImageActionForUserRequest.mockReturnValue({
      name: "generate_image_async",
      requestedNudity: "unspecified",
    });
    runtime.runCompanion.mockImplementation(async (invocation, port) => {
      await port.emit({
        invocationId: invocation.invocationId,
        attemptId: invocation.attemptId,
        sequence: 1,
        occurredAt: "2026-08-28T12:00:00.000Z",
        type: "failed",
        error: {
          code: "provider_first_token_timeout",
          message: "provider first-token timeout",
          retryable: true,
        },
      });
    });

    await expect(acceptAgentRun(agentRunInput("Send me a photo"))).resolves.toEqual({
      duplicate: false,
      terminal: false,
    });
    await completed.promise;

    expect(store.writeAgentRunProposal).toHaveBeenCalledWith(
      "turn-1",
      1,
      expect.objectContaining({
        terminal: expect.objectContaining({
          status: "failed",
          content: "",
          promptTokens: null,
          completionTokens: null,
          terminalEvidence: expect.objectContaining({
            authority: "chat_agent_run",
            prompt: expect.objectContaining({
              productPromptVersion: "companion-product-1",
            }),
            failureCode: "provider_first_token_timeout",
          }),
        }),
      }),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(runtime.runCompanion).toHaveBeenCalledOnce();
  });

  it("does not execute a required image action when product policy disables it", async () => {
    const completed = Promise.withResolvers<void>();
    store.completeAgentRun.mockImplementationOnce(async () => {
      completed.resolve();
      return undefined;
    });
    store.readAgentRunInput.mockResolvedValue(agentRunInput("Send me a photo"));
    productContext.imageToolEnabled = false;
    imageAction.requiredImageActionForUserRequest.mockReturnValue({
      name: "generate_image_async",
      requestedNudity: "unspecified",
    });
    runtime.runCompanion.mockImplementation(async (invocation, port) => {
      await port.commit({
        attemptId: invocation.attemptId,
        content: "I cannot use images in this chat.",
        finishReason: "stop",
        provider: "openai",
        model: "test-model",
        usage: { promptTokens: 10, completionTokens: 8, reasoningTokens: 0 },
        execution: { steps: 1, toolCalls: 0 },
        tools: [],
        completedAt: "2026-08-28T12:00:01.000Z",
      });
    });

    await expect(acceptAgentRun(agentRunInput("Send me a photo"))).resolves.toEqual({
      duplicate: false,
      terminal: false,
    });
    await completed.promise;

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(runtime.runCompanion).toHaveBeenCalledOnce();
  });

  it("reconciles an ambiguous Main acknowledgement with the same tool identity", async () => {
    const completed = Promise.withResolvers<void>();
    store.completeAgentRun.mockImplementationOnce(async () => {
      completed.resolve();
      return undefined;
    });
    store.readAgentRunInput.mockResolvedValue(agentRunInput("Send me a photo"));
    imageAction.requiredImageActionForUserRequest.mockReturnValue({
      name: "generate_image_async",
      requestedNudity: "unspecified",
    });
    runtime.runCompanion.mockImplementation(async (invocation, port) => {
      await port.executeTool({
        attemptId: invocation.attemptId,
        callId: "model-tool-call-1",
        name: "generate_image_async",
        effectScope: "turn_action",
        intent: { requestedNudity: "unspecified" },
        arguments: {
          prompt: "Companion taking a candid selfie beside a bright window",
          orientation: "4:5",
          outputCount: 1,
        },
      });
      await port.commit({
        attemptId: invocation.attemptId,
        content: "For you.",
        finishReason: "stop",
        provider: "openai",
        model: "test-model",
        usage: { promptTokens: 12, completionTokens: 3, reasoningTokens: 0 },
        execution: { steps: 2, toolCalls: 1 },
        tools: [{
          attemptId: invocation.attemptId,
          callId: "model-tool-call-1",
          name: "generate_image_async",
          effectScope: "turn_action",
          intent: { requestedNudity: "unspecified" },
          argumentsDigest: "d".repeat(64),
        }],
        completedAt: "2026-08-28T12:00:01.000Z",
      });
    });
    let toolRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/api/internal/chat/tool-effects")) {
        toolRequests += 1;
        if (toolRequests === 1) throw new Error("response lost after commit");
        return Response.json({
          accepted: true,
          duplicate: true,
          attachmentId: "attachment-1",
          status: "accepted",
          generationJobId: "job-1",
          mediaAssetId: null,
          costDreamcoins: 5,
        });
      }
      return Response.json({
        accepted: true,
        duplicate: false,
        terminalMessageId: "assistant-1",
        committedAt: "2026-08-28T12:00:00.000Z",
      });
    }));

    await expect(acceptAgentRun(agentRunInput("Send me a photo"))).resolves.toEqual({
      duplicate: false,
      terminal: false,
    });
    await completed.promise;

    expect(toolRequests).toBe(2);
    const toolBodies = vi.mocked(fetch).mock.calls
      .filter(([input]) => String(input).endsWith("/api/internal/chat/tool-effects"))
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(toolBodies[0]).toEqual(toolBodies[1]);
    expect(runtime.runCompanion).toHaveBeenCalledOnce();
  });
});
