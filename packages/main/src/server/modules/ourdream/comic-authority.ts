import type { Prisma, MediaAsset } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { evaluateMediaAssetCustomerPublishability, resolveMediaAssetBlobLocator } from "@/server/lib/media-asset-authority";

export const comicInclude = {
  creator: { select: { id: true, displayName: true, name: true, status: true, deletedAt: true, dataClass: true, role: true } },
  episodes: { orderBy: { ordinal: "asc" }, include: { pages: { orderBy: { ordinal: "asc" }, include: { mediaAsset: true } } } },
} as const satisfies Prisma.ComicInclude;
export type ComicRow = Prisma.ComicGetPayload<{ include: typeof comicInclude }>;

export function comicPageUsable(asset: MediaAsset | null, creatorId: string): asset is MediaAsset {
  return Boolean(asset && asset.ownerId === creatorId && !asset.deletedAt
    && asset.type === "image" && asset.safetyStatus === "passed"
    && resolveMediaAssetBlobLocator(asset)?.key
    && evaluateMediaAssetCustomerPublishability({ metadata: asset.metadata }).publishable);
}

export function comicPublishable(comic: ComicRow) {
  return comic.episodes.length > 0 && comic.episodes.every((episode) =>
    episode.pages.length > 0 && episode.pages.every((page) => comicPageUsable(page.mediaAsset, comic.creatorId)));
}

export function comicPublicAuthor(comic: ComicRow) {
  return comic.creator.status === "active" && !comic.creator.deletedAt
    && comic.creator.dataClass === "customer" && comic.creator.role === "user";
}

export function comicContentUrl(comicId: string, pageId: string) {
  return `/api/v1/comics/${encodeURIComponent(comicId)}/pages/${encodeURIComponent(pageId)}/content`;
}

export async function loadReadableComic(id: string, viewerId?: string, admin = false, db: Pick<Prisma.TransactionClient, "comic"> = prisma) {
  const comic = await db.comic.findUnique({ where: { id }, include: comicInclude });
  if (!comic) throw Errors.notFound("Comic not found");
  if (admin || comic.creatorId === viewerId) return comic;
  if (comic.status !== "published" || comic.visibility === "private" || !comicPublicAuthor(comic) || !comicPublishable(comic)) {
    throw Errors.notFound("Comic is no longer available");
  }
  return comic;
}
