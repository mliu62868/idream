import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  comicManifestSchema, comicVersionSchema, comicWriteSchema,
  type ComicDetail, type ComicManifest, type ComicSummary,
} from "@idream/shared/comics";
import { getAuthCtx, requireAgeGate, requireAgeVerified, requireUser } from "@/server/lib/auth";
import { adminComicDecisionRequestSchema } from "@idream/shared/admin/contracts";
import { env } from "@/server/lib/env";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { resolveMediaAssetBlobLocator } from "@/server/lib/media-asset-authority";
import { jsonBody, toInputJson } from "@/server/lib/request-json";
import { providers } from "@/server/providers";
import { moderateText } from "@/server/moderation/text-authority";
import { lockCharacterMediaAssetAuthorities } from "@/server/modules/admin-v2/characters/generation-authority-lock";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { actorWithPermission, jsonBody as adminJsonBody } from "@/server/modules/admin-v2/shared/authority";
import { comicInclude as include, comicPageUsable as usableMedia, comicPublishable as publishable, comicPublicAuthor as publicAuthor, comicContentUrl as contentUrl, loadReadableComic as readableComic, type ComicRow } from "./comic-authority";
import { collectionMediaViewUrl } from "./public-read-model";
import { canonicalJsonHash, requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { activeCustomerUserWhere, publicCharacterAudienceWhere } from "./public-content-audience";

const noStore = { "cache-control": "private, no-store, max-age=0", vary: "Cookie, Authorization" };
const cursorSchema = z.object({ scope: z.string(), id: z.string(), updatedAt: z.iso.datetime() }).strict();

function summary(comic: ComicRow, viewerId?: string, admin = false): ComicSummary {
  const first = comic.episodes.flatMap((episode) => episode.pages)[0];
  return {
    id: comic.id, title: comic.title, description: comic.description,
    visibility: comicManifestSchema.shape.visibility.parse(comic.visibility),
    allowRemix: comic.allowRemix,
    status: z.enum(["draft", "pending_review", "published", "withdrawn"]).parse(comic.status),
    version: comic.version,
    creator: { id: comic.creator.id, displayName: comic.creator.displayName ?? comic.creator.name ?? "Creator" },
    pageCount: comic.episodes.reduce((total, episode) => total + episode.pages.length, 0),
    episodeCount: comic.episodes.length,
    coverUrl: first && usableMedia(first.mediaAsset, comic.creatorId) ? (admin ? collectionMediaViewUrl(first.mediaAsset!) : contentUrl(comic.id, first.id)) : null,
    updatedAt: comic.updatedAt.toISOString(), publishedAt: comic.publishedAt?.toISOString() ?? null,
    canManage: viewerId === comic.creatorId,
  };
}

async function detail(comic: ComicRow, viewerId?: string, admin = false): Promise<ComicDetail> {
  // Only current public Character identity is projected. Private prompts, chat text,
  // generation parameters, storage keys and internal provenance remain server-side.
  const characterIds = [...new Set(comic.episodes.flatMap((episode) => episode.pages)
    .flatMap((page) => page.mediaAsset?.characterId ? [page.mediaAsset.characterId] : []))];
  const characters = characterIds.length ? await prisma.character.findMany({
    where: { AND: [{ id: { in: characterIds } }, publicCharacterAudienceWhere] },
    select: { id: true, name: true },
  }) : [];
  const byId = new Map(characters.map((character) => [character.id, character]));
  return {
    ...summary(comic, viewerId, admin),
    reviewNote: admin || viewerId === comic.creatorId ? comic.reviewNote : null,
    episodes: comic.episodes.map((episode) => ({
      id: episode.id, title: episode.title, ordinal: episode.ordinal,
      pages: episode.pages.map((page) => {
        const character = page.mediaAsset?.characterId ? byId.get(page.mediaAsset.characterId) : null;
        return {
          id: page.id, mediaAssetId: page.mediaAssetId, ordinal: page.ordinal, caption: page.caption,
          url: usableMedia(page.mediaAsset, comic.creatorId) ? (admin ? collectionMediaViewUrl(page.mediaAsset!) : contentUrl(comic.id, page.id)) : null,
          remixHref: comic.allowRemix && comic.status === "published" && comic.visibility !== "private" && publicAuthor(comic) && publishable(comic)
            ? `/generate?${new URLSearchParams({ comicId: comic.id, comicVersion: String(comic.version), comicPageId: page.id })}` : null,
          character: character ? {
            id: character.id, name: character.name,
            remixHref: `/generate?${new URLSearchParams({ characterId: character.id })}`,
          } : null,
        };
      }),
    })),
  };
}


async function listComics(request: Request, viewerId?: string, admin = false) {
  const query = new URL(request.url).searchParams;
  const mine = !admin && query.get("scope") === "mine";
  if (mine && !viewerId) throw Errors.unauthorized();
  const status = admin ? z.enum(["pending_review", "published", "draft", "withdrawn"]).parse(query.get("status") ?? "pending_review") : null;
  const creatorId = query.get("creatorId") || null;
  const scope = canonicalJsonHash({ mine, viewerId: mine ? viewerId : null, creatorId, admin, status });
  let cursor: z.infer<typeof cursorSchema> | null = null;
  if (query.get("cursor")) {
    try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(query.get("cursor")!, "base64url").toString("utf8"))); }
    catch { throw Errors.badRequest("Invalid Comic cursor. Reload the list."); }
    if (cursor.scope !== scope) throw Errors.badRequest("Comic cursor belongs to another list. Reload the list.");
  }
  const limit = z.coerce.number().int().min(1).max(24).parse(query.get("limit") ?? "12");
  const rows = await prisma.comic.findMany({
    where: { AND: [
      admin ? { status: status! } : mine ? { creatorId: viewerId } : { status: "published", visibility: "public", creator: activeCustomerUserWhere },
      ...(creatorId ? [{ creatorId }] : []),
      ...(cursor ? [{ OR: [{ updatedAt: { lt: new Date(cursor.updatedAt) } }, { updatedAt: new Date(cursor.updatedAt), id: { lt: cursor.id } }] }] : []),
    ] },
    include, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: limit + 1,
  });
  const selected = rows.slice(0, limit);
  const last = selected.at(-1);
  return ok({
    items: selected.filter((comic) => admin || mine || publishable(comic)).map((comic) => summary(comic, viewerId, admin)),
    nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ scope, id: last.id, updatedAt: last.updatedAt.toISOString() })).toString("base64url") : null,
  }, { headers: noStore });
}

async function manifestEpisodes(tx: Prisma.TransactionClient, creatorId: string, manifest: ComicManifest) {
  const ids = [...new Set(manifest.episodes.flatMap((episode) => episode.pages.map((page) => page.mediaAssetId)))];
  await lockCharacterMediaAssetAuthorities(tx, ids);
  const assets = ids.length ? await tx.mediaAsset.findMany({ where: { id: { in: ids }, ownerId: creatorId } }) : [];
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  if (ids.some((id) => !usableMedia(byId.get(id) ?? null, creatorId))) {
    throw Errors.badRequest("Choose available images from your own Gallery. Remove unavailable pages before saving.");
  }
  return manifest.episodes.map((episode, ordinal) => ({
    ordinal, title: episode.title,
    pages: { create: episode.pages.map((page, pageOrdinal) => {
      const asset = byId.get(page.mediaAssetId)!;
      return {
        ordinal: pageOrdinal, mediaAssetId: asset.id, caption: page.caption,
        sourceProvenance: toInputJson({ mediaAssetId: asset.id, characterId: asset.characterId }),
      };
    }) },
  }));
}

async function lockComic(tx: Prisma.TransactionClient, id: string, expectedVersion: number, ownerId?: string) {
  // Comic writers lock their row before sorted media authority locks. Media mutations
  // only read Comic dependencies under their existing media lock, never lock Comic rows.
  await tx.$queryRaw`SELECT id FROM comics WHERE id = ${id} FOR UPDATE`;
  const comic = await tx.comic.findUnique({ where: { id }, include });
  if (!comic || (ownerId && comic.creatorId !== ownerId)) throw Errors.notFound("Comic not found");
  if (comic.version !== expectedVersion) throw Errors.conflict("Comic changed. Reload before continuing.", { currentVersion: comic.version });
  return comic;
}

async function createComic(request: Request, creatorId: string) {
  const manifest = comicManifestSchema.parse(await jsonBody(request));
  const id = crypto.randomUUID();
  await moderateManifest(id, manifest);
  const comic = await prisma.$transaction(async (tx) => {
    const episodes = await manifestEpisodes(tx, creatorId, manifest);
    return tx.comic.create({ data: { id, creatorId, title: manifest.title, description: manifest.description, visibility: manifest.visibility, allowRemix: manifest.allowRemix, episodes: { create: episodes } }, include });
  });
  return ok(await detail(comic, creatorId), { status: 201, headers: noStore });
}

async function updateComic(request: Request, id: string, creatorId: string) {
  const { version, manifest } = comicWriteSchema.parse(await jsonBody(request));
  const owned = await prisma.comic.findFirst({ where: { id, creatorId }, select: { id: true } });
  if (!owned) throw Errors.notFound("Comic not found");
  await moderateManifest(id, manifest);
  const comic = await prisma.$transaction(async (tx) => {
    const current = await lockComic(tx, id, version, creatorId);
    if (!["draft", "withdrawn"].includes(current.status)) throw Errors.conflict("Withdraw this Comic before editing it.");
    const episodes = await manifestEpisodes(tx, creatorId, manifest);
    await tx.comicEpisode.deleteMany({ where: { comicId: id } });
    return tx.comic.update({ where: { id }, data: {
      title: manifest.title, description: manifest.description, visibility: manifest.visibility,
      allowRemix: manifest.allowRemix,
      status: "draft", reviewNote: null, submittedAt: null, publishedAt: null,
      version: { increment: 1 }, episodes: { create: episodes },
    }, include });
  });
  return ok(await detail(comic, creatorId), { headers: noStore });
}

async function authorAction(request: Request, id: string, creatorId: string, action: "submit" | "withdraw") {
  const { version } = comicVersionSchema.parse(await jsonBody(request));
  const comic = await prisma.$transaction(async (tx) => {
    let current = await lockComic(tx, id, version, creatorId);
    if (action === "submit") {
      if (current.status !== "draft") throw Errors.conflict("Only a saved draft can be submitted.");
      if (current.visibility === "private") throw Errors.badRequest("Choose public or unlisted visibility before submitting.");
      await lockCharacterMediaAssetAuthorities(tx, current.episodes.flatMap((episode) => episode.pages.flatMap((page) => page.mediaAssetId ? [page.mediaAssetId] : [])));
      current = await tx.comic.findUniqueOrThrow({ where: { id }, include });
      if (!publishable(current)) throw Errors.badRequest("Every chapter needs at least one available image before submission.");
    } else if (!["pending_review", "published"].includes(current.status)) {
      throw Errors.conflict("Only a submitted or published Comic can be withdrawn.");
    }
    return tx.comic.update({ where: { id }, data: action === "submit"
      ? { status: "pending_review", version: { increment: 1 }, submittedAt: new Date(), reviewNote: null }
      : { status: "withdrawn", version: { increment: 1 }, publishedAt: null }, include });
  });
  return ok(await detail(comic, creatorId), { headers: noStore });
}

export async function decideAdminComic(request: Request, id: string) {
  const actor = await actorWithPermission(request, "safety.review.write");
  const body = adminComicDecisionRequestSchema.parse(await adminJsonBody(request, "adminComicDecisionRequestSchema+idempotency-key"));
  if (body.confirmation !== id) throw Errors.badRequest("Confirmation did not match the Comic");
  const result = await executeAtomicIdempotentMutation({
    environment: env.APP_ENV, actor, idempotencyKey: requireIdempotencyKey(request),
    requestId: request.headers.get("x-request-id") || crypto.randomUUID(),
    commandType: "comic.review", target: { type: "comic", id }, expectedVersion: body.version, payload: body,
    mutate: async (tx) => {
    let current = await lockComic(tx, id, body.version);
    if (body.decision === "remove" ? current.status !== "published" : current.status !== "pending_review") {
      throw Errors.conflict("Comic status changed. Reload the review queue.");
    }
    if (body.decision === "approve") {
      await lockCharacterMediaAssetAuthorities(tx, current.episodes.flatMap((episode) => episode.pages.flatMap((page) => page.mediaAssetId ? [page.mediaAssetId] : [])));
      current = await tx.comic.findUniqueOrThrow({ where: { id }, include });
      if (!publishable(current) || !publicAuthor(current)) throw Errors.conflict("The author or a Comic page is no longer eligible for publication.");
    }
    const updated = await tx.comic.update({ where: { id }, data: {
      status: body.decision === "approve" ? "published" : body.decision === "reject" ? "draft" : "withdrawn",
      publishedAt: body.decision === "approve" ? new Date() : null,
      reviewNote: body.reason, version: { increment: 1 },
    }, include });
    await tx.adminAuditLog.create({ data: {
      actorId: actor.id, actorRole: actor.role, action: `comic.${body.decision}`, targetType: "comic", targetId: id,
      reason: body.reason, before: toInputJson({ status: current.status, version: current.version }),
      after: toInputJson({ status: updated.status, version: updated.version }),
    } });
    return detail(updated, undefined, true);
    },
  });
  return ok(result, { headers: noStore });
}

async function pageContent(id: string, pageId: string, viewerId?: string, admin = false) {
  const comic = await readableComic(id, viewerId, admin);
  const page = comic.episodes.flatMap((episode) => episode.pages).find((item) => item.id === pageId);
  if (!page || !usableMedia(page.mediaAsset, comic.creatorId)) throw Errors.notFound("Comic page is unavailable");
  const key = resolveMediaAssetBlobLocator(page.mediaAsset)?.key;
  if (!key || !providers.blob.getPrivate) throw Errors.unavailable("Comic image storage is unavailable");
  const blob = await providers.blob.getPrivate({ key });
  if (!blob.ok) throw Errors.notFound("Comic page is unavailable");
  // Recheck after the blob read so a withdrawal during storage I/O cannot deliver
  // an old publication. No signed URLs escape this revocable authority boundary.
  const latest = await readableComic(id, viewerId, admin);
  if (latest.version !== comic.version) throw Errors.conflict("Comic changed. Reload the reader.");
  const latestPage = latest.episodes.flatMap((episode) => episode.pages).find((item) => item.id === pageId);
  if (!latestPage || !usableMedia(latestPage.mediaAsset, latest.creatorId)) throw Errors.notFound("Comic page is unavailable");
  const buffer = new ArrayBuffer(blob.data.body.byteLength);
  new Uint8Array(buffer).set(blob.data.body);
  return new Response(buffer, { headers: { ...noStore, "content-type": page.mediaAsset.contentType ?? blob.data.contentType ?? "image/webp", "x-content-type-options": "nosniff" } });
}

// The Admin v2 route owns the permission check and the manifest query door.
export function listAdminComics(request: Request) {
  return listComics(request, undefined, true);
}

export async function getAdminComic(request: Request, id: string) {
  await actorWithPermission(request, "content.asset.read");
  return ok(await detail(await readableComic(id, undefined, true), undefined, true), { headers: noStore });
}

export async function dispatchComics(request: Request, segments: string[]): Promise<Response | null> {
  if (segments[0] !== "comics") return null;
  const [, id, action, pageId, content, extra] = segments;
  const method = request.method;
  if (extra) throw Errors.notFound();
  const ctx = await getAuthCtx(request);
  requireAgeGate(ctx);
  let viewerId = ctx.userId;
  if (method !== "GET" || new URL(request.url).searchParams.get("scope") === "mine") {
    viewerId = requireUser(ctx).id;
    requireAgeVerified(ctx);
  }
  // Public reading only requires the age gate. Private owner previews use
  // the same age-verification authority as Gallery and Comic authoring.
  if (ctx.ageVerificationStatus !== "not_required" && ctx.ageVerificationStatus !== "verified") viewerId = undefined;
  if (method === "GET" && !id) return listComics(request, viewerId);
  if (method === "GET" && id && !action) return ok(await detail(await readableComic(id, viewerId), viewerId), { headers: noStore });
  if (method === "GET" && id && action === "pages" && pageId && content === "content") return pageContent(id, pageId, viewerId);
  if (viewerId) {
    if (method === "POST" && !id) return createComic(request, viewerId);
    if (method === "PATCH" && id && !action) return updateComic(request, id, viewerId);
    if (method === "POST" && id && !pageId && (action === "submit" || action === "withdraw")) return authorAction(request, id, viewerId, action);
  }
  throw Errors.notFound();
}

async function moderateManifest(id: string, manifest: ComicManifest) {
  const text = [manifest.title, manifest.description, ...manifest.episodes.flatMap((episode) => [episode.title, ...episode.pages.map((page) => page.caption)])].join("\n");
  const moderation = await moderateText("comic", id, text, "input");
  if (moderation.status === "blocked") throw Errors.forbidden("Comic text failed safety checks", moderation);
}
