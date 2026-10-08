import { describe, expect, it } from "vitest";
import { audioFileExtension, voiceArtifactKey, voiceArtifactKeys, voiceProviderIdempotencyKey } from "./idempotency";

describe("Voice artifact erasure names", () => {
  it("enumerates every accepted content type including legacy formats and fallback WAV once", () => {
    const key = voiceProviderIdempotencyKey("request-owned-by-main");
    const keys = voiceArtifactKeys(key);
    expect(keys).toHaveLength(5);
    for (const contentType of ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/ogg", "audio/flac", "audio/webm", "application/octet-stream"]) {
      expect(keys).toContain(voiceArtifactKey(key, audioFileExtension(contentType)));
    }
    expect(keys).toEqual(expect.arrayContaining([expect.stringMatching(/^voice\/[a-f0-9]{64}\.ogg$/), expect.stringMatching(/^voice\/[a-f0-9]{64}\.flac$/), expect.stringMatching(/^voice\/[a-f0-9]{64}\.webm$/)]));
    expect(voiceArtifactKeys(voiceProviderIdempotencyKey("another-request"))).not.toEqual(keys);
  });
});
