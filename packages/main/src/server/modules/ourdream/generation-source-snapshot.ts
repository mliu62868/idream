import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { Errors } from "@/server/lib/errors";

export const GENERATION_SOURCE_CHUNK_BYTES = 64 * 1024;
export const GENERATION_SOURCE_MAX_BYTES = 64 * 1024 * 1024;

export type FrozenGenerationSource = { id: string; sha256: string; sizeBytes: number; contentType: string };

/** A snapshot committed before admission, plus the asset row it was read through. */
export type PrefrozenGenerationSource = FrozenGenerationSource & {
  assetId: string;
  locator: string;
  width: number;
  height: number;
  pages: number;
};

// Up to 64 MiB of bytes and a full decode per reader: this bounds process memory.
const MAX_ACTIVE_SNAPSHOT_READS = 2;
let activeSnapshotReads = 0;
const snapshotReadWaiters: Array<() => void> = [];

/**
 * INVARIANT: `waitMs` is only for a caller holding no locks. Queueing inside an
 * authority transaction would stretch every lock it holds by the wait, so those
 * callers keep the immediate 503.
 */
export async function withGenerationSnapshotSlot<T>(
  operation: () => Promise<T>,
  { waitMs = 0 }: { waitMs?: number } = {},
): Promise<T> {
  const busy = () => Errors.unavailable("Image verification is busy. Please try again.");
  if (activeSnapshotReads < MAX_ACTIVE_SNAPSHOT_READS) activeSnapshotReads++;
  else if (waitMs <= 0) throw busy();
  else {
    // A released slot passes straight to the next waiter, so the count never drops
    // and a newcomer cannot overtake the queue.
    await new Promise<void>((resolve, reject) => {
      const waiter = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        snapshotReadWaiters.splice(snapshotReadWaiters.indexOf(waiter), 1);
        reject(busy());
      }, waitMs);
      snapshotReadWaiters.push(waiter);
    });
  }
  try { return await operation(); } finally {
    const next = snapshotReadWaiters.shift();
    if (next) next();
    else activeSnapshotReads--;
  }
}

/** Identifies what the asset row pointed at; a replaced asset changes this. */
export function generationSourceLocator(asset: { storageKey: string | null; url: string | null }) {
  return JSON.stringify([asset.storageKey, asset.url]);
}

/**
 * Safe with or without account/media locks, so admission can run this before it
 * takes them. A review draft may also freeze before admission.
 * INVARIANT: the snapshot row and all its chunks commit together, so a row that
 * another transaction can see is always complete.
 */
export async function freezeGenerationSource(
  tx: Prisma.TransactionClient,
  input: { userId: string; bytes: Uint8Array; contentType: string },
): Promise<FrozenGenerationSource> {
  if (!input.bytes.byteLength || input.bytes.byteLength > GENERATION_SOURCE_MAX_BYTES) throw new Error("Invalid generation source size");
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  // Freezing no longer implies the account lock. This narrow key lets two freezes of
  // the same bytes share one row instead of colliding on (userId, sha256), and its
  // holder waits for nothing else, so it cannot join a lock cycle.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`generation-source-snapshot:${input.userId}:${sha256}`}))`;
  const previous = await tx.generationSourceSnapshot.findUnique({ where: { userId_sha256: { userId: input.userId, sha256 } } });
  if (previous) {
    if (previous.sizeBytes !== input.bytes.byteLength || previous.contentType !== input.contentType) throw new Error("Conflicting generation source snapshot");
    return previous;
  }
  const snapshot = await tx.generationSourceSnapshot.create({ data: {
    userId: input.userId, sha256, contentType: input.contentType, sizeBytes: input.bytes.byteLength,
  } });
  // Bounded batches avoid pg's text bytea encoder materializing the full
  // 64 MiB source as a single several-times-larger JS string.
  for (let start = 0, ordinal = 0; start < input.bytes.byteLength; start += GENERATION_SOURCE_CHUNK_BYTES * 16, ordinal += 16) {
    const chunks = [];
    for (let offset = start, index = ordinal; offset < Math.min(input.bytes.byteLength, start + GENERATION_SOURCE_CHUNK_BYTES * 16); offset += GENERATION_SOURCE_CHUNK_BYTES, index++) {
      chunks.push({ snapshotId: snapshot.id, ordinal: index, bytes: Uint8Array.from(input.bytes.subarray(offset, offset + GENERATION_SOURCE_CHUNK_BYTES)) });
    }
    await tx.generationSourceSnapshotChunk.createMany({ data: chunks });
  }
  return snapshot;
}
