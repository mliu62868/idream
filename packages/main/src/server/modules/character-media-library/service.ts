import { createHash } from "node:crypto";
import type { CharacterMediaLibraryEntry, Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { isMediaAssetOperationalForAuthority, resolveMediaAssetBlobLocator } from "@/server/lib/media-asset-authority";
import { assertMediaAssetCustomerPublishable, resolveMediaAssetAuthorityMap } from "@/server/lib/media-asset-authority-query";
import { characterVisualProfileSnapshotHash } from "@/server/modules/admin-v2/characters/release-snapshot";
import { embedMediaText, mediaLibraryModels, rerankMediaText } from "./media-models";

type Db = Prisma.TransactionClient | PrismaClient;
export type LibraryIdentity = { characterId: string; visualProfileId: string; visualProfileVersion: number };
export type LibrarySearchInput = LibraryIdentity & {
  userId: string; kind: "image" | "video"; query: string;
  requiredFacts?: string[]; excludedFacts?: string[];
  requestedNudity?: "unspecified" | "none" | "full";
  unseenOnly?: boolean; minDurationSeconds?: number; maxDurationSeconds?: number; hasAudio?: boolean;
};
export type LibrarySearchCandidate = { entry: CharacterMediaLibraryEntry; score: number; alreadySent: boolean };

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
  const entries = await prisma.characterMediaLibraryEntry.findMany({ where: {
    ...input, status: "published", kind: { in: ["image", "video"] },
    embeddingModel: embedding.model, embeddingDimensions: embedding.dimensions,
    sourceAsset: { is: { deletedAt: null, safetyStatus: "passed", characterId: input.characterId } },
  }, include: { sourceAsset: true } });
  const authority = await resolveMediaAssetAuthorityMap(prisma, entries.flatMap(entry => entry.sourceAsset ? [entry.sourceAsset] : []));
  return [...new Set(entries.filter(entry => entry.sourceAsset && authority.get(entry.sourceAsset.id)?.publishable &&
    isMediaAssetOperationalForAuthority(entry.sourceAsset.metadata) && indexMatchesDescriptor(entry) &&
    resolveMediaAssetBlobLocator(entry.sourceAsset)?.key === record(entry.sourceSnapshot).sourceStorageKey &&
    record(entry.sourceSnapshot).visualProfileHash === visual.immutableHash)
    .map(entry => entry.kind as "image" | "video"))].sort();
}

export function libraryEntryDescriptor(entry: Pick<CharacterMediaLibraryEntry, "kind" | "description" | "facts" | "absentFacts" | "nudity" | "durationSeconds" | "hasAudio">) {
  return {
    kind: entry.kind, description: entry.description, facts: entry.facts, absentFacts: entry.absentFacts,
    nudity: entry.nudity, durationSeconds: entry.durationSeconds, hasAudio: entry.hasAudio,
  };
}

export function normalizeLibraryFact(value: string) { return value.normalize("NFKC").trim().toLocaleLowerCase("en").replace(/\s+/gu, " "); }
export function normalizedLibraryFacts(values: readonly string[]) { return [...new Set(values.map(normalizeLibraryFact))].sort(); }

export function libraryDescriptorText(entry: Parameters<typeof libraryEntryDescriptor>[0]) {
  const descriptor = libraryEntryDescriptor(entry);
  return [
    `${descriptor.kind}: ${descriptor.description}`,
    `Observed: ${normalizedLibraryFacts(descriptor.facts).join("; ")}`,
    `Confirmed absent: ${normalizedLibraryFacts(descriptor.absentFacts).join("; ")}`,
    `Wardrobe: ${descriptor.nudity}`,
    ...(descriptor.kind === "video" ? [`Duration: ${descriptor.durationSeconds} seconds. Audio: ${descriptor.hasAudio === null ? "unknown" : descriptor.hasAudio ? "present" : "absent"}.`] : []),
  ].join("\n");
}
export function libraryDescriptorHash(entry: Parameters<typeof libraryEntryDescriptor>[0]) {
  return createHash("sha256").update(libraryDescriptorText(entry)).digest("hex");
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

export async function searchCharacterMediaLibrary(input: LibrarySearchInput): Promise<LibrarySearchCandidate[]> {
  const config = mediaLibraryModels();
  if (!config.embedding) throw Errors.unavailable("Character media search is not configured");
  const visual = await prisma.characterVisualProfile.findUnique({ where: { id: input.visualProfileId } });
  if (!visual || visual.characterId !== input.characterId || visual.version !== input.visualProfileVersion ||
      !visual.immutableHash || visual.immutableHash !== characterVisualProfileSnapshotHash(visual)) return [];
  const requiredFacts = normalizedLibraryFacts(input.requiredFacts ?? []);
  const excludedFacts = normalizedLibraryFacts(input.excludedFacts ?? []);
  if (requiredFacts.some(fact => excludedFacts.includes(fact))) return [];
  const entries = await prisma.characterMediaLibraryEntry.findMany({
    where: {
      characterId: input.characterId, visualProfileId: input.visualProfileId, visualProfileVersion: input.visualProfileVersion,
      kind: input.kind, status: "published", embeddingModel: config.embedding.model, embeddingDimensions: config.embedding.dimensions,
      ...(requiredFacts.length ? { facts: { hasEvery: requiredFacts } } : {}),
      // Absence must be observed, not inferred from a missing tag.
      ...(excludedFacts.length ? { absentFacts: { hasEvery: excludedFacts } } : {}),
      ...(input.requestedNudity && input.requestedNudity !== "unspecified" ? { nudity: input.requestedNudity } : {}),
      ...(input.hasAudio === undefined ? {} : { hasAudio: input.hasAudio }),
      ...(input.minDurationSeconds === undefined && input.maxDurationSeconds === undefined ? {} : {
        durationSeconds: { ...(input.minDurationSeconds === undefined ? {} : { gte: input.minDurationSeconds }), ...(input.maxDurationSeconds === undefined ? {} : { lte: input.maxDurationSeconds }) },
      }),
      sourceAsset: { is: { deletedAt: null, safetyStatus: "passed", characterId: input.characterId } },
    },
    include: { sourceAsset: true }, orderBy: { id: "asc" },
  });
  if (!entries.length) return [];
  const authority = await resolveMediaAssetAuthorityMap(prisma, entries.flatMap(entry => entry.sourceAsset ? [entry.sourceAsset] : []));
  const delivered = await prisma.chatTurnAttachment.findMany({
    where: { status: "completed", turn: { session: { userId: input.userId, characterId: input.characterId } } },
    select: { metadata: true, mediaAssetId: true, turn: { select: { attempt: true } } },
  });
  const deliveredIds = delivered.filter(row => record(row.metadata).attempt === row.turn.attempt).flatMap(row => row.mediaAssetId ? [row.mediaAssetId] : []);
  const assets = deliveredIds.length ? await prisma.mediaAsset.findMany({
    where: { id: { in: deliveredIds }, ownerId: input.userId }, select: { metadata: true },
  }) : [];
  const seenEntries = new Set<string>();
  const seenHashes = new Set<string>();
  for (const asset of assets) {
    const delivery = record(record(asset.metadata).libraryDelivery);
    if (typeof delivery.entryId === "string") seenEntries.add(delivery.entryId);
    if (typeof delivery.contentHash === "string") seenHashes.add(delivery.contentHash);
  }
  const eligible = entries.filter(entry => entry.sourceAsset && authority.get(entry.sourceAsset.id)?.publishable &&
    isMediaAssetOperationalForAuthority(entry.sourceAsset.metadata) && indexMatchesDescriptor(entry) &&
    resolveMediaAssetBlobLocator(entry.sourceAsset)?.key === record(entry.sourceSnapshot).sourceStorageKey &&
    record(entry.sourceSnapshot).visualProfileHash === visual.immutableHash)
    .map(entry => ({ entry, alreadySent: seenEntries.has(entry.id) || seenHashes.has(entry.contentHash) }))
    .filter(candidate => input.unseenOnly === false || !candidate.alreadySent);
  if (!eligible.length) return [];
  const query = await embedMediaText(input.query, config.embedding);
  const tokens = words(input.query);
  const scored = eligible.map(candidate => ({ ...candidate,
    dense: dot(query.vector, candidate.entry.embedding),
    lexical: words(libraryDescriptorText(candidate.entry)).filter(word => tokens.includes(word)).length,
  }));
  const dense = [...scored].sort((a, b) => b.dense - a.dense);
  const lexical = [...scored].filter(candidate => candidate.lexical > 0).sort((a, b) => b.lexical - a.lexical);
  const ranks = new Map<string, number>();
  // Equal keyword overlap is not evidence that an earlier row is more relevant.
  // Share tied ranks so a late semantic match can still reach the reranker.
  for (const [ranking, key] of [[dense, "dense"], [lexical, "lexical"]] as const) {
    let rank = 0;
    ranking.forEach((candidate, index) => {
      if (index === 0 || candidate[key] !== ranking[index - 1]![key]) rank = index;
      ranks.set(candidate.entry.id, (ranks.get(candidate.entry.id) ?? 0) + 1 / (60 + rank + 1));
    });
  }
  const candidates = scored.sort((a, b) => (ranks.get(b.entry.id) ?? 0) - (ranks.get(a.entry.id) ?? 0)).slice(0, 20);
  const reranked = await rerankMediaText(input.query, candidates.map(candidate => libraryDescriptorText(candidate.entry)), config.rerank);
  // These scores order evidence for the Agent; they are never confidence or a
  // grant to send. The Agent must check every explicit request against facts.
  return (reranked ? reranked.map(row => ({ ...candidates[row.index]!, score: row.score }))
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
    : candidates.map(candidate => ({ ...candidate, score: candidate.dense })))
    .slice(0, 6).map(({ entry, score, alreadySent }) => ({ entry, score, alreadySent }));
}

function indexMatchesDescriptor(entry: CharacterMediaLibraryEntry) {
  return entry.embeddingHash === libraryDescriptorHash(entry) && entry.embeddingDimensions !== null && entry.embeddingDimensions > 0 &&
    entry.embedding.length === entry.embeddingDimensions && entry.embedding.every(Number.isFinite) && entry.embedding.some(value => value !== 0);
}
function dot(a: readonly number[], b: readonly number[]) { return a.length === b.length ? a.reduce((sum, value, index) => sum + value * b[index]!, 0) : -Infinity; }
function words(value: string) { return [...new Set(normalizeLibraryFact(value).match(/[\p{L}\p{N}]+/gu) ?? [])]; }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
