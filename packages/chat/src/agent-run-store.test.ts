import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as store from "./agent-run-store.js";
import type { AgentRunInput } from "./agent-run-store.js";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "idream-agent-run-"));
  roots.push(root);
  process.env.CHAT_FS_ROOT = root;
  return { root, store };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  delete process.env.CHAT_FS_ROOT;
});

describe("AgentRun local authority", () => {
  it("keeps only an exact proposal plus a bounded failed trace", async () => {
    // Exercise duplicate admission inside the seven-day retention window.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-27T12:00:02.000Z"));
    const { root, store } = await fixture();
    const input = {
      schemaVersion: 1 as const,
      admittedAt: "2026-08-27T12:00:00.000Z",
      snapshot: {
        version: 1 as const,
        turnId: "turn-1",
        sessionId: "session-1",
        userMessageId: "user-message-1",
        assistantMessageId: "assistant-message-1",
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
        hasRecentImageContext: false,
        recentTurns: [],
        sceneVersion: 0,
        scene: null,
      },
      authority: {
        version: 1 as const,
        user: { id: "user-1", displayName: null, locale: "en", status: "active", deletedAt: null, dataClass: "customer" },
        eligibility: { ageGateAccepted: true, ageVerified: true, jurisdiction: null, restrictedReason: null },
        entitlement: { modelTier: "free", unlimitedMessages: false, voiceEnabled: false, imageToolEnabled: true },
      },
    };
    await expect(store.admitAgentRun(input)).resolves.toEqual({ duplicate: false, terminal: false });
    await expect(store.admitAgentRun({
      ...input,
      admittedAt: "2026-08-27T12:00:02.000Z",
      authority: {
        ...input.authority,
        entitlement: { ...input.authority.entitlement, modelTier: "premium" },
      },
    })).resolves.toEqual({ duplicate: true, terminal: false });
    await store.appendAgentRunEvent("turn-1", 1, "started", { ok: true });
    const proposal = {
      schemaVersion: 1 as const,
      attemptId: "assistant-message-1:1",
      proposedAt: "2026-08-27T12:00:00.500Z",
      terminal: {
        version: 1 as const,
        turnId: "turn-1",
        sessionId: "session-1",
        assistantMessageId: "assistant-message-1",
        attempt: 1,
        status: "sent" as const,
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
            preparedTurnVersion: 4,
            systemPromptDigest: "a".repeat(64),
            soulFingerprint: "b".repeat(64),
          },
        },
      },
    };
    await store.writeAgentRunProposal("turn-1", 1, proposal);
    await expect(store.writeAgentRunProposal("turn-1", 1, {
      ...proposal,
      terminal: { ...proposal.terminal, content: "different" },
    })).rejects.toThrow("proposal is immutable");
    await expect(store.readAgentRunProposal("turn-1", 1)).resolves.toEqual(proposal);
    expect(await store.listIncompleteAgentRuns()).toEqual({
      runs: [{
        turnId: "turn-1",
        attempt: 1,
        userId: "user-1",
      }],
      failures: [],
    });
    expect(await readFile(path.join(root, "runs", "turn-1", "1", "events.jsonl"), "utf8"))
      .toContain('"kind":"started"');
    await store.completeAgentRun("turn-1", 1, {
      attemptId: "assistant-message-1:1",
      outcome: "failed",
      evidence: { digest: "abc" },
      completedAt: "2026-08-27T12:00:01.000Z",
    });
    expect(await store.listIncompleteAgentRuns()).toEqual({ runs: [], failures: [] });
    await expect(store.admitAgentRun(input)).resolves.toEqual({ duplicate: true, terminal: true });
    await expect(store.findAgentRunByAssistant("assistant-message-1"))
      .resolves.toMatchObject({ turnId: "turn-1", attempt: 1, userId: "user-1" });
    await expect(store.purgeAgentRunsForTurn("turn-1")).resolves.toBe(1);
    await expect(store.purgeAgentRunsForTurn("turn-1")).resolves.toBe(0);
    await expect(store.findAgentRunByAssistant("assistant-message-1")).resolves.toBeNull();
    await expect(store.admitAgentRun(input)).resolves.toMatchObject({ tombstoned: true });
    await expect(store.purgeAgentRunsForUser("user-1")).resolves.toBe(0);
    await expect(store.findAgentRunByAssistant("assistant-message-1")).resolves.toBeNull();
    await expect(store.admitAgentRun({
      ...input,
      snapshot: {
        ...input.snapshot,
        turnId: "turn-after-user-delete",
        userMessageId: "user-message-after-delete",
        assistantMessageId: "assistant-message-after-delete",
      },
    })).resolves.toMatchObject({ tombstoned: true });
  });

  it("isolates corrupt cleanup evidence while discovering and cleaning later runs", async () => {
    const { root, store } = await fixture();
    const corruptInput = path.join(root, "runs", "a-corrupt-input", "1", "input.json");
    const corruptCompletion = path.join(
      root,
      "runs",
      "b-corrupt-completion",
      "1",
      "completion.json",
    );
    const corruptIndex = path.join(root, "run-index", "assistant", "a-corrupt-index.json");
    await Promise.all([
      mkdir(path.dirname(corruptInput), { recursive: true }),
      mkdir(path.dirname(corruptCompletion), { recursive: true }),
      mkdir(path.dirname(corruptIndex), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(corruptInput, "{bad-input\n", "utf8"),
      writeFile(corruptCompletion, "{bad-completion\n", "utf8"),
      writeFile(corruptIndex, "{bad-index\n", "utf8"),
    ]);

    const validInput: AgentRunInput = {
      schemaVersion: 1,
      admittedAt: "2026-08-27T12:00:00.000Z",
      snapshot: {
        version: 1,
        turnId: "z-valid-turn",
        sessionId: "session-valid",
        userMessageId: "user-valid",
        assistantMessageId: "assistant-valid",
        attempt: 1,
        userId: "user-valid",
        characterId: "character-valid",
        characterContentVersionId: "content-valid",
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
        user: { id: "user-valid", displayName: null, locale: "en", status: "active", deletedAt: null, dataClass: "customer" },
        eligibility: { ageGateAccepted: true, ageVerified: true, jurisdiction: null, restrictedReason: null },
        entitlement: { modelTier: "free", unlimitedMessages: false, voiceEnabled: false, imageToolEnabled: true },
      },
    };
    await store.admitAgentRun(validInput);

    const expiredInput: AgentRunInput = {
      ...validInput,
      admittedAt: "2026-01-01T12:00:00.000Z",
      snapshot: {
        ...validInput.snapshot,
        turnId: "y-expired-turn",
        sessionId: "session-expired",
        userMessageId: "user-expired",
        assistantMessageId: "z-expired-index",
      },
    };
    await store.admitAgentRun(expiredInput);
    await store.completeAgentRun("y-expired-turn", 1, {
      attemptId: "z-expired-index:1",
      outcome: "failed",
      evidence: { code: "expired-fixture" },
      completedAt: "2026-01-01T12:00:01.000Z",
    });

    const scan = await store.listIncompleteAgentRuns();
    expect(scan.runs).toEqual([{
      turnId: "z-valid-turn",
      attempt: 1,
      userId: "user-valid",
    }]);
    expect(scan.failures).toHaveLength(3);
    expect(scan.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({
        evidencePath: path.join("runs", "a-corrupt-input", "1", "input.json"),
      }),
      expect.objectContaining({
        evidencePath: path.join("runs", "b-corrupt-completion", "1", "completion.json"),
      }),
      expect.objectContaining({
        evidencePath: path.join("run-index", "assistant", "a-corrupt-index.json"),
      }),
    ]));
    await expect(readFile(corruptInput, "utf8")).resolves.toBe("{bad-input\n");
    await expect(readFile(corruptCompletion, "utf8")).resolves.toBe("{bad-completion\n");
    await expect(readFile(corruptIndex, "utf8")).resolves.toBe("{bad-index\n");
    await expect(readFile(path.join(root, "runs", "y-expired-turn", "1", "input.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(root, "run-index", "assistant", "z-expired-index.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects identity reuse with different input", async () => {
    const { store } = await fixture();
    const base = {
      schemaVersion: 1 as const,
      admittedAt: "2026-08-27T12:00:00.000Z",
      snapshot: {
        version: 1 as const,
        turnId: "turn-2",
        sessionId: "session-2",
        userMessageId: "u-2",
        assistantMessageId: "a-2",
        attempt: 1,
        userId: "user-2",
        characterId: "character-2",
        characterContentVersionId: "content-2",
        characterReleaseId: "release-2",
        characterVisualProfileId: "visual-2",
        characterVisualProfileVersion: 2,
        memoryEnabled: false,
        contextRevision: 0,
        userContent: "first",
        hasRecentImageContext: false,
        recentTurns: [],
        sceneVersion: 0,
        scene: null,
      },
      authority: {
        version: 1 as const,
        user: { id: "user-2", displayName: null, locale: "en", status: "active", deletedAt: null, dataClass: "customer" },
        eligibility: { ageGateAccepted: true, ageVerified: true, jurisdiction: null, restrictedReason: null },
        entitlement: { modelTier: "free", unlimitedMessages: false, voiceEnabled: false, imageToolEnabled: true },
      },
    };
    await store.admitAgentRun(base);
    await expect(store.admitAgentRun({
      ...base,
      snapshot: { ...base.snapshot, userContent: "different" },
    })).rejects.toThrow("different input");
    await expect(store.purgeAgentRunsThroughAttempt("turn-2", 1)).resolves.toBe(1);
    await expect(store.admitAgentRun(base)).resolves.toMatchObject({ tombstoned: true });
    await expect(store.admitAgentRun({
      ...base,
      snapshot: { ...base.snapshot, attempt: 2 },
    })).resolves.toEqual({ duplicate: false, terminal: false });
  });

  it("lets a newer Main-signed attempt replace the prior assistant index before local completion", async () => {
    const { store } = await fixture();
    const input = {
      schemaVersion: 1 as const,
      admittedAt: "2026-08-27T12:00:00.000Z",
      snapshot: {
        version: 1 as const,
        turnId: "turn-regenerate",
        sessionId: "session-regenerate",
        userMessageId: "user-regenerate",
        assistantMessageId: "assistant-regenerate",
        attempt: 1,
        userId: "user-regenerate",
        characterId: "character-regenerate",
        characterContentVersionId: "content-regenerate",
        characterReleaseId: null,
        characterVisualProfileId: null,
        characterVisualProfileVersion: null,
        memoryEnabled: true,
        contextRevision: 0,
        userContent: "again",
        hasRecentImageContext: false,
        recentTurns: [],
        sceneVersion: 1,
        scene: { schemaVersion: 1 as const, version: 1, location: null, time: null, participants: [], emotionalBeat: null, unresolvedThreads: [] },
      },
      authority: {
        version: 1 as const,
        user: { id: "user-regenerate", displayName: null, locale: "en", status: "active", deletedAt: null, dataClass: "customer" },
        eligibility: { ageGateAccepted: true, ageVerified: true, jurisdiction: null, restrictedReason: null },
        entitlement: { modelTier: "free", unlimitedMessages: false, voiceEnabled: false, imageToolEnabled: true },
      },
    };
    await store.admitAgentRun(input);

    await expect(store.admitAgentRun({
      ...input,
      snapshot: { ...input.snapshot, attempt: 2, memoryEnabled: false },
    })).resolves.toEqual({ duplicate: false, terminal: false });
    await store.completeAgentRun("turn-regenerate", 1, {
      attemptId: "assistant-regenerate:1",
      outcome: "committed",
      evidence: {},
      completedAt: "2026-08-27T12:00:01.000Z",
    });
    await expect(store.findAgentRunByAssistant("assistant-regenerate"))
      .resolves.toEqual({ turnId: "turn-regenerate", attempt: 2, userId: "user-regenerate" });
  });
});
