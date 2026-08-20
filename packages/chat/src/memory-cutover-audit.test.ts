import { describe, expect, it, vi } from "vitest";
import { auditLegacyMemoryCutover } from "./memory-cutover-audit.js";
import {
  MEMORY_CUTOVER_AUDIT_USAGE,
  parseMemoryCutoverAuditArgs,
} from "./memory-cli.js";

describe("memory cutover operator audit", () => {
  it("has composable usage and rejects unexpected mutation flags", () => {
    expect(parseMemoryCutoverAuditArgs([])).toEqual({ help: false });
    expect(parseMemoryCutoverAuditArgs(["--help"])).toEqual({ help: true });
    expect(parseMemoryCutoverAuditArgs(["-h"])).toEqual({ help: true });
    expect(MEMORY_CUTOVER_AUDIT_USAGE).toContain("memory:cutover-audit");
    expect(() => parseMemoryCutoverAuditArgs(["--apply"])).toThrow(
      "unknown argument: --apply",
    );
  });

  it("enumerates legacy relationships read-only and never exposes their identity", async () => {
    const tx = {
      chatSession: { findMany: vi.fn(async () => []) },
      $queryRaw: vi.fn(async () => []),
    };
    const prisma = {
      $transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)),
    };
    const readFile = vi.fn(async () => "");
    const rows = await auditLegacyMemoryCutover({
      prisma: prisma as never,
      listFiles: async () => [
        "mem/private-user/private-character/memory.md",
        "mem/private-user/global/boundaries.md",
      ],
      readFile,
      env: {
        DSH_AGENT_TOKEN: "test-sidecar-token",
        DSH_AGENT_URL: "http://127.0.0.1:3101",
      },
      fetchImpl: async () => Response.json({ ok: true, proof: null }),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      total: 0,
      eligibleEntries: 0,
      status: "empty_unproven",
    });
    expect(rows[0]?.relationshipKeyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(rows)).not.toContain("private-user");
    expect(JSON.stringify(rows)).not.toContain("private-character");
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(tx.chatSession.findMany).toHaveBeenCalledOnce();
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(readFile).toHaveBeenCalledTimes(2);
  });
});
