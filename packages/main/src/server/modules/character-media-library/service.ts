import { createHash } from "node:crypto";
import type { CharacterMediaLibraryEntry, Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { isMediaAssetOperationalForAuthority, resolveMediaAssetBlobLocator } from "@/server/lib/media-asset-authority";
import { assertMediaAssetCustomerPublishable, resolveMediaAssetAuthorityMap } from "@/server/lib/media-asset-authority-query";
import { characterVisualProfileSnapshotHash } from "@/server/modules/admin-v2/characters/release-snapshot";
import { attachmentAttempt } from "@/server/modules/chat/turn-scope";
import { embedMediaText, mediaLibraryModels, rerankMediaText } from "./media-models";

type Db = Prisma.TransactionClient | PrismaClient;
type LibraryEntryWithSource = Prisma.CharacterMediaLibraryEntryGetPayload<{ include: { sourceAsset: true } }>;
export type LibraryIdentity = { characterId: string; visualProfileId: string; visualProfileVersion: number };
export type LibrarySearchInput = LibraryIdentity & {
  userId: string; kind: "image" | "video"; query: string;
  requiredFacts?: string[]; excludedFacts?: string[];
  requestedNudity?: "unspecified" | "none" | "partial" | "full";
  attireLevels?: string[];
  distributionScope?: "chat_library" | "pack_exclusive";
  minRerankScore?: number;
  unseenOnly?: boolean; minDurationSeconds?: number; maxDurationSeconds?: number; hasAudio?: boolean;
};
export type LibrarySearchCandidate = {
  entry: CharacterMediaLibraryEntry;
  score: number;
  scoreSource: "rerank" | "dense";
  alreadySent: boolean;
};

const LEXICAL_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have",
  "her", "hers", "him", "his", "i", "in", "is", "it", "its", "me", "my", "of",
  "on", "or", "our", "photo", "picture", "please", "send", "she", "show", "some",
  "that", "the", "their", "them", "there", "this", "to", "us", "video", "want",
  "with", "you", "your",
]);

export async function availableCharacterMediaLibraryKinds(input: LibraryIdentity): Promise<Array<"image" | "video">> {
  let embedding: ReturnType<typeof mediaLibraryModels>["embedding"];
  try { embedding = mediaLibraryModels().embedding; }
  catch {
    logger.warn("Character media search is disabled because its model configuration is invalid");
    return [];
  }
  if (!embedding) return [];
  const visual = await prisma.characterVisualProfile.findUnique({ where: { id: input.visualProfileId } });
  if (!visual || visual.characterId !== input.characterId || visual.version !== input.visualProfileVersion ||
      !visual.immutableHash || visual.immutableHash !== characterVisualProfileSnapshotHash(visual)) return [];
  const visualHash = visual.immutableHash;
  const kinds = ["image", "video"] as const;
  // Admission only advertises which lookups are worth offering. It must not
  // materialize the catalog or authorize a delivery for every text Turn.
  const present = await Promise.all(kinds.map(kind => prisma.characterMediaLibraryEntry.findFirst({
    where: {
      ...input, kind, status: "published", distributionScope: "chat_library",
      embeddingModel: embedding.model, embeddingDimensions: embedding.dimensions,
      embeddingHash: { not: null }, sourceSnapshot: { path: ["visualProfileHash"], equals: visualHash },
      sourceAsset: { is: { type: kind, deletedAt: null, safetyStatus: "passed", characterId: input.characterId } },
    }, select: { id: true },
  })));
  return kinds.filter((_, index) => present[index] !== null);
}

/** Operator coverage reflects verified source and index eligibility, not the Turn's cheaper tool hint. */
export async function hasEligibleCharacterMediaLibraryEntries(input: LibraryIdentity & { visualHash: string | null; kind?: "image" | "video" }) {
  const { visualHash, kind, ...identity } = input;
  if (!visualHash) return false;
  let embedding: ReturnType<typeof mediaLibraryModels>["embedding"];
  try { embedding = mediaLibraryModels().embedding; }
  catch { return false; }
  if (!embedding) return false;
  const where: Prisma.CharacterMediaLibraryEntryWhereInput = {
    ...identity, status: "published", kind: kind ?? { in: ["image", "video"] },
    embeddingModel: embedding.model, embeddingDimensions: embedding.dimensions,
    sourceAsset: { is: { ...(kind ? { type: kind } : {}), deletedAt: null, safetyStatus: "passed", characterId: identity.characterId } },
  };
  // Coverage needs one verified result. Bound each read and stop before loading
  // the remaining vectors or resolving their generation provenance.
  const pageSize = 32;
  let cursor: string | undefined;
  while (true) {
    const entries = await prisma.characterMediaLibraryEntry.findMany({
      where, include: { sourceAsset: true }, orderBy: { id: "asc" }, take: pageSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if ((await filterVerifiedLibraryEntries(entries, visualHash)).length > 0) return true;
    if (entries.length < pageSize) return false;
    cursor = entries[entries.length - 1]!.id;
  }
}

export function libraryEntryDescriptor(entry: Pick<CharacterMediaLibraryEntry, "kind" | "description" | "facts" | "absentFacts" | "nudity" | "durationSeconds" | "hasAudio">) {
  return {
    kind: entry.kind, description: entry.description, facts: entry.facts, absentFacts: entry.absentFacts,
    nudity: entry.nudity, durationSeconds: entry.durationSeconds, hasAudio: entry.hasAudio,
  };
}

export function normalizeLibraryFact(value: string) { return value.normalize("NFKC").trim().toLocaleLowerCase("en").replace(/\s+/gu, " "); }
export function normalizedLibraryFacts(values: readonly string[]) { return [...new Set(values.map(normalizeLibraryFact))].sort(); }

/**
 * Positive-only visual text for dense embedding, lexical BM25, and reranking.
 * Deliberately excludes `absentFacts` and template label noise ("Confirmed absent:",
 * "Observed:", "Wardrobe:") so negated facts never poison positive retrieval.
 */
export function libraryDescriptorText(entry: Parameters<typeof libraryEntryDescriptor>[0]) {
  const descriptor = libraryEntryDescriptor(entry);
  const positiveFacts = normalizedLibraryFacts(descriptor.facts).join("; ");
  return [
    descriptor.description.trim(),
    ...(positiveFacts ? [positiveFacts] : []),
  ].join("\n");
}
export function libraryDescriptorHash(entry: Parameters<typeof libraryEntryDescriptor>[0]) {
  const descriptor = libraryEntryDescriptor(entry);
  return createHash("sha256").update(JSON.stringify({
    v: 2,
    text: libraryDescriptorText(descriptor),
    kind: descriptor.kind,
    absentFacts: normalizedLibraryFacts(descriptor.absentFacts),
    nudity: descriptor.nudity,
    durationSeconds: descriptor.durationSeconds,
    hasAudio: descriptor.hasAudio,
  })).digest("hex");
}

/** The caller holds Character -> source asset -> library row locks at commit. */
export async function assertLibraryEntryAvailable(db: Db, entry: CharacterMediaLibraryEntry, expected: LibraryIdentity): Promise<void> {
  if (entry.status !== "published" || entry.characterId !== expected.characterId || entry.visualProfileId !== expected.visualProfileId ||
      entry.visualProfileVersion !== expected.visualProfileVersion || !entry.sourceAssetId || !indexMatchesDescriptor(entry)) {
    throw Errors.conflict("This chat library item is no longer available for the current Character identity");
  }
  const source = await db.mediaAsset.findUnique({ where: { id: entry.sourceAssetId } });
  const character = await db.character.findUnique({ where: { id: expected.characterId }, select: { age: true, deletedAt: true, status: true } });
  const visual = await db.characterVisualProfile.findUnique({ where: { id: expected.visualProfileId } });
  if (!character || character.deletedAt || character.age < 18 || ["removed", "archived", "rejected"].includes(character.status) ||
      !visual || visual.characterId !== expected.characterId || visual.version !== expected.visualProfileVersion ||
      !visual.immutableHash || visual.immutableHash !== characterVisualProfileSnapshotHash(visual) ||
      record(entry.sourceSnapshot).visualProfileHash !== visual.immutableHash) {
    throw Errors.conflict("The Character visual identity is no longer available");
  }
  if (!source || source.characterId !== expected.characterId || source.type !== entry.kind || source.deletedAt || source.safetyStatus !== "passed" ||
      !isMediaAssetOperationalForAuthority(source.metadata) ||
      resolveMediaAssetBlobLocator(source)?.key !== record(entry.sourceSnapshot).sourceStorageKey) {
    throw Errors.conflict("The source media is no longer available for new library delivery");
  }
  await assertMediaAssetCustomerPublishable(db, source);
}

export async function searchCharacterMediaLibrary(input: LibrarySearchInput, signal?: AbortSignal): Promise<LibrarySearchCandidate[]> {
  signal?.throwIfAborted();
  const config = mediaLibraryModels();
  if (!config.embedding) throw Errors.unavailable("Character media search is not configured");
  const visual = await prisma.characterVisualProfile.findUnique({ where: { id: input.visualProfileId } });
  signal?.throwIfAborted();
  if (!visual || visual.characterId !== input.characterId || visual.version !== input.visualProfileVersion ||
      !visual.immutableHash || visual.immutableHash !== characterVisualProfileSnapshotHash(visual)) return [];
  const requiredFacts = normalizedLibraryFacts(input.requiredFacts ?? []);
  const excludedFacts = normalizedLibraryFacts(input.excludedFacts ?? []);
  if (requiredFacts.some(fact => excludedFacts.includes(fact))) return [];
  const verified = await verifiedLibraryEntries({
      characterId: input.characterId, visualProfileId: input.visualProfileId, visualProfileVersion: input.visualProfileVersion,
      kind: input.kind, status: "published", embeddingModel: config.embedding.model, embeddingDimensions: config.embedding.dimensions,
      ...(requiredFacts.length ? { facts: { hasEvery: requiredFacts } } : {}),
      // Absence must be observed, not inferred from a missing tag.
      ...(excludedFacts.length ? { absentFacts: { hasEvery: excludedFacts } } : {}),
      ...(input.requestedNudity && input.requestedNudity !== "unspecified" ? { nudity: input.requestedNudity } : {}),
      ...(input.attireLevels?.length ? { attireLevel: { in: input.attireLevels } } : {}),
      ...(input.distributionScope ? { distributionScope: input.distributionScope } : {}),
      ...(input.hasAudio === undefined ? {} : { hasAudio: input.hasAudio }),
      ...(input.minDurationSeconds === undefined && input.maxDurationSeconds === undefined ? {} : {
        durationSeconds: { ...(input.minDurationSeconds === undefined ? {} : { gte: input.minDurationSeconds }), ...(input.maxDurationSeconds === undefined ? {} : { lte: input.maxDurationSeconds }) },
      }),
      sourceAsset: { is: { type: input.kind, deletedAt: null, safetyStatus: "passed", characterId: input.characterId } },
  }, visual.immutableHash, signal);
  signal?.throwIfAborted();
  const delivered = await deliveredLibraryMedia(prisma, { userId: input.userId, characterId: input.characterId, entries: verified });
  signal?.throwIfAborted();
  const eligible = verified.map(entry => ({ entry, alreadySent: delivered.has(entry.id) }))
    .filter(candidate => input.unseenOnly === false || !candidate.alreadySent);
  if (!eligible.length) return [];
  const query = await embedMediaText(input.query, config.embedding, undefined, signal);
  signal?.throwIfAborted();
  const queryTerms = lexicalTerms(input.query);
  const docTermLists = eligible.map(candidate => lexicalTerms(libraryDescriptorText(candidate.entry)));
  const lexicalScores = bm25Scores(queryTerms, docTermLists);
  const scored = eligible.map((candidate, index) => ({ ...candidate,
    dense: dot(query.vector, candidate.entry.embedding),
    lexical: lexicalScores[index] ?? 0,
  }));
  const dense = [...scored].sort((a, b) => b.dense - a.dense);
  const lexical = scored.filter(candidate => candidate.lexical > 0).sort((a, b) => b.lexical - a.lexical || b.dense - a.dense);
  const ranks = new Map<string, number>();
  // Equal scores share a rank. Similarity only breaks lexical ties when
  // choosing the leading lexical candidate.
  for (const [ranking, key] of [[dense, "dense"], [lexical, "lexical"]] as const) {
    let rank = 0;
    ranking.forEach((candidate, index) => {
      if (index === 0 || candidate[key] !== ranking[index - 1]![key]) rank = index;
      ranks.set(candidate.entry.id, (ranks.get(candidate.entry.id) ?? 0) + 1 / (60 + rank + 1));
    });
  }
  const fused = scored.sort((a, b) => (ranks.get(b.entry.id) ?? 0) - (ranks.get(a.entry.id) ?? 0));
  const leaders = [...dense.slice(0, 1), ...lexical.slice(0, 1)];
  // Keep the fused window intact and append any missing route leader in
  // dense then lexical order. Map updates preserve the original positions.
  const shortlist = (limit: number) => {
    const selected = new Map(fused.slice(0, limit).map(candidate => [candidate.entry.id, candidate]));
    for (const candidate of leaders) selected.set(candidate.entry.id, candidate);
    return [...selected.values()];
  };
  const candidates = shortlist(20);
  const reranked = await rerankMediaText(input.query, candidates.map(candidate => libraryDescriptorText(candidate.entry)), config.rerank, undefined, signal);
  signal?.throwIfAborted();
  const ranked = reranked
    ? reranked.map(row => ({ ...candidates[row.index]!, score: row.score }))
      .filter(candidate => input.minRerankScore === undefined || candidate.score >= input.minRerankScore)
      .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id)).slice(0, 6)
    : shortlist(6).map(candidate => ({ ...candidate, score: candidate.dense }));
  return ranked.map(({ entry, score, alreadySent }) => ({ entry, score, scoreSource: reranked ? "rerank" : "dense", alreadySent }));
}

async function verifiedLibraryEntries(where: Prisma.CharacterMediaLibraryEntryWhereInput, visualHash: string, signal?: AbortSignal) {
  const entries = await prisma.characterMediaLibraryEntry.findMany({ where, include: { sourceAsset: true }, orderBy: { id: "asc" } });
  signal?.throwIfAborted();
  return filterVerifiedLibraryEntries(entries, visualHash);
}

async function filterVerifiedLibraryEntries(entries: LibraryEntryWithSource[], visualHash: string) {
  if (!entries.length) return [];
  const authority = await resolveMediaAssetAuthorityMap(prisma, entries.flatMap(entry => entry.sourceAsset ? [entry.sourceAsset] : []));
  return entries.filter(entry => entry.sourceAsset?.type === entry.kind && authority.get(entry.sourceAsset.id)?.publishable &&
    isMediaAssetOperationalForAuthority(entry.sourceAsset.metadata) && indexMatchesDescriptor(entry) &&
    resolveMediaAssetBlobLocator(entry.sourceAsset)?.key === record(entry.sourceSnapshot).sourceStorageKey &&
    record(entry.sourceSnapshot).visualProfileHash === visualHash);
}

/** Search and the locked delivery use the same viewer/Character history and byte identity. */
export async function deliveredLibraryMedia(db: Db, input: {
  userId: string; characterId: string;
  entries: ReadonlyArray<Pick<CharacterMediaLibraryEntry, "id" | "contentHash"> & { nearDuplicateClusterId?: string | null }>;
}): Promise<Set<string>> {
  // Admin previews have no viewer history. Limit the joined result to
  // deliveries that can suppress a current candidate.
  if (!input.userId || !input.entries.length) return new Set();
  const ids = input.entries.map(entry => entry.id);
  const hashes = [...new Set(input.entries.map(entry => entry.contentHash))];
  const clusters = [...new Set(input.entries.map(entry => entry.nearDuplicateClusterId).filter((value): value is string => Boolean(value)))];
  const seenIds = new Set<string>();
  const seenHashes = new Set<string>();
  const seenClusters = new Set<string>();

  // 1) Ledger-grade lifetime receipts (survive chat message/session deletion).
  const receiptClient = (db as { userCharacterLibraryReceipt?: PrismaClient["userCharacterLibraryReceipt"] }).userCharacterLibraryReceipt;
  if (receiptClient) {
    const receipts = await receiptClient.findMany({
      where: {
        userId: input.userId,
        characterId: input.characterId,
        OR: [
          { entryId: { in: ids } },
          { contentHash: { in: hashes } },
          ...(clusters.length > 0 ? [{ nearDuplicateClusterId: { in: clusters } }] : []),
        ],
      },
      select: { entryId: true, contentHash: true, nearDuplicateClusterId: true },
    });
    for (const receipt of receipts) {
      seenIds.add(receipt.entryId);
      seenHashes.add(receipt.contentHash);
      if (receipt.nearDuplicateClusterId) seenClusters.add(receipt.nearDuplicateClusterId);
    }
  }

  // 2) Legacy chat_turn_attachments fallback for deliveries recorded prior to receipts table.
  const rows = await db.$queryRaw<Array<{ delivery: Prisma.JsonValue; attachmentMetadata: Prisma.JsonValue; attempt: number }>>`
    SELECT DISTINCT asset.metadata -> 'libraryDelivery' AS delivery,
      attachment.metadata AS "attachmentMetadata", turn.attempt
    FROM "media_assets" asset
    JOIN "chat_turn_attachments" attachment ON attachment."mediaAssetId" = asset.id
    JOIN "chat_turns" turn ON turn.id = attachment."turnId"
    JOIN "recent_chats" chat ON chat."sessionId" = turn."sessionId"
      AND chat."userId" = asset."ownerId" AND chat."characterId" = asset."characterId"
    WHERE asset."ownerId" = ${input.userId} AND asset."characterId" = ${input.characterId}
      AND attachment.status = 'completed'
      AND (asset.metadata #>> '{libraryDelivery,entryId}' = ANY(${ids}::text[])
        OR asset.metadata #>> '{libraryDelivery,contentHash}' = ANY(${hashes}::text[]))
  `;
  for (const row of rows) {
    if (attachmentAttempt(row.attachmentMetadata) !== row.attempt) continue;
    const { entryId, contentHash } = record(row.delivery);
    if (typeof entryId === "string") seenIds.add(entryId);
    if (typeof contentHash === "string") seenHashes.add(contentHash);
  }
  return new Set(
    input.entries
      .filter(entry =>
        seenIds.has(entry.id)
        || seenHashes.has(entry.contentHash)
        || (entry.nearDuplicateClusterId ? seenClusters.has(entry.nearDuplicateClusterId) : false),
      )
      .map(entry => entry.id),
  );
}

function indexMatchesDescriptor(entry: CharacterMediaLibraryEntry) {
  return entry.embeddingHash === libraryDescriptorHash(entry) && entry.embeddingDimensions !== null && entry.embeddingDimensions > 0 &&
    entry.embedding.length === entry.embeddingDimensions && entry.embedding.every(Number.isFinite) && entry.embedding.some(value => value !== 0);
}
function dot(a: readonly number[], b: readonly number[]) { return a.length === b.length ? a.reduce((sum, value, index) => sum + value * b[index]!, 0) : -Infinity; }
export function lexicalTerms(value: string): string[] {
  const raw = normalizeLibraryFact(value).match(/[\p{L}\p{N}]+/gu) ?? [];
  const filtered = raw.filter(token => !LEXICAL_STOPWORDS.has(token));
  return filtered.length > 0 ? filtered : raw;
}
export function bm25Scores(queryTerms: readonly string[], docs: readonly (readonly string[])[], k1 = 1.2, b = 0.75): number[] {
  const docCount = docs.length;
  if (docCount === 0 || queryTerms.length === 0) return docs.map(() => 0);
  const uniqueQuery = [...new Set(queryTerms)];
  const avgDocLength = docs.reduce((sum, doc) => sum + doc.length, 0) / docCount || 1;
  const docFreq = new Map<string, number>();
  const termFreqs = docs.map(doc => {
    const counts = new Map<string, number>();
    for (const term of doc) counts.set(term, (counts.get(term) ?? 0) + 1);
    for (const term of counts.keys()) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    return counts;
  });
  return docs.map((doc, index) => {
    const counts = termFreqs[index]!;
    let score = 0;
    for (const term of uniqueQuery) {
      const tf = counts.get(term) ?? 0;
      if (tf === 0) continue;
      const df = docFreq.get(term) ?? 0;
      const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (doc.length / avgDocLength))));
    }
    return score;
  });
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
