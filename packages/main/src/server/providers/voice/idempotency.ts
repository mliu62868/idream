import { createHash } from "node:crypto";

export function voiceArtifactKey(
  idempotencyKey: string,
  extension: string,
) {
  if (!/^\.[a-z0-9]{1,8}$/.test(extension)) {
    throw new Error(`Invalid voice artifact extension: ${extension}`);
  }
  const digest = createHash("sha256").update(idempotencyKey).digest("hex");
  return `voice/${digest}${extension}`;
}

export function voiceChunkIdempotencyKey(
  idempotencyKey: string,
  chunkIndex: number,
  chunkCount: number,
) {
  return chunkCount === 1
    ? idempotencyKey
    : `${idempotencyKey}:chunk:${chunkIndex + 1}`;
}
