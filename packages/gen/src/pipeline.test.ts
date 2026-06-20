// SPEC: Unit tests for the gen pipeline. enqueue is mocked and providers are
// stubbed, so no Redis and no disk are touched. Asserts the generation.completed
// finalize payload is enqueued to app.ai.finalize with the right dedupeKey,
// mode, and assets — and that the failure path enqueues generation.failed.
import { describe, expect, it, vi } from "vitest";
import {
  idempotencyKeys,
  type ImageGeneratePayload,
  MAIN_QUEUES,
  type VideoGeneratePayload,
} from "@idream/shared/contracts";
import { processImageGenerate, processVideoGenerate } from "./pipeline";
import type { GenProviders } from "./providers";
import type { EnqueueInput } from "./queue";

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
      { key: "mock/images/seed_1-1.png", width: 1024, height: 1024, contentType: "image/webp" },
      { key: "mock/images/seed_1-2.png", width: 1024, height: 1024, contentType: "image/webp" },
    ]);
  });

  it("enqueues generation.failed on a non-retryable provider error", async () => {
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
    expect(input.dedupeKey).toBe(idempotencyKeys.generationFinalize("job_img_1", "failed"));
    expect((input.payload as Record<string, unknown>).kind).toBe("generation.failed");
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

    await expect(processImageGenerate(imagePayload(), { enqueue, providers })).rejects.toThrow(
      "try again",
    );
    expect(enqueue).not.toHaveBeenCalled();
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

  it("enqueues generation.failed on a non-retryable provider error", async () => {
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
    expect(input.dedupeKey).toBe(idempotencyKeys.generationFinalize("job_vid_1", "failed"));
    expect((input.payload as Record<string, unknown>).kind).toBe("generation.failed");
  });
});
