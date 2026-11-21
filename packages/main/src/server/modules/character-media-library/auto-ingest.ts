import { randomUUID } from "node:crypto";
import { matchCharacterVideoSourceIdentity } from "@/server/modules/admin-v2/characters/video-source-identity";
import { prisma } from "@/server/lib/db";
import { logger } from "@/server/lib/logger";
import { isMediaAssetOperationalForAuthority, resolveMediaAssetBlobLocator } from "@/server/lib/media-asset-authority";
import { characterVisualProfileSnapshotHash } from "@/server/modules/admin-v2/characters/release-snapshot";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { jsonRecord } from "@/server/modules/ourdream/json-values";
import { providers } from "@/server/providers";
import { readLibrarySourceBytes } from "./media-bytes";
import { describeMediaFrames, embedMediaText, mediaLibraryModels } from "./media-models";
import { libraryDescriptorHash, libraryDescriptorText, normalizedLibraryFacts } from "./service";

export const AUTO_INGEST_PACK_PURPOSES = [
  "character_library_image_pack",
  "character_library_video_pack",
] as const;

export interface AutoIngestDraftDescriptor {
  readonly description: string;
  readonly facts: string[];
  readonly absentFacts: string[];
  /** Always fail-closed to "unknown" until an operator explicitly confirms in Batch Review. */
  readonly nudity: "unknown";
  readonly descriptionSource: "vision" | "operator";
  readonly attireLevel: string | null;
}

/**
 * Pure builder for auto-ingested draft descriptors.
 * Guarantees fail-closed nudity ("unknown") so no unverified asset can ever be
 * auto-published without an operator signing off via `batch-review`.
 */
export function buildAutoIngestDraftDescriptor(input: {
  readonly kind: "image" | "video";
  readonly promptHint?: string | null;
  readonly visionObservation?: {
    readonly description: string;
    readonly facts: readonly string[];
    readonly absentFacts: readonly string[];
  } | null;
}): AutoIngestDraftDescriptor {
  if (input.visionObservation) {
    const facts = normalizedLibraryFacts(input.visionObservation.facts);
    const absentFacts = normalizedLibraryFacts(input.visionObservation.absentFacts).filter(
      (fact) => !facts.includes(fact),
    );
    return {
      description: input.visionObservation.description.trim().slice(0, 2_000),
      facts,
      absentFacts,
      nudity: "unknown",
      descriptionSource: "vision",
      attireLevel: null,
    };
  }
  const cleanHint = input.promptHint?.replace(/\s+/gu, " ").trim().slice(0, 400);
  const fallback = cleanHint && cleanHint.length >= 3
    ? `Draft ${input.kind} from batch pack (pending operator review): ${cleanHint}`
    : `Draft ${input.kind} from batch pre-generation pack (pending operator review).`;
  return {
    description: fallback,
    facts: [],
    absentFacts: [],
    nudity: "unknown",
    descriptionSource: "operator",
    attireLevel: null,
  };
}

export interface AutoIngestPackSummary {
  readonly scanned: number;
  readonly ingested: number;
  readonly skipped: number;
  readonly failed: number;
}

/**
 * Sweeps completed `character_library_image_pack` / `character_library_video_pack`
 * ContentProductionItems that do not yet have a CharacterMediaLibraryEntry for
 * their Visual Profile, preserves an immutable library blob copy, runs optional
 * Vision pre-labeling + Embedding, and inserts `status = "draft", nudity = "unknown"`
 * so operators can batch-review 30 items in minutes.
 */
export async function autoIngestCompletedLibraryPackItems(limit = 4): Promise<AutoIngestPackSummary> {
  const safeLimit = Math.max(1, Math.min(limit, 20));
  // INVARIANT: previously ingested items cannot consume the bounded sweep window.
  // A source can have entries under several pins, so match the exact job identity.
  const pending = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT item.id
    FROM "content_production_items" item
    JOIN "content_production_batches" batch ON batch.id = item."batchId"
    JOIN "generation_jobs" job ON job.id = item."jobId"
    CROSS JOIN LATERAL (SELECT
      CASE WHEN job.mode = 'video' THEN job."sourceMeta" #>> '{videoSourceIdentity,visualProfileId}'
        ELSE job."visualProfileId" END AS profile_id,
      CASE WHEN job.mode = 'video' THEN job."sourceMeta" #>> '{videoSourceIdentity,visualProfileVersion}'
        ELSE job."visualProfileVersion"::text END AS profile_version
    ) pin
    WHERE item.status IN ('generated', 'approved')
      AND item."mediaAssetId" IS NOT NULL
      AND batch."targetType" = 'character'
      AND batch.purpose = ANY(${[...AUTO_INGEST_PACK_PURPOSES]}::text[])
      AND batch."lifecycleState" IN ('active', 'closed')
      AND job.status = 'completed'
      AND job."characterId" = batch."targetId"
      AND pin.profile_id IS NOT NULL
      AND pin.profile_version IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "character_media_library_entries" entry
        WHERE entry."characterId" = batch."targetId"
          AND entry."sourceAssetId" = item."mediaAssetId"
          AND entry."visualProfileId" = pin.profile_id
          AND entry."visualProfileVersion"::text = pin.profile_version
      )
    ORDER BY item."createdAt" DESC, item.id DESC
    LIMIT ${safeLimit * 3}
  `;
  const candidates = await prisma.contentProductionItem.findMany({
    where: {
      id: { in: pending.map(row => row.id) },
      status: { in: ["generated", "approved"] },
      mediaAssetId: { not: null },
      batch: {
        targetType: "character",
        purpose: { in: [...AUTO_INGEST_PACK_PURPOSES] },
        lifecycleState: { in: ["active", "closed"] },
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: {
      batch: {
        select: {
          id: true,
          targetId: true,
          purpose: true,
          createdById: true,
        },
      },
      job: true,
      mediaAsset: true,
    },
  });

  let scanned = 0;
  let ingested = 0;
  let skipped = 0;
  let failed = 0;

  let models: ReturnType<typeof mediaLibraryModels> = { embedding: null, rerank: null, vision: null };
  try {
    models = mediaLibraryModels();
  } catch (error) {
    logger.warn({ err: error }, "Media library models unavailable during pack auto-ingest; proceeding with draft metadata only");
  }

  for (const item of candidates) {
    if (ingested >= safeLimit) break;
    scanned += 1;

    const characterId = item.batch.targetId;
    const asset = item.mediaAsset;
    const job = item.job;
    if (
      !characterId
      || !asset
      || !job
      || job.status !== "completed"
      || job.characterId !== characterId
      || job.mode !== asset.type
      || asset.deletedAt !== null
      || asset.safetyStatus !== "passed"
      || !isMediaAssetOperationalForAuthority(asset.metadata)
      || !resolveMediaAssetBlobLocator(asset)
      || (asset.type !== "image" && asset.type !== "video")
    ) {
      skipped += 1;
      continue;
    }

    // Video packs pin the source image identity when the Run is accepted.
    const pin = asset.type === "video" ? jsonRecord(jsonRecord(job.sourceMeta).videoSourceIdentity) : job;
    const { visualProfileId, visualProfileVersion } = pin;
    if (typeof visualProfileId !== "string" || !visualProfileId ||
      typeof visualProfileVersion !== "number" || !Number.isSafeInteger(visualProfileVersion) || visualProfileVersion < 1) {
      skipped += 1;
      continue;
    }

    const existing = await prisma.characterMediaLibraryEntry.findUnique({
      where: {
        characterId_sourceAssetId_visualProfileId_visualProfileVersion: {
          characterId,
          sourceAssetId: asset.id,
          visualProfileId,
          visualProfileVersion,
        },
      },
      select: { id: true },
    });
    if (existing) {
      skipped += 1;
      continue;
    }

    const visual = await prisma.characterVisualProfile.findFirst({
      where: { id: visualProfileId, characterId, version: visualProfileVersion },
    });
    if (!visual || visual.immutableHash !== characterVisualProfileSnapshotHash(visual)) {
      skipped += 1;
      continue;
    }
    if (asset.type === "video" && (asset.sourceJobId !== job.id || job.sourceType !== "content_production_item" ||
      job.sourceId !== item.id || !(await matchCharacterVideoSourceIdentity(prisma, job, asset, visual)))) {
      skipped += 1;
      continue;
    }

    const id = `cml_${randomUUID()}`;
    const storageKey = `character-chat-library/${characterId}/${id}/media`;
    const thumbnailKey = `character-chat-library/${characterId}/${id}/thumbnail.jpg`;

    try {
      const media = await readLibrarySourceBytes(asset);
      for (const blobItem of [
        { key: storageKey, body: media.bytes, contentType: media.contentType },
        { key: thumbnailKey, body: media.thumbnail, contentType: "image/jpeg" },
      ]) {
        const stored = providers.blob.putPrivateIfAbsent
          ? await providers.blob.putPrivateIfAbsent({ ...blobItem, signal: AbortSignal.timeout(30_000) })
          : await providers.blob.putPrivate({ ...blobItem, signal: AbortSignal.timeout(30_000) });
        if (!stored.ok) {
          throw new Error("Failed to persist immutable library copy during auto-ingest");
        }
      }

      let visionObservation: { description: string; facts: string[]; absentFacts: string[] } | null = null;
      if (models.vision && media.frames.length > 0) {
        try {
          const observed = await describeMediaFrames(
            { kind: media.kind, frames: media.frames, durationSeconds: media.durationSeconds },
            models.vision,
          );
          visionObservation = {
            description: observed.description,
            facts: observed.facts,
            absentFacts: observed.absentFacts,
          };
        } catch (visionError) {
          logger.warn({ err: visionError, itemId: item.id, assetId: asset.id }, "Auto-ingest Vision pre-labeling failed; falling back to draft descriptor");
        }
      }

      const draft = buildAutoIngestDraftDescriptor({
        kind: media.kind,
        promptHint: job.prompt,
        visionObservation,
      });

      const descriptorForIndex = {
        kind: media.kind,
        description: draft.description,
        facts: draft.facts,
        absentFacts: draft.absentFacts,
        nudity: draft.nudity,
        durationSeconds: media.durationSeconds,
        hasAudio: media.hasAudio,
      };

      let embedding: number[] = [];
      let embeddingModel: string | null = null;
      let embeddingDimensions: number | null = null;
      let embeddingHash: string | null = null;
      if (models.embedding) {
        try {
          const embedded = await embedMediaText(libraryDescriptorText(descriptorForIndex), models.embedding);
          embedding = embedded.vector;
          embeddingModel = embedded.model;
          embeddingDimensions = embedded.dimensions;
          embeddingHash = libraryDescriptorHash(descriptorForIndex);
        } catch (embedError) {
          logger.warn({ err: embedError, itemId: item.id }, "Auto-ingest embedding failed; operator publish will re-embed");
        }
      }

      const locator = resolveMediaAssetBlobLocator(asset);
      const actorId = item.batch.createdById ?? asset.ownerId;
      await prisma.characterMediaLibraryEntry.createMany({
        skipDuplicates: true,
        data: [{
          id,
          characterId,
          sourceAssetId: asset.id,
          visualProfileId: visual.id,
          visualProfileVersion: visual.version,
          status: "draft",
          kind: media.kind,
          description: draft.description,
          facts: draft.facts,
          absentFacts: draft.absentFacts,
          nudity: draft.nudity,
          attireLevel: draft.attireLevel,
          nudityVerifiedById: null,
          distributionScope: "chat_library",
          descriptionSource: draft.descriptionSource,
          width: media.width,
          height: media.height,
          durationSeconds: media.durationSeconds,
          hasAudio: media.hasAudio,
          contentType: media.contentType,
          storageKey,
          thumbnailKey,
          contentHash: media.contentHash,
          embedding,
          embeddingModel,
          embeddingDimensions,
          embeddingHash,
          sourceSnapshot: toInputJson({
            characterId,
            assetId: asset.id,
            sourceStorageKey: locator?.key ?? null,
            visualProfileHash: visual.immutableHash,
            autoIngestedFromRunId: item.batch.id,
            autoIngestedFromItemId: item.id,
          }),
          createdById: actorId,
          updatedById: actorId,
        }],
      });
      ingested += 1;
    } catch (error) {
      failed += 1;
      logger.warn({ err: error, itemId: item.id, assetId: asset.id }, "Failed to auto-ingest completed library pack item");
    }
  }

  return { scanned, ingested, skipped, failed };
}
