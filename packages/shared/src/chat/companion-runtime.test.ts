import { describe, expect, it } from "vitest";
import {
  COMPANION_RUNTIME_PROTOCOL_VERSION,
  companionWorkspaceRebuildBudget,
  companionWorkspaceRebuildSchema,
  companionWorkspaceRebuildSessionIngestTimeoutMs,
  createCompanionWorkspaceRebuildStream,
  decodeCompanionWorkspaceRebuildFrame,
  encodeCompanionWorkspaceRebuildFrame,
  projectCompanionProbeDshEvidence,
  type CompanionWorkspaceRebuildMessage,
} from "./companion-runtime";

const messages: CompanionWorkspaceRebuildMessage[] = [
  {
    id: "user-1",
    sessionId: "session-1",
    role: "user",
    content: "remember the blue door",
    createdAt: "2026-08-28T12:00:00.000Z",
  },
  {
    id: "assistant-1",
    sessionId: "session-1",
    role: "assistant",
    content: "I will remember it.",
    createdAt: "2026-08-28T12:00:01.000Z",
  },
];

function imageToolEvidence(tool: unknown) {
  return {
    authority: "dsh_terminal_candidate",
    prompt: { productPromptVersion: "companion-product-1", preparedTurnVersion: 5, systemPromptDigest: "c".repeat(64), soulFingerprint: "d".repeat(64) },
    runtime: "embedded_dsh",
    memoryMode: "normal",
    provider: "openai",
    model: "model-1",
    profileDigest: "a".repeat(64),
    runtimeInstance: { id: "11111111-1111-4111-8111-111111111111", startedAt: "2026-09-07T00:45:00.000Z" },
    execution: { steps: 2, toolCalls: 1 },
    tools: [tool],
    contentDigest: "b".repeat(64),
    igrepVersion: "0.1.137",
    pluginVersion: "0.1.0",
    igrepObservations: {
      wake: { calls: 1, hits: 0, failures: 0, evidenceMatches: 0 },
      search: { calls: 0, hits: 0, failures: 0, evidenceMatches: 0 },
      memory: { calls: 1, hits: 1, failures: 0, evidenceMatches: 1 },
    },
    attribution: { requestId: "chatcmpl-image" },
  };
}

const imageReservation = {
  name: "generate_image_async",
  callId: "call_81eebf7c",
  attemptId: "assistant-image:1",
  effectScope: "turn_action",
  intent: { requestedNudity: "unspecified" },
  argumentsDigest: "066d9a89d376c814ed951b707d8b21f1cd3830779413c0c14a9dbb99325ed759",
};

describe("shared companion authority contracts", () => {
  it.each(["generate_image_async", "edit_last_image"])("accepts current %s reservation authority without exposing its intent", (name) => {
    const projected = projectCompanionProbeDshEvidence(imageToolEvidence({ ...imageReservation, name }), "normal");
    expect(projected).toMatchObject({ ok: true, error: null, memorySearchEvidenceMatches: 1 });
    expect(projected).not.toHaveProperty("tools");
    expect(projected).not.toHaveProperty("intent");
  });

  it.each([
    { effectScope: undefined, intent: undefined },
    { effectScope: "global" },
    { intent: { requestedNudity: "unknown" } },
    { intent: { requestedNudity: "unspecified", extraAuthority: true } },
    { argumentsDigest: "invalid" },
    { untrustedAuthority: true },
  ])("rejects incomplete or malformed reservation authority: %j", (overrides) => {
    const projected = projectCompanionProbeDshEvidence(imageToolEvidence({ ...imageReservation, ...overrides }), "normal");
    expect(projected.ok).toBe(false);
    expect(projected.error).toContain("execution.tools");
  });

  it("still rejects a tool count that disagrees with the actual reservations", () => {
    const evidence = imageToolEvidence(imageReservation);
    evidence.execution.toolCalls = 0;
    expect(projectCompanionProbeDshEvidence(evidence, "normal")).toMatchObject({ ok: false, error: expect.stringContaining("execution.tools") });
  });

  it("accepts only contiguous, complete user-assistant rebuild exchanges", () => {
    expect(companionWorkspaceRebuildSchema.safeParse({
      scope: "relationship",
      userId: "user-1",
      characterId: "character-1",
      mode: "rebuild",
      messages,
    }).success).toBe(true);
    expect(companionWorkspaceRebuildSchema.safeParse({
      scope: "relationship",
      userId: "user-1",
      characterId: "character-1",
      mode: "rebuild",
      messages: messages.slice(0, 1),
    }).success).toBe(false);
  });

  it("round-trips one strict NDJSON frame", () => {
    const frame = {
      protocolVersion: COMPANION_RUNTIME_PROTOCOL_VERSION,
      type: "complete" as const,
      messageCount: 2,
    };
    expect(decodeCompanionWorkspaceRebuildFrame(
      encodeCompanionWorkspaceRebuildFrame(frame),
    )).toEqual(frame);
    expect(() => decodeCompanionWorkspaceRebuildFrame("{}\n{}\n")).toThrow(/exactly one/);
  });

  it("detects a rebuild source count change while streaming", async () => {
    const stream = createCompanionWorkspaceRebuildStream({
      scope: "relationship",
      userId: "user-1",
      characterId: "character-1",
      mode: "project",
      messageCount: 0,
      messages: (async function* () { yield messages[0]!; })(),
    });
    await expect(new Response(stream).text()).rejects.toThrow(/source count changed/);
  });

  it("gives larger rebuilds a monotonic outer deadline", () => {
    const small = companionWorkspaceRebuildBudget({
      messageCount: 2,
      sessionCount: 1,
      estimatedBytes: 1_024,
    });
    const large = companionWorkspaceRebuildBudget({
      messageCount: 2_000,
      sessionCount: 20,
      estimatedBytes: 64 * 1_048_576,
    });
    expect(large.totalTimeoutMs).toBeGreaterThan(small.totalTimeoutMs);
  });

  it("keeps the Main deadline above initial ingest and one complete source recovery", () => {
    // Each child has its own size-aware deadline. A rejected derivation must
    // have time to re-ingest every session before the Main request expires.
    for (const sessionBytes of [[], [1_024], [1_024, 65 * 1_048_576, 2_097_153]]) {
      const ingestPass = sessionBytes.reduce((total, bytes) =>
        total + companionWorkspaceRebuildSessionIngestTimeoutMs(bytes), 0);
      const budget = companionWorkspaceRebuildBudget({
        messageCount: sessionBytes.length * 2,
        sessionCount: sessionBytes.length,
        estimatedBytes: sessionBytes.reduce((total, bytes) => total + bytes, 0),
      });
      expect(budget.totalTimeoutMs).toBeGreaterThanOrEqual(
        ingestPass * 2 + 300_000 + 30_000 + 10_000 + 30_000,
      );
    }
  });

  it("projects internal evidence into a content-free operator shape", () => {
    const projected = projectCompanionProbeDshEvidence({
      authority: "dsh_terminal_candidate",
      prompt: {
        productPromptVersion: "companion-product-1",
        preparedTurnVersion: 4,
        systemPromptDigest: "c".repeat(64),
        soulFingerprint: "d".repeat(64),
      },
      runtime: "embedded_dsh",
      memoryMode: "private",
      provider: "openai",
      model: "model-1",
      profileDigest: "a".repeat(64),
      runtimeInstance: {
        id: "11111111-1111-4111-8111-111111111111",
        startedAt: "2026-08-28T12:00:00.000Z",
      },
      execution: { steps: 1, toolCalls: 0 },
      tools: [],
      contentDigest: "b".repeat(64),
      igrepVersion: "0.1.134",
      pluginVersion: "0.1.0",
      igrepObservations: {
        wake: { calls: 0, hits: 0, failures: 0, evidenceMatches: 0 },
        search: { calls: 0, hits: 0, failures: 0, evidenceMatches: 0 },
        memory: { calls: 0, hits: 0, failures: 0, evidenceMatches: 0 },
      },
    }, "private");

    expect(projected).toMatchObject({
      ok: true,
      productPromptVersion: "companion-product-1",
      preparedTurnVersion: 4,
      systemPromptDigest: "c".repeat(64),
      soulFingerprint: "d".repeat(64),
      memoryOutcome: "disabled",
    });
    expect(projected).not.toHaveProperty("content");
    expect(projected).not.toHaveProperty("contentDigest");
  });
});
