import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  appendAgentRunEvent: vi.fn(async () => undefined),
  completeAgentRun: vi.fn(async () => undefined),
  fenceAgentRunAttempt: vi.fn(async () => undefined),
  isAgentRunTombstoned: vi.fn(async () => false),
  readAgentRunCompletion: vi.fn(async () => null),
  readAgentRunInput: vi.fn(),
  readAgentRunProposal: vi.fn(async () => null),
  writeAgentRunProposal: vi.fn(async () => undefined),
}));
const runtime = vi.hoisted(() => ({
  runCompanion: vi.fn(),
}));
const stream = vi.hoisted(() => ({
  appendStreamEvent: vi.fn(async () => undefined),
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
    characterName: "Companion",
    context: {
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
    messages: [{
      id: snapshot.userMessageId,
      role: "user",
      content: snapshot.userContent,
      sourceKind: "current_user",
    }],
    tools: [],
    profile: { provider: "openai", model: "test-model" },
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
vi.mock("@idream/shared/chat/image-action", () => ({
  REQUIRED_IMAGE_CAPTION_INSTRUCTION: "caption",
  requiredImageToolCallForUserRequest: vi.fn(() => null),
}));

import {
  cancelAgentRunsForUser,
  startAgentRun,
} from "./agent-runner.js";

describe("AgentRun account-erasure drain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      accepted: true,
      duplicate: false,
      terminalMessageId: "assistant-1",
      committedAt: "2026-08-28T12:00:00.000Z",
    })));
    store.readAgentRunInput.mockResolvedValue({
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
        characterReleaseId: null,
        characterVisualProfileId: null,
        characterVisualProfileVersion: null,
        memoryEnabled: true,
        contextRevision: 0,
        userContent: "hello",
        recentTurns: [],
        sceneVersion: 0,
        scene: null,
      },
      authority: {},
    });
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

    expect(startAgentRun("turn-1", 1, "user-1")).toBe(true);
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
});
