import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompanionInvocation } from "./agent-runtime/contracts.js";
import { AttemptWorkspaceStore } from "./agent-runtime/workspace.js";
import {
  admitAgentRun,
  appendAgentRunEvent,
  completeAgentRun,
  listIncompleteAgentRuns,
  purgeAgentRunsForTurn,
  writeAgentRunProposal,
  type AgentRunInput,
} from "./agent-run-store.js";
import {
  fenceAttemptsThrough,
  fenceUser,
  isFenced,
  withDrainFence,
} from "./fence.js";

const temporary: string[] = [];
let workspaces: AttemptWorkspaceStore;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-fence-consistency-"));
  const canonicalRoot = await mkdtemp(join(tmpdir(), "chat-fence-canonical-"));
  const privateRoot = await mkdtemp(join(tmpdir(), "chat-fence-private-"));
  temporary.push(root, canonicalRoot, privateRoot);
  process.env.CHAT_FS_ROOT = root;
  workspaces = new AttemptWorkspaceStore({ canonicalRoot, privateRoot });
});

afterEach(async () => {
  delete process.env.CHAT_FS_ROOT;
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function runInput(overrides: {
  userId?: string;
  turnId?: string;
  attempt?: number;
} = {}): AgentRunInput {
  const userId = overrides.userId ?? "user-1";
  const turnId = overrides.turnId ?? "turn-1";
  const attempt = overrides.attempt ?? 1;
  return {
    schemaVersion: 1,
    admittedAt: "2026-09-12T00:00:00.000Z",
    snapshot: {
      version: 1,
      turnId,
      sessionId: "session-1",
      userMessageId: "user-message-1",
      assistantMessageId: `assistant-${turnId}-${attempt}`,
      attempt,
      userId,
      characterId: "character-1",
      characterContentVersionId: "content-1",
      characterReleaseId: null,
      characterVisualProfileId: null,
      characterVisualProfileVersion: null,
      memoryEnabled: true,
      contextRevision: 0,
      userContent: "hello",
      hasRecentImageContext: false,
      recentTurns: [],
      sceneVersion: 0,
      scene: null,
    },
    authority: {
      version: 1,
      user: {
        id: userId,
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

function invocation(userId = "user-1", characterId = "character-1"): CompanionInvocation {
  return {
    invocationId: `invocation-${userId}`,
    attemptId: `attempt-${userId}`,
    sessionId: "session-1",
    userId,
    characterId,
    memoryMode: "private",
    expectedProfileDigest: "d".repeat(64),
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    preparedTurn: {
      version: 5,
      model: "model-1",
      characterName: "Mira",
      messages: [{
        id: "user-message-1",
        sourceKind: "current_user",
        role: "user",
        content: "Remember this view.",
      }],
      tools: [],
      profile: {
        tier: "free",
        adapter: "openai-compatible-v1",
        provider: "local",
        baseUrl: "http://127.0.0.1:8061/v1",
        model: "model-1",
        supportsTools: true,
        maxOutputTokens: 100,
        timeout: { firstTokenMs: 1_000, idleMs: 1_000 },
        sampling: { temperature: 0.9, topP: 0.95, repetitionPenalty: 1.05 },
      },
      budget: { maxInputTokens: 2_000, usedInputTokens: 100, dropped: [] },
      trace: {
        productPromptVersion: "companion-product-1",
        systemPromptDigest: "b".repeat(64),
        characterContentVersionId: "content-1",
        characterReleaseId: "release-1",
        soulFingerprint: "a".repeat(64),
        compilerVersion: "soul-v1",
        sceneVersion: 1,
        contextRevision: "1",
      },
      requiredAction: null,
    },
  };
}

// SPEC: 这一组用例断言的是「fence 之后没有任何写入方还能写」。
// INTENT: fence 过去是四份各自为政的实现，每个 module 的测试只证明自己那份生效，
//   没有一条用例问过四者是否同意。跨 module 的分歧恰恰是危险的那一半：被
//   workspace 删掉的用户，store 依旧放行 admission。
describe("Chat fence consistency", () => {
  it("rejects every writer for a fenced user", async () => {
    await expect(admitAgentRun(runInput())).resolves.toMatchObject({ duplicate: false });

    await fenceUser("user-1");

    await expect(admitAgentRun(runInput({ turnId: "turn-2" })))
      .resolves.toMatchObject({ tombstoned: true });
    await expect(appendAgentRunEvent("turn-1", 1, "probe", {}))
      .rejects.toThrow(/Chat user is fenced/);
    await expect(writeAgentRunProposal("turn-1", 1, {
      schemaVersion: 1,
      attemptId: "assistant-turn-1-1:1",
      proposedAt: "2026-09-12T00:00:01.000Z",
      terminal: {
        version: 1,
        turnId: "turn-1",
        sessionId: "session-1",
        assistantMessageId: "assistant-turn-1-1",
        attempt: 1,
        status: "sent",
        content: "hello back",
        model: "model-1",
        promptTokens: 2,
        completionTokens: 3,
        sceneVersion: 0,
        scene: null,
        terminalEvidence: {
          authority: "test",
          prompt: {
            productPromptVersion: "companion-product-1",
            preparedTurnVersion: 5,
            systemPromptDigest: "a".repeat(64),
            soulFingerprint: "b".repeat(64),
          },
        },
      },
    })).rejects.toThrow(/Chat user is fenced/);
    await expect(completeAgentRun("turn-1", 1, {
      attemptId: "assistant-turn-1-1:1",
      outcome: "failed",
      evidence: {},
      completedAt: "2026-09-12T00:00:01.000Z",
    })).rejects.toThrow(/Chat user is fenced/);
    await expect(workspaces.prepare(invocation())).rejects.toThrow(/Chat user is fenced/);
    // Startup recovery is a writer too: a fenced user's leftover input must not
    // come back as a live run.
    await expect(listIncompleteAgentRuns()).resolves.toMatchObject({ runs: [] });
  });

  it("leaves another user writable when one user is fenced", async () => {
    await fenceUser("user-1");

    await expect(admitAgentRun(runInput({ userId: "user-2", turnId: "turn-9" })))
      .resolves.toMatchObject({ duplicate: false, terminal: false });
    await expect(appendAgentRunEvent("turn-9", 1, "probe", {})).resolves.toMatchObject({
      sequence: 1,
    });
    await expect(workspaces.prepare(invocation("user-2"))).resolves.toMatchObject({
      path: expect.any(String),
    });
  });

  it("agrees between the workspace store and the AgentRun store on one user fence", async () => {
    await admitAgentRun(runInput());

    // The workspace purge is the other module that fences a user; the AgentRun
    // store must see that same fence without being told.
    await workspaces.purge({ scope: "user", userId: "user-1" });

    await expect(isFenced({ scope: "user", userId: "user-1" })).resolves.toBe(true);
    await expect(admitAgentRun(runInput({ turnId: "turn-3" })))
      .resolves.toMatchObject({ tombstoned: true });
    await expect(appendAgentRunEvent("turn-1", 1, "probe", {}))
      .rejects.toThrow(/Chat user is fenced/);
  });

  it("rejects every attempt of a fenced Turn", async () => {
    await admitAgentRun(runInput());
    await purgeAgentRunsForTurn("turn-1");

    await expect(isFenced({ scope: "turn", turnId: "turn-1" })).resolves.toBe(true);
    await expect(admitAgentRun(runInput({ attempt: 7 })))
      .resolves.toMatchObject({ tombstoned: true });
    await expect(appendAgentRunEvent("turn-1", 7, "probe", {}))
      .rejects.toThrow(/AgentRun turn-1:7 is fenced/);
  });

  it("fences superseded attempts and keeps the regenerated attempt legal", async () => {
    await admitAgentRun(runInput());
    await fenceAttemptsThrough("turn-1", 1);

    await expect(isFenced({ scope: "attempt", turnId: "turn-1", attempt: 1 })).resolves.toBe(true);
    await expect(isFenced({ scope: "attempt", turnId: "turn-1", attempt: 2 })).resolves.toBe(false);
    await expect(isFenced({ scope: "turn", turnId: "turn-1" })).resolves.toBe(false);
    await expect(appendAgentRunEvent("turn-1", 1, "probe", {}))
      .rejects.toThrow(/AgentRun turn-1:1 is fenced/);
    await expect(admitAgentRun(runInput({ attempt: 2 })))
      .resolves.toMatchObject({ duplicate: false, terminal: false });
    await expect(appendAgentRunEvent("turn-1", 2, "probe", {})).resolves.toMatchObject({
      sequence: 1,
    });
  });

  // INVARIANT: 关系级 purge 是产品更正，不是删号。fence 只在 drain 期间成立，
  // 结束后这段关系必须重新可写，否则重建完的记忆永远上不了线。
  it("fences a relationship only while its purge drains", async () => {
    const scope = { scope: "relationship", userId: "user-1", characterId: "character-1" } as const;
    await withDrainFence(scope, async () => {
      await expect(isFenced(scope)).resolves.toBe(true);
      await expect(workspaces.prepare(invocation())).rejects.toThrow(/Chat relationship is fenced/);
    });

    await expect(isFenced(scope)).resolves.toBe(false);
    await expect(workspaces.prepare(invocation())).resolves.toMatchObject({
      path: expect.any(String),
    });
  });

  it("keeps a user fence after its drain releases", async () => {
    const scope = { scope: "user", userId: "user-1" } as const;
    await withDrainFence(scope, () => fenceUser("user-1"));

    await expect(isFenced(scope)).resolves.toBe(true);
    await expect(workspaces.prepare(invocation())).rejects.toThrow(/Chat user is fenced/);
  });
});
