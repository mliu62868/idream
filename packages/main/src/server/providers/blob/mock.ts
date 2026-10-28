import type { BlobStore } from "../types";
import { resolveLocalBlobRoot } from "@idream/shared/storage/local-blob";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export class MockBlobStore implements BlobStore {
  getFencedStorageAuthority(): string {
    const root = path.resolve(blobRoot());
    // Record the actual local directory identity, not merely its path: a
    // replaced directory or retargeted symlink is a different authority.
    mkdirSync(root, { recursive: true });
    const resolved = realpathSync(root);
    const stat = statSync(resolved, { bigint: true });
    return createHash("sha256").update(JSON.stringify(["fenced-storage-v1", "local", resolved, String(stat.dev), String(stat.ino)])).digest("hex");
  }
  async prepareFencedPut(input: { key: string; signal?: AbortSignal }) {
    const target = path.join(blobRoot(), input.key);
    const marker = randomBytes(32);
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, marker, { flag: "wx", signal: input.signal });
      return { ok: true as const, data: { key: input.key, markerEtag: `"${createHash("sha256").update(marker).digest("hex")}"` } };
    } catch (error) {
      return { ok: false as const, error: { code: "fence_prepare_failed", message: error instanceof Error ? error.message : String(error), retryable: true } };
    }
  }

  async putPrivateFenced(input: { key: string; body: Uint8Array; contentType: string; markerEtag: string; signal?: AbortSignal }) {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      input.signal?.throwIfAborted();
      file = await open(path.join(blobRoot(), input.key), "r+");
      const marker = await file.readFile();
      const etag = `"${createHash("sha256").update(marker).digest("hex")}"`;
      if (etag !== input.markerEtag) return { ok: false as const, error: { code: "fenced_put_failed", message: "Marker precondition failed", retryable: false } };
      input.signal?.throwIfAborted();
      // An open file descriptor never recreates a path after unlink: even if
      // deletion wins between this read and write, bytes stay on the unlinked
      // inode rather than resurrecting the object. A key has only one writer.
      await file.truncate(0);
      let offset = 0;
      while (offset < input.body.byteLength) {
        input.signal?.throwIfAborted();
        const written = await file.write(input.body, offset, input.body.byteLength - offset, offset);
        if (written.bytesWritten <= 0) throw new Error("Could not write image bytes");
        offset += written.bytesWritten;
      }
      return { ok: true as const, data: { key: input.key, size: input.body.byteLength } };
    } catch (error) {
      return { ok: false as const, error: { code: "fenced_put_failed", message: error instanceof Error ? error.message : String(error), retryable: false } };
    } finally { await file?.close(); }
  }

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

  async deleteFenced(input: { key: string; signal?: AbortSignal }) {
    try {
      input.signal?.throwIfAborted();
      return await this.delete(input);
    } catch (error) {
      return { ok: false as const, error: { code: "fenced_delete_failed", message: error instanceof Error ? error.message : String(error), retryable: true } };
    }
  }
}

function blobRoot() {
  return resolveLocalBlobRoot();
}
