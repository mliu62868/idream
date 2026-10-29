import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  entries: vi.fn(), attachments: vi.fn(), assets: vi.fn(), visual: vi.fn(),
  rerank: vi.fn(), embed: vi.fn(),
}));
vi.mock("@/server/lib/db", () => ({ prisma: {
  characterMediaLibraryEntry: { findMany: dependencies.entries },
  chatTurnAttachment: { findMany: dependencies.attachments },
  mediaAsset: { findMany: dependencies.assets },
  characterVisualProfile: { findUnique: dependencies.visual },
} }));
vi.mock("@/server/lib/media-asset-authority", () => ({
  isMediaAssetOperationalForAuthority: () => true,
  resolveMediaAssetBlobLocator: (asset: { storageKey: string }) => ({ key: asset.storageKey }),
}));
vi.mock("@/server/lib/media-asset-authority-query", () => ({
  assertMediaAssetCustomerPublishable: vi.fn(),
  resolveMediaAssetAuthorityMap: async (_db: unknown, assets: Array<{ id: string }>) => new Map(assets.map(asset => [asset.id, { publishable: true }])),
}));
vi.mock("@/server/modules/admin-v2/characters/release-snapshot", () => ({ characterVisualProfileSnapshotHash: () => "visual-hash" }));
vi.mock("./media-models", () => ({
  mediaLibraryModels: () => ({ embedding: { url: "https://embedding.example/v1", model: "fixture", dimensions: 2, apiKey: "" }, rerank: { url: "https://rerank.example/v1", model: "fixture-rerank", apiKey: "" } }),
  embedMediaText: dependencies.embed,
  rerankMediaText: dependencies.rerank,
}));
import { libraryDescriptorHash, searchCharacterMediaLibrary } from "./service";

function entry(index: number) {
  const descriptor = { kind: "image", description: `A seaside photo ${index}`, facts: ["seaside"], absentFacts: ["hat"],
    nudity: "none", durationSeconds: null, hasAudio: null };
  return { id: `entry-${index}`, ...descriptor, status: "published", characterId: "character", visualProfileId: "visual",
    visualProfileVersion: 1, sourceAssetId: `source-${index}`, contentHash: `hash-${index}`,
    embeddingModel: "fixture", embeddingDimensions: 2, embedding: [1, 0], embeddingHash: libraryDescriptorHash(descriptor),
    sourceSnapshot: { sourceStorageKey: `key-${index}`, visualProfileHash: "visual-hash" },
    sourceAsset: { id: `source-${index}`, storageKey: `key-${index}`, metadata: {} },
  };
}

describe("Character media candidate ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.entries.mockResolvedValue(Array.from({ length: 8 }, (_, index) => entry(index)));
    dependencies.attachments.mockResolvedValue([]);
    dependencies.assets.mockResolvedValue([]);
    dependencies.visual.mockResolvedValue({ id: "visual", characterId: "character", version: 1, immutableHash: "visual-hash" });
    dependencies.embed.mockResolvedValue({ model: "fixture", dimensions: 2, vector: [1, 0] });
  });

  it("takes the highest reranker scores even when the model returns document-index order", async () => {
    dependencies.rerank.mockResolvedValue(Array.from({ length: 8 }, (_, index) => ({ index, score: index / 10 })));
    const matches = await searchCharacterMediaLibrary({ userId: "viewer", characterId: "character", visualProfileId: "visual",
      visualProfileVersion: 1, kind: "image", query: "A seaside photo without a hat" });
    expect(matches.map(match => match.entry.id)).toEqual(["entry-7", "entry-6", "entry-5", "entry-4", "entry-3", "entry-2"]);
    expect(matches.map(match => match.score)).toEqual([0.7, 0.6, 0.5, 0.4, 0.3, 0.2]);
  });

  it("propagates reranker failure instead of presenting it as an empty or successful lookup", async () => {
    const failure = new Error("rerank timed out");
    dependencies.rerank.mockRejectedValue(failure);
    await expect(searchCharacterMediaLibrary({ userId: "viewer", characterId: "character", visualProfileId: "visual",
      visualProfileVersion: 1, kind: "image", query: "A seaside photo" })).rejects.toBe(failure);
  });

  it("keeps a late semantic match when a large catalog has identical keyword overlap", async () => {
    const catalog = Array.from({ length: 1_025 }, (_, index) => ({ ...entry(index), embedding: [0, 1] }));
    catalog[1_024]!.embedding = [1, 0];
    dependencies.entries.mockResolvedValue(catalog);
    dependencies.rerank.mockResolvedValue(null);
    const matches = await searchCharacterMediaLibrary({ userId: "viewer", characterId: "character", visualProfileId: "visual",
      visualProfileVersion: 1, kind: "image", query: "seaside" });
    expect(matches[0]?.entry.id).toBe("entry-1024");
    expect(matches[0]?.score).toBe(1);
    expect(dependencies.rerank.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([expect.stringContaining("A seaside photo 1024")]));
  });
});
