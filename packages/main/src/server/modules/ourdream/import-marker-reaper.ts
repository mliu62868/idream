import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { providers } from "@/server/providers";
import type { BlobStore } from "@/server/providers/types";
import { findActiveAccountDeletionLegalHold } from "./import-legal-hold";

const STAGE_ID = /^media_url_stage_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RANDOM_KEY = /^imports\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LEASE_MS = 60_000;
const RETRY_MS = 60_000;
const RECHECK_MS = 24 * 60 * 60 * 1_000;

type MarkerIdentity = { stageId: string; key: string; authority: string };

function assertIdentity(input: MarkerIdentity): void {
  // No stable account identifier, URL, or other user content may survive
  // account deletion in this cross-account reaping authority.
  if (!STAGE_ID.test(input.stageId) || !RANDOM_KEY.test(input.key) || !/^[a-f0-9]{64}$/.test(input.authority)) throw new Error("Invalid import marker authority");
}

/** Caller holds the User root lock and creates the matching stage atomically. */
export async function reserveImportMarker(tx: Prisma.TransactionClient, input: MarkerIdentity): Promise<void> {
  assertIdentity(input);
  await tx.importMarkerReaper.create({ data: { id: input.stageId, storageKey: input.key, authorityHash: input.authority, status: "dormant" } });
}

/**
 * Caller holds User -> canonical -> stage locks and commits the marker key to
 * the completed asset in the same transaction. A claimed key cannot win.
 */
export async function retireImportMarker(tx: Prisma.TransactionClient, input: MarkerIdentity): Promise<void> {
  assertIdentity(input);
  const removed = await tx.importMarkerReaper.deleteMany({ where: { id: input.stageId, storageKey: input.key, authorityHash: input.authority, status: "dormant" } });
  if (removed.count !== 1) throw new Error("Import marker cleanup authority is missing or already claimed");
}

/**
 * Caller holds User -> canonical -> stage locks and irreversibly prevents the
 * writer from promoting this stage (or the User is already inactive). Once
 * armed, the random key must never be reused or transferred to another asset.
 */
export async function armImportMarker(tx: Prisma.TransactionClient, input: MarkerIdentity, now = new Date()): Promise<void> {
  assertIdentity(input);
  const changed = await tx.importMarkerReaper.updateMany({ where: { id: input.stageId, storageKey: input.key, authorityHash: input.authority, status: "dormant" }, data: { status: "pending", nextRunAt: now } });
  if (changed.count === 1) return;
  const existing = await tx.importMarkerReaper.findUnique({ where: { id: input.stageId } });
  if (!existing || existing.storageKey !== input.key || existing.authorityHash !== input.authority || !["pending", "processing"].includes(existing.status)) {
    throw new Error("Import marker cleanup authority is missing or invalid");
  }
}

/**
 * A DELETE acknowledgement cannot prove an indeterminate marker PUT will
 * never arrive later. Retain the random, non-user tombstone and recheck it
 * indefinitely until a future provider-authoritative settlement exists.
 */
export async function dispatchImportMarkerReapers(input: {
  db?: Pick<PrismaClient, "importMarkerReaper" | "$transaction">;
  blob?: Pick<BlobStore, "deleteFenced" | "getFencedStorageAuthority">;
  now?: Date;
  batch?: number;
  signal?: AbortSignal;
} = {}): Promise<{ checked: number; failed: number }> {
  const counts = { checked: 0, failed: 0 };
  if (input.signal?.aborted) return counts;
  const db = input.db ?? prisma;
  const blob = input.blob ?? providers.blob;
  const now = input.now ?? new Date();
  const eligible: Prisma.ImportMarkerReaperWhereInput = { OR: [
    { status: "pending", nextRunAt: { lte: now } },
    { status: "processing", leaseExpiresAt: { lte: now } },
  ] };
  const rows = await db.importMarkerReaper.findMany({
    where: eligible,
    orderBy: [{ nextRunAt: "asc" }, { id: "asc" }],
    take: Math.max(1, Math.min(input.batch ?? 25, 100)),
  });
  for (const row of rows) {
    if (input.signal?.aborted) break;
    const token = randomUUID();
    const claim = await db.importMarkerReaper.updateMany({ where: { id: row.id, attempts: row.attempts, ...eligible }, data: {
      status: "processing", leaseToken: token, leaseExpiresAt: new Date(now.getTime() + LEASE_MS), attempts: { increment: 1 },
    } });
    if (claim.count !== 1) continue;
    let deleted = false;
    try {
      assertIdentity({ stageId: row.id, key: row.storageKey, authority: row.authorityHash });
      const protectedKey = await db.$transaction(async tx => {
        const first = await tx.mediaAsset.findUnique({ where: { id: row.id }, select: { ownerId: true } });
        if (first) {
          await tx.$queryRaw`SELECT id FROM users WHERE id = ${first.ownerId} FOR UPDATE`;
          const stage = await tx.mediaAsset.findUnique({ where: { id: row.id }, select: { ownerId: true, storageKey: true } });
          if (stage && (stage.ownerId !== first.ownerId || stage.storageKey !== row.storageKey || await findActiveAccountDeletionLegalHold(tx, stage.ownerId))) return true;
        }
        // A transferred key must never be erased by an anonymous tombstone.
        return Boolean(await tx.mediaAsset.findFirst({ where: { id: { not: row.id }, OR: [
          { storageKey: row.storageKey }, { metadata: { path: ["blobLocator", "key"], equals: row.storageKey } },
        ] }, select: { id: true } }));
      });
      if (protectedKey) throw new Error("Import marker is retained by existing authority");
      // A configuration/bucket change must not turn a delete on a new store
      // into a false receipt for the old store. Retain the intent for retry.
      if (!blob.getFencedStorageAuthority || blob.getFencedStorageAuthority() !== row.authorityHash) throw new Error("Storage authority changed");
      const timeout = AbortSignal.timeout(20_000);
      const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
      const result = blob.deleteFenced ? await blob.deleteFenced({ key: row.storageKey, signal }) : null;
      deleted = Boolean(result?.ok);
    } catch { /* A durable retry remains; never log the key or provider payload. */ }
    await db.importMarkerReaper.updateMany({ where: { id: row.id, status: "processing", leaseToken: token, attempts: row.attempts + 1 }, data: {
      status: "pending", leaseToken: null, leaseExpiresAt: null,
      nextRunAt: new Date(now.getTime() + (deleted ? RECHECK_MS : RETRY_MS)),
      lastError: deleted ? Prisma.DbNull : { code: "import_marker_reaper_retry" },
    } });
    if (deleted) counts.checked++; else counts.failed++;
  }
  return counts;
}
