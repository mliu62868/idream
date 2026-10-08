import { createHash } from "node:crypto";

export function voiceProviderIdempotencyKey(requestId: string) {
  // One provider result per logical request across lease attempts/restarts.
  return `voice:${requestId}:provider`;
}

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

// SPEC: file extension for a synthesized voice artifact, derived from the
//   provider's content type. Lives beside voiceArtifactKey because the two are
//   always used together to name one stored object.
export function audioFileExtension(contentType: string) {
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
  return (mediaType && AUDIO_FILE_EXTENSIONS[mediaType]) || ".wav";
}

const AUDIO_FILE_EXTENSIONS: Record<string, string> = {
  "audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/wav": ".wav",
  "audio/x-wav": ".wav", "audio/ogg": ".ogg", "audio/flac": ".flac", "audio/webm": ".webm",
};

// An undelivered/ambiguous commit may have no MediaAsset. Account erasure can
// still enumerate every artifact name accepted by the canonical audio port.
export function voiceArtifactKeys(idempotencyKey: string) {
  return [...new Set(Object.values(AUDIO_FILE_EXTENSIONS))].map(extension => voiceArtifactKey(idempotencyKey, extension));
}
