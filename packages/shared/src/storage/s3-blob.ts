import { createHash, createHmac } from "node:crypto";

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
  accessKeyId: string;
  secretAccessKey: string;
  fetchImpl?: typeof fetch;
}

export class S3CompatibleBlobStore {
  private readonly endpoint: URL;
  private readonly bucket: string;
  private readonly region: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: S3CompatibleBlobStoreConfig) {
    this.endpoint = new URL(config.endpoint);
    this.bucket = config.bucket;
    this.region = config.region ?? "auto";
    this.accessKeyId = config.accessKeyId;
    this.secretAccessKey = config.secretAccessKey;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async putPrivate(input: {
    key: string;
    body: Uint8Array;
    contentType: string;
  }): Promise<BlobProviderResult<{ key: string; size: number }>> {
    const target = this.objectUrl(input.key);
    const payloadHash = sha256Hex(input.body);
    const headers = this.signedHeaders({
      method: "PUT",
      target,
      payloadHash,
      extraHeaders: {
        "content-type": input.contentType,
        "x-amz-content-sha256": payloadHash,
      },
    });

    try {
      const response = await this.fetchImpl(target, {
        method: "PUT",
        headers,
        body: new Blob([arrayBuffer(input.body)], { type: input.contentType }),
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

  async delete(input: {
    key: string;
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
      });
      if (!response.ok && response.status !== 404) {
        return blobFailure("delete_failed", response);
      }
      return { ok: true, data: { deleted: true } };
    } catch (error) {
      return networkFailure("delete_failed", error);
    }
  }

  private objectUrl(key: string) {
    const target = new URL(this.endpoint);
    const endpointPath = target.pathname === "/" ? "" : target.pathname.replace(/\/$/, "");
    target.pathname = `${endpointPath}/${encodePathSegment(this.bucket)}/${encodeS3Key(key)}`;
    target.search = "";
    return target;
  }

  private signedHeaders(input: {
    method: "PUT" | "DELETE";
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
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${name}:${normalizeHeaderValue(value)}\n`)
      .join("");
    const canonicalRequest = [
      input.method,
      canonicalUri(input.target),
      "",
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
      authorization: [
        "AWS4-HMAC-SHA256",
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
    longDate: iso.slice(0, 15),
  };
}

function canonicalUri(url: URL) {
  return url.pathname || "/";
}

function canonicalQuery(query: URLSearchParams) {
  return Array.from(query.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${awsEncode(key)}=${awsEncode(value)}`)
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
