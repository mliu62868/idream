import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureCompanionMemoryCutoverTx } from "./companion-memory-cutover-runtime.js";

const sourceChecksum = "1".repeat(64);
const importChecksum = "2".repeat(64);
const emptyParityChecksum = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";

const state = vi.hoisted(() => ({
  snapshot: {
    total: 0,
    entries: [] as unknown[],
    legacySourceChecksum: "1".repeat(64),
    importChecksum: "2".repeat(64),
  },
}));
const runtime = vi.hoisted(() => ({
  readProof: vi.fn(),
  importLegacy: vi.fn(),
}));

vi.mock("./chat-fs.js", () => ({
  chatFsPaths: { memory: (userId: string, characterId: string) => [userId, characterId] },
  readWhole: vi.fn(async () => ""),
  withFileMutationLock: vi.fn(),
}));
vi.mock("./companion-memory-projection.js", () => ({
  buildCompanionWorkspaceRebuild: vi.fn(async () => ({ messages: [] })),
}));
vi.mock("./legacy-memory-import.js", () => ({
  parseLegacyMemoryFile: vi.fn(() => []),
  buildLegacyMemoryCandidateSnapshot: vi.fn(() => state.snapshot),
}));
vi.mock("./companion-runtime.js", () => ({
  readCompanionMemoryCutoverProof: runtime.readProof,
  importLegacyCompanionMemory: runtime.importLegacy,
}));

describe("normal DSH memory cutover transaction", () => {
  beforeEach(() => {
    state.snapshot = {
      total: 0,
      entries: [],
      legacySourceChecksum: sourceChecksum,
      importChecksum,
    };
    runtime.readProof.mockReset().mockResolvedValue(null);
    runtime.importLegacy.mockReset().mockResolvedValue({
      skipped: false,
      written: 0,
      entries: 0,
      legacySourceChecksum: sourceChecksum,
      checksum: importChecksum,
      igrepVersion: "0.1.132",
      cutoverWorkspaceVersion: "rebuild-1787169600000-11111111-1111-4111-8111-111111111111",
      workspaceVersion: "rebuild-1787169600000-11111111-1111-4111-8111-111111111111",
      status: "cutover_ready",
      recallParity: {
        probeSetChecksum: emptyParityChecksum,
        total: 0,
        passed: 0,
        probes: [],
      },
      completedAt: "2026-08-19T12:00:00.000Z",
    });
  });

  it("queries canonical proof, imports audited empty authority, and assembles the pinned proof", async () => {
    const tx = { $queryRaw: vi.fn(async () => []) };

    await expect(ensureCompanionMemoryCutoverTx({
      tx: tx as never,
      userId: "user-1",
      characterId: "character-1",
      sidecar: { baseUrl: "http://127.0.0.1:3101", token: "secret", timeoutMs: 10_000 },
    })).resolves.toEqual({
      schemaVersion: 1,
      status: "cutover_ready",
      mode: "empty",
      legacySourceChecksum: sourceChecksum,
      importChecksum,
      igrepVersion: "0.1.132",
      cutoverWorkspaceVersion: "rebuild-1787169600000-11111111-1111-4111-8111-111111111111",
      workspaceVersion: "rebuild-1787169600000-11111111-1111-4111-8111-111111111111",
      recallParity: { probeSetChecksum: emptyParityChecksum, total: 0, passed: 0 },
      completedAt: "2026-08-19T12:00:00.000Z",
    });

    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(runtime.readProof).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      characterId: "character-1",
    }));
    expect(runtime.importLegacy).toHaveBeenCalledWith(expect.objectContaining({
      request: {
        scope: "relationship",
        userId: "user-1",
        characterId: "character-1",
        legacySourceChecksum: sourceChecksum,
        checksum: importChecksum,
        entries: [],
        recallProbes: [],
      },
    }));
  });

  it("fails closed instead of manufacturing an empty proof for existing legacy rows", async () => {
    state.snapshot = {
      total: 1,
      entries: [{ legacyMemoryId: "legacy-1" }],
      legacySourceChecksum: sourceChecksum,
      importChecksum,
    };
    const tx = { $queryRaw: vi.fn(async () => []) };

    await expect(ensureCompanionMemoryCutoverTx({
      tx: tx as never,
      userId: "user-1",
      characterId: "character-1",
      sidecar: { baseUrl: "http://127.0.0.1:3101", token: "secret", timeoutMs: 10_000 },
    })).rejects.toThrow("legacy memory import is required before DSH cutover");
    expect(runtime.importLegacy).not.toHaveBeenCalled();
  });

  it("rejects an empty import response that is not bound to the current legacy bytes", async () => {
    runtime.importLegacy.mockResolvedValue({
      skipped: false,
      written: 0,
      entries: 0,
      legacySourceChecksum: "9".repeat(64),
      checksum: importChecksum,
      igrepVersion: "0.1.132",
      cutoverWorkspaceVersion: "rebuild-1787169600000-11111111-1111-4111-8111-111111111111",
      workspaceVersion: "rebuild-1787169600000-11111111-1111-4111-8111-111111111111",
      status: "cutover_ready",
      recallParity: {
        probeSetChecksum: emptyParityChecksum,
        total: 0,
        passed: 0,
        probes: [],
      },
      completedAt: "2026-08-19T12:00:00.000Z",
    });
    const tx = { $queryRaw: vi.fn(async () => []) };

    await expect(ensureCompanionMemoryCutoverTx({
      tx: tx as never,
      userId: "user-1",
      characterId: "character-1",
      sidecar: { baseUrl: "http://127.0.0.1:3101", token: "secret", timeoutMs: 10_000 },
    })).rejects.toThrow(/did not produce a cutover proof|checksum/i);
  });
});
