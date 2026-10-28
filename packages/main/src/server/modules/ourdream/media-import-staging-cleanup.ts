import { createHash } from "node:crypto";
import { Prisma, type MediaAsset } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { providers } from "@/server/providers";
import type { BlobStore } from "@/server/providers/types";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { armImportMarker } from "./import-marker-reaper";
import { findActiveAccountDeletionLegalHold } from "./import-legal-hold";

// A failed attempt remains recoverable for a day. No age can fence a late
// unfenced PUT: only the marker protocol permits deleting a staged key.
export const IMPORT_STAGING_RETENTION_MS = 24 * 60 * 60 * 1_000;
const RETRY_MS = 60_000;
const BATCH = 25;
const stageIdPattern = /^media_url_stage_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const canonicalIdPattern = /^media_url_import_[0-9a-f]{64}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function record(value: Prisma.JsonValue): Record<string, Prisma.JsonValue | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stageAuthority(asset: MediaAsset): { parentId: string; key: string; storageAuthority: string } | null {
  const metadata = record(asset.metadata);
  const key = asset.storageKey;
  const parts = key?.split("/") ?? [];
  const scopedOwner = createHash("sha256").update(asset.ownerId).digest("hex");
  const validKey = parts.length === 3 && parts[0] === "imports" &&
    (parts[1] === scopedOwner || uuidPattern.test(parts[1] ?? "")) && uuidPattern.test(parts[2] ?? "");
  if (!stageIdPattern.test(asset.id) || asset.type !== "image" || asset.visibility !== "private" ||
      asset.safetyStatus !== "unknown" || asset.deletedAt || metadata.source !== "external_url_import" ||
      metadata.importState !== "staging" || metadata.importWriteProtocol !== "fenced-v1" ||
      typeof metadata.importParentId !== "string" || !canonicalIdPattern.test(metadata.importParentId) ||
      typeof metadata.importStorageAuthority !== "string" || !/^[a-f0-9]{64}$/.test(metadata.importStorageAuthority) ||
      !key || !validKey) return null;
  return { parentId: metadata.importParentId, key, storageAuthority: metadata.importStorageAuthority };
}

/**
 * Reconciles only fenced, abandoned attempts. Historical unfenced PUTs are
 * intentionally not inferred safe from time or from an object being absent.
 */
export async function cleanupExpiredMediaImports(input: {
  now?: Date;
  batch?: number;
  blob?: Pick<BlobStore, "deleteFenced" | "getFencedStorageAuthority">;
  signal?: AbortSignal;
} = {}): Promise<{ deleted: number; expired: number; failed: number }> {
  const counts = { deleted: 0, expired: 0, failed: 0 };
  if (input.signal?.aborted) return counts;
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - IMPORT_STAGING_RETENTION_MS);
  const retryAt = new Date(now.getTime() + RETRY_MS).toISOString();
  const due = { OR: [
    { metadata: { path: ["importCleanupRetryAt"], equals: Prisma.AnyNull } },
    { metadata: { path: ["importCleanupRetryAt"], lt: now.toISOString() } },
  ] } satisfies Prisma.MediaAssetWhereInput;
  const batch = Math.max(1, Math.min(input.batch ?? BATCH, 100));
  const blob = input.blob ?? providers.blob;
  const stages = await prisma.mediaAsset.findMany({
    where: { id: { startsWith: "media_url_stage_" }, safetyStatus: "unknown", deletedAt: null, createdAt: { lte: cutoff },
      metadata: { path: ["importWriteProtocol"], equals: "fenced-v1" }, ...due },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: batch,
  });
  for (const candidate of stages) {
    if (input.signal?.aborted) break;
    const authority = stageAuthority(candidate);
    if (!authority) {
      // Malformed authority must not block every later batch forever.
      await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${candidate.ownerId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM media_assets WHERE id = ${candidate.id} FOR UPDATE`;
        const current = await tx.mediaAsset.findUnique({ where: { id: candidate.id } });
        if (current && current.ownerId === candidate.ownerId && !stageAuthority(current)) {
          await tx.mediaAsset.update({ where: { id: current.id }, data: { metadata: toInputJson({ ...record(current.metadata), importCleanupRetryAt: retryAt }) } });
        }
      });
      counts.failed++;
      continue;
    }
    try {
      const claimed = await prisma.$transaction(async tx => {
        // Match import reservation/writer lock order; recheck after waiting.
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${candidate.ownerId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM media_assets WHERE id = ${authority.parentId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM media_assets WHERE id = ${candidate.id} FOR UPDATE`;
        const stage = await tx.mediaAsset.findUnique({ where: { id: candidate.id } });
        const current = stage && stageAuthority(stage);
        if (!stage || !current || stage.ownerId !== candidate.ownerId || current.parentId !== authority.parentId ||
            current.key !== authority.key || current.storageAuthority !== authority.storageAuthority || stage.createdAt > cutoff ||
            (typeof record(stage.metadata).importCleanupRetryAt === "string" && String(record(stage.metadata).importCleanupRetryAt) > now.toISOString())) return false;
        if (await findActiveAccountDeletionLegalHold(tx, stage.ownerId)) {
          await tx.mediaAsset.update({ where: { id: stage.id }, data: { metadata: toInputJson({ ...record(stage.metadata), importCleanupRetryAt: retryAt }) } });
          return null;
        }
        // Never remove an object which became another asset's authority.
        const reference = await tx.mediaAsset.findFirst({ where: { id: { not: stage.id }, OR: [
          { storageKey: current.key }, { metadata: { path: ["blobLocator", "key"], equals: current.key } },
        ] }, select: { id: true } });
        if (reference) {
          await tx.mediaAsset.update({ where: { id: stage.id }, data: { metadata: toInputJson({ ...record(stage.metadata), importCleanupRetryAt: retryAt }) } });
          return null;
        }
        // Once committed, the writer refuses this stage even if this process
        // crashes or DELETE finishes after its caller's timeout.
        await armImportMarker(tx, { stageId: stage.id, key: current.key, authority: current.storageAuthority }, now);
        await tx.mediaAsset.update({ where: { id: stage.id }, data: { metadata: toInputJson({ ...record(stage.metadata), importCleanupState: "claimed" }) } });
        return true;
      }, { timeout: 45_000 });
      if (claimed !== true) { if (claimed === null) counts.failed++; continue; }
      // This delete happens after durable fencing, outside any transaction.
      // Ordinary S3 DELETE can hide rather than erase historical versions.
      let deleted = false;
      try {
        const result = blob.deleteFenced && blob.getFencedStorageAuthority?.() === authority.storageAuthority
          ? await blob.deleteFenced({ key: authority.key, signal: AbortSignal.timeout(20_000) }) : null;
        deleted = Boolean(result?.ok);
      } catch { /* Keep the durable claim for a later attempt. */ }
      const finalized = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${candidate.ownerId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM media_assets WHERE id = ${authority.parentId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM media_assets WHERE id = ${candidate.id} FOR UPDATE`;
        const stage = await tx.mediaAsset.findUnique({ where: { id: candidate.id } });
        const current = stage && stageAuthority(stage);
        if (!stage || !current || stage.ownerId !== candidate.ownerId || current.parentId !== authority.parentId ||
            current.key !== authority.key || current.storageAuthority !== authority.storageAuthority || record(stage.metadata).importCleanupState !== "claimed") return false;
        const reference = await tx.mediaAsset.findFirst({ where: { id: { not: stage.id }, OR: [
          { storageKey: current.key }, { metadata: { path: ["blobLocator", "key"], equals: current.key } },
        ] }, select: { id: true } });
        if (!deleted || reference) {
          await tx.mediaAsset.update({ where: { id: stage.id }, data: { metadata: toInputJson({ ...record(stage.metadata), importCleanupRetryAt: retryAt }) } });
          return false;
        }
        await tx.mediaAsset.delete({ where: { id: stage.id } });
        return true;
      });
      if (finalized) counts.deleted++;
      else if (!deleted) counts.failed++;
    } catch {
      // An ambiguous commit leaves the durable stage for reconciliation.
      counts.failed++;
    }
  }

  const canonicals = await prisma.mediaAsset.findMany({
    where: { id: { startsWith: "media_url_import_" }, safetyStatus: "unknown", storageKey: null, deletedAt: null,
      createdAt: { lte: cutoff }, metadata: { path: ["importState"], equals: "pending" }, ...due },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: batch,
  });
  for (const candidate of canonicals) {
    if (input.signal?.aborted) break;
    try {
      const expired = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${candidate.ownerId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM media_assets WHERE id = ${candidate.id} FOR UPDATE`;
        const current = await tx.mediaAsset.findUnique({ where: { id: candidate.id } });
        if (!current || current.ownerId !== candidate.ownerId || current.safetyStatus !== "unknown" ||
            current.storageKey || current.createdAt > cutoff || current.deletedAt) return false;
        if (await findActiveAccountDeletionLegalHold(tx, current.ownerId)) return false;
        const metadata = record(current.metadata);
        if (typeof metadata.importCleanupRetryAt === "string" && metadata.importCleanupRetryAt > now.toISOString()) return false;
        if (!canonicalIdPattern.test(current.id) || metadata.source !== "external_url_import" || metadata.importState !== "pending" ||
            typeof metadata.importRequestHash !== "string" || !/^[a-f0-9]{64}$/.test(metadata.importRequestHash)) {
          // Leave malformed evidence untouched except for a retry deadline.
          await tx.mediaAsset.update({ where: { id: current.id }, data: { metadata: toInputJson({ ...metadata, importCleanupRetryAt: retryAt }) } });
          return false;
        }
        // Include historical and foreign-protocol stages: no unproven attempt
        // may be forgotten merely because the canonical intent is old.
        const linked = await tx.mediaAsset.findFirst({ where: { metadata: { path: ["importParentId"], equals: current.id } }, select: { id: true } });
        if (linked) {
          await tx.mediaAsset.update({ where: { id: current.id }, data: { metadata: toInputJson({ ...metadata, importCleanupRetryAt: retryAt }) } });
          return false;
        }
        await tx.mediaAsset.update({ where: { id: current.id }, data: { metadata: {
          source: "external_url_import", synthetic: false, importState: "expired", importRequestHash: metadata.importRequestHash,
        } } });
        return true;
      });
      if (expired) counts.expired++;
    } catch { counts.failed++; }
  }
  return counts;
}
