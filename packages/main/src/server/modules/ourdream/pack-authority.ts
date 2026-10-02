import type { MediaAsset, Prisma } from "@prisma/client";
import { z } from "zod";
import { evaluateMediaAssetCustomerPublishability, resolveMediaAssetBlobLocator } from "@/server/lib/media-asset-authority";
import { activeCustomerUserWhere } from "./public-content-audience";

export const packInclude = {
  creator: { select: { id: true, name: true, displayName: true, status: true, deletedAt: true, dataClass: true, role: true } },
  currentRelease: true,
} as const satisfies Prisma.PackInclude;
export type PackRow = Prisma.PackGetPayload<{ include: typeof packInclude }>;
export const packSnapshotSchema = z.object({
  schemaVersion: z.literal(1), coverAssetId: z.string().nullable(),
  items: z.array(z.object({
    id: z.string(), sourceMediaAssetId: z.string(), caption: z.string(),
    type: z.enum(["image", "video", "voice"]), contentType: z.string(),
    storageKey: z.string(), sizeBytes: z.number().int().positive(), sha256: z.string(),
  }).strict()).min(1).max(16),
}).strict();
export type PackSnapshot = z.infer<typeof packSnapshotSchema>;

const mimeByType: Record<string, readonly string[]> = {
  image: ["image/webp", "image/png", "image/jpeg", "image/gif", "image/avif"],
  video: ["video/mp4", "video/webm"],
  voice: ["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3", "audio/ogg", "audio/webm"],
};
export function packSourceUsable(asset: MediaAsset | null | undefined, ownerId: string): asset is MediaAsset {
  return Boolean(asset && asset.ownerId === ownerId && !asset.deletedAt && asset.safetyStatus === "passed"
    && mimeByType[asset.type]?.includes(asset.contentType ?? "")
    && resolveMediaAssetBlobLocator(asset)
    && evaluateMediaAssetCustomerPublishability({ metadata: asset.metadata }).publishable);
}
export function packPublicCreator(pack: PackRow): boolean {
  const creator = pack.creator;
  return Boolean(creator && creator.status === "active" && !creator.deletedAt && creator.dataClass === "customer" && creator.role === "user");
}
export function packCanOffer(pack: PackRow, now = new Date()): boolean {
  return pack.status === "published" && pack.visibility !== "private" && packPublicCreator(pack)
    && Boolean(pack.currentRelease && (!pack.currentRelease.claimUntil || pack.currentRelease.claimUntil > now));
}
// Query counterpart of packCanOffer: direct public/unlisted offers can qualify
// a Pack-only creator's profile and Follow target, including claim expiry.
export function publicPackAudienceWhere(now = new Date()): Prisma.PackWhereInput {
  return { status: "published", visibility: { in: ["public", "unlisted"] },
    creator: { is: activeCustomerUserWhere },
    currentRelease: { is: { OR: [{ claimUntil: null }, { claimUntil: { gt: now } }] } } };
}
export function packReleaseStorageKeys(value: unknown): string[] {
  return packSnapshotSchema.parse(value).items.map(item => item.storageKey);
}
export function packItemContentUrl(packId: string, releaseId: string, itemId: string) {
  return `/api/v1/packs/${encodeURIComponent(packId)}/releases/${encodeURIComponent(releaseId)}/items/${encodeURIComponent(itemId)}/content`;
}
