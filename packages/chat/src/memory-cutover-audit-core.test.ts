import { describe, expect, it } from "vitest";
import {
  evaluateMemoryCutoverAuditCandidate,
  memoryCutoverAuditExitCode,
  memoryCutoverAuditReport,
} from "./memory-cutover-audit-core.js";

const chatProof = {
  schemaVersion: 1,
  status: "cutover_ready",
  mode: "empty",
  legacySourceChecksum: "a".repeat(64),
  importChecksum: "b".repeat(64),
  igrepVersion: "0.1.132",
  cutoverWorkspaceVersion: "rebuild-1787169600000-11111111-1111-4111-8111-111111111111",
  workspaceVersion: "rebuild-1787169600000-11111111-1111-4111-8111-111111111111",
  recallParity: { probeSetChecksum: "c".repeat(64), total: 0, passed: 0 },
  completedAt: "2026-08-19T12:00:00.000Z",
};
const sidecarProof = {
  entries: 0,
  legacySourceChecksum: chatProof.legacySourceChecksum,
  checksum: chatProof.importChecksum,
  igrepVersion: chatProof.igrepVersion,
  cutoverWorkspaceVersion: chatProof.cutoverWorkspaceVersion,
  workspaceVersion: "commit-1787169700000-22222222-2222-4222-8222-222222222222",
  status: "cutover_ready",
  recallParity: { ...chatProof.recallParity, probes: [] },
  completedAt: chatProof.completedAt,
};

describe("memory cutover historical audit", () => {
  it("reports matching content-free proof and hashes relationship identity", () => {
    const row = evaluateMemoryCutoverAuditCandidate({
      userId: "private-user",
      characterId: "private-character",
      chatProof,
      sidecarProof,
    });
    expect(row).toMatchObject({
      status: "ready",
      mode: "empty",
      entries: 0,
      currentWorkspaceVersion: sidecarProof.workspaceVersion,
    });
    expect(row.relationshipKeyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(row)).not.toContain("private-user");
    expect(memoryCutoverAuditExitCode([row])).toBe(0);
    expect(memoryCutoverAuditReport([row]).summary).toEqual({
      relationships: 1,
      ready: 1,
      blocked: 0,
    });
  });

  it("fails audit without mutating or manufacturing a missing sidecar marker", () => {
    const row = evaluateMemoryCutoverAuditCandidate({
      userId: "user-1",
      characterId: "character-1",
      chatProof,
      sidecarProof: null,
    });
    expect(row.status).toBe("missing_sidecar_proof");
    expect(memoryCutoverAuditExitCode([row])).toBe(1);
  });
});
