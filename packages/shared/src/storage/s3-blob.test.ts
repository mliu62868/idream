import { describe, expect, it, vi } from "vitest";
import { S3CompatibleBlobStore } from "./s3-blob";

function createStore(fetchImpl?: typeof fetch) {
  return new S3CompatibleBlobStore({
    endpoint: "https://account.r2.cloudflarestorage.com",
    bucket: "private-media",
    region: "auto",
    accessKeyId: "access-key",
    secretAccessKey: "secret-key",
    fetchImpl: fetchImpl ?? (async () => new Response(null, { status: 200 })),
  });
}

describe("S3CompatibleBlobStore", () => {
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
      "content-type": "image/webp",
      host: "account.r2.cloudflarestorage.com",
    });
    expect((init?.headers as Record<string, string>).authorization).toContain(
      "AWS4-HMAC-SHA256",
    );
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
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
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
