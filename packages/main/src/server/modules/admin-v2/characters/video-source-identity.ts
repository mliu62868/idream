import type { CharacterVisualProfile, GenerationJob, MediaAsset, Prisma } from "@prisma/client";
import { resolveGenerationAssetSuccessAttempts } from "@/server/ai/generation-asset-success-authority";
import { hasHydratableMediaBlobAuthority, isMediaAssetOperationalForAuthority } from "@/server/lib/media-asset-authority";
import { resolveMediaAssetAuthorityMap } from "@/server/lib/media-asset-authority-query";
import { GENERATION_SOURCE_MAX_BYTES, matchesFrozenGenerationSource } from "@/server/modules/ourdream/generation-source-snapshot";
import { jsonRecord } from "@/server/modules/ourdream/json-values";
import { isCharacterLibraryOperatorUpload } from "./image-qualification";
import { characterReleaseSnapshotHash, characterVisualProfileSnapshotHash, referenceSetSnapshotHash } from "./release-snapshot";

type FrozenImage = { assetId: string; snapshotId: string; sha256: string };
type VisualIdentity = Pick<CharacterVisualProfile, "id" | "version" | "immutableHash">;
type ReferenceSet = Prisma.ReferenceSetRevisionGetPayload<{ include: { references: true } }>;

/** Admission holds the Character and source image locks. Historical reads recheck under the same locks before publication. */
export async function pinCharacterVideoSourceIdentity(
  db: Prisma.TransactionClient, source: MediaAsset, frozen: FrozenImage, admittedAt?: Date,
) {
  if (!source.characterId || source.id !== frozen.assetId || source.type !== "image" || source.deletedAt ||
    source.safetyStatus !== "passed" || !isMediaAssetOperationalForAuthority(source.metadata) ||
    !hasHydratableMediaBlobAuthority(source) || (admittedAt && source.createdAt > admittedAt)) return null;
  const recordedDigest = jsonRecord(source.metadata).sha256;
  if (recordedDigest !== undefined && recordedDigest !== frozen.sha256) return null;

  const item = source.sourceJobId ? await db.contentProductionItem.findFirst({
    where: {
      mediaAssetId: source.id, jobId: source.sourceJobId,
      status: { in: ["generated", "approved", "published"] },
      batch: { targetType: "character", targetId: source.characterId, lifecycleState: { in: ["active", "closed"] } },
      job: { is: { characterId: source.characterId, status: "completed", mode: "image", sourceType: "content_production_item",
        ...(admittedAt ? { completedAt: { lte: admittedAt } } : {}) } },
    },
    include: { job: true },
  }) : null;
  const job = item?.job && item.job.sourceId === item.id ? item.job : null;
  if (job && (job.visualProfileId === null) !== (job.visualProfileVersion === null)) return null;

  let visual: CharacterVisualProfile | null;
  if (job && job.visualProfileId !== null && job.visualProfileVersion !== null) {
    // A generated source keeps its original identity, even if a later reference set uses it.
    visual = await db.characterVisualProfile.findFirst({ where: {
      id: job.visualProfileId, version: job.visualProfileVersion, characterId: source.characterId,
      ...(admittedAt ? { createdAt: { lte: admittedAt } } : {}),
    } });
  } else if (isCharacterLibraryOperatorUpload(source) || jsonRecord(job?.sourceMeta).bootstrapIdentity === true) {
    // Uploads and first portraits have no generation pin. Only a unique sealed
    // production or live Release anchor can establish their identity.
    const candidates: CharacterVisualProfile[] = [];
    const production = await db.characterVisualProfile.findFirst({
      where: { characterId: source.characterId, status: "active" }, orderBy: { version: "desc" },
    });
    if (production) {
      const references = await db.referenceSetRevision.findFirst({
        where: { visualProfileId: production.id, ...(admittedAt
          ? { createdAt: { lte: admittedAt }, availableAtSnapshot: { lte: admittedAt }, status: { in: ["active", "superseded"] } }
          : { status: "active" }) },
        orderBy: { revision: "desc" },
        include: { references: { orderBy: { position: "asc" } } },
      });
      if (isSealedSourceAnchor(production, references, source.id, admittedAt)) candidates.push(production);
    }
    const serving = await db.characterServing.findUnique({
      where: { characterId: source.characterId },
      include: { currentRelease: true, character: { select: { visibility: true, status: true, deletedAt: true } } },
    });
    const release = serving?.currentRelease;
    if (serving?.state === "live" && !serving.character.deletedAt && serving.character.status === "approved" &&
      ["public", "unlisted"].includes(serving.character.visibility) && release?.status === "published" &&
      release.visualProfileId && release.visualProfileVersion && release.referenceSetRevisionId &&
      release.snapshotHash === characterReleaseSnapshotHash({
        projectId: release.projectId, revisionId: release.revisionId, characterContentVersionId: release.characterContentVersionId,
        visualProfileId: release.visualProfileId, visualProfileVersion: release.visualProfileVersion,
        referenceSetRevisionId: release.referenceSetRevisionId,
        generationProvenance: release.generationProvenance, releasePlacementManifest: release.releasePlacementManifest,
      })) {
      const live = await db.characterVisualProfile.findFirst({ where: {
        id: release.visualProfileId, version: release.visualProfileVersion, characterId: source.characterId,
      } });
      // Reference revisions can be superseded in production while remaining
      // frozen in the live Release. Its exact revision grants this authority.
      const references = await db.referenceSetRevision.findUnique({
        where: { id: release.referenceSetRevisionId }, include: { references: { orderBy: { position: "asc" } } },
      });
      if (live && isSealedSourceAnchor(live, references, source.id, admittedAt)) candidates.push(live);
    }
    const identities = [...new Map(candidates.map(candidate => [candidate.id, candidate])).values()];
    if (identities.length !== 1) return null;
    visual = identities[0]!;
    if (admittedAt && await hasOtherHistoricalAnchor(db, source.id, visual, admittedAt)) return null;
  } else {
    return null;
  }

  if (!visual?.immutableHash || visual.immutableHash !== characterVisualProfileSnapshotHash(visual) ||
    !(await resolveMediaAssetAuthorityMap(db, [source])).get(source.id)?.publishable ||
    (admittedAt && job && !(await hasCompletedMediaDelivery(db, source, job)))) return null;
  return {
    visualProfileId: visual.id, visualProfileVersion: visual.version, visualProfileHash: visual.immutableHash,
    snapshotId: frozen.snapshotId, sourceSha256: frozen.sha256,
  };
}

function isSealedSourceAnchor(visual: CharacterVisualProfile, references: ReferenceSet | null, assetId: string, admittedAt?: Date) {
  return visual.immutableHash !== null && visual.immutableHash === characterVisualProfileSnapshotHash(visual) &&
    references?.visualProfileId === visual.id && references.snapshotHash !== null &&
    (!admittedAt || (visual.createdAt <= admittedAt && references.createdAt <= admittedAt && references.availableAtSnapshot <= admittedAt)) &&
    references.snapshotHash === referenceSetSnapshotHash(references) &&
    references.references.some(reference => reference.mediaAssetId === assetId && (!admittedAt || reference.createdAt <= admittedAt) &&
      ["primary_face", "identity_anchor"].includes(reference.role));
}

async function hasOtherHistoricalAnchor(
  db: Prisma.TransactionClient, assetId: string, visual: CharacterVisualProfile, admittedAt: Date,
) {
  // A superseded reference can prove ambiguity even after the active and live
  // identities changed. Later seals cannot change the provenance of an older clip.
  const alternatives = await db.referenceSetRevision.findMany({
    where: {
      visualProfileId: { not: visual.id }, visualProfile: { characterId: visual.characterId },
      createdAt: { lte: admittedAt }, availableAtSnapshot: { lte: admittedAt },
      references: { some: { mediaAssetId: assetId, role: { in: ["primary_face", "identity_anchor"] } } },
    },
    include: { visualProfile: true, references: { orderBy: { position: "asc" } } },
  });
  return alternatives.some(reference => isSealedSourceAnchor(reference.visualProfile, reference, assetId, admittedAt));
}

export async function matchCharacterVideoSourceIdentity(
  db: Prisma.TransactionClient, job: GenerationJob, asset: MediaAsset, visual: VisualIdentity,
  lockedLegacySourceAssetId?: string | null,
) {
  const meta = jsonRecord(job.sourceMeta);
  const controls = jsonRecord(job.controls);
  const assetId = meta.videoSourceAssetId;
  if (job.mode !== "video" || meta.purpose !== "character_video" || !visual.immutableHash ||
    typeof assetId !== "string" || !assetId || controls.sourceImageAssetId !== assetId ||
    !Array.isArray(controls.referenceSnapshots) || controls.referenceSnapshots.length !== 1) return null;
  const snapshot = jsonRecord(controls.referenceSnapshots[0]);
  if (snapshot.role !== "source_image" || snapshot.assetId !== assetId || typeof snapshot.snapshotId !== "string" ||
    !snapshot.snapshotId || typeof snapshot.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.sha256)) return null;

  const hasPin = Object.hasOwn(meta, "videoSourceIdentity");
  if (hasPin) {
    const pin = jsonRecord(meta.videoSourceIdentity);
    if (pin.visualProfileId !== visual.id || pin.visualProfileVersion !== visual.version ||
      pin.visualProfileHash !== visual.immutableHash || pin.snapshotId !== snapshot.snapshotId ||
      pin.sourceSha256 !== snapshot.sha256) return null;
  } else if (job.visualProfileId !== null || job.visualProfileVersion !== null ||
    (lockedLegacySourceAssetId !== undefined && lockedLegacySourceAssetId !== assetId)) {
    return null;
  }
  const stored = await db.generationSourceSnapshot.findFirst({
    where: { id: snapshot.snapshotId, userId: job.userId, createdAt: { lte: job.createdAt } },
    select: { id: true, sha256: true, contentType: true, sizeBytes: true },
  });
  if (!stored || stored.sizeBytes <= 0 || stored.sizeBytes > GENERATION_SOURCE_MAX_BYTES ||
    !stored.contentType.startsWith("image/") || !matchesFrozenGenerationSource(snapshot, stored)) return null;
  if (hasPin) return { legacySourceAssetId: null };

  // Old native I2V jobs recorded the exact frozen pixels, but no visual pin.
  // Require the original Run and delivery evidence before deriving an identity.
  if (job.referenceAssetIds !== null && (!Array.isArray(job.referenceAssetIds) ||
    job.referenceAssetIds.length !== 1 || job.referenceAssetIds[0] !== assetId)) return null;
  if (job.referenceManifest !== null) {
    if (!Array.isArray(job.referenceManifest) || job.referenceManifest.length !== 1) return null;
    const entry = jsonRecord(job.referenceManifest[0]);
    if (entry.mediaAssetId !== assetId || entry.role !== "source_image") return null;
  }
  const source = await db.mediaAsset.findFirst({ where: { id: assetId, characterId: job.characterId } });
  if (!source || !(await hasCompletedMediaDelivery(db, asset, job))) return null;
  const pin = await pinCharacterVideoSourceIdentity(db, source, { assetId, snapshotId: stored.id, sha256: stored.sha256 }, job.createdAt);
  return pin?.visualProfileId === visual.id && pin.visualProfileVersion === visual.version &&
    pin.visualProfileHash === visual.immutableHash ? { legacySourceAssetId: assetId } : null;
}

async function hasCompletedMediaDelivery(db: Prisma.TransactionClient, asset: MediaAsset, job: GenerationJob) {
  if (job.status !== "completed" || !job.completedAt || job.deliveredOutputCount < 1 || asset.ownerId !== job.userId) return false;
  const artifacts = await db.generationArtifact.findMany({
    where: { assetId: asset.id, validationState: "valid", archiveState: "active" }, take: 2,
  });
  if (artifacts.length !== 1) return false;
  const artifact = artifacts[0]!;
  const attempt = await db.generationAttempt.findFirst({ where: { id: artifact.attemptId, requestId: job.id, provider: job.provider } });
  const delivery = await db.generationDelivery.findFirst({ where: {
    artifactId: artifact.id, requestId: job.id, targetType: "user_library", targetId: job.userId,
    status: "delivered", deliveredAt: { not: null },
  }, select: { id: true } });
  if (!attempt || !delivery) return false;
  if (attempt.status === "succeeded") return true;
  return attempt.status === "unknown" &&
    (await resolveGenerationAssetSuccessAttempts(db, [asset])).get(asset.id)?.id === attempt.id;
}
