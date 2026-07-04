import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import type { Prisma } from "@prisma/client";
import type { ImageGeneratePayload } from "@idream/shared/contracts";
import { resolveLocalBlobPath } from "@idream/shared/storage/local-blob";
import { prisma } from "@/server/lib/db";

export type ImageReferenceInput = NonNullable<ImageGeneratePayload["referenceImages"]>[number];

type ReferenceBlobStore = {
  signGetUrl(input: { key: string; expiresInSeconds: number }): Promise<
    | { ok: true; data: { url: string } }
    | { ok: false; error: { code: string; message: string; retryable: boolean } }
  >;
};

export async function imageReferenceInputsForGenerationJob(input: {
  userId: string;
  characterId: string | null;
  controls: Prisma.JsonValue | Record<string, unknown>;
  referenceAssetIds?: Prisma.JsonValue | null;
  maxReferences?: number;
}): Promise<ImageReferenceInput[]> {
  const controls = jsonRecord(input.controls);
  const visualIdentity = jsonRecord(controls.visualIdentity);
  const consistencyMode = consistencyModeFromControls(controls, visualIdentity);
  const sourceImageAssetId = stringFromRecord(controls, "sourceImageAssetId");
  const anchorAssetIds = jsonStringArray(visualIdentity.anchorAssetIds);
  const identityReferenceIds = jsonStringArray(visualIdentity.referenceAssetIds);
  const jobReferenceIds = jsonStringArray(input.referenceAssetIds);
  const orderedIds = uniqueStrings([
    sourceImageAssetId,
    ...anchorAssetIds,
    ...identityReferenceIds,
    ...jobReferenceIds,
  ]).slice(0, input.maxReferences ?? 4);
  if (orderedIds.length === 0) return [];

  const assets = await prisma.mediaAsset.findMany({
    where: {
      id: { in: orderedIds },
      type: "image",
      deletedAt: null,
      OR: [
        { ownerId: input.userId },
        ...(input.characterId ? [{ characterId: input.characterId }] : []),
      ],
    },
    select: {
      id: true,
      storageKey: true,
      url: true,
      contentType: true,
      width: true,
      height: true,
    },
  });
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  return orderedIds.flatMap((assetId) => {
    const asset = byId.get(assetId);
    if (!asset) return [];
    const role = referenceRole({
      assetId,
      sourceImageAssetId,
      anchorAssetIds,
      identityReferenceIds,
    });
    return [
      {
        assetId,
        role,
        weight: referenceWeight(role, consistencyMode),
        ...(asset.storageKey ? { storageKey: asset.storageKey } : {}),
        ...(asset.url ? { url: asset.url } : {}),
        ...(asset.contentType ? { contentType: asset.contentType } : {}),
        ...(asset.width ? { width: asset.width } : {}),
        ...(asset.height ? { height: asset.height } : {}),
      },
    ];
  });
}

export async function hydratedImageReferenceInputs(
  images: ImageReferenceInput[] | undefined,
  blob: ReferenceBlobStore,
): Promise<ImageReferenceInput[]> {
  const hydrated = await Promise.all(
    (images ?? []).map(async (image) => {
      if (image.b64Json || isAbsoluteUrl(image.url)) return image;
      if (!image.storageKey) return image;
      const local = await localBlobReference(image);
      if (local) return local;
      const signed = await blob.signGetUrl({
        key: image.storageKey,
        expiresInSeconds: 60 * 15,
      });
      if (signed.ok) return { ...image, url: signed.data.url };
      return image;
    }),
  );
  return hydrated.filter((image) => image.b64Json || isAbsoluteUrl(image.url));
}

function referenceRole(input: {
  assetId: string;
  sourceImageAssetId?: string;
  anchorAssetIds: string[];
  identityReferenceIds: string[];
}): ImageReferenceInput["role"] {
  if (input.assetId === input.sourceImageAssetId) return "source_image";
  if (input.anchorAssetIds.includes(input.assetId)) return "identity_anchor";
  if (input.identityReferenceIds.includes(input.assetId)) return "identity_reference";
  return "identity_reference";
}

function referenceWeight(
  role: ImageReferenceInput["role"],
  mode: "balanced" | "strict" | "creative",
) {
  if (role === "source_image") {
    if (mode === "creative") return 0.7;
    if (mode === "strict") return 0.9;
    return 0.8;
  }
  if (role === "identity_anchor") {
    if (mode === "creative") return 0.65;
    if (mode === "strict") return 1.25;
    return 1;
  }
  if (mode === "creative") return 0.45;
  if (mode === "strict") return 0.95;
  return 0.75;
}

async function localBlobReference(image: ImageReferenceInput) {
  if (!image.storageKey) return null;
  try {
    const bytes = await readFile(resolveLocalBlobPath(image.storageKey));
    return {
      ...image,
      b64Json: Buffer.from(bytes).toString("base64"),
    };
  } catch {
    return null;
  }
}

function consistencyModeFromControls(
  controls: Record<string, unknown>,
  visualIdentity: Record<string, unknown>,
) {
  const mode =
    stringFromRecord(controls, "consistencyMode") ??
    stringFromRecord(visualIdentity, "consistencyMode");
  if (mode === "strict" || mode === "creative") return mode;
  return "balanced";
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function jsonStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function stringFromRecord(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function uniqueStrings(values: Array<string | undefined>) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function isAbsoluteUrl(value: string | undefined) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
