import { appendFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  admitAgentRun, appendAgentRunEvent, listIncompleteAgentRuns, readAgentRunCompletion,
  writeAgentRunProposal, type AgentRunInput, type AgentRunProposal,
} from "./agent-run-store.js";

const runtime = vi.hoisted(() => ({ runCompanion: vi.fn() }));
const stream = vi.hoisted(() => ({ appendStreamEvent: vi.fn(async () => undefined) }));
vi.mock("./agent-runtime/runtime.js", () => ({
  ...runtime,
  agentRuntimeProfileDigest: vi.fn(),
  agentRuntimeVersions: vi.fn(),
}));
vi.mock("./stream.js", () => ({ ...stream, streamKey: (id: string) => `stream:${id}` }));

import { cancelAgentRunsForUser, recoverIncompleteAgentRuns } from "./agent-runner.js";

let root: string;
const NOW = "2026-10-29T12:00:00.000Z";
const input: AgentRunInput = {
  schemaVersion: 1, admittedAt: NOW,
  snapshot: {
    version: 1, turnId: "turn-journal", sessionId: "session-journal",
    userMessageId: "user-message-journal", assistantMessageId: "assistant-journal", attempt: 1,
    userId: "user-journal", characterId: "character-journal", characterContentVersionId: "content-journal",
    characterReleaseId: null, characterVisualProfileId: null, characterVisualProfileVersion: null,
    memoryEnabled: true, contextRevision: 0, userContent: "hello", hasRecentImageContext: false,
    recentTurns: [], sceneVersion: 0, scene: null,
  },
  authority: {
    version: 1,
    user: { id: "user-journal", displayName: null, locale: "en", status: "active", deletedAt: null, dataClass: "customer" },
    eligibility: { ageGateAccepted: true, ageVerified: true, jurisdiction: null, restrictedReason: null },
    entitlement: { modelTier: "free", unlimitedMessages: false, voiceEnabled: false, imageToolEnabled: true },
  },
};

const proposal: AgentRunProposal = {
  schemaVersion: 1, attemptId: "assistant-journal:1", proposedAt: NOW,
  terminal: {
    version: 1, turnId: "turn-journal", sessionId: "session-journal", assistantMessageId: "assistant-journal", attempt: 1,
    status: "sent", content: "The exact original reply. 🌙", model: "test-model", promptTokens: 17, completionTokens: 4,
    sceneVersion: 0, scene: null,
    terminalEvidence: { authority: "historical-runtime", prompt: {
      productPromptVersion: "companion-product-1", preparedTurnVersion: 6,
      systemPromptDigest: "a".repeat(64), soulFingerprint: "b".repeat(64),
    } },
  },
};

function runFile(name: string): string { return join(root, "runs", "turn-journal", "1", name); }

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  root = await mkdtemp(join(tmpdir(), "idream-journal-recovery-"));
  vi.stubEnv("CHAT_FS_ROOT", root);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({
    accepted: true, duplicate: false, terminalMessageId: "assistant-journal", committedAt: NOW,
  })));
  await admitAgentRun(input);
});

afterEach(async () => {
  await cancelAgentRunsForUser("user-journal");
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("AgentRun recovery with interrupted journal writes", () => {
  it("replays the exact proposal after a torn tail and retains the damaged bytes until diagnostic expiry", async () => {
    await appendAgentRunEvent("turn-journal", 1, "pi.started", { modelRequestJournalVersion: 1 });
    await writeAgentRunProposal("turn-journal", 1, proposal);
    // Include a physically incomplete UTF-8 code point, not only malformed JSON.
    await appendFile(runFile("events.jsonl"), Buffer.concat([Buffer.from('{"kind":"pi.finished","payload":"'), Buffer.from([0xf0, 0x9f])]));
    const damaged = await readFile(runFile("events.jsonl"));

    await recoverIncompleteAgentRuns();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await vi.waitFor(async () => expect(await readAgentRunCompletion("turn-journal", 1)).toMatchObject({ outcome: "committed" }));

    expect(runtime.runCompanion).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.body).toBe(JSON.stringify(proposal.terminal));
    await expect(readFile(runFile("proposal.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const evidence = (await readdir(runFile("."))).filter(name => name.startsWith("events.interrupted-"));
    expect(evidence).toHaveLength(1);
    expect(await readFile(runFile(evidence[0]!))).toEqual(damaged);

    await expect(recoverIncompleteAgentRuns()).resolves.toEqual({ recovered: 0, failed: 0 });
    expect(fetch).toHaveBeenCalledOnce();
    vi.setSystemTime(Date.parse(NOW) + 7 * 24 * 60 * 60 * 1_000);
    await listIncompleteAgentRuns();
    await expect(readFile(runFile(evidence[0]!))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("settles an interrupted dispatch conservatively while preserving known request evidence across Main retry", async () => {
    const request = {
      bodyDigest: "c".repeat(64), systemPromptDigest: "a".repeat(64), estimatedInputTokens: 20,
      provider: "openai", model: "test-model", usage: null,
    };
    await appendAgentRunEvent("turn-journal", 1, "pi.model_request_started", { request });
    const measured = { ...request, usage: { inputTokens: 17, outputTokens: 4 } };
    await appendAgentRunEvent("turn-journal", 1, "pi.model_request", { request: measured });
    await appendAgentRunEvent("turn-journal", 1, "pi.model_request_started", { request });
    await appendFile(runFile("events.jsonl"), '{"kind":"pi.model_request","payload":');
    const damaged = await readFile(runFile("events.jsonl"));
    vi.mocked(fetch).mockResolvedValueOnce(new Response("Main unavailable", { status: 503 }));

    await recoverIncompleteAgentRuns();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await cancelAgentRunsForUser("user-journal");
    const firstBody = vi.mocked(fetch).mock.calls[0]?.[1]?.body;
    expect(JSON.parse(String(firstBody))).toMatchObject({
      status: "failed", model: "test-model", promptTokens: null, completionTokens: null,
      terminalEvidence: { failureCode: "agent_run_interrupted", modelRequests: [measured, request] },
    });
    expect(await readAgentRunCompletion("turn-journal", 1)).toBeNull();
    expect(runtime.runCompanion).not.toHaveBeenCalled();

    await recoverIncompleteAgentRuns();
    await vi.waitFor(async () => expect(await readAgentRunCompletion("turn-journal", 1)).toMatchObject({ outcome: "failed" }));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls[1]?.[1]?.body).toBe(firstBody);
    expect(runtime.runCompanion).not.toHaveBeenCalled();
    const evidence = (await readdir(runFile("."))).filter(name => name.startsWith("events.interrupted-"));
    expect(evidence).toHaveLength(1);
    expect(await readFile(runFile(evidence[0]!))).toEqual(damaged);
  });

  it.each(["failed", "unknown"] as const)("does not resume paid dispatch after a durable %s prepared-media lookup", async outcome => {
    const request = { bodyDigest: "c".repeat(64), systemPromptDigest: "a".repeat(64), estimatedInputTokens: 20,
      provider: "openai", model: "test-model", usage: null };
    await appendAgentRunEvent("turn-journal", 1, "pi.model_request_started", { request });
    await appendAgentRunEvent("turn-journal", 1, "pi.tool_started", { callId: "lookup-1", name: "search_character_media" });
    await appendAgentRunEvent("turn-journal", 1, "pi.tool_finished", { callId: "lookup-1", name: "search_character_media", outcome, durationMs: 1 });

    await recoverIncompleteAgentRuns();
    await vi.waitFor(async () => expect(await readAgentRunCompletion("turn-journal", 1)).toMatchObject({ outcome: "failed" }));

    expect(runtime.runCompanion).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body))).toMatchObject({
      status: "failed", terminalEvidence: { failureCode: "agent_run_interrupted", modelRequests: [request] },
    });
    await expect(recoverIncompleteAgentRuns()).resolves.toEqual({ recovered: 0, failed: 0 });
    expect(runtime.runCompanion).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["truncated", "missing newline"])("never dispatches after repairing a %s first record and crashing again before a proposal", async damage => {
    const started = { schemaVersion: 1, sequence: 1, occurredAt: NOW, kind: "pi.started", payload: { modelRequestJournalVersion: 1 } };
    await appendFile(runFile("events.jsonl"), damage === "truncated" ? '{"schemaVersion":1,"kind":' : JSON.stringify(started));
    // Repair completed, but the process exited before it could save a proposal.
    await appendAgentRunEvent("turn-journal", 1, "recovery.observed", {});

    await recoverIncompleteAgentRuns();
    await vi.waitFor(async () => expect(await readAgentRunCompletion("turn-journal", 1)).toMatchObject({ outcome: "failed" }));
    expect(runtime.runCompanion).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body))).toMatchObject({
      status: "failed", terminalEvidence: { failureCode: "agent_run_interrupted", modelRequests: [] },
    });
  });

  it("does not repair or hide malformed middle records while replaying a proposal", async () => {
    await writeAgentRunProposal("turn-journal", 1, proposal);
    await appendFile(runFile("events.jsonl"), '{"kind":\n' + JSON.stringify({
      schemaVersion: 1, sequence: 2, occurredAt: NOW, kind: "pi.finished", payload: {},
    }) + "\n");
    const damaged = await readFile(runFile("events.jsonl"));

    await recoverIncompleteAgentRuns();
    await cancelAgentRunsForUser("user-journal");

    expect(fetch).not.toHaveBeenCalled();
    expect(runtime.runCompanion).not.toHaveBeenCalled();
    expect(await readAgentRunCompletion("turn-journal", 1)).toBeNull();
    expect(await readFile(runFile("events.jsonl"))).toEqual(damaged);
    expect((await readdir(runFile("."))).filter(name => name.startsWith("events.interrupted-"))).toEqual([]);
    expect(JSON.parse(await readFile(runFile("proposal.json"), "utf8"))).toEqual(proposal);
  });
});
