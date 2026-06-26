// SPEC: Unit tests for the gen pipeline. enqueue is mocked and providers are
// stubbed, so no Redis and no disk are touched. Asserts the generation.completed
// finalize payload is enqueued to app.ai.finalize with the right dedupeKey,
// mode, and assets — and that the failure path enqueues generation.failed.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  idempotencyKeys,
  type ImageGeneratePayload,
  MAIN_QUEUES,
  type VideoGeneratePayload,
} from "@idream/shared/contracts";
import { mockVideoMp4Bytes } from "@idream/shared";
import { processImageGenerate, processVideoGenerate } from "./pipeline";
import type { GenProviders } from "./providers";
import type { EnqueueInput } from "./queue";

afterEach(() => {
  vi.unstubAllGlobals();
});

function imagePayload(overrides: Partial<ImageGeneratePayload> = {}): ImageGeneratePayload {
  return {
    version: 1,
    kind: "image",
    requestId: "req_img_1",
    generationJobId: "job_img_1",
    userId: "user_1",
    characterId: null,
    prompt: "a serene mountain lake",
    negativePrompt: null,
    controls: {},
    presetIds: [],
    orientation: "portrait",
    count: 2,
    seed: "seed_1",
    model: "mock-image",
    outputPrefix: "gen/job_img_1/",
    ...overrides,
  };
}

function videoPayload(overrides: Partial<VideoGeneratePayload> = {}): VideoGeneratePayload {
  return {
    version: 1,
    kind: "video",
    requestId: "req_vid_1",
    generationJobId: "job_vid_1",
    userId: "user_1",
    characterId: null,
    prompt: "a slow pan over a city skyline",
    negativePrompt: null,
    controls: {},
    seconds: 6,
    seed: "seed_v1",
    model: "mock-video",
    outputPrefix: "gen/job_vid_1/",
    ...overrides,
  };
}

function makeProviders(over: Partial<GenProviders> = {}): GenProviders {
  return {
    image: {
      generate: vi.fn(async () => ({
        ok: true as const,
        data: {
          assets: [
            { key: "mock/images/seed_1-1.png", width: 1024, height: 1024 },
            { key: "mock/images/seed_1-2.png", width: 1024, height: 1024 },
          ],
        },
      })),
    },
    video: {
      generate: vi.fn(async () => ({
        ok: true as const,
        data: { asset: { key: "mock/videos/seed_v1.mp4", seconds: 6 } },
      })),
    },
    moderation: {
      check: vi.fn(async () => ({
        ok: true as const,
        data: { status: "passed" as const, confidence: 0.5 },
      })),
    },
    blob: {
      putPrivate: vi.fn(async (input) => ({
        ok: true as const,
        data: { key: input.key, size: input.body.byteLength },
      })),
      signGetUrl: vi.fn(async (input) => ({
        ok: true as const,
        data: { url: `mock://${input.key}` },
      })),
    },
    ...over,
  };
}

describe("processImageGenerate", () => {
  it("writes a blob per asset and enqueues generation.completed with the right dedupeKey", async () => {
    const enqueue = vi.fn(async (_: EnqueueInput) => {});
    const providers = makeProviders();

    await processImageGenerate(imagePayload(), { enqueue, providers });

    // One blob write per asset, no DB.
    expect(providers.blob.putPrivate).toHaveBeenCalledTimes(2);

    expect(enqueue).toHaveBeenCalledTimes(1);
    const [input] = enqueue.mock.calls[0];
    expect(input.queue).toBe(MAIN_QUEUES.aiFinalize);
    expect(input.dedupeKey).toBe(idempotencyKeys.generationFinalize("job_img_1", "completed"));

    const payload = input.payload as Record<string, unknown>;
    expect(payload.kind).toBe("generation.completed");
    expect(payload.mode).toBe("image");
    expect(payload.generationJobId).toBe("job_img_1");
    expect(payload.assets).toEqual([
      { key: "mock/images/seed_1-1.png", width: 1024, height: 1024, contentType: "image/png" },
      { key: "mock/images/seed_1-2.png", width: 1024, height: 1024, contentType: "image/png" },
    ]);
  });

  it("downloads provider asset URLs before writing blobs", async () => {
    const enqueue = vi.fn(async (_: EnqueueInput) => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("downloaded-image", { status: 200 })),
    );
    const providers = makeProviders({
      image: {
        generate: vi.fn(async () => ({
          ok: true as const,
          data: {
            assets: [
              {
                key: "pipeline/job_img_1.webp",
                sourceUrl: "https://pipeline-assets.test/job_img_1.webp",
                width: 768,
                height: 1024,
                contentType: "image/webp",
              },
            ],
          },
        })),
      },
    });

    await processImageGenerate(imagePayload({ count: 1 }), { enqueue, providers });

    expect(fetch).toHaveBeenCalledWith(
      "https://pipeline-assets.test/job_img_1.webp",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(providers.blob.putPrivate).toHaveBeenCalledWith({
      key: "pipeline/job_img_1.webp",
      body: new TextEncoder().encode("downloaded-image"),
      contentType: "image/webp",
    });
    const [input] = enqueue.mock.calls[0];
    expect((input.payload as Record<string, unknown>).kind).toBe("generation.completed");
  });

  it("enqueues generation.failed when an image provider returns no assets", async () => {
    const enqueue = vi.fn(async (_: EnqueueInput) => {});
    const providers = makeProviders({
      image: {
        generate: vi.fn(async () => ({
          ok: true as const,
          data: { assets: [] },
        })),
      },
    });

    await processImageGenerate(imagePayload(), { enqueue, providers });

    expect(providers.blob.putPrivate).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [input] = enqueue.mock.calls[0];
    expect(input.dedupeKey).toBe(idempotencyKeys.generationFinalize("job_img_1", "failed"));
    expect((input.payload as Record<string, unknown>).kind).toBe("generation.failed");
    expect(((input.payload as Record<string, unknown>).error as Record<string, unknown>).code).toBe(
      "empty_provider_result",
    );
  });

  it("enqueues generation.failed on final blob persistence failure", async () => {
    const enqueue = vi.fn(async (_: EnqueueInput) => {});
    const providers = makeProviders({
      blob: {
        putPrivate: vi.fn(async () => ({
          ok: false as const,
          error: {
            code: "blob_write_failed",
            message: "object store unavailable",
            retryable: true,
          },
        })),
        signGetUrl: vi.fn(async (input) => ({
          ok: true as const,
          data: { url: `mock://${input.key}` },
        })),
      },
    });

    await processImageGenerate(imagePayload(), {
      enqueue,
      providers,
      attemptsMade: 2,
      maxAttempts: 3,
    });

    const [input] = enqueue.mock.calls[0];
    expect(input.dedupeKey).toBe(idempotencyKeys.generationFinalize("job_img_1", "failed"));
    expect((input.payload as Record<string, unknown>).kind).toBe("generation.failed");
    expect(((input.payload as Record<string, unknown>).error as Record<string, unknown>).code).toBe(
      "asset_persist_failed",
    );
  });

  it("enqueues generation.blocked on a provider content block", async () => {
    const enqueue = vi.fn(async (_: EnqueueInput) => {});
    const providers = makeProviders({
      image: {
        generate: vi.fn(async () => ({
          ok: false as const,
          error: { code: "content_blocked", message: "blocked", retryable: false },
        })),
      },
    });

    await processImageGenerate(imagePayload(), { enqueue, providers });

    expect(providers.blob.putPrivate).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [input] = enqueue.mock.calls[0];
    expect(input.dedupeKey).toBe(idempotencyKeys.generationFinalize("job_img_1", "blocked"));
    expect((input.payload as Record<string, unknown>).kind).toBe("generation.blocked");
  });

  it("throws (lets the queue retry) on a retryable provider error", async () => {
    const enqueue = vi.fn(async (_: EnqueueInput) => {});
    const providers = makeProviders({
      image: {
        generate: vi.fn(async () => ({
          ok: false as const,
          error: { code: "rate_limited", message: "try again", retryable: true },
        })),
      },
    });

    await expect(
      processImageGenerate(imagePayload(), {
        enqueue,
        providers,
        attemptsMade: 0,
        maxAttempts: 3,
      }),
    ).rejects.toThrow("try again");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("enqueues generation.failed when retryable errors hit the final attempt", async () => {
    const enqueue = vi.fn(async (_: EnqueueInput) => {});
    const providers = makeProviders({
      image: {
        generate: vi.fn(async () => ({
          ok: false as const,
          error: { code: "timeout", message: "timed out", retryable: true },
        })),
      },
    });

    await processImageGenerate(imagePayload(), {
      enqueue,
      providers,
      attemptsMade: 2,
      maxAttempts: 3,
    });

    expect(enqueue).toHaveBeenCalledTimes(1);
    const [input] = enqueue.mock.calls[0];
    expect(input.dedupeKey).toBe(idempotencyKeys.generationFinalize("job_img_1", "failed"));
    expect((input.payload as Record<string, unknown>).kind).toBe("generation.failed");
  });

  it("enqueues generation.blocked when input moderation blocks before provider work", async () => {
    const enqueue = vi.fn(async (_: EnqueueInput) => {});
    const providers = makeProviders({
      moderation: {
        check: vi.fn(async () => ({
          ok: true as const,
          data: { status: "blocked" as const, policyCode: "UNDERAGE", confidence: 0.99 },
        })),
      },
    });

    await processImageGenerate(imagePayload(), { enqueue, providers });

    expect(providers.image.generate).not.toHaveBeenCalled();
    const [input] = enqueue.mock.calls[0];
    expect(input.dedupeKey).toBe(idempotencyKeys.generationFinalize("job_img_1", "blocked"));
    expect((input.payload as Record<string, unknown>).kind).toBe("generation.blocked");
  });

  it("rejects an invalid payload before touching any provider", async () => {
    const enqueue = vi.fn(async (_: EnqueueInput) => {});
    const providers = makeProviders();

    await expect(
      processImageGenerate(imagePayload({ count: 99 as unknown as 4 }), { enqueue, providers }),
    ).rejects.toThrow();
    expect(providers.image.generate).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("processVideoGenerate", () => {
  it("writes a single blob and enqueues generation.completed with seconds asset", async () => {
    const enqueue = vi.fn(async (_: EnqueueInput) => {});
    const providers = makeProviders();

    await processVideoGenerate(videoPayload(), { enqueue, providers });

    expect(providers.blob.putPrivate).toHaveBeenCalledTimes(1);
    expect(providers.blob.putPrivate).toHaveBeenCalledWith({
      key: "mock/videos/seed_v1.mp4",
      body: mockVideoMp4Bytes(),
      contentType: "video/mp4",
    });
    expect(enqueue).toHaveBeenCalledTimes(1);

    const [input] = enqueue.mock.calls[0];
    expect(input.queue).toBe(MAIN_QUEUES.aiFinalize);
    expect(input.dedupeKey).toBe(idempotencyKeys.generationFinalize("job_vid_1", "completed"));

    const payload = input.payload as Record<string, unknown>;
    expect(payload.kind).toBe("generation.completed");
    expect(payload.mode).toBe("video");
    expect(payload.assets).toEqual([
      { key: "mock/videos/seed_v1.mp4", seconds: 6, contentType: "video/mp4" },
    ]);
  });

  it("downloads provider video asset URLs before writing blobs", async () => {
    const enqueue = vi.fn(async (_: EnqueueInput) => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("downloaded-video", { status: 200 })),
    );
    const providers = makeProviders({
      video: {
        generate: vi.fn(async () => ({
          ok: true as const,
          data: {
            asset: {
              key: "pipeline/videos/job_vid_1.mp4",
              seconds: 8,
              contentType: "video/mp4",
              sourceUrl: "https://pipeline-assets.test/job_vid_1.mp4",
            },
          },
        })),
      },
    });

    await processVideoGenerate(videoPayload({ seconds: 8 }), { enqueue, providers });

    expect(fetch).toHaveBeenCalledWith(
      "https://pipeline-assets.test/job_vid_1.mp4",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(providers.blob.putPrivate).toHaveBeenCalledWith({
      key: "pipeline/videos/job_vid_1.mp4",
      body: new TextEncoder().encode("downloaded-video"),
      contentType: "video/mp4",
    });
    const [input] = enqueue.mock.calls[0];
    expect((input.payload as Record<string, unknown>).kind).toBe("generation.completed");
  });

  it("enqueues generation.failed on final video blob persistence failure", async () => {
    const enqueue = vi.fn(async (_: EnqueueInput) => {});
    const providers = makeProviders({
      blob: {
        putPrivate: vi.fn(async () => ({
          ok: false as const,
          error: {
            code: "blob_write_failed",
            message: "object store unavailable",
            retryable: true,
          },
        })),
        signGetUrl: vi.fn(async (input) => ({
          ok: true as const,
          data: { url: `mock://${input.key}` },
        })),
      },
    });

    await processVideoGenerate(videoPayload(), {
      enqueue,
      providers,
      attemptsMade: 2,
      maxAttempts: 3,
    });

    const [input] = enqueue.mock.calls[0];
    expect(input.dedupeKey).toBe(idempotencyKeys.generationFinalize("job_vid_1", "failed"));
    expect((input.payload as Record<string, unknown>).kind).toBe("generation.failed");
    expect(((input.payload as Record<string, unknown>).error as Record<string, unknown>).code).toBe(
      "asset_persist_failed",
    );
  });

  it("enqueues generation.blocked on a provider content block", async () => {
    const enqueue = vi.fn(async (_: EnqueueInput) => {});
    const providers = makeProviders({
      video: {
        generate: vi.fn(async () => ({
          ok: false as const,
          error: { code: "content_blocked", message: "blocked", retryable: false },
        })),
      },
    });

    await processVideoGenerate(videoPayload(), { enqueue, providers });

    expect(providers.blob.putPrivate).not.toHaveBeenCalled();
    const [input] = enqueue.mock.calls[0];
    expect(input.dedupeKey).toBe(idempotencyKeys.generationFinalize("job_vid_1", "blocked"));
    expect((input.payload as Record<string, unknown>).kind).toBe("generation.blocked");
  });
});
