import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import type { Prisma } from "@prisma/client";
import type { ImageGeneratePayload } from "@idream/shared/contracts";
import { resolveLocalBlobPath } from "@idream/shared/storage/local-blob";
import { prisma } from "@/server/lib/db";
import {
  hasHydratableMediaBlobAuthority,
  isMediaAssetOperationalForAuthority,
  resolveMediaAssetBlobLocator,
} from "@/server/lib/media-asset-authority";

export type ImageReferenceInput = NonNullable<ImageGeneratePayload["referenceImages"]>[number];

type ReferenceBlobStore = {
  signGetUrl(input: { key: string; expiresInSeconds: number }): Promise<
    | { ok: true; data: { url: string } }
    | { ok: false; error: { code: string; message: string; retryable: boolean } }
  >;
};

type GenerationReferenceRequest = {
  readonly mediaAssetId: string;
  readonly role: ImageReferenceInput["role"];
  readonly weight?: number;
  readonly selectorVersion?: string;
  readonly selectionReason?: string;
  readonly qualityScore?: number;
  readonly identityScore?: number;
};

export function generationReferenceRequests(input: {
  readonly sourceImageAssetId?: string;
  readonly lookReferenceAssetId?: string;
  readonly anchorAssetIds: readonly string[];
  readonly identityReferenceIds: readonly string[];
  readonly jobReferenceIds: readonly string[];
  readonly referenceManifest?: unknown;
  readonly maxReferences: number;
}): GenerationReferenceRequest[] {
  const manifest = referenceManifestItems(input.referenceManifest);
  const manifestHasRequestedSource = Boolean(
    input.sourceImageAssetId &&
    manifest.some((item) =>
      item.mediaAssetId === input.sourceImageAssetId &&
      item.role === "source_image"
    ),
  );
  const manifestHasRequestedLook = Boolean(
    input.lookReferenceAssetId &&
    manifest.some((item) =>
      item.mediaAssetId === input.lookReferenceAssetId &&
      item.role === "look_reference"
    ),
  );
  return (
    manifest.length > 0
      ? [
          ...(input.sourceImageAssetId && !manifestHasRequestedSource
            ? [{
                mediaAssetId: input.sourceImageAssetId,
                role: "source_image" as const,
              }]
            : []),
          ...(input.lookReferenceAssetId && !manifestHasRequestedLook
            ? [{
                mediaAssetId: input.lookReferenceAssetId,
                role: "look_reference" as const,
              }]
            : []),
          ...manifest,
        ]
      : uniqueReferenceRequests([
          ...(input.sourceImageAssetId
            ? [{
                mediaAssetId: input.sourceImageAssetId,
                role: "source_image" as const,
              }]
            : []),
          ...(input.lookReferenceAssetId
            ? [{
                mediaAssetId: input.lookReferenceAssetId,
                role: "look_reference" as const,
              }]
            : []),
          ...input.anchorAssetIds.map((mediaAssetId) => ({
            mediaAssetId,
            role: "identity_anchor" as const,
          })),
          ...input.identityReferenceIds.map((mediaAssetId) => ({
            mediaAssetId,
            role: "identity_reference" as const,
          })),
          ...input.jobReferenceIds.map((mediaAssetId) => ({
            mediaAssetId,
            role: referenceRole({
              assetId: mediaAssetId,
              sourceImageAssetId: input.sourceImageAssetId,
              anchorAssetIds: [...input.anchorAssetIds],
              identityReferenceIds: [...input.identityReferenceIds],
            }),
          })),
        ])
  ).slice(0, input.maxReferences);
}

export async function imageReferenceInputsForGenerationJob(input: {
  userId: string;
  characterId: string | null;
  controls: Prisma.JsonValue | Record<string, unknown>;
  referenceAssetIds?: Prisma.JsonValue | null;
  referenceManifest?: Prisma.JsonValue | null;
  maxReferences?: number;
  db?: Pick<Prisma.TransactionClient, "mediaAsset"> | typeof prisma;
}): Promise<ImageReferenceInput[]> {
  const controls = jsonRecord(input.controls);
  const visualIdentity = jsonRecord(controls.visualIdentity);
  const consistencyMode = consistencyModeFromControls(controls, visualIdentity);
  const sourceImageAssetId = stringFromRecord(controls, "sourceImageAssetId");
  const lookReferenceAssetId = stringFromRecord(
    controls,
    "lookReferenceAssetId",
  );
  const anchorAssetIds = jsonStringArray(visualIdentity.anchorAssetIds);
  const identityReferenceIds = jsonStringArray(visualIdentity.referenceAssetIds);
  const jobReferenceIds = jsonStringArray(input.referenceAssetIds);
  const orderedReferences = generationReferenceRequests({
    sourceImageAssetId,
    lookReferenceAssetId,
    anchorAssetIds,
    identityReferenceIds,
    jobReferenceIds,
    referenceManifest: input.referenceManifest,
    maxReferences: input.maxReferences ?? 4,
  });
  if (orderedReferences.length === 0) return [];
  const orderedAssetIds = uniqueStrings(
    orderedReferences.map((reference) => reference.mediaAssetId),
  );

  const assets = await (input.db ?? prisma).mediaAsset.findMany({
    where: {
      id: { in: orderedAssetIds },
      type: "image",
      deletedAt: null,
      safetyStatus: "passed",
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
      metadata: true,
    },
  });
  const byId = new Map(
    assets
      .filter((asset) =>
        isMediaAssetOperationalForAuthority(asset.metadata) &&
        hasHydratableMediaBlobAuthority(asset)
      )
      .map((asset) => [asset.id, asset]),
  );
  return orderedReferences.flatMap((reference) => {
    const asset = byId.get(reference.mediaAssetId);
    if (!asset) return [];
    const role = reference.role;
    const blobLocator = resolveMediaAssetBlobLocator(asset);
    return [
      {
        assetId: reference.mediaAssetId,
        role,
        weight: reference.weight ?? referenceWeight(role, consistencyMode),
        ...(reference.selectorVersion ? { selectorVersion: reference.selectorVersion } : {}),
        ...(reference.selectionReason ? { selectionReason: reference.selectionReason } : {}),
        ...(reference.qualityScore !== undefined ? { qualityScore: reference.qualityScore } : {}),
        ...(reference.identityScore !== undefined ? { identityScore: reference.identityScore } : {}),
        ...(blobLocator ? { storageKey: blobLocator.key } : {}),
        ...(asset.url ? { url: asset.url } : {}),
        ...(asset.contentType ? { contentType: asset.contentType } : {}),
        ...(asset.width ? { width: asset.width } : {}),
        ...(asset.height ? { height: asset.height } : {}),
      },
    ];
  });
}

function referenceManifestItems(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = jsonRecord(item);
    const mediaAssetId = stringFromRecord(record, "mediaAssetId");
    if (!mediaAssetId) return [];
    const rawRole = stringFromRecord(record, "role");
    const role: ImageReferenceInput["role"] =
      rawRole === "primary_face" || rawRole === "identity_anchor"
        ? "identity_anchor"
        : rawRole === "look_reference"
          ? "look_reference"
        : rawRole === "source_image"
          ? "source_image"
          : "identity_reference";
    const weight = numberFromRecord(record, "weight");
    const qualityScore = numberFromRecord(record, "qualityScore");
    const identityScore = numberFromRecord(record, "identityScore");
    return [{
      mediaAssetId,
      role,
      ...(weight !== undefined ? { weight } : {}),
      selectorVersion: stringFromRecord(record, "selectorVersion"),
      selectionReason: stringFromRecord(record, "selectionReason"),
      qualityScore,
      identityScore,
    }];
  });
}

export async function hydratedImageReferenceInputs(
  images: ImageReferenceInput[] | undefined,
  blob: ReferenceBlobStore,
): Promise<ImageReferenceInput[]> {
  const requested = images ?? [];
  const hydrated = await Promise.all(
    requested.map(async (image) => {
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
  const readable = hydrated.filter(
    (image) => image.b64Json || isAbsoluteUrl(image.url),
  );
  if (readable.length !== requested.length) {
    const readableIds = new Set(readable.map((image) => image.assetId));
    const unavailableAssetIds = requested.flatMap((image) =>
      readableIds.has(image.assetId) ? [] : [image.assetId]
    );
    throw new Error(
      `Pinned image references could not be hydrated: ${unavailableAssetIds.join(", ")}`,
    );
  }
  return readable;
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
  if (role === "look_reference") {
    if (mode === "creative") return 0.8;
    if (mode === "strict") return 0.95;
    return 0.9;
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

function numberFromRecord(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

function uniqueReferenceRequests(
  values: readonly GenerationReferenceRequest[],
) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.mediaAssetId}\u0000${value.role}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
