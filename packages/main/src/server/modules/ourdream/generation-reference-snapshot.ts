import type { Prisma } from "@prisma/client";
import { generationReferenceRequests, imageReferenceInputsForGenerationJob } from "@/server/ai/reference-images";
import { Errors } from "@/server/lib/errors";
import { assertGenerationSourceImageAuthority } from "./generation-job-authority";
import { freezeGenerationSource, withGenerationSnapshotSlot, type FrozenGenerationSource } from "./generation-source-snapshot";
import { jsonRecord, jsonStringArray, stringFromRecord } from "./json-values";
import { prisma } from "@/server/lib/db";

export async function preflightGenerationReferences(input: {
  userId: string; characterId: string | null; controls: Record<string, unknown>;
  referenceManifest: Prisma.JsonValue; authorizedSourceImageAssetId?: string;
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
        verifyImagePixels: true,
        authorizedComicSourceMediaId: reference.role === "source_image" ? input.authorizedSourceImageAssetId : undefined,
      });
      if (!verified) throw new Error("Verified reference image bytes are missing");
      if (Date.now() >= deadline) throw Errors.unavailable("Reference image verification timed out. Please try again.");
      total += verified.bytes.byteLength;
      if (total > 64 * 1024 * 1024) throw Errors.conflict("The selected reference images are too large together. Choose smaller images.");
      verifiedIds.add(reference.assetId);
    }
  });
}

export async function freezeGenerationReferences(tx: Prisma.TransactionClient, input: {
  userId: string; characterId: string | null; controls: Record<string, unknown>;
  referenceAssetIds?: Prisma.JsonValue | null; referenceManifest?: Prisma.JsonValue | null;
  authorizedSourceImageAssetId?: string; reuse?: { assetId: string; snapshot: FrozenGenerationSource };
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
      if (total > 64 * 1024 * 1024) throw Errors.conflict("The selected reference images are too large together. Choose smaller images.");
      snapshots.set(reference.assetId, await freezeGenerationSource(tx, { userId: input.userId, ...verified }));
    }
    return references.map(reference => {
      const snapshot = snapshots.get(reference.assetId)!;
      return { assetId: reference.assetId, role: reference.role, snapshotId: snapshot.id, sha256: snapshot.sha256, sizeBytes: snapshot.sizeBytes, contentType: snapshot.contentType };
    });
  });
}
