import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { S3CompatibleBlobStore } from "./s3-blob";

function createStore(fetchImpl?: typeof fetch) {
  return new S3CompatibleBlobStore({
    endpoint: "https://account.r2.cloudflarestorage.com",
    bucket: "private-media",
    region: "auto",
    accessKeyId: "access-key",
    secretAccessKey: "secret-key",
    fencedWriteSemantics: "verified-unversioned-v1",
    fetchImpl: fetchImpl ?? (async () => new Response(null, { status: 200 })),
  });
}

describe("S3CompatibleBlobStore", () => {
  it("uses the explicitly attested R2 contract only for the official account endpoint", async () => {
    const objects = new Set<string>();
    const fetchImpl = vi.fn(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (init?.method === "GET") throw new Error("R2 must not request unimplemented bucket versioning");
      const key = String(url);
      if (init?.method === "HEAD") return new Response(null, { status: objects.has(key) ? 200 : 404 });
      if (init?.method === "DELETE") { objects.delete(key); return new Response(null, { status: 204 }); }
      const headers = init?.headers as Record<string, string>;
      if (headers["if-none-match"] === "*") {
        if (objects.has(key)) return new Response(null, { status: 412 });
        objects.add(key);
        return new Response(null, { status: 200, headers: { etag: '"marker"' } });
      }
      return new Response(null, { status: headers["if-match"] === '"marker"' && objects.has(key) ? 200 : objects.has(key) ? 412 : 404 });
    });
    const store = new S3CompatibleBlobStore({ endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com", bucket: "bucket", provider: "r2", accessKeyId: "key", secretAccessKey: "secret", fencedWriteSemantics: "verified-unversioned-v1", fetchImpl });
    const marker = await store.prepareFencedPut({ key: "imports/new" });
    expect(marker).toEqual({ ok: true, data: { key: "imports/new", markerEtag: '"marker"' } });
    await expect(store.putPrivateFenced({ key: "imports/new", body: new Uint8Array([1]), contentType: "image/png", markerEtag: '"marker"' })).resolves.toMatchObject({ ok: true });
    await expect(store.deleteFenced({ key: "imports/new" })).resolves.toEqual({ ok: true, data: { deleted: true } });
    expect(fetchImpl.mock.calls.every(([, init]) => init?.method !== "GET")).toBe(true);
  });

  it.each([
    "https://r2.cloudflarestorage.com.attacker.test",
    "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com.attacker.test",
    "http://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
    "https://not-a-real-account.r2.cloudflarestorage.com",
    "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com:444",
  ])("refuses a non-official R2 endpoint %s before sending any request", async endpoint => {
    const fetchImpl = vi.fn(async () => new Response(null));
    const store = new S3CompatibleBlobStore({ endpoint, bucket: "bucket", provider: "r2", accessKeyId: "key", secretAccessKey: "secret", fencedWriteSemantics: "verified-unversioned-v1", fetchImpl });
    await expect(store.prepareFencedPut({ key: "imports/new" })).resolves.toMatchObject({ ok: false, error: { code: "fence_unsupported" } });
    await expect(store.putPrivateFenced({ key: "imports/new", body: new Uint8Array([1]), contentType: "image/png", markerEtag: '"marker"' })).resolves.toMatchObject({ ok: false, error: { code: "fence_unsupported" } });
    await expect(store.deleteFenced({ key: "imports/new" })).resolves.toMatchObject({ ok: false, error: { code: "fence_unsupported" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses official R2 without explicit operator attestation", async () => {
    const fetchImpl = vi.fn(async () => new Response(null));
    const store = new S3CompatibleBlobStore({ endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com", bucket: "bucket", provider: "r2", accessKeyId: "key", secretAccessKey: "secret", fetchImpl });
    await expect(store.prepareFencedPut({ key: "imports/new" })).resolves.toMatchObject({ ok: false, error: { code: "fence_unsupported" } });
    await expect(store.putPrivateFenced({ key: "imports/new", body: new Uint8Array([1]), contentType: "image/png", markerEtag: '"marker"' })).resolves.toMatchObject({ ok: false, error: { code: "fence_unsupported" } });
    await expect(store.deleteFenced({ key: "imports/new" })).resolves.toMatchObject({ ok: false, error: { code: "fence_unsupported" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not bypass versioning checks for the official R2 host when provider is s3", async () => {
    const fetchImpl = vi.fn(async (_url: Parameters<typeof fetch>[0]) => new Response(null, { status: 501 }));
    const store = new S3CompatibleBlobStore({ endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com", bucket: "bucket", provider: "s3", accessKeyId: "key", secretAccessKey: "secret", fencedWriteSemantics: "verified-unversioned-v1", fetchImpl });
    await expect(store.deleteFenced({ key: "imports/new" })).resolves.toMatchObject({ ok: false, error: { code: "fence_versioning_check_failed" } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("?versioning=");
  });

  it("does not use fenced import writes or deletes without operator attestation", async () => {
    const fetchImpl = vi.fn(async () => new Response("<VersioningConfiguration/>"));
    const store = new S3CompatibleBlobStore({ endpoint: "https://s3.example.test", bucket: "bucket", accessKeyId: "key", secretAccessKey: "secret", fetchImpl });
    await expect(store.prepareFencedPut({ key: "imports/new" })).resolves.toMatchObject({ ok: false, error: { code: "fence_unsupported" } });
    await expect(store.putPrivateFenced({ key: "imports/new", body: new Uint8Array([1]), contentType: "image/png", markerEtag: '"marker"' })).resolves.toMatchObject({ ok: false, error: { code: "fence_unsupported" } });
    await expect(store.deleteFenced({ key: "imports/new" })).resolves.toMatchObject({ ok: false, error: { code: "fence_unsupported" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(["Enabled", "Suspended"])("refuses fencing against a %s versioned bucket before writing any data", async status => {
    const fetchImpl = vi.fn(async () => new Response(`<VersioningConfiguration><Status>${status}</Status></VersioningConfiguration>`));
    const result = await createStore(fetchImpl).prepareFencedPut({ key: "imports/attempt" });
    expect(result).toMatchObject({ ok: false, error: { code: "fence_unsupported" } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not claim fenced deletion on a versioned bucket", async () => {
    const fetchImpl = vi.fn(async () => new Response("<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>"));
    const result = await createStore(fetchImpl).deleteFenced({ key: "imports/attempt" });
    expect(result).toMatchObject({ ok: false, error: { code: "fence_unsupported" } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails closed for an inaccessible or malformed versioning response", async () => {
    for (const response of [new Response(null, { status: 403 }), new Response("not XML"), new Response("<VersioningConfiguration><Unknown/></VersioningConfiguration>")]) {
      const fetchImpl = vi.fn(async () => response);
      const result = await createStore(fetchImpl).deleteFenced({ key: "imports/attempt" });
      expect(result.ok).toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("signs the versioning query used to verify the fenced deletion authority", async () => {
    const fetchImpl = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (init?.method === "GET") return new Response("<VersioningConfiguration/>");
      if (init?.method === "PUT") return new Response(null, { status: 412 });
      if (init?.method === "HEAD") return new Response(null, { status: 404 });
      return new Response(null, { status: 204 });
    });
    await expect(createStore(fetchImpl).deleteFenced({ key: "imports/attempt" })).resolves.toEqual({ ok: true, data: { deleted: true } });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("?versioning=");
    const headers = fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>;
    const date = headers["x-amz-date"]!;
    expect(date).toMatch(/^\d{8}T\d{6}Z$/);
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=/);
    const dateShort = date.slice(0, 8);
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const sign = (key: string | Buffer, value: string) => createHmac("sha256", key).update(value).digest();
    const credentialScope = `${dateShort}/auto/s3/aws4_request`;
    const canonicalRequest = [
      "GET", "/private-media", "versioning=",
      `host:account.r2.cloudflarestorage.com\nx-amz-content-sha256:${hash("")}\nx-amz-date:${date}\n`,
      "host;x-amz-content-sha256;x-amz-date", hash(""),
    ].join("\n");
    const signingKey = sign(sign(sign(sign("AWS4secret-key", dateShort), "auto"), "s3"), "aws4_request");
    const signature = createHmac("sha256", signingKey).update(["AWS4-HMAC-SHA256", date, credentialScope, hash(canonicalRequest)].join("\n")).digest("hex");
    expect(headers.authorization).toContain(`Signature=${signature}`);
    expect(fetchImpl.mock.calls[1]?.[1]?.method).toBe("DELETE");
  });

  it("refuses fenced writes when a formerly unversioned bucket is now versioned", async () => {
    const fetchImpl = vi.fn(async () => new Response("<VersioningConfiguration><Status>Suspended</Status></VersioningConfiguration>"));
    const result = await createStore(fetchImpl).putPrivateFenced({ key: "imports/attempt", body: new Uint8Array([1]), contentType: "image/png", markerEtag: '"marker"' });
    expect(result).toMatchObject({ ok: false, error: { code: "fence_unsupported" } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses import and fenced erasure when a missing object accepts If-Match", async () => {
    let exists = false;
    const methods: string[] = [];
    const fetchImpl = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      methods.push(init?.method ?? "GET");
      if (init?.method === "GET") return new Response("<VersioningConfiguration/>");
      if (init?.method === "DELETE") { exists = false; return new Response(null, { status: 204 }); }
      if (init?.method === "HEAD") return new Response(null, { status: exists ? 200 : 404 });
      const headers = init?.headers as Record<string, string>;
      if (headers["if-none-match"] && exists) return new Response(null, { status: 412 });
      exists = true;
      return new Response(null, { status: 200, headers: { etag: '"marker"' } });
    });
    const store = createStore(fetchImpl);
    await expect(store.prepareFencedPut({ key: "imports/attempt" })).resolves.toMatchObject({ ok: false, error: { code: "fence_unsupported" } });
    expect(exists).toBe(true);
    await expect(store.deleteFenced({ key: "imports/attempt" })).resolves.toMatchObject({ ok: false, error: { code: "fence_unsupported" } });
    expect(exists).toBe(true);
    expect(methods.filter(method => method === "DELETE")).toHaveLength(2);
    expect(fetchImpl.mock.calls.every(([url]) => String(url).includes("/private-media/imports/attempt") || String(url).includes("?versioning="))).toBe(true);
  });

  it("does not acknowledge deletion if a rejected conditional write is followed by a present object", async () => {
    const fetchImpl = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (init?.method === "GET") return new Response("<VersioningConfiguration/>");
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (init?.method === "PUT") return new Response(null, { status: 412 });
      return new Response(null, { status: 200 });
    });
    await expect(createStore(fetchImpl).deleteFenced({ key: "imports/attempt" })).resolves.toMatchObject({ ok: false, error: { code: "fence_unsupported" } });
  });

  it("fails closed before user data if the endpoint ignores a marker If-Match precondition", async () => {
    let exists = false;
    let firstMarker = true;
    const fetchImpl = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (init?.method === "GET") return new Response('<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>');
      if (init?.method === "HEAD") return new Response(null, { status: exists ? 200 : 404 });
      if (init?.method === "DELETE") { exists = false; return new Response(null, { status: 204 }); }
      const headers = init?.headers as Record<string, string>;
      if (headers["if-none-match"]) {
        if (exists) return new Response(null, { status: 412 });
        exists = true;
        return new Response(null, { status: 200, headers: { etag: '"marker"' } });
      }
      if (firstMarker) { firstMarker = false; return new Response(null, { status: 404 }); }
      return new Response(null, { status: 200 });
    });
    const result = await createStore(fetchImpl).prepareFencedPut({ key: "imports/attempt" });
    expect(result).toMatchObject({ ok: false, error: { code: "fence_unsupported" } });
    const mismatch = fetchImpl.mock.calls.find(([, init]) => (init?.headers as Record<string, string> | undefined)?.["if-match"]?.startsWith('"idream-fence-mismatch-'))?.[1]?.headers as Record<string, string>;
    expect(mismatch.authorization).toContain(";if-match;");
  });

  it("signs a conditional write and prevents a delayed PUT from recreating a deleted key", async () => {
    let exists = false;
    let finishPut!: () => void;
    let dataPutReached!: () => void;
    const dataPutStarted = new Promise<void>(resolve => { dataPutReached = resolve; });
    const releasePut = new Promise<void>(resolve => { finishPut = resolve; });
    const fetchImpl = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (init?.method === "GET") return new Response("<VersioningConfiguration/>");
      if (init?.method === "DELETE") { exists = false; return new Response(null, { status: 204 }); }
      if (init?.method === "HEAD") return new Response(null, { status: exists ? 200 : 404 });
      const headers = init?.headers as Record<string, string>;
      if (headers["if-none-match"] === "*") {
        if (exists) return new Response(null, { status: 412 });
        exists = true;
        return new Response(null, { status: 200, headers: { etag: '"marker"' } });
      }
      if (!exists) return new Response(null, { status: 404 });
      if (headers["if-match"] !== '"marker"') return new Response(null, { status: 412 });
      dataPutReached();
      await releasePut;
      if (!exists) return new Response(null, { status: 404 });
      return new Response(null, { status: 200 });
    });
    const store = createStore(fetchImpl);
    const marker = await store.prepareFencedPut({ key: "imports/attempt" });
    expect(marker).toEqual({ ok: true, data: { key: "imports/attempt", markerEtag: '"marker"' } });
    const put = store.putPrivateFenced({ key: "imports/attempt", body: new Uint8Array([1, 2, 3]), contentType: "image/png", markerEtag: '"marker"' });
    await dataPutStarted;
    await expect(store.delete({ key: "imports/attempt" })).resolves.toEqual({ ok: true, data: { deleted: true } });
    finishPut();
    await expect(put).resolves.toMatchObject({ ok: false, error: { code: "fenced_put_failed" } });
    expect(exists).toBe(false);
    const signedPut = fetchImpl.mock.calls.find(([, init]) => (init?.headers as Record<string, string> | undefined)?.["if-match"] === '"marker"')?.[1];
    expect((signedPut?.headers as Record<string, string>).authorization).toContain(";if-match;");
  });
  it("returns a private object within the requested streaming size limit", async () => {
    const store = createStore(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }));
    const result = await store.getPrivate({ key: "source.png", maxBytes: 3 });
    expect(result).toEqual({ ok: true, data: { body: new Uint8Array([1, 2, 3]), contentType: "image/png" } });
  });
  it("limits and cancels a streamed private object when it exceeds the requested size", async () => {
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.enqueue(new Uint8Array([3, 4])); },
      cancel: cancelled,
    });
    const store = createStore(async () => new Response(stream, { status: 200 }));
    const result = await store.getPrivate({ key: "source.png", maxBytes: 3 });
    expect(result).toMatchObject({ ok: false, error: { code: "too_large", retryable: false } });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("passes the caller's abort signal into the private object request", async () => {
    const aborter = new AbortController();
    const fetchImpl = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      await new Promise<void>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
      return new Response(null);
    });
    const pending = createStore(fetchImpl).getPrivate({ key: "source.png", signal: aborter.signal, maxBytes: 10 });
    await Promise.resolve(); aborter.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "get_failed", retryable: true } });
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBe(aborter.signal);
  });
  it("uploads private objects with SigV4 authorization", async () => {
    const fetchImpl = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        new Response(null, { status: 200 }),
    );
    const store = createStore(fetchImpl);

    const result = await store.putPrivate({
      key: "images/user 1/result.webp",
      body: new TextEncoder().encode("image-bytes"),
      contentType: "image/webp",
    });

    expect(result).toEqual({
      ok: true,
      data: { key: "images/user 1/result.webp", size: 11 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const firstCall = fetchImpl.mock.calls[0];
    if (!firstCall) throw new Error("fetch was not called");
    const [url, init] = firstCall;
    expect(String(url)).toBe(
      "https://account.r2.cloudflarestorage.com/private-media/images/user%201/result.webp",
    );
    expect(init?.method).toBe("PUT");
    expect(init?.headers).toMatchObject({
      "cache-control": "private, no-store, max-age=0",
      "content-type": "image/webp",
      host: "account.r2.cloudflarestorage.com",
    });
    expect((init?.headers as Record<string, string>).authorization).toContain(
      "AWS4-HMAC-SHA256",
    );
  });

  it("passes the import PUT abort signal to the HTTP transport", async () => {
    const aborter = new AbortController();
    const fetchImpl = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      await new Promise<void>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
      return new Response(null);
    });
    const pending = createStore(fetchImpl).putPrivate({ key: "import", body: new Uint8Array([1]), contentType: "image/png", signal: aborter.signal });
    await Promise.resolve(); aborter.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "put_failed" } });
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBe(aborter.signal);
  });

  it("atomically creates an object only when its key is absent", async () => {
    const fetchImpl = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        new Response(null, { status: 200 }),
    );
    const store = createStore(fetchImpl);

    const result = await store.putPrivateIfAbsent({
      key: "terminal/attempt-1.json",
      body: new TextEncoder().encode("terminal-record"),
      contentType: "application/json",
    });

    expect(result).toEqual({
      ok: true,
      data: { key: "terminal/attempt-1.json", size: 15, created: true },
    });
    const firstCall = fetchImpl.mock.calls[0];
    if (!firstCall) throw new Error("fetch was not called");
    const [, init] = firstCall;
    expect(init?.headers).toMatchObject({ "if-none-match": "*" });
    expect((init?.headers as Record<string, string>).authorization).toContain(
      "SignedHeaders=cache-control;content-type;host;if-none-match;x-amz-content-sha256;x-amz-date",
    );
  });

  it("treats a precondition failure as an existing immutable object", async () => {
    const store = createStore(async () => new Response(null, { status: 412 }));

    await expect(store.putPrivateIfAbsent({
      key: "terminal/attempt-1.json",
      body: new TextEncoder().encode("terminal-record"),
      contentType: "application/json",
    })).resolves.toEqual({
      ok: true,
      data: { key: "terminal/attempt-1.json", size: 15, created: false },
    });
  });

  it("creates presigned get URLs without making a network request", async () => {
    const fetchImpl = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        new Response(null, { status: 200 }),
    );
    const store = createStore(fetchImpl);

    const result = await store.signGetUrl({
      key: "images/user 1/result.webp",
      expiresInSeconds: 900,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const url = new URL(result.data.url);
    expect(url.origin).toBe("https://account.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/private-media/images/user%201/result.webp");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("response-cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
    const date = url.searchParams.get("X-Amz-Date")!;
    expect(date).toMatch(/^\d{8}T\d{6}Z$/);
    const params = [...url.searchParams.entries()].filter(([key]) => key !== "X-Amz-Signature");
    const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    const canonicalQuery = params.map(([key, value]) => `${encode(key)}=${encode(value)}`).sort().join("&");
    expect(canonicalQuery.indexOf("X-Amz-SignedHeaders=")).toBeLessThan(canonicalQuery.indexOf("response-cache-control="));
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const sign = (key: string | Buffer, value: string) => createHmac("sha256", key).update(value).digest();
    const scope = `${date.slice(0, 8)}/auto/s3/aws4_request`;
    const canonical = ["GET", url.pathname, canonicalQuery, `host:${url.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
    const signingKey = sign(sign(sign(sign("AWS4secret-key", date.slice(0, 8)), "auto"), "s3"), "aws4_request");
    expect(url.searchParams.get("X-Amz-Signature")).toBe(createHmac("sha256", signingKey).update(["AWS4-HMAC-SHA256", date, scope, hash(canonical)].join("\n")).digest("hex"));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("can request attachment disposition for browser downloads", async () => {
    const store = createStore();

    const result = await store.signGetUrl({
      key: "images/user 1/result.webp",
      expiresInSeconds: 900,
      downloadFilename: "idream-image-result.webp",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const url = new URL(result.data.url);
    expect(url.searchParams.get("response-content-disposition")).toBe(
      'attachment; filename="idream-image-result.webp"',
    );
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("sanitizes attachment filenames before signing", async () => {
    const store = createStore();

    const result = await store.signGetUrl({
      key: "images/result.webp",
      expiresInSeconds: 900,
      downloadFilename: "bad/name with spaces.webp",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const url = new URL(result.data.url);
    expect(url.searchParams.get("response-content-disposition")).toBe(
      'attachment; filename="bad_name_with_spaces.webp"',
    );
  });

  it("deletes objects and treats missing objects as already deleted", async () => {
    const fetchImpl = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        new Response(null, { status: 404 }),
    );
    const store = createStore(fetchImpl);

    const result = await store.delete({ key: "images/result.webp" });

    expect(result).toEqual({ ok: true, data: { deleted: true } });
    const firstCall = fetchImpl.mock.calls[0];
    if (!firstCall) throw new Error("fetch was not called");
    const [, init] = firstCall;
    expect(init?.method).toBe("DELETE");
  });

  it("returns retryable failures for storage 5xx responses", async () => {
    const fetchImpl = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        new Response(null, { status: 503 }),
    );
    const store = createStore(fetchImpl);

    const result = await store.putPrivate({
      key: "images/result.webp",
      body: new Uint8Array([1, 2, 3]),
      contentType: "image/webp",
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "put_failed",
        message: "Object storage request failed with HTTP 503",
        retryable: true,
      },
    });
  });
});
