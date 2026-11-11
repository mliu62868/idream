import type { CharacterVisualProfile, GenerationJob, MediaAsset, Prisma } from "@prisma/client";
import { resolveMediaAssetAuthorityMap } from "@/server/lib/media-asset-authority-query";
import { jsonRecord } from "@/server/modules/ourdream/json-values";
import { isCharacterLibraryOperatorUpload } from "./image-qualification";
import { characterReleaseSnapshotHash, characterVisualProfileSnapshotHash, referenceSetSnapshotHash } from "./release-snapshot";

type FrozenImage = { assetId: string; snapshotId: string; sha256: string };
type VisualIdentity = Pick<CharacterVisualProfile, "id" | "version" | "immutableHash">;
type ReferenceSet = Prisma.ReferenceSetRevisionGetPayload<{ include: { references: true } }>;

/** The caller holds the Character and source image locks and froze the pixels for this Run. */
export async function pinCharacterVideoSourceIdentity(
  tx: Prisma.TransactionClient, source: MediaAsset, frozen: FrozenImage,
) {
  if (!source.characterId || source.id !== frozen.assetId) return null;
  const recordedDigest = jsonRecord(source.metadata).sha256;
  if (typeof recordedDigest === "string" && recordedDigest !== frozen.sha256) return null;

  const item = source.sourceJobId ? await tx.contentProductionItem.findFirst({
    where: {
      mediaAssetId: source.id, jobId: source.sourceJobId,
      status: { in: ["generated", "approved", "published"] },
      batch: { targetType: "character", targetId: source.characterId, lifecycleState: { in: ["active", "closed"] } },
      job: { is: { characterId: source.characterId, status: "completed", mode: "image", sourceType: "content_production_item" } },
    },
    include: { job: { select: { sourceId: true, sourceMeta: true, visualProfileId: true, visualProfileVersion: true } } },
  }) : null;
  const job = item?.job && item.job.sourceId === item.id ? item.job : null;

  let visual: CharacterVisualProfile | null;
  if (job?.visualProfileId && job.visualProfileVersion) {
    // A generated source keeps its original identity, even if a later reference set uses it.
    visual = await tx.characterVisualProfile.findFirst({ where: {
      id: job.visualProfileId, version: job.visualProfileVersion, characterId: source.characterId,
    } });
  } else if (isCharacterLibraryOperatorUpload(source) || jsonRecord(job?.sourceMeta).bootstrapIdentity === true) {
    // Uploads and first portraits have no generation pin. Only a unique sealed
    // production or live Release anchor can establish their identity.
    const candidates: CharacterVisualProfile[] = [];
    const production = await tx.characterVisualProfile.findFirst({
      where: { characterId: source.characterId, status: "active" }, orderBy: { version: "desc" },
    });
    if (production) {
      const references = await tx.referenceSetRevision.findFirst({
        where: { visualProfileId: production.id, status: "active" }, orderBy: { revision: "desc" },
        include: { references: { orderBy: { position: "asc" } } },
      });
      if (isSealedSourceAnchor(production, references, source.id)) candidates.push(production);
    }
    const serving = await tx.characterServing.findUnique({
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
      const live = await tx.characterVisualProfile.findFirst({ where: {
        id: release.visualProfileId, version: release.visualProfileVersion, characterId: source.characterId,
      } });
      // Reference revisions can be superseded in production while remaining
      // frozen in the live Release. Its exact revision grants this authority.
      const references = await tx.referenceSetRevision.findUnique({
        where: { id: release.referenceSetRevisionId }, include: { references: { orderBy: { position: "asc" } } },
      });
      if (live && isSealedSourceAnchor(live, references, source.id)) candidates.push(live);
    }
    const identities = [...new Map(candidates.map(candidate => [candidate.id, candidate])).values()];
    if (identities.length !== 1) return null;
    visual = identities[0]!;
  } else {
    return null;
  }

  if (!visual?.immutableHash || visual.immutableHash !== characterVisualProfileSnapshotHash(visual) ||
    !(await resolveMediaAssetAuthorityMap(tx, [source])).get(source.id)?.publishable) return null;
  return {
    visualProfileId: visual.id, visualProfileVersion: visual.version, visualProfileHash: visual.immutableHash,
    snapshotId: frozen.snapshotId, sourceSha256: frozen.sha256,
  };
}

function isSealedSourceAnchor(visual: CharacterVisualProfile, references: ReferenceSet | null, assetId: string) {
  return visual.immutableHash !== null && visual.immutableHash === characterVisualProfileSnapshotHash(visual) &&
    references?.visualProfileId === visual.id && references.snapshotHash !== null &&
    references.snapshotHash === referenceSetSnapshotHash(references) &&
    references.references.some(reference => reference.mediaAssetId === assetId &&
      ["primary_face", "identity_anchor"].includes(reference.role));
}

export function characterVideoMatchesSourceIdentity(
  job: Pick<GenerationJob, "mode" | "sourceMeta" | "controls">, visual: VisualIdentity,
) {
  const source = jsonRecord(job.sourceMeta);
  const pin = jsonRecord(source.videoSourceIdentity);
  const controls = jsonRecord(job.controls);
  if (job.mode !== "video" || source.purpose !== "character_video" || !visual.immutableHash ||
    pin.visualProfileId !== visual.id || pin.visualProfileVersion !== visual.version || pin.visualProfileHash !== visual.immutableHash ||
    typeof source.videoSourceAssetId !== "string" || controls.sourceImageAssetId !== source.videoSourceAssetId ||
    typeof pin.snapshotId !== "string" || typeof pin.sourceSha256 !== "string" ||
    !Array.isArray(controls.referenceSnapshots) || controls.referenceSnapshots.length !== 1) return false;
  const snapshot = jsonRecord(controls.referenceSnapshots[0]);
  return snapshot.role === "source_image" && snapshot.assetId === source.videoSourceAssetId &&
    snapshot.snapshotId === pin.snapshotId && snapshot.sha256 === pin.sourceSha256;
}
