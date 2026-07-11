import { describe, expect, it } from "vitest";
import { generationManifestChecksum, generationCompletionManifestSchema } from "./durable";

describe("durable cross-service contracts", () => {
  it("produces a stable checksum independent of object key order", () => {
    const manifest = generationCompletionManifestSchema.parse({
      version: 1,
      attemptId: "attempt-1",
      attemptNo: 1,
      requestId: "request-1",
      generationJobId: "job-1",
      mode: "image",
      provider: "provider-1",
      providerRequestId: null,
      completedAt: "2026-07-11T12:00:00.000Z",
      assets: [{ ordinal: 0, key: "a.webp", contentType: "image/webp", providerKey: null }],
      usage: { model: "m", gpuSeconds: 1 },
    });
    expect(generationManifestChecksum(manifest)).toBe(
      generationManifestChecksum({ ...manifest, usage: { gpuSeconds: 1, model: "m" } }),
    );
  });
});
