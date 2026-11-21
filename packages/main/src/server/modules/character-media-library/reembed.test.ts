import { describe, expect, it } from "vitest";
import { needsLibraryEntryReembed, type ReembedCandidate } from "./reembed";
import { libraryDescriptorHash } from "./service";

function makeEntry(overrides: Partial<ReembedCandidate> = {}): ReembedCandidate {
  const base: ReembedCandidate = {
    id: "cml_1",
    kind: "image",
    description: "Smiling in a red dress by the rainy window.",
    facts: ["red dress", "rainy window"],
    absentFacts: ["glasses", "hat"],
    nudity: "none",
    durationSeconds: null,
    hasAudio: null,
    embeddingModel: "bge-m3",
    embeddingDimensions: 1024,
    embeddingHash: null,
    ...overrides,
  };
  return {
    ...base,
    embeddingHash: overrides.embeddingHash !== undefined ? overrides.embeddingHash : libraryDescriptorHash(base),
  };
}

describe("needsLibraryEntryReembed", () => {
  const config = { model: "bge-m3", dimensions: 1024 };

  it("skips entries whose descriptor hash, model, and dimensions are current", () => {
    expect(needsLibraryEntryReembed(makeEntry(), config)).toBe(false);
  });

  it("detects stale hash when legacy embeddings included absentFacts", () => {
    const stale = makeEntry({ embeddingHash: "legacy-hash-with-absent-facts" });
    expect(needsLibraryEntryReembed(stale, config)).toBe(true);
  });

  it("detects model or dimension upgrades", () => {
    expect(needsLibraryEntryReembed(makeEntry({ embeddingModel: "old-model" }), config)).toBe(true);
    expect(needsLibraryEntryReembed(makeEntry({ embeddingDimensions: 512 }), config)).toBe(true);
  });

  it("re-embeds unconditionally when force=true", () => {
    expect(needsLibraryEntryReembed(makeEntry(), config, true)).toBe(true);
  });
});
