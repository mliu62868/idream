import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as store from "./agent-run-store.js";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "idream-agent-run-"));
  roots.push(root);
  process.env.CHAT_FS_ROOT = root;
  return { root, store };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  delete process.env.CHAT_FS_ROOT;
});

describe("AgentRun local authority", () => {
  it("keeps only an exact proposal plus a bounded failed trace", async () => {
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
    expect(await store.listIncompleteAgentRuns()).toEqual([{
      turnId: "turn-1",
      attempt: 1,
      userId: "user-1",
    }]);
    expect(await readFile(path.join(root, "runs", "turn-1", "1", "events.jsonl"), "utf8"))
      .toContain('"kind":"started"');
    await store.completeAgentRun("turn-1", 1, {
      attemptId: "assistant-message-1:1",
      outcome: "failed",
      evidence: { digest: "abc" },
      completedAt: "2026-08-27T12:00:01.000Z",
    });
    expect(await store.listIncompleteAgentRuns()).toEqual([]);
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
        scene: { version: 1 },
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
