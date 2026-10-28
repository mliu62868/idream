import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { readRemoteImage, verifySourceImageBytes, withRemoteImageValidationLimit } from "@/server/lib/safe-remote-image";
import { providers } from "@/server/providers";
import { reserveImportMarker, retireImportMarker } from "./import-marker-reaper";

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const importId = (userId: string, key: string) => `media_url_import_${digest(JSON.stringify([userId, key]))}`;
const unavailable = () => Errors.unavailable("Image import is temporarily unavailable. Check the original request before retrying.");

function validateUrl(value: string) {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw Errors.badRequest("Enter a valid public image URL."); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || !parsed.hostname) {
    throw Errors.badRequest("Enter a public HTTP or HTTPS image URL without credentials.");
  }
  return parsed;
}

function validateImport(asset: { ownerId: string; metadata: Prisma.JsonValue; deletedAt: Date | null; safetyStatus: string }, userId: string, requestHash?: string) {
  const metadata = asset.metadata && typeof asset.metadata === "object" && !Array.isArray(asset.metadata) ? asset.metadata : {};
  if (asset.ownerId !== userId || metadata.source !== "external_url_import" || (requestHash && metadata.importRequestHash !== requestHash)) {
    throw Errors.conflict("This import request belongs to a different image. Start a new import.");
  }
  if (asset.deletedAt) throw Errors.gone("This imported image was deleted. Start a new import.");
  if (metadata.importState === "expired") throw Errors.gone("This import request expired. Start a new import.");
  return metadata.importState === "completed" && asset.safetyStatus === "passed";
}

async function lockActiveUser(tx: Prisma.TransactionClient, userId: string) {
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
  const user = await tx.user.findUnique({ where: { id: userId }, select: { status: true, deletedAt: true } });
  if (!user || user.status !== "active" || user.deletedAt) throw Errors.unauthorized("Account access is no longer active.");
}

export async function readRemoteImageImport(userId: string, key: string) {
  const id = importId(userId, key);
  const asset = await prisma.mediaAsset.findUnique({ where: { id } });
  if (!asset || !validateImport(asset, userId)) throw Errors.notFound("This import has not completed. Retry with the same request.");
  return { assetId: id };
}

export async function createRemoteImageImport(userId: string, key: string, url: string) {
  const parsed = validateUrl(url);
  const requestHash = digest(url);
  const id = importId(userId, key);
  const existing = await prisma.mediaAsset.findUnique({ where: { id } });
  if (existing && validateImport(existing, userId, requestHash)) return { assetId: id, replayed: true };

  return withRemoteImageValidationLimit(async () => {
    // The configured mock moderation examines text; never persist or send the
    // URL query, which may contain a private signed token, to moderation.
    const moderation = await providers.moderation.check({ targetType: "image", content: parsed.pathname });
    if (!moderation.ok) throw Errors.unavailable("Image moderation is temporarily unavailable.");
    if (moderation.data.status !== "passed") throw Errors.conflict("This image could not be imported.");
    const remote = await readRemoteImage(url);
    const verified = await verifySourceImageBytes(remote.bytes);
    const authority = providers.blob.getFencedStorageAuthority?.();
    if (!authority || !/^[a-f0-9]{64}$/.test(authority) || !providers.blob.prepareFencedPut || !providers.blob.putPrivateFenced) throw unavailable();

    // A durable canonical intent and a distinct per-attempt staging row exist
    // before any Blob write. Failed or ambiguous PUTs never reuse their key.
    const stageId = `media_url_stage_${randomUUID()}`;
    // An indeterminate marker PUT can leave only random, non-user bytes.
    // Its key must also avoid embedding a stable account identifier.
    const stageKey = `imports/${randomUUID()}/${randomUUID()}`;
    const reserved = await prisma.$transaction(async tx => {
      await lockActiveUser(tx, userId);
      const current = await tx.mediaAsset.findUnique({ where: { id } });
      if (current && validateImport(current, userId, requestHash)) return false;
      if (!current) await tx.mediaAsset.create({ data: {
        id, ownerId: userId, type: "image", url: "", storageKey: null,
        contentType: verified.contentType, visibility: "private", safetyStatus: "unknown",
        metadata: { source: "external_url_import", synthetic: false, importState: "pending", importRequestHash: requestHash },
      } });
      await tx.mediaAsset.create({ data: {
        id: stageId, ownerId: userId, type: "image", url: "", storageKey: stageKey,
        contentType: verified.contentType, visibility: "private", safetyStatus: "unknown",
        metadata: { source: "external_url_import", synthetic: false, importState: "staging", importParentId: id, importWriteProtocol: "fenced-v1", importStorageAuthority: authority },
      } });
      await reserveImportMarker(tx, { stageId, key: stageKey, authority });
      return true;
    });
    if (!reserved) return { assetId: id, replayed: true };

    // Marker creation can finish after its database transaction times out.
    // Start it only while holding the shared locks, then use a fresh lock
    // transaction before starting the sensitive PUT.
    if (!providers.blob.prepareFencedPut || !providers.blob.putPrivateFenced || providers.blob.getFencedStorageAuthority?.() !== authority) throw unavailable();
    const prepareFenced = providers.blob.prepareFencedPut.bind(providers.blob);
    const putFenced = providers.blob.putPrivateFenced.bind(providers.blob);
    const signal = AbortSignal.timeout(20_000);
    const marker = await prisma.$transaction(async tx => {
      await lockActiveUser(tx, userId);
      await tx.$queryRaw`SELECT id FROM media_assets WHERE id = ${id} FOR UPDATE`;
      const stage = await tx.mediaAsset.findUnique({ where: { id: stageId } });
      const metadata = stage?.metadata && typeof stage.metadata === "object" && !Array.isArray(stage.metadata) ? stage.metadata : {};
      if (!stage || stage.ownerId !== userId || stage.storageKey !== stageKey || metadata.importCleanupState === "claimed" || metadata.importStorageAuthority !== authority || providers.blob.getFencedStorageAuthority?.() !== authority) throw unavailable();
      return prepareFenced({ key: stageKey, signal });
    }, { timeout: 45_000 });
    if (!marker.ok || marker.data.key !== stageKey) throw unavailable();

    return prisma.$transaction(async tx => {
      // Account deletion and retries share the User-root lock. Each PUT has a
      // distinct durable key, so an abort with a late server-side completion
      // cannot overwrite the successfully committed source of another retry.
      await lockActiveUser(tx, userId);
      await tx.$queryRaw`SELECT id FROM media_assets WHERE id = ${id} FOR UPDATE`;
      const asset = await tx.mediaAsset.findUnique({ where: { id } });
      if (!asset) throw unavailable();
      if (validateImport(asset, userId, requestHash)) {
        // This attempt may already have a marker. Keep its staging authority
        // for the expiry worker, even though another attempt won the request.
        return { assetId: id, replayed: true };
      }
      const stage = await tx.mediaAsset.findUnique({ where: { id: stageId } });
      if (!stage || stage.ownerId !== userId || stage.storageKey !== stageKey) throw unavailable();
      const stageMetadata = stage.metadata && typeof stage.metadata === "object" && !Array.isArray(stage.metadata) ? stage.metadata : {};
      // A cleanup claim is durable across process and network failures; never
      // start a PUT for a key whose deletion may still complete later.
      if (stageMetadata.importCleanupState === "claimed" || stageMetadata.importStorageAuthority !== authority || providers.blob.getFencedStorageAuthority?.() !== authority) throw unavailable();
      // A successful delete of the known marker fences a timed-out PUT at the
      // storage authority; client-side cancellation alone cannot do so.
      const stored = await putFenced({ key: stageKey, body: verified.bytes, contentType: verified.contentType, markerEtag: marker.data.markerEtag, signal });
      if (!stored.ok || stored.data.key !== stageKey || stored.data.size !== verified.bytes.byteLength) throw unavailable();
      // The unique Blob locator moves atomically from staging to the completed
      // asset. If commit is ambiguous either row still records the same key.
      await tx.mediaAsset.update({ where: { id: stageId }, data: { storageKey: null } });
      await tx.mediaAsset.update({ where: { id }, data: {
        storageKey: stageKey, contentType: verified.contentType, safetyStatus: "passed",
        metadata: { source: "external_url_import", synthetic: false, importState: "completed", importRequestHash: requestHash, importStorageAuthority: authority, sha256: digest(verified.bytes), sizeBytes: verified.bytes.byteLength },
      } });
      await retireImportMarker(tx, { stageId, key: stageKey, authority });
      await tx.mediaAsset.delete({ where: { id: stageId } });
      return { assetId: id, replayed: false };
    }, { timeout: 45_000 });
  });
}
