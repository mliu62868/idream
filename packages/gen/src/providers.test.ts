import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertProductionBlobReady,
  assertProductionModerationReady,
  assertProductionProviderReady,
  providers,
} from "./providers";

const oldEnv = { ...process.env };

beforeEach(() => {
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...oldEnv };
});

describe("generation provider assembly", () => {
 
 
 
 
 
 
 
 
 
 
  it("wires GEN_IMAGE_PROVIDER=backend to a BackendImageModel that rejects unknown models", async () => {
    process.env.GEN_IMAGE_PROVIDER = "backend";
    process.env.GEN_WORKFLOW_DIR = "workflows"; // no descriptor declares this modelId

    const result = await providers.image.generate({
      prompt: "a cat",
      count: 1,
      model: "does-not-exist",
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "unknown_model",
        message: expect.stringContaining("does-not-exist"),
        retryable: false,
      },
    });
  });

  it("rejects production image generation when the provider is mock", () => {
    process.env.APP_ENV = "production";
    process.env.GEN_IMAGE_PROVIDER = "mock";

    expect(() => assertProductionProviderReady("image")).toThrow(
      "Production image generation requires a non-mock provider",
    );
  });

  // SPEC: the image/video production-adapter asymmetry is deliberate. Image may
  // still run the legacy OpenAI-compatible gateway as the documented rollback;
  // video may not, because only BackendVideoModel enforces the LTX production
  // envelope. Pinned so "make the two modes consistent" cannot quietly delete
  // either the rollback or the guard.
 
 
 
  // SPEC: `pipeline` is no longer an adapter at all, so it is refused when the
  // env getter parses the vocabulary — one stage earlier than the production
  // policy that used to catch it, and in every environment rather than only
  // production. Pinned so deleting the adapter cannot quietly widen what a
  // misconfigured worker will start under.
  it("refuses the retired pipeline adapter at vocabulary parse", () => {
    process.env.APP_ENV = "production";
    process.env.GEN_VIDEO_PROVIDER = "pipeline";

    expect(() => assertProductionProviderReady("video")).toThrow(
      "Unsupported video provider: pipeline",
    );
  });

  it("rejects video worker startup with an invalid provider timeout", () => {
    process.env.GEN_VIDEO_PROVIDER = "backend";
    process.env.GEN_VIDEO_TIMEOUT_MS = "not-a-timeout";

    expect(() => assertProductionProviderReady("video")).toThrow(
      "GEN_VIDEO_TIMEOUT_MS must be a positive integer",
    );
  });

  it("rejects unsupported generation providers at startup", () => {
    process.env.GEN_VIDEO_PROVIDER = "sdcpp";

    expect(() => assertProductionProviderReady("video")).toThrow(
      "Unsupported video provider: sdcpp",
    );
  });

  it("rejects production generation when blob storage is still mock", () => {
    process.env.APP_ENV = "production";
    process.env.GEN_BLOB_PROVIDER = "mock";

    expect(() => assertProductionBlobReady()).toThrow(
      "Production generation requires a non-mock blob provider",
    );
  });

  it("accepts the product mock moderation authority in production", () => {
    process.env.APP_ENV = "production";
    process.env.GEN_MODERATION_PROVIDER = "mock";

    expect(() => assertProductionModerationReady()).not.toThrow();
  });

  it("wires the safety gateway moderation provider when configured", async () => {
    process.env.GEN_MODERATION_PROVIDER = "safety-gateway";
    process.env.MODERATION_SERVICE_URL = "https://safety.internal.example.com";
    process.env.MODERATION_API_KEY = "moderation-api-key";
    const fetchMock = vi.fn(async () =>
      Response.json({
        status: "passed",
        confidence: 0.71,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await providers.moderation.check({
      targetType: "text",
      content: "safe prompt",
    });

    expect(result).toEqual({
      ok: true,
      data: {
        status: "passed",
        confidence: 0.71,
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://safety.internal.example.com/moderation/check"),
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer moderation-api-key",
        }),
      }),
    );
  });

  it("writes generated assets to S3-compatible blob storage when configured", async () => {
    process.env.GEN_BLOB_PROVIDER = "r2";
    process.env.BLOB_ENDPOINT = "https://account.r2.cloudflarestorage.com";
    process.env.BLOB_BUCKET = "private-media";
    process.env.BLOB_ACCESS_KEY_ID = "access-key";
    process.env.BLOB_SECRET_ACCESS_KEY = "secret-key";
    const fetchMock = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        new Response(null, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await providers.blob.putPrivate({
      key: "images/job-1/result.webp",
      body: new Uint8Array([1, 2, 3]),
      contentType: "image/webp",
    });

    expect(result).toEqual({
      ok: true,
      data: { key: "images/job-1/result.webp", size: 3 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0];
    if (!firstCall) throw new Error("fetch was not called");
    const [url, init] = firstCall;
    expect(String(url)).toBe(
      "https://account.r2.cloudflarestorage.com/private-media/images/job-1/result.webp",
    );
    expect(init?.method).toBe("PUT");
  });

  it("creates mock blob objects once without replacing existing bytes", async () => {
    const blobRoot = await mkdtemp(path.join(tmpdir(), "idream-gen-blob-"));
    process.env.GEN_BLOB_PROVIDER = "mock";
    process.env.BLOB_ROOT = blobRoot;

    try {
      const key = "terminal/attempt-1.json";
      await expect(providers.blob.putPrivateIfAbsent({
        key,
        body: new TextEncoder().encode("first"),
        contentType: "application/json",
      })).resolves.toMatchObject({ ok: true, data: { created: true } });
      await expect(providers.blob.putPrivateIfAbsent({
        key,
        body: new TextEncoder().encode("second"),
        contentType: "application/json",
      })).resolves.toMatchObject({ ok: true, data: { created: false } });

      expect(await readFile(path.join(blobRoot, key), "utf8")).toBe("first");
    } finally {
      await rm(blobRoot, { recursive: true, force: true });
    }
  });

  it("emits distinct underage policy codes (csam vs other underage terms)", async () => {
    process.env.GEN_MODERATION_PROVIDER = "mock";
    delete process.env.APP_ENV;

    const csam = await providers.moderation.check({ targetType: "text", content: "csam material" });
    const minor = await providers.moderation.check({ targetType: "text", content: "a minor appears" });
    const safe = await providers.moderation.check({ targetType: "text", content: "a pleasant scene" });

    expect(csam).toMatchObject({
      ok: true,
      data: { status: "blocked", policyCode: "potential_underage_content" },
    });
    expect(minor).toMatchObject({
      ok: true,
      data: { status: "blocked", policyCode: "age_under_18" },
    });
    expect(safe).toMatchObject({ ok: true, data: { status: "passed" } });
  });
});
