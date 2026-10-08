import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunInput, AgentRunProposal, AgentRunRecoveryScan } from "./agent-run-store.js";
import type { CompanionTerminalCandidate } from "./agent-runtime/contracts.js";
import { CompanionCapacityError } from "./agent-runtime/engine.js";
import { ChatFenceError } from "./fence.js";

const store = vi.hoisted(() => ({
  admitAgentRun: vi.fn(async () => ({ duplicate: false, terminal: false })),
  appendAgentRunEvent: vi.fn<(...args: Parameters<typeof import("./agent-run-store.js").appendAgentRunEvent>) => Promise<void>>(async () => undefined),
  completeAgentRun: vi.fn(async () => undefined),
  listIncompleteAgentRuns: vi.fn<() => Promise<AgentRunRecoveryScan>>(
    async () => ({ runs: [], failures: [] }),
  ),
  readAgentRunCompletion: vi.fn(async () => null),
  readAgentRunInput: vi.fn(),
  readAgentRunProposal: vi.fn<() => Promise<AgentRunProposal | null>>(async () => null),
  writeAgentRunProposal: vi.fn<typeof import("./agent-run-store.js").writeAgentRunProposal>(async () => undefined),
}));
const fence = vi.hoisted(() => ({
  fenceAttemptsThrough: vi.fn(async () => undefined),
  isFenced: vi.fn(async () => false),
}));
const logs = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), debug: vi.fn() }));
const runtime = vi.hoisted(() => ({
  runCompanion: vi.fn(),
}));
const projection = vi.hoisted(() => ({
  projectSceneForReply: vi.fn<typeof import("./scene.js").projectSceneForReply>(),
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

vi.mock("./agent-run-store.js", async importOriginal => ({
  ...await importOriginal<typeof import("./agent-run-store.js")>(),
  ...store,
}));
vi.mock("./fence.js", async importOriginal => ({
  ...await importOriginal<typeof import("./fence.js")>(),
  ...fence,
}));
vi.mock("./logger.js", () => ({ logger: logs }));
vi.mock("./scene.js", async importOriginal => ({
  ...await importOriginal<typeof import("./scene.js")>(),
  ...projection,
}));
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
    version: 6,
    characterName: "Companion",
    context: {
      policy: { imageToolEnabled: productContext.imageToolEnabled },
      userLocale: productContext.userLocale,
      scene: snapshot.scene ?? {
        schemaVersion: 1,
        version: 0,
        location: null,
        time: null,
        participants: [],
        emotionalBeat: null,
        unresolvedThreads: [],
      },
    },
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
    profile: {
      tier: "test", adapter: "openai-compatible-v1", provider: "openai", model: "test-model",
      baseUrl: "https://model.test/v1", supportsTools: true, maxOutputTokens: 1_024,
      timeout: { firstTokenMs: 1_000, idleMs: 1_000 },
      sampling: { temperature: 0.9, topP: 0.95, repetitionPenalty: 1.05 },
    },
    budget: { maxInputTokens: 4_000, usedInputTokens: 100, dropped: [] },
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
    CHAT_MODEL_API_KEY: "test-model-key",
    DSH_OPENROUTER_PROVIDER_ONLY: [],
  },
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
    deadlineAt: "2026-08-28T12:04:00.000Z",
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

function terminalCandidate(attemptId: string): CompanionTerminalCandidate {
  return {
    attemptId, content: "I stay beside you.", finishReason: "stop", provider: "openai", model: "test-model",
    usage: { promptTokens: 20, completionTokens: 8, reasoningTokens: 0 },
    execution: { steps: 1, toolCalls: 0 }, tools: [], completedAt: "2026-08-28T12:00:01.000Z",
  };
}

const unchangedProjection: typeof import("./scene.js").projectSceneForReply = async (input) => ({
  scene: { ...input.previous, version: input.previous.version + 1 },
  evidence: {
    version: "scene-projection-1", attemptId: input.attemptId, anchorVersion: input.previous.version,
    sourceMessageIds: { user: input.userMessageId, assistant: input.assistantMessageId },
    inputDigest: "f".repeat(64), promptDigest: "e".repeat(64), completionPromptDigest: "c".repeat(64), provider: "openai", model: "test-model",
    status: "unchanged", acceptedPhaseIds: [], durationMs: 0, changeCount: 0, requests: [], phases: [], usage: null,
  },
});

describe("AgentRun account-erasure drain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.appendAgentRunEvent.mockReset().mockResolvedValue(undefined);
    stream.appendStreamEvent.mockReset().mockResolvedValue(undefined);
    store.readAgentRunProposal.mockReset().mockResolvedValue(null);
    productContext.imageToolEnabled = true;
    productContext.userLocale = "en";
    projection.projectSceneForReply.mockImplementation(unchangedProjection);
    store.admitAgentRun.mockResolvedValue({ duplicate: false, terminal: false });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      accepted: true,
      duplicate: false,
      terminalMessageId: "assistant-1",
      committedAt: "2026-08-28T12:00:00.000Z",
    })));
    store.readAgentRunInput.mockResolvedValue(agentRunInput());
  });

  it.each(["start", "delta", "replace", "done"])("commits and cleans up the exact reply when Redis rejects %s", async failedType => {
    let proposal: AgentRunProposal | null = null;
    store.readAgentRunProposal.mockImplementation(async () => proposal);
    store.writeAgentRunProposal.mockImplementationOnce(async (_turnId, _attempt, value) => {
      proposal = value;
    });
    stream.appendStreamEvent.mockImplementation(async (_key, event) => {
      if ((event as { type: string }).type === failedType) throw new Error("Redis unavailable");
    });
    runtime.runCompanion.mockImplementationOnce(async (invocation, port) => {
      const identity = {
        invocationId: invocation.invocationId, attemptId: invocation.attemptId,
        occurredAt: "2026-08-28T12:00:00.000Z",
      };
      await port.emit({ ...identity, sequence: 1, type: "text_delta", delta: "Draft reply" });
      await port.emit({ ...identity, sequence: 2, type: "text_reset" });
      await port.emit({ ...identity, sequence: 3, type: "text_delta", delta: "I stay beside you." });
      await port.commit(terminalCandidate(invocation.attemptId));
    });

    await acceptAgentRun(agentRunInput());
    await vi.waitFor(() => expect(store.completeAgentRun).toHaveBeenCalled());
    await new Promise(resolve => setImmediate(resolve));

    expect(runtime.runCompanion).toHaveBeenCalledOnce();
    expect(store.writeAgentRunProposal).toHaveBeenCalledExactlyOnceWith("turn-1", 1, expect.objectContaining({
      terminal: expect.objectContaining({ status: "sent", content: "I stay beside you." }),
    }));
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
    expect(store.completeAgentRun).toHaveBeenCalledExactlyOnceWith("turn-1", 1, expect.objectContaining({ outcome: "committed" }));
    expect(stream.appendStreamEvent.mock.calls.filter(([, event]) => (event as { type: string }).type === failedType)).toHaveLength(1);
    await expect(cancelAgentRunsForUser("user-1")).resolves.toBe(0);
  });

  it("retries the same admitted attempt after capacity returns without persisting a failure", async () => {
    runtime.runCompanion.mockRejectedValueOnce(new CompanionCapacityError("normal"));
    await acceptAgentRun(agentRunInput());
    await vi.waitFor(() => expect(store.appendAgentRunEvent).toHaveBeenCalledWith(
      "turn-1", 1, "agent.deferred", { reason: "runtime_capacity", pool: "normal" },
    ));
    await new Promise(resolve => setImmediate(resolve));
    expect(store.writeAgentRunProposal).not.toHaveBeenCalled();
    expect(store.completeAgentRun).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    store.listIncompleteAgentRuns.mockResolvedValueOnce({
      runs: [{ turnId: "turn-1", attempt: 1, userId: "user-1" }], failures: [],
    });
    runtime.runCompanion.mockImplementationOnce(async (invocation, port) => {
      await port.commit(terminalCandidate(invocation.attemptId));
    });
    await expect(recoverIncompleteAgentRuns()).resolves.toEqual({ recovered: 1, failed: 0 });
    await vi.waitFor(() => expect(store.completeAgentRun).toHaveBeenCalled());
    expect(store.admitAgentRun).toHaveBeenCalledOnce();
    expect(runtime.runCompanion.mock.calls.map(([invocation]) => invocation.attemptId)).toEqual([
      "assistant-1:1", "assistant-1:1",
    ]);
    expect(store.writeAgentRunProposal).toHaveBeenCalledExactlyOnceWith("turn-1", 1, expect.objectContaining({
      terminal: expect.objectContaining({ status: "sent", attempt: 1 }),
    }));
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not propose a replacement terminal when a cancellation fences an active write", async () => {
    store.appendAgentRunEvent.mockRejectedValueOnce(new ChatFenceError({ scope: "attempt", turnId: "turn-1", attempt: 1 }));

    await acceptAgentRun(agentRunInput());
    await cancelAgentRunsForUser("user-1");

    expect(runtime.runCompanion).not.toHaveBeenCalled();
    expect(store.writeAgentRunProposal).not.toHaveBeenCalled();
    expect(store.completeAgentRun).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(logs.error).not.toHaveBeenCalled();
  });

  it("treats a fence arriving during failure persistence as a completed cancellation", async () => {
    runtime.runCompanion.mockRejectedValueOnce(new Error("runtime stopped"));
    store.writeAgentRunProposal.mockRejectedValueOnce(new ChatFenceError({ scope: "attempt", turnId: "turn-1", attempt: 1 }));

    await acceptAgentRun(agentRunInput());
    await cancelAgentRunsForUser("user-1");

    expect(store.writeAgentRunProposal).toHaveBeenCalledOnce();
    expect(store.completeAgentRun).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(logs.error).not.toHaveBeenCalled();
  });

  it("still reports an ordinary runtime error whose text resembles a fence", async () => {
    const error = new Error("AgentRun turn-1:1 is fenced");
    runtime.runCompanion.mockRejectedValueOnce(error);
    await acceptAgentRun(agentRunInput());
    await vi.waitFor(() => expect(logs.error).toHaveBeenCalledWith({ err: error, turnId: "turn-1", attempt: 1 }, "AgentRun failed"));
    expect(store.writeAgentRunProposal).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
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
    // Recovery consumes the first admission's pin, not a new wall-clock window.
    expect(runtime.runCompanion.mock.calls[0]?.[0]).toMatchObject({ deadlineAt: agentRunInput().deadlineAt });
  });

  it.each([
    { status: 429, body: { error: "rate_limited" } },
    { status: 401, body: { error: "unauthorized" } },
    { status: 200, body: { accepted: false } },
    { status: 200, body: { accepted: true, duplicate: false, terminalMessageId: "another-message", committedAt: "2026-08-28T12:00:00.000Z" } },
    { status: 200, body: { accepted: true, duplicate: false, terminalMessageId: "assistant-1", committedAt: "invalid-date" } },
  ])("retains the exact proposal without done or cleanup for an unconfirmed Main ACK: $status $body", async ({ status, body }) => {
    const proposal: AgentRunProposal = {
      schemaVersion: 1,
      attemptId: "assistant-1:1",
      proposedAt: "2026-08-28T12:00:00.000Z",
      terminal: {
        version: 1, turnId: "turn-1", sessionId: "session-1", assistantMessageId: "assistant-1", attempt: 1,
        status: "sent", content: "A durable reply.", model: "test-model",
        promptTokens: 10, completionTokens: 4, sceneVersion: 0, scene: null,
        terminalEvidence: { authority: "test", prompt: {
          productPromptVersion: "companion-product-1", preparedTurnVersion: 5,
          systemPromptDigest: "a".repeat(64), soulFingerprint: "b".repeat(64),
        } },
      },
    };
    store.listIncompleteAgentRuns.mockResolvedValueOnce({
      runs: [{ turnId: "turn-1", attempt: 1, userId: "user-1" }], failures: [],
    });
    store.readAgentRunProposal.mockResolvedValueOnce(proposal);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(body, { status })));

    await recoverIncompleteAgentRuns();
    await cancelAgentRunsForUser("user-1");

    expect(runtime.runCompanion).not.toHaveBeenCalled();
    expect(projection.projectSceneForReply).not.toHaveBeenCalled();
    expect(store.writeAgentRunProposal).not.toHaveBeenCalled();
    expect(store.completeAgentRun).not.toHaveBeenCalled();
    expect(stream.appendStreamEvent).not.toHaveBeenCalled();
    const request = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toEqual(proposal.terminal);

    store.listIncompleteAgentRuns.mockResolvedValueOnce({
      runs: [{ turnId: "turn-1", attempt: 1, userId: "user-1" }], failures: [],
    });
    store.readAgentRunProposal.mockResolvedValueOnce(proposal);
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({
      accepted: true, duplicate: true, terminalMessageId: "assistant-1",
      committedAt: "2026-08-28T12:00:00.000Z",
    }));
    await recoverIncompleteAgentRuns();
    await cancelAgentRunsForUser("user-1");
    expect(runtime.runCompanion).not.toHaveBeenCalled();
    expect(projection.projectSceneForReply).not.toHaveBeenCalled();
    expect(store.completeAgentRun).toHaveBeenCalledExactlyOnceWith("turn-1", 1, expect.objectContaining({ outcome: "committed" }));
    expect(stream.appendStreamEvent).toHaveBeenCalledExactlyOnceWith("stream:assistant-1", expect.objectContaining({ type: "done", attempt: 1 }));
    expect(vi.mocked(fetch).mock.calls[1]?.[1]?.body).toBe(request?.body);
  });

  it.each([true, false])("carries the Scene forward one version without projecting (reply usage known=%s)", async (replyKnown) => {
    const input = agentRunInput("Now we are at the beach.");
    input.snapshot.scene = { schemaVersion: 1, version: 4, location: "the kitchen", time: "tonight", participants: ["Mina"], emotionalBeat: "calm", unresolvedThreads: ["call the hotel"] };
    input.snapshot.sceneVersion = 4;
    store.readAgentRunInput.mockResolvedValue(input);
    const completed = Promise.withResolvers<void>();
    store.completeAgentRun.mockImplementationOnce(async () => { completed.resolve(); return undefined; });
    runtime.runCompanion.mockImplementationOnce(async (invocation, port, signal) => {
      const candidate = terminalCandidate(invocation.attemptId);
      await port.commit({ ...candidate, usage: replyKnown ? candidate.usage : null }, signal);
    });
    await acceptAgentRun(input);
    await completed.promise;
    expect(projection.projectSceneForReply).not.toHaveBeenCalled();
    expect(store.appendAgentRunEvent.mock.calls.filter(([, , kind]) => kind === "scene.projected")).toHaveLength(0);
    expect(store.writeAgentRunProposal).toHaveBeenCalledWith("turn-1", 1, expect.objectContaining({
      terminal: expect.objectContaining({
        status: "sent", sceneVersion: 5,
        scene: { ...input.snapshot.scene, version: 5 },
        promptTokens: replyKnown ? 20 : null, completionTokens: replyKnown ? 8 : null,
        terminalEvidence: expect.not.objectContaining({ sceneProjection: expect.anything() }),
      }),
    }));
    expect(stream.appendStreamEvent).toHaveBeenCalledWith("stream:assistant-1", expect.objectContaining({
      type: "done", attempt: 1, usage: { promptTokens: replyKnown ? 20 : null, completionTokens: replyKnown ? 8 : null },
    }));
  });

  it("preserves the original Scene anchor when the run is cancelled", async () => {
    const input = agentRunInput("Now we are at the beach.");
    input.snapshot.scene = { schemaVersion: 1, version: 4, location: "the kitchen", time: null, participants: ["Mina"], emotionalBeat: null, unresolvedThreads: [] };
    input.snapshot.sceneVersion = 4;
    store.readAgentRunInput.mockResolvedValue(input);
    const completed = Promise.withResolvers<void>();
    store.completeAgentRun.mockImplementationOnce(async () => { completed.resolve(); return undefined; });
    const controller = new AbortController();
    runtime.runCompanion.mockImplementationOnce(async (invocation, port) => {
      controller.abort(new Error("run deadline"));
      await port.emit({ invocationId: invocation.invocationId, attemptId: invocation.attemptId, sequence: 1, occurredAt: "2026-08-28T12:00:00.000Z", type: "cancelled", reason: "timeout" });
      await port.commit(terminalCandidate(invocation.attemptId), controller.signal);
    });
    await acceptAgentRun(input);
    await completed.promise;
    expect(store.writeAgentRunProposal).toHaveBeenCalledExactlyOnceWith("turn-1", 1, expect.objectContaining({
      terminal: expect.objectContaining({ status: "cancelled", sceneVersion: 4, scene: input.snapshot.scene, content: "" }),
    }));
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

  it("records Agent-authored image direction and its terminal evidence", async () => {
    const completed = Promise.withResolvers<void>();
    store.completeAgentRun.mockImplementationOnce(async () => {
      completed.resolve();
    });
    store.readAgentRunInput.mockResolvedValue(agentRunInput("给我一个你的裸照"));
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
      const content = "等我一下……";
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
        modelRequests: [{
          systemPromptDigest: "d".repeat(64), bodyDigest: "e".repeat(64),
          estimatedInputTokens: 100, maxInputTokens: 2_000,
        }],
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
      delta: "等我一下……",
    }));
    expect(store.writeAgentRunProposal).toHaveBeenCalledWith(
      "turn-1",
      1,
      expect.objectContaining({
        terminal: expect.objectContaining({
          status: "sent",
          content: "等我一下……",
          model: "test-model",
          terminalEvidence: expect.objectContaining({
            authority: "dsh_terminal_candidate",
            prompt: expect.objectContaining({
              productPromptVersion: "companion-product-1",
              systemPromptDigest: "d".repeat(64),
            }),
            preparedSystemPromptDigest: expect.any(String),
            modelRequests: [expect.objectContaining({ bodyDigest: "e".repeat(64) })],
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

  it("does not execute an image action when product policy disables it", async () => {
    const completed = Promise.withResolvers<void>();
    store.completeAgentRun.mockImplementationOnce(async () => {
      completed.resolve();
      return undefined;
    });
    store.readAgentRunInput.mockResolvedValue(agentRunInput("Send me a photo"));
    productContext.imageToolEnabled = false;
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
