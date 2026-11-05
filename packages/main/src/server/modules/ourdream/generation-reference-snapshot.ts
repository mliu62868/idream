import type { Prisma } from "@prisma/client";
import { generationReferenceRequests, imageReferenceInputsForGenerationJob } from "@/server/ai/reference-images";
import { Errors } from "@/server/lib/errors";
import { assertGenerationSourceImageAuthority } from "./generation-job-authority";
import { freezeGenerationSource, generationSourceLocator, withGenerationSnapshotSlot, type FrozenGenerationSource, type PrefrozenGenerationSource } from "./generation-source-snapshot";
import { jsonRecord, jsonStringArray, stringFromRecord } from "./json-values";
import { prisma } from "@/server/lib/db";

export async function preflightGenerationReferences(input: {
  userId: string; characterId: string | null; controls: Record<string, unknown>;
  referenceManifest: Prisma.JsonValue; authorizedSourceImageAssetId?: string;
  /** The confirmation authority already froze this exact source. ACL still revalidates. */
  frozenSourceAssetId?: string;
}) {
  const references = await imageReferenceInputsForGenerationJob({ ...input, maxReferences: Number.MAX_SAFE_INTEGER, db: prisma });
  const expected = generationReferenceRequests({
    sourceImageAssetId: stringFromRecord(input.controls, "sourceImageAssetId"),
    lookReferenceAssetId: stringFromRecord(input.controls, "lookReferenceAssetId"),
    anchorAssetIds: [], identityReferenceIds: [], jobReferenceIds: [],
    referenceManifest: input.referenceManifest, maxReferences: Number.MAX_SAFE_INTEGER,
  });
  if (references.length !== expected.length || expected.some((item, index) => references[index]?.assetId !== item.mediaAssetId || references[index]?.role !== item.role)) throw Errors.conflict("One or more reference images are unavailable. Choose available images and try again.");
  if (!references.length) return;
  await withGenerationSnapshotSlot(async () => {
    const verifiedIds = new Set<string>();
    let total = 0;
    const deadline = Date.now() + 30_000;
    for (const reference of references) {
      if (verifiedIds.has(reference.assetId)) continue;
      if (Date.now() >= deadline) throw Errors.unavailable("Reference image verification timed out. Please try again.");
      const verified = await assertGenerationSourceImageAuthority(prisma, {
        sourceImageAssetId: reference.assetId, userId: input.userId, characterId: input.characterId,
        verifyImagePixels: reference.assetId !== input.frozenSourceAssetId,
        authorizedComicSourceMediaId: reference.role === "source_image" ? input.authorizedSourceImageAssetId : undefined,
      });
      if (reference.assetId === input.frozenSourceAssetId) { verifiedIds.add(reference.assetId); continue; }
      if (!verified) throw new Error("Verified reference image bytes are missing");
      if (Date.now() >= deadline) throw Errors.unavailable("Reference image verification timed out. Please try again.");
      total += verified.bytes.byteLength;
      if (total > 64 * 1024 * 1024) throw Errors.conflict("The selected reference images are too large together. Choose smaller images.");
      verifiedIds.add(reference.assetId);
    }
  });
}

const MAX_FROZEN_REFERENCE_BYTES = 64 * 1024 * 1024;
// How long an admission may queue for a slot. It holds no locks while it does, and
// sources are read in seconds, so a short burst no longer surfaces as a 503.
const PREFREEZE_SLOT_WAIT_MS = 15_000;

const sourceChangedDuringAdmission = (assetId: string) => Errors.conflict(
  "A source image changed while this request was being prepared. Please try again.",
  { sourceImageAssetId: assetId },
);

/**
 * SPEC: read, verify and commit the content-addressed snapshot of every source an
 * admission will pin, before its transaction opens. What used to happen under the
 * locks is split in two: the slow half (Blob read, decode, chunk writes) here, and
 * the check that the result still holds in assertPrefrozenGenerationSource.
 * INTENT: the transaction holds the per-Character advisory lock, shared by everyone
 * generating with a public Character. Holding it through a Blob read made each of
 * those users wait on one user's I/O, and a process could only do two at a time.
 * INVARIANT: never call with an authority transaction open. A snapshot that ends up
 * unpinned, because admission lost a race, is harmless: it is the owner's own bytes,
 * unreachable without a pin, and deduplicated by content.
 */
export async function prefreezeGenerationSources(input: {
  userId: string; characterId: string | null;
  assets: readonly { assetId: string; authorizedComicSourceMediaId?: string }[];
  /** Scenes of one sequence share these, so one source is decoded once per write. */
  known?: Map<string, PrefrozenGenerationSource>;
}): Promise<ReadonlyMap<string, PrefrozenGenerationSource>> {
  const frozen = input.known ?? new Map<string, PrefrozenGenerationSource>();
  const pending = input.assets.filter((asset, index) =>
    !frozen.has(asset.assetId) && input.assets.findIndex(other => other.assetId === asset.assetId) === index);
  if (!pending.length) return frozen;
  await withGenerationSnapshotSlot(async () => {
    let total = 0;
    const deadline = Date.now() + 30_000;
    for (const { assetId, authorizedComicSourceMediaId } of pending) {
      if (Date.now() >= deadline) throw Errors.unavailable("Reference image verification timed out. Please try again.");
      const verified = await assertGenerationSourceImageAuthority(prisma, {
        sourceImageAssetId: assetId, userId: input.userId, characterId: input.characterId,
        verifyImagePixels: true, authorizedComicSourceMediaId,
      });
      if (!verified) throw new Error("Verified generation source bytes are missing");
      total += verified.bytes.byteLength;
      if (total > MAX_FROZEN_REFERENCE_BYTES) throw Errors.conflict("The selected reference images are too large together. Choose smaller images.");
      const snapshot = await prisma.$transaction(tx => freezeGenerationSource(tx, {
        userId: input.userId, bytes: verified.bytes, contentType: verified.contentType,
      }), { timeout: 30_000 });
      frozen.set(assetId, {
        id: snapshot.id, sha256: snapshot.sha256, sizeBytes: snapshot.sizeBytes, contentType: snapshot.contentType,
        assetId, locator: verified.sourceLocator, width: verified.width, height: verified.height, pages: verified.pages,
      });
    }
  }, { waitMs: PREFREEZE_SLOT_WAIT_MS });
  return frozen;
}

/**
 * SPEC: inside the authority transaction, prove a prefrozen snapshot is still what
 * the old under-lock read would have produced, with no Blob I/O.
 * INVARIANT: exact (the asset row still has the locator its bytes were read through,
 * and media writers change that row under the lock held here), owner-authorized (the
 * row belongs to this user, so an erased account fails here), and pinned by the caller.
 * Authority over the asset itself is the caller's assertGenerationSourceImageAuthority.
 */
export async function assertPrefrozenGenerationSource(
  tx: Prisma.TransactionClient,
  input: { userId: string; prefrozen: PrefrozenGenerationSource },
) {
  const { userId, prefrozen } = input;
  const asset = await tx.mediaAsset.findUnique({ where: { id: prefrozen.assetId }, select: { storageKey: true, url: true } });
  const stored = await tx.generationSourceSnapshot.findFirst({
    where: { id: prefrozen.id, userId, sha256: prefrozen.sha256, sizeBytes: prefrozen.sizeBytes, contentType: prefrozen.contentType },
    select: { id: true },
  });
  if (!asset || !stored || generationSourceLocator(asset) !== prefrozen.locator) throw sourceChangedDuringAdmission(prefrozen.assetId);
}

export async function freezeGenerationReferences(tx: Prisma.TransactionClient, input: {
  userId: string; characterId: string | null; controls: Record<string, unknown>;
  referenceAssetIds?: Prisma.JsonValue | null; referenceManifest?: Prisma.JsonValue | null;
  authorizedSourceImageAssetId?: string; reuse?: { assetId: string; snapshot: FrozenGenerationSource };
  /** When present this call performs no Blob I/O; a source missing here is a conflict. */
  prefrozen?: ReadonlyMap<string, PrefrozenGenerationSource>;
}) {
  const references = await imageReferenceInputsForGenerationJob({ ...input, maxReferences: Number.MAX_SAFE_INTEGER, db: tx });
  const identity = jsonRecord(input.controls.visualIdentity);
  const expected = generationReferenceRequests({
    sourceImageAssetId: stringFromRecord(input.controls, "sourceImageAssetId"),
    lookReferenceAssetId: stringFromRecord(input.controls, "lookReferenceAssetId"),
    anchorAssetIds: jsonStringArray(identity.anchorAssetIds),
    identityReferenceIds: jsonStringArray(identity.referenceAssetIds),
    jobReferenceIds: jsonStringArray(input.referenceAssetIds),
    referenceManifest: input.referenceManifest, maxReferences: Number.MAX_SAFE_INTEGER,
  });
  if (references.length !== expected.length || expected.some((item, index) => references[index]?.assetId !== item.mediaAssetId || references[index]?.role !== item.role)) throw Errors.conflict("One or more reference images are unavailable. Choose available images and try again.");
  if (!references.length) return [];
  const snapshots = new Map<string, FrozenGenerationSource>();
  if (input.reuse) snapshots.set(input.reuse.assetId, input.reuse.snapshot);
  let total = input.reuse?.snapshot.sizeBytes ?? 0;
  const pinned = () => references.map(reference => {
    const snapshot = snapshots.get(reference.assetId)!;
    return { assetId: reference.assetId, role: reference.role, snapshotId: snapshot.id, sha256: snapshot.sha256, sizeBytes: snapshot.sizeBytes, contentType: snapshot.contentType };
  });
  if (input.prefrozen) {
    for (const reference of references) {
      if (snapshots.has(reference.assetId)) continue;
      await assertGenerationSourceImageAuthority(tx, {
        sourceImageAssetId: reference.assetId, userId: input.userId, characterId: input.characterId,
        authorizedComicSourceMediaId: reference.role === "source_image" ? input.authorizedSourceImageAssetId : undefined,
      });
      // The reference set changed after the unlocked read chose what to freeze. Asking
      // the owner to retry is what keeps Blob I/O out of this transaction.
      const prefrozen = input.prefrozen.get(reference.assetId);
      if (!prefrozen) throw sourceChangedDuringAdmission(reference.assetId);
      await assertPrefrozenGenerationSource(tx, { userId: input.userId, prefrozen });
      total += prefrozen.sizeBytes;
      if (total > MAX_FROZEN_REFERENCE_BYTES) throw Errors.conflict("The selected reference images are too large together. Choose smaller images.");
      snapshots.set(reference.assetId, prefrozen);
    }
    return pinned();
  }
  return withGenerationSnapshotSlot(async () => {
    for (const reference of references) {
      if (snapshots.has(reference.assetId)) continue;
      const verified = await assertGenerationSourceImageAuthority(tx, {
        sourceImageAssetId: reference.assetId, userId: input.userId, characterId: input.characterId,
        verifyImagePixels: true,
        authorizedComicSourceMediaId: reference.role === "source_image" ? input.authorizedSourceImageAssetId : undefined,
      });
      if (!verified) throw new Error("Verified reference image bytes are missing");
      total += verified.bytes.byteLength;
      if (total > MAX_FROZEN_REFERENCE_BYTES) throw Errors.conflict("The selected reference images are too large together. Choose smaller images.");
      snapshots.set(reference.assetId, await freezeGenerationSource(tx, { userId: input.userId, ...verified }));
    }
    return pinned();
  });
}
