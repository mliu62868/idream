import type { BlobStore } from "../types";

export class MockBlobStore implements BlobStore {
  async putPrivate(input: Parameters<BlobStore["putPrivate"]>[0]) {
    return {
      ok: true as const,
      data: {
        key: input.key,
        size: input.body.byteLength,
      },
    };
  }

  async signGetUrl(input: Parameters<BlobStore["signGetUrl"]>[0]) {
    return {
      ok: true as const,
      data: {
        url: `https://mock-blob.idream.local/${encodeURIComponent(input.key)}?ttl=${input.expiresInSeconds}`,
      },
    };
  }

  async delete() {
    return {
      ok: true as const,
      data: {
        deleted: true as const,
      },
    };
  }
}
