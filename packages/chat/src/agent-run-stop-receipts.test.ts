import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  admitAgentRun,
  appendAgentRunEvent,
  appendAgentRunModelRequest,
  findAgentRunByAssistant,
  listIncompleteAgentRuns,
  purgeAgentRunsForTurn,
  purgeAgentRunsForUser,
  purgeAgentRunsThroughAttempt,
  readAgentRunCompletion,
  readAgentRunInput,
  readAgentRunProposal,
  recordAgentRunCancellation,
  writeAgentRunProposal,
  type AgentRunEvent,
  type AgentRunInput,
  type AgentRunProposal,
} from "./agent-run-store.js";
import type { CompanionModelRequestEvidence } from "./agent-runtime/contracts.js";
import {
  ChatFenceError,
  fenceKey,
  fenceUser,
  isAttemptReceiptFenced,
  isFenced,
  withDrainFence,
  withFenceLock,
} from "./fence.js";

const NOW = "2026-10-23T03:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1_000;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "idream-stop-receipts-"));
  vi.stubEnv("CHAT_FS_ROOT", root);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function input(attempt = 1): AgentRunInput {
  return {
    schemaVersion: 1,
    admittedAt: NOW,
    deadlineAt: "2026-10-23T03:05:00.000Z",
    snapshot: {
      version: 1, turnId: "turn-stop", sessionId: "session-stop", attempt,
      userMessageId: "message-user", assistantMessageId: "message-assistant",
      userId: "user-stop", characterId: "character-stop", characterContentVersionId: "content-stop",
      characterReleaseId: "release-stop", characterVisualProfileId: null, characterVisualProfileVersion: null,
      memoryEnabled: false, contextRevision: 0, userContent: "PRIVATE_INPUT_SENTINEL",
      hasRecentImageContext: false, recentTurns: [], sceneVersion: 0, scene: null,
    },
    authority: {
      version: 1,
      user: { id: "user-stop", displayName: null, locale: "en", status: "active", deletedAt: null, dataClass: "customer" },
      eligibility: { ageGateAccepted: true, ageVerified: true, jurisdiction: null, restrictedReason: null },
      entitlement: { modelTier: "free", unlimitedMessages: false, voiceEnabled: false, imageToolEnabled: false },
    },
  };
}

function receipt(usage: CompanionModelRequestEvidence["usage"] = { inputTokens: 17, outputTokens: 4, cacheReadTokens: 3 }): CompanionModelRequestEvidence {
  return {
    bodyDigest: "a".repeat(64), systemPromptDigest: "b".repeat(64), estimatedInputTokens: 100,
    purpose: "compaction", provider: "local", model: "model-stop", usage,
  };
}

function proposal(attempt = 1): AgentRunProposal {
  return {
    schemaVersion: 1, attemptId: `message-assistant:${attempt}`, proposedAt: NOW,
    terminal: {
      version: 1, turnId: "turn-stop", sessionId: "session-stop", assistantMessageId: "message-assistant", attempt,
      status: "sent", content: "PRIVATE_REPLY_SENTINEL", model: "model-stop", promptTokens: 17, completionTokens: 4,
      sceneVersion: 0, scene: null, terminalEvidence: {
        authority: "test",
        prompt: { productPromptVersion: "companion-product-1", preparedTurnVersion: 6,
          systemPromptDigest: "b".repeat(64), soulFingerprint: "c".repeat(64) },
      },
    },
  };
}

function runPath(attempt = 1, file = "") {
  return join(root, "runs", "turn-stop", String(attempt), file);
}

function indexPath() {
  return join(root, "run-index", "assistant", "message-assistant.json");
}

async function events(attempt = 1): Promise<AgentRunEvent[]> {
  try {
    return (await readFile(runPath(attempt, "events.jsonl"), "utf8")).trim().split("\n").filter(Boolean)
      .map(line => JSON.parse(line) as AgentRunEvent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

describe("Stop preserves only bounded execution receipts", () => {
  it.each([
    { name: "known", usage: { inputTokens: 17, outputTokens: 4, cacheReadTokens: 3 } },
    { name: "zero", usage: { inputTokens: 0, outputTokens: 0 } },
    { name: "unknown", usage: null },
  ])("retains $name usage after Stop while generic writes and proposals stay fenced", async ({ usage }) => {
    await admitAgentRun(input());
    await recordAgentRunCancellation("turn-stop", 1);
    const completion = await readAgentRunCompletion("turn-stop", 1);
    const beforeIndex = await readFile(indexPath(), "utf8");
    const request = receipt(usage);

    await expect(appendAgentRunModelRequest("turn-stop", 1, request)).resolves.toMatchObject({
      kind: "pi.model_request", payload: { request },
    });
    await expect(appendAgentRunEvent("turn-stop", 1, "pi.model_request", { request }))
      .rejects.toBeInstanceOf(ChatFenceError);
    await expect(writeAgentRunProposal("turn-stop", 1, proposal())).rejects.toBeInstanceOf(ChatFenceError);

    expect(await events()).toHaveLength(1);
    expect(JSON.stringify(await events())).not.toContain("PRIVATE_");
    expect(await readAgentRunProposal("turn-stop", 1)).toBeNull();
    expect(await readAgentRunCompletion("turn-stop", 1)).toEqual(completion);
    expect(await readFile(indexPath(), "utf8")).toBe(beforeIndex);
    expect(await isFenced({ scope: "attempt", turnId: "turn-stop", attempt: 1 })).toBe(true);
    expect(await listIncompleteAgentRuns()).toEqual({ runs: [], failures: [] });
  });

  it.each(["attempt", "turn", "user"] as const)("never reopens a %s purge when Stop is replayed", async scope => {
    await admitAgentRun(input());
    await recordAgentRunCancellation("turn-stop", 1);
    await appendAgentRunModelRequest("turn-stop", 1, receipt());
    if (scope === "attempt") await purgeAgentRunsThroughAttempt("turn-stop", 1);
    if (scope === "turn") await purgeAgentRunsForTurn("turn-stop");
    if (scope === "user") await purgeAgentRunsForUser("user-stop");

    await recordAgentRunCancellation("turn-stop", 1);
    await recordAgentRunCancellation("turn-stop", 1);
    await expect(appendAgentRunModelRequest("turn-stop", 1, receipt(null))).rejects.toBeInstanceOf(ChatFenceError);
    expect(await isAttemptReceiptFenced("turn-stop", 1)).toBe(true);
    expect(await readAgentRunInput("turn-stop", 1)).toBeNull();
    expect(await readAgentRunCompletion("turn-stop", 1)).toBeNull();
    expect(await findAgentRunByAssistant("message-assistant")).toBeNull();
    await expect(stat(runPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([1, null])("keeps legacy fence throughAttempt=%s closed after a late Stop", async throughAttempt => {
    await admitAgentRun(input());
    await mkdir(join(root, "run-tombstones"), { recursive: true });
    await writeFile(join(root, "run-tombstones", "turn-stop.json"), JSON.stringify({
      schemaVersion: 1, throughAttempt, updatedAt: NOW,
    }));

    await recordAgentRunCancellation("turn-stop", 1);
    await expect(appendAgentRunModelRequest("turn-stop", 1, receipt())).rejects.toBeInstanceOf(ChatFenceError);
    expect(await isAttemptReceiptFenced("turn-stop", 1)).toBe(true);
    expect(await readAgentRunCompletion("turn-stop", 1)).toBeNull();
    expect(await events()).toEqual([]);
  });

  it("keeps a newer attempt's shared assistant index and receipt permission after delayed Stop and purge", async () => {
    await admitAgentRun(input(1));
    await admitAgentRun(input(2));
    const currentIndex = await readFile(indexPath(), "utf8");

    await recordAgentRunCancellation("turn-stop", 1);
    await appendAgentRunModelRequest("turn-stop", 1, receipt());
    expect(await readFile(indexPath(), "utf8")).toBe(currentIndex);
    expect(await findAgentRunByAssistant("message-assistant")).toMatchObject({ attempt: 2 });

    await purgeAgentRunsThroughAttempt("turn-stop", 1);
    await recordAgentRunCancellation("turn-stop", 1);
    await expect(appendAgentRunModelRequest("turn-stop", 1, receipt())).rejects.toBeInstanceOf(ChatFenceError);
    await expect(appendAgentRunModelRequest("turn-stop", 2, receipt(null))).resolves.toMatchObject({
      payload: { request: { usage: null } },
    });
    expect(await readFile(indexPath(), "utf8")).toBe(currentIndex);
    expect((await readAgentRunInput("turn-stop", 2))?.snapshot.attempt).toBe(2);
    expect(await listIncompleteAgentRuns()).toEqual({
      runs: [{ turnId: "turn-stop", attempt: 2, userId: "user-stop" }], failures: [],
    });
  });

  it.each(["user", "relationship"] as const)("rejects receipts throughout a %s drain without extending retention", async scope => {
    await admitAgentRun(input());
    await recordAgentRunCancellation("turn-stop", 1);
    const completion = await readAgentRunCompletion("turn-stop", 1);
    vi.setSystemTime(Date.parse(NOW) + DAY_MS);
    const fence = scope === "user"
      ? { scope: "user" as const, userId: "user-stop" }
      : { scope: "relationship" as const, userId: "user-stop", characterId: "character-stop" };

    await withDrainFence(fence, async () => {
      await expect(appendAgentRunModelRequest("turn-stop", 1, receipt())).rejects.toBeInstanceOf(ChatFenceError);
      await recordAgentRunCancellation("turn-stop", 1);
      expect(await events()).toEqual([]);
      expect(await readAgentRunCompletion("turn-stop", 1)).toEqual(completion);
    });
    await expect(appendAgentRunModelRequest("turn-stop", 1, receipt())).resolves.toMatchObject({ kind: "pi.model_request" });
    expect(await readAgentRunCompletion("turn-stop", 1)).toEqual(completion);
  });

  it("honors a user tombstone even while the old input and run directory still exist", async () => {
    await admitAgentRun(input());
    await recordAgentRunCancellation("turn-stop", 1);
    await fenceUser("user-stop");
    await expect(appendAgentRunModelRequest("turn-stop", 1, receipt())).rejects.toBeInstanceOf(ChatFenceError);
    expect(await readAgentRunInput("turn-stop", 1)).not.toBeNull();
    expect(await events()).toEqual([]);
  });

  it.each(["user", "turn", "attempt"] as const)("lets a queued %s purge win over a concurrent late receipt without a lock inversion", async scope => {
    await admitAgentRun(input());
    await recordAgentRunCancellation("turn-stop", 1);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const lock = scope === "user"
      ? fenceKey({ scope: "user", userId: "user-stop" })
      : fenceKey({ scope: "turn", turnId: "turn-stop" });
    const ownerLock = withFenceLock(lock, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const purge = scope === "user" ? purgeAgentRunsForUser("user-stop")
      : scope === "turn" ? purgeAgentRunsForTurn("turn-stop")
        : purgeAgentRunsThroughAttempt("turn-stop", 1);
    const lateReceipt = appendAgentRunModelRequest("turn-stop", 1, receipt());
    const results = Promise.allSettled([purge, lateReceipt]);
    release.resolve();
    await ownerLock;
    const [purged, rejected] = await results;
    expect(purged).toMatchObject({ status: "fulfilled", value: 1 });
    expect(rejected).toMatchObject({ status: "rejected", reason: expect.any(ChatFenceError) });
    await expect(stat(runPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("expires seven days after the first Stop and never renews through receipts or repeated Stop", async () => {
    await admitAgentRun(input());
    await recordAgentRunCancellation("turn-stop", 1);
    const completionBytes = await readFile(runPath(1, "completion.json"), "utf8");
    const indexBytes = await readFile(indexPath(), "utf8");
    expect(await readAgentRunCompletion("turn-stop", 1)).toMatchObject({
      completedAt: NOW, expiresAt: new Date(Date.parse(NOW) + 7 * DAY_MS).toISOString(), outcome: "cancelled",
    });

    vi.setSystemTime(Date.parse(NOW) + 7 * DAY_MS - 1);
    await recordAgentRunCancellation("turn-stop", 1);
    await appendAgentRunModelRequest("turn-stop", 1, receipt());
    expect(await readFile(runPath(1, "completion.json"), "utf8")).toBe(completionBytes);
    expect(await readFile(indexPath(), "utf8")).toBe(indexBytes);

    vi.setSystemTime(Date.parse(NOW) + 7 * DAY_MS);
    await recordAgentRunCancellation("turn-stop", 1);
    await expect(appendAgentRunModelRequest("turn-stop", 1, receipt(null))).rejects.toBeInstanceOf(ChatFenceError);
    expect(await readFile(runPath(1, "completion.json"), "utf8")).toBe(completionBytes);
    expect(await listIncompleteAgentRuns()).toEqual({ runs: [], failures: [] });
    await expect(stat(runPath())).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(indexPath())).rejects.toMatchObject({ code: "ENOENT" });

    await recordAgentRunCancellation("turn-stop", 1);
    await expect(appendAgentRunModelRequest("turn-stop", 1, receipt())).rejects.toBeInstanceOf(ChatFenceError);
    await expect(stat(runPath())).rejects.toMatchObject({ code: "ENOENT" });
    expect(await findAgentRunByAssistant("message-assistant")).toBeNull();
  });

  it("cleans an expired stopped attempt without removing a newer shared assistant index", async () => {
    await admitAgentRun(input(1));
    await recordAgentRunCancellation("turn-stop", 1);
    vi.setSystemTime(Date.parse(NOW) + 6 * DAY_MS);
    await admitAgentRun(input(2));
    const currentIndex = await readFile(indexPath(), "utf8");
    vi.setSystemTime(Date.parse(NOW) + 7 * DAY_MS);
    await listIncompleteAgentRuns();
    await expect(stat(runPath(1))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(indexPath(), "utf8")).toBe(currentIndex);
    expect(await findAgentRunByAssistant("message-assistant")).toMatchObject({ attempt: 2 });
    await recordAgentRunCancellation("turn-stop", 1);
    expect(await readFile(indexPath(), "utf8")).toBe(currentIndex);
  });

  it.each(["missing-run", "missing-input"] as const)("does not create execution state for %s", async missing => {
    if (missing === "missing-input") {
      await admitAgentRun(input());
      await appendAgentRunEvent("turn-stop", 1, "started", {});
      await rm(runPath(1, "input.json"));
    }
    await expect(appendAgentRunModelRequest("turn-stop", 1, receipt())).rejects.toBeInstanceOf(ChatFenceError);
    await recordAgentRunCancellation("turn-stop", 1);
    await expect(appendAgentRunModelRequest("turn-stop", 1, receipt(null))).rejects.toBeInstanceOf(ChatFenceError);
    expect(await readAgentRunInput("turn-stop", 1)).toBeNull();
    expect(await readAgentRunCompletion("turn-stop", 1)).toBeNull();
    if (missing === "missing-run") await expect(stat(runPath())).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await readdir(runPath())).toEqual(["events.jsonl"]);
  });

  it.each([
    { content: "PRIVATE_FORGED_BODY" },
    { messages: [{ role: "user", content: "PRIVATE_FORGED_BODY" }] },
    { usage: { inputTokens: 1, outputTokens: 1, content: "PRIVATE_FORGED_BODY" } },
  ])("rejects unrecognized text-bearing receipt data without appending it: %j", async forged => {
    await admitAgentRun(input());
    await recordAgentRunCancellation("turn-stop", 1);
    await expect(appendAgentRunModelRequest("turn-stop", 1, { ...receipt(), ...forged })).rejects.toThrow();
    expect(await events()).toEqual([]);
    expect(await readAgentRunProposal("turn-stop", 1)).toBeNull();
  });
});
