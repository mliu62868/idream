import { describe, expect, it } from "vitest";
import type { CompanionWorkspaceRebuildMessage } from "@idream/shared/chat/companion-runtime";
import {
  buildLegacyMemoryImportPlan,
  legacyMemoryImportCliEvidence,
  parseLegacyRecallProbeFile,
} from "./legacy-memory-import.js";
import {
  isLegacyMemoryImportHelp,
  LEGACY_MEMORY_IMPORT_USAGE,
  parseLegacyMemoryImportArgs,
} from "./memory-cli.js";
import type { MemoryItem } from "./memories.js";

const canonical: CompanionWorkspaceRebuildMessage[] = [{
  id: "source-1",
  sessionId: "session-1",
  role: "user",
  content: "source",
  createdAt: "2026-08-19T12:00:00.000Z",
}];

function memory(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: "memory-1",
    characterId: "character-1",
    type: "preference",
    text: "private jasmine text",
    sourceMessageIds: ["source-1"],
    confidence: 0.8,
    ...overrides,
  };
}

describe("legacy memory import proof inputs", () => {
  it("offers a zero-work help path and keeps unknown arguments strict", () => {
    expect(isLegacyMemoryImportHelp(["--help"])).toBe(true);
    expect(isLegacyMemoryImportHelp(["-h"])).toBe(true);
    expect(LEGACY_MEMORY_IMPORT_USAGE).toContain("--probe-file <path>");
    expect(() => parseLegacyMemoryImportArgs(["--wat"])).toThrow("unknown argument: --wat");
  });

  it("requires parity for imported rows and permits the explicit empty proof set", () => {
    expect(parseLegacyRecallProbeFile('{"version":1,"probes":[]}')).toEqual([]);
    expect(() => buildLegacyMemoryImportPlan({
      userId: "user-1",
      characterId: "character-1",
      memories: [memory()],
      canonicalMessages: canonical,
      recallProbes: [],
    })).toThrow(/recall probe/i);

    const empty = buildLegacyMemoryImportPlan({
      userId: "user-1",
      characterId: "character-1",
      memories: [],
      canonicalMessages: canonical,
      recallProbes: [],
    });
    expect(empty).toMatchObject({ total: 0, request: { entries: [], recallProbes: [] } });
  });

  it("binds excluded legacy rows into a redacted source checksum", () => {
    const build = (text: string) => buildLegacyMemoryImportPlan({
      userId: "private-user",
      characterId: "character-1",
      memories: [memory({ text, type: "boundary" })],
      canonicalMessages: canonical,
      recallProbes: [],
    });
    const first = build("private boundary one");
    const second = build("private boundary two");
    expect(first.request.entries).toEqual([]);
    expect(first.legacySourceChecksum).not.toBe(second.legacySourceChecksum);
    const serialized = JSON.stringify(legacyMemoryImportCliEvidence({
      ...first,
      mode: "dry-run",
    }));
    expect(serialized).not.toContain("private-user");
    expect(serialized).not.toContain("private boundary one");
    expect(serialized).toContain(first.legacySourceChecksum);
  });
});
