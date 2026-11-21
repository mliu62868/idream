import { prisma } from "@/server/lib/db";
import { logger } from "@/server/lib/logger";
import { embedMediaText, mediaLibraryModels } from "./media-models";
import { libraryDescriptorHash, libraryDescriptorText } from "./service";

export interface ReembedCandidate {
  readonly id: string;
  readonly kind: string;
  readonly description: string;
  readonly facts: string[];
  readonly absentFacts: string[];
  readonly nudity: string;
  readonly durationSeconds: number | null;
  readonly hasAudio: boolean | null;
  readonly embeddingModel: string | null;
  readonly embeddingDimensions: number | null;
  readonly embeddingHash: string | null;
}

export function needsLibraryEntryReembed(
  entry: ReembedCandidate,
  config: { readonly model: string; readonly dimensions: number },
  force = false,
): boolean {
  if (force) return true;
  const expectedHash = libraryDescriptorHash(entry);
  return (
    entry.embeddingHash !== expectedHash ||
    entry.embeddingModel !== config.model ||
    entry.embeddingDimensions !== config.dimensions
  );
}

export interface ReembedLibraryResult {
  readonly scanned: number;
  readonly updated: number;
  readonly skipped: number;
  readonly failed: number;
}

/**
 * Re-embeds published character media library entries whose descriptor hash
 * (now de-poisoned without absentFacts) or embedding model drifted.
 * Updates only embedding metadata without mutating status or revision.
 */
export async function reembedCharacterMediaLibrary(options?: {
  readonly characterId?: string;
  readonly limit?: number;
  readonly force?: boolean;
  readonly signal?: AbortSignal;
}): Promise<ReembedLibraryResult> {
  const models = mediaLibraryModels();
  if (!models.embedding) {
    throw new Error("Configure character media embeddings before running re-embed");
  }
  const config = models.embedding;
  const limit = Math.max(1, Math.min(options?.limit ?? 200, 1_000));
  const force = options?.force ?? false;

  const entries = await prisma.characterMediaLibraryEntry.findMany({
    where: {
      status: "published",
      ...(options?.characterId ? { characterId: options.characterId } : {}),
    },
    orderBy: { updatedAt: "asc" },
    take: limit,
    select: {
      id: true,
      kind: true,
      description: true,
      facts: true,
      absentFacts: true,
      nudity: true,
      durationSeconds: true,
      hasAudio: true,
      embeddingModel: true,
      embeddingDimensions: true,
      embeddingHash: true,
    },
  });

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of entries) {
    if (options?.signal?.aborted) break;
    if (!needsLibraryEntryReembed(entry, config, force)) {
      skipped += 1;
      continue;
    }
    try {
      const text = libraryDescriptorText(entry);
      const hash = libraryDescriptorHash(entry);
      const embedded = await embedMediaText(text, config);
      await prisma.characterMediaLibraryEntry.update({
        where: { id: entry.id },
        data: {
          embedding: embedded.vector,
          embeddingModel: embedded.model,
          embeddingDimensions: embedded.dimensions,
          embeddingHash: hash,
        },
      });
      updated += 1;
    } catch (error) {
      failed += 1;
      logger.warn({ err: error, entryId: entry.id }, "Failed to re-embed character media library entry");
    }
  }

  return { scanned: entries.length, updated, skipped, failed };
}
