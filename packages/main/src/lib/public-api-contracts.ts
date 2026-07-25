import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);
const nonNegativeInteger = z.number().int().nonnegative();
const nullableCursor = z.string().min(1).nullable();
const internalPath = z
  .string()
  .trim()
  .refine(isSafeInternalPath, "Expected an internal path");
export const renderableMediaSourceSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine(isRenderableMediaSource, "Expected an owned media path");
const timestamp = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), "Expected a timestamp");

export const publicCharacterCardSchema = z
  .object({
    id: nonEmptyString,
    title: nonEmptyString,
    age: nonEmptyString,
    description: z.string(),
    likes: z.string(),
    chats: z.string(),
    likesCount: nonNegativeInteger.optional(),
    chatsCount: nonNegativeInteger.optional(),
    source: z.enum(["official", "user"]).optional(),
    creatorType: z.enum(["official", "user"]).optional(),
    creator: nonEmptyString,
    creatorId: z.string().nullable().optional(),
    creatorName: z.string().nullable().optional(),
    canEditIdentity: z.boolean().optional(),
    image: renderableMediaSourceSchema,
    imageAssetId: z.string().nullable().optional(),
    heroImage: renderableMediaSourceSchema.optional(),
    heroThumbnailUrl: renderableMediaSourceSchema.optional(),
    heroImageAssetId: z.string().nullable().optional(),
    currentReleaseId: z.string().nullable().optional(),
    hasImage: z.boolean().optional(),
    vivid: z.boolean().optional(),
  })
  .passthrough();

export type PublicCharacterCard = z.infer<typeof publicCharacterCardSchema>;

export const planSchema = z
  .object({
    id: nonEmptyString,
    slug: nonEmptyString,
    name: nonEmptyString,
    billingPeriod: z.enum(["monthly", "yearly"]),
    priceCents: nonNegativeInteger,
    includedDreamcoins: nonNegativeInteger,
    features: z.record(z.string(), z.unknown()),
  })
  .passthrough();

export type PublicPlan = z.infer<typeof planSchema>;

export const billingModelSchema = z.enum([
  "prepaid_period",
  "recurring",
  "unknown",
]);
export const renewalCapabilitySchema = z.enum(["none", "cancel_resume"]);

export const billingModeSchema = z
  .object({
    provider: z.enum(["mock", "btcpay"]),
    demoMode: z.boolean(),
    autoConfirmAvailable: z.boolean(),
    billingModel: billingModelSchema,
    renewalCapability: renewalCapabilitySchema,
  })
  .strict();

export type PublicBillingMode = z.infer<typeof billingModeSchema>;

export const billingAccessSchema = z
  .object({
    provider: nonEmptyString,
    billingModel: billingModelSchema,
    renewalCapability: renewalCapabilitySchema,
    benefitsEndAt: timestamp.nullable(),
    renewsAt: timestamp.nullable(),
  })
  .strict()
  .superRefine((access, ctx) => {
    if (
      (access.billingModel === "prepaid_period" ||
        access.renewalCapability === "none") &&
      access.renewsAt !== null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["renewsAt"],
        message: "non-renewing access cannot expose a renewal date",
      });
    }
  });

export type PublicBillingAccess = z.infer<typeof billingAccessSchema>;

export const publicSubscriptionSchema = z
  .object({
    id: nonEmptyString,
    userId: nonEmptyString,
    planId: nonEmptyString,
    status: nonEmptyString,
    offerAuthority: z.enum(["checkout_snapshot", "unavailable"]),
    plan: planSchema.nullable(),
  })
  .strict()
  .superRefine((subscription, ctx) => {
    if (
      (subscription.offerAuthority === "checkout_snapshot") !==
      (subscription.plan !== null)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["plan"],
        message:
          "an authoritative checkout offer snapshot must be present or explicitly unavailable",
      });
    }
    if (
      subscription.plan !== null &&
      subscription.plan.id !== subscription.planId
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["plan", "id"],
        message: "subscription plan must match its immutable offer snapshot",
      });
    }
  });

export type PublicSubscription = z.infer<typeof publicSubscriptionSchema>;

const checkoutIdempotencyActionSchema = z.enum(["same_key", "new_key"]);
export type CheckoutIdempotencyAction = z.infer<
  typeof checkoutIdempotencyActionSchema
>;

const publicApiErrorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: z.string().optional(),
        message: z.string().optional(),
        details: z.unknown().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const plansResponseSchema = successEnvelope(
  z.object({
    items: z.array(planSchema),
    billing: billingModeSchema,
  }),
);

const followMutationResponseSchema = successEnvelope(
  z
    .object({
      following: z.boolean(),
      followers: nonNegativeInteger,
    })
    .strict(),
);

const checkoutResponseSchema = successEnvelope(
  z
    .object({
      checkout: z
        .object({
          id: nonEmptyString,
          planId: nonEmptyString,
          provider: z.enum(["mock", "btcpay"]),
          status: nonEmptyString,
          returnPath: internalPath,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .strict(),
      invoice: z
        .object({
          provider: z.enum(["mock", "btcpay"]),
          invoiceId: nonEmptyString,
          checkoutUrl: z
            .string()
            .refine(isSafeExternalHref, "Expected a safe checkout URL"),
          status: z.enum([
            "created",
            "processing",
            "settled",
            "expired",
            "invalid",
          ]),
          additionalStatus: z.enum([
            "none",
            "marked",
            "paid_late",
            "paid_over",
            "paid_partial",
          ]),
        })
        .strict(),
      subscription: z
        .union([publicSubscriptionSchema, z.null()]),
      billingAccess: billingAccessSchema.nullable(),
      billing: billingModeSchema,
    })
    .strict(),
);

const profileResponseSchema = successEnvelope(
  z
    .object({
      user: z
        .object({
          displayName: z.string().nullable().optional(),
          email: nonEmptyString,
        })
        .passthrough(),
      balance: z.number().finite(),
      subscription: publicSubscriptionSchema.nullable(),
      billingAccess: billingAccessSchema.nullable(),
      entitlements: z.record(z.string(), z.unknown()),
    })
    .strict()
    .superRefine((profile, ctx) => {
      if ((profile.subscription === null) !== (profile.billingAccess === null)) {
        ctx.addIssue({
          code: "custom",
          path: ["billingAccess"],
          message: "billing access must match the active subscription",
        });
      }
    }),
);

const billingPortalResponseSchema = successEnvelope(
  z
    .object({
      mode: z.enum(["subscribe", "access"]),
      url: internalPath,
      message: nonEmptyString,
      subscription: publicSubscriptionSchema.nullable(),
      billingAccess: billingAccessSchema.nullable(),
    })
    .strict()
    .superRefine((portal, ctx) => {
      if ((portal.subscription === null) !== (portal.billingAccess === null)) {
        ctx.addIssue({
          code: "custom",
          path: ["billingAccess"],
          message: "billing access must match the active subscription",
        });
      }
      if (
        (portal.mode === "subscribe" && portal.subscription !== null) ||
        (portal.mode === "access" && portal.subscription === null)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["mode"],
          message: "billing portal mode must match active access",
        });
      }
    }),
);

const characterListResponseSchema = successEnvelope(
  z.object({
    items: z.array(publicCharacterCardSchema),
    nextCursor: nullableCursor,
  }),
);

const publicTagSchema = z
  .object({
    label: nonEmptyString,
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    isMutedByDefault: z.boolean(),
    isMutedByUser: z.boolean(),
    publicCharacterCount: nonNegativeInteger,
  })
  .passthrough();

const tagListResponseSchema = successEnvelope(
  z.object({
    items: z.array(publicTagSchema),
  }),
);

const routeTemplateSchema = z.enum([
  "article",
  "comparison",
  "create",
  "generator",
  "library",
  "marketing",
  "profile",
  "safety",
  "terms",
  "upgrade",
]);

const searchSuggestResponseSchema = successEnvelope(
  z.object({
    characters: z.array(publicCharacterCardSchema),
    routes: z.array(
      z
        .object({
          description: z.string(),
          href: internalPath,
          template: routeTemplateSchema,
          title: nonEmptyString,
        })
        .passthrough(),
    ),
    tags: z.array(
      z
        .object({
          category: z.string().nullable().optional(),
          label: nonEmptyString,
          slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
        })
        .passthrough(),
    ),
  }),
);

const feedCharacterItemSchema = z
  .object({
    id: z.string().startsWith("character:"),
    type: z.literal("character"),
    character: publicCharacterCardSchema.extend({
      liked: z.boolean().optional(),
    }),
  })
  .passthrough();

const feedCollectionItemSchema = z
  .object({
    id: z.string().startsWith("collection:"),
    type: z.literal("collection"),
    collection: z
      .object({
        id: nonEmptyString,
        name: nonEmptyString,
        ownerId: z.string().nullable(),
        ownerName: z.string().nullable(),
        itemCount: nonNegativeInteger,
        previews: z.array(renderableMediaSourceSchema),
        createdAt: timestamp,
      })
      .passthrough(),
  })
  .passthrough();

const feedResponseSchema = successEnvelope(
  z.object({
    items: z.array(
      z.discriminatedUnion("type", [
        feedCharacterItemSchema,
        feedCollectionItemSchema,
      ]),
    ),
    nextCursor: nullableCursor,
    focusedItemId: z.string().min(1).nullable(),
  }),
);

const chatSessionSchema = z
  .object({
    id: nonEmptyString,
    title: z.string().nullable(),
    characterId: nonEmptyString,
    status: nonEmptyString,
    memoryEnabled: z.boolean(),
    lastMessageAt: timestamp.nullable(),
    memorySummary: z.string().nullable(),
  })
  .passthrough();

const creatorResponseSchema = successEnvelope(
  z.object({
    creator: z
      .object({
        id: nonEmptyString,
        displayName: nonEmptyString,
        image: renderableMediaSourceSchema.nullable(),
        isFollowing: z.boolean(),
        isSelf: z.boolean(),
        stats: z.object({
          characters: nonNegativeInteger,
          followers: nonNegativeInteger,
          likes: z.string(),
          chats: z.string(),
          likesCount: nonNegativeInteger.optional(),
          chatsCount: nonNegativeInteger.optional(),
        }),
      })
      .passthrough(),
    characters: z.array(publicCharacterCardSchema),
  }),
);

export type PublicTagList = z.infer<typeof tagListResponseSchema>["data"];
export type PublicSearchSuggestions = z.infer<
  typeof searchSuggestResponseSchema
>["data"];
export type PublicFeed = z.infer<typeof feedResponseSchema>["data"];
export type PublicFeedItem = PublicFeed["items"][number];
export type PublicChatSession = z.infer<typeof chatSessionSchema>;
export type PublicCreator = z.infer<typeof creatorResponseSchema>["data"];

const authUserSchema = z
  .object({
    id: nonEmptyString,
    displayName: z.string().nullable(),
    email: z.string().trim().email(),
    image: renderableMediaSourceSchema.nullable(),
  })
  .passthrough();

const authMeResponseSchema = successEnvelope(
  z
    .object({
      user: authUserSchema.nullable(),
      anonymousId: z.string().nullable().optional(),
      ageGate: z
        .object({
          accepted: z.boolean(),
        })
        .strict()
        .optional(),
    })
    .passthrough(),
);

const viewerAuthorityResponseSchema = successEnvelope(
  z
    .object({
      user: z
        .object({
          id: nonEmptyString,
        })
        .passthrough()
        .nullable(),
      anonymousId: z.string().nullable().optional(),
      ageGate: z
        .object({
          accepted: z.boolean(),
        })
        .strict()
        .optional(),
    })
    .passthrough(),
);

const announcementSchema = z
  .object({
    id: nonEmptyString,
    title: nonEmptyString,
    body: z.string(),
    level: z.enum(["info", "promo", "warning"]),
    href: z
      .string()
      .trim()
      .min(1)
      .max(2_048)
      .refine(
        (value) => isSafeInternalPath(value) || isSafeExternalHref(value),
        "Expected a safe internal path or HTTPS URL",
      )
      .nullable(),
  })
  .passthrough();

const announcementsResponseSchema = successEnvelope(
  z.object({ items: z.array(announcementSchema) }),
);

const characterDetailSchema = publicCharacterCardSchema
  .extend({
    tags: z
      .array(
        z
          .object({
            label: nonEmptyString,
            slug: nonEmptyString,
          })
          .passthrough(),
      )
      .optional(),
    liked: z.boolean().optional(),
    style: z.string().optional(),
    gender: z.string().optional(),
  })
  .passthrough();

const characterDetailResponseSchema = successEnvelope(
  z.object({ character: characterDetailSchema }),
);

const chatSessionCreateResponseSchema = successEnvelope(
  z.object({
    session: z.object({ id: nonEmptyString }).passthrough(),
  }),
);

const characterLikeResponseSchema = successEnvelope(
  z.object({ liked: z.boolean() }),
);

const reportResponseSchema = successEnvelope(
  z.object({
    report: z.object({ id: nonEmptyString }).passthrough(),
  }),
);

export const feedbackItemSchema = z
  .object({
    id: nonEmptyString,
    title: nonEmptyString,
    description: nonEmptyString,
    category: z.enum(["bug", "feature", "improvement"]),
    status: nonEmptyString,
    voteCount: nonNegativeInteger,
    userVoted: z.boolean(),
  })
  .passthrough();

const feedbackItemsResponseSchema = successEnvelope(
  z.object({ items: z.array(feedbackItemSchema) }),
);

const feedbackItemResponseSchema = successEnvelope(
  z.object({ item: feedbackItemSchema }),
);

const characterTemplateSchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    summary: z.string().nullable().optional(),
    gender: z.string().nullable().optional(),
    style: z.string().nullable().optional(),
    appearance: z.unknown().optional(),
    advancedDetails: z.unknown().optional(),
    tags: z.unknown().optional(),
  })
  .passthrough();

const templatesResponseSchema = successEnvelope(
  z.object({ items: z.array(characterTemplateSchema) }),
);

const exposureContextSchema = z
  .object({
    contextToken: nonEmptyString,
    journeyId: nonEmptyString,
    placementId: nonEmptyString,
    impressionExposureId: nonEmptyString,
    detailExposureId: nonEmptyString,
  })
  .strict();

const communityCharacterSchema = publicCharacterCardSchema
  .extend({
    style: z.string().optional(),
    gender: z.string().optional(),
    exposureContext: exposureContextSchema.nullable().optional(),
  })
  .passthrough();

const communityDreamerSchema = z
  .object({
    id: nonEmptyString,
    displayName: nonEmptyString,
    image: renderableMediaSourceSchema.nullable().optional(),
    characters: nonNegativeInteger,
    followers: nonNegativeInteger,
    likes: z.string(),
    chats: z.string(),
    likesCount: nonNegativeInteger.optional(),
    chatsCount: nonNegativeInteger.optional(),
    isFollowing: z.boolean().optional(),
  })
  .passthrough();

const communityCollectionSchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    visibility: nonEmptyString,
    ownerName: z.string().nullable().optional(),
    itemCount: nonNegativeInteger.optional(),
    previews: z.array(renderableMediaSourceSchema).optional(),
  })
  .passthrough();

const rankingExperimentSchema = z
  .object({
    assignmentId: nonEmptyString,
    variant: z.enum(["control", "relationship_first"]),
    exposureId: nonEmptyString,
    surface: z.literal("community.leaderboard"),
  })
  .strict();

const communityLeaderboardsResponseSchema = successEnvelope(
  z.object({
    leaderboards: z.object({
      characters: z.array(communityCharacterSchema),
      dreamers: z.array(communityDreamerSchema),
    }),
    experimentAssignment: rankingExperimentSchema.nullable().optional(),
  }),
);

const communityCollectionsResponseSchema = successEnvelope(
  z.object({ collections: z.array(communityCollectionSchema) }),
);

const communityCampaignSchema = z
  .object({
    ctaLabel: z.string().nullable().optional(),
    eyebrow: nonEmptyString,
    href: z
      .string()
      .trim()
      .min(1)
      .max(2_048)
      .refine(
        (value) => isSafeInternalPath(value) || isSafeExternalHref(value),
        "Expected a safe internal path or HTTPS URL",
      )
      .nullable()
      .optional(),
    id: nonEmptyString,
    image: renderableMediaSourceSchema,
    source: z.literal("authority"),
    title: nonEmptyString,
  })
  .passthrough();

const communityCampaignsResponseSchema = successEnvelope(
  z.object({ campaigns: z.array(communityCampaignSchema) }),
);

const generationModelSchema = z
  .object({
    id: nonEmptyString,
    label: nonEmptyString,
    orientations: z.array(nonEmptyString).optional(),
    costMultiplier: z.number().positive(),
    entitlement: z.string().nullable(),
    maxCount: z.number().int().positive(),
  })
  .passthrough();

const imageEditGenerationModelSchema = generationModelSchema.extend({
  referenceMode: z.enum(["source_only", "identity_source"]),
});

const generationPresetSchema = z
  .object({
    id: nonEmptyString,
    type: z.enum(["background", "pose", "outfit", "mode"]),
    scope: z.enum(["built_in", "community"]).optional(),
    category: z.string().nullable(),
    label: nonEmptyString,
  })
  .passthrough();

const generationRecipeFields = {
  id: nonEmptyString,
  rowId: nonEmptyString,
  label: nonEmptyString,
  useCase: nonEmptyString,
  version: z.number().int().positive(),
} as const;

const imageGenerationRecipeSchema = z
  .object({
    ...generationRecipeFields,
    mode: z.literal("image"),
  })
  .passthrough();

const videoGenerationRecipeSchema = z
  .object({
    ...generationRecipeFields,
    mode: z.literal("video"),
  })
  .passthrough();

const generationModeAvailabilitySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("available") }).strict(),
  z
    .object({
      state: z.literal("unavailable"),
      reason: z.enum([
        "no_active_model",
        "no_active_recipe",
        "entitlement_required",
        "feature_disabled",
      ]),
    })
    .strict(),
]);

const generationConfigSchema = z
  .object({
    viewer: z
      .object({
        authenticated: z.boolean(),
        scope: z.string().min(1).nullable(),
      })
      .strict(),
    entitlements: z.record(z.string(), z.unknown()),
    dreamcoins: z.object({ balance: nonNegativeInteger }).strict(),
    pricing: z
      .object({
        image: z
          .object({
            baseCost: z.number().nonnegative(),
            maxCount: z.number().int().positive().nullable(),
          })
          .strict(),
        video: z
          .object({
            baseCost: z.number().nonnegative().nullable(),
          })
          .strict(),
      })
      .strict(),
    image: z
      .object({
        availability: generationModeAvailabilitySchema,
        orientations: z.array(nonEmptyString),
        models: z.array(generationModelSchema),
        editModels: z.array(imageEditGenerationModelSchema).default([]),
        recipes: z.array(imageGenerationRecipeSchema).optional(),
      })
      .strict(),
    video: z
      .object({
        enabled: z.boolean(),
        availability: generationModeAvailabilitySchema,
        requiredEntitlement: z.string(),
        models: z.array(generationModelSchema),
        recipes: z.array(videoGenerationRecipeSchema).optional(),
      })
      .strict(),
    presets: z.array(generationPresetSchema).optional(),
  })
  .passthrough()
  .superRefine((config, ctx) => {
    const scope = config.viewer.scope;
    if (
      (config.viewer.authenticated && !scope?.startsWith("user:")) ||
      (!config.viewer.authenticated &&
        scope !== null &&
        !scope.startsWith("anonymous:"))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["viewer", "scope"],
        message: "viewer scope does not match authentication state",
      });
    }

    const imageAvailable = config.image.availability.state === "available";
    const imageCapabilityIsComplete =
      config.image.models.length > 0 &&
      config.image.orientations.length > 0 &&
      config.pricing.image.maxCount !== null &&
      hasCompleteRecipeSet(config.image.recipes);
    const imageCapabilityIsEmpty =
      config.image.models.length === 0 &&
      config.image.orientations.length === 0 &&
      config.pricing.image.maxCount === null;
    if (
      (imageAvailable && !imageCapabilityIsComplete) ||
      (!imageAvailable && !imageCapabilityIsEmpty)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["image", "availability"],
        message:
          "image availability must exactly match models, orientations, and maxCount",
      });
    }
    if (
      imageAvailable &&
      config.pricing.image.maxCount !== config.image.models[0]?.maxCount
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["pricing", "image", "maxCount"],
        message: "image maxCount must match the default visible model",
      });
    }

    const videoAvailable =
      config.video.availability.state === "available";
    if (
      (videoAvailable &&
        (!config.video.enabled ||
          config.video.models.length === 0 ||
          !hasCharacterRecipe(config.video.recipes))) ||
      (!videoAvailable && config.video.models.length > 0)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["video", "availability"],
        message:
          "video availability must exactly match the feature flag and visible models",
      });
    }
  });

function hasCompleteRecipeSet(
  recipes:
    | ReadonlyArray<{
        useCase: string;
      }>
    | undefined,
) {
  const useCases = new Set((recipes ?? []).map((recipe) => recipe.useCase));
  return useCases.has("character") && useCases.has("freeplay");
}

function hasCharacterRecipe(
  recipes:
    | ReadonlyArray<{
        useCase: string;
      }>
    | undefined,
) {
  return (recipes ?? []).some((recipe) => recipe.useCase === "character");
}

const generationConfigResponseSchema = successEnvelope(generationConfigSchema);

const generationQuoteSchema = z
  .object({
    mode: z.enum(["image", "video"]),
    profileId: nonEmptyString,
    profileVersion: z.number().int().positive(),
    routeFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    pricing: z
      .object({
        ruleId: nonEmptyString,
        ruleKey: nonEmptyString,
        version: z.number().int().positive(),
        effectiveFrom: timestamp.nullable(),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    orientations: z.array(nonEmptyString).min(1),
    defaultOrientation: nonEmptyString,
    maxCount: z.number().int().min(1).max(8),
    costs: z
      .array(
        z
          .object({
            outputCount: z.number().int().min(1).max(8),
            costDreamcoins: nonNegativeInteger,
          })
          .strict(),
      )
      .min(1)
      .max(8),
    balance: nonNegativeInteger,
  })
  .strict()
  .superRefine((quote, ctx) => {
    if (
      quote.orientations[0] !== quote.defaultOrientation ||
      !quote.orientations.includes(quote.defaultOrientation)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["defaultOrientation"],
        message: "default orientation must be the first allowed orientation",
      });
    }
    if (
      quote.costs.length !== quote.maxCount ||
      quote.costs.some(
        (cost, index) => cost.outputCount !== index + 1,
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["costs"],
        message:
          "quote must contain one exact ordered cost for every allowed output count",
      });
    }
  });

const generationQuoteResponseSchema = successEnvelope(
  z.object({ quote: generationQuoteSchema }).strict(),
);

const generationRetryQuoteSchema = z
  .object({
    mode: z.enum(["image", "video"]),
    generationJobId: nonEmptyString,
    profileId: nonEmptyString,
    profileVersion: z.number().int().positive(),
    routeFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    pricing: z
      .object({
        ruleId: nonEmptyString,
        ruleKey: nonEmptyString,
        version: z.number().int().positive(),
        effectiveFrom: timestamp.nullable(),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    outputCount: z.number().int().min(1).max(8),
    costDreamcoins: nonNegativeInteger,
    balance: nonNegativeInteger,
  })
  .strict();

const generationRetryQuoteResponseSchema = successEnvelope(
  z.object({ quote: generationRetryQuoteSchema }).strict(),
);

const generationJobSchema = z
  .object({
    id: nonEmptyString,
    mode: z.enum(["image", "video"]),
    status: nonEmptyString,
    costDreamcoins: nonNegativeInteger,
    outputCount: nonNegativeInteger,
    errorCode: z.string().nullable(),
    createdAt: timestamp,
  })
  .passthrough();

const mediaProvenanceSchema = z
  .object({
    sourceType: nonEmptyString,
    sourceId: z.string().nullable().optional(),
    label: nonEmptyString,
    feedItemId: z.string().nullable().optional(),
    sourceCharacterId: z.string().nullable().optional(),
    sourceCharacterName: z.string().nullable().optional(),
    href: internalPath.nullable().optional(),
  })
  .passthrough();

const workspaceMediaItemSchema = z
  .object({
    id: nonEmptyString,
    characterId: z.string().nullable().optional(),
    type: z.enum(["image", "video"]),
    url: renderableMediaSourceSchema,
    thumbnailUrl: renderableMediaSourceSchema,
    contentType: z.string().nullable().optional(),
    width: nonNegativeInteger.nullable().optional(),
    height: nonNegativeInteger.nullable().optional(),
    prompt: z.string().nullable(),
    liked: z.boolean(),
    isSynthetic: z.boolean().optional(),
    canEditIdentity: z.boolean().optional(),
    imageEditModelIds: z.array(nonEmptyString).optional(),
    visualProfileId: z.string().nullable().optional(),
    visualProfileVersion: nonNegativeInteger.nullable().optional(),
    identity: z
      .object({
        selectedAsCharacterImage: z.boolean().optional(),
        addedToReferences: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    provenance: mediaProvenanceSchema.nullable().optional(),
  })
  .passthrough();

const userPresetSchema = z
  .object({
    id: nonEmptyString,
    type: nonEmptyString,
    category: z.string().nullable(),
    label: nonEmptyString,
    controls: z.record(z.string(), z.unknown()),
    visibility: nonEmptyString,
  })
  .passthrough();

const characterLookSchema = z
  .object({
    id: nonEmptyString,
    characterId: nonEmptyString,
    label: nonEmptyString,
    status: nonEmptyString,
    appearanceDelta: z.record(z.string(), z.unknown()),
  })
  .passthrough();

const generationJobsResponseSchema = successEnvelope(
  z.object({ items: z.array(generationJobSchema) }),
);
const workspaceMediaResponseSchema = successEnvelope(
  z.object({ items: z.array(workspaceMediaItemSchema) }),
);
const userPresetsResponseSchema = successEnvelope(
  z.object({ items: z.array(userPresetSchema) }),
);
const characterLooksResponseSchema = successEnvelope(
  z.object({ items: z.array(characterLookSchema) }),
);
const generatorCharactersResponseSchema = successEnvelope(
  z.object({ items: z.array(publicCharacterCardSchema) }).passthrough(),
);
const generationJobDetailResponseSchema = successEnvelope(
  z.object({
    job: generationJobSchema,
    assets: z.array(workspaceMediaItemSchema),
  }),
);

const libraryCharacterSchema = z
  .object({
    id: nonEmptyString,
    title: z.string().optional(),
    name: z.string().optional(),
    image: renderableMediaSourceSchema.optional(),
  })
  .passthrough();

const libraryItemSchema = z
  .object({
    id: nonEmptyString,
    type: z.string().optional(),
    title: z.string().optional(),
    name: z.string().optional(),
    description: z.string().nullable().optional(),
    image: renderableMediaSourceSchema.optional(),
    thumbnailUrl: renderableMediaSourceSchema.optional(),
    url: renderableMediaSourceSchema.optional(),
    contentType: z.string().nullable().optional(),
    isSynthetic: z.boolean().optional(),
    prompt: z.string().nullable().optional(),
    visibility: z.string().optional(),
    status: z.string().optional(),
    character: libraryCharacterSchema.optional(),
  })
  .passthrough();

const libraryResponseSchema = successEnvelope(
  z.object({
    items: z.array(libraryItemSchema),
    emptyCta: internalPath.nullable().optional().default(null),
  }),
);

const mediaCollectionSchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    visibility: z.enum(["private", "public", "unlisted"]),
    itemCount: nonNegativeInteger,
  })
  .passthrough();

const mediaCollectionsResponseSchema = successEnvelope(
  z.object({ collections: z.array(mediaCollectionSchema) }),
);

const profilePreferencesResponseSchema = successEnvelope(
  z.object({
    preferences: z
      .object({
        locale: z.string().nullable().optional(),
        mutedTags: z.array(nonEmptyString).nullable().optional(),
        notificationSettings: z
          .record(z.string(), z.unknown())
          .nullable()
          .optional(),
      })
      .passthrough(),
  }),
);

const chatAttachmentSchema = z
  .object({
    id: nonEmptyString,
    kind: nonEmptyString,
    status: nonEmptyString,
    mediaAssetId: z.string().nullable().optional(),
    mediaUrl: renderableMediaSourceSchema.nullable().optional(),
    thumbnailUrl: renderableMediaSourceSchema.nullable().optional(),
    isSynthetic: z.boolean().optional(),
    costDreamcoins: nonNegativeInteger.nullable().optional(),
    promptHint: z.string().nullable().optional(),
    width: nonNegativeInteger.nullable().optional(),
    height: nonNegativeInteger.nullable().optional(),
    errorCode: z.string().nullable().optional(),
  })
  .passthrough();

const chatMessageSchema = z
  .object({
    id: nonEmptyString,
    role: nonEmptyString,
    content: z.string(),
    status: z.string().optional(),
    attachments: z.array(chatAttachmentSchema).optional(),
  })
  .passthrough();

const chatSessionDetailSchema = z
  .object({
    id: nonEmptyString,
    title: z.string().nullable(),
    characterId: z.string().optional(),
    memoryEnabled: z.boolean().optional(),
    messages: z.array(chatMessageSchema),
    character: z
      .object({
        canUpdateIdentity: z.boolean().optional(),
        name: nonEmptyString,
      })
      .passthrough(),
  })
  .passthrough();

const chatSessionDetailResponseSchema = successEnvelope(
  z.object({ session: chatSessionDetailSchema }),
);

const chatSendResponseSchema = successEnvelope(
  z.object({
    userMessage: chatMessageSchema,
    assistant: chatMessageSchema,
    assistantMessageId: z.string().optional(),
    streamUrl: internalPath.nullable().optional(),
    safety: z
      .object({
        layer: z.enum(["input", "output"]),
        policyCode: z.string().optional(),
      })
      .passthrough()
      .optional(),
  }),
);

export type AuthUser = z.infer<typeof authUserSchema>;
export type PublicAnnouncement = z.infer<typeof announcementSchema>;
export type PublicCharacterDetail = z.infer<typeof characterDetailSchema>;
export type PublicFeedbackItem = z.infer<typeof feedbackItemSchema>;
export type PublicCharacterTemplate = z.infer<typeof characterTemplateSchema>;
export type CommunityCharacter = z.infer<typeof communityCharacterSchema>;
export type CommunityDreamer = z.infer<typeof communityDreamerSchema>;
export type CommunityCollection = z.infer<typeof communityCollectionSchema>;
export type CommunityCampaign = z.infer<typeof communityCampaignSchema>;
export type RankingExperiment = z.infer<typeof rankingExperimentSchema>;
export type RuntimeGenerationConfig = z.infer<typeof generationConfigSchema>;
export type RuntimeGenerationQuote = z.infer<typeof generationQuoteSchema>;
export type RuntimeGenerationRetryQuote = z.infer<
  typeof generationRetryQuoteSchema
>;
export type RuntimeGenerationJob = z.infer<typeof generationJobSchema>;
export type RuntimeWorkspaceMediaItem = z.infer<
  typeof workspaceMediaItemSchema
>;
export type RuntimeUserPreset = z.infer<typeof userPresetSchema>;
export type RuntimeCharacterLook = z.infer<typeof characterLookSchema>;
export type RuntimeLibraryItem = z.infer<typeof libraryItemSchema>;
export type RuntimeMediaCollection = z.infer<typeof mediaCollectionSchema>;
export type RuntimeChatMessage = z.infer<typeof chatMessageSchema>;
export type RuntimeChatAttachment = z.infer<typeof chatAttachmentSchema>;
export type RuntimeChatSession = z.infer<typeof chatSessionDetailSchema>;

export function parsePlansResponse(payload: unknown) {
  return parseContract(plansResponseSchema, payload, "plans").data;
}

export function parseFollowMutationResponse(payload: unknown) {
  return parseContract(
    followMutationResponseSchema,
    payload,
    "follow mutation",
  ).data;
}

export function parseCheckoutResponse(payload: unknown) {
  return parseContract(
    checkoutResponseSchema,
    payload,
    "checkout",
  ).data;
}

export function parseProfileResponse(payload: unknown) {
  return parseContract(
    profileResponseSchema,
    payload,
    "profile",
  ).data;
}

export function parseBillingPortalResponse(payload: unknown) {
  return parseContract(
    billingPortalResponseSchema,
    payload,
    "billing access",
  ).data;
}

export function parsePublicApiError(payload: unknown) {
  const parsed = publicApiErrorEnvelopeSchema.safeParse(payload);
  if (!parsed.success) return null;
  const details =
    parsed.data.error.details &&
    typeof parsed.data.error.details === "object" &&
    !Array.isArray(parsed.data.error.details)
      ? (parsed.data.error.details as Record<string, unknown>)
      : null;
  const idempotencyAction = checkoutIdempotencyActionSchema.safeParse(
    details?.idempotencyAction,
  );
  return {
    code: parsed.data.error.code,
    message: parsed.data.error.message ?? "Request failed",
    idempotencyAction: idempotencyAction.success
      ? idempotencyAction.data
      : undefined,
  };
}

export function parseCharacterListResponse(payload: unknown) {
  return parseContract(
    characterListResponseSchema,
    payload,
    "character catalog",
  ).data;
}

export function parseTagListResponse(payload: unknown) {
  return parseContract(tagListResponseSchema, payload, "tag catalog").data;
}

export function parseSearchSuggestResponse(payload: unknown) {
  return parseContract(
    searchSuggestResponseSchema,
    payload,
    "search suggestions",
  ).data;
}

export function parseFeedResponse(payload: unknown) {
  return parseContract(feedResponseSchema, payload, "feed").data;
}

export function parseChatSessionsResponse(payload: unknown) {
  return parseContract(
    z.array(chatSessionSchema),
    payload,
    "chat sessions",
  );
}

export function parseCreatorResponse(payload: unknown) {
  return parseContract(creatorResponseSchema, payload, "creator profile").data;
}

export function parseAuthMeResponse(payload: unknown) {
  return parseContract(authMeResponseSchema, payload, "account authority").data;
}

export function parseViewerAuthorityResponse(payload: unknown) {
  return parseContract(
    viewerAuthorityResponseSchema,
    payload,
    "viewer authority",
  ).data;
}

export function parseAnnouncementsResponse(payload: unknown) {
  return parseContract(
    announcementsResponseSchema,
    payload,
    "announcements",
  ).data;
}

export function parseCharacterDetailResponse(payload: unknown) {
  return parseContract(
    characterDetailResponseSchema,
    payload,
    "character detail",
  ).data;
}

export function parseChatSessionCreateResponse(payload: unknown) {
  return parseContract(
    chatSessionCreateResponseSchema,
    payload,
    "chat session",
  ).data;
}

export function parseCharacterLikeResponse(payload: unknown) {
  return parseContract(
    characterLikeResponseSchema,
    payload,
    "character like",
  ).data;
}

export function parseReportResponse(payload: unknown) {
  return parseContract(reportResponseSchema, payload, "report").data;
}

export function parseFeedbackItemsResponse(payload: unknown) {
  return parseContract(
    feedbackItemsResponseSchema,
    payload,
    "roadmap feedback",
  ).data;
}

export function parseFeedbackItemResponse(payload: unknown) {
  return parseContract(
    feedbackItemResponseSchema,
    payload,
    "roadmap feedback item",
  ).data;
}

export function parseTemplatesResponse(payload: unknown) {
  return parseContract(
    templatesResponseSchema,
    payload,
    "character templates",
  ).data;
}

export function parseCommunityLeaderboardsResponse(payload: unknown) {
  return parseContract(
    communityLeaderboardsResponseSchema,
    payload,
    "community leaderboards",
  ).data;
}

export function parseCommunityCollectionsResponse(payload: unknown) {
  return parseContract(
    communityCollectionsResponseSchema,
    payload,
    "community collections",
  ).data;
}

export function parseCommunityCampaignsResponse(payload: unknown) {
  return parseContract(
    communityCampaignsResponseSchema,
    payload,
    "community campaigns",
  ).data;
}

export function parseGenerationConfigResponse(payload: unknown) {
  return parseContract(
    generationConfigResponseSchema,
    payload,
    "generation config",
  ).data;
}

export function parseGenerationQuoteResponse(payload: unknown) {
  return parseContract(
    generationQuoteResponseSchema,
    payload,
    "generation quote",
  ).data;
}

export function parseGenerationRetryQuoteResponse(payload: unknown) {
  return parseContract(
    generationRetryQuoteResponseSchema,
    payload,
    "generation retry quote",
  ).data;
}

export function parseGenerationJobsResponse(payload: unknown) {
  return parseContract(
    generationJobsResponseSchema,
    payload,
    "generation jobs",
  ).data;
}

export function parseWorkspaceMediaResponse(payload: unknown) {
  return parseContract(
    workspaceMediaResponseSchema,
    payload,
    "workspace media",
  ).data;
}

export function parseUserPresetsResponse(payload: unknown) {
  return parseContract(
    userPresetsResponseSchema,
    payload,
    "user presets",
  ).data;
}

export function parseCharacterLooksResponse(payload: unknown) {
  return parseContract(
    characterLooksResponseSchema,
    payload,
    "character looks",
  ).data;
}

export function parseGeneratorCharactersResponse(payload: unknown) {
  return parseContract(
    generatorCharactersResponseSchema,
    payload,
    "generator characters",
  ).data;
}

export function parseGenerationJobDetailResponse(payload: unknown) {
  return parseContract(
    generationJobDetailResponseSchema,
    payload,
    "generation job detail",
  ).data;
}

export function parseLibraryResponse(payload: unknown) {
  return parseContract(libraryResponseSchema, payload, "profile library").data;
}

export function parseMediaCollectionsResponse(payload: unknown) {
  return parseContract(
    mediaCollectionsResponseSchema,
    payload,
    "media collections",
  ).data;
}

export function parseProfilePreferencesResponse(payload: unknown) {
  return parseContract(
    profilePreferencesResponseSchema,
    payload,
    "profile preferences",
  ).data;
}

export function parseChatSessionDetailResponse(payload: unknown) {
  return parseContract(
    chatSessionDetailResponseSchema,
    payload,
    "chat session detail",
  ).data;
}

export function parseChatSendResponse(payload: unknown) {
  return parseContract(chatSendResponseSchema, payload, "chat send").data;
}

function successEnvelope<T extends z.ZodType>(data: T) {
  return z
    .object({
      ok: z.literal(true),
      data,
    })
    .passthrough();
}

function parseContract<T extends z.ZodType>(
  schema: T,
  payload: unknown,
  contractName: string,
): z.infer<T> {
  const parsed = schema.safeParse(payload);
  if (parsed.success) return parsed.data;
  throw new PublicApiContractError(contractName, parsed.error);
}

export class PublicApiContractError extends Error {
  readonly contractName: string;

  constructor(contractName: string, cause: z.ZodError) {
    super(`Invalid ${contractName} response`, { cause });
    this.name = "PublicApiContractError";
    this.contractName = contractName;
  }
}

export function isRenderableMediaSource(value: string) {
  return isSafeInternalPath(value);
}

export function isSafeInternalPath(value: string) {
  if (!value.startsWith("/") || unsafeUrlCharacters(value)) return false;
  const origin = "https://owned-media.invalid";
  try {
    return new URL(value, origin).origin === origin;
  } catch {
    return false;
  }
}

export function isSafeExternalHref(value: string) {
  if (unsafeUrlCharacters(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

function unsafeUrlCharacters(value: string) {
  return (
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001F\u007F]/.test(value)
  );
}
