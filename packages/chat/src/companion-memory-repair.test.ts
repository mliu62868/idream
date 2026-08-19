import { describe, expect, it } from "vitest";
import {
  groupCompanionMemoryRepairs,
  needsCompanionMemoryRepair,
  repairedCompanionMemoryTrace,
} from "./companion-memory-repair.js";

function trace(outcome: string, privateMode = false) {
  return {
    schemaVersion: 1,
    companionRuntime: {
      runtime: "dsh",
      memoryBackend: "igrep-dsh",
      profile: "normal",
      private: privateMode,
    },
    companion: {
      invocationId: "invocation-1",
      memoryIngestOutcome: outcome,
    },
    primaryTelemetry: {
      schemaVersion: 1,
      runtime: "dsh",
      startedAt: "2026-08-19T12:00:00.000Z",
      totalMs: 1_000,
      retryCount: 0,
      memory: { outcome },
    },
  };
}

describe("durable companion memory repair", () => {
  it("recognizes only normal DSH pending/failed projections", () => {
    expect(needsCompanionMemoryRepair(trace("pending"))).toBe(true);
    expect(needsCompanionMemoryRepair(trace("failed"))).toBe(true);
    expect(needsCompanionMemoryRepair(trace("ingested"))).toBe(false);
    expect(needsCompanionMemoryRepair(trace("failed", true))).toBe(false);
    expect(needsCompanionMemoryRepair({})).toBe(false);
  });

  it("settles the trace without dropping provider, usage or attribution evidence", () => {
    const value = {
      ...trace("failed"),
      dsh: { model: "deepseek/test" },
      companion: {
        ...trace("failed").companion,
        usage: { promptTokens: 10, completionTokens: 4 },
        attribution: { requestId: "request-1", actualProvider: "Together" },
      },
    };
    expect(repairedCompanionMemoryTrace(
      value,
      "2026-08-19T12:10:00.000Z",
    )).toEqual(expect.objectContaining({
      dsh: { model: "deepseek/test" },
      primaryTelemetry: expect.objectContaining({
        memory: {
          outcome: "ingested_rebuilt",
          settleLagMs: 599_000,
        },
      }),
      companion: expect.objectContaining({
        memoryIngestOutcome: "ingested_rebuilt",
        usage: { promptTokens: 10, completionTokens: 4 },
        attribution: { requestId: "request-1", actualProvider: "Together" },
        memoryRepair: {
          kind: "canonical_rebuild",
          repairedAt: "2026-08-19T12:10:00.000Z",
        },
      }),
    }));
  });

  it("coalesces many failed attempts into one relationship rebuild", () => {
    expect(groupCompanionMemoryRepairs([
      { id: "a-1", attempt: 1, sessionId: "s-1", userId: "u-1", characterId: "c-1" },
      { id: "a-2", attempt: 2, sessionId: "s-2", userId: "u-1", characterId: "c-1" },
      { id: "a-3", attempt: 1, sessionId: "s-3", userId: "u-1", characterId: "c-2" },
    ])).toEqual([
      {
        userId: "u-1",
        characterId: "c-1",
        sessionId: "s-1",
        messageIds: ["a-1", "a-2"],
      },
      {
        userId: "u-1",
        characterId: "c-2",
        sessionId: "s-3",
        messageIds: ["a-3"],
      },
    ]);
  });
});
