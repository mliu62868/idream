import { describe, expect, it } from "vitest";

import {
  PublicApiContractError,
  parseAnnouncementsResponse,
  parseAuthMeResponse,
  parseBillingPortalResponse,
  parseCharacterListResponse,
  parseCharacterDetailResponse,
  parseCheckoutResponse,
  parseChatSessionsResponse,
  parseCommunityCampaignsResponse,
  parseCommunityCollectionsResponse,
  parseCommunityLeaderboardsResponse,
  parseCreatorResponse,
  parseFeedResponse,
  parseFeedbackItemsResponse,
  parseFollowMutationResponse,
  parseGenerationConfigResponse,
  parseGenerationQuoteResponse,
  parseGenerationRetryQuoteResponse,
  parseGenerationJobsResponse,
  parseChatSessionDetailResponse,
  parseLibraryResponse,
  parseMediaCollectionsResponse,
  parsePlansResponse,
  parseProfileResponse,
  parsePublicApiError,
  parseSearchSuggestResponse,
  parseTagListResponse,
  parseTemplatesResponse,
  parseViewerAuthorityResponse,
  parseWorkspaceMediaResponse,
} from "@/lib/public-api-contracts";

const character = {
  id: "character-1",
  title: "Avery",
  age: "24",
  description: "A public character.",
  likes: "0",
  chats: "0",
  creator: "Official",
  image: "/character.png",
};

describe("public API runtime contracts", () => {
  it("accepts intentional empty collections from complete success envelopes", () => {
    expect(
      parsePlansResponse({
        ok: true,
        data: {
          items: [],
          billing: {
            provider: "mock",
            demoMode: true,
            autoConfirmAvailable: true,
            billingModel: "prepaid_period",
            renewalCapability: "none",
          },
        },
      }).items,
    ).toEqual([]);
    expect(
      parseCharacterListResponse({
        ok: true,
        data: { items: [], nextCursor: null },
      }).items,
    ).toEqual([]);
    expect(
      parseTagListResponse({ ok: true, data: { items: [] } }).items,
    ).toEqual([]);
    expect(
      parseSearchSuggestResponse({
        ok: true,
        data: { characters: [], routes: [], tags: [] },
      }),
    ).toEqual({ characters: [], routes: [], tags: [] });
    expect(
      parseFeedResponse({
        ok: true,
        data: { items: [], nextCursor: null, focusedItemId: null },
      }).items,
    ).toEqual([]);
    expect(parseChatSessionsResponse([])).toEqual([]);
    expect(
      parseFollowMutationResponse({
        ok: true,
        data: { following: true, followers: 3 },
      }),
    ).toEqual({ following: true, followers: 3 });
    expect(
      parseCheckoutResponse({
        ok: true,
        data: {
          checkout: {
            id: "checkout-1",
            planId: "plan-1",
            provider: "btcpay",
            status: "created",
            returnPath: "/generate",
            createdAt: "2026-07-17T00:00:00.000Z",
            updatedAt: "2026-07-17T00:00:00.000Z",
          },
          invoice: {
            provider: "btcpay",
            invoiceId: "invoice-1",
            checkoutUrl: "https://payments.example.com/invoice-1",
            status: "created",
            additionalStatus: "none",
          },
          subscription: null,
          billingAccess: null,
          billing: {
            provider: "btcpay",
            demoMode: false,
            autoConfirmAvailable: false,
            billingModel: "prepaid_period",
            renewalCapability: "none",
          },
        },
      }).invoice.invoiceId,
    ).toBe("invoice-1");
  });

  it("exposes prepaid benefits without inventing a renewal date", () => {
    const plan = {
      id: "plan-1",
      slug: "premium",
      name: "Premium",
      billingPeriod: "monthly",
      priceCents: 1999,
      includedDreamcoins: 1500,
      features: {},
    };
    const subscription = {
      id: "subscription-1",
      userId: "user-1",
      planId: "plan-1",
      status: "active",
      offerAuthority: "checkout_snapshot",
      plan,
    };
    const billingAccess = {
      provider: "btcpay",
      billingModel: "prepaid_period",
      renewalCapability: "none",
      benefitsEndAt: "2026-08-17T00:00:00.000Z",
      renewsAt: null,
    };

    expect(
      parseProfileResponse({
        ok: true,
        data: {
          user: { email: "customer@example.com", displayName: "Customer" },
          balance: 1500,
          subscription,
          billingAccess,
          entitlements: {},
        },
      }).billingAccess,
    ).toEqual(billingAccess);
    expect(
      parseBillingPortalResponse({
        ok: true,
        data: {
          mode: "access",
          url: "/profile#billing",
          message: "Prepaid access is active.",
          subscription,
          billingAccess,
        },
      }).mode,
    ).toBe("access");
    expect(() =>
      parseProfileResponse({
        ok: true,
        data: {
          user: { email: "customer@example.com" },
          balance: 1500,
          subscription,
          billingAccess: {
            ...billingAccess,
            renewsAt: "2026-08-17T00:00:00.000Z",
          },
          entitlements: {},
        },
      }),
    ).toThrow(PublicApiContractError);
  });

  it("keeps paid access explicit when a historical purchase has no immutable offer snapshot", () => {
    const payload = {
      ok: true,
      data: {
        user: { email: "legacy@example.com" },
        balance: 0,
        subscription: {
          id: "subscription-legacy",
          userId: "user-legacy",
          planId: "plan-legacy",
          status: "active",
          offerAuthority: "unavailable",
          plan: null,
        },
        billingAccess: {
          provider: "legacy-processor",
          billingModel: "unknown",
          renewalCapability: "none",
          benefitsEndAt: "2026-08-17T00:00:00.000Z",
          renewsAt: null,
        },
        entitlements: {},
      },
    };

    expect(parseProfileResponse(payload).subscription).toMatchObject({
      offerAuthority: "unavailable",
      plan: null,
    });
    expect(() =>
      parseProfileResponse({
        ...payload,
        data: {
          ...payload.data,
          subscription: {
            ...payload.data.subscription,
            offerAuthority: "checkout_snapshot",
          },
        },
      }),
    ).toThrow(PublicApiContractError);
  });

  it("preserves only validated checkout idempotency actions from error envelopes", () => {
    expect(
      parsePublicApiError({
        ok: false,
        error: {
          code: "conflict",
          message: "Retry with the same key.",
          details: { checkoutId: "checkout-1", idempotencyAction: "same_key" },
        },
      }),
    ).toEqual({
      code: "conflict",
      message: "Retry with the same key.",
      idempotencyAction: "same_key",
    });
    expect(
      parsePublicApiError({
        error: {
          code: "conflict",
          message: "Unknown authority action.",
          details: { idempotencyAction: "replace_it" },
        },
      }),
    ).toEqual({
      code: "conflict",
      message: "Unknown authority action.",
      idempotencyAction: undefined,
    });
    expect(parsePublicApiError(null)).toBeNull();
  });

  it.each([
    ["plans", parsePlansResponse],
    ["characters", parseCharacterListResponse],
    ["tags", parseTagListResponse],
    ["search", parseSearchSuggestResponse],
    ["feed", parseFeedResponse],
    ["creator", parseCreatorResponse],
  ])("rejects a 200-shaped but incomplete %s envelope", (_name, parse) => {
    expect(() => parse({ ok: true, data: {} })).toThrow(
      PublicApiContractError,
    );
  });

  it("rejects invalid list members instead of rendering a false empty state", () => {
    expect(() =>
      parseCharacterListResponse({
        ok: true,
        data: { items: [{}], nextCursor: null },
      }),
    ).toThrow(PublicApiContractError);
    expect(() => parseChatSessionsResponse([{}])).toThrow(
      PublicApiContractError,
    );
    expect(() =>
      parseAnnouncementsResponse({
        ok: true,
        data: { items: [null] },
      }),
    ).toThrow(PublicApiContractError);
    expect(() =>
      parseFeedbackItemsResponse({
        ok: true,
        data: { items: [null] },
      }),
    ).toThrow(PublicApiContractError);
    expect(() =>
      parseTemplatesResponse({
        ok: true,
        data: { items: [null] },
      }),
    ).toThrow(PublicApiContractError);
  });

  it("rejects malformed identity and character detail authorities", () => {
    expect(() =>
      parseAuthMeResponse({ ok: true, data: {} }),
    ).toThrow(PublicApiContractError);
    expect(() =>
      parseAuthMeResponse({
        ok: true,
        data: { user: { email: "not-an-email" } },
      }),
    ).toThrow(PublicApiContractError);
    expect(() =>
      parseViewerAuthorityResponse({
        ok: true,
        data: { user: {} },
      }),
    ).toThrow(PublicApiContractError);
    expect(() =>
      parseViewerAuthorityResponse({
        ok: true,
        data: { user: null, ageGate: { accepted: "false" } },
      }),
    ).toThrow(PublicApiContractError);
    expect(() =>
      parseCharacterDetailResponse({
        ok: true,
        data: {},
      }),
    ).toThrow(PublicApiContractError);
  });

  it("rejects media strings that cannot be rendered as owned or web media", () => {
    for (const image of [
      "not-a-url",
      "javascript:alert(1)",
      "//untrusted.example/image.png",
      "/\\untrusted.example/image.png",
      "data:text/html,bad",
    ]) {
      expect(() =>
        parseCharacterListResponse({
          ok: true,
          data: {
            items: [{ ...character, image }],
            nextCursor: null,
          },
        }),
      ).toThrow(PublicApiContractError);
    }
  });

  it("rejects cross-origin lookalikes in internal navigation authorities", () => {
    expect(() =>
      parseSearchSuggestResponse({
        ok: true,
        data: {
          characters: [],
          routes: [
            {
              description: "Unsafe route",
              href: "/\\untrusted.example/path",
              template: "article",
              title: "Unsafe route",
            },
          ],
          tags: [],
        },
      }),
    ).toThrow(PublicApiContractError);
    expect(() =>
      parseAnnouncementsResponse({
        ok: true,
        data: {
          items: [
            {
              id: "announcement-1",
              title: "Unsafe announcement",
              body: "",
              level: "info",
              href: "/\\untrusted.example/path",
            },
          ],
        },
      }),
    ).toThrow(PublicApiContractError);
  });

  it("validates complete community authorities member by member", () => {
    expect(
      parseCommunityLeaderboardsResponse({
        ok: true,
        data: {
          leaderboards: {
            characters: [character],
            dreamers: [
              {
                id: "creator-1",
                displayName: "Creator",
                image: null,
                characters: 1,
                followers: 0,
                likes: "0",
                chats: "0",
              },
            ],
          },
          experimentAssignment: null,
        },
      }).leaderboards.characters,
    ).toHaveLength(1);
    expect(
      parseCommunityCollectionsResponse({
        ok: true,
        data: {
          collections: [
            {
              id: "collection-1",
              name: "Portraits",
              visibility: "public",
              previews: ["/portrait.png"],
            },
          ],
        },
      }).collections,
    ).toHaveLength(1);
    expect(
      parseCommunityCampaignsResponse({
        ok: true,
        data: {
          campaigns: [
            {
              id: "campaign-1",
              eyebrow: "Community",
              image: "/campaign.png",
              source: "authority",
              title: "Live campaign",
            },
          ],
        },
      }).campaigns,
    ).toHaveLength(1);

    expect(() =>
      parseCommunityLeaderboardsResponse({
        ok: true,
        data: {
          leaderboards: { characters: [null], dreamers: [] },
        },
      }),
    ).toThrow(PublicApiContractError);
  });

  it("validates the complete generation config before it reaches UI state", () => {
    expect(
      parseGenerationConfigResponse({
        ok: true,
        data: {
          viewer: { authenticated: false, scope: "anonymous:viewer-1" },
          entitlements: {},
          dreamcoins: { balance: 0 },
          pricing: {
            image: { baseCost: 1, maxCount: 4 },
            video: { baseCost: null },
          },
          image: {
            availability: { state: "available" },
            orientations: ["4:5"],
            models: [
              {
                id: "image-model",
                label: "Image model",
                costMultiplier: 1,
                entitlement: null,
                maxCount: 4,
              },
            ],
            editModels: [
              {
                id: "character-image-variation-darkbeast",
                label: "Dark Beast · Identity Focus",
                costMultiplier: 1.2,
                entitlement: null,
                maxCount: 1,
                referenceMode: "identity_source",
              },
            ],
            recipes: [
              {
                id: "image-character",
                rowId: "recipe-row-1",
                label: "Image character",
                mode: "image",
                useCase: "character",
                version: 1,
              },
              {
                id: "image-freeplay",
                rowId: "recipe-row-2",
                label: "Image freeplay",
                mode: "image",
                useCase: "freeplay",
                version: 1,
              },
            ],
          },
          video: {
            enabled: false,
            availability: {
              state: "unavailable",
              reason: "feature_disabled",
            },
            requiredEntitlement: "video",
            models: [],
            recipes: [
              {
                id: "video-standard",
                rowId: "recipe-row-3",
                label: "Video standard",
                mode: "video",
                useCase: "standard",
                version: 1,
              },
            ],
          },
        },
      }).image.editModels,
    ).toEqual([
      expect.objectContaining({
        id: "character-image-variation-darkbeast",
        referenceMode: "identity_source",
      }),
    ]);

    expect(() =>
      parseGenerationConfigResponse({
        ok: true,
        data: {
          viewer: { authenticated: false, scope: null },
          entitlements: {},
          dreamcoins: { balance: 0 },
          pricing: {
            image: { baseCost: 1, maxCount: 4 },
            video: { baseCost: null },
          },
          image: {
            availability: { state: "available" },
            orientations: ["4:5"],
            models: [
              {
                id: "image-model",
                label: "Image model",
                costMultiplier: 1,
                entitlement: null,
                maxCount: 4,
              },
            ],
            recipes: [
              {
                id: "image-character",
                rowId: "recipe-row-1",
                label: "Image character",
                mode: "image",
                useCase: "character",
                version: 1,
              },
            ],
          },
          video: {
            enabled: false,
            availability: {
              state: "unavailable",
              reason: "feature_disabled",
            },
            requiredEntitlement: "video",
            models: [],
            recipes: [],
          },
        },
      }),
    ).toThrow(PublicApiContractError);

    expect(() =>
      parseGenerationConfigResponse({
        ok: true,
        data: {
          viewer: { authenticated: true, scope: "anonymous:wrong" },
        },
      }),
    ).toThrow(PublicApiContractError);

    expect(() =>
      parseGenerationConfigResponse({
        ok: true,
        data: {
          viewer: { authenticated: false, scope: "anonymous:viewer-1" },
          entitlements: {},
          dreamcoins: { balance: 0 },
          pricing: {
            image: { baseCost: 1, maxCount: 4 },
            video: { baseCost: null },
          },
          image: {
            availability: { state: "available" },
            orientations: ["4:5"],
            models: [],
            recipes: [
              {
                id: "image-standard",
                rowId: "recipe-row-1",
                label: "Image standard",
                mode: "video",
                useCase: "standard",
                version: 1,
              },
            ],
          },
          video: {
            enabled: false,
            availability: {
              state: "unavailable",
              reason: "feature_disabled",
            },
            requiredEntitlement: "video",
            models: [],
            recipes: [],
          },
        },
      }),
    ).toThrow(PublicApiContractError);

    expect(
      parseGenerationConfigResponse({
        ok: true,
        data: {
          viewer: { authenticated: false, scope: "anonymous:viewer-1" },
          entitlements: {},
          dreamcoins: { balance: 0 },
          pricing: {
            image: { baseCost: 1, maxCount: null },
            video: { baseCost: null },
          },
          image: {
            availability: {
              state: "unavailable",
              reason: "no_active_model",
            },
            orientations: [],
            models: [],
            recipes: [],
          },
          video: {
            enabled: false,
            availability: {
              state: "unavailable",
              reason: "feature_disabled",
            },
            requiredEntitlement: "video",
            models: [],
            recipes: [],
          },
        },
      }).pricing.image.maxCount,
    ).toBeNull();

    expect(
      parseGenerationConfigResponse({
        ok: true,
        data: {
          viewer: { authenticated: false, scope: null },
          entitlements: {},
          dreamcoins: { balance: 0 },
          pricing: {
            image: { baseCost: 1, maxCount: null },
            video: { baseCost: null },
          },
          image: {
            availability: {
              state: "unavailable",
              reason: "no_active_recipe",
            },
            orientations: [],
            models: [],
            recipes: [],
          },
          video: {
            enabled: false,
            availability: {
              state: "unavailable",
              reason: "feature_disabled",
            },
            requiredEntitlement: "video",
            models: [],
            recipes: [],
          },
        },
      }).image.availability,
    ).toEqual({ state: "unavailable", reason: "no_active_recipe" });

    expect(() =>
      parseGenerationConfigResponse({
        ok: true,
        data: {
          viewer: { authenticated: false, scope: null },
          entitlements: {},
          dreamcoins: { balance: 0 },
          pricing: {
            image: { baseCost: 1, maxCount: 4 },
            video: { baseCost: null },
          },
          image: {
            availability: {
              state: "unavailable",
              reason: "no_active_model",
            },
            orientations: ["4:5"],
            models: [],
            recipes: [],
          },
          video: {
            enabled: false,
            availability: {
              state: "unavailable",
              reason: "feature_disabled",
            },
            requiredEntitlement: "video",
            models: [],
            recipes: [],
          },
        },
      }),
    ).toThrow(PublicApiContractError);
  });

  it("requires one exact server price for every count in a generation quote", () => {
    const payload = {
      ok: true,
      data: {
        quote: {
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
        },
      },
    };

    expect(parseGenerationQuoteResponse(payload).quote).toMatchObject({
      profileId: "character-image-multi-identity",
      maxCount: 1,
      balance: 5,
    });
    expect(() =>
      parseGenerationQuoteResponse({
        ...payload,
        data: {
          quote: {
            ...payload.data.quote,
            maxCount: 2,
          },
        },
      }),
    ).toThrow(PublicApiContractError);
  });

  it("pins the exact failed job, route, and price in a retry quote", () => {
    expect(
      parseGenerationRetryQuoteResponse({
        ok: true,
        data: {
          quote: {
            mode: "image",
            generationJobId: "failed-job-1",
            profileId: "character-image-multi-identity",
            profileVersion: 2,
            routeFingerprint: "a".repeat(64),
            pricing: {
              ruleId: "image-price-v1",
              ruleKey: "image-default",
              version: 1,
              effectiveFrom: null,
              fingerprint: "b".repeat(64),
            },
            outputCount: 1,
            costDreamcoins: 8,
            balance: 20,
          },
        },
      }).quote,
    ).toMatchObject({
      generationJobId: "failed-job-1",
      costDreamcoins: 8,
      balance: 20,
    });
  });

  it("validates the per-source image-edit model projection", () => {
    const payload = {
      ok: true,
      data: {
        items: [
          {
            id: "media-1",
            characterId: "character-1",
            type: "image",
            url: "/media-1.png",
            thumbnailUrl: "/media-1-thumb.png",
            prompt: null,
            liked: false,
            imageEditModelIds: [
              "character-image-variation-darkbeast",
            ],
          },
        ],
      },
    };

    expect(
      parseWorkspaceMediaResponse(payload).items[0]?.imageEditModelIds,
    ).toEqual(["character-image-variation-darkbeast"]);
    expect(() =>
      parseWorkspaceMediaResponse({
        ...payload,
        data: {
          items: [
            {
              ...payload.data.items[0],
              imageEditModelIds: [""],
            },
          ],
        },
      }),
    ).toThrow(PublicApiContractError);
  });

  it("rejects malformed generation, profile, and chat collection members", () => {
    for (const parse of [
      () =>
        parseGenerationJobsResponse({
          ok: true,
          data: { items: [null] },
        }),
      () =>
        parseWorkspaceMediaResponse({
          ok: true,
          data: { items: [null] },
        }),
      () =>
        parseLibraryResponse({
          ok: true,
          data: { items: [null] },
        }),
      () =>
        parseMediaCollectionsResponse({
          ok: true,
          data: { collections: [null] },
        }),
      () =>
        parseChatSessionDetailResponse({
          ok: true,
          data: {
            session: {
              id: "session-1",
              title: "Chat",
              character: { name: "Avery" },
            },
          },
        }),
    ]) {
      expect(parse).toThrow(PublicApiContractError);
    }
  });

  it("accepts current plans, catalog cards, feed items, and creator DTOs", () => {
    expect(
      parsePlansResponse({
        ok: true,
        data: {
          items: [
            {
              id: "plan-1",
              slug: "premium",
              name: "Premium",
              billingPeriod: "monthly",
              priceCents: 999,
              includedDreamcoins: 100,
              features: {},
            },
          ],
          billing: {
            provider: "btcpay",
            demoMode: false,
            autoConfirmAvailable: false,
            billingModel: "prepaid_period",
            renewalCapability: "none",
          },
        },
      }).items,
    ).toHaveLength(1);

    expect(
      parseCharacterListResponse({
        ok: true,
        data: { items: [character], nextCursor: "next-page" },
      }).items,
    ).toHaveLength(1);

    expect(
      parseFeedResponse({
        ok: true,
        data: {
          items: [
            {
              id: "character:character-1",
              type: "character",
              character,
            },
            {
              id: "collection:collection-1",
              type: "collection",
              collection: {
                id: "collection-1",
                name: "Portraits",
                ownerId: null,
                ownerName: "Official collection",
                itemCount: 0,
                previews: [],
                createdAt: "2026-07-16T00:00:00.000Z",
              },
            },
          ],
          nextCursor: null,
          focusedItemId: null,
        },
      }).items,
    ).toHaveLength(2);

    expect(
      parseCreatorResponse({
        ok: true,
        data: {
          creator: {
            id: "creator-1",
            displayName: "Creator",
            image: null,
            isFollowing: false,
            isSelf: false,
            stats: {
              characters: 1,
              followers: 0,
              likes: "0",
              chats: "0",
            },
          },
          characters: [character],
        },
      }).characters,
    ).toHaveLength(1);
  });
});
