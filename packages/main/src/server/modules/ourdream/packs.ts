import { createHash } from "node:crypto";
import { Prisma, type PackRelease } from "@prisma/client";
import { z } from "zod";
import { PACK_RIGHTS, packClaimSchema, packContentSchema, packManifestSchema, packStatusSchema, packVersionSchema, packWriteSchema, type PackDetail, type PackManifest, type PackSummary } from "@idream/shared/packs";
import { adminPackBlockRequestSchema, adminPackDetailResponseSchema } from "@idream/shared/admin/contracts";
import { getAuthCtx, requireAgeGate, requireAgeVerified, requireUser } from "@/server/lib/auth";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { env } from "@/server/lib/env";
import { ok } from "@/server/lib/http";
import { jsonBody, toInputJson } from "@/server/lib/request-json";
import { resolveMediaAssetBlobLocator } from "@/server/lib/media-asset-authority";
import { mediaByteResponse } from "@/server/lib/media-byte-response";
import { providers } from "@/server/providers";
import { lockCharacterMediaAssetAuthorities } from "@/server/modules/admin-v2/characters/generation-authority-lock";
import { canonicalJsonHash, requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { actorWithPermission, jsonBody as adminJsonBody } from "@/server/modules/admin-v2/shared/authority";
import { activeCustomerUserWhere } from "./public-content-audience";
import { packCanOffer, packInclude, packItemContentUrl, packPublicCreator, packSnapshotSchema, packSourceUsable, type PackRow, type PackSnapshot } from "./pack-authority";

const noStore = { "cache-control": "private, no-store, max-age=0", vary: "Cookie, Authorization" };
const cursorSchema = z.object({ scope: z.string(), id: z.string(), at: z.iso.datetime() }).strict();
const maxItemBytes = 50 * 1024 * 1024;
const maxReleaseBytes = 200 * 1024 * 1024;

function summary(pack: PackRow, viewerId?: string, release: PackRelease | null = pack.currentRelease): PackSummary {
  const content = packContentSchema.parse(pack.draftContent);
  const snapshot = release ? packSnapshotSchema.parse(release.manifest) : null;
  const cover = snapshot?.coverAssetId;
  return {
    id: pack.id, title: release?.title ?? pack.title, description: release?.description ?? pack.description,
    visibility: packManifestSchema.shape.visibility.parse(pack.visibility), status: packStatusSchema.parse(pack.status),
    version: pack.version, creator: { id: pack.creator?.id ?? null, displayName: pack.creator?.displayName ?? pack.creator?.name ?? "Former creator" },
    itemCount: snapshot?.items.length ?? content.items.length,
    coverUrl: cover && packCanOffer(pack) && release?.id === pack.currentReleaseId ? `/api/v1/packs/${encodeURIComponent(pack.id)}/cover` : null,
    releaseId: release?.id ?? null, releaseVersion: release?.version ?? null,
    claimUntil: release?.claimUntil?.toISOString() ?? content.claimUntil, publishedAt: release?.publishedAt.toISOString() ?? null,
    updatedAt: pack.updatedAt.toISOString(), priceCents: 0, rights: PACK_RIGHTS,
    canManage: Boolean(viewerId && viewerId === pack.creatorId), canClaim: packCanOffer(pack) && release?.id === pack.currentReleaseId,
  };
}

export async function packDetail(pack: PackRow, viewerId?: string, selectedReleaseId?: string, admin = false, db: Pick<Prisma.TransactionClient, "packGrant" | "packRelease"> = prisma): Promise<PackDetail> {
  const owner = Boolean(viewerId && pack.creatorId === viewerId);
  const grants = viewerId ? await db.packGrant.findMany({ where: { userId: viewerId, release: { packId: pack.id } }, include: { release: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }) : [];
  let release = pack.currentRelease;
  if (!selectedReleaseId && !owner && !admin && !packCanOffer(pack)) release = grants[0]?.release ?? null;
  if (selectedReleaseId && selectedReleaseId !== release?.id) {
    if (!owner && !admin && !grants.some(grant => grant.releaseId === selectedReleaseId)) throw Errors.notFound("Pack version not found");
    release = await db.packRelease.findFirst({ where: { id: selectedReleaseId, packId: pack.id } });
    if (!release) throw Errors.notFound("Pack version not found");
  }
  const grantForRelease = grants.find(grant => grant.releaseId === release?.id);
  // A grant belongs to one immutable release, never to this creator's later
  // private draft or edition. Withdrawn/expired links recover the owned edition.
  if (!owner && !admin && !grantForRelease && !(release?.id === pack.currentReleaseId && packCanOffer(pack))) throw Errors.notFound("Pack version not found");
  const canAccess = pack.status !== "blocked" && Boolean(owner || grantForRelease);
  const receipt = (grant: typeof grants[number]) => ({
    id: grant.id, releaseId: grant.releaseId, version: grant.release.version, title: grant.release.title,
    claimedAt: grant.createdAt.toISOString(), href: `/packs/${encodeURIComponent(pack.id)}?release=${encodeURIComponent(grant.releaseId)}`,
  });
  return {
    ...summary(pack, viewerId, release),
    // A saved draft is creator-only; released snapshots never expose source prompts or locators.
    manifest: owner ? packManifestSchema.parse({ title: pack.title, description: pack.description, visibility: pack.visibility, ...packContentSchema.parse(pack.draftContent) }) : null,
    grant: grantForRelease ? receipt(grantForRelease) : null, grants: grants.map(receipt),
    blockedReason: pack.status === "blocked" ? pack.blockedReason : null,
    release: release ? {
      id: release.id, version: release.version, title: release.title, description: release.description,
      priceCents: 0, rights: PACK_RIGHTS, claimUntil: release.claimUntil?.toISOString() ?? null, publishedAt: release.publishedAt.toISOString(), canAccess,
      items: packSnapshotSchema.parse(release.manifest).items.map(item => ({
        id: item.id, caption: item.caption, type: item.type, contentType: item.contentType, sizeBytes: item.sizeBytes,
        url: canAccess ? packItemContentUrl(pack.id, release!.id, item.id) : null,
        downloadUrl: canAccess ? `${packItemContentUrl(pack.id, release!.id, item.id)}?download=1` : null,
      })),
    } : null,
  };
}

function cursor(request: Request, scope: string) {
  const value = new URL(request.url).searchParams.get("cursor");
  if (!value) return null;
  try {
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (parsed.scope !== scope) throw new Error("scope mismatch");
    return parsed;
  } catch { throw Errors.badRequest("Pack cursor belongs to another list. Reload the list."); }
}

async function listPacks(request: Request, viewerId?: string, admin = false) {
  const query = new URL(request.url).searchParams;
  const mode = z.enum(["public", "mine", "claimed"]).parse(query.get("scope") ?? "public");
  if (mode !== "public" && !viewerId) throw Errors.unauthorized();
  const creatorId = query.get("creatorId") || null;
  const status = admin && query.has("status") ? packStatusSchema.parse(query.get("status")) : null;
  const scope = canonicalJsonHash({ mode, viewerId: mode !== "public" ? viewerId : null, creatorId, status, admin });
  const after = cursor(request, scope);
  const limit = z.coerce.number().int().min(1).max(24).parse(query.get("limit") ?? "12");
  if (mode === "claimed") {
    const rows = await prisma.packGrant.findMany({ where: { userId: viewerId!, ...(after ? { OR: [{ createdAt: { lt: new Date(after.at) } }, { createdAt: new Date(after.at), id: { lt: after.id } }] } : {}) },
      include: { release: { include: { pack: { include: packInclude } } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1 });
    const selected = rows.slice(0, limit), last = selected.at(-1);
    return ok({ items: selected.map(grant => summary(grant.release.pack, viewerId, grant.release)), nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ scope, id: last.id, at: last.createdAt.toISOString() })).toString("base64url") : null }, { headers: noStore });
  }
  const rows = await prisma.pack.findMany({ where: { AND: [
    admin ? status ? { status } : {} : mode === "mine" ? { creatorId: viewerId } : { status: "published", visibility: "public", creator: { is: activeCustomerUserWhere }, currentRelease: { is: { OR: [{ claimUntil: null }, { claimUntil: { gt: new Date() } }] } } },
    ...(creatorId ? [{ creatorId }] : []),
    ...(after ? [{ OR: [{ updatedAt: { lt: new Date(after.at) } }, { updatedAt: new Date(after.at), id: { lt: after.id } }] }] : []),
  ] }, include: packInclude, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: limit + 1 });
  const selected = rows.slice(0, limit), last = selected.at(-1);
  return ok({ items: selected.map(pack => summary(pack, viewerId)), nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ scope, id: last.id, at: last.updatedAt.toISOString() })).toString("base64url") : null }, { headers: noStore });
}

async function lockCreator(tx: Prisma.TransactionClient, userId: string) {
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
  const user = await tx.user.findUnique({ where: { id: userId }, select: { status: true, deletedAt: true } });
  if (!user || user.status !== "active" || user.deletedAt) throw Errors.unauthorized("Your account is no longer active");
}
export async function lockPack(tx: Prisma.TransactionClient, id: string, version: number, creatorId?: string) {
  await tx.$queryRaw`SELECT id FROM packs WHERE id = ${id} FOR UPDATE`;
  const pack = await tx.pack.findUnique({ where: { id }, include: packInclude });
  if (!pack || (creatorId && pack.creatorId !== creatorId)) throw Errors.notFound("Pack not found");
  if (pack.version !== version) throw Errors.conflict("Pack changed. Reload before continuing.", { currentVersion: pack.version });
  return pack;
}
async function validateSources(tx: Prisma.TransactionClient, creatorId: string, manifest: PackManifest) {
  const ids = manifest.items.map(item => item.mediaAssetId);
  await lockCharacterMediaAssetAuthorities(tx, ids);
  const assets = await tx.mediaAsset.findMany({ where: { id: { in: ids }, ownerId: creatorId } });
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  if (ids.some(id => !packSourceUsable(byId.get(id), creatorId))) throw Errors.badRequest("Choose available images, videos or audio from your own Gallery. Remove unavailable items before saving.");
  if (manifest.coverAssetId && byId.get(manifest.coverAssetId)?.type !== "image") throw Errors.badRequest("Choose an image from this Pack as its public preview cover.");
  return ids.map(id => byId.get(id)!);
}
async function savePack(request: Request, creatorId: string, id?: string) {
  const input = await jsonBody(request);
  const write = id ? packWriteSchema.parse(input) : null;
  const manifest = write?.manifest ?? packManifestSchema.parse(input);
  const pack = await prisma.$transaction(async tx => {
    await lockCreator(tx, creatorId);
    if (id) {
      const current = await lockPack(tx, id, write!.version, creatorId);
      if (!["draft", "withdrawn"].includes(current.status)) throw Errors.conflict("Withdraw this Pack before editing it.");
    }
    await validateSources(tx, creatorId, manifest);
    const { title, description, visibility, ...content } = manifest;
    const data = { title, description, visibility, draftContent: toInputJson(content) };
    return id ? tx.pack.update({ where: { id }, data: { ...data, status: "draft", version: { increment: 1 } }, include: packInclude })
      : tx.pack.create({ data: { ...data, creatorId }, include: packInclude });
  });
  return ok(await packDetail(pack, creatorId), { status: id ? 200 : 201, headers: noStore });
}

async function publishPack(request: Request, id: string, creatorId: string) {
  const { version } = packVersionSchema.parse(await jsonBody(request));
  const pack = await prisma.pack.findFirst({ where: { id, creatorId }, include: packInclude });
  if (!pack) throw Errors.notFound("Pack not found");
  if (pack.version !== version || pack.status !== "draft") throw Errors.conflict("Only the current saved draft can be published. Reload the Pack.");
  if (pack.visibility !== "private" && !packPublicCreator(pack)) throw Errors.forbidden("Only an active creator account can share a Pack.");
  const manifest = packManifestSchema.parse({ title: pack.title, description: pack.description, visibility: pack.visibility, ...packContentSchema.parse(pack.draftContent) });
  if (!manifest.items.length) throw Errors.badRequest("Choose at least one asset before publishing.");
  if (manifest.claimUntil && new Date(manifest.claimUntil) <= new Date()) throw Errors.badRequest("Choose a future claim deadline or no deadline.");
  if (!providers.blob.getPrivate) throw Errors.unavailable("Pack storage is unavailable");
  const assets = await prisma.mediaAsset.findMany({ where: { id: { in: manifest.items.map(item => item.mediaAssetId) }, ownerId: creatorId } });
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  const releaseId = crypto.randomUUID();
  const copied: PackSnapshot["items"] = [];
  let bytes = 0;
  try {
    for (const item of manifest.items) {
      const asset = byId.get(item.mediaAssetId);
      if (!packSourceUsable(asset, creatorId)) throw Errors.badRequest("A selected Gallery asset is unavailable. Reload and remove it.");
      const sourceKey = resolveMediaAssetBlobLocator(asset)!.key;
      const blob = await providers.blob.getPrivate({ key: sourceKey });
      if (!blob.ok) throw Errors.unavailable("A selected Gallery file is unavailable. Try again after restoring it.");
      bytes += blob.data.body.byteLength;
      if (!blob.data.body.byteLength || blob.data.body.byteLength > maxItemBytes || bytes > maxReleaseBytes) throw Errors.badRequest("Pack files must be at most 50 MB each and 200 MB in total.");
      const key = `packs/${id}/${releaseId}/${copied.length}`;
      const staged = { id: asset.id, sourceMediaAssetId: asset.id, caption: item.caption, type: z.enum(["image", "video", "voice"]).parse(asset.type), contentType: asset.contentType!, storageKey: key, sizeBytes: blob.data.body.byteLength, sha256: createHash("sha256").update(blob.data.body).digest("hex") };
      // Track the attempted key before PUT; a response failure can still have written bytes.
      copied.push(staged);
      const stored = await providers.blob.putPrivate({ key, body: blob.data.body, contentType: staged.contentType });
      if (!stored.ok) throw Errors.unavailable("Pack file persistence failed. No publication was committed.");
    }
    const snapshot = packSnapshotSchema.parse({ schemaVersion: 1, coverAssetId: manifest.coverAssetId, items: copied });
    const published = await prisma.$transaction(async tx => {
      await lockCreator(tx, creatorId);
      const current = await lockPack(tx, id, version, creatorId);
      if (current.status !== "draft") throw Errors.conflict("Pack publication changed. Reload the Pack.");
      if (current.visibility !== "private" && !packPublicCreator(current)) throw Errors.forbidden("The creator can no longer share this Pack.");
      const latest = await validateSources(tx, creatorId, manifest);
      if (latest.some(asset => resolveMediaAssetBlobLocator(asset)?.key !== resolveMediaAssetBlobLocator(byId.get(asset.id)!)?.key)) throw Errors.conflict("A source asset changed while publishing. Reload the Pack.");
      await tx.packRelease.create({ data: { id: releaseId, packId: id, version: version + 1, title: manifest.title, description: manifest.description, manifest: toInputJson(snapshot), manifestHash: canonicalJsonHash(snapshot), claimUntil: manifest.claimUntil ? new Date(manifest.claimUntil) : null } });
      return tx.pack.update({ where: { id }, data: { status: "published", currentReleaseId: releaseId, version: { increment: 1 } }, include: packInclude });
    });
    return ok(await packDetail(published, creatorId), { headers: noStore });
  } catch (error) {
    // A lost commit response must not delete a granted snapshot. Unknown DB
    // outcomes preserve bytes; a retry/refresh resolves the durable release.
    const committed = await prisma.packRelease.findUnique({ where: { id: releaseId }, select: { id: true } });
    if (committed) {
      const current = await prisma.pack.findUniqueOrThrow({ where: { id }, include: packInclude });
      return ok(await packDetail(current, creatorId), { headers: noStore });
    }
    for (const item of copied) {
      const deleted = await providers.blob.delete({ key: item.storageKey });
      if (!deleted.ok) throw Errors.unavailable("Publication failed and temporary file cleanup requires retry.", { packId: id, releaseId });
    }
    throw error;
  }
}

async function withdrawPack(request: Request, id: string, creatorId: string) {
  const { version } = packVersionSchema.parse(await jsonBody(request));
  const pack = await prisma.$transaction(async tx => {
    await lockCreator(tx, creatorId);
    const current = await lockPack(tx, id, version, creatorId);
    if (current.status === "blocked") throw Errors.conflict("This Pack is blocked. Contact support before changing it.");
    if (current.status !== "published") throw Errors.conflict("Only a published Pack can be withdrawn.");
    return tx.pack.update({ where: { id }, data: { status: "withdrawn", version: { increment: 1 } }, include: packInclude });
  });
  return ok(await packDetail(pack, creatorId), { headers: noStore });
}
async function claimPack(request: Request, id: string, viewerId: string) {
  const { version, releaseId } = packClaimSchema.parse(await jsonBody(request));
  const pack = await prisma.$transaction(async tx => {
    // Account erasure and creator publication use User -> Pack lock order.
    await lockCreator(tx, viewerId);
    await tx.$queryRaw`SELECT id FROM packs WHERE id = ${id} FOR UPDATE`;
    const current = await tx.pack.findUnique({ where: { id }, include: packInclude });
    if (!current) throw Errors.notFound("Pack not found");
    const existing = await tx.packGrant.findUnique({ where: { userId_releaseId: { userId: viewerId, releaseId } } });
    if (existing && await tx.packRelease.findFirst({ where: { id: releaseId, packId: id, version } })) return current;
    if (!packCanOffer(current) || current.currentReleaseId !== releaseId || current.currentRelease?.version !== version) throw Errors.conflict("This Pack version is no longer available for new claims. Reload the Pack.");
    await tx.packGrant.create({ data: { userId: viewerId, releaseId } });
    return current;
  });
  return ok(await packDetail(pack, viewerId, releaseId), { headers: noStore });
}

async function readableContent(packId: string, releaseId: string, itemId: string, viewerId?: string, cover = false) {
  const pack = await prisma.pack.findUnique({ where: { id: packId }, include: packInclude });
  if (!pack) throw Errors.notFound("Pack not found");
  const release = cover ? pack.currentRelease : await prisma.packRelease.findFirst({ where: { id: releaseId, packId } });
  if (!release) throw Errors.notFound("Pack version not found");
  if (!cover && (!viewerId || !await prisma.user.findFirst({ where: { id: viewerId, status: "active", deletedAt: null }, select: { id: true } }))) throw Errors.notFound("Your account can no longer access this Pack");
  const granted = viewerId && await prisma.packGrant.findUnique({ where: { userId_releaseId: { userId: viewerId, releaseId: release.id } } });
  if (cover ? !packCanOffer(pack) : !viewerId || (viewerId !== pack.creatorId && !granted)) throw Errors.notFound("This Pack content is private. Claim its exact version first.");
  if (pack.status === "blocked") throw Errors.gone("This Pack was blocked. Your claim receipt is retained.");
  const snapshot = packSnapshotSchema.parse(release.manifest);
  const item = snapshot.items.find(item => item.id === (cover ? snapshot.coverAssetId : itemId));
  if (!item || (cover && item.type !== "image")) throw Errors.notFound("Pack asset not found");
  return { pack, release, item };
}
async function packContent(request: Request, packId: string, releaseId: string, itemId: string, viewerId?: string, cover = false) {
  const read = await readableContent(packId, releaseId, itemId, viewerId, cover);
  if (!providers.blob.getPrivate) throw Errors.unavailable("Pack storage is unavailable");
  const blob = await providers.blob.getPrivate({ key: read.item.storageKey });
  if (!blob.ok) throw Errors.unavailable("This Pack file is temporarily unavailable. Your claim is retained.");
  // Block, account changes and cover withdrawal during I/O must win before bytes escape.
  await readableContent(packId, read.release.id, read.item.id, viewerId, cover);
  if (blob.data.body.byteLength !== read.item.sizeBytes || createHash("sha256").update(blob.data.body).digest("hex") !== read.item.sha256) throw Errors.unavailable("The Pack file failed its integrity check. Your claim is retained.");
  const download = new URL(request.url).searchParams.get("download") === "1";
  return mediaByteResponse(request, blob.data.body, { ...noStore, "content-type": read.item.contentType, "x-content-type-options": "nosniff", ...(download ? { "content-disposition": `attachment; filename="pack-${read.release.id}-${read.item.type}.${read.item.contentType.split("/")[1]?.replace("x-", "") ?? "bin"}"` } : {}) });
}

async function sources(request: Request, viewerId: string) {
  const scope = canonicalJsonHash({ sources: viewerId });
  const after = cursor(request, scope);
  const rows = await prisma.mediaAsset.findMany({ where: { ownerId: viewerId, deletedAt: null, ...(after ? { OR: [{ createdAt: { lt: new Date(after.at) } }, { createdAt: new Date(after.at), id: { lt: after.id } }] } : {}) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 41 });
  const selected = rows.slice(0, 40), last = selected.at(-1);
  return ok({ items: selected.filter(asset => packSourceUsable(asset, viewerId)).map(asset => ({ id: asset.id, type: asset.type, url: `/api/v1/media/${encodeURIComponent(asset.id)}/content` })), nextCursor: rows.length > 40 && last ? Buffer.from(JSON.stringify({ scope, id: last.id, at: last.createdAt.toISOString() })).toString("base64url") : null }, { headers: noStore });
}

export async function packLibrary(viewerId: string) {
  const [owned, grants] = await Promise.all([
    prisma.pack.findMany({ where: { creatorId: viewerId }, include: packInclude, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 100 }),
    prisma.packGrant.findMany({ where: { userId: viewerId }, include: { release: { include: { pack: { include: packInclude } } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100 }),
  ]);
  return [...owned.map(pack => ({ id: pack.id, type: "pack", title: pack.title, description: `${pack.status} · ${packContentSchema.parse(pack.draftContent).items.length} assets`, href: `/packs/${encodeURIComponent(pack.id)}`, ...(summary(pack, viewerId).coverUrl ? { image: summary(pack, viewerId).coverUrl } : {}) })),
    ...grants.map(grant => ({ id: grant.id, type: "pack", title: grant.release.title, description: `Claimed version ${grant.release.version} · ${grant.release.pack.status}`, href: `/packs/${encodeURIComponent(grant.release.packId)}?release=${encodeURIComponent(grant.releaseId)}` }))];
}

export async function dispatchPacks(request: Request, segments: string[]): Promise<Response | null> {
  if (segments[0] !== "packs") return null;
  const [, id, action, releaseId, items, itemId, content, extra] = segments;
  if (extra) throw Errors.notFound();
  const ctx = await getAuthCtx(request); requireAgeGate(ctx);
  let viewerId = ctx.userId;
  if (request.method !== "GET" || id === "sources" || ["mine", "claimed"].includes(new URL(request.url).searchParams.get("scope") ?? "")) {
    viewerId = requireUser(ctx).id; requireAgeVerified(ctx);
  }
  if (ctx.ageVerificationStatus !== "not_required" && ctx.ageVerificationStatus !== "verified") viewerId = undefined;
  if (request.method === "GET" && !id) return listPacks(request, viewerId);
  if (request.method === "GET" && id === "sources" && !action && viewerId) return sources(request, viewerId);
  if (request.method === "GET" && id && action === "cover" && !releaseId) return packContent(request, id, "", "", viewerId, true);
  if (request.method === "GET" && id && action === "releases" && releaseId && items === "items" && itemId && content === "content") return packContent(request, id, releaseId, itemId, viewerId);
  if (request.method === "GET" && id && !action) {
    const pack = await prisma.pack.findUnique({ where: { id }, include: packInclude }); if (!pack) throw Errors.notFound("Pack not found");
    return ok(await packDetail(pack, viewerId, new URL(request.url).searchParams.get("release") ?? undefined), { headers: noStore });
  }
  if (viewerId) {
    if (request.method === "POST" && !id) return savePack(request, viewerId);
    if (request.method === "PATCH" && id && !action) return savePack(request, viewerId, id);
    if (request.method === "POST" && id && !releaseId) {
      if (action === "publish") return publishPack(request, id, viewerId);
      if (action === "withdraw") return withdrawPack(request, id, viewerId);
      if (action === "claim") return claimPack(request, id, viewerId);
    }
  }
  throw Errors.notFound();
}

export function listAdminPacks(request: Request) { return listPacks(request, undefined, true); }

export async function getAdminPack(request: Request, id: string) {
  await actorWithPermission(request, "content.asset.read");
  const pack = await prisma.pack.findUnique({ where: { id }, include: packInclude });
  if (!pack) throw Errors.notFound("Pack not found");
  return ok(await packDetail(pack, undefined, undefined, true), { headers: noStore });
}

export async function blockAdminPack(request: Request, id: string) {
  const actor = await actorWithPermission(request, "safety.review.write");
  const body = adminPackBlockRequestSchema.parse(await adminJsonBody(request, "adminPackBlockRequestSchema+idempotency-key"));
  if (body.confirmation !== id) throw Errors.badRequest("Confirmation did not match the Pack");
  const result = await executeAtomicIdempotentMutation({
    environment: env.APP_ENV, actor, idempotencyKey: requireIdempotencyKey(request),
    requestId: request.headers.get("x-request-id") || crypto.randomUUID(),
    commandType: "pack.block", target: { type: "pack", id }, expectedVersion: body.version, payload: body,
    validateResult: value => adminPackDetailResponseSchema.parse(value),
    mutate: async tx => {
      const current = await lockPack(tx, id, body.version);
      if (current.status === "blocked") throw Errors.conflict("This Pack is already blocked. Reload its current state.");
      const updated = await tx.pack.update({ where: { id }, data: { status: "blocked", blockedReason: body.reason, version: { increment: 1 } }, include: packInclude });
      await tx.adminAuditLog.create({ data: {
        actorId: actor.id, actorRole: actor.role, action: "pack.block", targetType: "pack", targetId: id,
        reason: body.reason, before: toInputJson({ status: current.status, version: current.version }),
        after: toInputJson({ status: updated.status, version: updated.version }),
      } });
      return packDetail(updated, undefined, undefined, true, tx);
    },
  });
  return ok(result, { headers: noStore });
}
