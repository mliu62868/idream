import { describe, expect, it, vi } from "vitest";
import { auditHistoricalMemoryCutover } from "./memory-cutover-audit.js";
import {
  MEMORY_CUTOVER_AUDIT_USAGE,
  parseMemoryCutoverAuditArgs,
} from "./memory-cli.js";

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

describe("memory cutover operator audit", () => {
  it("has a read-only CLI and rejects mutation flags", () => {
    expect(parseMemoryCutoverAuditArgs([])).toEqual({ help: false });
    expect(parseMemoryCutoverAuditArgs(["--help"])).toEqual({ help: true });
    expect(MEMORY_CUTOVER_AUDIT_USAGE).toContain("memory:cutover-audit");
    expect(() => parseMemoryCutoverAuditArgs(["--apply"])).toThrow(
      "unknown argument: --apply",
    );
  });

  it("enumerates persisted historical proofs without reading legacy files", async () => {
    const prisma = {
      $queryRaw: vi.fn(async () => [{
        userId: "private-user",
        characterId: "private-character",
        chatProof,
      }]),
    };
    const rows = await auditHistoricalMemoryCutover({
      prisma: prisma as never,
      env: {
        DSH_AGENT_TOKEN: "test-sidecar-token",
        DSH_AGENT_URL: "http://127.0.0.1:3101",
      },
      fetchImpl: async () => Response.json({
        ok: true,
        proof: {
          entries: 0,
          legacySourceChecksum: chatProof.legacySourceChecksum,
          checksum: chatProof.importChecksum,
          igrepVersion: chatProof.igrepVersion,
          cutoverWorkspaceVersion: chatProof.cutoverWorkspaceVersion,
          workspaceVersion: "commit-1787169700000-22222222-2222-4222-8222-222222222222",
          status: "cutover_ready",
          recallParity: { ...chatProof.recallParity, probes: [] },
          completedAt: chatProof.completedAt,
        },
      }),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "ready", mode: "empty", entries: 0 });
    expect(rows[0]?.relationshipKeyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(rows)).not.toContain("private-user");
    expect(JSON.stringify(rows)).not.toContain("private-character");
    expect(prisma.$queryRaw).toHaveBeenCalledOnce();
  });
});
