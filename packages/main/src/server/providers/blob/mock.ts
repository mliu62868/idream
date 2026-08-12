import type { BlobStore } from "../types";
import { resolveLocalBlobRoot } from "@idream/shared/storage/local-blob";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

  async getPrivate(input: { key: string }) {
    try {
      return {
        ok: true as const,
        data: {
          body: new Uint8Array(await readFile(path.join(blobRoot(), input.key))),
          contentType: null,
        },
      };
    } catch (error) {
      return {
        ok: false as const,
        error: {
          code: "not_found",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        },
      };
    }
  }

  async delete(input: Parameters<BlobStore["delete"]>[0]) {
    // S3 DELETE is idempotent (including missing objects); the local adapter
    // must preserve the same crash-retry contract.
    await rm(path.join(blobRoot(), input.key), { force: true });
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
