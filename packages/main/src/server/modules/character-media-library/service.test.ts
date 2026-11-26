import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  entries: vi.fn(), exists: vi.fn(), deliveries: vi.fn(), visual: vi.fn(),
  rerank: vi.fn(), embed: vi.fn(),
}));
vi.mock("@/server/lib/db", () => ({ prisma: {
  characterMediaLibraryEntry: { findMany: dependencies.entries, findFirst: dependencies.exists },
  $queryRaw: dependencies.deliveries,
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
import { availableCharacterMediaLibraryKinds, bm25Scores, hasEligibleCharacterMediaLibraryEntries, lexicalTerms, libraryDescriptorHash, libraryDescriptorText, searchCharacterMediaLibrary } from "./service";

const identity = { characterId: "character", visualProfileId: "visual", visualProfileVersion: 1 };

function entry(index: number, observation?: { description: string; facts: string[] }) {
  const descriptor = { kind: "image", description: `A seaside photo ${index}`, facts: ["seaside"], absentFacts: ["hat"],
    nudity: "none", durationSeconds: null, hasAudio: null, ...observation };
  return { id: `entry-${index}`, ...descriptor, status: "published", characterId: "character", visualProfileId: "visual",
    visualProfileVersion: 1, sourceAssetId: `source-${index}`, contentHash: `hash-${index}`,
    embeddingModel: "fixture", embeddingDimensions: 2, embedding: [1, 0], embeddingHash: libraryDescriptorHash(descriptor),
    sourceSnapshot: { sourceStorageKey: `key-${index}`, visualProfileHash: "visual-hash" },
    sourceAsset: { id: `source-${index}`, type: "image", storageKey: `key-${index}`, metadata: {} },
  };
}

describe("Character media candidate ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.entries.mockResolvedValue(Array.from({ length: 8 }, (_, index) => entry(index)));
    dependencies.exists.mockResolvedValue(null);
    dependencies.deliveries.mockResolvedValue([]);
    dependencies.visual.mockResolvedValue({ id: "visual", characterId: "character", version: 1, immutableHash: "visual-hash" });
    dependencies.embed.mockResolvedValue({ model: "fixture", dimensions: 2, vector: [1, 0] });
    dependencies.rerank.mockResolvedValue(null);
  });

  it("advertises only an existence hint without loading candidate vectors or calling models", async () => {
    dependencies.exists.mockResolvedValueOnce({ id: "entry-0" });
    expect(await availableCharacterMediaLibraryKinds(identity)).toEqual(["image"]);
    for (const kind of ["image", "video"]) {
      expect(dependencies.exists).toHaveBeenCalledWith({ select: { id: true }, where: expect.objectContaining({
        ...identity, kind, status: "published", sourceSnapshot: { path: ["visualProfileHash"], equals: "visual-hash" },
      }) });
    }
    expect(dependencies.entries).not.toHaveBeenCalled();
    expect(dependencies.embed).not.toHaveBeenCalled();

    dependencies.entries.mockResolvedValue([{ ...entry(0), embeddingHash: "stale-descriptor-hash" }]);
    expect(await hasEligibleCharacterMediaLibraryEntries({ ...identity, visualHash: "visual-hash", kind: "image" })).toBe(false);
    expect(await searchCharacterMediaLibrary({ ...identity, userId: "viewer", kind: "image", query: "seaside" })).toEqual([]);
    expect(dependencies.deliveries).not.toHaveBeenCalled();
    expect(dependencies.embed).not.toHaveBeenCalled();
  });

  it("stops checking coverage after the first verified page", async () => {
    dependencies.entries.mockResolvedValueOnce([entry(0)]).mockRejectedValue(new Error("The rest of the catalog must not be loaded"));
    expect(await hasEligibleCharacterMediaLibraryEntries({ ...identity, visualHash: "visual-hash" })).toBe(true);
    expect(dependencies.entries).toHaveBeenCalledTimes(1);
    expect(dependencies.entries.mock.calls[0][0].take).toBe(32);
    expect(dependencies.embed).not.toHaveBeenCalled();
  });

  it("keeps checking coverage past a full page of stale indexes without accepting them", async () => {
    const stale = Array.from({ length: 32 }, (_, index) => ({ ...entry(index), embeddingHash: "stale" }));
    dependencies.entries.mockResolvedValueOnce(stale).mockResolvedValueOnce([entry(32)]);
    expect(await hasEligibleCharacterMediaLibraryEntries({ ...identity, visualHash: "visual-hash" })).toBe(true);
    expect(dependencies.entries).toHaveBeenCalledTimes(2);
    expect(dependencies.entries.mock.calls[1][0]).toMatchObject({ take: 32, cursor: { id: "entry-31" }, skip: 1 });
  });

  it("only suppresses candidates with matching bytes or entry and a current delivery attempt", async () => {
    const available = [entry(0), entry(1), entry(2)];
    dependencies.entries.mockResolvedValue([...available, { ...entry(3), sourceAsset: null }]);
    dependencies.deliveries.mockResolvedValue([
      { delivery: { entryId: "older-entry", contentHash: "hash-0" }, attachmentMetadata: { attempt: 2 }, attempt: 2 },
      { delivery: { entryId: "entry-1", contentHash: "hash-1" }, attachmentMetadata: { attempt: 1 }, attempt: 2 },
      { delivery: { entryId: "entry-2", contentHash: "old-digest" }, attachmentMetadata: { attempt: 2 }, attempt: 2 },
    ]);
    const input = { ...identity, userId: "viewer", kind: "image" as const, query: "seaside" };
    expect((await searchCharacterMediaLibrary(input)).map(({ entry }) => entry.id)).toEqual(["entry-1"]);
    expect(dependencies.deliveries.mock.calls[0]?.slice(1)).toEqual([
      "viewer", "character", available.map(entry => entry.id), available.map(entry => entry.contentHash),
    ]);
    expect((await searchCharacterMediaLibrary({ ...input, unseenOnly: false })).map(({ entry, alreadySent }) => [entry.id, alreadySent]))
      .toEqual([["entry-0", true], ["entry-1", false], ["entry-2", true]]);
  });

  it("uses reviewed absence and observed technical constraints without inventing tags for free text", async () => {
    dependencies.entries.mockResolvedValue([]);
    await searchCharacterMediaLibrary({ ...identity, userId: "", kind: "video", query: "海边，不戴帽，6–10 秒且无音轨",
      excludedFacts: [" Hat "], requestedNudity: "none", minDurationSeconds: 6, maxDurationSeconds: 10, hasAudio: false });
    expect(dependencies.entries).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      kind: "video", absentFacts: { hasEvery: ["hat"] }, nudity: "none", durationSeconds: { gte: 6, lte: 10 }, hasAudio: false,
    }) }));
    expect(dependencies.entries.mock.calls[0]?.[0]?.where).not.toHaveProperty("facts");
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
    expect(new Set(matches.map(match => match.entry.id)).size).toBe(6);
    const documents = dependencies.rerank.mock.calls[0]?.[1] ?? [];
    expect(documents).toEqual(expect.arrayContaining([expect.stringContaining("A seaside photo 1024")]));
    expect(documents).toHaveLength(20);
    expect(new Set(documents).size).toBe(20);
  });

  it.each([true, false])("keeps both routes' strongest candidates and every fused window candidate (rerank=%s)", async rerank => {
    const blended = Array.from({ length: 20 }, (_, index) => {
      const subject = index === 5 || index === 19 ? "red frock" : "red bench";
      return { ...entry(index, { description: `A ${subject} ${index}`, facts: [subject] }), embedding: [0.8, 0.6] };
    });
    const gown = entry(20, { description: "A vermilion gown", facts: ["vermilion gown"] });
    const dress = { ...entry(21, { description: "A red dress", facts: ["red dress"] }), embedding: [0, 1] };
    dependencies.entries.mockResolvedValue([...blended, gown, dress]);
    if (rerank) {
      const knownScores = [{ phrase: "red frock 19", score: 1 }, { phrase: "vermilion gown", score: 0.9 }, { phrase: "red dress", score: 0.8 }];
      dependencies.rerank.mockImplementationOnce(async (_query: string, documents: string[]) => documents.map((document, index) => ({
        index, score: knownScores.find(({ phrase }) => document.includes(phrase))?.score ?? 0.1,
      })));
    }

    const matches = await searchCharacterMediaLibrary({ ...identity, userId: "viewer", kind: "image", query: "red dress" });
    const ids = matches.map(match => match.entry.id);
    const lastInWindow = blended[rerank ? 19 : 5]!;
    expect(ids).toEqual(expect.arrayContaining([lastInWindow.id, gown.id, dress.id]));
    if (rerank) {
      expect(ids).toHaveLength(6);
      expect(ids.slice(0, 3)).toEqual([lastInWindow.id, gown.id, dress.id]);
      expect(dependencies.rerank.mock.calls[0]?.[1]).toEqual(
        [...blended, gown, dress].map(candidate => expect.stringContaining(`${candidate.description}\n`)),
      );
    } else {
      expect(ids).toEqual([...blended.slice(0, 6).map(candidate => candidate.id), gown.id, dress.id]);
      expect(matches.find(match => match.entry.id === gown.id)?.score).toBe(1);
    }
  });

  it("never pollutes positive descriptor text or lexical BM25 scores with absentFacts", () => {
    const withoutGlasses = entry(0, { description: "A sunny café portrait", facts: ["sunny cafe"] });
    withoutGlasses.absentFacts = ["glasses", "hat"];
    const withGlasses = entry(1, { description: "A sunny café portrait wearing glasses", facts: ["sunny cafe", "glasses"] });
    withGlasses.absentFacts = [];

    const textWithout = libraryDescriptorText(withoutGlasses);
    expect(textWithout).not.toContain("Confirmed absent");
    expect(textWithout).not.toContain("glasses");
    expect(textWithout).not.toContain("hat");

    const scores = bm25Scores(
      lexicalTerms("wearing glasses"),
      [lexicalTerms(textWithout), lexicalTerms(libraryDescriptorText(withGlasses))],
    );
    expect(scores[0]).toBe(0);
    expect(scores[1]).toBeGreaterThan(0);
  });

  it("filters out low-confidence rerank candidates when minRerankScore is set", async () => {
    dependencies.rerank.mockResolvedValue(Array.from({ length: 8 }, (_, index) => ({ index, score: index / 10 })));
    const matches = await searchCharacterMediaLibrary({
      ...identity,
      userId: "viewer",
      kind: "image",
      query: "seaside",
      minRerankScore: 0.55,
    });
    expect(matches.map(match => match.entry.id)).toEqual(["entry-7", "entry-6"]);
  });
});
