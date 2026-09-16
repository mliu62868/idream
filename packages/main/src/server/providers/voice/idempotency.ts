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

// SPEC: file extension for a synthesized voice artifact, derived from the
//   provider's content type. Lives beside voiceArtifactKey because the two are
//   always used together to name one stored object.
export function audioFileExtension(contentType: string) {
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
  const extensions: Record<string, string> = {
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/ogg": ".ogg",
    "audio/flac": ".flac",
    "audio/webm": ".webm",
  };
  return (mediaType && extensions[mediaType]) || ".wav";
}
