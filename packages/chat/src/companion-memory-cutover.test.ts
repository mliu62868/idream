import { describe, expect, it } from "vitest";
import {
  resolveCompanionMemoryCutover,
  type CompanionMemoryCutoverProof,
  type CompanionMemoryCutoverSidecarProof,
} from "./companion-memory-cutover.js";

const sourceChecksum = "1".repeat(64);
const importChecksum = "2".repeat(64);
const cutoverWorkspaceVersion = "rebuild-1787169600000-11111111-1111-4111-8111-111111111111";

function chatProof(overrides: Partial<CompanionMemoryCutoverProof> = {}): CompanionMemoryCutoverProof {
  return {
    schemaVersion: 1,
    status: "cutover_ready",
    mode: "imported",
    legacySourceChecksum: sourceChecksum,
    importChecksum,
    igrepVersion: "0.1.132",
    cutoverWorkspaceVersion,
    workspaceVersion: "commit-1787169700000-22222222-2222-4222-8222-222222222222",
    recallParity: {
      probeSetChecksum: "3".repeat(64),
      total: 1,
      passed: 1,
    },
    completedAt: "2026-08-19T12:00:00.000Z",
    ...overrides,
  };
}

function sidecarProof(
  overrides: Partial<CompanionMemoryCutoverSidecarProof> = {},
): CompanionMemoryCutoverSidecarProof {
  return {
    entries: 1,
    legacySourceChecksum: sourceChecksum,
    checksum: importChecksum,
    igrepVersion: "0.1.132",
    cutoverWorkspaceVersion,
    workspaceVersion: "commit-1787169800000-33333333-3333-4333-8333-333333333333",
    status: "cutover_ready",
    recallParity: {
      probeSetChecksum: "3".repeat(64),
      total: 1,
      passed: 1,
      probes: [{
        probeId: "known-fact",
        queryHash: "4".repeat(64),
        legacyExpectedHash: "5".repeat(64),
        recallContextHash: "6".repeat(64),
        hitCount: 1,
      }],
    },
    completedAt: "2026-08-19T12:00:00.000Z",
    ...overrides,
  };
}

describe("companion memory cutover admission", () => {
  it("pins the current certified workspace only when source checksum and parity still match", () => {
    expect(resolveCompanionMemoryCutover({
      snapshot: {
        total: 1,
        eligibleEntries: 1,
        legacySourceChecksum: sourceChecksum,
        importChecksum,
      },
      chatProof: chatProof(),
      sidecarProof: sidecarProof(),
    })).toEqual({
      action: "admit",
      proof: chatProof({
        workspaceVersion: "commit-1787169800000-33333333-3333-4333-8333-333333333333",
      }),
    });

    expect(() => resolveCompanionMemoryCutover({
      snapshot: {
        total: 1,
        eligibleEntries: 1,
        legacySourceChecksum: "9".repeat(64),
        importChecksum,
      },
      chatProof: chatProof(),
      sidecarProof: sidecarProof(),
    })).toThrow(/legacy source checksum/i);
  });

  it("requires an audited import when any legacy candidate exists", () => {
    expect(() => resolveCompanionMemoryCutover({
      snapshot: {
        total: 1,
        eligibleEntries: 1,
        legacySourceChecksum: sourceChecksum,
        importChecksum,
      },
      chatProof: null,
      sidecarProof: null,
    })).toThrow(/legacy memory import/i);
  });

  it("recovers from a promoted sidecar import when the outer PG proof write did not commit", () => {
    expect(resolveCompanionMemoryCutover({
      snapshot: {
        total: 1,
        eligibleEntries: 1,
        legacySourceChecksum: sourceChecksum,
        importChecksum,
      },
      chatProof: null,
      sidecarProof: sidecarProof(),
    })).toMatchObject({
      action: "admit",
      proof: {
        mode: "imported",
        legacySourceChecksum: sourceChecksum,
        importChecksum,
        cutoverWorkspaceVersion,
      },
    });
  });

  it("bootstraps only a relationship proven to have zero legacy rows", () => {
    expect(resolveCompanionMemoryCutover({
      snapshot: {
        total: 0,
        eligibleEntries: 0,
        legacySourceChecksum: sourceChecksum,
        importChecksum,
      },
      chatProof: null,
      sidecarProof: null,
    })).toEqual({ action: "bootstrap_empty" });

    expect(() => resolveCompanionMemoryCutover({
      snapshot: {
        total: 1,
        eligibleEntries: 0,
        legacySourceChecksum: sourceChecksum,
        importChecksum,
      },
      chatProof: null,
      sidecarProof: null,
    })).toThrow(/operator-reviewed empty import/i);
  });

  it("reuses an audited empty sidecar marker before its PG attempt is selected", () => {
    expect(resolveCompanionMemoryCutover({
      snapshot: {
        total: 0,
        eligibleEntries: 0,
        legacySourceChecksum: sourceChecksum,
        importChecksum,
      },
      chatProof: null,
      sidecarProof: sidecarProof({
        entries: 0,
        recallParity: {
          probeSetChecksum: "7".repeat(64),
          total: 0,
          passed: 0,
          probes: [],
        },
      }),
    })).toMatchObject({
      action: "admit",
      proof: {
        mode: "empty",
        legacySourceChecksum: sourceChecksum,
        importChecksum,
      },
    });
  });

  it("accepts excluded legacy rows only after an explicit empty import proof", () => {
    expect(resolveCompanionMemoryCutover({
      snapshot: {
        total: 1,
        eligibleEntries: 0,
        legacySourceChecksum: sourceChecksum,
        importChecksum,
      },
      chatProof: chatProof({
        mode: "empty",
        recallParity: {
          probeSetChecksum: "7".repeat(64),
          total: 0,
          passed: 0,
        },
      }),
      sidecarProof: sidecarProof({
        entries: 0,
        recallParity: {
          probeSetChecksum: "7".repeat(64),
          total: 0,
          passed: 0,
          probes: [],
        },
      }),
    })).toMatchObject({ action: "admit", proof: { mode: "empty" } });
  });
});
