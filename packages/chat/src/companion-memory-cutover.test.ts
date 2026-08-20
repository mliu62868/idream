import { describe, expect, it } from "vitest";
import { validateHistoricalMemoryCutoverEvidence } from "./companion-memory-cutover.js";

const chatProof = {
  schemaVersion: 1 as const,
  status: "cutover_ready" as const,
  mode: "imported" as const,
  legacySourceChecksum: "a".repeat(64),
  importChecksum: "b".repeat(64),
  igrepVersion: "0.1.132" as const,
  cutoverWorkspaceVersion: "rebuild-1787169600000-11111111-1111-4111-8111-111111111111",
  workspaceVersion: "rebuild-1787169600000-11111111-1111-4111-8111-111111111111",
  recallParity: { probeSetChecksum: "c".repeat(64), total: 1, passed: 1 },
  completedAt: "2026-08-19T12:00:00.000Z",
};

const sidecarProof = {
  entries: 1,
  legacySourceChecksum: chatProof.legacySourceChecksum,
  checksum: chatProof.importChecksum,
  igrepVersion: chatProof.igrepVersion,
  cutoverWorkspaceVersion: chatProof.cutoverWorkspaceVersion,
  workspaceVersion: "commit-1787169700000-22222222-2222-4222-8222-222222222222",
  status: "cutover_ready" as const,
  recallParity: {
    ...chatProof.recallParity,
    probes: [{
      probeId: "migration-proof",
      queryHash: "d".repeat(64),
      legacyExpectedHash: "e".repeat(64),
      recallContextHash: "f".repeat(64),
      hitCount: 1,
    }],
  },
  completedAt: chatProof.completedAt,
};

describe("historical memory cutover evidence", () => {
  it("accepts a migrated lineage after normal commit descendants", () => {
    expect(validateHistoricalMemoryCutoverEvidence({ chatProof, sidecarProof }))
      .toEqual({ chatProof, sidecarProof });
  });

  it("rejects marker or recall-parity drift", () => {
    expect(() => validateHistoricalMemoryCutoverEvidence({
      chatProof,
      sidecarProof: { ...sidecarProof, checksum: "9".repeat(64) },
    })).toThrow("lineage");
    expect(() => validateHistoricalMemoryCutoverEvidence({
      chatProof,
      sidecarProof: {
        ...sidecarProof,
        recallParity: { ...sidecarProof.recallParity, probeSetChecksum: "9".repeat(64) },
      },
    })).toThrow("recall parity");
  });
});
