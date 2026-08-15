import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchCharacterById,
  generatorJobStatusLabel,
  generatorVideoModeCopy,
  generatorShowsSavedLooksEmpty,
  generatorConfigRequestIsCurrent,
  generatorImageEditModelOptions,
  generatorRouteAfterRemixExit,
  invalidateGeneratorConfigAuthority,
  loadGeneratorLooksForViewer,
  loadGeneratorWorkspaceInitialData,
  projectGeneratorModelSelection,
  revalidateGeneratorViewerAuthority,
  removeGeneratorCharacterViewerAuthority,
  suspendGeneratorConfigAuthority,
} from "./GeneratorWorkspace";
// The generation request lifecycle these cases exercise now lives in its own
// module; the workspace only renders it. See generation-request.test.ts for the
// invariants that module owns.
import {
  exactGenerationQuoteForCount,
  requestGenerationJobWithExactAuthority,
  requestMediaVariationWithExactQuote,
} from "@/lib/generation-write-client";
import type { RuntimeGenerationQuote } from "@/lib/public-api-contracts";

describe("generator model selection authority", () => {
  const models = [
    { id: "public-t2i", label: "Public text to image" },
  ];

  it("renders implicit routing as Auto and omits a model request", () => {
    expect(
      projectGeneratorModelSelection(
        { id: "public-t2i", explicit: false },
        models,
      ),
    ).toEqual({
      displayedLabel: "Auto (identity-aware)",
      requestModelId: undefined,
      selectValue: "",
    });
  });

  it("only projects a concrete model after an explicit selection", () => {
    expect(
      projectGeneratorModelSelection(
        { id: "public-t2i", explicit: true },
        models,
      ),
    ).toEqual({
      displayedLabel: "Public text to image",
      requestModelId: "public-t2i",
      selectValue: "public-t2i",
    });
  });

  it("describes automatic video routing as source animation, not identity-aware scene generation", () => {
    expect(
      projectGeneratorModelSelection(
        { id: "", explicit: false },
        models,
        "Auto (animate source)",
      ),
    ).toEqual({
      displayedLabel: "Auto (animate source)",
      requestModelId: undefined,
      selectValue: "",
    });
  });

  it("offers only the image-edit models compatible with the selected source", () => {
    const editModels = [
      {
        id: "chat-image-edit",
        label: "Qwen source edit",
        referenceMode: "source_only" as const,
      },
      {
        id: "character-image-variation",
        label: "Qwen identity edit",
        referenceMode: "identity_source" as const,
      },
      {
        id: "character-image-variation-darkbeast",
        label: "Dark Beast identity edit",
        referenceMode: "identity_source" as const,
      },
    ];

    expect(
      generatorImageEditModelOptions(editModels, [
        "character-image-variation-darkbeast",
      ]),
    ).toEqual([
      editModels[2],
    ]);
    expect(generatorImageEditModelOptions(editModels, [])).toEqual([]);
    expect(generatorImageEditModelOptions(editModels, null)).toEqual(
      editModels,
    );
  });
});

describe("generator video product contract", () => {
  it("explains that video animates the pinned character image", () => {
    expect(generatorVideoModeCopy("Alexa Reeves")).toEqual({
      promptLabel: "Motion direction",
      promptPlaceholder:
        "Describe movement, camera motion, and pacing for this starting image",
      sourceTitle: "Animate this image",
      sourceDescription:
        "This exact Alexa Reeves image is the first frame. Video adds motion; it does not replace the outfit, lighting, or location.",
    });
  });

  it("sets an honest minutes-level expectation while local video is waiting or rendering", () => {
    expect(generatorJobStatusLabel("video", "queued", null)).toBe(
      "Waiting to render · usually 6–10 min",
    );
    expect(generatorJobStatusLabel("video", "running", null)).toBe(
      "Rendering source image · usually 6–10 min",
    );
    expect(generatorJobStatusLabel("video", "completed", null)).toBe("Completed");
    expect(generatorJobStatusLabel("image", "running", null)).toBe("Generating");
  });
});

describe("generator remix route authority", () => {
  it("removes stale Feed provenance when the user chooses another character", () => {
    expect(
      generatorRouteAfterRemixExit(
        "https://idream.test/generate?characterId=old&remixFeedItemId=character%3Aold",
        "new-character",
      ),
    ).toBe("/generate?characterId=new-character");
  });

  it("removes both Feed and Character route intent when entering Freeplay", () => {
    expect(
      generatorRouteAfterRemixExit(
        "/generate?characterId=old&remixFeedItemId=character%3Aold#generator",
        null,
      ),
    ).toBe("/generate#generator");
  });
});

describe("generator target character lookup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats a real 404 as a missing character", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );

    await expect(fetchCharacterById("missing")).resolves.toBeNull();
  });

  it("does not turn a target-character service failure into a missing character", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error: { message: "Character service unavailable." },
            }),
            {
              status: 503,
              headers: { "content-type": "application/json" },
            },
          ),
      ),
    );

    await expect(fetchCharacterById("target")).rejects.toThrow(
      "Character service unavailable.",
    );
  });
});

describe("generator saved Looks authority", () => {
  it("hides the owner-only empty state for a public non-owner character", () => {
    const ready = { phase: "ready", error: null, hasSnapshot: true } as const;

    expect(generatorShowsSavedLooksEmpty(false, ready, 0)).toBe(false);
    expect(generatorShowsSavedLooksEmpty(true, ready, 0)).toBe(true);
  });

  it("does not run the protected Looks loader for an anonymous viewer", async () => {
    const loadLooks = vi.fn(async () => undefined);
    const settleWithoutRequest = vi.fn();

    await loadGeneratorLooksForViewer(false, true, loadLooks, settleWithoutRequest);

    expect(loadLooks).not.toHaveBeenCalled();
    expect(settleWithoutRequest).not.toHaveBeenCalled();
  });

  it("settles owner-only Looks without a request for a public non-owner character", async () => {
    const loadLooks = vi.fn(async () => undefined);
    const settleWithoutRequest = vi.fn();

    await loadGeneratorLooksForViewer(true, false, loadLooks, settleWithoutRequest);

    expect(loadLooks).not.toHaveBeenCalled();
    expect(settleWithoutRequest).toHaveBeenCalledOnce();
  });

  it("runs the protected Looks loader for an authenticated character owner", async () => {
    const loadLooks = vi.fn(async () => undefined);
    const settleWithoutRequest = vi.fn();

    await loadGeneratorLooksForViewer(true, true, loadLooks, settleWithoutRequest);

    expect(loadLooks).toHaveBeenCalledOnce();
    expect(settleWithoutRequest).not.toHaveBeenCalled();
  });

  it("removes viewer-relative edit authority before a new scope loads", () => {
    expect(
      removeGeneratorCharacterViewerAuthority([
        {
          id: "owned-before-switch",
          title: "Owned before switch",
          age: "22",
          description: "Scope-bound character",
          likes: "0",
          chats: "0",
          creator: "Previous viewer",
          canEditIdentity: true,
          image: "/user-content/owned-before-switch/content.webp",
        },
      ]),
    ).toMatchObject([
      {
        id: "owned-before-switch",
        canEditIdentity: false,
      },
    ]);
  });
});

describe("generator exact quote authority", () => {
  const quote: RuntimeGenerationQuote = {
    mode: "image",
    profileId: "character-image-multi-identity",
    profileVersion: 1,
    routeFingerprint: "a".repeat(64),
    pricing: {
      ruleId: "image-price-v1",
      ruleKey: "image-default",
      version: 1,
      effectiveFrom: null,
      fingerprint: "b".repeat(64),
    },
    orientations: ["4:5", "16:9"],
    defaultOrientation: "4:5",
    maxCount: 1,
    costs: [{ outputCount: 1, costDreamcoins: 7 }],
    balance: 5,
  };

  it("has no exact authority for a count above the resolved route limit", () => {
    expect(exactGenerationQuoteForCount(quote, 2)).toBeNull();
  });

  it("carries the exact server cost and blocks a low-balance submission", () => {
    expect(exactGenerationQuoteForCount(quote, 1)).toEqual({
      costDreamcoins: 7,
      affordable: false,
      authority: {
        profileId: "character-image-multi-identity",
        profileVersion: 1,
        routeFingerprint: "a".repeat(64),
        pricingFingerprint: "b".repeat(64),
        outputCount: 1,
        costDreamcoins: 7,
      },
    });
  });

  it("prefetches an exact quote before the More like this quick action submits", async () => {
    const requests: Array<{ body: unknown; url: string }> = [];
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        requests.push({
          url,
          body:
            typeof init?.body === "string"
              ? JSON.parse(init.body)
              : null,
        });
        if (url.endsWith("/variation/quote")) {
          return Response.json({
            ok: true,
            data: {
              quote: {
                ...quote,
                balance: 20,
              },
            },
          });
        }
        return Response.json({
          ok: true,
          data: {
            job: {
              id: "variation-job",
              mode: "image",
              status: "queued",
              costDreamcoins: 7,
              outputCount: 1,
              errorCode: null,
              createdAt: new Date().toISOString(),
            },
            assets: [],
          },
        });
      },
    ) as unknown as typeof fetch;

    await expect(
      requestMediaVariationWithExactQuote(
        {
          mediaId: "media/with spaces",
          consistencyMode: "balanced",
          model: "character-image-variation-darkbeast",
          outputCount: 1,
        },
        fetcher,
      ),
    ).resolves.toMatchObject({ job: { id: "variation-job" } });

    expect(requests.map((request) => request.url)).toEqual([
      "/api/v1/media/media%2Fwith%20spaces/variation/quote",
      "/api/v1/media/media%2Fwith%20spaces/variation",
    ]);
    expect(requests[0]?.body).toMatchObject({
      consistencyMode: "balanced",
      model: "character-image-variation-darkbeast",
    });
    expect(requests[1]?.body).toMatchObject({
      model: "character-image-variation-darkbeast",
      outputCount: 1,
      orientation: quote.defaultOrientation,
      quoteAuthority: {
        profileId: quote.profileId,
        routeFingerprint: quote.routeFingerprint,
        pricingFingerprint: quote.pricing.fingerprint,
        costDreamcoins: 7,
      },
    });
  });

  it("reuses the selected-source form quote and never submits without its authority", async () => {
    const requests: Array<{ body: unknown; url: string }> = [];
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        requests.push({
          url,
          body:
            typeof init?.body === "string"
              ? JSON.parse(init.body)
              : null,
        });
        return Response.json({
          ok: true,
          data: {
            job: {
              id: "edit-job",
              mode: "image",
              status: "queued",
              costDreamcoins: 7,
              outputCount: 1,
              errorCode: null,
              createdAt: new Date().toISOString(),
            },
            assets: [],
          },
        });
      },
    ) as unknown as typeof fetch;

    await requestMediaVariationWithExactQuote(
      {
        mediaId: "selected-source",
        consistencyMode: "strict",
        outputCount: 1,
        quote: { ...quote, balance: 20 },
      },
      fetcher,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "/api/v1/media/selected-source/variation",
    );
    expect(requests[0]?.body).toMatchObject({
      consistencyMode: "strict",
      orientation: quote.defaultOrientation,
      quoteAuthority: {
        profileId: quote.profileId,
        profileVersion: quote.profileVersion,
        outputCount: 1,
      },
    });
  });

  it("reuses the main Generate idempotency key after an ambiguous network failure", async () => {
    const idempotencyKeys = new Map<string, string>();
    const observedKeys: string[] = [];
    let attempt = 0;
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        observedKeys.push(
          new Headers(init?.headers).get("idempotency-key") ?? "",
        );
        attempt += 1;
        if (attempt === 1) {
          throw new TypeError("connection reset after commit");
        }
        return Response.json({
          ok: true,
          data: {
            job: {
              id: "same-main-job",
              mode: "image",
              status: "queued",
              costDreamcoins: 7,
              outputCount: 1,
              errorCode: null,
              createdAt: new Date().toISOString(),
            },
            assets: [],
          },
        });
      },
    ) as unknown as typeof fetch;
    const input = {
      idempotencyKeys,
      createIdempotencyKey: () => "stable-main-key",
      body: {
        mode: "image",
        characterId: "character-1",
        freeplay: false,
        outputCount: 1,
        quoteAuthority: exactGenerationQuoteForCount(
          { ...quote, balance: 20 },
          1,
        )?.authority,
      },
    };

    await expect(
      requestGenerationJobWithExactAuthority(input, fetcher),
    ).rejects.toThrow("connection reset after commit");
    await expect(
      requestGenerationJobWithExactAuthority(
        {
          ...input,
          body: {
            ...input.body,
            quoteAuthority: {
              ...(
                input.body.quoteAuthority as NonNullable<
                  typeof input.body.quoteAuthority
                >
              ),
              pricingFingerprint: "c".repeat(64),
            },
          },
        },
        fetcher,
      ),
    ).resolves.toMatchObject({ job: { id: "same-main-job" } });

    expect(observedKeys).toEqual(["stable-main-key", "stable-main-key"]);
    expect(idempotencyKeys.size).toBe(0);
  });

  it("reuses the variation idempotency key after an ambiguous network failure", async () => {
    const idempotencyKeys = new Map<string, string>();
    const observedKeys: string[] = [];
    let attempt = 0;
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        observedKeys.push(
          new Headers(init?.headers).get("idempotency-key") ?? "",
        );
        attempt += 1;
        if (attempt === 1) {
          throw new TypeError("connection reset after commit");
        }
        return Response.json({
          ok: true,
          data: {
            job: {
              id: "same-variation-job",
              mode: "image",
              status: "queued",
              costDreamcoins: 7,
              outputCount: 1,
              errorCode: null,
              createdAt: new Date().toISOString(),
            },
            assets: [],
          },
        });
      },
    ) as unknown as typeof fetch;
    const input = {
      mediaId: "source-1",
      consistencyMode: "balanced" as const,
      outputCount: 1,
      quote: { ...quote, balance: 20 },
      idempotencyKeys,
      createIdempotencyKey: () => "stable-variation-key",
    };

    await expect(
      requestMediaVariationWithExactQuote(input, fetcher),
    ).rejects.toThrow("connection reset after commit");
    await expect(
      requestMediaVariationWithExactQuote(
        {
          ...input,
          quote: {
            ...input.quote,
            pricing: {
              ...input.quote.pricing,
              fingerprint: "c".repeat(64),
            },
          },
        },
        fetcher,
      ),
    ).resolves.toMatchObject({ job: { id: "same-variation-job" } });

    expect(observedKeys).toEqual([
      "stable-variation-key",
      "stable-variation-key",
    ]);
    expect(idempotencyKeys.size).toBe(0);
  });

});

describe("generator viewer data bootstrap", () => {
  it("rejects delayed or aborted config responses from an earlier viewer scope", () => {
    const oldRequest = new AbortController();
    const currentRequest = new AbortController();

    expect(generatorConfigRequestIsCurrent(oldRequest, 1, 2)).toBe(false);
    expect(generatorConfigRequestIsCurrent(currentRequest, 2, 2)).toBe(true);
    currentRequest.abort();
    expect(generatorConfigRequestIsCurrent(currentRequest, 2, 2)).toBe(false);
  });

  it("fails closed immediately and coalesces overlapping viewer revalidation events", async () => {
    let resolveRefresh: (() => void) | undefined;
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const suspend = vi.fn();
    const gate = { current: null as Promise<void> | null };

    const first = revalidateGeneratorViewerAuthority(gate, {
      refresh,
      suspend,
    });
    const second = revalidateGeneratorViewerAuthority(gate, {
      refresh,
      suspend,
    });

    expect(suspend).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
    expect(second).toBe(first);
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledOnce();

    resolveRefresh?.();
    await first;
    expect(gate.current).toBeNull();
  });

  it("suspends viewer scope without inventing a refresh failure", () => {
    const refs = {
      authenticated: { current: true as boolean | null },
      epoch: { current: 8 },
      scope: { current: "user:viewer-1" as string | null },
    };
    const actions = {
      clearConfig: vi.fn(),
      clearPrivateProjections: vi.fn(),
    };

    suspendGeneratorConfigAuthority(refs, actions);

    expect(refs).toEqual({
      authenticated: { current: null },
      epoch: { current: 9 },
      scope: { current: null },
    });
    expect(actions.clearConfig).toHaveBeenCalledOnce();
    expect(actions.clearPrivateProjections).toHaveBeenCalledOnce();
  });

  it("revokes stale config and private viewer authority after a refresh failure", () => {
    const refs = {
      authenticated: { current: true as boolean | null },
      epoch: { current: 4 },
      scope: { current: "user:viewer-1" as string | null },
    };
    const actions = {
      clearConfig: vi.fn(),
      clearPrivateProjections: vi.fn(),
      showError: vi.fn(),
    };

    invalidateGeneratorConfigAuthority(
      refs,
      actions,
      "Generation controls could not load.",
    );

    expect(refs).toEqual({
      authenticated: { current: null },
      epoch: { current: 5 },
      scope: { current: null },
    });
    expect(actions.clearConfig).toHaveBeenCalledOnce();
    expect(actions.clearPrivateProjections).toHaveBeenCalledOnce();
    expect(actions.showError).toHaveBeenCalledWith(
      "Generation controls could not load.",
    );
  });

  it("does not load generator data before age acceptance", async () => {
    const loaders = {
      loadConfig: vi.fn(async () => false),
      loadCharacters: vi.fn(async () => undefined),
      loadJobs: vi.fn(async () => undefined),
      loadMedia: vi.fn(async () => undefined),
      loadPresets: vi.fn(async () => undefined),
      loadIdentityMedia: vi.fn(async () => undefined),
    };

    await loadGeneratorWorkspaceInitialData(false, loaders);

    for (const loader of Object.values(loaders)) {
      expect(loader).not.toHaveBeenCalled();
    }
  });

  it("loads public configuration and characters without anonymous protected requests", async () => {
    const loaders = {
      loadConfig: vi.fn(async () => false),
      loadCharacters: vi.fn(async () => undefined),
      loadJobs: vi.fn(async () => undefined),
      loadMedia: vi.fn(async () => undefined),
      loadPresets: vi.fn(async () => undefined),
      loadIdentityMedia: vi.fn(async () => undefined),
    };

    await loadGeneratorWorkspaceInitialData(true, loaders);

    expect(loaders.loadConfig).toHaveBeenCalledOnce();
    expect(loaders.loadCharacters).toHaveBeenCalledOnce();
    expect(loaders.loadJobs).not.toHaveBeenCalled();
    expect(loaders.loadMedia).not.toHaveBeenCalled();
    expect(loaders.loadPresets).not.toHaveBeenCalled();
    expect(loaders.loadIdentityMedia).not.toHaveBeenCalled();
  });

  it("loads protected generation data after authentication resolves", async () => {
    const loaders = {
      loadConfig: vi.fn(async () => true),
      loadCharacters: vi.fn(async () => undefined),
      loadJobs: vi.fn(async () => undefined),
      loadMedia: vi.fn(async () => undefined),
      loadPresets: vi.fn(async () => undefined),
      loadIdentityMedia: vi.fn(async () => undefined),
    };

    await loadGeneratorWorkspaceInitialData(true, loaders);

    expect(loaders.loadJobs).toHaveBeenCalledOnce();
    expect(loaders.loadMedia).toHaveBeenCalledOnce();
    expect(loaders.loadPresets).toHaveBeenCalledOnce();
    expect(loaders.loadIdentityMedia).toHaveBeenCalledOnce();
  });

  it("keeps protected generation data unresolved when config authority fails", async () => {
    const loaders = {
      loadConfig: vi.fn(async () => null),
      loadCharacters: vi.fn(async () => undefined),
      loadJobs: vi.fn(async () => undefined),
      loadMedia: vi.fn(async () => undefined),
      loadPresets: vi.fn(async () => undefined),
      loadIdentityMedia: vi.fn(async () => undefined),
    };

    await loadGeneratorWorkspaceInitialData(true, loaders);

    expect(loaders.loadJobs).not.toHaveBeenCalled();
    expect(loaders.loadMedia).not.toHaveBeenCalled();
    expect(loaders.loadPresets).not.toHaveBeenCalled();
    expect(loaders.loadIdentityMedia).not.toHaveBeenCalled();
  });
});
