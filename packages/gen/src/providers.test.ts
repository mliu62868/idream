import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import {
  assertProductionBlobReady,
  assertProductionModerationReady,
  assertProductionProviderReady,
  providers,
} from "./providers";

const oldEnv = { ...process.env };

beforeEach(() => {
  delete process.env.PIPELINE_IMAGE_SIZE_DEFAULT;
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...oldEnv };
});

describe("PipelineImageModel", () => {
  it("parses OpenAI-compatible base64 image responses for blob persistence", async () => {
    process.env.GEN_IMAGE_PROVIDER = "pipeline";
    process.env.PIPELINE_API_URL = "https://pipeline.test";
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: [
          {
            b64_json: Buffer.from("image-bytes", "utf8").toString("base64"),
            width: 768,
            height: 1024,
            contentType: "image/png",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await providers.image.generate({
      prompt: "portrait",
      count: 1,
      model: "profile_image_default_v1",
      orientation: "4:5",
      seed: "seed_1",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://pipeline.test/images/generations"),
      expect.objectContaining({
        body: expect.stringContaining('"count":1'),
      }),
    );
    const firstCall = fetchMock.mock.calls[0] as unknown as
      | [Parameters<typeof fetch>[0], Parameters<typeof fetch>[1]]
      | undefined;
    if (!firstCall) throw new Error("fetch was not called");
    const [, init] = firstCall;
    const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(requestBody).toMatchObject({
      model: "profile_image_default_v1",
      count: 1,
      n: 1,
      size: "1024x1280",
      response_format: "b64_json",
      controls: { idreamSeed: "seed_1" },
    });
    expect(typeof requestBody.seed).toBe("number");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.assets[0]).toMatchObject({
      key: "pipeline/asset-1",
      width: 768,
      height: 1024,
      contentType: "image/png",
    });
    expect(new TextDecoder().decode(result.data.assets[0].body)).toBe("image-bytes");
  });

  it("parses pipeline asset URLs and clamps assets to the requested count", async () => {
    process.env.GEN_IMAGE_PROVIDER = "pipeline";
    process.env.PIPELINE_API_URL = "https://pipeline.test/custom-endpoint";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          assets: [
            {
              key: "pipeline/a.webp",
              url: "https://files.test/a.webp",
              width: 832,
              height: 1216,
              mime_type: "image/webp",
            },
            {
              key: "pipeline/unpaid-extra.webp",
              url: "https://files.test/extra.webp",
            },
          ],
        }),
      ),
    );

    const result = await providers.image.generate({
      prompt: "portrait",
      count: 1,
      model: "profile_image_default_v1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.assets).toHaveLength(1);
    expect(result.data.assets[0]).toMatchObject({
      key: "pipeline/a.webp",
      width: 832,
      height: 1216,
      contentType: "image/webp",
      sourceUrl: "https://files.test/a.webp",
    });
  });

  it("uses model-profile dimensions for OpenAI-compatible size when provided", async () => {
    process.env.GEN_IMAGE_PROVIDER = "pipeline";
    process.env.PIPELINE_API_URL = "https://pipeline.test";
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: [{ b64_json: Buffer.from("image-bytes", "utf8").toString("base64") }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await providers.image.generate({
      prompt: "portrait",
      count: 1,
      controls: { width: 512, height: 512, profileId: "profile_image_default_v1" },
    });

    expect(result.ok).toBe(true);
    const firstCall = fetchMock.mock.calls[0] as unknown as
      | [Parameters<typeof fetch>[0], Parameters<typeof fetch>[1]]
      | undefined;
    if (!firstCall) throw new Error("fetch was not called");
    const [, init] = firstCall;
    const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(requestBody).toMatchObject({
      profileId: "profile_image_default_v1",
      size: "512x512",
    });
  });

  it("treats empty success responses as retryable internal failures", async () => {
    process.env.GEN_IMAGE_PROVIDER = "pipeline";
    process.env.PIPELINE_API_URL = "https://pipeline.test";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [] })));

    const result = await providers.image.generate({
      prompt: "portrait",
      count: 1,
      model: "profile_image_default_v1",
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "internal",
        message: "Pipeline response did not include any assets",
        retryable: true,
      },
    });
  });

  it("treats success assets without bytes or URLs as retryable internal failures", async () => {
    process.env.GEN_IMAGE_PROVIDER = "pipeline";
    process.env.PIPELINE_API_URL = "https://pipeline.test";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ assets: [{ key: "bare-key" }] })));

    const result = await providers.image.generate({
      prompt: "portrait",
      count: 1,
      model: "profile_image_default_v1",
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "internal",
        message: "Pipeline asset 1 is missing image bytes or URL",
        retryable: true,
      },
    });
  });

  it("maps structured transient errors to retryable provider failures", async () => {
    process.env.GEN_IMAGE_PROVIDER = "pipeline";
    process.env.PIPELINE_API_URL = "https://pipeline.test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { category: "overloaded", message: "GPU busy" } },
          { status: 503 },
        ),
      ),
    );

    const result = await providers.image.generate({
      prompt: "portrait",
      count: 1,
      model: "profile_image_default_v1",
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "overloaded", message: "GPU busy", retryable: true },
    });
  });

  it("maps terminal invalid params errors to non-retryable failures", async () => {
    process.env.GEN_IMAGE_PROVIDER = "pipeline";
    process.env.PIPELINE_API_URL = "https://pipeline.test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { category: "invalid_params", message: "bad size" } },
          { status: 400 },
        ),
      ),
    );

    const result = await providers.image.generate({ prompt: "portrait", count: 1 });

    expect(result).toEqual({
      ok: false,
      error: { code: "invalid_params", message: "bad size", retryable: false },
    });
  });

  it("rejects production image generation when the provider is mock", () => {
    process.env.APP_ENV = "production";
    process.env.GEN_IMAGE_PROVIDER = "mock";

    expect(() => assertProductionProviderReady("image")).toThrow(
      "Production image generation requires a non-mock provider",
    );
  });

  it("rejects production image pipeline startup without a pipeline URL", () => {
    process.env.APP_ENV = "production";
    process.env.GEN_IMAGE_PROVIDER = "pipeline";
    delete process.env.PIPELINE_API_URL;

    expect(() => assertProductionProviderReady("image")).toThrow(
      "Production image generation requires PIPELINE_API_URL",
    );
  });

  it("parses OpenAI-compatible video URL responses for blob persistence", async () => {
    process.env.GEN_VIDEO_PROVIDER = "pipeline";
    process.env.PIPELINE_API_URL = "https://pipeline.test";
    process.env.PIPELINE_VIDEO_MODEL_DEFAULT = "video-real";
    const fetchMock = vi.fn(async () =>
      Response.json({
        asset: {
          key: "pipeline/videos/req_vid_1.mp4",
          url: "https://pipeline-assets.test/req_vid_1.mp4",
          seconds: 8,
          mime_type: "video/mp4",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await providers.video.generate({
      prompt: "slow cinematic pan",
      seconds: 8,
      requestId: "req_vid_1",
      seed: "seed_v1",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://pipeline.test/videos/generations"),
      expect.objectContaining({
        body: expect.stringContaining('"seconds":8'),
      }),
    );
    const firstCall = fetchMock.mock.calls[0] as unknown as
      | [Parameters<typeof fetch>[0], Parameters<typeof fetch>[1]]
      | undefined;
    if (!firstCall) throw new Error("fetch was not called");
    const [, init] = firstCall;
    const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(requestBody).toMatchObject({
      model: "video-real",
      seconds: 8,
      duration: 8,
      response_format: "url",
      controls: { idreamSeed: "seed_v1" },
    });
    expect(typeof requestBody.seed).toBe("number");
    expect(result).toEqual({
      ok: true,
      data: {
        asset: {
          key: "pipeline/videos/req_vid_1.mp4",
          seconds: 8,
          contentType: "video/mp4",
          sourceUrl: "https://pipeline-assets.test/req_vid_1.mp4",
        },
      },
    });
  });

  it("rejects production video pipeline startup without a pipeline URL", () => {
    process.env.APP_ENV = "production";
    process.env.GEN_VIDEO_PROVIDER = "pipeline";
    delete process.env.PIPELINE_API_URL;

    expect(() => assertProductionProviderReady("video")).toThrow(
      "Production video generation requires PIPELINE_API_URL",
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

  it("rejects production generation when moderation is still mock", () => {
    process.env.APP_ENV = "production";
    process.env.GEN_MODERATION_PROVIDER = "mock";

    expect(() => assertProductionModerationReady()).toThrow(
      "Production generation requires a non-mock moderation provider",
    );
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
