import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { Errors } from "@/server/lib/errors";

export const GENERATION_SOURCE_CHUNK_BYTES = 64 * 1024;
export const GENERATION_SOURCE_MAX_BYTES = 64 * 1024 * 1024;

export type FrozenGenerationSource = { id: string; sha256: string; sizeBytes: number; contentType: string };

let activeSnapshotReads = 0;
export async function withGenerationSnapshotSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (activeSnapshotReads >= 2) throw Errors.unavailable("Video source verification is busy. Please try again.");
  activeSnapshotReads++;
  try { return await operation(); } finally { activeSnapshotReads--; }
}

/** The caller holds the account/media locks. Snapshot and debit commit together. */
export async function freezeGenerationSource(
  tx: Prisma.TransactionClient,
  input: { userId: string; bytes: Uint8Array; contentType: string },
): Promise<FrozenGenerationSource> {
  if (!input.bytes.byteLength || input.bytes.byteLength > GENERATION_SOURCE_MAX_BYTES) throw new Error("Invalid generation source size");
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
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
