import { describe, expect, it } from "vitest";
import {
  COMPANION_RUNTIME_PROTOCOL_VERSION,
  companionWorkspaceRebuildBudget,
  companionWorkspaceRebuildSchema,
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

describe("shared companion authority contracts", () => {
  it("accepts only contiguous, complete user-assistant rebuild exchanges", () => {
    expect(companionWorkspaceRebuildSchema.safeParse({
      scope: "relationship",
      userId: "user-1",
      characterId: "character-1",
      messages,
    }).success).toBe(true);
    expect(companionWorkspaceRebuildSchema.safeParse({
      scope: "relationship",
      userId: "user-1",
      characterId: "character-1",
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

  it("projects internal evidence into a content-free operator shape", () => {
    const projected = projectCompanionProbeDshEvidence({
      authority: "dsh_terminal_candidate",
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

    expect(projected).toMatchObject({ ok: true, memoryOutcome: "disabled" });
    expect(projected).not.toHaveProperty("content");
    expect(projected).not.toHaveProperty("contentDigest");
  });
});
