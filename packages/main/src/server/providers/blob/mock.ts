import type { BlobStore } from "../types";
import { resolveLocalBlobRoot } from "@idream/shared/storage/local-blob";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export class MockBlobStore implements BlobStore {
  async putPrivate(input: Parameters<BlobStore["putPrivate"]>[0]) {
    const target = path.join(blobRoot(), input.key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, input.body);
    return {
      ok: true as const,
      data: {
        key: input.key,
        size: input.body.byteLength,
      },
    };
  }

  async signGetUrl(input: Parameters<BlobStore["signGetUrl"]>[0]) {
    const query = new URLSearchParams({
      ttl: String(input.expiresInSeconds),
    });
    if (input.downloadFilename) {
      query.set("download", "1");
      query.set("filename", input.downloadFilename);
    }

    return {
      ok: true as const,
      data: {
        url: `https://mock-blob.idream.local/${encodeURIComponent(input.key)}?${query.toString()}`,
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

function blobRoot() {
  return resolveLocalBlobRoot();
}
