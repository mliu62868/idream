// SPEC: Unit tests for the gen pipeline. Providers and durable hand-off ports are
// stubbed, so no Redis, HTTP, or disk are touched. Image/video outcomes persist
// one terminal record before ACK across every image/video use case.
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type GenerationTerminalRecordIngest,
  type ImageGeneratePayload,
  type VideoGeneratePayload,
} from "@idream/shared/contracts";
import { mockVideoMp4Bytes } from "@idream/shared";
import {
  type PipelineDeps,
  processImageGenerate,
  processVideoGenerate,
} from "./pipeline";
import type { GenProviders } from "./providers";
import { env } from "./env";

const originalFetch = globalThis.fetch;
const originalImageProvider = process.env.GEN_IMAGE_PROVIDER;
const originalVideoProvider = process.env.GEN_VIDEO_PROVIDER;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalImageProvider === undefined) {
    delete process.env.GEN_IMAGE_PROVIDER;
  } else {
    process.env.GEN_IMAGE_PROVIDER = originalImageProvider;
  }
  if (originalVideoProvider === undefined) {
    delete process.env.GEN_VIDEO_PROVIDER;
  } else {
    process.env.GEN_VIDEO_PROVIDER = originalVideoProvider;
  }
  vi.restoreAllMocks();
});

function imagePayload(overrides: Partial<ImageGeneratePayload> = {}): ImageGeneratePayload {
  return {
    version: 1,
    kind: "image",
    requestId: "req_img_1",
    generationJobId: "job_img_1",
    attemptId: "job_img_1:1",
    attemptNo: 1,
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
    provider: env.IMAGE_PROVIDER,
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
    attemptId: "job_vid_1:1",
    attemptNo: 1,
    userId: "user_1",
    characterId: null,
    prompt: "a slow pan over a city skyline",
    negativePrompt: null,
    controls: {},
    seconds: 6,
    seed: "seed_v1",
    model: "mock-video",
    provider: env.VIDEO_PROVIDER,
    outputPrefix: "gen/job_vid_1/",
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
        data: {
          asset: {
            key: "mock/videos/seed_v1.mp4",
            seconds: 6,
            body: mockVideoMp4Bytes(),
          },
        },
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
      putPrivateIfAbsent: vi.fn(async (input) => ({
        ok: true as const,
        data: {
          key: input.key,
          size: input.body.byteLength,
          created: true,
        },
      })),
      delete: vi.fn(async () => ({
        ok: true as const,
        data: { deleted: true as const },
      })),
      signGetUrl: vi.fn(async (input) => ({
        ok: true as const,
        data: { url: `mock://${input.key}` },
      })),
    },
    ...over,
  };
}

function makePipelineDeps(
  providers: GenProviders,
  overrides: Partial<Omit<PipelineDeps, "providers">> = {},
): PipelineDeps {
  return {
    providers,
    acknowledgeTerminalRecord: vi.fn(async () => {}),
    recordTransportExecution: vi.fn(async () => {}),
    ...overrides,
  };
}

function successfulPutPrivateIfAbsent() {
  return vi.fn(async (input: {
    key: string;
    body: Uint8Array;
    contentType: string;
  }) => ({
    ok: true as const,
    data: {
      key: input.key,
      size: input.body.byteLength,
      created: true,
    },
  }));
}

function makeMemoryBlob(): GenProviders["blob"] {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();
  return {
    putPrivate: vi.fn(async (input) => {
      objects.set(input.key, { body: input.body, contentType: input.contentType });
      return {
        ok: true as const,
        data: { key: input.key, size: input.body.byteLength },
      };
    }),
    putPrivateIfAbsent: vi.fn(async (input) => {
      if (objects.has(input.key)) {
        return {
          ok: true as const,
          data: {
            key: input.key,
            size: input.body.byteLength,
            created: false,
          },
        };
      }
      objects.set(input.key, { body: input.body, contentType: input.contentType });
      return {
        ok: true as const,
        data: {
          key: input.key,
          size: input.body.byteLength,
          created: true,
        },
      };
    }),
    delete: vi.fn(async (input) => {
      objects.delete(input.key);
      return { ok: true as const, data: { deleted: true as const } };
    }),
    getPrivate: vi.fn(async (input) => {
      const object = objects.get(input.key);
      return object
        ? {
            ok: true as const,
            data: { body: object.body, contentType: object.contentType },
          }
        : {
            ok: false as const,
            error: {
              code: "not_found",
              message: `Object ${input.key} was not found`,
              retryable: false,
            },
          };
    }),
    signGetUrl: vi.fn(async (input) => ({
      ok: true as const,
      data: { url: `memory://${input.key}` },
    })),
  };
}

describe("processImageGenerate", () => {
  it("persists and acknowledges a succeeded terminal record", async () => {
    const providers = makeProviders();
    const acknowledgeTerminalRecord = vi.fn(async (_: GenerationTerminalRecordIngest) => {});

    await processImageGenerate(imagePayload(), {
      providers,
      acknowledgeTerminalRecord,
      recordTransportExecution: vi.fn(async () => {}),
    });

    expect(providers.blob.putPrivate).not.toHaveBeenCalled();
    expect(providers.blob.putPrivateIfAbsent).toHaveBeenCalledTimes(3);
    expect(acknowledgeTerminalRecord).toHaveBeenCalledWith(expect.objectContaining({
      terminalRecordChecksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      terminalRecord: expect.objectContaining({
        outcome: "succeeded",
        mode: "image",
        providerInvoked: true,
        generationJobId: "job_img_1",
        assets: expect.arrayContaining([
          expect.objectContaining({
            key: "gen/job_img_1/image-1.png",
            providerKey: "mock/images/seed_1-1.png",
          }),
        ]),
      }),
    }));
  });

  it("keeps image objects isolated between Attempts of the same request", async () => {
    const blob = makeMemoryBlob();
    const providers = makeProviders({ blob });
    const attemptIds = ["attempt_img_isolated_1", "attempt_img_isolated_2"];

    for (const [index, attemptId] of attemptIds.entries()) {
      await processImageGenerate(
        imagePayload({
          attemptId,
          attemptNo: index + 1,
          count: 1,
          outputPrefix: `gen/job_img_1/attempts/${attemptId}/`,
        }),
        makePipelineDeps(providers),
      );
    }

    const imageKeys = vi.mocked(blob.putPrivateIfAbsent).mock.calls
      .map(([input]) => input.key)
      .filter((key) => key.endsWith("/image-1.png"));
    expect(imageKeys).toEqual([
      "gen/job_img_1/attempts/attempt_img_isolated_1/image-1.png",
      "gen/job_img_1/attempts/attempt_img_isolated_2/image-1.png",
    ]);
  });

  it("persists an immutable terminal record and waits for main durable ACK before completing", async () => {
    const acknowledgeTerminalRecord = vi.fn(async (_: GenerationTerminalRecordIngest) => {});
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
      makePipelineDeps(providers, { acknowledgeTerminalRecord }),
    );

    expect(providers.blob.putPrivate).not.toHaveBeenCalled();
    expect(providers.blob.putPrivateIfAbsent).toHaveBeenCalledWith(expect.objectContaining({
      key: "gen/terminal-records/attempt_img_1/terminal.json",
      contentType: "application/json",
    }));
    expect(acknowledgeTerminalRecord).toHaveBeenCalledWith(expect.objectContaining({
      terminalRecordChecksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      terminalRecord: expect.objectContaining({
        outcome: "succeeded",
        attemptId: "attempt_img_1",
        generationJobId: "job_img_1",
        model: "mock-image",
        provider: env.IMAGE_PROVIDER,
        providerInvoked: true,
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

  it("replays an image terminal record after relay interruption without invoking the provider twice", async () => {
    const providers = makeProviders({ blob: makeMemoryBlob() });
    const acknowledgeTerminalRecord = vi.fn()
      .mockRejectedValueOnce(new Error("terminal relay unavailable"))
      .mockResolvedValue(undefined);
    const payload = imagePayload({ attemptId: "attempt_img_resume", attemptNo: 1 });

    await expect(processImageGenerate(
      payload,
      makePipelineDeps(providers, { acknowledgeTerminalRecord }),
    )).rejects.toThrow("terminal relay unavailable");
    await processImageGenerate(
      payload,
      makePipelineDeps(providers, { acknowledgeTerminalRecord, attemptsMade: 1 }),
    );

    expect(providers.image.generate).toHaveBeenCalledTimes(1);
    expect(providers.moderation.check).toHaveBeenCalledTimes(1);
    expect(providers.blob.putPrivate).not.toHaveBeenCalled();
    expect(providers.blob.putPrivateIfAbsent).toHaveBeenCalledTimes(3);
    expect(acknowledgeTerminalRecord).toHaveBeenCalledTimes(2);
    expect(acknowledgeTerminalRecord).toHaveBeenLastCalledWith(expect.objectContaining({
      terminalRecordRef: "gen/terminal-records/attempt_img_resume/terminal.json",
      terminalRecord: expect.objectContaining({ outcome: "succeeded" }),
    }));
  });

  it("fails closed before moderation when the pinned provider requires another adapter", async () => {
    process.env.GEN_IMAGE_PROVIDER = "backend";
    const providers = makeProviders();
    const deps = makePipelineDeps(providers);

    await expect(processImageGenerate(
      imagePayload({ provider: "pipeline" }),
      deps,
    )).rejects.toThrow(
      "Pinned image provider pipeline requires GEN_IMAGE_PROVIDER=pipeline; configured=backend",
    );

    expect(providers.moderation.check).not.toHaveBeenCalled();
    expect(providers.image.generate).not.toHaveBeenCalled();
    expect(providers.blob.putPrivateIfAbsent).not.toHaveBeenCalled();
  });

  it("replays a persisted terminal record before checking a drifted adapter", async () => {
    process.env.GEN_IMAGE_PROVIDER = "pipeline";
    const providers = makeProviders({ blob: makeMemoryBlob() });
    const acknowledgeTerminalRecord = vi.fn()
      .mockRejectedValueOnce(new Error("terminal relay unavailable"))
      .mockResolvedValue(undefined);
    const payload = imagePayload({
      provider: "pipeline",
      attemptId: "attempt_img_adapter_drift",
      attemptNo: 1,
    });

    await expect(processImageGenerate(
      payload,
      makePipelineDeps(providers, { acknowledgeTerminalRecord }),
    )).rejects.toThrow("terminal relay unavailable");
    process.env.GEN_IMAGE_PROVIDER = "backend";
    await processImageGenerate(
      payload,
      makePipelineDeps(providers, {
        acknowledgeTerminalRecord,
        attemptsMade: 1,
      }),
    );

    expect(providers.image.generate).toHaveBeenCalledTimes(1);
    expect(providers.moderation.check).toHaveBeenCalledTimes(1);
    expect(acknowledgeTerminalRecord).toHaveBeenCalledTimes(2);
  });

  it("hydrates reference image storage keys before calling the image provider", async () => {
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
        putPrivateIfAbsent: successfulPutPrivateIfAbsent(),
        delete: vi.fn(async () => ({
          ok: true as const,
          data: { deleted: true as const },
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
      makePipelineDeps(providers),
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
        putPrivateIfAbsent: successfulPutPrivateIfAbsent(),
        delete: vi.fn(async () => ({
          ok: true as const,
          data: { deleted: true as const },
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
    const deps = makePipelineDeps(providers);

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
        deps,
      ),
    ).rejects.toThrow(
      "Pinned image references could not be hydrated: anchor-unavailable",
    );
    expect(imageGenerate).not.toHaveBeenCalled();
    expect(deps.acknowledgeTerminalRecord).not.toHaveBeenCalled();
  });

  it("downloads provider asset URLs before writing blobs", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("downloaded-image", { status: 200 }),
    ) as typeof fetch;
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

    const deps = makePipelineDeps(providers);
    await processImageGenerate(imagePayload({ count: 1 }), deps);

    expect(fetch).toHaveBeenCalledWith(
      "https://pipeline-assets.test/job_img_1.webp",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(providers.blob.putPrivateIfAbsent).toHaveBeenCalledWith({
      key: "gen/job_img_1/image-1.webp",
      body: new TextEncoder().encode("downloaded-image"),
      contentType: "image/webp",
    });
    expect(deps.acknowledgeTerminalRecord).toHaveBeenCalledWith(expect.objectContaining({
      terminalRecord: expect.objectContaining({ outcome: "succeeded" }),
    }));
  });

  it("persists and acknowledges a failed terminal record when an image provider returns no assets", async () => {
    const providers = makeProviders({
      image: {
        generate: vi.fn(async () => ({
          ok: true as const,
          data: { assets: [] },
        })),
      },
    });
    const acknowledgeTerminalRecord = vi.fn(async (_: GenerationTerminalRecordIngest) => {});
    const recordTransportExecution = vi.fn(async () => {});

    await processImageGenerate(imagePayload(), {
      providers,
      acknowledgeTerminalRecord,
      recordTransportExecution,
    });

    expect(providers.blob.putPrivate).not.toHaveBeenCalled();
    expect(providers.blob.putPrivateIfAbsent).toHaveBeenCalledTimes(2);
    expect(acknowledgeTerminalRecord).toHaveBeenCalledWith(expect.objectContaining({
      terminalRecord: expect.objectContaining({
        outcome: "failed",
        error: expect.objectContaining({ code: "empty_provider_result" }),
      }),
    }));
  });

  it("fails instead of fabricating pixels when the provider returns no bytes or URL", async () => {
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
    const deps = makePipelineDeps(providers, { attemptsMade: 0, maxAttempts: 1 });

    await processImageGenerate(imagePayload({ count: 1 }), deps);

    expect(providers.blob.putPrivate).not.toHaveBeenCalled();
    expect(providers.blob.putPrivateIfAbsent).toHaveBeenCalledTimes(2);
    expect(deps.acknowledgeTerminalRecord).toHaveBeenCalledWith(expect.objectContaining({
      terminalRecord: expect.objectContaining({
        outcome: "failed",
        error: expect.objectContaining({ code: "asset_body_missing" }),
      }),
    }));
  });

  it("persists a failed terminal record when an image provider returns a degenerate PNG", async () => {
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
    const deps = makePipelineDeps(providers);

    await processImageGenerate(imagePayload({ count: 1 }), deps);

    expect(providers.blob.putPrivate).not.toHaveBeenCalled();
    expect(providers.blob.putPrivateIfAbsent).toHaveBeenCalledTimes(2);
    expect(deps.acknowledgeTerminalRecord).toHaveBeenCalledWith(expect.objectContaining({
      terminalRecord: expect.objectContaining({
        outcome: "failed",
        error: expect.objectContaining({ code: "asset_quality_failed" }),
      }),
    }));
  });

  it("rejects a multi-panel identity candidate before persisting any artifact", async () => {
    const providers = makeProviders({
      image: {
        generate: vi.fn(async () => ({
          ok: true as const,
          data: {
            assets: [
              {
                key: "pipeline/contact-sheet.png",
                width: 80,
                height: 100,
                contentType: "image/png",
                body: contactSheetPng(),
              },
            ],
          },
        })),
      },
    });
    const deps = makePipelineDeps(providers);

    await processImageGenerate(
      imagePayload({
        count: 1,
        controls: {
          compositionRequirement: "single_subject_single_frame",
        },
      }),
      deps,
    );

    expect(providers.blob.putPrivate).not.toHaveBeenCalled();
    expect(providers.blob.putPrivateIfAbsent).toHaveBeenCalledTimes(2);
    expect(deps.acknowledgeTerminalRecord).toHaveBeenCalledWith(expect.objectContaining({
      terminalRecord: expect.objectContaining({
        outcome: "failed",
        error: expect.objectContaining({
          code: "asset_quality_failed",
          message: expect.stringMatching(/multiple panels|contact sheet/i),
        }),
      }),
    }));
  });

  it("persists a failed terminal record on final blob persistence failure", async () => {
    const providers = makeProviders({
      blob: {
        putPrivate: vi.fn(async (input) => ({
          ok: true as const,
          data: { key: input.key, size: input.body.byteLength },
        })),
        putPrivateIfAbsent: vi.fn(async (input) =>
          input.key.includes("/image-")
            ? {
                ok: false as const,
                error: {
                  code: "blob_write_failed",
                  message: "object store unavailable",
                  retryable: true,
                },
              }
            : {
                ok: true as const,
                data: {
                  key: input.key,
                  size: input.body.byteLength,
                  created: true,
                },
              }
        ),
        delete: vi.fn(async () => ({
          ok: true as const,
          data: { deleted: true as const },
        })),
        signGetUrl: vi.fn(async (input) => ({
          ok: true as const,
          data: { url: `mock://${input.key}` },
        })),
      },
    });
    const deps = makePipelineDeps(providers, { attemptsMade: 2, maxAttempts: 3 });

    await processImageGenerate(imagePayload(), deps);

    expect(deps.acknowledgeTerminalRecord).toHaveBeenCalledWith(expect.objectContaining({
      terminalRecord: expect.objectContaining({
        outcome: "failed",
        error: expect.objectContaining({ code: "asset_persist_failed" }),
      }),
    }));
  });

  it("rolls back blobs created before a later image asset persistence failure", async () => {
    const deleteBlob = vi.fn(async () => ({
      ok: true as const,
      data: { deleted: true as const },
    }));
    const providers = makeProviders({
      blob: {
        putPrivate: vi.fn(async (input) => ({
          ok: true as const,
          data: { key: input.key, size: input.body.byteLength },
        })),
        putPrivateIfAbsent: vi.fn(async (input) =>
          input.key.endsWith("/image-2.png")
            ? {
                ok: false as const,
                error: {
                  code: "blob_write_failed",
                  message: "second image unavailable",
                  retryable: true,
                },
              }
            : {
                ok: true as const,
                data: {
                  key: input.key,
                  size: input.body.byteLength,
                  created: true,
                },
              },
        ),
        delete: deleteBlob,
        signGetUrl: vi.fn(async (input) => ({
          ok: true as const,
          data: { url: `mock://${input.key}` },
        })),
      },
    });

    await processImageGenerate(
      imagePayload({ count: 2 }),
      makePipelineDeps(providers, { attemptsMade: 2, maxAttempts: 3 }),
    );

    expect(deleteBlob).toHaveBeenCalledTimes(1);
    expect(deleteBlob).toHaveBeenCalledWith({
      key: "gen/job_img_1/image-1.png",
    });
  });

  it("persists and acknowledges a blocked terminal record on a provider content block", async () => {
    const providers = makeProviders({
      image: {
        generate: vi.fn(async () => ({
          ok: false as const,
          error: { code: "content_blocked", message: "blocked", retryable: false },
        })),
      },
    });
    const acknowledgeTerminalRecord = vi.fn(async (_: GenerationTerminalRecordIngest) => {});
    const recordTransportExecution = vi.fn(async () => {});

    await processImageGenerate(imagePayload(), {
      providers,
      acknowledgeTerminalRecord,
      recordTransportExecution,
    });

    expect(providers.blob.putPrivate).not.toHaveBeenCalled();
    expect(providers.blob.putPrivateIfAbsent).toHaveBeenCalledTimes(2);
    expect(acknowledgeTerminalRecord).toHaveBeenCalledWith(expect.objectContaining({
      terminalRecord: expect.objectContaining({
        outcome: "blocked",
        providerInvoked: true,
        block: {
          policyCode: "content_blocked",
          message: "blocked",
          layer: "provider",
        },
      }),
    }));
    expect(recordTransportExecution).toHaveBeenCalledTimes(1);
    expect(recordTransportExecution).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ status: "running" }),
    );
  });

  it("throws (lets the queue retry) on a retryable provider error", async () => {
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
    const deps = makePipelineDeps(providers, {
      attemptsMade: 0,
      maxAttempts: 3,
      recordTransportExecution,
    });

    await expect(
      processImageGenerate(imagePayload(), deps),
    ).rejects.toThrow("try again");
    expect(deps.acknowledgeTerminalRecord).not.toHaveBeenCalled();
    expect(recordTransportExecution).toHaveBeenNthCalledWith(1, expect.objectContaining({ transportAttemptNo: 1, status: "running", idempotencyKey: "generation:job_img_1:1:provider" }));
    expect(recordTransportExecution).toHaveBeenNthCalledWith(2, expect.objectContaining({ transportAttemptNo: 1, status: "failed" }));
  });

  it("does not replay an ambiguous invocation when the provider lacks deterministic idempotency", async () => {
    const recordTransportExecution = vi.fn(async () => {});
    const providers = makeProviders({
      image: {
        generate: vi.fn(async () => ({ ok: false as const, error: { code: "timeout", message: "provider outcome unknown", retryable: true } })),
      },
    });
    const deps = makePipelineDeps(providers, {
      attemptsMade: 0,
      maxAttempts: 3,
      recordTransportExecution,
    });

    await processImageGenerate(
      imagePayload({ attemptId: "attempt-non-replayable", attemptNo: 1 }),
      deps,
    );

    expect(providers.image.generate).toHaveBeenCalledTimes(1);
    expect(recordTransportExecution).toHaveBeenCalledTimes(1);
    expect(recordTransportExecution).toHaveBeenLastCalledWith(expect.objectContaining({ status: "running", transportAttemptNo: 1 }));
    expect(deps.acknowledgeTerminalRecord).toHaveBeenCalledWith(expect.objectContaining({
      terminalRecord: expect.objectContaining({
        outcome: "unknown",
        error: expect.objectContaining({ code: "ambiguous_non_replayable", retryability: "not_retryable" }),
      }),
    }));
  });

  it("persists a failed terminal record when retryable errors hit the final attempt", async () => {
    const providers = makeProviders({
      image: {
        retryCapabilities: {
          deterministicIdempotencyKey: true,
          retryableFailureCodes: ["timeout"],
        },
        generate: vi.fn(async () => ({
          ok: false as const,
          error: { code: "timeout", message: "timed out", retryable: true },
        })),
      },
    });
    const deps = makePipelineDeps(providers, { attemptsMade: 2, maxAttempts: 3 });

    await processImageGenerate(imagePayload(), deps);

    expect(deps.acknowledgeTerminalRecord).toHaveBeenCalledWith(expect.objectContaining({
      terminalRecord: expect.objectContaining({
        outcome: "failed",
        error: expect.objectContaining({ code: "timeout" }),
      }),
    }));
  });

  it("persists a blocked terminal record when input moderation blocks before provider work", async () => {
    const providers = makeProviders({
      moderation: {
        check: vi.fn(async () => ({
          ok: true as const,
          data: { status: "blocked" as const, policyCode: "UNDERAGE", confidence: 0.99 },
        })),
      },
    });
    const deps = makePipelineDeps(providers);

    await processImageGenerate(imagePayload(), deps);

    expect(providers.image.generate).not.toHaveBeenCalled();
    expect(deps.acknowledgeTerminalRecord).toHaveBeenCalledWith(expect.objectContaining({
      terminalRecord: expect.objectContaining({
        outcome: "blocked",
        providerInvoked: false,
        block: expect.objectContaining({ policyCode: "UNDERAGE", layer: "input" }),
      }),
    }));
  });

  it("retries moderation infrastructure failure without fabricating a provider terminal", async () => {
    const providers = makeProviders({
      moderation: {
        check: vi.fn(async () => ({
          ok: false as const,
          error: {
            code: "moderation_unavailable",
            message: "moderation service unavailable",
            retryable: true,
          },
        })),
      },
    });
    const deps = makePipelineDeps(providers);

    await expect(processImageGenerate(imagePayload(), deps)).rejects.toThrow(
      "Input moderation failed",
    );
    expect(providers.image.generate).not.toHaveBeenCalled();
    expect(deps.recordTransportExecution).not.toHaveBeenCalled();
    expect(deps.acknowledgeTerminalRecord).not.toHaveBeenCalled();
  });

  it("rejects an invalid payload before touching any provider", async () => {
    const providers = makeProviders();
    const deps = makePipelineDeps(providers);

    await expect(
      processImageGenerate(imagePayload({ count: 99 as unknown as 4 }), deps),
    ).rejects.toThrow();
    expect(providers.image.generate).not.toHaveBeenCalled();
    expect(deps.acknowledgeTerminalRecord).not.toHaveBeenCalled();
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

function contactSheetPng() {
  const width = 80;
  const height = 100;
  const rows = Array.from({ length: height }, (_, y) => {
    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = 1 + x * 3;
      const color = x < 60
        ? [
            (x * 3 + y) % 180,
            (x + y * 2) % 180,
            (x * 2 + y * 3) % 180,
          ]
        : [
            220 - Math.floor(y / 25) * 20,
            190 - Math.floor(y / 25) * 10,
            160 + ((x + y) % 40),
          ];
      row[offset] = color[0];
      row[offset + 1] = color[1];
      row[offset + 2] = color[2];
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
  it("keeps video objects isolated between Attempts of the same request", async () => {
    const blob = makeMemoryBlob();
    const providers = makeProviders({ blob });
    const attemptIds = ["attempt_vid_isolated_1", "attempt_vid_isolated_2"];

    for (const [index, attemptId] of attemptIds.entries()) {
      await processVideoGenerate(
        videoPayload({
          attemptId,
          attemptNo: index + 1,
          outputPrefix: `gen/job_vid_1/attempts/${attemptId}/`,
        }),
        makePipelineDeps(providers),
      );
    }

    const videoKeys = vi.mocked(blob.putPrivate).mock.calls.map(
      ([input]) => input.key,
    );
    expect(videoKeys).toEqual([
      "gen/job_vid_1/attempts/attempt_vid_isolated_1/video.mp4",
      "gen/job_vid_1/attempts/attempt_vid_isolated_2/video.mp4",
    ]);
  });

  it("passes the pinned source image to the video provider", async () => {
    const providers = makeProviders();
    const referenceImages = [{
      assetId: "source-1",
      role: "source_image" as const,
      b64Json: "aW1hZ2U=",
      contentType: "image/webp",
    }];

    await processVideoGenerate(videoPayload({ referenceImages }), makePipelineDeps(providers));

    expect(providers.video.generate).toHaveBeenCalledWith(
      expect.objectContaining({ referenceImages }),
    );
  });

  it("fails closed when a successful provider response has no video bytes or URL", async () => {
    const providers = makeProviders({
      video: {
        generate: vi.fn(async () => ({
          ok: true as const,
          data: {
            asset: {
              key: "backend/videos/missing.mp4",
              seconds: 4,
              contentType: "video/mp4",
            },
          },
        })),
      },
    });
    const deps = makePipelineDeps(providers, { attemptsMade: 2, maxAttempts: 3 });

    await processVideoGenerate(videoPayload({ seconds: 4 }), deps);

    expect(providers.blob.putPrivate).not.toHaveBeenCalled();
    expect(providers.blob.putPrivateIfAbsent).toHaveBeenCalledTimes(2);
    expect(deps.acknowledgeTerminalRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalRecord: expect.objectContaining({
          outcome: "failed",
          error: expect.objectContaining({ code: "asset_persist_failed" }),
        }),
      }),
    );
  });

  it("persists and acknowledges a succeeded video terminal record", async () => {
    const recordTransportExecution = vi.fn(async () => {});
    const providers = makeProviders();
    const acknowledgeTerminalRecord = vi.fn(async (_: GenerationTerminalRecordIngest) => {});

    await processVideoGenerate(videoPayload(), {
      providers,
      recordTransportExecution,
      acknowledgeTerminalRecord,
    });

    expect(providers.blob.putPrivate).toHaveBeenCalledTimes(1);
    expect(providers.blob.putPrivateIfAbsent).toHaveBeenCalledTimes(1);
    expect(providers.blob.putPrivate).toHaveBeenCalledWith({
      key: "gen/job_vid_1/video.mp4",
      body: mockVideoMp4Bytes(),
      contentType: "video/mp4",
    });
    expect(recordTransportExecution).toHaveBeenNthCalledWith(1, expect.objectContaining({
      provider: env.VIDEO_PROVIDER,
      model: "mock-video",
      status: "running",
    }));
    expect(acknowledgeTerminalRecord).toHaveBeenCalledWith(expect.objectContaining({
      terminalRecord: expect.objectContaining({
        outcome: "succeeded",
        mode: "video",
        provider: env.VIDEO_PROVIDER,
        providerInvoked: true,
        model: "mock-video",
        assets: [{
          ordinal: 0,
          key: "gen/job_vid_1/video.mp4",
          seconds: 6,
          contentType: "video/mp4",
          providerKey: "mock/videos/seed_v1.mp4",
        }],
      }),
    }));
  });

  it("replays a video terminal record after relay interruption without invoking the provider twice", async () => {
    const providers = makeProviders({ blob: makeMemoryBlob() });
    const acknowledgeTerminalRecord = vi.fn()
      .mockRejectedValueOnce(new Error("terminal relay unavailable"))
      .mockResolvedValue(undefined);
    const payload = videoPayload({ attemptId: "attempt_vid_resume", attemptNo: 1 });

    await expect(processVideoGenerate(
      payload,
      makePipelineDeps(providers, { acknowledgeTerminalRecord }),
    )).rejects.toThrow("terminal relay unavailable");
    await processVideoGenerate(
      payload,
      makePipelineDeps(providers, { acknowledgeTerminalRecord, attemptsMade: 1 }),
    );

    expect(providers.video.generate).toHaveBeenCalledTimes(1);
    expect(providers.moderation.check).toHaveBeenCalledTimes(1);
    expect(providers.blob.putPrivate).toHaveBeenCalledTimes(1);
    expect(providers.blob.putPrivateIfAbsent).toHaveBeenCalledTimes(1);
    expect(acknowledgeTerminalRecord).toHaveBeenCalledTimes(2);
    expect(acknowledgeTerminalRecord).toHaveBeenLastCalledWith(expect.objectContaining({
      terminalRecordRef: "gen/terminal-records/attempt_vid_resume/terminal.json",
      terminalRecord: expect.objectContaining({ outcome: "succeeded" }),
    }));
  });

  it("does not replay an ambiguous video invocation without deterministic idempotency", async () => {
    const providers = makeProviders({
      video: {
        generate: vi.fn(async () => ({
          ok: false as const,
          error: {
            code: "timeout",
            message: "provider outcome unknown",
            retryable: true,
          },
        })),
      },
    });
    const deps = makePipelineDeps(providers, { attemptsMade: 0, maxAttempts: 3 });

    await processVideoGenerate(
      videoPayload({ attemptId: "attempt_vid_unknown", attemptNo: 1 }),
      deps,
    );

    expect(providers.video.generate).toHaveBeenCalledTimes(1);
    expect(deps.recordTransportExecution).toHaveBeenCalledTimes(1);
    expect(deps.recordTransportExecution).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "running" }),
    );
    expect(deps.acknowledgeTerminalRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalRecord: expect.objectContaining({
          outcome: "unknown",
          error: expect.objectContaining({
            code: "ambiguous_non_replayable",
            retryability: "not_retryable",
          }),
        }),
      }),
    );
  });

  it("downloads provider video asset URLs before writing blobs", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("downloaded-video", { status: 200 }),
    ) as typeof fetch;
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
    const deps = makePipelineDeps(providers);

    await processVideoGenerate(videoPayload({ seconds: 8 }), deps);

    expect(fetch).toHaveBeenCalledWith(
      "https://pipeline-assets.test/job_vid_1.mp4",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(providers.blob.putPrivate).toHaveBeenCalledWith({
      key: "gen/job_vid_1/video.mp4",
      body: new TextEncoder().encode("downloaded-video"),
      contentType: "video/mp4",
    });
    expect(deps.acknowledgeTerminalRecord).toHaveBeenCalledWith(expect.objectContaining({
      terminalRecord: expect.objectContaining({ outcome: "succeeded" }),
    }));
  });

  it("persists a failed terminal record on final video blob persistence failure", async () => {
    const providers = makeProviders({
      blob: {
        putPrivate: vi.fn(async (input) =>
          input.key.endsWith("/video.mp4")
            ? {
                ok: false as const,
                error: {
                  code: "blob_write_failed",
                  message: "object store unavailable",
                  retryable: true,
                },
              }
            : {
                ok: true as const,
                data: { key: input.key, size: input.body.byteLength },
              }
        ),
        putPrivateIfAbsent: successfulPutPrivateIfAbsent(),
        delete: vi.fn(async () => ({
          ok: true as const,
          data: { deleted: true as const },
        })),
        signGetUrl: vi.fn(async (input) => ({
          ok: true as const,
          data: { url: `mock://${input.key}` },
        })),
      },
    });
    const deps = makePipelineDeps(providers, { attemptsMade: 2, maxAttempts: 3 });

    await processVideoGenerate(videoPayload(), deps);

    expect(deps.acknowledgeTerminalRecord).toHaveBeenCalledWith(expect.objectContaining({
      terminalRecord: expect.objectContaining({
        outcome: "failed",
        error: expect.objectContaining({ code: "asset_persist_failed" }),
      }),
    }));
  });

  it("persists a blocked video terminal record on a provider content block", async () => {
    const providers = makeProviders({
      video: {
        generate: vi.fn(async () => ({
          ok: false as const,
          error: { code: "content_blocked", message: "blocked", retryable: false },
        })),
      },
    });
    const deps = makePipelineDeps(providers);

    await processVideoGenerate(videoPayload(), deps);

    expect(providers.blob.putPrivate).not.toHaveBeenCalled();
    expect(providers.blob.putPrivateIfAbsent).toHaveBeenCalledTimes(2);
    expect(deps.acknowledgeTerminalRecord).toHaveBeenCalledWith(expect.objectContaining({
      terminalRecord: expect.objectContaining({
        outcome: "blocked",
        providerInvoked: true,
        block: expect.objectContaining({ layer: "provider" }),
      }),
    }));
    expect(deps.recordTransportExecution).toHaveBeenCalledTimes(1);
    expect(deps.recordTransportExecution).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ status: "running" }),
    );
  });
});

type GenerationLifecycleOutcome = "succeeded" | "failed" | "unknown" | "blocked";

function imageLifecycleResult(outcome: GenerationLifecycleOutcome) {
  switch (outcome) {
    case "succeeded":
      return {
        ok: true as const,
        data: {
          assets: [{
            key: "provider/image.png",
            width: 2,
            height: 2,
            contentType: "image/png",
            body: Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGNgYGD4//8/GDMwAAAp5AX71ZPZmwAAAABJRU5ErkJggg==",
              "base64",
            ),
          }],
        },
      };
    case "failed":
      return {
        ok: false as const,
        error: { code: "backend_error", message: "backend failed", retryable: false },
      };
    case "unknown":
      return {
        ok: false as const,
        error: {
          code: "backend_error",
          message: "provider outcome unknown",
          retryable: true,
          outcome: "ambiguous" as const,
        },
      };
    case "blocked":
      return {
        ok: false as const,
        error: { code: "content_blocked", message: "provider blocked", retryable: false },
      };
  }
}

function videoLifecycleResult(outcome: GenerationLifecycleOutcome) {
  switch (outcome) {
    case "succeeded":
      return {
        ok: true as const,
        data: {
          asset: {
            key: "provider/video.mp4",
            seconds: 6,
            contentType: "video/mp4",
            body: mockVideoMp4Bytes(),
          },
        },
      };
    case "failed":
      return {
        ok: false as const,
        error: { code: "backend_error", message: "backend failed", retryable: false },
      };
    case "unknown":
      return {
        ok: false as const,
        error: {
          code: "backend_error",
          message: "provider outcome unknown",
          retryable: true,
          outcome: "ambiguous" as const,
        },
      };
    case "blocked":
      return {
        ok: false as const,
        error: { code: "content_blocked", message: "provider blocked", retryable: false },
      };
  }
}

function lifecycleHarness(
  mode: "image" | "video",
  outcome: GenerationLifecycleOutcome,
  blob: GenProviders["blob"] = makeMemoryBlob(),
) {
  if (mode === "image") {
    const generate = vi.fn(async () => imageLifecycleResult(outcome));
    const providers = makeProviders({ image: { generate }, blob });
    const payload = imagePayload({
      attemptId: `attempt_contract_${mode}_${outcome}`,
      attemptNo: 1,
      count: 1,
    });
    return {
      generate,
      payload,
      providers,
      run: (deps: PipelineDeps) => processImageGenerate(payload, deps),
    };
  }

  const generate = vi.fn(async () => videoLifecycleResult(outcome));
  const providers = makeProviders({ video: { generate }, blob });
  const payload = videoPayload({
    attemptId: `attempt_contract_${mode}_${outcome}`,
    attemptNo: 1,
  });
  return {
    generate,
    payload,
    providers,
    run: (deps: PipelineDeps) => processVideoGenerate(payload, deps),
  };
}

describe.each(["image", "video"] as const)(
  "%s generation lifecycle contract",
  (mode) => {
    it.each(["succeeded", "failed", "unknown", "blocked"] as const)(
      "persists and relays the %s terminal outcome",
      async (outcome) => {
        const harness = lifecycleHarness(mode, outcome);
        const acknowledgeTerminalRecord = vi.fn(async () => undefined);

        await harness.run(makePipelineDeps(harness.providers, {
          acknowledgeTerminalRecord,
          attemptsMade: 0,
          maxAttempts: 3,
        }));

        expect(harness.generate).toHaveBeenCalledTimes(1);
        expect(acknowledgeTerminalRecord).toHaveBeenCalledWith(
          expect.objectContaining({
            terminalRecord: expect.objectContaining({ outcome, mode }),
          }),
        );
      },
    );

    it("resumes relay admission from the terminal record without invoking the provider twice", async () => {
      const harness = lifecycleHarness(mode, "succeeded");
      const acknowledgeTerminalRecord = vi.fn()
        .mockRejectedValueOnce(new Error("terminal relay unavailable"))
        .mockResolvedValue(undefined);

      await expect(harness.run(makePipelineDeps(harness.providers, {
        acknowledgeTerminalRecord,
      }))).rejects.toThrow("terminal relay unavailable");
      await harness.run(makePipelineDeps(harness.providers, {
        acknowledgeTerminalRecord,
        attemptsMade: 1,
      }));

      expect(harness.generate).toHaveBeenCalledTimes(1);
      expect(acknowledgeTerminalRecord).toHaveBeenCalledTimes(2);
      expect(acknowledgeTerminalRecord.mock.calls[1]?.[0]).toEqual(
        acknowledgeTerminalRecord.mock.calls[0]?.[0],
      );
    });
  },
);

it("retries only video terminal relay admission on transport attempt two", async () => {
  const harness = lifecycleHarness("video", "succeeded");
  const acknowledgeTerminalRecord = vi.fn()
    .mockRejectedValueOnce(new Error("terminal relay Redis unavailable"))
    .mockResolvedValue(undefined);

  await expect(harness.run(makePipelineDeps(harness.providers, {
    acknowledgeTerminalRecord,
    attemptsMade: 0,
    maxAttempts: 3,
  }))).rejects.toThrow("terminal relay Redis unavailable");
  await expect(harness.run(makePipelineDeps(harness.providers, {
    acknowledgeTerminalRecord,
    attemptsMade: 1,
    maxAttempts: 3,
  }))).resolves.toBeUndefined();

  expect(harness.generate).toHaveBeenCalledTimes(1);
  expect(acknowledgeTerminalRecord).toHaveBeenCalledTimes(2);
  expect(acknowledgeTerminalRecord.mock.calls[1]?.[0]).toEqual(
    acknowledgeTerminalRecord.mock.calls[0]?.[0],
  );
});

it("does not invoke a non-idempotent video provider again after artifact persistence fails", async () => {
  const blob = makeMemoryBlob();
  const persistInMemory = blob.putPrivate;
  blob.putPrivate = vi.fn(async (input) =>
    input.key.endsWith("/video.mp4")
      ? {
          ok: false as const,
          error: {
            code: "blob_write_failed",
            message: "video blob unavailable",
            retryable: true,
          },
        }
      : persistInMemory(input),
  );
  const harness = lifecycleHarness("video", "succeeded", blob);
  const acknowledgeTerminalRecord = vi.fn()
    .mockRejectedValueOnce(new Error("terminal relay unavailable"))
    .mockResolvedValue(undefined);

  await expect(harness.run(makePipelineDeps(harness.providers, {
    acknowledgeTerminalRecord,
    attemptsMade: 0,
    maxAttempts: 3,
  }))).rejects.toThrow("terminal relay unavailable");
  await harness.run(makePipelineDeps(harness.providers, {
    acknowledgeTerminalRecord,
    attemptsMade: 1,
    maxAttempts: 3,
  }));

  expect(harness.generate).toHaveBeenCalledTimes(1);
  expect(acknowledgeTerminalRecord).toHaveBeenCalledTimes(2);
  expect(acknowledgeTerminalRecord).toHaveBeenLastCalledWith(
    expect.objectContaining({
      terminalRecord: expect.objectContaining({
        outcome: "failed",
        error: expect.objectContaining({
          code: "asset_persist_failed",
          retryability: "not_retryable",
        }),
      }),
    }),
  );
});

it("retries image artifact persistence only when provider replay is deterministic", async () => {
  const blob = makeMemoryBlob();
  const persistInMemory = blob.putPrivateIfAbsent;
  let rejectFirstImageWrite = true;
  blob.putPrivateIfAbsent = vi.fn(async (input) => {
    if (input.key.endsWith("/image-1.png") && rejectFirstImageWrite) {
      rejectFirstImageWrite = false;
      return {
        ok: false as const,
        error: {
          code: "blob_write_failed",
          message: "image blob unavailable",
          retryable: true,
        },
      };
    }
    return persistInMemory(input);
  });
  const generate = vi.fn(async (
    _input: Parameters<GenProviders["image"]["generate"]>[0],
  ) => imageLifecycleResult("succeeded"));
  const providers = makeProviders({
    image: {
      retryCapabilities: {
        deterministicIdempotencyKey: true,
        retryableFailureCodes: [],
      },
      generate,
    },
    blob,
  });
  const payload = imagePayload({
    attemptId: "attempt_deterministic_image_artifact_retry",
    attemptNo: 1,
    count: 1,
  });

  await expect(processImageGenerate(
    payload,
    makePipelineDeps(providers, { attemptsMade: 0, maxAttempts: 3 }),
  )).rejects.toThrow("image blob unavailable");
  await processImageGenerate(
    payload,
    makePipelineDeps(providers, { attemptsMade: 1, maxAttempts: 3 }),
  );

  expect(generate).toHaveBeenCalledTimes(2);
  expect(generate.mock.calls[0]?.[0]?.requestId).toBe(
    generate.mock.calls[1]?.[0]?.requestId,
  );
});

describe.each(["image", "video"] as const)(
  "%s terminal persistence safety",
  (mode) => {
    it("records unknown instead of replaying a non-idempotent provider", async () => {
      const blob = makeMemoryBlob();
      const persistIfAbsent = blob.putPrivateIfAbsent;
      blob.putPrivateIfAbsent = vi.fn(async (input) =>
        input.key.endsWith("/terminal.json")
          ? {
              ok: false as const,
              error: {
                code: "terminal_blob_unavailable",
                message: `cannot persist ${input.key}`,
                retryable: true,
              },
            }
          : persistIfAbsent(input),
      );
      const harness = lifecycleHarness(mode, "succeeded", blob);
      const recordTransportExecution = vi.fn(async () => undefined);
      const acknowledgeTerminalRecord = vi.fn(async () => undefined);

      await expect(harness.run(makePipelineDeps(harness.providers, {
        recordTransportExecution,
        acknowledgeTerminalRecord,
        attemptsMade: 0,
        maxAttempts: 3,
      }))).resolves.toBeUndefined();

      expect(harness.generate).toHaveBeenCalledTimes(1);
      expect(acknowledgeTerminalRecord).not.toHaveBeenCalled();
      expect(recordTransportExecution).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: "unknown",
          error: expect.objectContaining({
            code: "terminal_record_persist_failed",
          }),
        }),
      );
    });

    it.each(["succeeded", "failed"] as const)(
      "recovers a %s result from simultaneous blob and Main failure without a second provider call",
      async (providerOutcome) => {
      const blob = makeMemoryBlob();
      const persistIfAbsent = blob.putPrivateIfAbsent;
      let terminalBlobAvailable = false;
      blob.putPrivateIfAbsent = vi.fn(async (input) =>
        input.key.endsWith("/terminal.json") && !terminalBlobAvailable
          ? {
              ok: false as const,
              error: {
                code: "terminal_blob_unavailable",
                message: "terminal object store unavailable",
                retryable: true,
              },
            }
          : persistIfAbsent(input),
      );
      const harness = lifecycleHarness(mode, providerOutcome, blob);
      let mainAvailable = false;
      const recordTransportExecution = vi.fn(async (input) => {
        if (input.status === "unknown" && !mainAvailable) {
          throw new Error("Main transport unavailable");
        }
      });
      const acknowledgeTerminalRecord = vi.fn(async () => undefined);

      await expect(harness.run(makePipelineDeps(harness.providers, {
        recordTransportExecution,
        acknowledgeTerminalRecord,
        attemptsMade: 0,
        maxAttempts: 3,
      }))).rejects.toThrow(/could not persist or record terminal evidence/);

      terminalBlobAvailable = true;
      mainAvailable = true;
      await harness.run(makePipelineDeps(harness.providers, {
        recordTransportExecution,
        acknowledgeTerminalRecord,
        attemptsMade: 1,
        maxAttempts: 3,
      }));

      expect(harness.generate).toHaveBeenCalledTimes(1);
      expect(acknowledgeTerminalRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          terminalRecord: expect.objectContaining({
            outcome: "unknown",
            error: expect.objectContaining({
              code: "ambiguous_incomplete_provider_invocation",
              retryability: "not_retryable",
            }),
          }),
        }),
      );
      },
    );
  },
);

it("retries deterministic terminal persistence with the same provider key", async () => {
  const blob = makeMemoryBlob();
  const persistIfAbsent = blob.putPrivateIfAbsent;
  let rejectFirstTerminalWrite = true;
  blob.putPrivateIfAbsent = vi.fn(async (input) => {
    if (input.key.endsWith("/terminal.json") && rejectFirstTerminalWrite) {
      rejectFirstTerminalWrite = false;
      return {
        ok: false as const,
        error: {
          code: "terminal_blob_unavailable",
          message: "terminal object store unavailable",
          retryable: true,
        },
      };
    }
    return persistIfAbsent(input);
  });
  const generate = vi.fn(async (
    _input: Parameters<GenProviders["image"]["generate"]>[0],
  ) => imageLifecycleResult("succeeded"));
  const providers = makeProviders({
    image: {
      retryCapabilities: {
        deterministicIdempotencyKey: true,
        retryableFailureCodes: [],
      },
      generate,
    },
    blob,
  });
  const payload = imagePayload({
    attemptId: "attempt_deterministic_terminal_retry",
    attemptNo: 1,
    count: 1,
  });

  await expect(processImageGenerate(
    payload,
    makePipelineDeps(providers, { attemptsMade: 0, maxAttempts: 3 }),
  )).rejects.toThrow("terminal object store unavailable");
  await processImageGenerate(
    payload,
    makePipelineDeps(providers, { attemptsMade: 1, maxAttempts: 3 }),
  );

  expect(generate).toHaveBeenCalledTimes(2);
  expect(generate.mock.calls[0]?.[0]?.requestId).toBe(
    generate.mock.calls[1]?.[0]?.requestId,
  );
});

it("records unknown when deterministic terminal persistence fails on the final attempt", async () => {
  const blob = makeMemoryBlob();
  const persistIfAbsent = blob.putPrivateIfAbsent;
  blob.putPrivateIfAbsent = vi.fn(async (input) =>
    input.key.endsWith("/terminal.json")
      ? {
          ok: false as const,
          error: {
            code: "terminal_blob_unavailable",
            message: "terminal object store unavailable",
            retryable: true,
          },
        }
      : persistIfAbsent(input),
  );
  const generate = vi.fn(async () => imageLifecycleResult("succeeded"));
  const providers = makeProviders({
    image: {
      retryCapabilities: {
        deterministicIdempotencyKey: true,
        retryableFailureCodes: [],
      },
      generate,
    },
    blob,
  });
  const recordTransportExecution = vi.fn(async () => undefined);

  await processImageGenerate(
    imagePayload({ attemptId: "attempt_deterministic_terminal_final" }),
    makePipelineDeps(providers, {
      attemptsMade: 2,
      maxAttempts: 3,
      recordTransportExecution,
    }),
  );

  expect(generate).toHaveBeenCalledTimes(1);
  expect(recordTransportExecution).toHaveBeenLastCalledWith(
    expect.objectContaining({
      status: "unknown",
      error: expect.objectContaining({
        code: "terminal_record_persist_failed",
      }),
    }),
  );
});
