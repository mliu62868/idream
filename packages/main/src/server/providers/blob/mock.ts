import type { BlobStore } from "../types";
import { resolveLocalBlobRoot } from "@idream/shared/storage/local-blob";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export class MockBlobStore implements BlobStore {
  async putPrivate(input: Parameters<BlobStore["putPrivate"]>[0]) {
    const target = path.join(blobRoot(), input.key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, input.body, { signal: input.signal });
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

  async getPrivate(input: { key: string; signal?: AbortSignal; maxBytes?: number }) {
    try {
      if (input.maxBytes !== undefined && (await stat(path.join(blobRoot(), input.key))).size > input.maxBytes) {
        return { ok: false as const, error: { code: "too_large", message: "Source image is too large", retryable: false } };
      }
      const data = await readFile(path.join(blobRoot(), input.key), { signal: input.signal });
      if (input.maxBytes !== undefined && data.byteLength > input.maxBytes) {
        return { ok: false as const, error: { code: "too_large", message: "Source image is too large", retryable: false } };
      }
      return {
        ok: true as const,
        data: {
          body: new Uint8Array(data),
          contentType: null,
        },
      };
    } catch (error) {
      return {
        ok: false as const,
        error: {
          code: (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "not_found" : "get_failed",
          message: error instanceof Error ? error.message : String(error),
          retryable: error instanceof Error && error.name === "AbortError",
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
