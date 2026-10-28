import { createHash, createHmac, randomBytes } from "node:crypto";

export type BlobProviderResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: { code: string; message: string; retryable: boolean };
    };

export interface S3CompatibleBlobStoreConfig {
  endpoint: string;
  bucket: string;
  region?: string;
  provider?: "s3" | "r2";
  accessKeyId: string;
  secretAccessKey: string;
  /** Operator attests atomic If-Match/delete ordering and immutable unversioned configuration. */
  fencedWriteSemantics?: "verified-unversioned-v1";
  fetchImpl?: typeof fetch;
}

export class S3CompatibleBlobStore {
  private readonly endpoint: URL;
  private readonly bucket: string;
  private readonly region: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly provider: "s3" | "r2";
  private readonly fencedWriteSemantics?: "verified-unversioned-v1";

  constructor(config: S3CompatibleBlobStoreConfig) {
    this.endpoint = new URL(config.endpoint);
    this.bucket = config.bucket;
    this.region = config.region ?? "auto";
    this.provider = config.provider ?? "s3";
    this.accessKeyId = config.accessKeyId;
    this.secretAccessKey = config.secretAccessKey;
    this.fencedWriteSemantics = config.fencedWriteSemantics;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  getFencedStorageAuthority(): string {
    const endpoint = new URL(this.endpoint);
    endpoint.username = "";
    endpoint.password = "";
    endpoint.search = "";
    endpoint.hash = "";
    endpoint.pathname = endpoint.pathname === "/" ? "" : endpoint.pathname.replace(/\/$/, "");
    return sha256Hex(JSON.stringify(["fenced-storage-v1", this.provider, endpoint.toString(), this.bucket, this.region]));
  }

  async putPrivate(input: {
    key: string;
    body: Uint8Array;
    contentType: string;
    signal?: AbortSignal;
  }): Promise<BlobProviderResult<{ key: string; size: number }>> {
    const target = this.objectUrl(input.key);
    const payloadHash = sha256Hex(input.body);
    const headers = this.signedHeaders({
      method: "PUT",
      target,
      payloadHash,
      extraHeaders: {
        "cache-control": "private, no-store, max-age=0",
        "content-type": input.contentType,
        "x-amz-content-sha256": payloadHash,
      },
    });

    try {
      const response = await this.fetchImpl(target, {
        method: "PUT",
        headers,
        body: new Blob([arrayBuffer(input.body)], { type: input.contentType }),
        signal: input.signal,
      });
      if (!response.ok) return blobFailure("put_failed", response);
      return {
        ok: true,
        data: { key: input.key, size: input.body.byteLength },
      };
    } catch (error) {
      return networkFailure("put_failed", error);
    }
  }

  /**
   * Establish an immutable, non-user-data marker for a single PUT attempt.
   * A key is never reused: after marker deletion a late If-Match PUT must fail.
   * The deployment must prevent bucket-versioning changes and use an endpoint
   * that guarantees S3 conditional-write ordering; an ordinary DELETE cannot
   * erase historical versions. Unsupported or ambiguous endpoints fail closed.
   */
  async prepareFencedPut(input: { key: string; signal?: AbortSignal }): Promise<BlobProviderResult<{ key: string; markerEtag: string }>> {
    const versioning = await this.isUnversioned(input.signal);
    if (!versioning.ok) return versioning;
    const marker = randomBytes(32);
    const target = this.objectUrl(input.key);
    const hash = sha256Hex(marker);
    try {
      const response = await this.fetchImpl(target, {
        method: "PUT", signal: input.signal, body: new Blob([arrayBuffer(marker)]),
        headers: this.signedHeaders({ method: "PUT", target, payloadHash: hash, extraHeaders: {
          "cache-control": "private, no-store, max-age=0", "content-type": "application/octet-stream",
          "if-none-match": "*", "x-amz-content-sha256": hash,
        } }),
      });
      if (!response.ok) return blobFailure("fence_prepare_failed", response);
      const firstEtag = response.headers.get("etag");
      if (!firstEtag || !/^"[A-Za-z0-9._-]{1,128}"$/.test(firstEtag) || response.headers.has("x-amz-version-id")) {
        return fenceFailure("The object storage did not return an unversioned marker ETag");
      }
      const deleted = await this.delete({ key: input.key, signal: input.signal });
      if (!deleted.ok) return fenceFailure("Unable to delete the condition probe");
      const checkedMissing = await this.checkMissingObjectCondition(input.key, firstEtag, input.signal);
      if (!checkedMissing.ok) return checkedMissing;
      const replacement = randomBytes(32);
      const replacementHash = sha256Hex(replacement);
      const restored = await this.fetchImpl(target, {
        method: "PUT", signal: input.signal, body: new Blob([arrayBuffer(replacement)]),
        headers: this.signedHeaders({ method: "PUT", target, payloadHash: replacementHash, extraHeaders: {
          "cache-control": "private, no-store, max-age=0", "content-type": "application/octet-stream",
          "if-none-match": "*", "x-amz-content-sha256": replacementHash,
        } }),
      });
      const etag = restored.headers.get("etag");
      if (!restored.ok || !etag || !/^"[A-Za-z0-9._-]{1,128}"$/.test(etag) || restored.headers.has("x-amz-version-id")) {
        return fenceFailure("Unable to recreate an unversioned marker");
      }
      const overwriteProbe = randomBytes(32);
      const overwriteHash = sha256Hex(overwriteProbe);
      const overwrite = await this.fetchImpl(target, {
        method: "PUT", signal: input.signal, body: new Blob([arrayBuffer(overwriteProbe)]),
        headers: this.signedHeaders({ method: "PUT", target, payloadHash: overwriteHash, extraHeaders: {
          "cache-control": "private, no-store, max-age=0", "content-type": "application/octet-stream",
          "if-none-match": "*", "x-amz-content-sha256": overwriteHash,
        } }),
      });
      if (overwrite.status !== 412) return fenceFailure("Object storage did not enforce marker uniqueness");
      // A compatibility endpoint that ignores If-Match would silently corrupt
      // an erase. Probe a deliberately wrong condition using non-sensitive
      // bytes, and never upload user data unless the endpoint rejects it.
      const probe = randomBytes(32);
      const probeHash = sha256Hex(probe);
      const mismatch = '"idream-fence-mismatch-' + randomBytes(16).toString("hex") + '"';
      const checked = await this.fetchImpl(target, {
        method: "PUT", signal: input.signal, body: new Blob([arrayBuffer(probe)]),
        headers: this.signedHeaders({ method: "PUT", target, payloadHash: probeHash, extraHeaders: {
          "cache-control": "private, no-store, max-age=0", "content-type": "application/octet-stream",
          "if-match": mismatch, "x-amz-content-sha256": probeHash,
        } }),
      });
      if (checked.status !== 412) return fenceFailure("Object storage did not enforce the marker precondition");
      return { ok: true, data: { key: input.key, markerEtag: etag } };
    } catch (error) { return networkFailure("fence_prepare_failed", error); }
  }

  async putPrivateFenced(input: { key: string; body: Uint8Array; contentType: string; markerEtag: string; signal?: AbortSignal }): Promise<BlobProviderResult<{ key: string; size: number }>> {
    if (!/^"[A-Za-z0-9._-]{1,128}"$/.test(input.markerEtag)) return fenceFailure("Invalid marker ETag");
    const versioning = await this.isUnversioned(input.signal);
    if (!versioning.ok) return versioning;
    const target = this.objectUrl(input.key);
    const hash = sha256Hex(input.body);
    try {
      const response = await this.fetchImpl(target, {
        method: "PUT", signal: input.signal, body: new Blob([arrayBuffer(input.body)], { type: input.contentType }),
        headers: this.signedHeaders({ method: "PUT", target, payloadHash: hash, extraHeaders: {
          "cache-control": "private, no-store, max-age=0", "content-type": input.contentType,
          "if-match": input.markerEtag, "x-amz-content-sha256": hash,
        } }),
      });
      if (!response.ok) return blobFailure("fenced_put_failed", response);
      if (response.headers.has("x-amz-version-id")) return fenceFailure("Object storage created a versioned object");
      return { ok: true, data: { key: input.key, size: input.body.byteLength } };
    } catch (error) { return networkFailure("fenced_put_failed", error); }
  }

  private async isUnversioned(signal?: AbortSignal): Promise<BlobProviderResult<{ unversioned: true }>> {
    if (this.fencedWriteSemantics !== "verified-unversioned-v1") return fenceFailure("Fenced import storage semantics are not verified");
    if (this.provider === "r2") {
      // Cloudflare documents atomic conditional writes but does not implement
      // GetBucketVersioning. Never generalize that exception to a proxy or an
      // arbitrary S3-compatible host; explicit operator attestation above is
      // still required for the actual bucket's retention/version contract.
      if (this.endpoint.protocol !== "https:" || this.endpoint.port || this.endpoint.username || this.endpoint.password || this.endpoint.pathname !== "/" || this.endpoint.search || this.endpoint.hash || !/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(this.endpoint.hostname)) {
        return fenceFailure("The R2 fencing contract requires an official R2 endpoint");
      }
      return { ok: true, data: { unversioned: true } };
    }
    const target = new URL(this.endpoint);
    const endpointPath = target.pathname === "/" ? "" : target.pathname.replace(/\/$/, "");
    target.pathname = `${endpointPath}/${encodePathSegment(this.bucket)}`;
    target.search = "versioning=";
    const hash = sha256Hex(new Uint8Array());
    try {
      const response = await this.fetchImpl(target, { method: "GET", signal, headers: this.signedHeaders({ method: "GET", target, payloadHash: hash, extraHeaders: { "x-amz-content-sha256": hash } }) });
      if (!response.ok) return blobFailure("fence_versioning_check_failed", response);
      const text = await readBoundedText(response, 4096);
      if (!/^(?:\s*<\?xml\s+version="1\.0"\s+encoding="UTF-8"\s*\?>)?\s*<VersioningConfiguration(?:\s+xmlns="http:\/\/s3\.amazonaws\.com\/doc\/2006-03-01\/")?\s*(?:\/>|>\s*<\/VersioningConfiguration>)\s*$/.test(text)) {
        return fenceFailure("Bucket versioning must be disabled and verifiable");
      }
      return { ok: true, data: { unversioned: true } };
    } catch (error) { return networkFailure("fence_versioning_check_failed", error); }
  }

  /**
   * Creates an object exactly once. S3 evaluates If-None-Match atomically, so
   * concurrent writers cannot replace an already-persisted authority record.
   */
  async putPrivateIfAbsent(input: {
    key: string;
    body: Uint8Array;
    contentType: string;
  }): Promise<BlobProviderResult<{ key: string; size: number; created: boolean }>> {
    const target = this.objectUrl(input.key);
    const payloadHash = sha256Hex(input.body);
    const headers = this.signedHeaders({
      method: "PUT",
      target,
      payloadHash,
      extraHeaders: {
        "cache-control": "private, no-store, max-age=0",
        "content-type": input.contentType,
        "if-none-match": "*",
        "x-amz-content-sha256": payloadHash,
      },
    });

    try {
      const response = await this.fetchImpl(target, {
        method: "PUT",
        headers,
        body: new Blob([arrayBuffer(input.body)], { type: input.contentType }),
      });
      if (response.status === 412) {
        return {
          ok: true,
          data: { key: input.key, size: input.body.byteLength, created: false },
        };
      }
      if (!response.ok) return blobFailure("put_if_absent_failed", response);
      return {
        ok: true,
        data: { key: input.key, size: input.body.byteLength, created: true },
      };
    } catch (error) {
      return networkFailure("put_if_absent_failed", error);
    }
  }

  async signGetUrl(input: {
    key: string;
    expiresInSeconds: number;
    downloadFilename?: string;
  }): Promise<BlobProviderResult<{ url: string }>> {
    const expires = Math.max(1, Math.min(input.expiresInSeconds, 604_800));
    const target = this.objectUrl(input.key);
    const now = new Date();
    const dates = signingDates(now);
    const credentialScope = this.credentialScope(dates.shortDate);
    const query = new URLSearchParams({
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${this.accessKeyId}/${credentialScope}`,
      "X-Amz-Date": dates.longDate,
      "X-Amz-Expires": String(expires),
      "X-Amz-SignedHeaders": "host",
      "response-cache-control": "private, no-store, max-age=0",
    });
    if (input.downloadFilename) {
      query.set(
        "response-content-disposition",
        `attachment; filename="${safeDispositionFilename(input.downloadFilename)}"`,
      );
    }
    target.search = canonicalQuery(query);
    const canonicalRequest = [
      "GET",
      canonicalUri(target),
      canonicalQuery(query),
      `host:${target.host}\n`,
      "host",
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    query.set(
      "X-Amz-Signature",
      this.signature({
        canonicalRequest,
        credentialScope,
        shortDate: dates.shortDate,
        longDate: dates.longDate,
      }),
    );
    target.search = canonicalQuery(query);

    return { ok: true, data: { url: target.toString() } };
  }

  async getPrivate(input: { key: string; signal?: AbortSignal; maxBytes?: number }): Promise<BlobProviderResult<{ body: Uint8Array; contentType: string | null }>> {
    const signed = await this.signGetUrl({ key: input.key, expiresInSeconds: 60 });
    if (!signed.ok) return signed;
    try {
      const response = await this.fetchImpl(signed.data.url, { signal: input.signal });
      if (!response.ok) return blobFailure(response.status === 404 ? "not_found" : "get_failed", response);
      if (input.maxBytes !== undefined && response.body) {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > input.maxBytes) {
              await reader.cancel();
              return { ok: false, error: { code: "too_large", message: "Source image is too large", retryable: false } };
            }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        const body = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
        return { ok: true, data: { body, contentType: response.headers.get("content-type") } };
      }
      return {
        ok: true,
        data: {
          body: new Uint8Array(await response.arrayBuffer()),
          contentType: response.headers.get("content-type"),
        },
      };
    } catch (error) {
      return networkFailure("get_failed", error);
    }
  }

  async delete(input: {
    key: string;
    signal?: AbortSignal;
  }): Promise<BlobProviderResult<{ deleted: true }>> {
    const target = this.objectUrl(input.key);
    const payloadHash = sha256Hex(new Uint8Array());
    const headers = this.signedHeaders({
      method: "DELETE",
      target,
      payloadHash,
      extraHeaders: {
        "x-amz-content-sha256": payloadHash,
      },
    });

    try {
      const response = await this.fetchImpl(target, {
        method: "DELETE",
        headers,
        signal: input.signal,
      });
      if (!response.ok && response.status !== 404) {
        return blobFailure("delete_failed", response);
      }
      return { ok: true, data: { deleted: true } };
    } catch (error) {
      return networkFailure("delete_failed", error);
    }
  }

  async deleteFenced(input: { key: string; signal?: AbortSignal }): Promise<BlobProviderResult<{ deleted: true }>> {
    const versioning = await this.isUnversioned(input.signal);
    if (!versioning.ok) return versioning;
    const deleted = await this.delete(input);
    if (!deleted.ok) return deleted;
    // The key already has durable deletion authority. A failed or ambiguous
    // probe leaves that authority pending and all probe bytes are random.
    const etag = `"idream-fence-${randomBytes(16).toString("hex")}"`;
    const checked = await this.checkMissingObjectCondition(input.key, etag, input.signal);
    return checked.ok ? { ok: true, data: { deleted: true } } : checked;
  }

  private async checkMissingObjectCondition(key: string, etag: string, signal?: AbortSignal): Promise<BlobProviderResult<{ verified: true }>> {
    const target = this.objectUrl(key);
    const probe = randomBytes(32);
    const probeHash = sha256Hex(probe);
    try {
      const checked = await this.fetchImpl(target, {
        method: "PUT", signal, body: new Blob([arrayBuffer(probe)]),
        headers: this.signedHeaders({ method: "PUT", target, payloadHash: probeHash, extraHeaders: {
          "cache-control": "private, no-store, max-age=0", "content-type": "application/octet-stream",
          "if-match": etag, "x-amz-content-sha256": probeHash,
        } }),
      });
      if (![404, 409, 412].includes(checked.status)) return fenceFailure("Object storage did not reject a deleted marker condition");
      // A 412 can also mean an object has reappeared, so require a current
      // negative read as well. Neither observation guarantees future ordering;
      // the operator's immutable atomic-write contract remains necessary.
      const hash = sha256Hex(new Uint8Array());
      const head = await this.fetchImpl(target, { method: "HEAD", signal, headers: this.signedHeaders({
        method: "HEAD", target, payloadHash: hash, extraHeaders: { "x-amz-content-sha256": hash },
      }) });
      if (head.status !== 404 || head.headers.has("x-amz-version-id")) return fenceFailure("Deleted marker absence could not be verified");
      return { ok: true, data: { verified: true } };
    } catch (error) { return networkFailure("fence_probe_failed", error); }
  }

  private objectUrl(key: string) {
    const target = new URL(this.endpoint);
    const endpointPath = target.pathname === "/" ? "" : target.pathname.replace(/\/$/, "");
    target.pathname = `${endpointPath}/${encodePathSegment(this.bucket)}/${encodeS3Key(key)}`;
    target.search = "";
    return target;
  }

  private signedHeaders(input: {
    method: "GET" | "HEAD" | "PUT" | "DELETE";
    target: URL;
    payloadHash: string;
    extraHeaders: Record<string, string>;
  }) {
    const now = new Date();
    const dates = signingDates(now);
    const credentialScope = this.credentialScope(dates.shortDate);
    const headers = {
      host: input.target.host,
      "x-amz-date": dates.longDate,
      ...lowercaseHeaders(input.extraHeaders),
    };
    const signedHeaders = Object.keys(headers).sort().join(";");
    const canonicalHeaders = Object.entries(headers)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([name, value]) => `${name}:${normalizeHeaderValue(value)}\n`)
      .join("");
    const canonicalRequest = [
      input.method,
      canonicalUri(input.target),
      canonicalQuery(input.target.searchParams),
      canonicalHeaders,
      signedHeaders,
      input.payloadHash,
    ].join("\n");
    const signature = this.signature({
      canonicalRequest,
      credentialScope,
      shortDate: dates.shortDate,
      longDate: dates.longDate,
    });

    return {
      ...headers,
      authorization: "AWS4-HMAC-SHA256 " + [
        `Credential=${this.accessKeyId}/${credentialScope}`,
        `SignedHeaders=${signedHeaders}`,
        `Signature=${signature}`,
      ].join(", "),
    };
  }

  private credentialScope(shortDate: string) {
    return `${shortDate}/${this.region}/s3/aws4_request`;
  }

  private signature(input: {
    canonicalRequest: string;
    credentialScope: string;
    shortDate: string;
    longDate: string;
  }) {
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      input.longDate,
      input.credentialScope,
      sha256Hex(input.canonicalRequest),
    ].join("\n");
    const signingKey = hmac(
      hmac(
        hmac(
          hmac(`AWS4${this.secretAccessKey}`, input.shortDate),
          this.region,
        ),
        "s3",
      ),
      "aws4_request",
    );
    return hmac(signingKey, stringToSign).toString("hex");
  }
}

function signingDates(now: Date) {
  const iso = now.toISOString().replaceAll("-", "").replaceAll(":", "");
  return {
    shortDate: iso.slice(0, 8),
    longDate: `${iso.slice(0, 15)}Z`,
  };
}

function canonicalUri(url: URL) {
  return url.pathname || "/";
}

function canonicalQuery(query: URLSearchParams) {
  return Array.from(query.entries())
    .map(([key, value]) => [awsEncode(key), awsEncode(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function encodeS3Key(key: string) {
  return key.replace(/^\/+/, "").split("/").map(encodePathSegment).join("/");
}

function encodePathSegment(value: string) {
  return awsEncode(value);
}

function awsEncode(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function lowercaseHeaders(headers: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

function normalizeHeaderValue(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function safeDispositionFilename(value: string) {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "download";
}

function sha256Hex(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function arrayBuffer(value: Uint8Array) {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function hmac(key: string | Uint8Array, value: string) {
  return createHmac("sha256", key).update(value).digest();
}

function blobFailure(code: string, response: Response): BlobProviderResult<never> {
  return {
    ok: false,
    error: {
      code,
      message: `Object storage request failed with HTTP ${response.status}`,
      retryable: response.status === 429 || response.status >= 500,
    },
  };
}

function fenceFailure(message: string): BlobProviderResult<never> {
  return { ok: false, error: { code: "fence_unsupported", message, retryable: false } };
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new Error("Object storage versioning response is too large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("Object storage versioning response is too large");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size).toString("utf8");
}

function networkFailure(code: string, error: unknown): BlobProviderResult<never> {
  return {
    ok: false,
    error: {
      code,
      message: error instanceof Error ? error.message : "Object storage request failed",
      retryable: true,
    },
  };
}
