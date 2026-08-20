import { describe, expect, it } from "vitest";
import {
  evaluateMemoryCutoverAuditCandidate,
  memoryCutoverAuditExitCode,
  memoryCutoverAuditReport,
} from "./memory-cutover-audit-core.js";

const digest = (character: string) => character.repeat(64);
const workspace = "rebuild-1787169600000-11111111-1111-4111-8111-111111111111";

function readyCandidate() {
  const snapshot = {
    total: 1,
    eligibleEntries: 1,
    legacySourceChecksum: digest("a"),
    importChecksum: digest("b"),
  };
  return {
    userId: "private-user",
    characterId: "private-character",
    snapshot,
    excluded: { boundary: 0 },
    snapshotStable: true,
    chatProof: {
      schemaVersion: 1,
      status: "cutover_ready",
      mode: "imported",
      legacySourceChecksum: snapshot.legacySourceChecksum,
      importChecksum: snapshot.importChecksum,
      igrepVersion: "0.1.132",
      cutoverWorkspaceVersion: workspace,
      workspaceVersion: workspace,
      recallParity: { probeSetChecksum: digest("c"), total: 1, passed: 1 },
      completedAt: "2026-08-19T12:00:00.000Z",
    },
    sidecarProof: {
      entries: 1,
      legacySourceChecksum: snapshot.legacySourceChecksum,
      checksum: snapshot.importChecksum,
      igrepVersion: "0.1.132",
      cutoverWorkspaceVersion: workspace,
      workspaceVersion: workspace,
      status: "cutover_ready",
      recallParity: {
        probeSetChecksum: digest("c"),
        total: 1,
        passed: 1,
        probes: [{
          probeId: "probe-1",
          queryHash: digest("d"),
          legacyExpectedHash: digest("e"),
          recallContextHash: digest("f"),
          hitCount: 1,
        }],
      },
      completedAt: "2026-08-19T12:00:00.000Z",
    },
  };
}

describe("memory cutover batch audit", () => {
  it("reports only redacted authority evidence and exits zero only at 100% ready", () => {
    const ready = evaluateMemoryCutoverAuditCandidate(readyCandidate());
    const blocked = evaluateMemoryCutoverAuditCandidate({
      ...readyCandidate(),
      userId: "another-private-user",
      snapshot: {
        total: 0,
        eligibleEntries: 0,
        legacySourceChecksum: digest("1"),
        importChecksum: digest("2"),
      },
      chatProof: null,
      sidecarProof: null,
    });
    const report = memoryCutoverAuditReport([ready, blocked]);

    expect(ready.status).toBe("ready");
    expect(blocked.status).toBe("empty_unproven");
    expect(report.summary).toEqual({ relationships: 2, ready: 1, blocked: 1 });
    expect(memoryCutoverAuditExitCode([ready])).toBe(0);
    expect(memoryCutoverAuditExitCode([ready, blocked])).toBe(1);
    expect(JSON.stringify(report)).not.toContain("private-user");
    expect(JSON.stringify(report)).not.toContain("private-character");
  });

  it("fails closed when the source races or the sidecar proof is unavailable", () => {
    expect(evaluateMemoryCutoverAuditCandidate({
      ...readyCandidate(),
      snapshotStable: false,
    }).status).toBe("snapshot_raced");
    expect(evaluateMemoryCutoverAuditCandidate({
      ...readyCandidate(),
      probeError: "HTTP 503",
    }).status).toBe("sidecar_unavailable");
  });
});
