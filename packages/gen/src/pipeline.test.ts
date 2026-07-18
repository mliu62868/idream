// SPEC: Unit tests for the gen pipeline. enqueue is mocked and providers are
// stubbed, so no Redis and no disk are touched. Asserts the generation.completed
// finalize payload is enqueued to app.ai.finalize with the right dedupeKey,
// mode, and assets — and that the failure path enqueues generation.failed.
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CharacterPreviewGeneratePayload,
  idempotencyKeys,
  type ImageGeneratePayload,
  MAIN_QUEUES,
  type VideoGeneratePayload,
} from "@idream/shared/contracts";
import { mockVideoMp4Bytes } from "@idream/shared";
import {
  processCharacterPreviewGenerate,
  processImageGenerate,
  processVideoGenerate,
} from "./pipeline";
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

function previewPayload(
  overrides: Partial<CharacterPreviewGeneratePayload> = {},
): CharacterPreviewGeneratePayload {
  return {
    version: 1,
    kind: "character.preview",
    requestId: "preview-request-1",
    previewJobId: "preview-job-1",
    draftId: "draft-1",
    userId: "user-1",
    prompt: "adult character identity portrait",
    negativePrompt: null,
    controls: { width: 832, height: 1024 },
    orientation: "4:5",
    seed: "draft-1:preview-job-1",
    model: "redcraft-krea2-comfyui",
    outputPrefix: "preview/preview-job-1/",
    ...overrides,
  };
}

function makeProviders(over: Partial<GenProviders> = {}): GenProviders {
  return {
    image: {
      retryCapabilities: { deterministicIdempotencyKey: true, retryableFailureCodes: ["rate_limited", "overloaded", "timeout", "internal"] },
      generate: vi.fn(async () => ({
        ok: true as const,
        data: {
          assets: [
            {
              key: "mock/images/seed_1-1.png",
              width: 1024,
              height: 1024,
              contentType: "image/png",
              body: patternedPng(4, 4),
            },
            {
              key: "mock/images/seed_1-2.png",
              width: 1024,
              height: 1024,
              contentType: "image/png",
              body: patternedPng(4, 4),
            },
          ],
        },
      })),
    },
    video: {
      retryCapabilities: { deterministicIdempotencyKey: true, retryableFailureCodes: ["rate_limited", "overloaded", "timeout", "internal"] },
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
    expect(payload.provider).toBe("backend");
    expect(payload.model).toBe("mock-image");
    expect(payload.generationJobId).toBe("job_img_1");
    expect(payload.assets).toEqual([
      {
        key: "gen/job_img_1/image-1.png",
        width: 1024,
        height: 1024,
        contentType: "image/png",
        providerKey: "mock/images/seed_1-1.png",
      },
      {
        key: "gen/job_img_1/image-2.png",
        width: 1024,
        height: 1024,
        contentType: "image/png",
        providerKey: "mock/images/seed_1-2.png",
      },
    ]);
  });

  it("persists an immutable manifest and waits for main durable ACK before completing", async () => {
    const enqueue = vi.fn(async (_: EnqueueInput) => {});
    const acknowledgeCompletion = vi.fn(async () => {});
    const providers = makeProviders({
      image: {
        generate: vi.fn(async () => ({
          ok: true as const,
          data: {
            assets: [
              {
                key: "mock/images/seed_1-1.png",
                width: 1024,
                height: 1024,
                contentType: "image/png",
                body: patternedPng(4, 4),
              },
              {
                key: "mock/images/seed_1-2.png",
                width: 1024,
                height: 1024,
                contentType: "image/png",
                body: patternedPng(4, 4),
              },
            ],
          },
          invocation: {
            providerRequestId: "provider-request-image-1",
            usage: { images: 2 },
            costMicros: 125_000,
            pricingVersion: "mock-image-v2",
          },
        })),
      },
    });

    await processImageGenerate(
      imagePayload({ attemptId: "attempt_img_1", attemptNo: 1 }),
      { enqueue, providers, acknowledgeCompletion },
    );

    expect(enqueue).not.toHaveBeenCalled();
    expect(providers.blob.putPrivate).toHaveBeenCalledTimes(3);
    expect(providers.blob.putPrivate).toHaveBeenLastCalledWith(expect.objectContaining({
      key: "gen/completion-manifests/attempt_img_1/completion.json",
      contentType: "application/json",
    }));
    expect(acknowledgeCompletion).toHaveBeenCalledWith(expect.objectContaining({
      manifestChecksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      manifest: expect.objectContaining({
        attemptId: "attempt_img_1",
        generationJobId: "job_img_1",
        model: "mock-image",
        provider: "backend",
        providerRequestId: "provider-request-image-1",
        accounting: {
          usage: { images: 2 },
          latencyMs: expect.any(Number),
          costMicros: 125_000,
          pricingVersion: "mock-image-v2",
        },
        assets: expect.arrayContaining([expect.objectContaining({ ordinal: 0 })]),
      }),
    }));
  });

  it("replays a persisted manifest after an ACK interruption without invoking the provider again", async () => {
    const enqueue = vi.fn(async (_: EnqueueInput) => {});
    const acknowledgeCompletion = vi.fn(async () => {});
    const manifest = {
      version: 1 as const,
      attemptId: "attempt_img_resume",
      attemptNo: 1,
      transportAttemptNo: 1,
      providerIdempotencyKey: "generation:attempt_img_resume:provider",
      requestId: "req_img_1",
      generationJobId: "job_img_1",
      mode: "image" as const,
      provider: "mock-image",
      providerRequestId: null,
      completedAt: "2026-07-11T12:00:00.000Z",
      assets: [{ ordinal: 0, key: "gen/job_img_1/image-1.png", contentType: "image/png", width: 1024, height: 1024, providerKey: null }],
      usage: { gpuSeconds: 1.2, model: "mock-image" },
    };
    const providers = makeProviders();
    providers.blob.getPrivate = vi.fn(async () => ({
      ok: true as const,
      data: { body: new TextEncoder().encode(JSON.stringify(manifest)), contentType: "application/json" },
    }));

    await processImageGenerate(
      imagePayload({ attemptId: manifest.attemptId, attemptNo: 1 }),
      { enqueue, providers, acknowledgeCompletion },
    );

    expect(providers.image.generate).not.toHaveBeenCalled();
    expect(providers.blob.putPrivate).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(acknowledgeCompletion).toHaveBeenCalledWith(expect.objectContaining({
      manifestRef: `gen/completion-manifests/${manifest.attemptId}/completion.json`,
      manifest,
    }));
  });

  it("hydrates reference image storage keys before calling the image provider", async () => {
    const enqueue = vi.fn(async (_: EnqueueInput) => {});
    const imageGenerate = vi.fn(async () => ({
      ok: true as const,
      data: {
        assets: [{
          key: "mock/images/seed_1-1.png",
          width: 1024,
          height: 1024,
          contentType: "image/png",
          body: patternedPng(4, 4),
        }],
      },
    }));
    const providers = makeProviders({
      image: { generate: imageGenerate },
      blob: {
        putPrivate: vi.fn(async (input) => ({
          ok: true as const,
          data: { key: input.key, size: input.body.byteLength },
        })),
        signGetUrl: vi.fn(async (input) => ({
          ok: true as const,
          data: { url: `https://blob.test/${encodeURIComponent(input.key)}` },
        })),
      },
    });

    await processImageGenerate(
      imagePayload({
        count: 1,
        referenceImages: [
          {
            assetId: "anchor-1",
            role: "identity_anchor",
            storageKey: "identity/anchor-1.webp",
            contentType: "image/webp",
            width: 1024,
            height: 1280,
            weight: 1.25,
          },
        ],
      }),
      { enqueue, providers },
    );

    expect(imageGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        referenceImages: [
          expect.objectContaining({
            assetId: "anchor-1",
            role: "identity_anchor",
            url: "https://blob.test/identity%2Fanchor-1.webp",
            storageKey: "identity/anchor-1.webp",
            weight: 1.25,
          }),
        ],
      }),
    );
  });

  it("fails closed before the provider when any pinned reference cannot be hydrated", async () => {
    const enqueue = vi.fn(async (_: EnqueueInput) => {});
    const imageGenerate = vi.fn(async () => ({
      ok: true as const,
      data: {
        assets: [{
          key: "mock/images/partial-reference.png",
          width: 1024,
          height: 1024,
          contentType: "image/png",
          body: patternedPng(4, 4),
        }],
      },
    }));
    const providers = makeProviders({
      image: { generate: imageGenerate },
      blob: {
        putPrivate: vi.fn(async (input) => ({
          ok: true as const,
          data: { key: input.key, size: input.body.byteLength },
        })),
        signGetUrl: vi.fn(async (input) =>
          input.key === "identity/unavailable.webp"
            ? {
                ok: false as const,
                error: {
                  code: "not_found",
                  message: "reference object missing",
                  retryable: false,
                },
              }
            : {
                ok: true as const,
                data: {
                  url: `https://blob.test/${encodeURIComponent(input.key)}`,
                },
              }
        ),
      },
    });

    await expect(
      processImageGenerate(
        imagePayload({
          count: 1,
          referenceImages: [
            {
              assetId: "anchor-unavailable",
              role: "identity_anchor",
              storageKey: "identity/unavailable.webp",
            },
            {
              assetId: "anchor-available",
              role: "identity_reference",
              storageKey: "identity/available.webp",
            },
          ],
        }),
        { enqueue, providers },
      ),
    ).rejects.toThrow(
      "Pinned image references could not be hydrated: anchor-unavailable",
    );
    expect(imageGenerate).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
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
      key: "gen/job_img_1/image-1.webp",
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

  it("fails instead of fabricating pixels when the provider returns no bytes or URL", async () => {
    const enqueue = vi.fn(async (_: EnqueueInput) => {});
    const providers = makeProviders({
      image: {
        generate: vi.fn(async () => ({
          ok: true as const,
          data: {
            assets: [{
              key: "provider/missing-image.webp",
              width: 768,
              height: 1024,
              contentType: "image/webp",
            }],
          },
        })),
      },
    });

    await processImageGenerate(imagePayload({ count: 1 }), {
      enqueue,
      providers,
      attemptsMade: 0,
      maxAttempts: 1,
    });

    expect(providers.blob.putPrivate).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: idempotencyKeys.generationFinalize("job_img_1", "failed"),
      payload: expect.objectContaining({
        kind: "generation.failed",
        error: expect.objectContaining({ code: "asset_body_missing" }),
      }),
    }));
  });

  it("enqueues generation.failed when an image provider returns a degenerate PNG", async () => {
    const enqueue = vi.fn(async (_: EnqueueInput) => {});
    const providers = makeProviders({
      image: {
        generate: vi.fn(async () => ({
          ok: true as const,
          data: {
            assets: [
              {
                key: "pipeline/blank.png",
                width: 4,
                height: 4,
                contentType: "image/png",
                body: whitePng(4, 4),
              },
            ],
          },
        })),
      },
    });

    await processImageGenerate(imagePayload({ count: 1 }), { enqueue, providers });

    expect(providers.blob.putPrivate).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [input] = enqueue.mock.calls[0];
    expect(input.dedupeKey).toBe(idempotencyKeys.generationFinalize("job_img_1", "failed"));
    expect((input.payload as Record<string, unknown>).kind).toBe("generation.failed");
    expect(((input.payload as Record<string, unknown>).error as Record<string, unknown>).code).toBe(
      "asset_quality_failed",
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
    const recordTransportExecution = vi.fn(async () => {});
    const providers = makeProviders({
      image: {
        retryCapabilities: { deterministicIdempotencyKey: true, retryableFailureCodes: ["rate_limited"] },
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
        recordTransportExecution,
      }),
    ).rejects.toThrow("try again");
    expect(enqueue).not.toHaveBeenCalled();
    expect(recordTransportExecution).toHaveBeenNthCalledWith(1, expect.objectContaining({ transportAttemptNo: 1, status: "running", idempotencyKey: "generation:job_img_1:1:provider" }));
    expect(recordTransportExecution).toHaveBeenNthCalledWith(2, expect.objectContaining({ transportAttemptNo: 1, status: "failed" }));
  });

  it("does not replay an ambiguous invocation when the provider lacks deterministic idempotency", async () => {
    const enqueue = vi.fn(async (_: EnqueueInput) => {});
    const recordTransportExecution = vi.fn(async () => {});
    const providers = makeProviders({
      image: {
        generate: vi.fn(async () => ({ ok: false as const, error: { code: "timeout", message: "provider outcome unknown", retryable: true } })),
      },
    });

    await processImageGenerate(imagePayload({ attemptId: "attempt-non-replayable", attemptNo: 1 }), {
      enqueue,
      providers,
      attemptsMade: 0,
      maxAttempts: 3,
      recordTransportExecution,
    });

    expect(providers.image.generate).toHaveBeenCalledTimes(1);
    expect(recordTransportExecution).toHaveBeenLastCalledWith(expect.objectContaining({ status: "unknown", transportAttemptNo: 1 }));
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        kind: "generation.failed",
        error: expect.objectContaining({ code: "ambiguous_non_replayable", attemptOutcome: "unknown", retryability: "not_retryable" }),
      }),
    }));
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

describe("processCharacterPreviewGenerate", () => {
  it("persists a real provider asset and returns a preview completion to main", async () => {
    const enqueue = vi.fn(async (_: EnqueueInput) => {});
    const providers = makeProviders({
      image: {
        generate: vi.fn(async () => ({
          ok: true as const,
          data: {
            assets: [{
              key: "provider/preview.png",
              width: 832,
              height: 1024,
              contentType: "image/png",
              body: patternedPng(4, 4),
            }],
          },
        })),
      },
    });

    await processCharacterPreviewGenerate(previewPayload(), { enqueue, providers });

    expect(providers.blob.putPrivate).toHaveBeenCalledWith({
      key: "preview/preview-job-1/image-1.png",
      body: expect.anything(),
      contentType: "image/png",
    });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      queue: MAIN_QUEUES.aiFinalize,
      dedupeKey: idempotencyKeys.characterPreviewFinalize(
        "preview-job-1",
        "completed",
      ),
      payload: expect.objectContaining({
        kind: "character.preview.completed",
        provider: "backend",
        previewJobId: "preview-job-1",
      }),
    }));
  });

  it("fails closed when a provider returns only a key without bytes or URL", async () => {
    const enqueue = vi.fn(async (_: EnqueueInput) => {});
    const providers = makeProviders({
      image: {
        generate: vi.fn(async () => ({
          ok: true as const,
          data: {
            assets: [{
              key: "provider/missing-preview.png",
              width: 832,
              height: 1024,
              contentType: "image/png",
            }],
          },
        })),
      },
    });

    await processCharacterPreviewGenerate(previewPayload(), {
      enqueue,
      providers,
      attemptsMade: 0,
      maxAttempts: 1,
    });

    expect(providers.blob.putPrivate).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: idempotencyKeys.characterPreviewFinalize(
        "preview-job-1",
        "failed",
      ),
      payload: expect.objectContaining({
        kind: "character.preview.failed",
        error: expect.objectContaining({ code: "asset_body_missing" }),
      }),
    }));
  });
});

function patternedPng(width: number, height: number) {
  const rows = Array.from({ length: height }, (_, y) => {
    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = 1 + x * 3;
      row[offset] = (x * 67 + y * 19) % 256;
      row[offset + 1] = (x * 29 + y * 83) % 256;
      row[offset + 2] = (x * 11 + y * 47) % 256;
    }
    return row;
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]));
}

function whitePng(width: number, height: number) {
  const rows = Array.from({ length: height }, () => {
    const row = Buffer.alloc(1 + width * 3, 255);
    row[0] = 0;
    return row;
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]));
}

function pngChunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const chunk = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(chunk), 0);
  return Buffer.concat([length, chunk, crc]);
}

const pngCrcTable = new Uint32Array(256).map((_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = pngCrcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

describe("processVideoGenerate", () => {
  it("writes a single blob and enqueues generation.completed with seconds asset", async () => {
    const enqueue = vi.fn(async (_: EnqueueInput) => {});
    const recordTransportExecution = vi.fn(async () => {});
    const providers = makeProviders();

    await processVideoGenerate(videoPayload(), { enqueue, providers, recordTransportExecution });

    expect(providers.blob.putPrivate).toHaveBeenCalledTimes(1);
    expect(providers.blob.putPrivate).toHaveBeenCalledWith({
      key: "gen/job_vid_1/video.mp4",
      body: mockVideoMp4Bytes(),
      contentType: "video/mp4",
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(recordTransportExecution).toHaveBeenNthCalledWith(1, expect.objectContaining({
      provider: "mock",
      model: "mock-video",
      status: "running",
    }));

    const [input] = enqueue.mock.calls[0];
    expect(input.queue).toBe(MAIN_QUEUES.aiFinalize);
    expect(input.dedupeKey).toBe(idempotencyKeys.generationFinalize("job_vid_1", "completed"));

    const payload = input.payload as Record<string, unknown>;
    expect(payload.kind).toBe("generation.completed");
    expect(payload.mode).toBe("video");
    expect(payload.provider).toBe("mock");
    expect(payload.model).toBe("mock-video");
    expect(payload.assets).toEqual([
      {
        key: "gen/job_vid_1/video.mp4",
        seconds: 6,
        contentType: "video/mp4",
        providerKey: "mock/videos/seed_v1.mp4",
      },
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
      key: "gen/job_vid_1/video.mp4",
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
