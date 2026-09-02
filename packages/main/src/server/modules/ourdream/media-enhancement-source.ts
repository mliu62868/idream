import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import sharp from "sharp";
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { isMediaAssetOperationalForAuthority, resolveMediaAssetBlobLocator } from "@/server/lib/media-asset-authority";
import { providers } from "@/server/providers";
import { jsonRecord } from "./json-values";

export const mediaEnhancementPinSchema = z.object({
  sourceMediaId: z.string().min(1),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceWidth: z.number().int().positive().max(2048),
  sourceHeight: z.number().int().positive().max(2048),
  scale: z.literal(2),
}).strict();

// SPEC: Enhance transforms owned pixels, including historical Character images;
// it never selects a current identity, rewrites its source, or changes a portrait.
export function isEnhanceEligible(asset: {
  type: string; safetyStatus: string; width?: number | null; height?: number | null;
  contentType?: string | null; storageKey?: string | null; url: string;
  metadata?: unknown; deletedAt?: Date | null;
}) {
  return asset.type === "image" && asset.safetyStatus === "passed" && !asset.deletedAt &&
    Boolean(asset.width && asset.height && asset.width > 0 && asset.height > 0 && asset.width <= 2048 && asset.height <= 2048) &&
    ["image/png", "image/jpeg", "image/webp"].includes(asset.contentType ?? "") &&
    isMediaAssetOperationalForAuthority(asset.metadata) && Boolean(resolveMediaAssetBlobLocator(asset));
}

export async function loadMediaEnhancementSource(
  userId: string, sourceMediaId: string,
  db: Pick<Prisma.TransactionClient, "mediaAsset"> = prisma,
) {
  const asset = await db.mediaAsset.findFirst({
    where: { id: sourceMediaId, ownerId: userId, deletedAt: null },
    include: { sourceJob: true },
  });
  if (!asset) throw Errors.notFound("Image not found");
  if (!isEnhanceEligible(asset)) throw Errors.conflict("This image cannot be enhanced. Choose an available image up to 2048 pixels per side.");
  const locator = resolveMediaAssetBlobLocator(asset)!;
  if (!providers.blob.getPrivate) throw Errors.conflict("Source image storage does not support enhancement");
  const result = await providers.blob.getPrivate({ key: locator.key });
  if (!result.ok) throw Errors.conflict("Source image is unavailable");
  const bytes = Buffer.from(result.data.body);
  try {
    const image = sharp(bytes, { limitInputPixels: 4_194_304, animated: true });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || metadata.width !== asset.width || metadata.height !== asset.height ||
      !["png", "jpeg", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) !== 1 || (metadata.orientation ?? 1) !== 1) {
      throw new Error("Unsupported or inconsistent source image");
    }
    await image.raw().toBuffer();
  } catch {
    throw Errors.conflict("Source image cannot be decoded at its recorded dimensions");
  }
  return { asset, pin: {
    sourceMediaId: asset.id,
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    sourceWidth: asset.width!, sourceHeight: asset.height!, scale: 2 as const,
  } };
}

export async function assertMediaEnhancementSource(input: {
  userId: string; characterId: string | null; controls: unknown;
}, db: Pick<Prisma.TransactionClient, "mediaAsset"> = prisma) {
  const controls = jsonRecord(input.controls);
  const parsed = mediaEnhancementPinSchema.safeParse(controls.enhancement);
  if (!parsed.success || controls.sourceImageAssetId !== parsed.data.sourceMediaId ||
    controls.width !== parsed.data.sourceWidth * 2 || controls.height !== parsed.data.sourceHeight * 2) {
    throw Errors.conflict("Enhancement source authority is invalid");
  }
  const source = await loadMediaEnhancementSource(input.userId, parsed.data.sourceMediaId, db);
  if (source.asset.characterId !== input.characterId || source.pin.sourceSha256 !== parsed.data.sourceSha256 ||
    source.pin.sourceWidth !== parsed.data.sourceWidth || source.pin.sourceHeight !== parsed.data.sourceHeight) {
    throw Errors.conflict("The original image changed after this enhancement was quoted");
  }
  return source;
}
