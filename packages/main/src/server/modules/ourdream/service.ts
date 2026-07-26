import { Prisma, type GenerationJob as GenerationJobRow } from "@prisma/client";
import { buildCharacterSystemPrompt } from "@idream/shared";
import { parseCharacterReleaseAssetManifest } from "@idream/shared/admin";
import { assignWorkflowReferenceSlots } from "@idream/shared/gen-workflow";
import { resolveLocalBlobPath, resolveLocalBlobRoot } from "@idream/shared/storage/local-blob";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type {
  CharacterPreviewGeneratePayload,
  ChatImageRequestedPayload,
} from "@/server/ai/schemas";
import {
  recordGenerationAttemptEvent,
} from "@/server/ai/generation-attempt-events";
import {
  assertPinnedLegacyCharacterGenerationAuthority,
  enqueueGenerationAttempt,
  legacyCharacterGenerationAuthorityFromControls,
  loadLockedLiveEditorialLegacyGenerationAuthority,
  type LegacyCharacterGenerationAuthority,
} from "@/server/modules/generation/attempt-dispatch";
import { transitionGenerationRequest } from "@/server/ai/generation-request-transition";
import { dispatchAdmin } from "@/server/modules/admin/service";
import { generationWorkflowDescriptor } from "@/server/modules/admin/generation-catalog";
import {
  ensureReviewCaseForAppeal,
  ensureReviewCaseForReport,
  ensureSupportCaseForRequest,
} from "@/server/modules/admin-v2/cases/service";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { listActiveTemplates } from "@/server/modules/admin/characters/templates";
import {
  IDENTITY_ASSEMBLER_VERSION,
  assembleIdentityPrompt,
  toTraitRecord,
  type IdentityTraits,
} from "@/server/modules/ourdream/identity-assembler";
import { isReusablePlatformAssetWhere } from "@/server/modules/ourdream/chat-image-reuse";
import {
  characterVisualProfileSnapshotHash,
  referenceSetSnapshotHash,
} from "@/server/modules/admin-v2/characters/release-snapshot";
import {
  lockCharacterGenerationAuthority,
  lockCharacterMediaAssetAuthorities,
  lockMediaAssetAuthority,
} from "@/server/modules/admin-v2/characters/generation-authority-lock";
import { invalidateCharacterDraftAssetPack } from "@/server/modules/admin-v2/characters/draft-asset-authority";
import { proxyChatRequest } from "@/server/bff/chat-proxy";
import { jobQueue } from "@/server/jobs/queue";
import {
  GEN_QUEUES,
  MAIN_TO_CHAT_EVENTS,
  METRIC_PRODUCT_EVENTS,
  characterExposureRecordedV2Schema,
  idempotencyKeys,
} from "@idream/shared/contracts";
import {
  dispatchPendingChatEvents,
  recordMainToChatEvent,
} from "@/processes/chat-outbox";
import { appendCanonicalMetricEvent } from "@/server/modules/admin-v2/metrics/event-writer";
import { createClassifiedAnalyticsEvent } from "@/server/modules/admin-v2/metrics/classified-event-writer";
import {
  ExperimentRuntimeError,
  assignExperiment,
  recordExperimentExposure,
} from "@/server/modules/admin-v2/experiments/runtime";
import { linkGenerationLedgerEntry } from "@/server/ai/generation-settlement";
import {
  clearSessionCookie,
  createAnonymousId,
  createSessionToken,
  getAuthCtx,
  hashPassword,
  mergeAnonymous,
  requireAgeGate,
  requireAgeVerified,
  requireUser,
  sessionCookie,
  ageGateCookie,
  anonymousCookie,
  clearAdminSessionCookie,
  verifyPassword,
} from "@/server/lib/auth";
import { prisma } from "@/server/lib/db";
import { nameMatch } from "@/server/lib/db/search";
import {
  generationCostDreamcoins,
  generationCostFromAuthority,
  resolveGenerationPricingAuthority,
} from "@/server/lib/generation-pricing";
import { env } from "@/server/lib/env";
import { AppError, Errors } from "@/server/lib/errors";
import {
  evaluateMediaAssetCustomerPublishability,
  hasHydratableMediaBlobAuthority,
  isMediaAssetOperationalForAuthority,
  isSyntheticMediaAsset,
  resolveMediaAssetBlobLocator,
  SHARED_IMMUTABLE_BLOB_LOCATOR_SCHEMA,
} from "@/server/lib/media-asset-authority";
import { mediaAssetAuthorityDependencies } from "@/server/modules/admin-v2/shared/media-asset-authority-dependencies";
import { canonicalJsonHash } from "@/server/modules/admin-v2/shared/idempotency";
import { isCharacterProjectPhaseTransitionAllowed } from "@/server/modules/admin-v2/shared/state-transition-authority";
import {
  isReservedInternalEmail,
  registeredUserDataClass,
} from "@/server/lib/user-data-provenance";
import { empty, fail, ok } from "@/server/lib/http";
import { getOurdreamRoute, ourdreamRoutePaths } from "@/lib/ourdream-data";
import { billingPeriodEnd } from "@/lib/billing-period";
import { isPublicRouteDiscoverable } from "@/lib/public-route-authority";
import { activeAnnouncements, readAnnouncements } from "@/server/announcements/store";
import { logger } from "@/server/lib/logger";
import { resolveCharacterVoiceAuthority } from "@/server/modules/voice-defaults";
import {
  redeemCodeDreamcoins,
  redeemCodeHashCandidates,
} from "@/server/lib/redeem-codes";
import { providers } from "@/server/providers";
import type {
  PaymentInvoice,
  ProviderResult,
} from "@/server/providers/types";
import { paymentProviderCapabilities } from "@/server/providers/payment/capabilities";
import type { OurdreamRoute, OurdreamRouteTemplate } from "@/types/ourdream";
import {
  dimensionsForImageOrientation,
  imageOrientations,
  normalizeImageOrientation,
} from "./generation-dimensions";
import {
  issueExposureContext,
  verifyExposureContext,
  type ExposureSubject,
} from "./exposure-context";
import {
  parseCommunityCampaignAuthoredCopy,
  resolveCommunityCampaignPlacements,
} from "./community-campaigns";
import {
  FEATURED_SETTING_KEY,
  parseFeaturedSetting,
} from "./featured-setting";
import {
  activeCustomerUserWhere,
  nonSyntheticMediaAssetWhere,
  publicCharacterAudienceWhere,
  publicCollectionAudienceWhere,
  publicFeedbackAudienceWhere,
  publicReadableMediaAssetWhere,
  resolvePublicCharacterReleaseAssetPack,
} from "./public-content-audience";

const generationOrientations = [...imageOrientations, "2:3"] as [
  (typeof imageOrientations)[number] | "2:3",
  ...Array<(typeof imageOrientations)[number] | "2:3">,
];

type ApiMethod = "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
type JsonRecord = Record<string, Prisma.JsonValue>;
type SearchRouteSuggestion = {
  description: string;
  href: string;
  template: OurdreamRouteTemplate;
  title: string;
};

const credentialProvider = "credential";
const missingCharacterImage = "/images/ourdream/character-placeholder.svg";

const signupSchema = z.object({
  email: z.string().email().transform((value) => value.toLowerCase()),
  password: z.string().min(8),
  name: z.string().trim().min(1).max(80).optional(),
  // Referral code captured from /signup?ref=DREAM-XXXX (invite share link).
  ref: z.string().trim().min(1).max(64).optional(),
});

// Referral economy (give/get): both the new user and the inviter receive dreamcoins
// when an invitee signs up with a valid ref code. Idempotent per invitee via the
// ledger idempotencyKey, so replays/retries never double-mint.
const REFERRAL_INVITEE_BONUS = 150;
const REFERRAL_INVITER_REWARD = 150;

const loginSchema = z.object({
  email: z.string().email().transform((value) => value.toLowerCase()),
  password: z.string().min(1),
});

const ageGateSchema = z.object({
  country: z.string().max(2).optional(),
  sourcePath: z.string().max(240).optional(),
  policyVersion: z.string().max(80).default("2026-06-13"),
});

const draftCreateSchema = z.object({
  gender: z.enum(["female", "male", "trans"]).optional(),
  style: z.enum(["realistic", "anime", "hybrid", "other"]).optional(),
  name: z.string().trim().min(1).max(80).optional(),
});

const draftPatchSchema = z.object({
  step: z.number().int().min(0).max(12).optional(),
  gender: z.enum(["female", "male", "trans"]).nullable().optional(),
  style: z.enum(["realistic", "anime", "hybrid", "other"]).nullable().optional(),
  name: z.string().trim().min(1).max(80).nullable().optional(),
  appearance: z.record(z.string(), z.unknown()).optional(),
  hair: z.record(z.string(), z.unknown()).optional(),
  body: z.record(z.string(), z.unknown()).optional(),
  advancedDetails: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
});

const draftSubmitSchema = z.object({
  visibility: z.enum(["private", "unlisted", "public"]).default("private"),
  description: z.string().trim().min(1).max(1_500).optional(),
  age: z.number().int().min(18).max(99).default(21),
});

const draftPreviewSelectSchema = z.object({
  previewJobId: z.string().trim().min(1),
});

const generationControlsSchema = z
  .object({
    modePresetId: z.string().trim().min(1).max(120).optional(),
    backgroundPresetId: z.string().trim().min(1).max(120).optional(),
    posePresetId: z.string().trim().min(1).max(120).optional(),
    outfitPresetId: z.string().trim().min(1).max(120).optional(),
    lookId: z.string().trim().min(1).max(120).optional(),
    expression: z.string().trim().min(1).max(240).optional(),
    pose: z.string().trim().min(1).max(240).optional(),
    outfit: z.string().trim().min(1).max(400).optional(),
    camera: z.string().trim().min(1).max(240).optional(),
    lighting: z.string().trim().min(1).max(240).optional(),
    styleDelta: z.string().trim().min(1).max(240).optional(),
    orientation: z.enum(generationOrientations).optional(),
    model: z.string().trim().min(1).max(120).optional(),
    seconds: z.number().int().min(1).max(30).optional(),
  })
  .strict();

const generationQuoteAuthoritySchema = z
  .object({
    profileId: z.string().trim().min(1).max(180),
    profileVersion: z.number().int().positive(),
    routeFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    pricingFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    outputCount: z.number().int().min(1).max(8),
    costDreamcoins: z.number().int().nonnegative(),
  })
  .strict();

const generationJobSchema = z
  .object({
    mode: z.enum(["image", "video"]).default("image"),
    characterId: z.string().min(1).optional(),
    visualProfileId: z.string().min(1).optional(),
    consistencyMode: z.enum(["balanced", "strict", "creative"]).default("balanced"),
    seed: z.string().trim().min(1).max(120).optional(),
    freeplay: z.boolean().default(false),
    prompt: z.string().trim().max(2_000).optional(),
    negativePrompt: z.string().trim().max(1_000).optional(),
    controls: generationControlsSchema.default({}),
    presetIds: z.array(z.string()).max(12).default([]),
    orientation: z.enum(generationOrientations).optional(),
    outputCount: z.number().int().min(1).max(8).default(1),
    model: z.string().max(80).optional(),
    remixFeedItemId: z.string().max(180).optional(),
    quoteAuthority: generationQuoteAuthoritySchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (Boolean(value.characterId) === value.freeplay) {
      ctx.addIssue({
        code: "custom",
        path: ["characterId"],
        message: "Choose exactly one of characterId or freeplay",
      });
    }
    if (value.freeplay && value.visualProfileId) {
      ctx.addIssue({
        code: "custom",
        path: ["visualProfileId"],
        message: "Visual profile can only be used with a character",
      });
    }
    if (
      value.mode === "video" &&
      value.controls.seconds !== undefined &&
      value.controls.seconds !== 4
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["controls", "seconds"],
        message: "LTX 2.3 video generation requires exactly four seconds",
      });
    }
  });

const presetCreateSchema = z.object({
  type: z.enum(["background", "pose", "outfit", "mode"]),
  category: z.string().max(80).optional(),
  label: z.string().trim().min(1).max(80),
  controls: z.record(z.string(), z.unknown()).default({}),
  visibility: z.enum(["private", "public", "unlisted"]).default("private"),
});

const mediaCollectionVisibilitySchema = z.enum(["private", "public", "unlisted"]);

const generationFeedbackSchema = z.object({
  feedbackType: z.enum(["identity_match", "identity_mismatch"]),
  sourceSurface: z.enum(["chat", "generator", "gallery"]),
});

const characterLookAppearanceSchema = z
  .record(z.string(), z.unknown())
  .superRefine((value, ctx) => {
    const allowedKeys = new Set(["outfit", "hair", "accessories", "makeup", "description"]);
    for (const key of Object.keys(value)) {
      if (allowedKeys.has(key)) continue;
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `${key} is an identity trait; a Look may only change styling`,
      });
    }
  });

const characterLookSchema = z.object({
  label: z.string().trim().min(1).max(80),
  appearanceDelta: characterLookAppearanceSchema,
  referenceAssetId: z.string().trim().min(1).optional(),
});

const characterLookPatchSchema = characterLookSchema.partial().extend({
  status: z.enum(["active", "archived"]).optional(),
});

const mediaCollectionCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  visibility: mediaCollectionVisibilitySchema.default("private"),
  mediaAssetId: z.string().optional(),
});

const mediaCollectionUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  visibility: mediaCollectionVisibilitySchema.optional(),
});

const mediaCollectionItemSchema = z.object({
  mediaAssetId: z.string(),
});

const checkoutSchema = z.object({
  planId: z.string().optional(),
  slug: z.enum(["premium", "deluxe"]).optional(),
  billingPeriod: z.enum(["monthly", "yearly"]).default("monthly"),
  returnPath: z
    .string()
    .max(240)
    .refine((value) => value.startsWith("/") && !value.startsWith("//"), {
      message: "returnPath must be an internal path",
    })
    .default("/profile"),
  autoConfirm: z.boolean().default(true),
});

const checkoutOfferSnapshotSchema = z.object({
  version: z.literal(1),
  planId: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  billingPeriod: z.enum(["monthly", "yearly"]),
  priceCents: z.number().int().nonnegative(),
  currency: z.string().min(1),
  includedDreamcoins: z.number().int().nonnegative(),
  features: z.record(z.string(), z.unknown()),
});

const reportSchema = z.object({
  targetType: z.string().trim().min(1).max(80),
  targetId: z.string().trim().min(1).max(160),
  category: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000).optional(),
});

const appealTargetTypeSchema = z.enum([
  "character",
  "media",
  "feed_item",
  "chat_message",
  "user_profile",
  "moderation_decision",
  "safety_issue",
  "copyright_likeness",
]);

const profilePatchSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  image: z.string().url().optional(),
});

const preferencesPatchSchema = z.object({
  locale: z.string().trim().min(2).max(16).optional(),
  mutedTags: z.array(z.string().trim().min(1).max(80)).max(80).optional(),
  safeModeFlags: z.record(z.string(), z.unknown()).optional(),
  notificationSettings: z.record(z.string(), z.unknown()).optional(),
});

const redeemSchema = z.object({
  code: z.string().trim().min(3).max(80),
});

const eventSchema = z.object({
  name: z.string().trim().min(1).max(120),
  props: z.record(z.string(), z.unknown()).default({}),
});

const characterExposureClientSchema = z.object({
  contextToken: z.string().min(1).max(4_096),
  exposureId: z.string().min(1),
  eventType: z.enum(["eligible_impression", "detail_view"]),
  parentExposureId: z.string().min(1).nullable().default(null),
  journeyId: z.string().min(1),
  characterId: z.string().min(1),
  placementId: z.string().min(1).nullable(),
  visibleRatio: z.number().min(0).max(1),
  visibleDurationMs: z.number().int().nonnegative(),
}).strict().superRefine((event, ctx) => {
  if (event.eventType === "eligible_impression" && event.parentExposureId !== null) {
    ctx.addIssue({ code: "custom", path: ["parentExposureId"], message: "Impressions are exposure roots" });
  }
  if (event.eventType === "detail_view" && event.parentExposureId === null) {
    ctx.addIssue({ code: "custom", path: ["parentExposureId"], message: "Detail views require an exposure chain" });
  }
});

const experimentExposureClientSchema = z.object({
  exposureId: z.string().min(1).max(200),
  assignmentId: z.string().min(1).max(200),
  surface: z.literal("community.leaderboard"),
}).strict();

const supportRequestSchema = z.object({
  category: z.enum(["account", "billing", "generation", "chat", "bug", "feature", "other"]),
  subject: z.string().trim().min(3).max(120),
  description: z.string().trim().min(10).max(2_000),
  diagnosticConsent: z.boolean().default(false),
  sourcePath: z.string().trim().max(240).optional(),
});

const feedbackItemCreateSchema = z.object({
  category: z.enum(["bug", "feature", "improvement"]).default("feature"),
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(10).max(600),
});

type ProductFeedbackItemRow = {
  id: string;
  sourceKey: string | null;
  title: string;
  description: string;
  category: string;
  status: string;
  voteCount: number;
  createdAt: Date;
  updatedAt: Date;
};

export async function dispatchV1(request: Request, segments: string[]) {
  try {
    const response = await dispatchV1Unsafe(request, segments);
    return withPrivateNoStoreHeaders(response);
  } catch (error) {
    let response: Response;
    if (error instanceof AppError) {
      response = fail(error);
      return withPrivateNoStoreHeaders(response);
    }
    if (error instanceof z.ZodError) {
      response = fail(
        new AppError("bad_request", "Validation failed", error.flatten()),
      );
      return withPrivateNoStoreHeaders(response);
    }
    logger.error(
      { err: error, method: request.method, path: new URL(request.url).pathname },
      "Unhandled v1 route error",
    );
    response = fail(new AppError("internal", "Internal error"));
    return withPrivateNoStoreHeaders(response);
  }
}

function withPrivateNoStoreHeaders(response: Response) {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store, max-age=0");
  headers.set("pragma", "no-cache");
  appendVaryHeader(headers, "Cookie");
  appendVaryHeader(headers, "Authorization");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function appendVaryHeader(headers: Headers, value: string) {
  const values = new Set(
    (headers.get("vary") ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  values.add(value);
  headers.set("vary", [...values].join(", "));
}

async function dispatchV1Unsafe(request: Request, segments: string[]) {
  const method = request.method as ApiMethod;
  const [resource, id, action, child, grandchild] = segments;

  if (!resource) return ok({ service: "idream-api", version: "v1" });

  if (resource === "admin") {
    return dispatchAdmin(request, segments.slice(1));
  }

  if (resource === "auth") {
    if (id === "signup" && method === "POST") return signup(request);
    if (id === "login" && method === "POST") return login(request);
    if (id === "logout" && method === "POST") return logout(request);
  }

  if (resource === "me") {
    if (!id && method === "GET") return me(request);
    if (id === "preferences" && method === "PATCH") return updatePreferences(request);
  }

  if (resource === "age-gate" && id === "accept" && method === "POST") {
    return acceptAgeGate(request);
  }

  // 公开站内公告（无需鉴权/年龄门）：banner 读取，仅回 active + 时间窗内的展示字段。
  if (resource === "announcements" && !id && method === "GET") {
    const items = activeAnnouncements(await readAnnouncements(), Date.now());
    return ok({
      items: items.map((a) => ({
        id: a.id,
        title: a.title,
        body: a.body,
        level: a.level,
        href: a.href,
      })),
    });
  }

  if (resource === "age-verification") {
    if (id === "status" && method === "GET") return ageVerificationStatus(request);
    if (id === "sessions" && method === "POST") return createAgeVerificationSession(request);
    if (id === "webhooks" && action && method === "POST") {
      return ageVerificationWebhook(request, action);
    }
  }

  if (resource === "characters") {
    if (!id && method === "GET") return listCharacters(request);
    if (id && !action && method === "GET") return getCharacter(request, id);
    if (id && action === "like" && method === "POST") return likeCharacter(request, id);
    if (id && action === "like" && method === "DELETE") return unlikeCharacter(request, id);
    if (id && action === "report" && method === "POST") {
      return submitReport(request, { targetType: "character", targetId: id });
    }
    if (id && action === "duplicate" && method === "POST") return duplicateCharacter(request, id);
    if (id && action === "looks" && !child && method === "GET") return listCharacterLooks(request, id);
    if (id && action === "looks" && !child && method === "POST") return createCharacterLook(request, id);
    if (id && action === "looks" && child && method === "PATCH") {
      return updateCharacterLook(request, id, child);
    }
    if (id && action === "looks" && child && method === "DELETE") {
      return archiveCharacterLook(request, id, child);
    }
    if (id && !action && method === "PATCH") return updateCharacter(request, id);
    if (id && !action && method === "DELETE") return archiveCharacter(request, id);
  }

  if (resource === "tags" && !id && method === "GET") return listTags(request);
  // 前台创建页拉取可用角色模板（仅 isActive，公开只读，见 CHARACTER_MANAGEMENT_PLAN §B）。
  if (resource === "character-templates" && !id && method === "GET") {
    return listActiveTemplates();
  }
  if (resource === "search" && id === "suggest" && method === "GET") return suggest(request);

  if (resource === "character-drafts") {
    if (!id && method === "POST") return createDraft(request);
    if (id && !action && method === "PATCH") return updateDraft(request, id);
    if (id && action === "preview" && method === "POST") return previewDraft(request, id);
    if (id && action === "preview" && method === "GET") return previewStatus(request, id);
    if (id && action === "preview-anchor" && method === "POST") return selectPreviewAnchor(request, id);
    if (id && action === "submit" && method === "POST") return submitDraft(request, id);
    if (id && action === "tags" && method === "POST") return updateDraftTags(request, id);
  }

  // Chat Service split (design §1/§3, P0-A): chat is now a HARD dependency — the
  // in-monolith chat handler is gone. Always route chat/messages to the BFF proxy,
  // which signs + reverse-proxies when CHAT_SERVICE_URL is set, and returns a
  // structured 503 chat_unavailable when it is NOT (instead of a misleading
  // "route not found" fall-through).
  if (resource === "chat" || resource === "messages") {
    return proxyChatRequest(request, segments);
  }

  if (resource === "generation") {
    if (id === "config" && !action && method === "GET") return generationConfig(request);
    if (id === "quote" && !action && method === "POST") return generationQuote(request);
    if (id === "jobs" && !action && method === "POST") return createGenerationJob(request);
    if (id === "voice" && !action && method === "POST") return createVoiceClip(request);
    if (id === "jobs" && !action && method === "GET") return listGenerationJobs(request);
    if (id === "jobs" && action && !child && method === "GET") return getGenerationJob(request, action);
    if (
      id === "jobs" &&
      action &&
      child === "retry" &&
      grandchild === "quote" &&
      method === "POST"
    ) {
      return generationRetryQuote(request, action);
    }
    if (
      id === "jobs" &&
      action &&
      child === "retry" &&
      !grandchild &&
      method === "POST"
    ) {
      return retryGenerationJob(request, action);
    }
    if (id === "presets" && !action && method === "GET") return listPresets(request);
    if (id === "presets" && !action && method === "POST") return createPreset(request);
    if (id === "presets" && action && method === "PATCH") return updatePreset(request, action);
    if (id === "presets" && action && method === "DELETE") return archivePreset(request, action);
  }

  if (resource === "media") {
    if (!id && method === "GET") return listMedia(request);
    if (id === "collections" && !action && method === "GET") return listMediaCollections(request);
    if (id === "collections" && !action && method === "POST") return createMediaCollection(request);
    if (id === "collections" && action && !child && method === "PATCH") {
      return updateMediaCollection(request, action);
    }
    if (id === "collections" && action && child === "items" && method === "POST") {
      return addMediaToCollection(request, action);
    }
    if (id === "bulk" && method === "POST") return bulkMedia(request);
    if (id && action === "like" && method === "POST") return likeMedia(request, id);
    if (id && action === "like" && method === "DELETE") return unlikeMedia(request, id);
    if (id && action === "feedback" && method === "POST") return recordMediaFeedback(request, id);
    if (id && action === "use-as-character-image" && method === "POST") {
      return setMediaAsCharacterImage(request, id);
    }
    if (id && action === "add-to-identity" && method === "POST") return addMediaToIdentity(request, id);
    if (id && action === "save-as-look" && method === "POST") return saveMediaAsCharacterLook(request, id);
    if (id && action === "variation" && child === "quote" && method === "POST") {
      return mediaVariationQuote(request, id);
    }
    if (id && action === "variation" && !child && method === "POST") {
      return createMediaVariation(request, id);
    }
    if (id && action === "content" && method === "GET") return contentMedia(request, id);
    if (id && action === "download" && method === "GET") return downloadMedia(request, id);
    if (id && !action && method === "DELETE") return deleteMedia(request, id);
  }

  if (resource === "plans" && !id && method === "GET") return listPlans();
  if (resource === "billing") {
    if (id === "checkout" && method === "POST") return checkout(request);
    if (id === "portal" && method === "POST") return billingPortal(request);
    if (id === "cancel" && method === "POST") return cancelSubscription(request);
    if (id === "resume" && method === "POST") return resumeSubscription(request);
    if (id === "webhooks" && action && method === "POST") return billingWebhook(request, action);
  }
  if (resource === "dreamcoins" && method === "GET") return dreamcoins(request);

  if (resource === "library" && id && method === "GET") return library(request, id);

  if (resource === "profile") {
    if (!id && method === "GET") return profile(request);
    if (!id && method === "PATCH") return updateProfile(request);
    if (id === "preferences" && method === "GET") return profilePreferences(request);
    if (id === "preferences" && method === "PATCH") return updatePreferences(request);
    if (id === "language" && method === "PATCH") return updateLanguage(request);
  }

  if (resource === "redeem-codes" && id === "redeem" && method === "POST") {
    return redeemCode(request);
  }

  if (resource === "referrals") {
    if (!id && method === "GET") return referrals(request);
    if (id === "invite" && method === "POST") return inviteReferral(request);
  }

  if (resource === "account") {
    if (id === "sign-out-all" && method === "POST") return signOutAll(request);
    if (id === "delete-request" && method === "POST") return deleteRequest(request);
  }

  if (resource === "reports") {
    if (!id && method === "POST") return submitReport(request);
    if (id && method === "GET") return reportStatus(request, id);
  }

  if (resource === "appeals" && !id && method === "POST") return createAppeal(request);
  if (resource === "policies" && !id && method === "GET") return policies();

  if (resource === "users" && id && action === "follow") {
    if (method === "POST") return followUser(request, id);
    if (method === "DELETE") return unfollowUser(request, id);
  }

  if (resource === "events" && id === "track" && method === "POST") return track(request);
  if (resource === "feedback" && id === "items") {
    if (!action && method === "GET") return listFeedbackItems(request);
    if (!action && method === "POST") return createFeedbackItem(request);
    if (action && child === "vote" && method === "POST") return voteFeedbackItem(request, action);
    if (action && child === "vote" && method === "DELETE") return unvoteFeedbackItem(request, action);
  }
  if (resource === "support" && id === "requests" && !action && method === "POST") {
    return submitSupportRequest(request);
  }
  if (resource === "feed") return feed(request, segments);
  if (resource === "community") return community(request, segments);
  if (resource === "creators" && id && !action && method === "GET") {
    return creatorProfile(request, id);
  }

  throw Errors.notFound("API route not found", { path: `/${segments.join("/")}` });
}

async function signup(request: Request) {
  const body = signupSchema.parse(await jsonBody(request));
  const ctx = await getAuthCtx(request);
  if (isReservedInternalEmail(body.email)) {
    throw Errors.badRequest("Email domain is reserved");
  }
  const existing = await prisma.user.findUnique({ where: { email: body.email } });
  if (existing) throw Errors.conflict("Email already registered");

  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
  const token = createSessionToken();
  const user = await prisma.$transaction(async (tx) => {
    const anonymousId = await claimableAnonymousId(tx, ctx.anonymousId);
    const created = await tx.user.create({
      data: {
        email: body.email,
        emailVerified: false,
        dataClass: registeredUserDataClass(body.email),
        name: body.name,
        displayName: body.name ?? body.email.split("@")[0],
        ...(anonymousId ? { anonymousId } : {}),
        accounts: {
          create: {
            providerId: credentialProvider,
            accountId: body.email,
            password: hashPassword(body.password),
          },
        },
        sessions: {
          create: {
            token,
            expiresAt,
          },
        },
        preferences: {
          create: {
            mutedTags: [],
            safeModeFlags: {},
            notificationSettings: {},
          },
        },
      },
    });
    await appendLedger(tx, created.id, 250, "signup_bonus", "signup");
    // Referral give/get: one share code can convert many invitees. Keep the
    // parent invite row (inviteeId=null) and append one conversion row per signup
    // so admin/progress views do not lose prior invitee attribution.
    if (body.ref) {
      const referral = await tx.referral.findFirst({
        where: { code: body.ref, inviteeId: null },
      });
      if (referral && referral.inviterId !== created.id) {
        const conversion = await tx.referral.create({
          data: {
            inviterId: referral.inviterId,
            inviteeId: created.id,
            code: referral.code,
            status: "completed",
            rewardStatus: "granted",
          },
        });
        await appendLedger(
          tx,
          created.id,
          REFERRAL_INVITEE_BONUS,
          "referral_bonus",
          conversion.id,
          `referral_invitee:${created.id}`,
        );
        await appendLedger(
          tx,
          referral.inviterId,
          REFERRAL_INVITER_REWARD,
          "referral_reward",
          created.id,
          `referral_inviter:${created.id}`,
        );
      }
    }
    await appendCanonicalMetricEvent(tx, {
      sourceEventId: `signup:${created.id}`,
      eventType: METRIC_PRODUCT_EVENTS.customerSignupCompleted,
      occurredAt: created.createdAt,
      userId: created.id,
      context: { source: "credential_signup" },
      payload: { userId: created.id },
    });
    return created;
  });

  await mergeAnonymous(user.id, ctx.anonymousId);
  await trackEvent("signup", { source: "api" }, { userId: user.id, anonymousId: ctx.anonymousId });

  const response = ok({
    user: userDTO(user),
    session: { expiresAt },
  });
  response.headers.append("set-cookie", sessionCookie(token, expiresAt));
  return response;
}

async function claimableAnonymousId(
  tx: Prisma.TransactionClient,
  anonymousId: string | undefined,
) {
  if (!anonymousId) return undefined;
  const owner = await tx.user.findUnique({
    where: { anonymousId },
    select: { id: true },
  });
  return owner ? undefined : anonymousId;
}

async function login(request: Request) {
  const body = loginSchema.parse(await jsonBody(request));
  const account = await prisma.account.findUnique({
    where: {
      providerId_accountId: {
        providerId: credentialProvider,
        accountId: body.email,
      },
    },
    include: { user: true },
  });

  if (!account || !verifyPassword(body.password, account.password)) {
    throw Errors.unauthorized("Invalid email or password");
  }

  if (account.user.status !== "active" || account.user.deletedAt) {
    throw Errors.forbidden("Account is not active");
  }

  const token = createSessionToken();
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
  await prisma.session.create({
    data: {
      userId: account.userId,
      token,
      expiresAt,
      userAgent: request.headers.get("user-agent"),
    },
  });
  await trackEvent("login", { source: "api" }, { userId: account.userId });

  const response = ok({
    user: userDTO(account.user),
    session: { expiresAt },
  });
  response.headers.append("set-cookie", sessionCookie(token, expiresAt));
  return response;
}

async function logout(request: Request) {
  const cookies = parseRequestCookies(request);
  const tokens = [cookies.get("idream_session"), cookies.get("idream_admin_session")].filter(
    (token): token is string => Boolean(token),
  );
  if (tokens.length) await prisma.session.deleteMany({ where: { token: { in: tokens } } });
  const response = empty();
  response.headers.append("set-cookie", clearSessionCookie());
  response.headers.append("set-cookie", clearAdminSessionCookie());
  return response;
}

async function me(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = ctx.userId
    ? await prisma.user.findUnique({ where: { id: ctx.userId } })
    : null;
  const [entitlements, balance, availability] = await Promise.all([
    ctx.userId ? entitlementMap(ctx.userId) : Promise.resolve({}),
    ctx.userId ? dreamcoinBalance(ctx.userId) : Promise.resolve(0),
    publicOfferAvailability(),
  ]);

  return ok({
    user: user ? userDTO(user) : null,
    anonymousId: ctx.anonymousId,
    ageGate: { accepted: ctx.ageGateAccepted },
    ageVerification: { status: ctx.ageVerificationStatus },
    entitlements: publicFeatureProjection(entitlements, availability),
    dreamcoins: { balance },
  });
}

async function acceptAgeGate(request: Request) {
  const body = ageGateSchema.parse(await jsonBody(request));
  const ctx = await getAuthCtx(request);
  const anonymousId = ctx.anonymousId ?? createAnonymousId();

  await prisma.ageGateAcceptance.create({
    data: {
      userId: ctx.userId,
      anonymousId,
      country: body.country,
      sourcePath: body.sourcePath,
      policyVersion: body.policyVersion,
    },
  });
  await trackEvent("age_gate_accepted", { sourcePath: body.sourcePath }, ctx);

  const response = ok({ accepted: true, anonymousId });
  response.headers.append("set-cookie", ageGateCookie());
  response.headers.append("set-cookie", anonymousCookie(anonymousId));
  return response;
}

async function ageVerificationStatus(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  return ok({ status: await currentAgeVerificationStatus(user.id) });
}

async function createAgeVerificationSession(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const result = await providers.ageVerification.createSession({ userId: user.id });
  if (!result.ok) throw Errors.internal(result.error.message, result.error);

  const verification = await prisma.ageVerification.create({
    data: {
      userId: user.id,
      provider: result.data.provider,
      providerVerificationId: result.data.providerVerificationId,
      status: result.data.status,
      metadata: {},
    },
  });

  return ok({ verification, url: result.data.url });
}

// SPEC (BackendFeatureSpec §5.1): identity-verification provider callback.
// INVARIANTS: idempotent by provider event id; applies the reported status to
// the user's latest age_verification exactly once.
async function ageVerificationWebhook(request: Request, provider: string) {
  const rawBody = await bodyText(request);
  const payload = parseJsonText(rawBody);
  const incomingEventId =
    request.headers.get("x-provider-event-id") ??
    (isRecord(payload) && typeof payload.providerEventId === "string"
      ? payload.providerEventId
      : cryptoRandomId("age_evt"));

  const parsed = await providers.ageVerification.parseWebhook({
    providerEventId: incomingEventId,
    payload,
    rawBody,
    signature:
      request.headers.get("x-age-verify-signature") ??
      request.headers.get("x-gocam-signature") ??
      request.headers.get("x-signature") ??
      undefined,
  });
  if (!parsed.ok) throw Errors.badRequest(parsed.error.message, parsed.error);

  const eventId = parsed.data.providerEventId;

  const already = await prisma.providerEvent.findUnique({
    where: { provider_providerEventId: { provider, providerEventId: eventId } },
  });
  if (already?.processedAt) return ok({ processed: false, idempotent: true });

  const event = await prisma.providerEvent.upsert({
    where: { provider_providerEventId: { provider, providerEventId: eventId } },
    update: { payload: toInputJson(payload) },
    create: {
      provider,
      providerEventId: eventId,
      type: "age.verification",
      payload: toInputJson(payload),
    },
  });

  const { userId, providerVerificationId, status } = parsed.data;
  if (userId || providerVerificationId) {
    const latest =
      userId
        ? await prisma.ageVerification.findFirst({
            where: { userId },
            orderBy: { createdAt: "desc" },
          })
        : await prisma.ageVerification.findFirst({
            where: { providerVerificationId },
            orderBy: { createdAt: "desc" },
          });
    const verifiedAt = status === "verified" ? new Date() : null;
    if (latest) {
      await prisma.ageVerification.update({
        where: { id: latest.id },
        data: { status, provider, providerVerificationId, verifiedAt },
      });
    } else if (userId) {
      await prisma.ageVerification.create({
        data: { userId, provider, providerVerificationId, status, verifiedAt, metadata: {} },
      });
    }
  }

  await prisma.providerEvent.update({
    where: { id: event.id },
    data: { processedAt: new Date() },
  });
  return ok({ processed: true });
}

async function listCharacters(request: Request) {
  const ctx = await getAuthCtx(request);
  requireAgeGate(ctx);
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const tags = url.searchParams.getAll("tags").flatMap((value) => value.split(",")).filter(Boolean);
  const limit = clampInt(url.searchParams.get("limit"), 1, 60, 28);
  const cursor = decodeCursor(url.searchParams.get("cursor"));
  const sort = exploreSort(url.searchParams.get("sort"));
  const mutedTagSlugs = ctx.userId ? await mutedTagSlugsForUser(ctx.userId) : [];
  const gender = publicCharacterEnumFilter(url.searchParams.get("gender"), [
    "female",
    "male",
    "trans",
  ]);
  const style = publicCharacterEnumFilter(url.searchParams.get("style"), [
    "realistic",
    "anime",
    "hybrid",
  ]);

  const where: Prisma.CharacterWhereInput = {
    AND: [
      publicCharacterAudienceWhere,
      {
        gender,
        style,
        age: {
          gte: intParam(url.searchParams.get("age_min")),
          lte: intParam(url.searchParams.get("age_max")),
        },
        tags:
          tags.length > 0
            ? {
                some: {
                  tag: {
                    slug: { in: tags.map(slugify) },
                  },
                },
              }
            : undefined,
        NOT:
          mutedTagSlugs.length > 0
            ? {
                tags: {
                  some: {
                    tag: {
                      slug: { in: mutedTagSlugs },
                    },
                  },
                },
              }
            : undefined,
      },
    ],
  };

  if (sort === "following") {
    if (!ctx.userId) {
      return ok({ items: [], nextCursor: null });
    }
    const followedCreatorIds = await communityFollowedCreatorIds(ctx.userId);
    if (followedCreatorIds.length === 0) {
      return ok({ items: [], nextCursor: null });
    }
    where.creatorId = { in: followedCreatorIds };
  }

  const nameFilter = nameMatch(q);
  if (nameFilter) {
    where.OR = [
      { name: nameFilter },
      { description: { contains: q.trim() } },
    ];
  }

  const characters = await prisma.character.findMany({
    where,
    include: characterInclude(ctx.userId),
    orderBy: exploreOrderBy(sort),
    skip: cursor,
    take: limit + 1,
  });

  const page = characters
    .slice(0, limit)
    .filter(hasPublicListReleaseManifestAuthority);
  return ok({
    items: page.map((character) => characterDTO(character, ctx.userId)),
    nextCursor: characters.length > limit ? encodeCursor(cursor + limit) : null,
  });
}

type ExploreSort = "for-you" | "popular" | "newest" | "following";

function exploreSort(value: string | null): ExploreSort {
  if (value === "popular" || value === "newest" || value === "following") return value;
  return "for-you";
}

function exploreOrderBy(sort: ExploreSort): Prisma.CharacterOrderByWithRelationInput[] {
  if (sort === "newest" || sort === "following") {
    return [{ createdAt: "desc" }, { id: "asc" }];
  }
  return [
    { stats: { chatsCount: "desc" } },
    { stats: { likesCount: "desc" } },
    { createdAt: "desc" },
    { id: "asc" },
  ];
}

function publicCharacterEnumFilter<T extends string>(value: string | null, allowed: readonly T[]) {
  if (!value || value === "any") return undefined;
  return allowed.includes(value as T) ? (value as T) : undefined;
}

async function getCharacter(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  requireAgeGate(ctx);
  const character = await prisma.character.findFirst({
    where: {
      id,
      deletedAt: null,
      OR: [
        publicCharacterAudienceWhere,
        ctx.userId ? { creatorId: ctx.userId } : {},
      ].filter((item) => Object.keys(item).length > 0),
    },
    include: characterInclude(ctx.userId),
  });
  if (!character) throw Errors.notFound("Character not found");

  await trackEvent("character_viewed", { characterId: character.id }, ctx);
  return ok({ character: await characterDetailDTO(character, ctx.userId) });
}

async function listCharacterLooks(request: Request, characterId: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  await assertIdentityTargetCharacter(characterId, user.id);
  const items = await prisma.characterLook.findMany({
    where: { characterId, ownerId: user.id, status: { not: "archived" } },
    orderBy: { updatedAt: "desc" },
  });
  return ok({ items: items.map(characterLookDTO) });
}

async function createCharacterLook(request: Request, characterId: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const body = characterLookSchema.parse(await jsonBody(request));
  await assertIdentityTargetCharacter(characterId, user.id);
  if (body.referenceAssetId) await assertIdentityImageMedia(body.referenceAssetId, user.id);

  const look = await prisma.$transaction(async (tx) => {
    await lockCharacterGenerationAuthority(tx, characterId);
    await lockCharacterMediaAssetAuthorities(
      tx,
      body.referenceAssetId ? [body.referenceAssetId] : [],
    );
    const character = await assertIdentityTargetCharacterInTx(tx, characterId, user.id);
    if (body.referenceAssetId) {
      const referenceAsset = await assertIdentityImageMediaForCharacterInTx(
        tx,
        body.referenceAssetId,
        user.id,
        character.id,
        { allowUnassigned: false },
      );
      assertHydratableLookReferenceAsset(referenceAsset);
    }
    const visualProfile = await requireActiveVisualProfileInTx(tx, character.id);
    return persistCharacterLook(tx, {
      characterId,
      visualProfileId: visualProfile.id,
      ownerId: user.id,
      label: body.label,
      appearanceDelta: toInputJson(body.appearanceDelta),
      referenceAssetId: body.referenceAssetId ?? null,
    });
  });
  return ok({ look: characterLookDTO(look) }, { status: 201 });
}

async function updateCharacterLook(request: Request, characterId: string, lookId: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const body = characterLookPatchSchema.parse(await jsonBody(request));
  await assertIdentityTargetCharacter(characterId, user.id);
  if (body.referenceAssetId) await assertIdentityImageMedia(body.referenceAssetId, user.id);
  const look = await prisma.$transaction(async (tx) => {
    await lockCharacterGenerationAuthority(tx, characterId);
    const character = await assertIdentityTargetCharacterInTx(
      tx,
      characterId,
      user.id,
    );
    const located = await tx.characterLook.findFirst({
      where: {
        id: lookId,
        characterId,
        ownerId: user.id,
        status: { not: "archived" },
      },
    });
    if (!located) throw Errors.notFound("Character Look not found");
    const nextReferenceAssetId = body.referenceAssetId === undefined
      ? located.referenceAssetId
      : body.referenceAssetId;
    await lockCharacterMediaAssetAuthorities(
      tx,
      nextReferenceAssetId ? [nextReferenceAssetId] : [],
    );
    const current = await tx.characterLook.findFirst({
      where: {
        id: located.id,
        characterId,
        ownerId: user.id,
        status: { not: "archived" },
        updatedAt: located.updatedAt,
      },
    });
    if (!current) {
      throw Errors.conflict("Character Look changed before the update was applied");
    }
    if (nextReferenceAssetId) {
      const referenceAsset = await assertIdentityImageMediaForCharacterInTx(
        tx,
        nextReferenceAssetId,
        user.id,
        character.id,
        { allowUnassigned: false },
      );
      assertHydratableLookReferenceAsset(referenceAsset);
    }
    const activeProfile = await requireActiveVisualProfileInTx(tx, character.id);
    const nextStatus = body.status ?? current.status;
    const nextLabel = body.label ?? current.label;
    const nextAppearanceDelta = body.appearanceDelta
      ? toInputJson(body.appearanceDelta)
      : toInputJson(current.appearanceDelta);
    const requiresRebase = current.visualProfileId !== activeProfile.id;
    if (nextStatus === "active" && requiresRebase) {
      return persistCharacterLook(tx, {
        characterId,
        visualProfileId: activeProfile.id,
        ownerId: user.id,
        label: nextLabel,
        appearanceDelta: nextAppearanceDelta,
        referenceAssetId: nextReferenceAssetId,
        rebasedFromLookId: current.id,
      });
    }
    return tx.characterLook.update({
      where: { id: current.id },
      data: {
        label: body.label,
        appearanceDelta: body.appearanceDelta
          ? toInputJson(body.appearanceDelta)
          : undefined,
        referenceAssetId: body.referenceAssetId,
        status: body.status,
        activeKey:
          nextStatus === "active"
            ? characterLookActiveKey(user.id, characterId, nextLabel)
            : null,
      },
    });
  });
  return ok({ look: characterLookDTO(look) });
}

async function archiveCharacterLook(request: Request, characterId: string, lookId: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  await assertIdentityTargetCharacter(characterId, user.id);
  const updated = await prisma.$transaction(async (tx) => {
    await lockCharacterGenerationAuthority(tx, characterId);
    await assertIdentityTargetCharacterInTx(tx, characterId, user.id);
    const current = await tx.characterLook.findFirst({
      where: {
        id: lookId,
        characterId,
        ownerId: user.id,
        status: { not: "archived" },
      },
      select: { id: true, referenceAssetId: true, updatedAt: true },
    });
    if (!current) return { count: 0 };
    await lockCharacterMediaAssetAuthorities(
      tx,
      current.referenceAssetId ? [current.referenceAssetId] : [],
    );
    return tx.characterLook.updateMany({
      where: {
        id: current.id,
        characterId,
        ownerId: user.id,
        status: { not: "archived" },
        updatedAt: current.updatedAt,
      },
      data: { status: "archived", activeKey: null },
    });
  });
  if (updated.count === 0) throw Errors.notFound("Character Look not found");
  return empty();
}

async function likeCharacter(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  const [character, countsAsEngagement] = await Promise.all([
    prisma.character.findFirst({
      where: {
        AND: [
          publicCharacterAudienceWhere,
          { id },
        ],
      },
      select: { id: true },
    }),
    isCustomerEngagementActor(user.id),
  ]);
  if (!character) throw Errors.notFound("Character not found");
  await prisma.$transaction(async (tx) => {
    const created = await tx.characterLike.createMany({
      data: [{ userId: user.id, characterId: id }],
      skipDuplicates: true,
    });
    if (created.count > 0 && countsAsEngagement) {
      await tx.characterStats.upsert({
        where: { characterId: id },
        update: { likesCount: { increment: 1 } },
        create: { characterId: id, likesCount: 1 },
      });
    }
  });
  return ok({ liked: true });
}

async function unlikeCharacter(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const countsAsEngagement = await isCustomerEngagementActor(user.id);
  const deleted = await prisma.characterLike.deleteMany({
    where: { userId: user.id, characterId: id },
  });
  if (deleted.count > 0 && countsAsEngagement) {
    await prisma.characterStats.updateMany({
      where: { characterId: id, likesCount: { gt: 0 } },
      data: { likesCount: { decrement: 1 } },
    });
  }
  return ok({ liked: false });
}

async function listTags(request: Request) {
  const ctx = await getAuthCtx(request);
  const mutedTagSlugs = new Set(ctx.userId ? await mutedTagSlugsForUser(ctx.userId) : []);
  const tags = await prisma.tag.findMany({
    include: {
      _count: {
        select: {
          characters: {
            where: {
              character: publicCharacterAudienceWhere,
            },
          },
        },
      },
    },
    orderBy: [{ category: "asc" }, { label: "asc" }],
  });
  return ok({
    items: tags.map(({ _count, ...tag }) => ({
      ...tag,
      isMutedByUser: mutedTagSlugs.has(tag.slug),
      publicCharacterCount: _count.characters,
    })),
  });
}

async function suggest(request: Request) {
  const ctx = await getAuthCtx(request);
  requireAgeGate(ctx);
  const q = new URL(request.url).searchParams.get("q") ?? "";
  const normalized = q.trim();
  if (!normalized) return ok({ characters: [], tags: [], routes: [] });
  const mutedTagSlugs = ctx.userId ? await mutedTagSlugsForUser(ctx.userId) : [];

  const [characters, tags] = await Promise.all([
    prisma.character.findMany({
      where: {
        AND: [
          publicCharacterAudienceWhere,
          {
            name: { contains: normalized },
            NOT:
              mutedTagSlugs.length > 0
                ? {
                    tags: {
                      some: {
                        tag: {
                          slug: { in: mutedTagSlugs },
                        },
                      },
                    },
                  }
                : undefined,
          },
        ],
      },
      include: characterInclude(ctx.userId),
      orderBy: exploreOrderBy("popular"),
      take: 8,
    }),
    prisma.tag.findMany({
      where: {
        isMutedByDefault: false,
        label: { contains: normalized },
        slug: mutedTagSlugs.length > 0 ? { notIn: mutedTagSlugs } : undefined,
      },
      orderBy: [{ category: "asc" }, { label: "asc" }],
      take: 8,
    }),
  ]);

  return ok({
    characters: characters.map((character) => characterDTO(character, ctx.userId)),
    routes: suggestRoutes(normalized, 6),
    tags,
  });
}

async function createDraft(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const body = draftCreateSchema.parse(await jsonBody(request));
  const draft = await prisma.characterDraft.create({
    data: {
      ownerId: user.id,
      gender: body.gender,
      style: body.style,
      name: body.name,
      appearance: {},
      hair: {},
      body: {},
      advancedDetails: {},
      tags: [],
    },
  });
  await trackEvent("character_create_started", { draftId: draft.id }, ctx);
  return ok({ draft });
}

async function updateDraft(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const body = draftPatchSchema.parse(await jsonBody(request));
  const currentDraft = await assertDraftOwner(id, user.id);
  const identityChanged =
    (body.name !== undefined && body.name !== currentDraft.name) ||
    (body.gender !== undefined && body.gender !== currentDraft.gender) ||
    (body.style !== undefined && body.style !== currentDraft.style) ||
    jsonFieldChanged(body.appearance, currentDraft.appearance) ||
    jsonFieldChanged(body.hair, currentDraft.hair) ||
    jsonFieldChanged(body.body, currentDraft.body) ||
    advancedDetailsIdentityChanged(body.advancedDetails, currentDraft.advancedDetails);

  const draft = await prisma.characterDraft.update({
    where: { id },
    data: {
      step: body.step,
      gender: body.gender,
      style: body.style,
      name: body.name,
      appearance: body.appearance ? toInputJson(body.appearance) : undefined,
      hair: body.hair ? toInputJson(body.hair) : undefined,
      body: body.body ? toInputJson(body.body) : undefined,
      advancedDetails: body.advancedDetails ? toInputJson(body.advancedDetails) : undefined,
      tags: body.tags ? toInputJson(body.tags.map(slugify)) : undefined,
      previewJobId: identityChanged ? null : undefined,
    },
  });

  return ok({ draft });
}

function jsonFieldChanged(next: Record<string, unknown> | undefined, current: unknown) {
  return next !== undefined && JSON.stringify(next) !== JSON.stringify(current ?? {});
}

const personaDetailFields = new Set([
  "description",
  "relationshipArchetype",
  "relationship",
  "personality",
  "tone",
  "backstory",
  "firstMessage",
  "exampleDialogue",
]);

function advancedDetailsIdentityChanged(
  next: Record<string, unknown> | undefined,
  current: unknown,
) {
  if (next === undefined) return false;
  const identityDetails = (value: unknown) =>
    Object.fromEntries(
      Object.entries(jsonRecord(value)).filter(([key]) => !personaDetailFields.has(key)),
    );
  return JSON.stringify(identityDetails(next)) !== JSON.stringify(identityDetails(current));
}

async function previewDraft(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const draft = await assertDraftOwner(id, user.id);
  const moderation = await moderateText(
    "character_draft",
    id,
    `${draft.name ?? ""} ${JSON.stringify(draft.advancedDetails)}`,
    "input",
  );
  if (moderation.status === "blocked") {
    throw Errors.forbidden("Draft failed safety checks", moderation);
  }

  const profile = await selectGenerationProfile(
    "image",
    undefined,
    {
      pinnedReferences: [],
      sourceImageAssetId: null,
      lookReferenceAssetId: null,
    },
    true,
    await entitlementMap(user.id),
  );
  const recipe = await selectRecipe("image", "character");
  const allowedOrientations = jsonStringArray(profile.allowedOrientations);
  const orientation = allowedOrientations.includes("4:5")
    ? "4:5"
    : (allowedOrientations[0] ?? "4:5");
  const dimensions = dimensionsForImageOrientation({
    orientation,
    defaultWidth: profile.defaultWidth,
    defaultHeight: profile.defaultHeight,
  });
  const prompt = [
    recipe.body,
    `${draft.style ?? "realistic"} portrait of an adult ${draft.gender ?? "female"} character`,
    draft.name ? `Character name: ${draft.name}` : null,
    `Appearance: ${JSON.stringify(draft.appearance ?? {})}`,
    `Hair: ${JSON.stringify(draft.hair ?? {})}`,
    `Body: ${JSON.stringify(draft.body ?? {})}`,
    `Details: ${JSON.stringify(draft.advancedDetails ?? {})}`,
    "single subject, clear face, identity reference portrait",
  ]
    .filter((part): part is string => Boolean(part))
    .join(". ");

  // Async: the generation service owns provider execution and blob persistence;
  // main only creates and settles the authoritative preview job.
  const job = await prisma.characterPreviewJob.create({
    data: {
      draftId: id,
      status: "queued",
      provider: "generation_service",
    },
  });
  await jobQueue.enqueue({
    queue: GEN_QUEUES.characterPreview,
    payload: toInputJson({
      version: 1,
      kind: "character.preview",
      requestId: `character-preview:${job.id}`,
      previewJobId: job.id,
      draftId: id,
      userId: user.id,
      prompt,
      negativePrompt: recipe.negativeBase,
      controls: {
        width: dimensions.width,
        height: dimensions.height,
        workflowKey: profile.workflowKey,
      },
      orientation,
      seed: `${id}:${job.id}`,
      model: profile.pipelineModel,
      outputPrefix: `preview/${job.id}/`,
    } satisfies CharacterPreviewGeneratePayload),
    dedupeKey: idempotencyKeys.characterPreview(job.id),
  });
  return ok({ previewJob: job });
}

// GET character-drafts/:id/preview — poll target for the async preview job.
// Returns the latest preview job for the draft, plus the asset once completed.
async function previewStatus(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  const draft = await assertDraftOwner(id, user.id);
  const job = await prisma.characterPreviewJob.findFirst({
    where: { draftId: draft.id },
    orderBy: { createdAt: "desc" },
  });
  if (!job) return ok({ previewJob: null, asset: null });
  if (job.status === "completed" && job.resultAssetId) {
    const asset = await prisma.mediaAsset.findUnique({ where: { id: job.resultAssetId } });
    return ok({ previewJob: job, asset: asset ? mediaDTO(asset) : null });
  }
  return ok({ previewJob: job, asset: null });
}

async function selectPreviewAnchor(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  await assertDraftOwner(id, user.id);
  const body = draftPreviewSelectSchema.parse(await jsonBody(request));
  const job = await prisma.characterPreviewJob.findFirst({
    where: {
      id: body.previewJobId,
      draftId: id,
      status: "completed",
      resultAssetId: { not: null },
    },
  });
  if (!job?.resultAssetId) {
    throw Errors.badRequest("Preview anchor must be a completed preview image");
  }
  const asset = await prisma.mediaAsset.findFirst({
    where: { id: job.resultAssetId, ownerId: user.id, deletedAt: null, type: "image" },
  });
  if (!asset) throw Errors.notFound("Preview anchor asset not found");
  assertNonSyntheticMediaAsset(
    asset,
    "Demo preview images cannot be used as a character identity",
  );
  const draft = await prisma.characterDraft.update({
    where: { id },
    data: { previewJobId: job.id },
  });
  return ok({ draft, previewJob: job, asset: mediaDTO(asset) });
}

async function submitDraft(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const body = draftSubmitSchema.parse(await jsonBody(request));
  const draft = await assertDraftOwner(id, user.id);
  if (!draft.name) throw Errors.badRequest("Draft name is required before submit");
  const draftName = draft.name;
  const advancedDetails = jsonRecord(draft.advancedDetails);
  const relationship =
    jsonNonBlankString(advancedDetails.relationshipArchetype) ??
    jsonNonBlankString(advancedDetails.relationship);

  const personaDescription =
    body.description ??
    jsonNonBlankString(advancedDetails.description);
  const description =
    personaDescription ??
    `Custom ${draft.style ?? "realistic"} companion created from the Ourdream creator.`;
  const style = draft.style ?? "realistic";
  const gender = draft.gender ?? "female";
  const missingPersonaFields = requiredCharacterPersonaFields({
    description: personaDescription,
    relationship,
    advancedDetails,
  });
  const moderation = await moderateText(
    "character_draft",
    id,
    `${draft.name} ${description} ${JSON.stringify(draft.advancedDetails)}`,
    "input",
  );
  if (moderation.status === "blocked") {
    throw Errors.forbidden("Character failed safety checks", moderation);
  }
  const selectedPreview = draft.previewJobId
    ? await prisma.characterPreviewJob.findFirst({
        where: {
          id: draft.previewJobId,
          draftId: draft.id,
          status: "completed",
          resultAssetId: { not: null },
        },
      })
    : null;
  if (!selectedPreview?.resultAssetId) {
    throw Errors.badRequest("Choose an identity image before publishing this character");
  }
  const anchorAssetId = selectedPreview.resultAssetId;
  const anchorAsset = await prisma.mediaAsset.findFirst({
    where: {
      id: anchorAssetId,
      ownerId: user.id,
      deletedAt: null,
      type: "image",
    },
  });
  if (!anchorAsset) {
    throw Errors.badRequest("The selected identity image is no longer available");
  }
  assertNonSyntheticMediaAsset(
    anchorAsset,
    "Demo preview images cannot be published as a character identity",
  );
  if (missingPersonaFields.length > 0) {
    throw Errors.badRequest("Complete the character persona before publishing", {
      missingFields: missingPersonaFields,
    });
  }
  const systemPrompt = buildCharacterSystemPrompt({
    name: draftName,
    age: body.age,
    description,
    relationship,
    style,
    gender,
    tags: jsonStringArray(draft.tags),
    appearance: draft.appearance,
    advancedDetails: draft.advancedDetails,
  });

  const character = await prisma.$transaction(async (tx) => {
    await lockCharacterMediaAssetAuthorities(tx, [anchorAssetId]);
    const lockedAnchorAsset = await assertIdentityImageMediaInTx(
      tx,
      anchorAssetId,
      user.id,
    );
    if (lockedAnchorAsset.characterId !== null) {
      throw Errors.conflict(
        "The selected identity image already belongs to another Character. Choose an unassigned image or clone it first.",
        {
          mediaAssetId: lockedAnchorAsset.id,
          mediaCharacterId: lockedAnchorAsset.characterId,
        },
      );
    }

    const created = await tx.character.create({
      data: {
        creatorId: user.id,
        name: draftName,
        age: body.age,
        description,
        systemPrompt,
        visibility: body.visibility,
        status: body.visibility === "public" ? "pending_review" : "approved",
        style,
        gender,
        relationship,
        imageAssetId: anchorAssetId,
        appearance: toInputJson(draft.appearance ?? {}),
        advancedDetails: toInputJson(draft.advancedDetails ?? {}),
      },
    });

    const claimedAnchor = await tx.mediaAsset.updateMany({
      where: {
        id: anchorAssetId,
        ownerId: user.id,
        deletedAt: null,
        type: "image",
        characterId: null,
      },
      data: { characterId: created.id },
    });
    if (claimedAnchor.count !== 1) {
      throw Errors.conflict(
        "The selected identity image changed while the Character was being created. Review the image and submit again.",
        {
          mediaAssetId: anchorAssetId,
          targetCharacterId: created.id,
        },
      );
    }
    const visualProfile = await tx.characterVisualProfile.create({
      data: characterVisualProfileCreateData({
        characterId: created.id,
        version: 1,
        status: "active",
        style,
        name: draftName,
        age: body.age,
        description,
        gender,
        appearance: draft.appearance,
        advancedDetails: draft.advancedDetails,
        anchorAssetIds: [anchorAssetId],
        createdFrom: "create_preview",
      }),
    });
    await createReferenceSetRevision(
      tx,
      visualProfile,
      "create_preview",
    );
    await tx.characterStats.create({ data: { characterId: created.id } });
    await tx.characterSubmission.create({
      data: {
        characterId: created.id,
        submitterId: user.id,
        status: body.visibility === "public" ? "pending" : "approved",
      },
    });

    return created;
  });

  // Input moderation already ran synchronously above (moderateText); no async pass.
  await trackEvent("character_created", { characterId: character.id }, ctx);
  return ok({ character });
}

async function updateDraftTags(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const body = z.object({ tags: z.array(z.string()).max(12) }).parse(await jsonBody(request));
  await assertDraftOwner(id, user.id);
  const draft = await prisma.characterDraft.update({
    where: { id },
    data: { tags: toInputJson(body.tags.map(slugify)) },
  });
  return ok({ draft });
}

async function generationConfig(request: Request) {
  const ctx = await getAuthCtx(request);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const entitlements = ctx.userId ? await entitlementMap(ctx.userId) : {};
  const balance = ctx.userId ? await dreamcoinBalance(ctx.userId) : 0;
  const [profiles, recipes, presets, videoEnabled] = await Promise.all([
    prisma.generationModelProfile.findMany({
      where: { status: "active", enabled: true },
      orderBy: [{ mode: "asc" }, { costMultiplier: "asc" }, { label: "asc" }],
    }),
    prisma.generationRecipe.findMany({
      where: { status: "active" },
      orderBy: [{ mode: "asc" }, { useCase: "asc" }, { version: "desc" }],
    }),
    prisma.generationPreset.findMany({
      where: {
        scope: { in: ["built_in", "community"] },
        status: "active",
        visibility: "public",
      },
      orderBy: [{ scope: "asc" }, { type: "asc" }, { label: "asc" }],
    }),
    featureFlagEnabled("video_gen"),
  ]);
  const imageBaseCost = await generationCost("image", 1);
  const videoBaseCost = videoEnabled ? await generationCost("video", 1) : null;

  const publicImageProfiles = await filterPublicTextToImageGenerationProfiles(
    profiles.filter((profile) => profile.mode === "image"),
  );
  const publicImageEditProfiles =
    await projectPublicImageEditGenerationProfiles(
      profiles.filter((profile) => profile.mode === "image"),
    );
  const executableVideoProfiles = profiles.filter(
    (profile) =>
      profile.mode === "video" && isExecutableGenerationProfile(profile),
  );
  const visibleImageProfiles = publicImageProfiles.filter((profile) =>
    profile.requiredEntitlement
      ? Boolean(entitlements[profile.requiredEntitlement])
      : true,
  );
  const visibleImageEditProfiles = publicImageEditProfiles.filter(
    ({ profile }) =>
      profile.requiredEntitlement
        ? Boolean(entitlements[profile.requiredEntitlement])
        : true,
  );
  const videoProfiles = executableVideoProfiles.filter((profile) =>
    profile.requiredEntitlement
      ? Boolean(entitlements[profile.requiredEntitlement])
      : true,
  );
  const imageRecipes = recipes.filter((recipe) => recipe.mode === "image");
  const videoRecipes = recipes.filter((recipe) => recipe.mode === "video");
  const defaultImageProfile = visibleImageProfiles[0];
  const imageAvailability = !defaultImageProfile
    ? {
        state: "unavailable" as const,
        reason:
          publicImageProfiles.length > 0
            ? ("entitlement_required" as const)
            : ("no_active_model" as const),
      }
    : !hasCompleteGenerationRecipeSet(imageRecipes)
      ? {
          state: "unavailable" as const,
          reason: "no_active_recipe" as const,
        }
      : { state: "available" as const };
  const videoAvailability = !videoEnabled
    ? {
        state: "unavailable" as const,
        reason: "feature_disabled" as const,
      }
    : videoProfiles.length === 0
      ? {
        state: "unavailable" as const,
        reason:
            executableVideoProfiles.length > 0
              ? ("entitlement_required" as const)
              : ("no_active_model" as const),
        }
      : !hasCharacterGenerationRecipe(videoRecipes)
        ? {
            state: "unavailable" as const,
            reason: "no_active_recipe" as const,
          }
        : { state: "available" as const };
  const availableImageProfile =
    imageAvailability.state === "available" ? defaultImageProfile : undefined;

  return ok({
    viewer: {
      authenticated: Boolean(ctx.userId),
      scope: ctx.userId
        ? `user:${ctx.userId}`
        : ctx.anonymousId
          ? `anonymous:${ctx.anonymousId}`
          : null,
    },
    entitlements: publicFeatureProjection(entitlements, {
      videoGeneration: videoAvailability.state === "available",
    }),
    dreamcoins: { balance },
    pricing: {
      image: {
        baseCost: imageBaseCost,
        maxCount: availableImageProfile?.maxCount ?? null,
      },
      video: {
        baseCost: videoBaseCost,
      },
    },
    image: {
      availability: imageAvailability,
      orientations: availableImageProfile
        ? supportedProfileOrientations(availableImageProfile.allowedOrientations)
        : [],
      models:
        imageAvailability.state === "available"
          ? visibleImageProfiles.map(profileConfigDTO)
          : [],
      editModels: visibleImageEditProfiles.map(
        ({ profile, referenceMode }) => ({
          ...profileConfigDTO(profile),
          referenceMode,
        }),
      ),
      recipes: imageRecipes.map(recipeConfigDTO),
    },
    video: {
      enabled: videoEnabled,
      availability: videoAvailability,
      requiredEntitlement: "video_generation",
      models:
        videoAvailability.state === "available"
          ? videoProfiles.map(profileConfigDTO)
          : [],
      recipes: videoRecipes.map(recipeConfigDTO),
    },
    presets: presets.map((preset) => ({
      id: preset.id,
      type: preset.type,
      scope: preset.scope,
      category: preset.category,
      label: preset.label,
      controls: preset.controls,
      visibility: preset.visibility,
    })),
  });
}

async function generationQuote(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const body = generationJobSchema.parse(await jsonBody(request));
  return generationQuoteForUser(user.id, body, "public_generator");
}

async function generationQuoteForUser(
  userId: string,
  body: GenerationCreateBody,
  profileSelectionAuthority: GenerationProfileSelectionAuthority,
  options: {
    source?: GenerationSource;
  } = {},
) {
  const plan = await resolveGenerationPlanForUser(userId, body, {
    source: options.source,
    profileSelectionAuthority,
    bootstrapVisualProfile: false,
  });
  const routeFingerprint = generationPlanRouteFingerprint(plan);
  const pricingAuthority = await resolveGenerationPricingAuthority(body.mode);
  const pricingFingerprint = generationPricingFingerprint(pricingAuthority);
  const costs = Array.from(
    { length: plan.profile.maxCount },
    (_, index) => {
      const outputCount = index + 1;
      return {
        outputCount,
        costDreamcoins: generationCostFromAuthority(
          pricingAuthority,
          outputCount,
          plan.profile.costMultiplier,
        ),
      };
    },
  );
  const balance = await dreamcoinBalance(userId);
  const orientations = jsonStringArray(plan.profile.allowedOrientations);
  const defaultOrientation = orientations[0];
  if (!defaultOrientation) {
    throw Errors.unavailable(
      "No executable orientation is configured for this generation route",
    );
  }

  return ok({
    quote: {
      mode: body.mode,
      profileId: plan.profile.profileKey,
      profileVersion: plan.profile.version,
      routeFingerprint,
      pricing: {
        ruleId: pricingAuthority.id,
        ruleKey: pricingAuthority.ruleKey,
        version: pricingAuthority.version,
        effectiveFrom:
          pricingAuthority.effectiveFrom?.toISOString() ?? null,
        fingerprint: pricingFingerprint,
      },
      orientations,
      defaultOrientation,
      maxCount: plan.profile.maxCount,
      costs,
      balance,
    },
  });
}

// SPEC: turn selected mode/background/pose/outfit preset ids into a descriptive prompt fragment.
// INTENT: presets are open to every tier (unlike custom prompt); only built-in or the user's
// own active presets or public community presets resolve, so a stranger's private
// id can't be injected. Empty when none selected.
async function resolvePresetPromptFragment(
  controls: {
    modePresetId?: string;
    backgroundPresetId?: string;
    posePresetId?: string;
    outfitPresetId?: string;
  },
  userId: string,
): Promise<string> {
  const ids = [
    controls.modePresetId,
    controls.backgroundPresetId,
    controls.posePresetId,
    controls.outfitPresetId,
  ].filter((id): id is string => Boolean(id));
  if (ids.length === 0) return "";
  const presets = await prisma.generationPreset.findMany({
    where: {
      id: { in: ids },
      status: "active",
      OR: [
        { scope: "built_in" },
        { scope: "community", visibility: "public" },
        { ownerId: userId },
      ],
    },
  });
  const fragments: string[] = [];
  for (const id of ids) {
    const preset = presets.find((item) => item.id === id);
    if (!preset) continue;
    const values = isRecord(preset.controls)
      ? Object.values(preset.controls)
          .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          .map((value) => value.trim())
      : [];
    fragments.push(values.length ? values.join(", ") : preset.label);
  }
  return fragments.join(", ");
}

async function createGenerationJob(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const body = generationJobSchema.parse(await jsonBody(request));
  const idempotencyKey = requireGenerationWriteIdempotencyKey(request);
  const requestFingerprint = generationWriteRequestFingerprint(
    "generation.create",
    body,
  );
  const existing = await findExistingGenerationJob(user.id, {
    idempotencyKey,
    requestFingerprint,
  });
  const job = existing ?? await (async () => {
    const source = await resolveFeedRemixGenerationSource(
      user.id,
      body,
      idempotencyKey,
    );
    return createGenerationJobForUser(user.id, body, {
      idempotencyKey,
      requestFingerprint,
      source,
      profileSelectionAuthority: "public_generator",
    });
  })();
  const queued = await prisma.generationJob.findUniqueOrThrow({
    where: { id: job.id },
    include: generationJobInclude(),
  });
  return ok(generationJobResponse(queued), { status: 202 });
}

type GenerationCreateBody = z.infer<typeof generationJobSchema>;

interface GenerationSource {
  sourceType: string;
  sourceId: string;
  sourceMeta?: Prisma.InputJsonValue;
}

function requireGenerationWriteIdempotencyKey(request: Request) {
  const value = request.headers.get("idempotency-key")?.trim();
  if (!value) {
    throw Errors.badRequest(
      "Idempotency-Key header is required for generation writes",
    );
  }
  if (value.length < 8 || value.length > 160) {
    throw Errors.badRequest(
      "Idempotency-Key must be between 8 and 160 characters",
    );
  }
  return value;
}

function generationWriteRequestFingerprint(
  commandType: "generation.create" | "media.variation.create",
  body: unknown,
  targetId?: string,
) {
  const semanticBody = isRecord(body)
    ? Object.fromEntries(
        Object.entries(body).filter(([key]) => key !== "quoteAuthority"),
      )
    : body;
  return canonicalJsonHash({
    schemaVersion: "generation-write-request-v1",
    commandType,
    targetId: targetId ?? null,
    body: semanticBody,
  });
}

function assertGenerationJobRequestFingerprint(
  job: Pick<GenerationJobRow, "id" | "momentSpec">,
  requestFingerprint?: string,
) {
  if (!requestFingerprint) return;
  const storedFingerprint = jsonRecord(job.momentSpec).requestFingerprint;
  // Jobs created before fingerprint binding remain replayable by their durable
  // user/idempotency tuple. Every new public generation write pins the hash.
  if (
    typeof storedFingerprint === "string" &&
    storedFingerprint !== requestFingerprint
  ) {
    throw Errors.conflict(
      "Idempotency-Key was already used for a different generation request",
      { generationJobId: job.id },
    );
  }
}

async function resolveFeedRemixGenerationSource(
  userId: string,
  body: GenerationCreateBody,
  idempotencyKey: string,
): Promise<GenerationSource | undefined> {
  const itemId = body.remixFeedItemId?.trim();
  if (!itemId) return undefined;
  if (body.freeplay || !body.characterId) {
    throw Errors.badRequest("Choose a feed character before remixing");
  }
  const character = await feedPublicCharacterByItemId(itemId);
  if (!character) throw Errors.notFound("Feed item not found");
  if (character.id !== body.characterId) {
    throw Errors.badRequest("Remix feed item does not match the selected character");
  }
  return {
    sourceType: "feed_remix",
    sourceId: `feed:${itemId}:user:${userId}:remix:${idempotencyKey}`,
    sourceMeta: toInputJson({
      feedItemId: itemId,
      sourceCharacterId: character.id,
      sourceCreatorId: character.creatorId,
      sourceCharacterName: character.name,
    }),
  };
}

interface GenerationPromptCharacter {
  id: string;
  imageAssetId: string | null;
  name: string;
  age: number;
  description: string;
  relationship: string | null;
  style: string | null;
  gender: string | null;
  appearance: Prisma.JsonValue;
  advancedDetails: Prisma.JsonValue;
}

interface GenerationVisualProfile {
  id: string;
  characterId: string;
  version: number;
  status: string;
  style: string;
  identityPrompt: string;
  negativeIdentityPrompt: string | null;
  anchorAssetIds: Prisma.JsonValue;
  referenceAssetIds: Prisma.JsonValue;
  defaultSeed: string | null;
  adapterRefs: Prisma.JsonValue;
}

type ReferenceSetWithReferences = Prisma.ReferenceSetRevisionGetPayload<{
  include: { references: true };
}>;

type CharacterVisualProfileSource = {
  id: string;
  name: string;
  age: number;
  description: string;
  style: string | null;
  gender: string | null;
  appearance: Prisma.JsonValue;
  advancedDetails: Prisma.JsonValue;
  imageAssetId?: string | null;
};

export function characterVisualProfileCreateData(input: {
  characterId: string;
  version: number;
  status: "draft" | "active" | "archived";
  style: string;
  name: string;
  age: number;
  description: string;
  gender: string;
  appearance: Prisma.JsonValue;
  advancedDetails: Prisma.JsonValue;
  anchorAssetIds: string[];
  referenceAssetIds?: string[];
  createdFrom: string;
}) {
  // traits 是唯一真源：先抽取，再把 identityPrompt/traitsHash 作为版本化派生缓存拼装出来
  // （见 identity-assembler.ts SPEC）。styleTraits 额外纳入 name/description——原
  // buildCharacterIdentityPrompt 需要它们拼标题行/details，纳入后 assembler 才是 traits 的纯函数。
  const faceTraits = extractVisualTraitRecord(input.appearance, "face");
  const hairTraits = extractVisualTraitRecord(input.appearance, "hair");
  const bodyTraits = extractVisualTraitRecord(input.appearance, "body");
  const signatureTraits = extractVisualTraitRecord(input.advancedDetails, "signature");
  const styleTraits = {
    style: input.style,
    gender: input.gender,
    age: String(input.age),
    name: input.name,
    description: input.description,
  };
  const traits: IdentityTraits = {
    face: toTraitRecord(faceTraits),
    hair: toTraitRecord(hairTraits),
    body: toTraitRecord(bodyTraits),
    signature: toTraitRecord(signatureTraits),
    style: toTraitRecord(styleTraits),
  };
  const { identityPrompt, traitsHash } = assembleIdentityPrompt(traits);
  const negativeIdentityPrompt =
    "different face, different hairstyle, different eye color, identity drift, inconsistent age presentation";
  return {
    characterId: input.characterId,
    version: input.version,
    status: input.status,
    style: input.style,
    identityPrompt,
    negativeIdentityPrompt,
    faceTraits: toInputJson(faceTraits),
    hairTraits: toInputJson(hairTraits),
    bodyTraits: toInputJson(bodyTraits),
    signatureTraits: toInputJson(signatureTraits),
    styleTraits: toInputJson(styleTraits),
    anchorAssetIds: toInputJson(input.anchorAssetIds),
    referenceAssetIds: toInputJson(input.referenceAssetIds ?? []),
    defaultSeed: `character:${input.characterId}:visual:${input.version}`,
    adapterRefs: toInputJson({
      identity: { traitsHash, assemblerVersion: IDENTITY_ASSEMBLER_VERSION, source: "derived" },
    }),
    immutableHash: characterVisualProfileSnapshotHash({
      version: input.version,
      style: input.style,
      identityPrompt,
      negativeIdentityPrompt,
      faceTraits,
      hairTraits,
      bodyTraits,
      signatureTraits,
      styleTraits,
      anchorAssetIds: input.anchorAssetIds,
      referenceAssetIds: input.referenceAssetIds ?? [],
    }),
    evidenceState: "candidate",
    createdFrom: input.createdFrom,
  };
}

export async function createActiveCharacterVisualProfileVersion(
  tx: Prisma.TransactionClient,
  character: CharacterVisualProfileSource,
  input: { createdFrom: string },
) {
  await lockCharacterGenerationAuthority(tx, character.id);
  await assertCharacterIdentityAuthorityMutable(tx, character.id);
  const active = await tx.characterVisualProfile.findFirst({
    where: { characterId: character.id, status: "active" },
    orderBy: { version: "desc" },
  });
  const activeReferenceAuthority = active
    ? await loadLockedGenerationReferenceAuthority(
        tx,
        character.id,
        active,
        "balanced",
      )
    : null;
  const inheritedReferences =
    activeReferenceAuthority?.referenceSetRevision?.references.map((reference) => ({
      mediaAssetId: reference.mediaAssetId,
      position: reference.position,
      role: reference.role,
      weight: reference.weight,
      selectionReason: reference.selectionReason,
    })) ?? [];
  const anchorAssetIds = inheritedReferences
    .filter((reference) =>
      reference.role === "primary_face" || reference.role === "identity_anchor"
    )
    .map((reference) => reference.mediaAssetId);
  const referenceAssetIds = inheritedReferences
    .filter((reference) =>
      reference.role !== "primary_face" && reference.role !== "identity_anchor"
    )
    .map((reference) => reference.mediaAssetId);
  if (active) {
    await tx.characterVisualProfile.updateMany({
      where: { characterId: character.id, status: "active" },
      data: { status: "archived" },
    });
  }
  const version = (active?.version ?? 0) + 1;
  const createdFrom =
    inheritedReferences.length === 0 &&
    (!active || active.createdFrom.startsWith("generation_bootstrap"))
      ? `generation_bootstrap:${input.createdFrom}`
      : input.createdFrom;
  const created = await tx.characterVisualProfile.create({
    data: characterVisualProfileCreateData({
      characterId: character.id,
      version,
      status: "active",
      style: character.style ?? "realistic",
      name: character.name,
      age: character.age,
      description: character.description,
      gender: character.gender ?? "female",
      appearance: character.appearance,
      advancedDetails: character.advancedDetails,
      anchorAssetIds,
      referenceAssetIds,
      createdFrom,
    }),
  });
  if (inheritedReferences.length > 0) {
    await createReferenceSetRevision(
      tx,
      created,
      `visual_profile_version:${input.createdFrom}`,
      inheritedReferences,
    );
  }
  if (active) {
    await tx.characterLook.updateMany({
      where: { visualProfileId: active.id, status: "active" },
      data: { status: "needs_rebase", activeKey: null },
    });
  }
  await invalidateCharacterDraftAssetPack(tx, character.id);
  return created;
}

function extractVisualTraitRecord(value: Prisma.JsonValue, preferredKey: string) {
  if (!isRecord(value)) return {};
  const direct = value[preferredKey];
  if (isRecord(direct)) return direct;
  return Object.fromEntries(
    Object.entries(value).filter(([, child]) =>
      ["string", "number", "boolean"].includes(typeof child),
    ),
  );
}

// Dedup lookup for generation jobs: idempotencyKey first, then (sourceType, sourceId).
// Shared by the cheap pre-check fast-path and the P2002 conflict fallback so both resolve
// a duplicate request to the SAME existing job.
async function findExistingGenerationJob(
  userId: string,
  options: {
    idempotencyKey?: string | null;
    requestFingerprint?: string;
    source?: GenerationSource;
  },
) {
  if (options.idempotencyKey) {
    const existing = await prisma.generationJob.findFirst({
      where: { userId, idempotencyKey: options.idempotencyKey },
    });
    if (existing) {
      assertGenerationJobRequestFingerprint(
        existing,
        options.requestFingerprint,
      );
      return existing;
    }
  }
  if (options.source) {
    const existing = await prisma.generationJob.findFirst({
      where: { sourceType: options.source.sourceType, sourceId: options.source.sourceId },
    });
    if (existing) {
      assertGenerationJobRequestFingerprint(
        existing,
        options.requestFingerprint,
      );
      return existing;
    }
  }
  return null;
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

async function resolveGenerationVisualProfile(
  character: GenerationPromptCharacter,
  requestedProfileId?: string,
  opts: {
    fallbackToActiveOnStale?: boolean;
    bootstrapIfMissing?: boolean;
  } = {},
): Promise<GenerationVisualProfile | null> {
  if (requestedProfileId) {
    const profile = await prisma.characterVisualProfile.findFirst({
      where: { id: requestedProfileId, characterId: character.id },
      orderBy: { version: "desc" },
    });
    if (!profile) {
      // Chat path (fallbackToActiveOnStale): async fire-and-forget, so a stale/unknown
      // passport id must never fail the image — fall back to whatever is active now.
      if (opts.fallbackToActiveOnStale) {
        return resolveActiveVisualProfile(character, {
          bootstrapIfMissing: opts.bootstrapIfMissing,
        });
      }
      throw Errors.notFound("Character visual profile not found");
    }
    if (profile.status === "archived") {
      if (opts.fallbackToActiveOnStale) {
        return resolveActiveVisualProfile(character, {
          bootstrapIfMissing: opts.bootstrapIfMissing,
        });
      }
      throw Errors.badRequest("Character visual profile is archived", { visualProfileId: requestedProfileId });
    }
    return profile;
  }

  return resolveActiveVisualProfile(character, {
    bootstrapIfMissing: opts.bootstrapIfMissing,
  });
}

async function resolveGenerationLook(
  userId: string,
  characterId: string | null,
  visualProfileId: string | null,
  lookId?: string,
) {
  if (!lookId) return null;
  if (!characterId || !visualProfileId) {
    throw Errors.badRequest("A Character Look requires character image generation");
  }
  const look = await prisma.characterLook.findFirst({
    where: { id: lookId, ownerId: userId, characterId, status: "active" },
    include: {
      referenceAsset: {
        select: {
          id: true,
          ownerId: true,
          characterId: true,
          type: true,
          deletedAt: true,
          safetyStatus: true,
          storageKey: true,
          url: true,
          metadata: true,
        },
      },
    },
  });
  if (!look) throw Errors.notFound("Character Look not found");
  if (look.visualProfileId !== visualProfileId) {
    throw Errors.badRequest("Character Look must be rebased to the active identity", {
      lookId,
      lookVisualProfileId: look.visualProfileId,
      activeVisualProfileId: visualProfileId,
    });
  }
  if (
    look.referenceAssetId &&
    (
      !look.referenceAsset ||
      look.referenceAsset.ownerId !== userId ||
      look.referenceAsset.characterId !== characterId ||
      look.referenceAsset.type !== "image" ||
      look.referenceAsset.deletedAt !== null ||
      look.referenceAsset.safetyStatus !== "passed" ||
      !isMediaAssetOperationalForAuthority(look.referenceAsset.metadata) ||
      !hasHydratableMediaBlobAuthority(look.referenceAsset)
    )
  ) {
    throw Errors.conflict(
      "Character Look reference is unavailable. Update or rebase the Look before generating.",
      {
        lookId: look.id,
        referenceAssetId: look.referenceAssetId,
      },
    );
  }
  return look;
}

async function assertGenerationLookAuthorityInTx(
  tx: Prisma.TransactionClient,
  input: {
    readonly look: Awaited<ReturnType<typeof resolveGenerationLook>>;
    readonly userId: string;
    readonly characterId: string;
    readonly visualProfileId: string;
  },
) {
  if (!input.look) return;
  await lockCharacterMediaAssetAuthorities(
    tx,
    input.look.referenceAssetId ? [input.look.referenceAssetId] : [],
  );
  const current = await tx.characterLook.findFirst({
    where: {
      id: input.look.id,
      ownerId: input.userId,
      characterId: input.characterId,
      visualProfileId: input.visualProfileId,
      status: "active",
      updatedAt: input.look.updatedAt,
    },
    include: {
      referenceAsset: {
        select: {
          id: true,
          ownerId: true,
          characterId: true,
          type: true,
          deletedAt: true,
          safetyStatus: true,
          storageKey: true,
          url: true,
          metadata: true,
        },
      },
    },
  });
  if (
    !current ||
    current.referenceAssetId !== input.look.referenceAssetId ||
    (
      current.referenceAssetId &&
      (
        !current.referenceAsset ||
        current.referenceAsset.ownerId !== input.userId ||
        current.referenceAsset.characterId !== input.characterId ||
        current.referenceAsset.type !== "image" ||
        current.referenceAsset.deletedAt !== null ||
        current.referenceAsset.safetyStatus !== "passed" ||
        !isMediaAssetOperationalForAuthority(current.referenceAsset.metadata) ||
        !hasHydratableMediaBlobAuthority(current.referenceAsset)
      )
    )
  ) {
    throw Errors.conflict(
      "Character Look authority changed or became unavailable before generation was pinned",
      {
        lookId: input.look.id,
        referenceAssetId: input.look.referenceAssetId,
      },
    );
  }
}

async function assertGenerationSourceImageAuthorityInTx(
  tx: Prisma.TransactionClient,
  input: {
    readonly sourceImageAssetId: string;
    readonly userId: string;
    readonly characterId: string | null;
  },
) {
  const source = await tx.mediaAsset.findFirst({
    where: {
      id: input.sourceImageAssetId,
      type: "image",
      deletedAt: null,
      safetyStatus: "passed",
      OR: [
        { ownerId: input.userId },
        ...(input.characterId ? [{ characterId: input.characterId }] : []),
      ],
    },
    select: {
      id: true,
      storageKey: true,
      url: true,
      metadata: true,
    },
  });
  if (
    !source ||
    !isMediaAssetOperationalForAuthority(source.metadata) ||
    !hasHydratableMediaBlobAuthority(source)
  ) {
    throw Errors.conflict(
      "Source image changed or became unavailable before generation was pinned",
      { sourceImageAssetId: input.sourceImageAssetId },
    );
  }
}

async function assertRetryGenerationReferenceAuthoritiesInTx(
  tx: Prisma.TransactionClient,
  input: {
    readonly referenceAssetIds: readonly string[];
    readonly characterId: string | null;
  },
) {
  if (input.referenceAssetIds.length === 0) return;
  if (!input.characterId) {
    throw Errors.conflict(
      "Pinned Character references cannot be retried without their Character authority",
      { referenceAssetIds: input.referenceAssetIds },
    );
  }
  const references = await tx.mediaAsset.findMany({
    where: {
      id: { in: [...input.referenceAssetIds] },
      characterId: input.characterId,
      type: "image",
      deletedAt: null,
      safetyStatus: "passed",
    },
    select: {
      id: true,
      storageKey: true,
      url: true,
      metadata: true,
    },
  });
  const usableReferenceIds = new Set(
    references
      .filter((reference) =>
        isMediaAssetOperationalForAuthority(reference.metadata) &&
        hasHydratableMediaBlobAuthority(reference)
      )
      .map((reference) => reference.id),
  );
  const unavailableReferenceAssetIds = input.referenceAssetIds.filter(
    (assetId) => !usableReferenceIds.has(assetId),
  );
  if (unavailableReferenceAssetIds.length > 0) {
    throw Errors.conflict(
      "Pinned Character references changed or became unavailable before retry",
      {
        characterId: input.characterId,
        unavailableReferenceAssetIds,
      },
    );
  }
}

async function resolveActiveVisualProfile(
  character: GenerationPromptCharacter,
  options: { bootstrapIfMissing?: boolean } = {},
): Promise<GenerationVisualProfile | null> {
  const legacyReleaseAuthority = await prisma.$transaction((tx) =>
    loadLockedLiveEditorialLegacyGenerationAuthority(tx, character.id)
  );
  if (legacyReleaseAuthority) {
    // A live editorial Release remains the current identity authority even if
    // an unpinned active profile happens to coexist.
    return null;
  }
  const active = await prisma.characterVisualProfile.findFirst({
    where: { characterId: character.id, status: "active" },
    orderBy: { version: "desc" },
  });
  if (active) return active;
  if (options.bootstrapIfMissing === false) return null;
  return bootstrapCharacterVisualProfile(character);
}

async function bootstrapCharacterVisualProfile(
  character: GenerationPromptCharacter,
): Promise<GenerationVisualProfile | null> {
  return prisma.$transaction(async (tx) => {
    await lockCharacterGenerationAuthority(tx, character.id);
    const active = await tx.characterVisualProfile.findFirst({
      where: { characterId: character.id, status: "active" },
      orderBy: { version: "desc" },
    });
    if (active) return active;
    await assertCharacterIdentityAuthorityMutable(tx, character.id);
    const profile = await tx.characterVisualProfile.create({
      data: characterVisualProfileCreateData({
        characterId: character.id,
        version: 1,
        status: "active",
        style: character.style ?? "realistic",
        name: character.name,
        age: character.age,
        description: character.description,
        gender: character.gender ?? "female",
        appearance: character.appearance,
        advancedDetails: character.advancedDetails,
        anchorAssetIds: [],
        createdFrom: "generation_bootstrap",
      }),
    });
    await invalidateCharacterDraftAssetPack(tx, character.id);
    return profile;
  });
}

type GenerationProfileSelectionAuthority =
  | "public_generator"
  | "public_image_edit"
  | "specialized";

async function resolveGenerationPlanForUser(
  userId: string,
  body: GenerationCreateBody,
  options: {
    source?: GenerationSource;
    fallbackToActiveOnStaleVisualProfile?: boolean;
    profileSelectionAuthority?: GenerationProfileSelectionAuthority;
    bootstrapVisualProfile?: boolean;
  } = {},
) {
  const entitlements = await entitlementMap(userId);
  const selectedModel = body.model ?? body.controls.model;
  if (body.mode === "video" && !entitlements.video_generation) {
    throw Errors.paymentRequired("Video generation requires Deluxe entitlement");
  }
  if (body.mode === "video" && !(await featureFlagEnabled("video_gen"))) {
    throw Errors.forbidden("Video generation is disabled");
  }
  const systemPromptSource = isTrustedGenerationPromptSource(
    options.source?.sourceType,
  );
  const freeCharacterMoment =
    body.mode === "image" && Boolean(body.characterId) && Boolean(body.prompt);
  if (
    (body.negativePrompt || (body.prompt && !freeCharacterMoment)) &&
    !systemPromptSource &&
    !entitlements.premium_controls
  ) {
    throw Errors.paymentRequired("Custom prompt controls require Premium");
  }
  const recipe = await selectRecipe(
    body.mode,
    body.characterId ? "character" : "freeplay",
  );
  const character = body.characterId
    ? body.mode === "video"
      ? await publishedGenerationVideoCharacter(body.characterId)
      : await generationCharacter(body.characterId, userId)
    : null;
  const consistencyMode = body.consistencyMode ?? "balanced";
  const visualProfile =
    body.mode === "image" && character
      ? await resolveGenerationVisualProfile(character, body.visualProfileId, {
          fallbackToActiveOnStale:
            options.fallbackToActiveOnStaleVisualProfile,
          bootstrapIfMissing: options.bootstrapVisualProfile !== false,
        })
      : null;
  const selectedLook = await resolveGenerationLook(
    userId,
    character?.id ?? null,
    visualProfile?.id ?? null,
    body.controls.lookId,
  );
  const requestedLookReferenceAssetId =
    selectedLook?.referenceAssetId ?? null;
  const explicitSourceImageAssetId = (
    body.controls as Record<string, unknown>
  ).sourceImageAssetId;
  const requestedSourceImageAssetId =
    typeof explicitSourceImageAssetId === "string"
      ? explicitSourceImageAssetId
      : body.mode === "video"
        ? character?.imageAssetId ?? null
        : null;
  const referenceRequirements =
    body.mode === "image" && character && visualProfile
      ? await generationReferenceRouteRequirements(visualProfile.id)
      : [];
  const hasRequestedSourceImage =
    typeof requestedSourceImageAssetId === "string";
  if (body.mode === "video" && !hasRequestedSourceImage) {
    throw Errors.conflict(
      "Image-to-video generation requires a Character with an available primary image",
      { characterId: character?.id ?? null },
    );
  }
  const requiresReferenceRouting =
    (
      body.mode === "image" &&
      (
        referenceRequirements.length > 0 ||
        hasRequestedSourceImage ||
        requestedLookReferenceAssetId !== null
      )
    ) ||
    (body.mode === "video" && hasRequestedSourceImage);
  const requirePublicTextToImageProfile =
    body.mode === "image" &&
    (
      !requiresReferenceRouting ||
      (
        options.profileSelectionAuthority === "public_generator" &&
        Boolean(selectedModel)
      )
    );
  const requirePublicImageEditProfile =
    body.mode === "image" &&
    options.profileSelectionAuthority === "public_image_edit" &&
    Boolean(selectedModel);
  const profile = requiresReferenceRouting
    ? await selectGenerationProfile(
        body.mode,
        selectedModel,
        {
          pinnedReferences: referenceRequirements,
          sourceImageAssetId: hasRequestedSourceImage
            ? requestedSourceImageAssetId
            : null,
          lookReferenceAssetId: requestedLookReferenceAssetId,
        },
        requirePublicTextToImageProfile,
        entitlements,
        requirePublicImageEditProfile,
      )
    : body.mode === "image"
      ? await selectGenerationProfile(
          body.mode,
          selectedModel,
          {
            pinnedReferences: [],
            sourceImageAssetId: null,
            lookReferenceAssetId: null,
          },
          requirePublicTextToImageProfile,
          entitlements,
          requirePublicImageEditProfile,
        )
      : await selectGenerationProfile(
          body.mode,
          selectedModel,
          undefined,
          false,
          entitlements,
        );
  if (
    profile.requiredEntitlement &&
    !entitlements[profile.requiredEntitlement]
  ) {
    throw Errors.paymentRequired("Selected model requires entitlement", {
      entitlement: profile.requiredEntitlement,
    });
  }

  const workflowDescriptor = await generationWorkflowDescriptor(
    profile.workflowKey ?? profile.pipelineModel,
  );
  if (
    hasRequestedSourceImage &&
    referenceRequirements.length === 0
  ) {
    assertGenerationProfileCanDispatchReferences({
      profile,
      workflowDescriptor,
      pinnedReferences: [],
      sourceImageAssetId: requestedSourceImageAssetId,
      lookReferenceAssetId: requestedLookReferenceAssetId,
    });
  }

  return {
    character,
    consistencyMode,
    entitlements,
    hasRequestedSourceImage,
    profile,
    recipe,
    referenceRequirements,
    requestedLookReferenceAssetId,
    requestedSourceImageAssetId,
    selectedLook,
    selectedModel,
    visualProfile,
    workflowDescriptor,
  };
}

function generationPlanRouteFingerprint(
  plan: Awaited<ReturnType<typeof resolveGenerationPlanForUser>>,
) {
  return createHash("sha256")
    .update(JSON.stringify({
      schemaVersion: "generation-plan-v1",
      mode: plan.profile.mode,
      profileId: plan.profile.profileKey,
      profileVersion: plan.profile.version,
      workflowKey:
        plan.profile.workflowKey ?? plan.profile.pipelineModel,
      workflowVersion:
        plan.workflowDescriptor?.version ?? null,
      workflowIdentity:
        plan.workflowDescriptor?.identity ?? null,
      recipeId: plan.recipe.recipeKey,
      recipeVersion: plan.recipe.version,
      characterId: plan.character?.id ?? null,
      visualProfileId: plan.visualProfile?.id ?? null,
      visualProfileVersion: plan.visualProfile?.version ?? null,
      referenceRequirements: plan.referenceRequirements,
      sourceImageAssetId:
        typeof plan.requestedSourceImageAssetId === "string"
          ? plan.requestedSourceImageAssetId
          : null,
      lookId: plan.selectedLook?.id ?? null,
      lookUpdatedAt: plan.selectedLook?.updatedAt.toISOString() ?? null,
      lookReferenceAssetId:
        plan.selectedLook?.referenceAssetId ?? null,
      allowedOrientations: jsonStringArray(
        plan.profile.allowedOrientations,
      ),
      maxCount: plan.profile.maxCount,
      costMultiplier: plan.profile.costMultiplier,
    }))
    .digest("hex");
}

function generationPricingFingerprint(
  authority: Awaited<ReturnType<typeof resolveGenerationPricingAuthority>>,
) {
  return createHash("sha256")
    .update(JSON.stringify({
      schemaVersion: "generation-pricing-v1",
      id: authority.id,
      ruleKey: authority.ruleKey,
      version: authority.version,
      baseCost: authority.baseCost,
      effectiveFrom: authority.effectiveFrom?.toISOString() ?? null,
      updatedAt: authority.updatedAt.toISOString(),
    }))
    .digest("hex");
}

async function createGenerationJobForUser(
  userId: string,
  body: GenerationCreateBody,
  options: {
    idempotencyKey?: string | null;
    requestFingerprint?: string;
    source?: GenerationSource;
    fallbackToActiveOnStaleVisualProfile?: boolean;
    profileSelectionAuthority?: GenerationProfileSelectionAuthority;
    requireQuoteAuthority?: boolean;
  } = {},
) {
  const preexisting = await findExistingGenerationJob(userId, options);
  if (preexisting) return preexisting;
  if (
    (
      options.profileSelectionAuthority === "public_generator" ||
      options.requireQuoteAuthority
    ) &&
    !body.quoteAuthority
  ) {
    throw Errors.conflict(
      "An exact generation quote is required before submitting.",
    );
  }

  const plan = await resolveGenerationPlanForUser(userId, body, {
    source: options.source,
    fallbackToActiveOnStaleVisualProfile:
      options.fallbackToActiveOnStaleVisualProfile,
    profileSelectionAuthority: options.profileSelectionAuthority,
    // A public write validates route, price, count, orientation, and balance
    // before a legacy Character bootstrap can create any row.
    bootstrapVisualProfile:
      options.profileSelectionAuthority !== "public_generator" &&
      !options.requireQuoteAuthority,
  });
  const {
    character,
    consistencyMode,
    entitlements,
    profile,
    recipe,
    requestedLookReferenceAssetId,
    requestedSourceImageAssetId,
    selectedLook,
    workflowDescriptor,
  } = plan;
  const lookSnapshot = selectedLook ? characterLookSnapshot(selectedLook) : null;
  const allowedOrientations = jsonStringArray(profile.allowedOrientations);
  const orientation =
    body.orientation ??
    body.controls.orientation ??
    allowedOrientations[0] ??
    "4:5";
  const pricingAuthority = await resolveGenerationPricingAuthority(body.mode);
  const pricingFingerprint = generationPricingFingerprint(pricingAuthority);
  const cost = generationCostFromAuthority(
    pricingAuthority,
    body.outputCount,
    profile.costMultiplier,
  );
  const routeFingerprint = generationPlanRouteFingerprint(plan);
  if (
    body.quoteAuthority &&
    (
      body.quoteAuthority.profileId !== profile.profileKey ||
      body.quoteAuthority.profileVersion !== profile.version ||
      body.quoteAuthority.routeFingerprint !== routeFingerprint ||
      body.quoteAuthority.pricingFingerprint !== pricingFingerprint ||
      body.quoteAuthority.outputCount !== body.outputCount ||
      body.quoteAuthority.costDreamcoins !== cost
    )
  ) {
    throw Errors.conflict(
      "Generation quote changed. Refresh the exact quote before submitting.",
      {
        quoted: body.quoteAuthority,
        current: {
          profileId: profile.profileKey,
          profileVersion: profile.version,
          routeFingerprint,
          pricingFingerprint,
          outputCount: body.outputCount,
          costDreamcoins: cost,
        },
      },
    );
  }
  if (body.outputCount > profile.maxCount) {
    throw Errors.badRequest("Output count exceeds selected model limit", {
      maxCount: profile.maxCount,
      profileId: profile.profileKey,
      profileVersion: profile.version,
    });
  }
  if (!allowedOrientations.includes(orientation)) {
    throw Errors.badRequest(
      "Orientation is unavailable for the selected generation route",
      {
        orientation,
        allowedOrientations,
        profileId: profile.profileKey,
        profileVersion: profile.version,
      },
    );
  }
  const availableBalance = await dreamcoinBalance(userId);
  if (availableBalance < cost) {
    throw Errors.paymentRequired("Insufficient DreamCoins", {
      required: cost,
      available: availableBalance,
    });
  }
  const acceptedQuoteAuthority = body.quoteAuthority
    ? {
        schemaVersion: "generation-quote-authority-v1",
        profileId: profile.profileKey,
        profileVersion: profile.version,
        routeFingerprint,
        pricing: {
          ruleId: pricingAuthority.id,
          ruleKey: pricingAuthority.ruleKey,
          version: pricingAuthority.version,
          effectiveFrom:
            pricingAuthority.effectiveFrom?.toISOString() ?? null,
          fingerprint: pricingFingerprint,
        },
        outputCount: body.outputCount,
        costDreamcoins: cost,
      }
    : null;

  let visualProfile = plan.visualProfile;
  if (
    (
      options.profileSelectionAuthority === "public_generator" ||
      options.requireQuoteAuthority
    ) &&
    body.mode === "image" &&
    character &&
    !visualProfile
  ) {
    visualProfile = await resolveGenerationVisualProfile(
      character,
      body.visualProfileId,
      { bootstrapIfMissing: true },
    );
  }
  const dimensions =
    body.mode === "image"
      ? dimensionsForImageOrientation({
          orientation,
          defaultWidth: profile.defaultWidth,
          defaultHeight: profile.defaultHeight,
        })
      : { width: profile.defaultWidth, height: profile.defaultHeight };
  const momentSpec = buildMomentSpec(
    body,
    options.source,
    options.requestFingerprint,
  );
  const seed = body.seed ?? visualProfile?.defaultSeed ?? null;
  const presetFragment = await resolvePresetPromptFragment(body.controls, userId);
  const prompt = buildGenerationPrompt({
    mode: body.mode,
    character,
    visualProfile,
    consistencyMode,
    userPrompt: body.prompt,
    presetFragment,
    lookFragment: selectedLook ? JSON.stringify(selectedLook.appearanceDelta) : "",
    sourceType: options.source?.sourceType,
  });
  const negativePrompt =
    body.mode === "image"
      ? imageNegativePrompt(
          body.negativePrompt ?? defaultImageNegativePrompt(recipe.negativeBase, options.source?.sourceType),
          visualProfile,
        )
      : (body.negativePrompt ?? null);

  // Create in a tx; if a concurrent writer (or a redelivered chat.image.requested for the
  // same attachment) committed the same idempotencyKey / (sourceType,sourceId) first, the
  // unique constraint throws P2002 — resolve to that existing job rather than a 500 / a
  // spurious chat.image.failed (handled below).
  const runCreateTx = () => prisma.$transaction(async (tx) => {
    let legacyReleaseAuthority:
      LegacyCharacterGenerationAuthority | null = null;
    if (options.source) {
      const existing = await tx.generationJob.findFirst({
        where: { sourceType: options.source.sourceType, sourceId: options.source.sourceId },
      });
      if (existing) {
        assertGenerationJobRequestFingerprint(
          existing,
          options.requestFingerprint,
        );
        return existing;
      }
    }
    if (character) {
      await lockCharacterGenerationAuthority(tx, character.id);
      const lockedCharacter = await tx.character.findFirst({
        where: {
          AND: [
            {
              id: character.id,
              deletedAt: null,
              age: { gte: 18 },
              status: "approved",
            },
            body.mode === "video"
              ? publicCharacterAudienceWhere
              : {
                  OR: [
                    { creatorId: userId },
                    publicCharacterAudienceWhere,
                  ],
                },
          ],
        },
        select: { id: true },
      });
      if (!lockedCharacter) {
        throw Errors.conflict(
          "Character changed before generation authority could be reserved",
          { characterId: character.id },
        );
      }
      if (body.mode === "image") {
        const lockedLegacyReleaseAuthority =
          await loadLockedLiveEditorialLegacyGenerationAuthority(
            tx,
            character.id,
          );
        if (lockedLegacyReleaseAuthority && visualProfile) {
          throw Errors.conflict(
            "Character Release authority changed after generation identity was selected",
            { characterId: character.id },
          );
        }
        if (!lockedLegacyReleaseAuthority && !visualProfile) {
          throw Errors.conflict(
            "Legacy Character generation authority changed before the job could be queued",
            { characterId: character.id },
          );
        }
        legacyReleaseAuthority = lockedLegacyReleaseAuthority;
      }
    }
    const sourceImageAssetId =
      typeof requestedSourceImageAssetId === "string"
        ? requestedSourceImageAssetId
        : null;
    const additionalMediaAssetIds = [
      sourceImageAssetId,
      requestedLookReferenceAssetId,
    ].filter((assetId): assetId is string => Boolean(assetId));
    const referenceAuthority =
      visualProfile && character
        ? await loadLockedGenerationReferenceAuthority(
            tx,
            character.id,
            visualProfile,
            consistencyMode,
            additionalMediaAssetIds,
          )
        : null;
    if (!referenceAuthority) {
      await lockCharacterMediaAssetAuthorities(tx, additionalMediaAssetIds);
    }
    if (sourceImageAssetId) {
      await assertGenerationSourceImageAuthorityInTx(tx, {
        sourceImageAssetId,
        userId,
        characterId: character?.id ?? null,
      });
    }
    const referenceAssetIds =
      referenceAuthority?.referenceAssetIds ?? [];
    const referenceSetRevision = referenceAuthority?.referenceSetRevision ?? null;
    const referenceManifest =
      referenceAuthority?.referenceManifest ?? [];
    if (
      referenceAssetIds.length > 0 ||
      sourceImageAssetId ||
      requestedLookReferenceAssetId
    ) {
      assertGenerationProfileCanDispatchReferences({
        profile,
        workflowDescriptor,
        pinnedReferences: referenceManifest.map((reference) => ({
          assetId: reference.mediaAssetId,
          role: normalizedGenerationReferenceRole(reference.role),
        })),
        sourceImageAssetId,
        lookReferenceAssetId: requestedLookReferenceAssetId,
      });
    }
    if (selectedLook && character && visualProfile) {
      await assertGenerationLookAuthorityInTx(tx, {
        look: selectedLook,
        userId,
        characterId: character.id,
        visualProfileId: visualProfile.id,
      });
    }
    const controls = pruneUndefined({
      ...body.controls,
      orientation,
      model: profile.profileKey,
      profileId: profile.profileKey,
      generationProfileKey: profile.profileKey,
      generationProfileVersion: profile.version,
      workflowKey: workflowDescriptor?.workflowKey,
      workflowVersion: workflowDescriptor?.version,
      width: dimensions.width,
      height: dimensions.height,
      sourceImageAssetId: sourceImageAssetId ?? undefined,
      lookReferenceAssetId: requestedLookReferenceAssetId ?? undefined,
      workflowIdentity: workflowDescriptor?.identity,
      consistencyMode: visualProfile ? consistencyMode : undefined,
      generationQuoteAuthority: acceptedQuoteAuthority ?? undefined,
      legacyReleaseAuthority: legacyReleaseAuthority ?? undefined,
      visualIdentity: visualProfile
        ? {
            visualProfileId: visualProfile.id,
            visualProfileVersion: visualProfile.version,
            consistencyMode,
            referenceAssetIds,
            referenceSetRevisionId: referenceSetRevision?.id,
            referenceManifest,
            anchorAssetIds: referenceAuthority?.anchorAssetIds ?? [],
            seed,
          }
        : undefined,
    });
    await lockUserLedger(tx, userId);
    const balance = await dreamcoinBalance(userId, tx);
    if (balance < cost) {
      throw Errors.paymentRequired("Insufficient dreamcoins", {
        balance,
        cost,
        required: cost,
      });
    }
    const active = await tx.generationJob.count({
      where: { userId, status: { in: activeGenerationStatuses() } },
    });
    const max = maxInflightJobs(entitlements);
    if (active >= max) {
      throw Errors.rateLimited("Too many active generation jobs", { active, max });
    }

    const created = await tx.generationJob.create({
      data: {
        userId,
        characterId: body.characterId,
        visualProfileId: visualProfile?.id,
        visualProfileVersion: visualProfile?.version,
        consistencyMode: visualProfile ? consistencyMode : null,
        seed,
        referenceAssetIds: visualProfile ? toInputJson(referenceAssetIds) : undefined,
        referenceSetRevisionId: referenceSetRevision?.id,
        referenceManifest: referenceSetRevision ? toInputJson(referenceManifest) : undefined,
        momentSpec: toInputJson(momentSpec),
        lookId: selectedLook?.id,
        lookSnapshot: lookSnapshot ? toInputJson(lookSnapshot) : undefined,
        idempotencyKey: options.idempotencyKey,
        mode: body.mode,
        prompt,
        negativePrompt,
        controls: toInputJson(controls),
        presetIds: toInputJson(body.presetIds),
        model: profile.workflowKey ?? profile.pipelineModel,
        profileId: profile.profileKey,
        profileVersion: profile.version,
        recipeId: recipe.recipeKey,
        recipeVersion: recipe.version,
        orientation,
        outputCount: body.outputCount,
        status: "queued",
        costDreamcoins: cost,
        provider: profile.runner,
        sourceType: options.source?.sourceType ?? "generator",
        sourceId: options.source?.sourceId,
        sourceMeta: options.source?.sourceMeta,
      },
    });
    await appendGenerationEvent(tx, created.id, "created", "Generation job accepted", {
      mode: created.mode,
      profileId: created.profileId,
      recipeId: created.recipeId,
      visualProfileId: created.visualProfileId,
      visualProfileVersion: created.visualProfileVersion,
      referenceSetRevisionId: created.referenceSetRevisionId,
      consistencyMode: created.consistencyMode,
      idempotencyKey: options.idempotencyKey ?? null,
      sourceType: created.sourceType,
      sourceId: created.sourceId,
    });
    await appendLedger(
      tx,
      userId,
      -cost,
      "generation_spend",
      created.id,
      `generation:${created.id}:reserve`,
    );
    await appendGenerationEvent(tx, created.id, "reserved", "Dreamcoins reserved", {
      amount: cost,
    });
    await appendGenerationEvent(tx, created.id, "queued", "Generation job queued", {});
    return created;
  });

  let job: Awaited<ReturnType<typeof runCreateTx>>;
  try {
    job = await runCreateTx();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const existing = await findExistingGenerationJob(userId, options);
      if (existing) return existing;
    }
    throw error;
  }

  if (job.status !== "queued") return job;

  try {
    await enqueueGenerationJob(job);
  } catch (error) {
    await failQueuedGeneration(job, "queue_enqueue_failed", error);
    logger.error(
      { error, generationJobId: job.id },
      "generation job enqueue failed",
    );
    if (error instanceof AppError) throw error;
    throw Errors.internal("Generation queue unavailable", { jobId: job.id });
  }
  return job;
}

function isTrustedGenerationPromptSource(sourceType: string | undefined) {
  return sourceType === "chat_image" || sourceType === "media_variation";
}

export async function createChatImageGenerationJob(payload: ChatImageRequestedPayload) {
  const user = await prisma.user.findUnique({ where: { id: payload.userId } });
  if (!user || user.status !== "active" || user.deletedAt) {
    throw Errors.forbidden("User cannot generate images");
  }
  const prompt = buildChatImagePrompt(payload);
  const orientation = normalizeImageOrientation(payload.controls.orientation, "4:5");
  const sourceImageAssetId = payload.controls.sourceImageAssetId;
  return createGenerationJobForUser(
    payload.userId,
    {
      mode: "image",
      characterId: payload.characterId,
      freeplay: false,
      consistencyMode: "balanced",
      prompt,
      visualProfileId: payload.visualProfileId,
      // Explicit whitelist — never blind-spread payload.controls, it's an untrusted
      // passthrough bag from chat and could otherwise leak arbitrary keys into the job.
      controls: {
        orientation,
        ...(sourceImageAssetId ? { sourceImageAssetId } : {}),
      },
      presetIds: [],
      orientation,
      outputCount: payload.controls.outputCount,
      // A source-only edit is pinned to the dedicated img2img profile. Character
      // edits leave profile selection open so the complete identity + source
      // reference shape can select a compatible multi-reference workflow.
      // Explicit profile requests are fail-closed; source intent is never
      // silently discarded in favor of plain text-to-image generation.
      model:
        sourceImageAssetId && !payload.characterId
          ? "chat-image-edit"
          : undefined,
    },
    {
      idempotencyKey: idempotencyKeys.chatImage(payload.attachmentId),
      source: {
        sourceType: "chat_image",
        sourceId: payload.attachmentId,
        sourceMeta: toInputJson({
          sessionId: payload.sessionId,
          exchangeId: payload.exchangeId ?? null,
          messageId: payload.messageId,
          characterReleaseId: payload.characterReleaseId ?? null,
          promptHint: payload.promptHint,
          conversationContext: payload.conversationContext,
        }),
      },
      // Chat is async/fire-and-forget: a passport version that went stale (archived)
      // or vanished between chat's request and main's processing must never fail the
      // image — fall back to whatever profile is active now.
      fallbackToActiveOnStaleVisualProfile: true,
    },
  );
}

function buildChatImagePrompt(payload: ChatImageRequestedPayload) {
  const hint = payload.promptHint?.trim();
  return hint ? cleanPromptText(hint, 500) : "candid in-character photo";
}

function buildGenerationPrompt(input: {
  mode: "image" | "video";
  character: GenerationPromptCharacter | null;
  visualProfile: GenerationVisualProfile | null;
  consistencyMode: "balanced" | "strict" | "creative";
  userPrompt?: string;
  presetFragment: string;
  lookFragment: string;
  sourceType?: string;
}) {
  const userPrompt = cleanPromptText(input.userPrompt, 900);
  const base =
    input.mode === "image"
      ? buildImageGenerationPrompt({
          character: input.character,
          visualProfile: input.visualProfile,
          consistencyMode: input.consistencyMode,
          userPrompt,
          sourceType: input.sourceType,
        })
      : buildVideoGenerationPrompt(input.character, userPrompt);
  const preset = cleanPromptText(input.presetFragment, 500);
  const look = cleanPromptText(input.lookFragment, 500);
  return clampPrompt(
    [base, look ? `Active look: ${look}` : null, preset ? `Scene details: ${preset}` : null]
      .filter(Boolean)
      .join(". "),
    2_000,
  );
}

function buildImageGenerationPrompt(input: {
  character: GenerationPromptCharacter | null;
  visualProfile: GenerationVisualProfile | null;
  consistencyMode: "balanced" | "strict" | "creative";
  userPrompt: string;
  sourceType?: string;
}) {
  const request =
    input.userPrompt ||
    (input.sourceType === "chat_image"
      ? "candid in-character portrait shared from the current moment"
      : "natural in-character portrait");

  if (!input.character) {
    return clampPrompt(
      [
        "High quality original companion portrait",
        `Requested scene: ${request}`,
        "single coherent subject, expressive face, natural pose, well-lit face, properly exposed, sharp focus, detailed eyes, natural skin texture, clean composition",
      ].join(". "),
      2_000,
    );
  }

  const character = input.character;
  const visualProfile = input.visualProfile;
  const details = [
    cleanPromptText(character.description, 500),
    ...promptDetails(character.appearance, "Appearance"),
    ...promptDetails(character.advancedDetails, "Character detail"),
  ].filter(Boolean);
  const presentation = [
    "adult",
    cleanPromptText(character.gender, 80),
    cleanPromptText(character.style, 80),
  ].filter(Boolean);

  return clampPrompt(
    [
      `High quality in-character portrait photo of ${cleanPromptText(character.name, 120)}`,
      presentation.length ? `Subject: ${presentation.join(", ")}` : null,
      visualProfile
        ? `Locked identity: ${cleanPromptText(visualProfile.identityPrompt, 900)}`
        : details.length
          ? `Character: ${details.join("; ")}`
          : null,
      visualProfile ? consistencyPromptFragment(input.consistencyMode) : null,
      visualProfile && details.length ? `Character notes: ${details.join("; ")}` : null,
      `Requested scene: ${request}`,
      "single coherent subject, face and body matching the character, expressive eyes, natural pose, well-lit visible face, properly exposed, sharp focus, detailed skin and hair, clean photographic composition",
    ]
      .filter(Boolean)
      .join(". "),
    2_000,
  );
}

function consistencyPromptFragment(mode: "balanced" | "strict" | "creative") {
  if (mode === "strict") {
    return "Identity consistency: strict; preserve the same face, hairstyle, eye color, body type, and signature traits from the locked identity";
  }
  if (mode === "creative") {
    return "Identity consistency: creative; allow scene and styling variation while preserving the core face, hair, and signature traits";
  }
  return "Identity consistency: balanced; preserve the character identity while allowing the requested scene, pose, outfit, and lighting";
}

function imageNegativePrompt(base: string | null, visualProfile: GenerationVisualProfile | null) {
  const cleanBase = cleanPromptText(base, 900);
  const identityNegative = cleanPromptText(visualProfile?.negativeIdentityPrompt, 400);
  return [cleanBase, identityNegative].filter(Boolean).join(", ") || null;
}

function referenceSnapshotInputs(profile: GenerationVisualProfile) {
  const anchorIds = jsonStringArray(profile.anchorAssetIds);
  const anchorSet = new Set(anchorIds);
  const referenceIds = jsonStringArray(profile.referenceAssetIds).filter((id) => !anchorSet.has(id));
  return [
    ...anchorIds.map((mediaAssetId, index) => ({
      mediaAssetId,
      position: index,
      role: index === 0 ? "primary_face" : "identity_anchor",
      weight: index === 0 ? 1 : 0.9,
      selectionReason: index === 0 ? "primary_identity_anchor" : "supporting_identity_angle",
    })),
    ...referenceIds.map((mediaAssetId, index) => ({
      mediaAssetId,
      position: anchorIds.length + index,
      role: "identity_reference",
      weight: 0.75,
      selectionReason: "user_promoted_identity_reference",
    })),
  ];
}

async function loadLockedGenerationReferenceAuthority(
  tx: Prisma.TransactionClient,
  characterId: string,
  expectedProfile: GenerationVisualProfile,
  consistencyMode: "balanced" | "strict" | "creative",
  additionalMediaAssetIds: readonly string[] = [],
) {
  await lockCharacterGenerationAuthority(tx, characterId);
  const lockedCharacter = await tx.character.findFirst({
    where: {
      id: characterId,
      deletedAt: null,
    },
    select: { id: true },
  });
  if (!lockedCharacter) {
    throw Errors.conflict(
      "Character was archived before generation authority could be pinned",
      { characterId },
    );
  }
  const activeProfile = await tx.characterVisualProfile.findFirst({
    where: { characterId, status: "active" },
    orderBy: { version: "desc" },
  });
  if (
    !activeProfile ||
    activeProfile.id !== expectedProfile.id ||
    activeProfile.version !== expectedProfile.version
  ) {
    throw Errors.conflict(
      "Character identity changed before the generation job could pin its authority",
      { characterId },
    );
  }

  const bootstrapWithoutReferences =
    activeProfile.createdFrom.startsWith("generation_bootstrap") &&
    jsonStringArray(activeProfile.anchorAssetIds).length === 0 &&
    jsonStringArray(activeProfile.referenceAssetIds).length === 0;
  if (bootstrapWithoutReferences) {
    await lockCharacterMediaAssetAuthorities(tx, additionalMediaAssetIds);
    return {
      anchorAssetIds: [] as string[],
      referenceAssetIds: [] as string[],
      referenceManifest: [] as ReturnType<typeof referenceManifestFromRevision>,
      referenceSetRevision: null,
    };
  }

  const candidate = await tx.referenceSetRevision.findFirst({
    where: { visualProfileId: activeProfile.id, status: "active" },
    include: { references: { orderBy: { position: "asc" } } },
    orderBy: { revision: "desc" },
  });
  if (!candidate || candidate.references.length === 0) {
    throw Errors.conflict(
      "Character generation requires a complete active Reference Set",
      {
        characterId,
        visualProfileId: activeProfile.id,
      },
    );
  }
  await lockCharacterMediaAssetAuthorities(
    tx,
    [
      ...candidate.references.map((reference) => reference.mediaAssetId),
      ...additionalMediaAssetIds,
    ],
  );
  const referenceSetRevision = await tx.referenceSetRevision.findFirst({
    where: {
      visualProfileId: activeProfile.id,
      status: "active",
    },
    include: {
      references: {
        include: { mediaAsset: true },
        orderBy: { position: "asc" },
      },
    },
    orderBy: { revision: "desc" },
  });
  if (!referenceSetRevision || referenceSetRevision.id !== candidate.id) {
    throw Errors.conflict(
      "Character Reference Set changed before generation authority was pinned",
      { characterId, referenceSetRevisionId: candidate.id },
    );
  }
  const referenceAssetIds = referenceSetRevision.references.map(
    (reference) => reference.mediaAssetId,
  );
  if (
    new Set(referenceAssetIds).size !== referenceAssetIds.length ||
    referenceSetRevision.references.some(
      (reference, index) =>
        reference.position !== index ||
        reference.mediaAsset.deletedAt !== null ||
        reference.mediaAsset.type !== "image" ||
        reference.mediaAsset.safetyStatus !== "passed" ||
        !isMediaAssetOperationalForAuthority(reference.mediaAsset.metadata) ||
        !hasHydratableMediaBlobAuthority(reference.mediaAsset) ||
        reference.mediaAsset.characterId !== characterId,
    )
  ) {
    throw Errors.conflict(
      "Every Character reference must be unique, ordered, available, safety-passed, and owned by the exact Character",
      {
        characterId,
        referenceSetRevisionId: referenceSetRevision.id,
      },
    );
  }
  const computedSnapshotHash = referenceSetSnapshotHash(referenceSetRevision);
  if (
    !referenceSetRevision.snapshotHash ||
    referenceSetRevision.snapshotHash !== computedSnapshotHash
  ) {
    throw Errors.conflict(
      "Character Reference Set snapshot is not sealed to its current references",
      {
        characterId,
        referenceSetRevisionId: referenceSetRevision.id,
      },
    );
  }
  const referenceManifest = referenceManifestFromRevision(
    referenceSetRevision,
    consistencyMode,
  );
  return {
    anchorAssetIds: referenceSetRevision.references
      .filter((reference) =>
        reference.role === "primary_face" || reference.role === "identity_anchor"
      )
      .map((reference) => reference.mediaAssetId),
    referenceAssetIds,
    referenceManifest,
    referenceSetRevision,
  };
}

async function createReferenceSetRevision(
  tx: Prisma.TransactionClient,
  profile: GenerationVisualProfile,
  createdFrom: string,
  references = referenceSnapshotInputs(profile),
) {
  const proposedReferences = references;
  const existingAssets = await tx.mediaAsset.findMany({
    where: {
      id: { in: proposedReferences.map((reference) => reference.mediaAssetId) },
      deletedAt: null,
      type: "image",
      safetyStatus: "passed",
      characterId: profile.characterId,
    },
    select: { id: true, storageKey: true, url: true, metadata: true },
  });
  const existingAssetIds = new Set(existingAssets.map((asset) => asset.id));
  if (
    existingAssetIds.size !== proposedReferences.length ||
    proposedReferences.some((reference) => !existingAssetIds.has(reference.mediaAssetId)) ||
    existingAssets.some((asset) =>
      !isMediaAssetOperationalForAuthority(asset.metadata) ||
      !hasHydratableMediaBlobAuthority(asset)
    )
  ) {
    throw Errors.conflict(
      "Every Character reference must be available, safety-passed, and owned by the exact Character",
      { characterId: profile.characterId },
    );
  }
  const availableReferences = proposedReferences;
  const latest = await tx.referenceSetRevision.aggregate({
    where: { visualProfileId: profile.id },
    _max: { revision: true },
  });
  await tx.referenceSetRevision.updateMany({
    where: { visualProfileId: profile.id, status: "active" },
    data: { status: "superseded" },
  });
  return tx.referenceSetRevision.create({
    data: {
      visualProfileId: profile.id,
      revision: (latest._max.revision ?? 0) + 1,
      status: "active",
      selectorVersion: "v1",
      createdFrom,
      snapshotHash: referenceSetSnapshotHash({
        visualProfileId: profile.id,
        revision: (latest._max.revision ?? 0) + 1,
        selectorVersion: "v1",
        references: availableReferences,
      }),
      references: {
        create: availableReferences.map((reference) => ({
            ...reference,
            selectorVersion: "v1",
          })),
      },
    },
    include: { references: { orderBy: { position: "asc" } } },
  });
}

function referenceManifestFromRevision(
  revision: ReferenceSetWithReferences,
  consistencyMode?: "balanced" | "strict" | "creative",
) {
  return revision.references.map((reference) => ({
    mediaAssetId: reference.mediaAssetId,
    role: reference.role,
    weight: resolvedReferenceWeight(reference.role, reference.weight, consistencyMode),
    crop: reference.crop,
    qualityScore: reference.qualityScore,
    identityScore: reference.identityScore,
    selectorVersion: reference.selectorVersion,
    selectionReason: reference.selectionReason,
  }));
}

function resolvedReferenceWeight(
  role: string,
  baseWeight: number,
  mode?: "balanced" | "strict" | "creative",
) {
  if (!mode || mode === "balanced") return baseWeight;
  const anchor = role === "primary_face" || role === "identity_anchor";
  if (mode === "strict") return anchor ? 1.25 : 0.95;
  return anchor ? 0.65 : 0.45;
}

function buildMomentSpec(
  body: GenerationCreateBody,
  source?: GenerationSource,
  requestFingerprint?: string,
) {
  const controls = body.controls as Record<string, unknown>;
  const rawInput = cleanPromptText(body.prompt, 2_000) || "A natural in-character moment";
  const continuitySources: string[] = [];
  if (source?.sourceType === "chat_image") continuitySources.push("chat_context");
  if (body.prompt) continuitySources.push("user_prompt");
  if (typeof controls.lookId === "string") continuitySources.push("character_look");
  if (typeof controls.sourceImageAssetId === "string") continuitySources.push("source_image");
  if (continuitySources.length === 0) continuitySources.push("product_default");

  return pruneUndefined({
    schemaVersion: "1",
    parserVersion: "moment-direct-v1",
    requestFingerprint,
    rawInput,
    scene: rawInput,
    action: typeof controls.pose === "string" ? controls.pose : undefined,
    expression: typeof controls.expression === "string" ? controls.expression : undefined,
    outfitIntent: typeof controls.outfitPresetId === "string" ? "change" : "unspecified",
    outfit: typeof controls.outfit === "string" ? controls.outfit : undefined,
    locationContinuity:
      source?.sourceType === "chat_image" ? "continue" : "unspecified",
    camera: typeof controls.camera === "string" ? controls.camera : undefined,
    lighting: typeof controls.lighting === "string" ? controls.lighting : undefined,
    styleDelta: typeof controls.styleDelta === "string" ? controls.styleDelta : undefined,
    confidence: 1,
    continuitySources,
    createdAt: new Date().toISOString(),
  });
}

function buildVideoGenerationPrompt(character: GenerationPromptCharacter | null, userPrompt: string) {
  const subject = character?.name ? cleanPromptText(character.name, 120) : "an original companion";
  return clampPrompt(userPrompt || `Video generation for ${subject}`, 2_000);
}

function defaultImageNegativePrompt(templateNegative: string | null, sourceType?: string) {
  const base =
    cleanPromptText(templateNegative, 700) ||
    "low quality, distorted anatomy, extra fingers, watermark, text";
  const uiBlockers =
    "logo, user interface, app screen, phone screenshot, chat bubbles, buttons, icons, blurry, underexposed, silhouette, overly dark";
  return sourceType === "chat_image" ? `${base}, ${uiBlockers}` : `${base}, ${uiBlockers}`;
}

function promptDetails(value: Prisma.JsonValue, label: string) {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .flatMap(([key, raw]) => promptDetailValue(`${label}.${key}`, raw))
    .filter(Boolean)
    .slice(0, 8);
}

function promptDetailValue(key: string, value: unknown): string[] {
  const cleanKey = cleanPromptText(key.replace(/[_.]+/g, " "), 80);
  if (!cleanKey || /source\s*image/i.test(cleanKey)) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const cleanValue = cleanPromptText(String(value), 180);
    if (!cleanValue || /^https?:\/\//i.test(cleanValue) || cleanValue.startsWith("/")) return [];
    return [`${cleanKey}: ${cleanValue}`];
  }
  if (Array.isArray(value)) {
    const values = value
      .filter((item): item is string | number | boolean =>
        ["string", "number", "boolean"].includes(typeof item),
      )
      .map((item) => cleanPromptText(String(item), 120))
      .filter((item) => item && !/^https?:\/\//i.test(item) && !item.startsWith("/"))
      .slice(0, 5);
    return values.length ? [`${cleanKey}: ${values.join(", ")}`] : [];
  }
  if (isRecord(value)) {
    return Object.entries(value)
      .flatMap(([childKey, raw]) => promptDetailValue(`${key}.${childKey}`, raw))
      .slice(0, 8);
  }
  return [];
}

function cleanPromptText(value: string | null | undefined, max = 2_000) {
  const cleaned = value?.replace(/\s+/g, " ").trim() ?? "";
  return clampPrompt(cleaned, max);
}

function clampPrompt(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max - 3).trimEnd()}...`;
}

// SPEC: Cached TTS for one assistant chat turn. The client prewarms each completed
//       reply and the play button reuses the same endpoint and MediaAsset.
// INTENT: synchronous at this seam, but prewarming runs off the reply-rendering
//         path so text is never delayed by speech generation.
// INVARIANTS: prewarm uses included minutes only and never spends Dreamcoins
//         without a play action; character must be age>=18.
// EXAMPLE: POST /api/v1/generation/voice {characterId, messageId, text, intent}
//          → {assetId, contentUrl, durationMs}
const voiceClipSchema = z.object({
  characterId: z.string().min(1),
  messageId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  text: z.string().trim().min(1).max(2_000),
  intent: z.enum(["play", "prewarm"]).default("play"),
});

const voiceClipCacheVersion = 5;

async function createVoiceClip(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const body = voiceClipSchema.parse(await jsonBody(request));
  const prewarming = body.intent === "prewarm";

  // Release gate: a single flag fronts all voice traffic for controlled rollout /
  // kill-switch, mirroring video_gen.
  if (!(await featureFlagEnabled("voice_gen"))) {
    if (prewarming) return ok(voicePrewarmSkipped(body.messageId, "disabled"));
    throw Errors.forbidden("Voice generation is disabled");
  }

  const entitlements = await entitlementMap(user.id);
  if (entitlements.voice_enabled !== true) {
    if (prewarming) return ok(voicePrewarmSkipped(body.messageId, "not_entitled"));
    throw Errors.paymentRequired("Voice playback requires a plan with voice enabled", {
      entitlement: "voice_enabled",
    });
  }

  // Cache: a clip already synthesized for this message replays for free.
  const cacheWhere: Prisma.MediaAssetWhereInput = {
    ownerId: user.id,
    type: "voice",
    deletedAt: null,
    metadata: { path: ["messageId"], equals: body.messageId },
  };
  const cachedAssets = await prisma.mediaAsset.findMany({
    where: cacheWhere,
    orderBy: { createdAt: "desc" },
  });
  const cached = cachedAssets.find(isCurrentVoiceClip);
  if (cached) return ok(voiceClipResponse(cached));
  const hasStaleCachedClip = cachedAssets.length > 0;

  const character = await readableCharacter(body.characterId, user.id);
  if (character.age < 18) {
    throw Errors.badRequest("Character is not eligible for voice", { policyCode: "UNDERAGE" });
  }
  const tone = characterVoiceTone(character);

  const overflowCost = await voiceClipCost();
  const remainingBeforeSynthesis = await voiceMinutesRemainingMs(
    user.id,
    entitlements,
  );
  if (
    prewarming &&
    !hasStaleCachedClip &&
    remainingBeforeSynthesis <= 0
  ) {
    return ok(voicePrewarmSkipped(body.messageId, "allowance_exhausted"));
  }
  // Fast-fail only when the allowance is already exhausted. The authoritative
  // metering decision happens after synthesis because duration determines coverage.
  if (
    !prewarming &&
    !hasStaleCachedClip &&
    overflowCost > 0 &&
    remainingBeforeSynthesis <= 0 &&
    (await dreamcoinBalance(user.id)) < overflowCost
  ) {
    throw Errors.paymentRequired("Insufficient dreamcoins", {
      cost: overflowCost,
      required: overflowCost,
    });
  }

  const voiceAuthority = await resolveCharacterVoiceAuthority({
    voiceId: character.voiceId,
    gender: character.gender,
  });
  const result = await providers.voice.synthesize({
    text: body.text,
    voiceId: voiceAuthority.voiceId,
    tone,
  });
  if (!result.ok) throw Errors.internal("Voice synthesis failed", result.error);

  const mediaId = `media_${cryptoRandomId("voice")}`;
  // Debit + persist atomically under the per-user ledger lock. The lock also makes
  // the cache re-check race-free, so a concurrent double-click can neither create a
  // duplicate clip nor double-charge; a create failure rolls the charge back.
  let asset: Awaited<ReturnType<typeof prisma.mediaAsset.create>> | null = null;
  try {
    asset = await prisma.$transaction(async (tx) => {
      await lockUserLedger(tx, user.id);
      const racedAssets = await tx.mediaAsset.findMany({
        where: cacheWhere,
        orderBy: { createdAt: "desc" },
      });
      const raced = racedAssets.find(isCurrentVoiceClip);
      if (raced) return raced;
      const staleAssetIds = racedAssets.map((existingAsset) => existingAsset.id);
      const durationMs = Math.max(0, result.data.durationMs);
      const remainingMs = await voiceMinutesRemainingMs(user.id, entitlements, tx);
      const cost = staleAssetIds.length > 0 || remainingMs >= durationMs ? 0 : overflowCost;
      if (prewarming && cost > 0) return null;
      if (staleAssetIds.length > 0) {
        await tx.mediaAsset.updateMany({
          where: { id: { in: staleAssetIds } },
          data: { deletedAt: new Date() },
        });
      }
      if (cost > 0) {
        const balance = await dreamcoinBalance(user.id, tx);
        if (balance < cost) {
          throw Errors.paymentRequired("Insufficient dreamcoins", { balance, cost, required: cost });
        }
        await appendLedger(
          tx,
          user.id,
          -cost,
          "generation_spend",
          mediaId,
          `voice:${body.messageId}:spend`,
        );
      }
      return tx.mediaAsset.create({
        data: {
          id: mediaId,
          ownerId: user.id,
          characterId: character.id,
          type: "voice",
          url: `/api/v1/media/${mediaId}/content`,
          storageKey: result.data.key,
          contentType: voiceContentType(result.data.key),
          providerAssetId: result.data.key,
          prompt: body.text.slice(0, 500),
          visibility: "private",
          safetyStatus: "passed",
          metadata: toInputJson({
            cacheVersion: voiceClipCacheVersion,
            messageId: body.messageId,
            sessionId: body.sessionId ?? null,
            voiceId: voiceAuthority.voiceId,
            voiceAuthority: voiceAuthority.source,
            systemVoiceSettingVersion: voiceAuthority.settingVersion,
            tone,
            durationMs,
            providerKey: result.data.key,
            costDreamcoins: cost,
            generationIntent: prewarming ? "automatic" : "requested",
            replacedAssetIds: staleAssetIds,
          }),
        },
      });
    });
  } catch (cause) {
    await providers.blob.delete({ key: result.data.key });
    throw cause;
  }

  if (!asset) {
    await providers.blob.delete({ key: result.data.key });
    return ok(voicePrewarmSkipped(body.messageId, "allowance_exhausted"));
  }
  if (asset.id !== mediaId) {
    await providers.blob.delete({ key: result.data.key });
  }

  // 201 when we created the clip; 200 when a concurrent request beat us to it.
  return ok(voiceClipResponse(asset), { status: asset.id === mediaId ? 201 : 200 });
}

// Remaining voice milliseconds in the user's rolling 30-day window. The plan grants
// a `voice_minutes` allowance; consumed time is the sum of prior clip durations.
async function voiceMinutesRemainingMs(
  userId: string,
  entitlements: Record<string, Prisma.JsonValue>,
  db: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const allowanceMinutes =
    typeof entitlements.voice_minutes === "number" ? entitlements.voice_minutes : 0;
  if (allowanceMinutes <= 0) return 0;
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const clips = await db.mediaAsset.findMany({
    where: { ownerId: userId, type: "voice", deletedAt: null, createdAt: { gte: since } },
    select: { metadata: true },
  });
  const consumedMs = clips.reduce((sum, clip) => sum + voiceDurationMs(clip.metadata), 0);
  return Math.max(0, allowanceMinutes * 60_000 - consumedMs);
}

function voiceDurationMs(metadata: Prisma.JsonValue) {
  const record = jsonRecord(metadata);
  return typeof record.durationMs === "number" ? record.durationMs : 0;
}

function isCurrentVoiceClip(asset: { metadata: Prisma.JsonValue }) {
  const record = jsonRecord(asset.metadata);
  return record.cacheVersion === voiceClipCacheVersion;
}

function voiceContentType(key: string) {
  const ext = key.split(".").pop()?.toLowerCase();
  const byExt: Record<string, string> = {
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    flac: "audio/flac",
    webm: "audio/webm",
  };
  return (ext && byExt[ext]) ?? "audio/mpeg";
}

// Character-level default delivery. Per-message emotion can later override this.
function characterVoiceTone(character: {
  name: string;
  style: string;
  relationship: string | null;
}) {
  const relationship = character.relationship?.trim();
  const persona = relationship ? `the user's ${relationship}` : "a close companion";
  return `Speak as ${character.name}, ${persona}. Warm, intimate, expressive ${character.style} delivery.`;
}

async function voiceClipCost() {
  return generationCostDreamcoins("voice", 1, 1);
}

function voiceClipResponse(asset: { id: string; url: string; metadata: Prisma.JsonValue }) {
  const metadata = jsonRecord(asset.metadata);
  return {
    assetId: asset.id,
    contentUrl: asset.url,
    durationMs: typeof metadata.durationMs === "number" ? metadata.durationMs : 0,
    messageId: typeof metadata.messageId === "string" ? metadata.messageId : null,
  };
}

function voicePrewarmSkipped(
  messageId: string,
  reason: "allowance_exhausted" | "disabled" | "not_entitled",
) {
  return {
    messageId,
    prewarmed: false as const,
    reason,
  };
}

async function listGenerationJobs(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const mode = url.searchParams.get("mode");
  const limit = clampInt(url.searchParams.get("limit"), 1, 50, 20);
  const offset = decodeCursor(url.searchParams.get("cursor"));
  const jobs = await prisma.generationJob.findMany({
    where: {
      userId: user.id,
      mode: mode && mode !== "all" ? mode : undefined,
      status:
        status === "active"
          ? { in: activeGenerationStatuses() }
          : status
            ? status
            : undefined,
    },
    include: generationJobInclude(),
    orderBy: { createdAt: "desc" },
    skip: offset,
    take: limit + 1,
  });
  const page = jobs.slice(0, limit);
  return ok({
    items: page.map(generationJobDTO),
    nextCursor: jobs.length > limit ? encodeCursor(offset + limit) : null,
  });
}

async function getGenerationJob(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const job = await prisma.generationJob.findFirst({
    where: { id, userId: user.id },
    include: generationJobInclude(),
  });
  if (!job) throw Errors.notFound("Generation job not found");
  return ok(generationJobResponse(job));
}

function requireGenerationRetryIdempotencyKey(request: Request) {
  const value = request.headers.get("idempotency-key")?.trim();
  if (!value) {
    throw Errors.badRequest(
      "Idempotency-Key header is required for generation retry",
    );
  }
  if (value.length < 8 || value.length > 160) {
    throw Errors.badRequest(
      "Idempotency-Key must be between 8 and 160 characters",
    );
  }
  return value;
}

function assertGenerationJobIsRetryable(
  job: GenerationJobRow,
): asserts job is GenerationJobRow & { mode: "image" | "video" } {
  if (job.status === "blocked") {
    throw Errors.forbidden("Blocked generation jobs cannot be retried");
  }
  if (job.status !== "failed") {
    throw Errors.badRequest("Only failed generation jobs can be retried");
  }
  if (job.mode !== "image" && job.mode !== "video") {
    throw Errors.badRequest("Unsupported generation mode");
  }
}

async function resolveGenerationRetryAuthority(
  userId: string,
  job: GenerationJobRow & { mode: "image" | "video" },
) {
  const entitlements = await entitlementMap(userId);
  const controls = jsonRecord(job.controls);
  const retrySourceImageAssetId = stringFromRecord(
    controls,
    "sourceImageAssetId",
  );
  const retryLookReferenceAssetId =
    stringFromRecord(controls, "lookReferenceAssetId") ??
    stringFromRecord(jsonRecord(job.lookSnapshot), "referenceAssetId");
  const retryPinnedReferences = generationRequirementsFromManifest(
    job.referenceManifest,
  );
  const retryReferenceRequirements =
    job.mode === "image"
      ? {
          pinnedReferences: retryPinnedReferences,
          sourceImageAssetId: retrySourceImageAssetId ?? null,
          lookReferenceAssetId: retryLookReferenceAssetId ?? null,
        }
      : undefined;
  const exactProfiles =
    job.profileId && job.profileVersion !== null
      ? await prisma.generationModelProfile.findMany({
          where: {
            mode: job.mode,
            version: job.profileVersion,
            status: "active",
            enabled: true,
            OR: [
              { profileKey: job.profileId },
              { id: job.profileId },
            ],
          },
          take: 2,
        })
      : [];
  const exactProfile =
    exactProfiles.find(
      (candidate) => candidate.profileKey === job.profileId,
    ) ?? exactProfiles[0];
  const profile = exactProfile && isExecutableGenerationProfile(exactProfile)
    ? exactProfile
    : generationJobRequiresPinnedLegacyAuthority(job) &&
        !job.profileId &&
        job.profileVersion === null
      ? await selectGenerationProfile(
          job.mode,
          job.model ?? undefined,
          retryReferenceRequirements,
          false,
          entitlements,
        )
      : null;
  if (!profile) {
    throw Errors.conflict(
      "The failed generation job's pinned profile version is unavailable",
      {
        generationJobId: job.id,
        pinnedProfileId: job.profileId,
        pinnedProfileVersion: job.profileVersion,
        resolvedProfileId: null,
        resolvedProfileVersion: null,
      },
    );
  }
  if (generationJobRequiresPinnedLegacyAuthority(job)) {
    await prisma.$transaction((tx) =>
      assertPinnedLegacyCharacterGenerationAuthority(tx, {
        generationJobId: job.id,
        characterId: job.characterId!,
        controls: job.controls,
      })
    );
  }
  const workflowDescriptor = await generationWorkflowDescriptor(
    profile.workflowKey ?? profile.pipelineModel,
  );
  const pinnedWorkflowKey = stringFromRecord(controls, "workflowKey");
  const pinnedWorkflowVersion = numberFromRecord(
    controls,
    "workflowVersion",
  );
  if (
    (
      pinnedWorkflowKey !== undefined ||
      pinnedWorkflowVersion !== undefined
    ) &&
    (
      pinnedWorkflowKey !== workflowDescriptor?.workflowKey ||
      pinnedWorkflowVersion !== workflowDescriptor?.version
    )
  ) {
    throw Errors.conflict(
      "The failed generation job's pinned workflow version is unavailable",
      {
        generationJobId: job.id,
        pinnedWorkflowKey: pinnedWorkflowKey ?? null,
        pinnedWorkflowVersion: pinnedWorkflowVersion ?? null,
        resolvedWorkflowKey: workflowDescriptor?.workflowKey ?? null,
        resolvedWorkflowVersion: workflowDescriptor?.version ?? null,
      },
    );
  }
  if (
    job.mode === "image" &&
    (
      retryPinnedReferences.length > 0 ||
      retrySourceImageAssetId ||
      retryLookReferenceAssetId
    )
  ) {
    assertGenerationProfileCanDispatchReferences({
      profile,
      workflowDescriptor,
      pinnedReferences: retryPinnedReferences,
      sourceImageAssetId: retrySourceImageAssetId ?? null,
      lookReferenceAssetId: retryLookReferenceAssetId ?? null,
    });
  }
  if (
    profile.requiredEntitlement &&
    !entitlements[profile.requiredEntitlement]
  ) {
    throw Errors.paymentRequired("Selected model requires entitlement", {
      entitlement: profile.requiredEntitlement,
    });
  }
  const allowedOrientations = jsonStringArray(profile.allowedOrientations);
  if (
    job.outputCount > profile.maxCount ||
    job.orientation === null ||
    !allowedOrientations.includes(job.orientation)
  ) {
    throw Errors.conflict(
      "The failed generation job no longer fits its pinned retry route",
      {
        generationJobId: job.id,
        outputCount: job.outputCount,
        maxCount: profile.maxCount,
        orientation: job.orientation,
        allowedOrientations,
      },
    );
  }
  const pricingAuthority = await resolveGenerationPricingAuthority(job.mode);
  const pricingFingerprint =
    generationPricingFingerprint(pricingAuthority);
  const cost = generationCostFromAuthority(
    pricingAuthority,
    job.outputCount,
    profile.costMultiplier,
  );
  const retryReferenceAssetIds = [
    ...new Set([
      ...jsonStringArray(job.referenceAssetIds),
      ...retryPinnedReferences.map((reference) => reference.assetId),
    ]),
  ];
  const routeFingerprint = createHash("sha256")
    .update(JSON.stringify({
      schemaVersion: "generation-retry-plan-v1",
      generationJobId: job.id,
      generationJobVersion: job.version,
      mode: job.mode,
      profileId: profile.profileKey,
      profileVersion: profile.version,
      workflowKey:
        profile.workflowKey ?? profile.pipelineModel,
      workflowVersion: workflowDescriptor?.version ?? null,
      characterId: job.characterId,
      visualProfileId: job.visualProfileId,
      visualProfileVersion: job.visualProfileVersion,
      referenceSetRevisionId: job.referenceSetRevisionId,
      retryPinnedReferences,
      sourceImageAssetId: retrySourceImageAssetId ?? null,
      lookReferenceAssetId: retryLookReferenceAssetId ?? null,
      orientation: job.orientation,
      outputCount: job.outputCount,
      costMultiplier: profile.costMultiplier,
    }))
    .digest("hex");

  return {
    allowedOrientations,
    controls,
    cost,
    entitlements,
    pricingAuthority,
    pricingFingerprint,
    profile,
    retryLookReferenceAssetId,
    retryPinnedReferences,
    retryReferenceAssetIds,
    retrySourceImageAssetId,
    routeFingerprint,
    workflowDescriptor,
  };
}

async function generationRetryQuote(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const job = await prisma.generationJob.findFirst({
    where: { id, userId: user.id },
  });
  if (!job) throw Errors.notFound("Generation job not found");
  assertGenerationJobIsRetryable(job);
  const authority = await resolveGenerationRetryAuthority(user.id, job);
  const balance = await dreamcoinBalance(user.id);
  return ok({
    quote: {
      mode: job.mode,
      generationJobId: job.id,
      profileId: authority.profile.profileKey,
      profileVersion: authority.profile.version,
      routeFingerprint: authority.routeFingerprint,
      pricing: {
        ruleId: authority.pricingAuthority.id,
        ruleKey: authority.pricingAuthority.ruleKey,
        version: authority.pricingAuthority.version,
        effectiveFrom:
          authority.pricingAuthority.effectiveFrom?.toISOString() ?? null,
        fingerprint: authority.pricingFingerprint,
      },
      outputCount: job.outputCount,
      costDreamcoins: authority.cost,
      balance,
    },
  });
}

async function retryGenerationJob(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const retryIdempotencyKey = requireGenerationRetryIdempotencyKey(request);
  const job = await prisma.generationJob.findFirst({ where: { id, userId: user.id } });
  if (!job) throw Errors.notFound("Generation job not found");
  const replay = await prisma.generationJob.findFirst({
    where: {
      userId: user.id,
      idempotencyKey: retryIdempotencyKey,
    },
  });
  if (replay) {
    if (replay.derivedFromJobId !== job.id) {
      throw Errors.conflict(
        "Idempotency-Key was already used for a different generation request",
      );
    }
    const existing = await prisma.generationJob.findUniqueOrThrow({
      where: { id: replay.id },
      include: generationJobInclude(),
    });
    return ok(generationJobResponse(existing), { status: 202 });
  }
  assertGenerationJobIsRetryable(job);
  const body = z
    .object({
      quoteAuthority: generationQuoteAuthoritySchema.optional(),
    })
    .strict()
    .parse(await jsonBody(request));
  if (!body.quoteAuthority) {
    throw Errors.conflict(
      "An exact generation retry quote is required before retrying.",
    );
  }
  const authority = await resolveGenerationRetryAuthority(user.id, job);
  const {
    controls,
    cost,
    entitlements,
    pricingAuthority,
    pricingFingerprint,
    profile,
    retryLookReferenceAssetId,
    retryReferenceAssetIds,
    retrySourceImageAssetId,
    routeFingerprint,
    workflowDescriptor,
  } = authority;
  if (
    body.quoteAuthority.profileId !== profile.profileKey ||
    body.quoteAuthority.profileVersion !== profile.version ||
    body.quoteAuthority.routeFingerprint !== routeFingerprint ||
    body.quoteAuthority.pricingFingerprint !== pricingFingerprint ||
    body.quoteAuthority.outputCount !== job.outputCount ||
    body.quoteAuthority.costDreamcoins !== cost
  ) {
    throw Errors.conflict(
      "Generation retry quote changed. Refresh the exact quote before retrying.",
      {
        quoted: body.quoteAuthority,
        current: {
          profileId: profile.profileKey,
          profileVersion: profile.version,
          routeFingerprint,
          pricingFingerprint,
          outputCount: job.outputCount,
          costDreamcoins: cost,
        },
      },
    );
  }
  const availableBalance = await dreamcoinBalance(user.id);
  if (availableBalance < cost) {
    throw Errors.paymentRequired("Insufficient DreamCoins", {
      required: cost,
      available: availableBalance,
    });
  }
  const acceptedRetryQuoteAuthority = {
    schemaVersion: "generation-retry-quote-authority-v1",
    generationJobId: job.id,
    profileId: profile.profileKey,
    profileVersion: profile.version,
    routeFingerprint,
    pricing: {
      ruleId: pricingAuthority.id,
      ruleKey: pricingAuthority.ruleKey,
      version: pricingAuthority.version,
      effectiveFrom:
        pricingAuthority.effectiveFrom?.toISOString() ?? null,
      fingerprint: pricingFingerprint,
    },
    outputCount: job.outputCount,
    costDreamcoins: cost,
  };
  const reservation = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`generation-retry-idempotency:${user.id}:${retryIdempotencyKey}`}))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`generation-retry-authority:${job.id}`}))`;
    const lockedJob = await tx.generationJob.findFirst({
      where: { id: job.id, userId: user.id },
    });
    if (
      !lockedJob ||
      lockedJob.status !== "failed" ||
      lockedJob.version !== job.version
    ) {
      throw Errors.conflict(
        "Generation job changed before retry authority could be reserved",
        { generationJobId: job.id },
      );
    }
    const existingRetry = await tx.generationJob.findFirst({
      where: {
        userId: user.id,
        idempotencyKey: retryIdempotencyKey,
      },
    });
    if (existingRetry) {
      if (existingRetry.derivedFromJobId !== job.id) {
        throw Errors.conflict(
          "Idempotency-Key was already used for a different generation request",
        );
      }
      return { job: existingRetry, created: false } as const;
    }
    const retryCount = await tx.generationJob.count({
      where: { derivedFromJobId: job.id },
    });
    if (retryCount >= 3) {
      throw Errors.rateLimited("Retry limit reached for this generation job", {
        retries: retryCount,
        max: 3,
      });
    }
    if (job.characterId) {
      await lockCharacterGenerationAuthority(tx, job.characterId);
      const character = await tx.character.findFirst({
        where: {
          AND: [
            {
              id: job.characterId,
              deletedAt: null,
              age: { gte: 18 },
              status: "approved",
            },
            job.mode === "video"
              ? publicCharacterAudienceWhere
              : {
                  OR: [
                    { creatorId: user.id },
                    publicCharacterAudienceWhere,
                  ],
                },
          ],
        },
        select: { id: true },
      });
      if (!character) {
        throw Errors.conflict(
          "Character changed before retry authority could be reserved",
          { characterId: job.characterId },
        );
      }
      if (generationJobRequiresPinnedLegacyAuthority(lockedJob)) {
        await assertPinnedLegacyCharacterGenerationAuthority(tx, {
          generationJobId: lockedJob.id,
          characterId: lockedJob.characterId!,
          controls: lockedJob.controls,
        });
      }
    }
    await lockCharacterMediaAssetAuthorities(tx, [
      ...retryReferenceAssetIds,
      ...(retrySourceImageAssetId ? [retrySourceImageAssetId] : []),
      ...(retryLookReferenceAssetId ? [retryLookReferenceAssetId] : []),
    ]);
    await assertRetryGenerationReferenceAuthoritiesInTx(tx, {
      referenceAssetIds: retryReferenceAssetIds,
      characterId: job.characterId,
    });
    if (retrySourceImageAssetId) {
      await assertGenerationSourceImageAuthorityInTx(tx, {
        sourceImageAssetId: retrySourceImageAssetId,
        userId: user.id,
        characterId: job.characterId,
      });
    }
    if (retryLookReferenceAssetId) {
      await assertGenerationSourceImageAuthorityInTx(tx, {
        sourceImageAssetId: retryLookReferenceAssetId,
        userId: user.id,
        characterId: job.characterId,
      });
    }
    await lockUserLedger(tx, user.id);
    const balance = await dreamcoinBalance(user.id, tx);
    if (balance < cost) {
      throw Errors.paymentRequired("Insufficient dreamcoins", {
        balance,
        cost,
        required: cost,
      });
    }
    const active = await tx.generationJob.count({
      where: { userId: user.id, status: { in: activeGenerationStatuses() } },
    });
    const max = maxInflightJobs(entitlements);
    if (active >= max) {
      throw Errors.rateLimited("Too many active generation jobs", { active, max });
    }
    const created = await tx.generationJob.create({
      data: {
        userId: user.id,
        characterId: job.characterId,
        visualProfileId: job.visualProfileId,
        visualProfileVersion: job.visualProfileVersion,
        consistencyMode: job.consistencyMode,
        seed: job.seed,
        referenceAssetIds: job.referenceAssetIds === null ? undefined : job.referenceAssetIds,
        referenceSetRevisionId: job.referenceSetRevisionId,
        referenceManifest: job.referenceManifest === null ? undefined : job.referenceManifest,
        momentSpec: job.momentSpec === null ? undefined : job.momentSpec,
        lookId: job.lookId,
        lookSnapshot: job.lookSnapshot === null ? undefined : job.lookSnapshot,
        derivedFromJobId: job.id,
        idempotencyKey: retryIdempotencyKey,
        mode: job.mode,
        prompt: job.prompt,
        negativePrompt: job.negativePrompt,
        controls: toInputJson(pruneUndefined({
          ...controls,
          generationProfileKey: profile.profileKey,
          generationProfileVersion: profile.version,
          workflowKey: workflowDescriptor?.workflowKey,
          workflowVersion: workflowDescriptor?.version,
          workflowIdentity: workflowDescriptor?.identity,
          lookReferenceAssetId: retryLookReferenceAssetId,
          generationRetryQuoteAuthority:
            acceptedRetryQuoteAuthority,
        })),
        presetIds: toInputJson(jsonStringArray(job.presetIds)),
        model: profile.workflowKey ?? profile.pipelineModel,
        profileId: profile.profileKey,
        profileVersion: profile.version,
        recipeId: job.recipeId,
        recipeVersion: job.recipeVersion,
        orientation: job.orientation,
        outputCount: job.outputCount,
        status: "queued",
        costDreamcoins: cost,
        provider: profile.runner,
      },
    });
    await appendGenerationEvent(tx, created.id, "created", "Retry generation job accepted", {
      derivedFromJobId: job.id,
    });
    await appendLedger(
      tx,
      user.id,
      -cost,
      "generation_spend",
      created.id,
      `generation:${created.id}:reserve`,
    );
    await appendGenerationEvent(tx, created.id, "reserved", "Dreamcoins reserved", {
      amount: cost,
    });
    await appendGenerationEvent(tx, created.id, "queued", "Retry generation job queued", {});
    return { job: created, created: true } as const;
  });
  const retry = reservation.job;
  if (reservation.created) {
    try {
      await enqueueGenerationJob(retry);
    } catch (error) {
      await failQueuedGeneration(retry, "queue_enqueue_failed", error);
      logger.error(
        { error, generationJobId: retry.id },
        "generation retry enqueue failed",
      );
      if (error instanceof AppError) throw error;
      throw Errors.internal("Generation queue unavailable", {
        jobId: retry.id,
      });
    }
  }
  const queued = await prisma.generationJob.findUniqueOrThrow({
    where: { id: retry.id },
    include: generationJobInclude(),
  });
  return ok(generationJobResponse(queued), { status: 202 });
}

function generationJobRequiresPinnedLegacyAuthority(job: {
  readonly characterId: string | null;
  readonly controls: Prisma.JsonValue;
  readonly mode: string;
  readonly sourceType: string | null;
  readonly visualProfileId: string | null;
}) {
  return (
    job.mode === "image" &&
    job.characterId !== null &&
    job.visualProfileId === null &&
    (
      job.sourceType !== "content_production_item" ||
      legacyCharacterGenerationAuthorityFromControls(job.controls) !== null
    )
  );
}

async function listPresets(request: Request) {
  const url = new URL(request.url);
  const type = url.searchParams.get("type");
  const scope = url.searchParams.get("scope");
  const q = url.searchParams.get("q");
  const ctx = await getAuthCtx(request);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const items = await prisma.generationPreset.findMany({
    where: {
      status: "active",
      type: type ?? undefined,
      scope: scope ?? undefined,
      OR: ctx.userId
        ? [{ ownerId: ctx.userId }, { scope: { in: ["built_in", "community"] } }]
        : [{ scope: "built_in" }],
      label: q ? { contains: q } : undefined,
    },
    orderBy: [{ scope: "asc" }, { type: "asc" }, { label: "asc" }],
  });
  return ok({ items });
}

async function createPreset(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const body = presetCreateSchema.parse(await jsonBody(request));
  const preset = await prisma.generationPreset.create({
    data: {
      ownerId: user.id,
      scope: "user",
      type: body.type,
      category: body.category,
      label: body.label,
      controls: toInputJson(body.controls),
      visibility: body.visibility,
    },
  });
  return ok({ preset });
}

async function archivePreset(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  await prisma.generationPreset.updateMany({
    where: { id, ownerId: user.id },
    data: { status: "archived" },
  });
  return ok({ archived: true });
}

async function updatePreset(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const body = z
    .object({
      label: z.string().trim().min(1).max(80).optional(),
      category: z.string().max(80).optional(),
      controls: z.record(z.string(), z.unknown()).optional(),
      visibility: z.enum(["private", "public", "unlisted"]).optional(),
    })
    .parse(await jsonBody(request));
  // Owners edit their own presets; admins may also manage built-in/community presets.
  const where: Prisma.GenerationPresetWhereInput =
    user.role === "admin" ? { id } : { id, ownerId: user.id };
  const updated = await prisma.generationPreset.updateMany({
    where,
    data: {
      label: body.label,
      category: body.category,
      controls: body.controls ? toInputJson(body.controls) : undefined,
      visibility: body.visibility,
    },
  });
  if (updated.count === 0) throw Errors.notFound("Preset not found");
  const preset = await prisma.generationPreset.findUnique({ where: { id } });
  return ok({ preset });
}

async function listMedia(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const url = new URL(request.url);
  const liked = url.searchParams.get("liked") === "1";
  const type = url.searchParams.get("type");
  const visibility = url.searchParams.get("visibility");
  const limit = clampInt(url.searchParams.get("limit"), 1, 80, 40);
  const offset = decodeCursor(url.searchParams.get("cursor"));
  const assets = await prisma.mediaAsset.findMany({
    where: {
      ownerId: user.id,
      deletedAt: null,
      type: type ?? undefined,
      visibility: visibility ?? undefined,
      likes: liked ? { some: { userId: user.id } } : undefined,
    },
    include: {
      sourceJob: {
        select: {
          characterId: true,
          sourceType: true,
          sourceId: true,
          sourceMeta: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
    skip: offset,
    take: limit + 1,
  });
  const page = assets.slice(0, limit);
  const imageEditCharacterIds = [
    ...new Set(
      page
        .map((asset) => asset.characterId ?? asset.sourceJob?.characterId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const [editableCharacters, readableImageEditCharacters, activeImageProfiles] =
    await Promise.all([
      imageEditCharacterIds.length > 0
        ? prisma.character.findMany({
          where: {
            id: { in: imageEditCharacterIds },
            creatorId: user.id,
            deletedAt: null,
          },
          select: { id: true },
        })
        : [],
      imageEditCharacterIds.length > 0
        ? prisma.character.findMany({
          where: {
            id: { in: imageEditCharacterIds },
            deletedAt: null,
            status: "approved",
            age: { gte: 18 },
            OR: [
              publicCharacterAudienceWhere,
              { creatorId: user.id },
            ],
          },
          select: {
            id: true,
            visualProfiles: {
              where: { status: "active" },
              orderBy: { version: "desc" },
              take: 1,
              select: { id: true },
            },
          },
        })
        : [],
      prisma.generationModelProfile.findMany({
        where: { mode: "image", status: "active", enabled: true },
        orderBy: [
          { costMultiplier: "asc" },
          { version: "desc" },
        ],
      }),
    ]);
  const editableCharacterIds = new Set(
    editableCharacters.map((character) => character.id),
  );
  const imageEditReferenceRequirementsByCharacterId = new Map(
    await Promise.all(
      readableImageEditCharacters.map(async (character) => {
        const visualProfileId = character.visualProfiles[0]?.id;
        return [
          character.id,
          visualProfileId
            ? await generationReferenceRouteRequirements(visualProfileId)
            : [],
        ] as const;
      }),
    ),
  );
  const publicImageEditProfiles =
    await projectPublicImageEditGenerationProfiles(activeImageProfiles);
  const projectedItems = page.map((asset) => {
    const imageEditCharacterId =
      asset.characterId ?? asset.sourceJob?.characterId ?? null;
    const referenceRequirements = imageEditCharacterId
      ? imageEditReferenceRequirementsByCharacterId.get(imageEditCharacterId)
      : [];
    const imageEditModelIds =
      referenceRequirements === undefined
        ? []
        : publicImageEditProfiles.flatMap(
          ({ profile, workflowDescriptor }) =>
            generationProfileReferenceIncompatibilities({
              profile,
              workflowDescriptor,
              pinnedReferences: referenceRequirements,
              sourceImageAssetId: asset.id,
              lookReferenceAssetId: null,
            }).length === 0
              ? [profile.profileKey]
              : [],
        );
    return mediaDTO(asset, {
      editableCharacterIds,
      imageEditModelIds,
    });
  });
  return ok({
    items: projectedItems,
    nextCursor: assets.length > limit ? encodeCursor(offset + limit) : null,
  });
}

function mediaCollectionInclude(publicOnly = false) {
  const mediaAssetWhere: Prisma.MediaAssetWhereInput = {
    deletedAt: null,
    safetyStatus: "passed",
    ...(publicOnly
      ? {
          ...nonSyntheticMediaAssetWhere,
          visibility: { in: ["public_pack", "unlisted"] },
        }
      : {}),
  };
  return {
    items: {
      where: { mediaAsset: { is: mediaAssetWhere } },
      orderBy: { sortOrder: "asc" as const },
      take: 4,
      include: {
        mediaAsset: {
          select: {
            id: true,
            thumbnailUrl: true,
            url: true,
            storageKey: true,
            contentType: true,
            type: true,
            deletedAt: true,
            safetyStatus: true,
            visibility: true,
          },
        },
      },
    },
    owner: { select: { id: true, displayName: true, name: true } },
    _count: {
      select: {
        items: { where: { mediaAsset: { is: mediaAssetWhere } } },
      },
    },
  } satisfies Prisma.MediaCollectionInclude;
}

type MediaCollectionWithRelations = Prisma.MediaCollectionGetPayload<{
  include: ReturnType<typeof mediaCollectionInclude>;
}>;

async function listMediaCollections(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const collections = await prisma.mediaCollection.findMany({
    where: { ownerId: user.id },
    include: mediaCollectionInclude(),
    orderBy: { createdAt: "desc" },
  });
  return ok({ collections: collections.map(mediaCollectionDTO) });
}

async function createMediaCollection(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const body = mediaCollectionCreateSchema.parse(await jsonBody(request));
  const media = body.mediaAssetId ? await assertMediaOwner(body.mediaAssetId, user.id) : null;
  if (body.visibility === "public") {
    if (!media) {
      throw Errors.badRequest(
        "A public collection must contain at least one publishable media asset",
      );
    }
    assertPublicCollectionMediaAsset(media);
  }

  const collection = await prisma.$transaction(async (tx) => {
    const created = await tx.mediaCollection.create({
      data: {
        ownerId: user.id,
        name: body.name,
        visibility: body.visibility,
      },
    });
    if (media) {
      if (body.visibility === "public") {
        await tx.mediaAsset.update({
          where: { id: media.id },
          data: { visibility: "public_pack" },
        });
      }
      await tx.mediaCollectionItem.create({
        data: {
          collectionId: created.id,
          mediaAssetId: media.id,
          sortOrder: 0,
        },
      });
    }
    return tx.mediaCollection.findUniqueOrThrow({
      where: { id: created.id },
      include: mediaCollectionInclude(),
    });
  });

  await trackEvent("media_collection_created", {
    collectionId: collection.id,
    visibility: collection.visibility,
    mediaAssetId: media?.id ?? null,
  }, ctx);

  return ok({ collection: mediaCollectionDTO(collection) }, { status: 201 });
}

async function updateMediaCollection(request: Request, collectionId: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const body = mediaCollectionUpdateSchema.parse(await jsonBody(request));
  const existing = await prisma.mediaCollection.findFirst({
    where: { id: collectionId, ownerId: user.id },
    select: { id: true },
  });
  if (!existing) throw Errors.notFound("Collection not found");

  const collection = await prisma.$transaction(async (tx) => {
    if (body.visibility === "public") {
      const items = await tx.mediaCollectionItem.findMany({
        where: { collectionId },
        include: { mediaAsset: true },
      });
      if (items.length === 0) {
        throw Errors.badRequest(
          "A public collection must contain at least one publishable media asset",
        );
      }
      for (const item of items) {
        assertPublicCollectionMediaAsset(item.mediaAsset);
      }
      await tx.mediaAsset.updateMany({
        where: {
          ownerId: user.id,
          deletedAt: null,
          collections: { some: { collectionId } },
        },
        data: { visibility: "public_pack" },
      });
    }
    await tx.mediaCollection.update({
      where: { id: collectionId },
      data: {
        name: body.name,
        visibility: body.visibility,
      },
    });
    return tx.mediaCollection.findUniqueOrThrow({
      where: { id: collectionId },
      include: mediaCollectionInclude(),
    });
  });

  await trackEvent("media_collection_updated", {
    collectionId,
    visibility: body.visibility ?? collection.visibility,
  }, ctx);

  return ok({ collection: mediaCollectionDTO(collection) });
}

async function addMediaToCollection(request: Request, collectionId: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const body = mediaCollectionItemSchema.parse(await jsonBody(request));
  const [collection, media] = await Promise.all([
    prisma.mediaCollection.findFirst({
      where: { id: collectionId, ownerId: user.id },
      select: { id: true, visibility: true },
    }),
    assertMediaOwner(body.mediaAssetId, user.id),
  ]);
  if (!collection) throw Errors.notFound("Collection not found");

  const updated = await prisma.$transaction(async (tx) => {
    const sortOrder = await tx.mediaCollectionItem.count({ where: { collectionId } });
    if (collection.visibility === "public") {
      assertPublicCollectionMediaAsset(media);
      await tx.mediaAsset.update({
        where: { id: media.id },
        data: { visibility: "public_pack" },
      });
    }
    await tx.mediaCollectionItem.upsert({
      where: {
        collectionId_mediaAssetId: {
          collectionId,
          mediaAssetId: media.id,
        },
      },
      update: {},
      create: {
        collectionId,
        mediaAssetId: media.id,
        sortOrder,
      },
    });
    return tx.mediaCollection.findUniqueOrThrow({
      where: { id: collectionId },
      include: mediaCollectionInclude(),
    });
  });

  await trackEvent("media_collection_item_added", {
    collectionId,
    mediaAssetId: media.id,
  }, ctx);

  return ok({ collection: mediaCollectionDTO(updated) });
}

async function likeMedia(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  await assertMediaOwner(id, user.id);
  await prisma.mediaLike.upsert({
    where: { userId_mediaAssetId: { userId: user.id, mediaAssetId: id } },
    update: {},
    create: { userId: user.id, mediaAssetId: id },
  });
  await prisma.mediaAsset.update({ where: { id }, data: { liked: true } });
  return ok({ liked: true });
}

async function unlikeMedia(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  await prisma.mediaLike.deleteMany({ where: { userId: user.id, mediaAssetId: id } });
  await prisma.mediaAsset.updateMany({ where: { id, ownerId: user.id }, data: { liked: false } });
  return ok({ liked: false });
}

async function recordMediaFeedback(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const body = generationFeedbackSchema.parse(await jsonBody(request));
  const asset = await assertMediaOwner(id, user.id);
  if (asset.type !== "image") throw Errors.badRequest("Feedback is only supported for image media");
  if (!asset.sourceJobId) throw Errors.badRequest("Generated image feedback requires a source job");
  const job = await prisma.generationJob.findFirst({
    where: { id: asset.sourceJobId, userId: user.id },
    select: {
      id: true,
      characterId: true,
      visualProfileId: true,
      visualProfileVersion: true,
    },
  });
  if (!job) throw Errors.notFound("Generation job not found for media feedback");
  const visualProfile = await generationJobVisualProfileForFeedback(job);

  const value = body.feedbackType === "identity_match" ? "match" : "mismatch";
  const quality = jsonRecord(jsonRecord(asset.metadata).quality);
  const current = mediaIdentityFeedback(quality.identityFeedback);
  if (current?.value === value) {
    const referenceCandidate = visualProfile
      ? await prisma.referenceCandidate.findUnique({
          where: {
            visualProfileId_mediaAssetId: {
              visualProfileId: visualProfile.id,
              mediaAssetId: asset.id,
            },
          },
        })
      : null;
    return ok({
      feedback: current,
      eventId: current.eventId,
      referenceCandidate: referenceCandidate ? referenceCandidateDTO(referenceCandidate) : null,
    });
  }

  const result = await prisma.$transaction(async (tx) => {
    await lockMediaAssetAuthority(tx, asset.id);
    const lockedAsset = await tx.mediaAsset.findFirst({
      where: {
        id: asset.id,
        ownerId: user.id,
        type: "image",
        deletedAt: null,
      },
    });
    if (!lockedAsset) {
      throw Errors.conflict("Media asset changed before feedback was recorded");
    }
    const lockedVisualProfile = visualProfile
      ? await tx.characterVisualProfile.findFirst({
          where: {
            id: visualProfile.id,
            characterId: job.characterId!,
            version: job.visualProfileVersion!,
          },
        })
      : null;
    if (visualProfile && !lockedVisualProfile) {
      throw Errors.conflict(
        "Generation job identity authority changed before feedback was recorded",
        {
          generationJobId: job.id,
          visualProfileId: job.visualProfileId,
          visualProfileVersion: job.visualProfileVersion,
        },
      );
    }
    const lockedQuality = jsonRecord(jsonRecord(lockedAsset.metadata).quality);
    const lockedFeedback = mediaIdentityFeedback(
      lockedQuality.identityFeedback,
    );
    const currentFeedbackRow = await tx.generationFeedback.findFirst({
      where: {
        actorId: user.id,
        mediaAssetId: asset.id,
        dimension: "identity",
        active: true,
      },
      orderBy: { revision: "desc" },
    });
    if (lockedFeedback?.value === value) {
      const referenceCandidate = lockedVisualProfile
        ? await tx.referenceCandidate.findUnique({
            where: {
              visualProfileId_mediaAssetId: {
                visualProfileId: lockedVisualProfile.id,
                mediaAssetId: lockedAsset.id,
              },
            },
          })
        : null;
      return {
        storedFeedback: lockedFeedback,
        referenceCandidate,
      };
    }
    const revision =
      Math.max(
        currentFeedbackRow?.revision ?? 0,
        lockedFeedback?.revision ?? 0,
      ) + 1;
    const feedback = {
      id: `feedback:${user.id}:${asset.id}:identity`,
      dimension: "identity",
      value,
      revision,
      sourceSurface: body.sourceSurface,
    } as const;
    const event = await appendGenerationEvent(tx, job.id, "user_feedback", "User rated character identity", {
      schemaVersion: 1,
      actorId: user.id,
      mediaAssetId: asset.id,
      feedbackId: feedback.id,
      feedbackType: body.feedbackType,
      feedbackDimension: feedback.dimension,
      feedbackValue: feedback.value,
      idempotencyKey: feedback.id,
      revision,
      sourceSurface: body.sourceSurface,
      supersedesEventId:
        currentFeedbackRow?.eventId ?? lockedFeedback?.eventId ?? null,
    });
    await tx.generationFeedback.updateMany({
      where: {
        actorId: user.id,
        mediaAssetId: asset.id,
        dimension: feedback.dimension,
        active: true,
      },
      data: { active: false },
    });
    await tx.generationFeedback.create({
      data: {
        feedbackKey: feedback.id,
        actorId: user.id,
        mediaAssetId: asset.id,
        generationJobId: job.id,
        dimension: feedback.dimension,
        value: feedback.value,
        revision,
        sourceSurface: body.sourceSurface,
        active: true,
        supersedesId: currentFeedbackRow?.id,
        eventId: event.id,
      },
    });
    const storedFeedback = { ...feedback, eventId: event.id };
    await tx.mediaAsset.update({
      where: { id: asset.id },
      data: {
        metadata: mediaMetadataWithQuality(lockedAsset.metadata, {
          identityFeedback: storedFeedback,
        }),
      },
    });
    const referenceCandidate = lockedVisualProfile
      ? await tx.referenceCandidate.upsert({
          where: {
            visualProfileId_mediaAssetId: {
              visualProfileId: lockedVisualProfile.id,
              mediaAssetId: asset.id,
            },
          },
          update: {
            sourceJobId: job.id,
            status: value === "match" ? "candidate" : "rejected",
            rejectionReason: value === "mismatch" ? "user_identity_mismatch" : null,
          },
          create: {
            visualProfileId: lockedVisualProfile.id,
            mediaAssetId: asset.id,
            sourceJobId: job.id,
            proposedRole: "identity_reference",
            source: "user_feedback",
            status: value === "match" ? "candidate" : "rejected",
            rejectionReason: value === "mismatch" ? "user_identity_mismatch" : null,
          },
        })
      : null;
    return { storedFeedback, referenceCandidate };
  });
  return ok({
    feedback: result.storedFeedback,
    eventId: result.storedFeedback.eventId,
    referenceCandidate: result.referenceCandidate
      ? referenceCandidateDTO(result.referenceCandidate)
      : null,
  });
}

async function generationJobVisualProfileForFeedback(job: {
  readonly id: string;
  readonly characterId: string | null;
  readonly visualProfileId: string | null;
  readonly visualProfileVersion: number | null;
}): Promise<GenerationVisualProfile | null> {
  if (
    job.visualProfileId === null &&
    job.visualProfileVersion === null
  ) {
    return null;
  }
  if (
    !job.characterId ||
    !job.visualProfileId ||
    job.visualProfileVersion === null
  ) {
    throw Errors.conflict(
      "Generation job has incomplete identity authority for feedback",
      { generationJobId: job.id },
    );
  }
  const profile = await prisma.characterVisualProfile.findFirst({
    where: {
      id: job.visualProfileId,
      characterId: job.characterId,
      version: job.visualProfileVersion,
    },
  });
  if (!profile) {
    throw Errors.conflict(
      "Generation job identity authority is unavailable for feedback",
      {
        generationJobId: job.id,
        visualProfileId: job.visualProfileId,
        visualProfileVersion: job.visualProfileVersion,
      },
    );
  }
  return profile;
}

function mediaIdentityFeedback(value: unknown) {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : null;
  const dimension = value.dimension === "identity" ? "identity" as const : null;
  const feedbackValue = value.value === "match" || value.value === "mismatch" ? value.value : null;
  const revision = typeof value.revision === "number" && Number.isInteger(value.revision) ? value.revision : null;
  const sourceSurface =
    value.sourceSurface === "chat" || value.sourceSurface === "generator" || value.sourceSurface === "gallery"
      ? value.sourceSurface
      : null;
  const eventId = typeof value.eventId === "string" ? value.eventId : null;
  if (!id || !dimension || !feedbackValue || revision === null || !sourceSurface || !eventId) return null;
  return { id, dimension, value: feedbackValue, revision, sourceSurface, eventId };
}

async function setMediaAsCharacterImage(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const body = z.object({ characterId: z.string().optional() }).parse(await jsonBody(request));
  const asset = await assertIdentityImageMedia(id, user.id);
  const character = await assertIdentityTargetCharacter(body.characterId ?? asset.characterId, user.id);
  const result = await prisma.$transaction(async (tx) => {
    await lockCharacterGenerationAuthority(tx, character.id);
    const lockedCharacter = await assertIdentityTargetCharacterInTx(tx, character.id, user.id);
    await lockCharacterMediaAssetAuthorities(tx, [asset.id]);
    const lockedAsset = await assertIdentityImageMediaForCharacterInTx(
      tx,
      asset.id,
      user.id,
      lockedCharacter.id,
      { allowUnassigned: true },
    );
    if (body.characterId === undefined && lockedAsset.characterId !== lockedCharacter.id) {
      throw Errors.conflict("Media identity target changed before character-image promotion");
    }
    await assertCharacterDisplayImageMutable(tx, lockedCharacter.id);
    await tx.character.update({
      where: { id: lockedCharacter.id },
      data: { imageAssetId: lockedAsset.id },
    });
    await tx.mediaAsset.update({
      where: { id: lockedAsset.id },
      data: {
        characterId: lockedCharacter.id,
        metadata: mediaMetadataWithQuality(lockedAsset.metadata, {
          selectedAsCharacterImage: true,
        }),
      },
    });
    return { imageAssetId: lockedAsset.id };
  });

  return ok({
    characterId: character.id,
    imageAssetId: result.imageAssetId,
  });
}

async function addMediaToIdentity(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const body = z.object({ characterId: z.string().optional() }).parse(await jsonBody(request));
  const asset = await assertIdentityImageMedia(id, user.id);
  const character = await assertIdentityTargetCharacter(body.characterId ?? asset.characterId, user.id);
  const result = await prisma.$transaction(async (tx) => {
    await lockCharacterGenerationAuthority(tx, character.id);
    const lockedCharacter = await assertIdentityTargetCharacterInTx(tx, character.id, user.id);
    const activeProfile = await tx.characterVisualProfile.findFirst({
      where: { characterId: character.id, status: "active" },
      orderBy: { version: "desc" },
    });
    if (!activeProfile) {
      throw Errors.conflict(
        "Establish a Character identity anchor before adding identity references",
      );
    }
    if (jsonStringArray(activeProfile.anchorAssetIds).length === 0) {
      throw Errors.conflict(
        "Establish a Character identity anchor before adding identity references",
      );
    }
    const currentReferenceSet = await tx.referenceSetRevision.findFirst({
      where: { visualProfileId: activeProfile.id, status: "active" },
      include: { references: { orderBy: { position: "asc" } } },
      orderBy: { revision: "desc" },
    });
    await lockCharacterMediaAssetAuthorities(tx, [
      asset.id,
      ...jsonStringArray(activeProfile.anchorAssetIds),
      ...jsonStringArray(activeProfile.referenceAssetIds),
      ...(currentReferenceSet?.references.map((reference) => reference.mediaAssetId) ?? []),
    ]);
    const lockedAsset = await assertIdentityImageMediaForCharacterInTx(
      tx,
      asset.id,
      user.id,
      lockedCharacter.id,
      { allowUnassigned: true },
    );
    if (body.characterId === undefined && lockedAsset.characterId !== lockedCharacter.id) {
      throw Errors.conflict("Media identity target changed before reference promotion");
    }
    const baseReferences =
      currentReferenceSet?.references.map((reference) => ({
        mediaAssetId: reference.mediaAssetId,
        position: reference.position,
        role: reference.role,
        weight: reference.weight,
        selectionReason: reference.selectionReason,
      })) ?? referenceSnapshotInputs(activeProfile);
    const alreadyPinned = baseReferences.some(
      (reference) => reference.mediaAssetId === lockedAsset.id,
    );
    const referenceAuthorityChanged = !alreadyPinned || !currentReferenceSet;
    if (referenceAuthorityChanged) {
      await assertCharacterIdentityAuthorityMutable(tx, character.id);
    }
    await tx.mediaAsset.update({
      where: { id: lockedAsset.id },
      data: {
        characterId: lockedCharacter.id,
        metadata: mediaMetadataWithQuality(lockedAsset.metadata, {
          addedToReferences: true,
          visualProfileId: activeProfile.id,
          visualProfileVersion: activeProfile.version,
        }),
      },
    });
    const referenceSetRevision = alreadyPinned
      ? currentReferenceSet ??
        await createReferenceSetRevision(
          tx,
          activeProfile,
          "gallery_reference_existing",
          baseReferences,
        )
      : await createReferenceSetRevision(
          tx,
          activeProfile,
          "gallery_reference",
          [
            ...baseReferences,
            {
              mediaAssetId: lockedAsset.id,
              position: baseReferences.length,
              role: "identity_reference",
              weight: 0.75,
              selectionReason: "user_promoted_identity_reference",
            },
          ],
        );
    await tx.referenceCandidate.updateMany({
      where: { mediaAssetId: lockedAsset.id, status: "candidate" },
      data: { status: "promoted", promotedRevisionId: referenceSetRevision.id },
    });
    if (referenceAuthorityChanged) {
      await invalidateCharacterDraftAssetPack(tx, lockedCharacter.id);
    }
    return { visualProfile: activeProfile, referenceSetRevision };
  });

  return ok({
    visualProfile: visualProfileDTO(result.visualProfile),
    referenceSetRevision: referenceSetRevisionDTO(result.referenceSetRevision),
  });
}

async function saveMediaAsCharacterLook(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const body = characterLookSchema.omit({ referenceAssetId: true }).parse(await jsonBody(request));
  const asset = await assertIdentityImageMedia(id, user.id);
  const character = await assertIdentityTargetCharacter(asset.characterId, user.id);
  const look = await prisma.$transaction(async (tx) => {
    await lockCharacterGenerationAuthority(tx, character.id);
    await lockCharacterMediaAssetAuthorities(tx, [asset.id]);
    const lockedCharacter = await assertIdentityTargetCharacterInTx(
      tx,
      character.id,
      user.id,
    );
    const lockedAsset = await assertIdentityImageMediaInTx(tx, asset.id, user.id);
    if (lockedAsset.characterId !== lockedCharacter.id) {
      throw Errors.conflict("Media identity target changed before saving the Character Look");
    }
    assertHydratableLookReferenceAsset(lockedAsset);
    const visualProfile = await requireActiveVisualProfileInTx(tx, lockedCharacter.id);
    return persistCharacterLook(tx, {
      characterId: lockedCharacter.id,
      visualProfileId: visualProfile.id,
      ownerId: user.id,
      label: body.label,
      appearanceDelta: toInputJson(body.appearanceDelta),
      referenceAssetId: lockedAsset.id,
    });
  });
  return ok({ look: characterLookDTO(look) }, { status: 201 });
}

async function persistCharacterLook(
  tx: Prisma.TransactionClient,
  input: {
    characterId: string;
    visualProfileId: string;
    ownerId: string;
    label: string;
    appearanceDelta: Prisma.InputJsonValue;
    referenceAssetId: string | null;
    rebasedFromLookId?: string;
  },
) {
  await tx.characterLook.updateMany({
    where: {
      ownerId: input.ownerId,
      characterId: input.characterId,
      label: input.label,
      status: "active",
    },
    data: { status: "archived", activeKey: null },
  });
  return tx.characterLook.create({
    data: {
      ...input,
      status: "active",
      activeKey: characterLookActiveKey(input.ownerId, input.characterId, input.label),
    },
  });
}

function characterLookActiveKey(ownerId: string, characterId: string, label: string) {
  return `${ownerId}:${characterId}:${label.trim().toLowerCase()}`;
}

function assertHydratableLookReferenceAsset(asset: {
  id: string;
  storageKey: string | null;
  url: string | null;
  metadata: Prisma.JsonValue;
}) {
  if (hasHydratableMediaBlobAuthority(asset)) return;
  throw Errors.conflict(
    "Character Look image does not have retrievable blob authority",
    { mediaAssetId: asset.id },
  );
}

async function resolveMediaVariationGenerationInput(
  userId: string,
  id: string,
  input: {
    outputCount: number;
    consistencyMode: "balanced" | "strict" | "creative";
    model?: string;
    orientation?: string;
  },
) {
  const asset = await assertIdentityImageMedia(id, userId);
  const sourceJob = asset.sourceJobId
    ? await prisma.generationJob.findFirst({
        where: { id: asset.sourceJobId, userId },
      })
    : null;
  const characterId =
    asset.characterId ?? sourceJob?.characterId ?? undefined;
  const sourceControls = jsonRecord(sourceJob?.controls);
  const sourceOrientation = normalizeImageOrientation(
    sourceJob?.orientation ??
      stringControl(
        sourceControls,
        "orientation",
        stringFromMediaDimensions(asset.width, asset.height),
      ),
    "4:5",
  );
  const orientation = normalizeImageOrientation(
    input.orientation,
    sourceOrientation,
  );
  const controls = pruneUndefined({
    orientation,
    backgroundPresetId: stringFromRecord(
      sourceControls,
      "backgroundPresetId",
    ),
    posePresetId: stringFromRecord(sourceControls, "posePresetId"),
    outfitPresetId: stringFromRecord(
      sourceControls,
      "outfitPresetId",
    ),
    sourceImageAssetId: asset.id,
  });
  return {
    asset,
    sourceJob,
    body: {
      mode: "image" as const,
      characterId,
      freeplay: !characterId,
      consistencyMode: input.consistencyMode,
      model: input.model,
      prompt: variationScenePrompt(asset.prompt ?? sourceJob?.prompt),
      controls,
      presetIds: sourceJob ? jsonStringArray(sourceJob.presetIds) : [],
      orientation,
      outputCount: input.outputCount,
    },
  };
}

async function mediaVariationQuote(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const input = z
    .object({
      consistencyMode: z
        .enum(["balanced", "strict", "creative"])
        .default("balanced"),
      model: z.string().trim().min(1).max(120).optional(),
    })
    .strict()
    .parse(await jsonBody(request));
  const variation = await resolveMediaVariationGenerationInput(
    user.id,
    id,
    {
      outputCount: 1,
      consistencyMode: input.consistencyMode,
      model: input.model,
    },
  );
  return generationQuoteForUser(
    user.id,
    variation.body,
    "public_image_edit",
    {
      source: {
        sourceType: "media_variation",
        sourceId: `media:${variation.asset.id}:variation:quote`,
      },
    },
  );
}

async function createMediaVariation(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const body = z
    .object({
      outputCount: z.number().int().min(1).max(4).default(1),
      consistencyMode: z.enum(["balanced", "strict", "creative"]).default("balanced"),
      model: z.string().trim().min(1).max(120).optional(),
      orientation: z.enum(imageOrientations).optional(),
      quoteAuthority: generationQuoteAuthoritySchema,
    })
    .parse(await jsonBody(request));
  const idempotencyKey = requireGenerationWriteIdempotencyKey(request);
  const requestFingerprint = generationWriteRequestFingerprint(
    "media.variation.create",
    body,
    id,
  );
  const existing = await findExistingGenerationJob(user.id, {
    idempotencyKey,
    requestFingerprint,
  });
  const job = existing ?? await (async () => {
    const variation = await resolveMediaVariationGenerationInput(
      user.id,
      id,
      {
        outputCount: body.outputCount,
        consistencyMode: body.consistencyMode,
        model: body.model,
        orientation: body.orientation,
      },
    );
    const { asset, sourceJob } = variation;
    return createGenerationJobForUser(
      user.id,
      {
        ...variation.body,
        quoteAuthority: body.quoteAuthority,
      },
      {
        idempotencyKey,
        requestFingerprint,
        source: {
          sourceType: "media_variation",
          sourceId: `media:${asset.id}:variation:${idempotencyKey}`,
          sourceMeta: toInputJson({
            sourceMediaId: asset.id,
            sourceJobId: sourceJob?.id ?? null,
          }),
        },
        profileSelectionAuthority: "public_image_edit",
        requireQuoteAuthority: true,
      },
    );
  })();
  const queued = await prisma.generationJob.findUniqueOrThrow({
    where: { id: job.id },
    include: generationJobInclude(),
  });
  return ok(generationJobResponse(queued), { status: 202 });
}

async function bulkMedia(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const body = z
    .object({
      ids: z.array(z.string()).min(1).max(100),
      action: z.enum(["delete", "visibility"]),
      visibility: z.enum(["private", "public_pack", "unlisted"]).optional(),
    })
    .parse(await jsonBody(request));

  if (body.action === "delete") {
    const deleted = await softDeleteOwnedMediaAssets(user.id, body.ids);
    return ok({ deleted });
  }

  const targetVisibility = body.visibility ?? "private";
  const updated = await prisma.$transaction(async (tx) => {
    const discovered = await tx.mediaAsset.findMany({
      where: {
        id: { in: body.ids },
        ownerId: user.id,
        deletedAt: null,
      },
      select: { id: true },
    });
    const ownedAssetIds = discovered.map((asset) => asset.id).sort();
    await lockCharacterMediaAssetAuthorities(tx, ownedAssetIds);
    if (ownedAssetIds.length === 0) return 0;

    const current = await tx.mediaAsset.findMany({
      where: {
        id: { in: ownedAssetIds },
        ownerId: user.id,
        deletedAt: null,
      },
      select: { id: true, metadata: true },
    });
    if (
      targetVisibility === "public_pack"
      && current.some((asset) => isSyntheticMediaAsset(asset.metadata))
    ) {
      throw Errors.badRequest("Synthetic media cannot be made public");
    }
    if (targetVisibility !== "public_pack") {
      for (const asset of current) {
        await assertCustomerMediaAuthorityMutationAllowed(tx, asset.id);
      }
    }
    const result = await tx.mediaAsset.updateMany({
      where: {
        id: { in: current.map((asset) => asset.id) },
        ownerId: user.id,
        deletedAt: null,
      },
      data: { visibility: targetVisibility },
    });
    return result.count;
  });
  return ok({ updated });
}

async function downloadMedia(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const asset = await assertReadableMediaAsset(id, user.id);
  const blobLocator = resolveMediaAssetBlobLocator(asset);
  const key = blobLocator?.key;
  if (!key) {
    const remoteUrl = absoluteHttpMediaUrl(asset.url);
    if (remoteUrl) return ok({ url: remoteUrl });
    throw Errors.unavailable("Media storage authority is incomplete", {
      assetId: asset.id,
    });
  }
  if ((process.env.BLOB_PROVIDER ?? "mock") === "mock") {
    return ok({ url: `${mediaViewUrl(asset)}?download=1` });
  }
  const signed = await providers.blob.signGetUrl({
    key,
    expiresInSeconds: signedUrlTtlSeconds(),
    downloadFilename: mediaDownloadFilename(asset),
  });
  if (!signed.ok) {
    throw Errors.unavailable(
      "Media download is temporarily unavailable",
      signed.error,
    );
  }
  return ok({ url: signed.data.url });
}

async function contentMedia(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  if (ctx.userId && ctx.role && ctx.role !== "user") {
    await actorWithPermission(request, "content.asset.read");
    const asset = await prisma.mediaAsset.findFirst({
      where: { id, deletedAt: null },
    });
    if (!asset) throw Errors.notFound("Media not found");
    return contentMediaAsset(request, asset);
  }

  requireAgeGate(ctx);
  const publicAsset = await findPublicReadableMediaAsset(id);
  if (publicAsset) return contentMediaAsset(request, publicAsset);

  const user = requireUser(ctx);
  requireAgeVerified(ctx);
  return contentMediaAsset(request, await assertReadableMediaAsset(id, user.id));
}

async function contentMediaAsset(
  request: Request,
  asset: Awaited<ReturnType<typeof assertReadableMediaAsset>>,
) {
  const key = resolveMediaAssetBlobLocator(asset)?.key;

  if (key && (process.env.BLOB_PROVIDER ?? "mock") === "mock") {
    const body = await readFile(localBlobPath(key)).catch(() => null);
    if (!body) throw Errors.notFound("Media not found");
    return localMediaResponse(request, asset, body);
  }

  if (!key) {
    const remoteUrl = absoluteHttpMediaUrl(asset.url);
    if (remoteUrl) return Response.redirect(remoteUrl, 302);
    throw Errors.unavailable("Media storage authority is incomplete", {
      assetId: asset.id,
    });
  }
  const signed = await providers.blob.signGetUrl({
    key,
    expiresInSeconds: signedUrlTtlSeconds(),
    downloadFilename:
      new URL(request.url).searchParams.get("download") === "1"
        ? mediaDownloadFilename(asset)
        : undefined,
  });
  if (!signed.ok) {
    throw Errors.unavailable(
      "Media is temporarily unavailable",
      signed.error,
    );
  }
  return Response.redirect(signed.data.url, 302);
}

function absoluteHttpMediaUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function localMediaResponse(
  request: Request,
  asset: {
    id: string;
    type: string;
    contentType?: string | null;
    storageKey: string | null;
    url: string;
  },
  body: Buffer,
) {
  const headers = localMediaHeaders(request, asset);
  headers.set("accept-ranges", "bytes");
  const range = parseByteRange(request.headers.get("range"), body.byteLength);
  if (range === "invalid") {
    headers.set("content-range", `bytes */${body.byteLength}`);
    return new Response(null, { status: 416, headers });
  }

  if (range) {
    const chunk = body.subarray(range.start, range.end + 1);
    headers.set("content-length", String(chunk.byteLength));
    headers.set("content-range", `bytes ${range.start}-${range.end}/${body.byteLength}`);
    return new Response(arrayBufferBody(chunk), { status: 206, headers });
  }

  headers.set("content-length", String(body.byteLength));
  return new Response(arrayBufferBody(body), { headers });
}

function arrayBufferBody(bytes: Uint8Array) {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function localMediaHeaders(
  request: Request,
  asset: {
    id: string;
    type: string;
    contentType?: string | null;
    storageKey: string | null;
    url: string;
  },
) {
  const url = new URL(request.url);
  const headers = new Headers({
    "cache-control": "private, no-store, max-age=0",
    "content-type": asset.contentType ?? "application/octet-stream",
    pragma: "no-cache",
    vary: "Cookie, Authorization",
  });
  if (url.searchParams.get("download") === "1") {
    headers.set("content-disposition", `attachment; filename="${mediaDownloadFilename(asset)}"`);
  }
  return headers;
}

function parseByteRange(header: string | null, size: number) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size <= 0) return "invalid";
  const [, rawStart, rawEnd] = match;

  if (!rawStart && !rawEnd) return "invalid";
  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return "invalid";
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    };
  }

  const start = Number(rawStart);
  const end = rawEnd ? Number(rawEnd) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return "invalid";
  }

  return { start, end: Math.min(end, size - 1) };
}

function localBlobPath(key: string) {
  const root = resolveLocalBlobRoot();
  const target = resolveLocalBlobPath(key);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw Errors.notFound("Media not found");
  }
  return target;
}

function mediaDownloadFilename(asset: {
  id: string;
  type: string;
  contentType?: string | null;
  storageKey: string | null;
  url: string;
}) {
  return `idream-${asset.type}-${asset.id}${mediaFileExtension(asset)}`;
}

function mediaFileExtension(asset: {
  contentType?: string | null;
  storageKey?: string | null;
  url: string;
}) {
  const byContentType: Record<string, string> = {
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "audio/flac": ".flac",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/webm": ".webm",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
  };
  if (asset.contentType && byContentType[asset.contentType]) {
    return byContentType[asset.contentType];
  }

  const source = asset.storageKey ?? asset.url;
  const match = /\.(flac|gif|jpe?g|mp3|mp4|ogg|png|wav|webm|webp)(?:[?#]|$)/i.exec(source);
  return match ? `.${match[1].toLowerCase().replace("jpeg", "jpg")}` : "";
}

async function deleteMedia(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  await softDeleteOwnedMediaAssets(user.id, [id]);
  return ok({ deleted: true });
}

async function softDeleteOwnedMediaAssets(
  ownerId: string,
  requestedAssetIds: readonly string[],
) {
  const requestedIds = [...new Set(requestedAssetIds)];
  return prisma.$transaction(async (tx) => {
    const discovered = await tx.mediaAsset.findMany({
      where: {
        id: { in: requestedIds },
        ownerId,
        deletedAt: null,
      },
      select: { id: true },
    });
    const ownedAssetIds = discovered.map((asset) => asset.id).sort();
    await lockCharacterMediaAssetAuthorities(tx, ownedAssetIds);
    if (ownedAssetIds.length === 0) return 0;

    const current = await tx.mediaAsset.findMany({
      where: {
        id: { in: ownedAssetIds },
        ownerId,
        deletedAt: null,
      },
      select: { id: true },
    });
    const currentAssetIds = current.map((asset) => asset.id).sort();
    if (currentAssetIds.length === 0) return 0;
    for (const assetId of currentAssetIds) {
      await assertCustomerMediaAuthorityMutationAllowed(tx, assetId);
    }
    const deleted = await tx.mediaAsset.updateMany({
      where: {
        id: { in: currentAssetIds },
        ownerId,
        deletedAt: null,
      },
      data: { deletedAt: new Date() },
    });
    return deleted.count;
  });
}

async function assertCustomerMediaAuthorityMutationAllowed(
  tx: Prisma.TransactionClient,
  assetId: string,
) {
  const dependencies = await mediaAssetAuthorityDependencies(tx, assetId);
  if (dependencies.length === 0) return;
  throw Errors.conflict(
    "This image is in use. Replace or withdraw it from the linked Character or campaign before making it private or deleting it.",
    {
      code: "media_asset_authority_dependency_active",
      mediaAssetId: assetId,
      dependencies,
      repairPath: dependencies[0]?.repairPath ?? "/generator?tab=gallery",
    },
  );
}

async function listPlans() {
  const [plans, availability] = await Promise.all([
    prisma.plan.findMany({
      where: { active: true },
      orderBy: [{ slug: "asc" }, { billingPeriod: "asc" }],
    }),
    publicOfferAvailability(),
  ]);
  return ok({
    items: plans.map((plan) => ({
      ...plan,
      features: publicFeatureProjection(plan.features, availability),
    })),
    billing: checkoutMode(),
  });
}

function checkoutMode() {
  const provider = env.PAYMENT_PROVIDER;
  return {
    provider,
    demoMode: provider === "mock",
    autoConfirmAvailable: provider === "mock",
    ...providers.payment.capabilities,
  };
}

async function checkout(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const idempotencyKey = requireCheckoutIdempotencyKey(request);
  const body = checkoutSchema.parse(await jsonBody(request));
  const mode = checkoutMode();
  const autoConfirm = body.autoConfirm && mode.autoConfirmAvailable;
  const requestHash = checkoutRequestHash({
    selector: body.planId
      ? { planId: body.planId }
      : {
          slug: body.slug ?? "premium",
          billingPeriod: body.billingPeriod,
        },
    returnPath: body.returnPath,
    autoConfirm,
    provider: mode.provider,
  });
  const preexisting = await prisma.checkoutSession.findUnique({
    where: {
      userId_idempotencyKey: {
        userId: user.id,
        idempotencyKey,
      },
    },
  });
  const selectedPlan = preexisting ? null : await findPlan(body);

  const durableIntent = await prisma.$transaction(async (tx) => {
    await lockUserLedger(tx, user.id);
    const existing = await tx.checkoutSession.findUnique({
      where: {
        userId_idempotencyKey: {
          userId: user.id,
          idempotencyKey,
        },
      },
    });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw Errors.conflict(
          "Idempotency-Key was already used for a different checkout request",
          { idempotencyAction: "new_key" },
        );
      }
      return existing;
    }
    if (!selectedPlan) {
      throw Errors.conflict(
        "Checkout intent disappeared before it could be replayed",
        { idempotencyAction: "same_key" },
      );
    }
    const now = new Date();
    await assertNoActiveSamePlanAccessInTx(
      tx,
      user.id,
      selectedPlan.id,
      now,
    );
    return tx.checkoutSession.create({
      data: {
        userId: user.id,
        planId: selectedPlan.id,
        provider: mode.provider,
        idempotencyKey,
        requestHash,
        amountCents: selectedPlan.priceCents,
        currency: selectedPlan.currency.toLowerCase(),
        offerSnapshot: toInputJson({
          version: 1,
          planId: selectedPlan.id,
          slug: selectedPlan.slug,
          name: selectedPlan.name,
          billingPeriod: selectedPlan.billingPeriod,
          priceCents: selectedPlan.priceCents,
          currency: selectedPlan.currency.toLowerCase(),
          includedDreamcoins: selectedPlan.includedDreamcoins,
          features: selectedPlan.features,
        }),
        autoConfirm,
        returnPath: body.returnPath,
        status: "provider_pending",
      },
    });
  });
  if (
    !durableIntent.planId ||
    durableIntent.amountCents === null ||
    !durableIntent.currency ||
    !checkoutOfferSnapshotSchema.safeParse(durableIntent.offerSnapshot).success
  ) {
    throw Errors.unavailable("Checkout intent is missing its authoritative plan snapshot", {
      checkoutId: durableIntent.id,
    });
  }

  await trackEventOnce(
    "checkout_started",
    {
      planId: durableIntent.planId,
      autoConfirm: durableIntent.autoConfirm,
      provider: durableIntent.provider,
    },
    ctx,
    `checkout:${durableIntent.id}:started`,
  );

  let checkoutSession = await ensureCheckoutInvoice(durableIntent.id, {
    userId: durableIntent.userId,
    planId: durableIntent.planId,
    amountCents: durableIntent.amountCents,
    currency: durableIntent.currency,
  });
  let subscription = await subscriptionForCheckout(checkoutSession);
  if (checkoutSession.status === "provider_settled") {
    const completed = await completeCheckoutIntent(checkoutSession.id, "checkout");
    checkoutSession = completed.checkout;
    if (completed.settlementDeferred) {
      throw Errors.unavailable(
        "Settlement is waiting for an in-flight same-plan provider dispatch to finish.",
        {
          checkoutId: checkoutSession.id,
          competingCheckoutId: completed.deferredByCheckoutId,
          deferred: true,
        },
      );
    }
    if (completed.reconciliationRequired) {
      throw Errors.unavailable(
        "The settled purchase requires billing reconciliation before access can change.",
        { checkoutId: checkoutSession.id },
      );
    }
    subscription = await subscriptionForCheckout(checkoutSession);
  }
  if (
    checkoutSession.status === "provider_unknown" ||
    checkoutSession.needsReconciliation
  ) {
    throw Errors.unavailable(
      "Checkout payment state requires provider reconciliation before it can continue.",
      { checkoutId: checkoutSession.id },
    );
  }
  if (
    checkoutSession.status === "expired" ||
    checkoutSession.status === "canceled"
  ) {
    throw Errors.conflict(
      "This payment invoice is no longer payable. Start a new checkout with a new Idempotency-Key.",
      {
        checkoutId: checkoutSession.id,
        idempotencyAction: "new_key",
        providerInvoiceStatus: checkoutSession.providerInvoiceStatus,
      },
    );
  }
  if (checkoutSession.autoConfirm && checkoutSession.status !== "completed") {
    const completed = await completeCheckoutIntent(checkoutSession.id, "checkout");
    checkoutSession = completed.checkout;
    if (completed.settlementDeferred) {
      throw Errors.unavailable(
        "Settlement is waiting for an in-flight same-plan provider dispatch to finish.",
        {
          checkoutId: checkoutSession.id,
          competingCheckoutId: completed.deferredByCheckoutId,
          deferred: true,
        },
      );
    }
    if (completed.reconciliationRequired) {
      throw Errors.unavailable(
        "The settled purchase requires billing reconciliation before access can change.",
        { checkoutId: checkoutSession.id },
      );
    }
    subscription = await subscriptionForCheckout(checkoutSession);
  }

  if (!checkoutSession.providerSessionId || !checkoutSession.checkoutUrl) {
    throw Errors.unavailable("Checkout provider state is incomplete", {
      checkoutId: checkoutSession.id,
    });
  }
  const publicSubscription = subscription
    ? await publicSubscriptionDTO(subscription)
    : null;

  return ok({
    checkout: {
      id: checkoutSession.id,
      planId: checkoutSession.planId,
      provider: checkoutSession.provider,
      status: checkoutSession.status,
      returnPath: checkoutSession.returnPath,
      createdAt: checkoutSession.createdAt,
      updatedAt: checkoutSession.updatedAt,
    },
    invoice: {
      provider: checkoutSession.provider,
      invoiceId: checkoutSession.providerSessionId,
      checkoutUrl: checkoutSession.checkoutUrl,
      status: checkoutSession.providerInvoiceStatus ?? "created",
      additionalStatus:
        checkoutSession.providerInvoiceAdditionalStatus ?? "none",
    },
    subscription: publicSubscription,
    billingAccess: subscription ? billingAccessDTO(subscription) : null,
    billing: mode,
  });
}

function requireCheckoutIdempotencyKey(request: Request) {
  const value = request.headers.get("idempotency-key")?.trim();
  if (!value) {
    throw Errors.badRequest("Idempotency-Key header is required for checkout");
  }
  if (value.length < 8 || value.length > 160) {
    throw Errors.badRequest("Idempotency-Key must be between 8 and 160 characters");
  }
  return value;
}

function checkoutRequestHash(input: {
  selector:
    | { planId: string }
    | { slug: "premium" | "deluxe"; billingPeriod: "monthly" | "yearly" };
  returnPath: string;
  autoConfirm: boolean;
  provider: string;
}) {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
}

function billingProviderEventTargetHash(input: {
  type: "invoice.confirmed" | "invoice.ignored";
  invoiceId?: string;
  orderId?: string;
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        type: input.type,
        invoiceId: input.invoiceId ?? null,
        orderId: input.orderId ?? null,
      }),
    )
    .digest("hex");
}

const CHECKOUT_PROVIDER_RECONCILIATION_GRACE_MS = 30 * 60 * 1_000;
const CHECKOUT_PROVIDER_RECONCILIATION_MIN_MISSES = 3;
const CHECKOUT_PROVIDER_NOT_FOUND_TERMINAL =
  "provider_invoice_not_found_after_grace";
const CHECKOUT_PROVIDER_DISPATCH_LEASE_MS = 2 * 60 * 1_000;
const PAYMENT_PROVIDER_REQUEST_DEADLINE_MS =
  env.NODE_ENV === "test" ? 1_000 : 10_000;

async function paymentProviderRequestWithDeadline<T>(
  timeoutCode: string,
  operation: (signal: AbortSignal) => Promise<ProviderResult<T>>,
): Promise<ProviderResult<T>> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<ProviderResult<T>>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve({
        ok: false,
        error: {
          code: timeoutCode,
          message: "Payment provider request exceeded its deadline",
          retryable: true,
        },
      });
    }, PAYMENT_PROVIDER_REQUEST_DEADLINE_MS);
  });
  const requested = Promise.resolve()
    .then(() => operation(controller.signal))
    .catch(
      (error): ProviderResult<T> => ({
        ok: false,
        error: {
          code: timeoutCode,
          message:
            error instanceof Error
              ? error.message
              : "Payment provider request failed",
          retryable: true,
        },
      }),
    );
  try {
    return await Promise.race([requested, timedOut]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function ensureCheckoutInvoice(
  checkoutId: string,
  plan: {
    userId: string;
    planId: string;
    amountCents: number;
    currency: string;
  },
) {
  let current = await prisma.checkoutSession.findUniqueOrThrow({
    where: { id: checkoutId },
  });
  if (
    current.status === "completed" &&
    current.providerSessionId &&
    current.checkoutUrl
  ) {
    return current;
  }
  if (isProviderMissingCheckoutTerminal(current)) {
    throw Errors.conflict(
      "The previous payment attempt was not found after reconciliation. Start a new checkout with a new Idempotency-Key.",
      { checkoutId, idempotencyAction: "new_key" },
    );
  }
  if (isLateSettledAbandonedCheckout(current)) {
    throw Errors.unavailable(
      "A late provider settlement is under manual reconciliation. Contact support before starting another checkout.",
      { checkoutId },
    );
  }
  if (
    current.dispatchToken &&
    current.dispatchLeaseUntil &&
    current.dispatchLeaseUntil > new Date()
  ) {
    current = await waitForCheckoutDispatch(checkoutId);
    if (current.providerSessionId && current.checkoutUrl) return current;
    if (
      current.dispatchToken &&
      current.dispatchLeaseUntil &&
      current.dispatchLeaseUntil > new Date()
    ) {
      throw Errors.conflict(
        "Checkout creation is already in progress. Retry with the same Idempotency-Key.",
        { checkoutId, idempotencyAction: "same_key" },
      );
    }
  }
  if (
    current.providerAttemptedAt ||
    current.providerSessionId ||
    current.needsReconciliation ||
    current.status === "provider_unknown"
  ) {
    const recovered = await paymentProviderRequestWithDeadline(
      "invoice_lookup_timeout",
      (signal) =>
        providers.payment.findInvoiceByOrderId({
          orderId: checkoutId,
          signal,
        }),
    );
    if (!recovered.ok) {
      throw Errors.unavailable(
        "Payment provider lookup is temporarily unavailable",
        recovered.error,
      );
    }
    if (recovered.data) {
      return persistRecoveredCheckoutInvoice(checkoutId, recovered.data);
    }
    const missing = await recordCheckoutInvoiceMissing(
      checkoutId,
      "provider_attempt_requires_reconciliation",
    );
    if (missing.closed) {
      throw Errors.conflict(
        "The payment provider confirmed no invoice after the reconciliation window. Start a new checkout with a new Idempotency-Key.",
        { checkoutId, idempotencyAction: "new_key" },
      );
    }
    if (missing.preservedAuthority) return missing.checkout;
    throw Errors.unavailable(
      "Checkout payment state is awaiting reconciliation. Retry with the same key later.",
      { checkoutId },
    );
  }

  return dispatchCheckoutInvoiceWithAccessExclusion(checkoutId, plan);
}

async function dispatchCheckoutInvoiceWithAccessExclusion(
  checkoutId: string,
  plan: {
    userId: string;
    planId: string;
    amountCents: number;
    currency: string;
  },
) {
  const dispatchToken = randomUUID();
  const phaseOne = await prisma.$transaction(async (tx) => {
    await lockCheckoutSession(tx, checkoutId);
    const current = await tx.checkoutSession.findUniqueOrThrow({
      where: { id: checkoutId },
    });
    const now = new Date();
    const claimable =
      current.providerAttemptedAt === null &&
      current.providerSessionId === null &&
      !current.needsReconciliation &&
      (current.status === "provider_pending" ||
        current.status === "provider_dispatching") &&
      (current.dispatchLeaseUntil === null ||
        current.dispatchLeaseUntil < now);
    if (!claimable) return { kind: "busy" } as const;

    await lockUserLedger(tx, plan.userId);
    await assertNoActiveSamePlanAccessInTx(
      tx,
      plan.userId,
      plan.planId,
      now,
    );
    const competingDispatch = await activeSamePlanProviderDispatchInTx(
      tx,
      plan.userId,
      plan.planId,
      checkoutId,
      now,
    );
    if (competingDispatch) {
      throw Errors.conflict(
        "Another checkout for this plan is already contacting the payment provider.",
        {
          checkoutId,
          competingCheckoutId: competingDispatch.id,
          idempotencyAction: "same_key",
        },
      );
    }

    // This marker commits before any provider network call. From this point on,
    // every retry is lookup/reconciliation-only and can never issue a second
    // POST, including a crash immediately after this transaction.
    const checkout = await tx.checkoutSession.update({
      where: { id: checkoutId },
      data: {
        status: "provider_dispatching",
        dispatchToken,
        dispatchLeaseUntil: new Date(
          now.getTime() + CHECKOUT_PROVIDER_DISPATCH_LEASE_MS,
        ),
        providerAttemptedAt: now,
        failureCode: null,
      },
    });
    return { kind: "claimed", checkout } as const;
  });

  if (phaseOne.kind === "busy") {
    const current = await waitForCheckoutDispatch(checkoutId);
    if (current.providerSessionId && current.checkoutUrl) return current;
    throw Errors.conflict(
      "Checkout creation is already in progress. Retry with the same Idempotency-Key.",
      { checkoutId, idempotencyAction: "same_key" },
    );
  }

  const recoveredBeforeCreate = await paymentProviderRequestWithDeadline(
    "invoice_lookup_timeout",
    (signal) =>
      providers.payment.findInvoiceByOrderId({
        orderId: checkoutId,
        signal,
      }),
  );
  if (!recoveredBeforeCreate.ok) {
    await recordProviderDispatchUnknown(
      checkoutId,
      dispatchToken,
      recoveredBeforeCreate.error.code,
    );
    throw Errors.unavailable(
      "Payment provider lookup is temporarily unavailable",
      recoveredBeforeCreate.error,
    );
  }
  if (recoveredBeforeCreate.data) {
    return persistCheckoutInvoiceAuthority(
      checkoutId,
      recoveredBeforeCreate.data,
      dispatchToken,
    );
  }

  const created = await paymentProviderRequestWithDeadline(
    "invoice_create_timeout",
    (signal) =>
      providers.payment.createInvoice({
        orderId: checkoutId,
        userId: plan.userId,
        amountCents: plan.amountCents,
        currency: plan.currency,
        metadata: { planId: plan.planId },
        signal,
      }),
  );
  if (created.ok) {
    return persistCheckoutInvoiceAuthority(
      checkoutId,
      created.data,
      dispatchToken,
    );
  }

  const recoveredAfterFailure = await paymentProviderRequestWithDeadline(
    "invoice_lookup_timeout",
    (signal) =>
      providers.payment.findInvoiceByOrderId({
        orderId: checkoutId,
        signal,
      }),
  );
  if (recoveredAfterFailure.ok && recoveredAfterFailure.data) {
    return persistCheckoutInvoiceAuthority(
      checkoutId,
      recoveredAfterFailure.data,
      dispatchToken,
    );
  }

  const failureCode = recoveredAfterFailure.ok
    ? created.error.code
    : `${created.error.code}:${recoveredAfterFailure.error.code}`;
  await recordProviderDispatchUnknown(
    checkoutId,
    dispatchToken,
    failureCode,
  );
  throw Errors.unavailable(
    "Payment provider did not return a recoverable checkout. The intent was preserved for reconciliation.",
    { checkoutId, providerError: created.error },
  );
}

async function waitForCheckoutDispatch(checkoutId: string) {
  const deadline = Date.now() + 1_500;
  let current = await prisma.checkoutSession.findUniqueOrThrow({
    where: { id: checkoutId },
  });
  while (
    current.dispatchToken &&
    current.dispatchLeaseUntil &&
    current.dispatchLeaseUntil > new Date() &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    current = await prisma.checkoutSession.findUniqueOrThrow({
      where: { id: checkoutId },
    });
  }
  return current;
}

async function persistRecoveredCheckoutInvoice(
  checkoutId: string,
  invoice: PaymentInvoice,
) {
  return persistCheckoutInvoiceAuthority(checkoutId, invoice);
}

async function persistCheckoutInvoiceAuthority(
  checkoutId: string,
  invoice: PaymentInvoice,
  expectedDispatchToken?: string,
) {
  return prisma.$transaction((tx) =>
    persistCheckoutInvoiceAuthorityInTx(
      tx,
      checkoutId,
      invoice,
      expectedDispatchToken,
    ),
  );
}

async function persistCheckoutInvoiceAuthorityInTx(
  tx: Prisma.TransactionClient,
  checkoutId: string,
  invoice: PaymentInvoice,
  expectedDispatchToken?: string,
) {
  await lockCheckoutSession(tx, checkoutId);
  const current = await tx.checkoutSession.findUniqueOrThrow({
    where: { id: checkoutId },
  });
    if (current.provider !== invoice.provider) {
      throw Errors.conflict("Recovered invoice provider does not match checkout intent", {
        checkoutId,
        idempotencyAction: "same_key",
      });
    }
    if (
      current.providerSessionId &&
      current.providerSessionId !== invoice.invoiceId
    ) {
      throw Errors.conflict("Recovered invoice does not match checkout intent", {
        checkoutId,
        idempotencyAction: "same_key",
      });
    }
    assertRecoveredInvoiceMatchesCheckout(current, invoice);
    if (isCheckoutReconciliationResolved(current)) return current;
    if (isLateSettledAbandonedCheckout(current)) {
      if (invoice.status !== "settled") return current;
      return tx.checkoutSession.update({
        where: { id: checkoutId },
        data: lateSettledCheckoutData(current.reconciliationEvidence, invoice),
      });
    }
    if (isCheckoutAbandonedTerminal(current)) {
      if (invoice.status !== "settled") return current;
      return tx.checkoutSession.update({
        where: { id: checkoutId },
        data: lateSettledCheckoutData(current.reconciliationEvidence, invoice),
      });
    }
    if (current.status === "completed") {
      return tx.checkoutSession.update({
        where: { id: checkoutId },
        data: {
          providerSessionId: invoice.invoiceId,
          checkoutUrl: invoice.checkoutUrl,
          providerInvoiceStatus: "settled",
          providerInvoiceAdditionalStatus:
            current.providerInvoiceAdditionalStatus ??
            invoice.additionalStatus,
          dispatchToken: null,
          dispatchLeaseUntil: null,
          providerLookupMissCount: 0,
          providerLastLookupAt: new Date(),
        },
      });
    }
    if (
      expectedDispatchToken &&
      current.dispatchToken !== expectedDispatchToken
    ) {
      if (current.providerSessionId === invoice.invoiceId) return current;
      throw Errors.conflict(
        "Checkout authority changed before invoice persistence",
        { checkoutId, idempotencyAction: "same_key" },
      );
    }
    if (
      current.providerInvoiceStatus === "settled" &&
      invoice.status !== "settled"
    ) {
      return current;
    }
    const disposition = checkoutDispositionForInvoice(
      invoice,
      current.status,
    );
    const providerInvoiceStatus =
      current.status === "completed" ? "settled" : invoice.status;
    const providerInvoiceAdditionalStatus =
      current.status === "completed"
        ? current.providerInvoiceAdditionalStatus ?? invoice.additionalStatus
        : invoice.additionalStatus;
  return tx.checkoutSession.update({
    where: { id: checkoutId },
    data: {
      providerSessionId: invoice.invoiceId,
      checkoutUrl: invoice.checkoutUrl,
      providerInvoiceStatus,
      providerInvoiceAdditionalStatus,
      status: disposition.status,
      dispatchToken: null,
      dispatchLeaseUntil: null,
      failureCode: disposition.failureCode,
      needsReconciliation: disposition.needsReconciliation,
      providerLookupMissCount: 0,
      providerLastLookupAt: new Date(),
    },
  });
}

function lateSettledCheckoutData(
  existingEvidence: unknown,
  invoice: {
    provider: PaymentInvoice["provider"];
    invoiceId: string;
    checkoutUrl: string | null;
    additionalStatus: PaymentInvoice["additionalStatus"];
  },
) {
  return {
    providerSessionId: invoice.invoiceId,
    checkoutUrl: invoice.checkoutUrl,
    providerInvoiceStatus: "settled",
    providerInvoiceAdditionalStatus: invoice.additionalStatus,
    status: "provider_unknown",
    dispatchToken: null,
    dispatchLeaseUntil: null,
    failureCode: "provider_invoice_settled_after_abandonment",
    needsReconciliation: true,
    providerLookupMissCount: 0,
    providerLastLookupAt: new Date(),
    reconciliationEvidence: toInputJson({
      ...(isRecord(existingEvidence) ? existingEvidence : {}),
      schemaVersion: "checkout-reconciliation-evidence-v1",
      reason: "provider_invoice_settled_after_abandonment",
      provider: invoice.provider,
      providerInvoiceId: invoice.invoiceId,
      observedAt: new Date().toISOString(),
    }),
  };
}

function assertRecoveredInvoiceMatchesCheckout(
  checkout: {
    id: string;
    amountCents: number | null;
    currency: string | null;
  },
  invoice: PaymentInvoice,
) {
  if (
    invoice.orderId !== checkout.id ||
    invoice.amountCents !== checkout.amountCents ||
    invoice.currency.toLowerCase() !== checkout.currency?.toLowerCase()
  ) {
    throw Errors.conflict(
      "Recovered invoice amount, currency, or order does not match checkout intent",
      {
        checkoutId: checkout.id,
        idempotencyAction: "same_key",
        providerInvoiceId: invoice.invoiceId,
      },
    );
  }
}

function checkoutDispositionForInvoice(
  invoice: PaymentInvoice,
  currentStatus: string,
) {
  if (currentStatus === "completed") {
    return {
      status: "completed",
      failureCode: null,
      needsReconciliation: false,
    };
  }
  if (invoice.status === "settled") {
    return {
      status: "provider_settled",
      failureCode: null,
      needsReconciliation: false,
    };
  }
  if (
    (invoice.status === "expired" || invoice.status === "invalid") &&
    ["paid_late", "paid_over", "paid_partial"].includes(
      invoice.additionalStatus,
    )
  ) {
    return {
      status: "provider_unknown",
      failureCode: `provider_invoice_${invoice.status}_${invoice.additionalStatus}`,
      needsReconciliation: true,
    };
  }
  if (invoice.status === "expired") {
    return {
      status: "expired",
      failureCode: "provider_invoice_expired",
      needsReconciliation: false,
    };
  }
  if (invoice.status === "invalid") {
    return {
      status: "canceled",
      failureCode: "provider_invoice_invalid",
      needsReconciliation: false,
    };
  }
  return {
    status: "created",
    failureCode: null,
    needsReconciliation: false,
  };
}

async function recordCheckoutInvoiceMissing(
  checkoutId: string,
  failureCode: string,
  dispatchToken?: string,
) {
  return prisma.$transaction(async (tx) => {
    await lockCheckoutSession(tx, checkoutId);
    const current = await tx.checkoutSession.findUniqueOrThrow({
      where: { id: checkoutId },
    });
    const existingTerminal = isCheckoutAbandonedTerminal(current);
    if (
      current.status === "completed" ||
      current.providerSessionId !== null ||
      existingTerminal ||
      isLateSettledAbandonedCheckout(current) ||
      (dispatchToken && current.dispatchToken !== dispatchToken)
    ) {
      return {
        checkout: current,
        closed: existingTerminal,
        preservedAuthority: true,
      };
    }
    const now = new Date();
    const missCount = current.providerLookupMissCount + 1;
    const graceElapsed =
      current.providerAttemptedAt !== null &&
      now.getTime() - current.providerAttemptedAt.getTime() >=
        CHECKOUT_PROVIDER_RECONCILIATION_GRACE_MS;
    const closed =
      graceElapsed &&
      missCount >= CHECKOUT_PROVIDER_RECONCILIATION_MIN_MISSES &&
      current.providerSessionId === null;
    const checkout = await tx.checkoutSession.update({
      where: { id: checkoutId },
      data: {
        status: closed ? "canceled" : "provider_unknown",
        dispatchToken: null,
        dispatchLeaseUntil: null,
        providerLastLookupAt: now,
        providerLookupMissCount: missCount,
        failureCode: closed
          ? CHECKOUT_PROVIDER_NOT_FOUND_TERMINAL
          : failureCode,
        needsReconciliation: !closed,
      },
    });
    return { checkout, closed, preservedAuthority: false };
  });
}

async function recordProviderDispatchUnknown(
  checkoutId: string,
  dispatchToken: string,
  failureCode: string,
) {
  return recordCheckoutInvoiceMissing(
    checkoutId,
    failureCode,
    dispatchToken,
  );
}

function isProviderMissingCheckoutTerminal(checkout: {
  status: string;
  failureCode: string | null;
}) {
  return (
    checkout.status === "canceled" &&
    checkout.failureCode === CHECKOUT_PROVIDER_NOT_FOUND_TERMINAL
  );
}

function isLateSettledAbandonedCheckout(checkout: {
  failureCode: string | null;
}) {
  return checkout.failureCode === "provider_invoice_settled_after_abandonment";
}

function isCheckoutAbandonedTerminal(checkout: { status: string }) {
  return checkout.status === "canceled" || checkout.status === "expired";
}

function isCheckoutReconciliationResolved(checkout: {
  failureCode: string | null;
}) {
  return checkout.failureCode === "provider_invoice_refund_acknowledged";
}

function paymentInvoiceAdditionalStatus(
  value: string | null,
): PaymentInvoice["additionalStatus"] {
  if (
    value === "marked" ||
    value === "paid_late" ||
    value === "paid_over" ||
    value === "paid_partial"
  ) {
    return value;
  }
  return "none";
}

async function subscriptionForCheckout(checkoutSession: {
  userId: string;
  planId: string | null;
  provider: string;
  providerSessionId: string | null;
}) {
  if (!checkoutSession.planId || !checkoutSession.providerSessionId) {
    return null;
  }
  const purchased = await prisma.subscription.findFirst({
    where: {
      userId: checkoutSession.userId,
      planId: checkoutSession.planId,
      provider: checkoutSession.provider,
      providerSubscriptionId: checkoutSession.providerSessionId,
    },
    include: { plan: true },
    orderBy: { createdAt: "desc" },
  });
  if (purchased?.status === "active") return purchased;

  // A late older invoice can be recorded as an applied purchase while its
  // prepaid period extends a newer access authority. Public checkout state must
  // return that current authority, not present the non-active receipt as access.
  return prisma.subscription.findFirst({
    where: activeSubscriptionWhere(checkoutSession.userId),
    include: { plan: true },
    orderBy: [{ currentPeriodEnd: "desc" }, { createdAt: "desc" }],
  });
}

async function completeCheckoutIntent(
  checkoutId: string,
  source: "checkout" | "webhook",
) {
  return prisma.$transaction(async (tx) => {
    await lockCheckoutSession(tx, checkoutId);
    const current = await tx.checkoutSession.findUniqueOrThrow({
      where: { id: checkoutId },
    });
    if (!current.planId || !current.providerSessionId) {
      throw Errors.conflict("Checkout is missing its local plan or provider invoice", {
        checkoutId,
        idempotencyAction: "same_key",
      });
    }
    const offerSnapshot = checkoutOfferSnapshotSchema.safeParse(
      current.offerSnapshot,
    );
    if (
      !offerSnapshot.success ||
      offerSnapshot.data.planId !== current.planId
    ) {
      throw Errors.conflict("Checkout is missing its authoritative offer snapshot", {
        checkoutId,
        idempotencyAction: "same_key",
      });
    }
    if (current.status === "completed") {
      const subscription = await tx.subscription.findFirst({
        where: {
          userId: current.userId,
          planId: current.planId,
          provider: current.provider,
          providerSubscriptionId: current.providerSessionId,
        },
        orderBy: { createdAt: "desc" },
      });
      return {
        checkout: current,
        subscription,
        created: false,
        reconciliationRequired: false,
        settlementDeferred: false,
      } as const;
    }

    const activation = await activateSubscriptionInTx(
      tx,
      current.userId,
      current.planId,
      current.providerSessionId,
      current.provider,
      offerSnapshot.data,
      {
        checkoutId: current.id,
        createdAt: current.createdAt,
      },
    );
    if (activation.settlementDeferred) {
      return {
        checkout: current,
        subscription: null,
        created: false,
        reconciliationRequired: false,
        settlementDeferred: true,
        deferredByCheckoutId: activation.deferredByCheckoutId,
      } as const;
    }
    if (activation.reconciliationRequired) {
      const reconciled = await tx.checkoutSession.update({
        where: { id: current.id },
        data: checkoutSettlementReconciliationData(
          activation.reconciliationReason,
        ),
      });
      return {
        checkout: reconciled,
        subscription: null,
        created: false,
        reconciliationRequired: true,
        settlementDeferred: false,
      } as const;
    }
    const completed = await tx.checkoutSession.update({
      where: { id: current.id },
      data: {
        status: "completed",
        providerInvoiceStatus: "settled",
        providerInvoiceAdditionalStatus:
          current.providerInvoiceAdditionalStatus ?? "none",
        failureCode: null,
        needsReconciliation: false,
      },
    });
    if (activation.created) {
      await createClassifiedAnalyticsEvent(tx, {
        userId: current.userId,
        name: "subscription_started",
        props: {
          planId: current.planId,
          provider: current.provider,
          source,
        },
        sourceEventId: `checkout:${current.id}:subscription_started`,
        sourceService: "billing",
        trustClass: "server_trusted",
      });
    }
    return {
      checkout: completed,
      subscription: activation.subscription,
      created: activation.created,
      reconciliationRequired: false,
      settlementDeferred: false,
    } as const;
  });
}

function checkoutSettlementReconciliationData(reason: string) {
  return {
    status: "provider_unknown",
    providerInvoiceStatus: "settled",
    failureCode: reason,
    needsReconciliation: true,
    reconciliationEvidence: toInputJson({
      schemaVersion: "checkout-settlement-reconciliation-v1",
      reason,
      observedAt: new Date().toISOString(),
    }),
  };
}

async function billingPortal(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const subscription = await prisma.subscription.findFirst({
    where: activeSubscriptionWhere(user.id),
    include: { plan: true },
    orderBy: { createdAt: "desc" },
  });

  if (!subscription) {
    return ok({
      mode: "subscribe",
      url: "/upgrade",
      subscription: null,
      billingAccess: null,
      message: "No active paid access. Compare plans to buy access.",
    });
  }

  const billingAccess = billingAccessDTO(subscription);
  return ok({
    mode: "access",
    url: "/profile#billing",
    subscription: await publicSubscriptionDTO(subscription),
    billingAccess,
    message:
      billingAccess.billingModel === "prepaid_period"
        ? "Your prepaid benefits remain active until the displayed end date and do not renew automatically."
        : "Your active billing access is shown in Profile.",
  });
}

async function cancelSubscription(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const subscription = await prisma.subscription.findFirst({
    where: activeSubscriptionWhere(user.id),
    include: { plan: true },
    orderBy: { createdAt: "desc" },
  });
  if (!subscription) throw Errors.badRequest("No active subscription to cancel.");
  assertRenewalMutationSupported(subscription);
  if (subscription.cancelAtPeriodEnd) {
    return ok({
      subscription: await publicSubscriptionDTO(subscription),
      billingAccess: billingAccessDTO(subscription),
      message: "Renewal is already canceled.",
    });
  }

  const updated = await prisma.subscription.update({
    where: { id: subscription.id },
    data: { cancelAtPeriodEnd: true },
    include: { plan: true },
  });
  await trackEvent(
    "subscription_cancel_requested",
    { planId: updated.planId, provider: updated.provider, source: "profile" },
    ctx,
  );
  return ok({
    subscription: await publicSubscriptionDTO(updated),
    billingAccess: billingAccessDTO(updated),
    message: "Renewal canceled. Benefits stay active until the current period ends.",
  });
}

async function resumeSubscription(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const subscription = await prisma.subscription.findFirst({
    where: activeSubscriptionWhere(user.id),
    include: { plan: true },
    orderBy: { createdAt: "desc" },
  });
  if (!subscription) throw Errors.badRequest("No active subscription.");
  assertRenewalMutationSupported(subscription);
  if (!subscription.cancelAtPeriodEnd) {
    throw Errors.badRequest("No canceled renewal to resume.");
  }

  const updated = await prisma.subscription.update({
    where: { id: subscription.id },
    data: { cancelAtPeriodEnd: false },
    include: { plan: true },
  });
  await trackEvent(
    "subscription_resume_requested",
    { planId: updated.planId, provider: updated.provider, source: "profile" },
    ctx,
  );
  return ok({
    subscription: await publicSubscriptionDTO(updated),
    billingAccess: billingAccessDTO(updated),
    message: "Renewal resumed.",
  });
}

async function billingWebhook(request: Request, provider: string) {
  if (provider !== env.PAYMENT_PROVIDER) {
    throw Errors.badRequest("Webhook provider does not match the configured payment provider");
  }
  const rawBody = await bodyText(request);
  const payload = parseJsonText(rawBody);
  const eventId =
    request.headers.get("x-provider-event-id") ??
    (isRecord(payload) && typeof payload.providerEventId === "string"
      ? payload.providerEventId
      : isRecord(payload) && typeof payload.deliveryId === "string"
        ? payload.deliveryId
        : isRecord(payload) && typeof payload.id === "string"
          ? payload.id
      : cryptoRandomId("evt"));
  const parsed = await providers.payment.parseWebhook({
    providerEventId: eventId,
    payload,
    signature:
      request.headers.get("btcpay-sig") ??
      request.headers.get("x-signature") ??
      undefined,
    rawBody,
  });
  if (!parsed.ok) throw Errors.badRequest(parsed.error.message, parsed.error);
  const providerEventId = parsed.data.providerEventId;
  const payloadHash = createHash("sha256").update(rawBody).digest("hex");
  const targetHash = billingProviderEventTargetHash(parsed.data);

  let event = await prisma.providerEvent.upsert({
    where: { provider_providerEventId: { provider, providerEventId } },
    update: {},
    create: {
      provider,
      providerEventId,
      type: parsed.data.type,
      payload: toInputJson(payload),
      targetHash,
    },
  });
  if (event.type !== parsed.data.type) {
    throw Errors.conflict("Provider event type changed across deliveries", {
      providerEventId,
    });
  }
  if (!event.targetHash) {
    await prisma.providerEvent.updateMany({
      where: { id: event.id, targetHash: null },
      data: { targetHash },
    });
    event = await prisma.providerEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
  }
  if (event.targetHash !== targetHash) {
    throw Errors.conflict("Provider event target changed across deliveries", {
      providerEventId,
    });
  }
  const delivery = await prisma.providerEventDelivery.upsert({
    where: {
      eventId_deliveryId: {
        eventId: event.id,
        deliveryId: parsed.data.deliveryId,
      },
    },
    update: {},
    create: {
      eventId: event.id,
      deliveryId: parsed.data.deliveryId,
      payload: toInputJson(payload),
      payloadHash,
    },
  });
  if (delivery.payloadHash !== payloadHash) {
    throw Errors.conflict("Provider delivery payload changed for the same delivery id", {
      providerEventId,
      deliveryId: parsed.data.deliveryId,
    });
  }

  let verifiedOrderInvoice: PaymentInvoice | null = null;
  if (
    parsed.data.type === "invoice.confirmed" &&
    parsed.data.invoiceId &&
    parsed.data.orderId
  ) {
    const alreadyBound = await prisma.checkoutSession.findUnique({
      where: {
        provider_providerSessionId: {
          provider,
          providerSessionId: parsed.data.invoiceId,
        },
      },
      select: { id: true },
    });
    if (!alreadyBound) {
      const lookup = await paymentProviderRequestWithDeadline(
        "invoice_lookup_timeout",
        (signal) =>
          providers.payment.findInvoiceByOrderId({
            orderId: parsed.data.orderId!,
            signal,
          }),
      );
      if (!lookup.ok) {
        throw Errors.unavailable(
          "Payment provider lookup is temporarily unavailable",
          lookup.error,
        );
      }
      if (!lookup.data) {
        throw Errors.unavailable(
          "Settled payment could not yet be verified by its provider order id",
          { orderId: parsed.data.orderId },
        );
      }
      if (
        lookup.data.provider !== provider ||
        lookup.data.invoiceId !== parsed.data.invoiceId ||
        lookup.data.status !== "settled"
      ) {
        throw Errors.conflict(
          "Webhook settlement does not match the provider invoice authority",
          {
            invoiceId: parsed.data.invoiceId,
            orderId: parsed.data.orderId,
          },
        );
      }
      verifiedOrderInvoice = lookup.data;
    }
  }

  type BillingWebhookSettlement = {
    processed: boolean;
    idempotent?: boolean;
    deferred?: boolean;
    reconciliationRequired?: boolean;
  };

  const result: BillingWebhookSettlement = await prisma.$transaction(async (tx) => {
    // Lock the provider event while settling. processedAt is written LAST, so a
    // failed activation/checkout update rolls back and remains retryable.
    await lockProviderEvent(tx, event.id);
    const current = await tx.providerEvent.findUniqueOrThrow({ where: { id: event.id } });
    if (current.processedAt) return { processed: false, idempotent: true };

    if (parsed.data.type === "invoice.ignored") {
      await tx.providerEvent.update({
        where: { id: event.id },
        data: { processedAt: new Date() },
      });
      return { processed: true };
    }

    if (!parsed.data.invoiceId) {
      throw Errors.badRequest("Confirmed payment webhook is missing an invoice id");
    }

    let checkoutIdentity = await tx.checkoutSession.findUnique({
      where: {
        provider_providerSessionId: {
          provider,
          providerSessionId: parsed.data.invoiceId,
        },
      },
      select: { id: true },
    });
    if (
      checkoutIdentity &&
      parsed.data.orderId &&
      checkoutIdentity.id !== parsed.data.orderId
    ) {
      throw Errors.conflict("Webhook order does not match its invoice checkout", {
        checkoutId: checkoutIdentity.id,
      });
    }
    if (!checkoutIdentity && parsed.data.orderId) {
      const byOrderId = await tx.checkoutSession.findUnique({
        where: { id: parsed.data.orderId },
        select: { id: true, provider: true },
      });
      if (byOrderId?.provider === provider) {
        checkoutIdentity = { id: byOrderId.id };
      }
    }
    if (!checkoutIdentity) {
      return { processed: false, deferred: true };
    }

    // Every path locks the checkout before inspecting or binding its provider
    // invoice. Distinct provider events can settle concurrently, so any state
    // read before this lock is only an identity hint, never mutation authority.
    await lockCheckoutSession(tx, checkoutIdentity.id);
    let checkoutSession = await tx.checkoutSession.findUniqueOrThrow({
      where: { id: checkoutIdentity.id },
    });
    if (checkoutSession.provider !== provider) {
      throw Errors.conflict("Webhook provider does not match the checkout", {
        checkoutId: checkoutSession.id,
      });
    }
    if (
      parsed.data.orderId &&
      checkoutSession.id !== parsed.data.orderId
    ) {
      throw Errors.conflict("Webhook order does not match its invoice checkout", {
        checkoutId: checkoutSession.id,
      });
    }
    if (
      checkoutSession.providerSessionId &&
      checkoutSession.providerSessionId !== parsed.data.invoiceId
    ) {
      throw Errors.conflict("Webhook invoice does not match the checkout order", {
        checkoutId: checkoutSession.id,
      });
    }
    if (isLateSettledAbandonedCheckout(checkoutSession)) {
      await tx.providerEvent.update({
        where: { id: event.id },
        data: { processedAt: new Date() },
      });
      return { processed: true, reconciliationRequired: true };
    }
    if (isCheckoutReconciliationResolved(checkoutSession)) {
      await tx.providerEvent.update({
        where: { id: event.id },
        data: { processedAt: new Date() },
      });
      return { processed: true, idempotent: true };
    }
    if (
      isCheckoutAbandonedTerminal(checkoutSession) &&
      checkoutSession.providerSessionId
    ) {
      await tx.checkoutSession.update({
        where: { id: checkoutSession.id },
        data: lateSettledCheckoutData(checkoutSession.reconciliationEvidence, {
          provider,
          invoiceId: checkoutSession.providerSessionId,
          checkoutUrl: checkoutSession.checkoutUrl,
          additionalStatus: paymentInvoiceAdditionalStatus(
            checkoutSession.providerInvoiceAdditionalStatus,
          ),
        }),
      });
      await tx.providerEvent.update({
        where: { id: event.id },
        data: { processedAt: new Date() },
      });
      return { processed: true, reconciliationRequired: true };
    }
    if (!checkoutSession.providerSessionId) {
      if (!verifiedOrderInvoice) {
        return { processed: false, deferred: true };
      }
      assertRecoveredInvoiceMatchesCheckout(
        checkoutSession,
        verifiedOrderInvoice,
      );
      if (isProviderMissingCheckoutTerminal(checkoutSession)) {
        await tx.checkoutSession.update({
          where: { id: checkoutSession.id },
          data: lateSettledCheckoutData(
            checkoutSession.reconciliationEvidence,
            verifiedOrderInvoice,
          ),
        });
        await tx.providerEvent.update({
          where: { id: event.id },
          data: { processedAt: new Date() },
        });
        return { processed: true, reconciliationRequired: true };
      }
      checkoutSession = await tx.checkoutSession.update({
        where: { id: checkoutSession.id },
        data: {
          providerSessionId: verifiedOrderInvoice.invoiceId,
          checkoutUrl: verifiedOrderInvoice.checkoutUrl,
          providerInvoiceStatus: "settled",
          providerInvoiceAdditionalStatus:
            verifiedOrderInvoice.additionalStatus,
          status:
            checkoutSession.status === "completed"
              ? "completed"
              : "provider_settled",
          failureCode:
            checkoutSession.status === "completed"
              ? checkoutSession.failureCode
              : null,
          needsReconciliation:
            checkoutSession.status === "completed"
              ? checkoutSession.needsReconciliation
              : false,
          providerLookupMissCount: 0,
          providerLastLookupAt: new Date(),
        },
      });
    }
    if (checkoutSession.providerSessionId !== parsed.data.invoiceId) {
      throw Errors.conflict("Checkout invoice changed before webhook settlement", {
        checkoutId: checkoutSession.id,
      });
    }
    if (checkoutSession.status === "completed") {
      await tx.checkoutSession.update({
        where: { id: checkoutSession.id },
        data: {
          providerInvoiceStatus: "settled",
          providerInvoiceAdditionalStatus:
            checkoutSession.providerInvoiceAdditionalStatus ?? "none",
        },
      });
      await tx.providerEvent.update({
        where: { id: event.id },
        data: { processedAt: new Date() },
      });
      return { processed: true, idempotent: true };
    }
    if (!checkoutSession.planId) {
      return { processed: false, deferred: true };
    }

    const offerSnapshot = checkoutOfferSnapshotSchema.safeParse(
      checkoutSession.offerSnapshot,
    );
    if (
      !offerSnapshot.success ||
      offerSnapshot.data.planId !== checkoutSession.planId
    ) {
      return { processed: false, deferred: true };
    }
    const activation = await activateSubscriptionInTx(
      tx,
      checkoutSession.userId,
      checkoutSession.planId,
      parsed.data.invoiceId,
      provider,
      offerSnapshot.data,
      {
        checkoutId: checkoutSession.id,
        createdAt: checkoutSession.createdAt,
      },
    );
    if (activation.settlementDeferred) {
      return { processed: false, deferred: true };
    }
    if (activation.reconciliationRequired) {
      await tx.checkoutSession.update({
        where: { id: checkoutSession.id },
        data: checkoutSettlementReconciliationData(
          activation.reconciliationReason,
        ),
      });
      await tx.providerEvent.update({
        where: { id: event.id },
        data: { processedAt: new Date() },
      });
      return { processed: true, reconciliationRequired: true };
    }
    await tx.checkoutSession.update({
      where: { id: checkoutSession.id },
      data: {
        status: "completed",
        providerInvoiceStatus: "settled",
        providerInvoiceAdditionalStatus:
          checkoutSession.providerInvoiceAdditionalStatus ?? "none",
        failureCode: null,
        needsReconciliation: false,
      },
    });
    if (activation.created) {
      await createClassifiedAnalyticsEvent(tx, {
        userId: checkoutSession.userId,
        name: "subscription_started",
        props: {
          planId: checkoutSession.planId,
          provider,
          source: "webhook",
        },
        sourceEventId: `checkout:${checkoutSession.id}:subscription_started`,
        sourceService: "billing",
        trustClass: "server_trusted",
      });
    }

    await tx.providerEvent.update({
      where: { id: event.id },
      data: { processedAt: new Date() },
    });
    return { processed: true };
  });

  if (result.deferred) {
    throw Errors.unavailable(
      "Payment event is valid but its checkout intent is not available yet; retry delivery.",
      { providerEventId, deferred: true },
    );
  }
  return ok(result);
}

async function dreamcoins(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const [balance, ledger] = await Promise.all([
    dreamcoinBalance(user.id),
    prisma.dreamcoinLedger.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);
  return ok({ balance, ledger });
}

async function library(request: Request, tab: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);

  if (tab === "recent") {
    // Chat remains authoritative in the chat service, but the library home must
    // still feel populated if the event-fed recent_chats projection lags.
    const [sessions, likedCharacters, createdCharacters, media] = await Promise.all([
      prisma.recentChat.findMany({
        where: { userId: user.id, status: { not: "deleted" } },
        include: { character: { include: characterInclude(user.id) } },
        orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
        take: 12,
      }),
      prisma.characterLike.findMany({
        where: { userId: user.id },
        include: { character: { include: characterInclude(user.id) } },
        orderBy: { createdAt: "desc" },
        take: 12,
      }),
      prisma.character.findMany({
        where: { creatorId: user.id, deletedAt: null },
        include: characterInclude(user.id),
        orderBy: { createdAt: "desc" },
        take: 12,
      }),
      prisma.mediaAsset.findMany({
        where: { ownerId: user.id, deletedAt: null },
        orderBy: { createdAt: "desc" },
        take: 12,
      }),
    ]);

    const entries = new Map<string, { item: Record<string, unknown>; sortAt: Date }>();
    const addEntry = (key: string, item: Record<string, unknown>, sortAt: Date) => {
      const existing = entries.get(key);
      if (!existing || existing.sortAt < sortAt) entries.set(key, { item, sortAt });
    };

    for (const session of sessions) {
      const character = characterDTO(session.character, user.id);
      addEntry(
        `chat:${session.sessionId}`,
        {
          id: session.sessionId,
          type: "chat",
          title: session.title ?? character.title,
          character,
          createdAt: session.createdAt,
        },
        session.lastMessageAt ?? session.createdAt,
      );
    }
    for (const like of likedCharacters) {
      addEntry(`character:${like.characterId}`, characterDTO(like.character, user.id), like.createdAt);
    }
    for (const character of createdCharacters) {
      addEntry(`character:${character.id}`, characterDTO(character, user.id), character.createdAt);
    }
    for (const asset of media) {
      addEntry(`media:${asset.id}`, mediaDTO(asset), asset.createdAt);
    }

    const items = [...entries.values()]
      .sort((a, b) => b.sortAt.getTime() - a.sortAt.getTime())
      .slice(0, 12)
      .map((entry) => entry.item);
    return ok({ items });
  }

  if (tab === "characters") {
    const likes = await prisma.characterLike.findMany({
      where: { userId: user.id },
      include: { character: { include: characterInclude(user.id) } },
      orderBy: { createdAt: "desc" },
    });
    return ok({ items: likes.map((like) => characterDTO(like.character, user.id)) });
  }

  if (tab === "created") {
    const characters = await prisma.character.findMany({
      where: { creatorId: user.id, deletedAt: null },
      include: characterInclude(user.id),
      orderBy: { createdAt: "desc" },
    });
    return ok({ items: characters.map((character) => characterDTO(character, user.id)) });
  }

  if (tab === "presets") {
    const presets = await prisma.generationPreset.findMany({
      where: { ownerId: user.id, status: "active" },
      orderBy: { updatedAt: "desc" },
    });
    return ok({ items: presets });
  }

  if (tab === "media") return listMedia(request);
  if (tab === "group-chats" || tab === "packs") {
    return ok({ items: [], emptyCta: null });
  }

  throw Errors.notFound("Library tab not found");
}

async function profile(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const [fullUser, balance, subscription, entitlements, availability] = await Promise.all([
    prisma.user.findUnique({ where: { id: user.id }, include: { preferences: true } }),
    dreamcoinBalance(user.id),
    prisma.subscription.findFirst({
      where: activeSubscriptionWhere(user.id),
      include: { plan: true },
      orderBy: { createdAt: "desc" },
    }),
    entitlementMap(user.id),
    publicOfferAvailability(),
  ]);
  const publicSubscription = subscription
    ? await publicSubscriptionDTO(subscription)
    : null;
  return ok({
    user: fullUser,
    balance,
    subscription: publicSubscription,
    billingAccess: subscription ? billingAccessDTO(subscription) : null,
    entitlements: publicFeatureProjection(entitlements, availability),
  });
}

async function updateProfile(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const body = profilePatchSchema.parse(await jsonBody(request));
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      displayName: body.displayName,
      name: body.displayName,
      image: body.image,
    },
  });
  return ok({ user: userDTO(updated) });
}

async function profilePreferences(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const preferences = await readPreferences(user.id);
  return ok({ preferences });
}

async function updatePreferences(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const body = preferencesPatchSchema.parse(await jsonBody(request));
  const mutedTags = body.mutedTags ? normalizeMutedTags(body.mutedTags) : undefined;
  const preferences = await prisma.userPreferences.upsert({
    where: { userId: user.id },
    update: {
      locale: body.locale,
      mutedTags: mutedTags ? toInputJson(mutedTags) : undefined,
      safeModeFlags: body.safeModeFlags ? toInputJson(body.safeModeFlags) : undefined,
      notificationSettings: body.notificationSettings
        ? toInputJson(body.notificationSettings)
        : undefined,
    },
    create: {
      userId: user.id,
      locale: body.locale ?? "en",
      mutedTags: toInputJson(mutedTags ?? []),
      safeModeFlags: toInputJson(body.safeModeFlags ?? {}),
      notificationSettings: toInputJson(body.notificationSettings ?? {}),
    },
  });
  return ok({ preferences });
}

async function updateLanguage(request: Request) {
  const body = z.object({ locale: z.string().min(2).max(16) }).parse(await jsonBody(request));
  const nextRequest = new Request(request.url, {
    method: "PATCH",
    headers: request.headers,
    body: JSON.stringify({ locale: body.locale }),
  });
  return updatePreferences(nextRequest);
}

async function redeemCode(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const body = redeemSchema.parse(await jsonBody(request));
  const code = await prisma.redeemCode.findFirst({
    where: { codeHash: { in: redeemCodeHashCandidates(body.code) } },
    orderBy: { createdAt: "desc" },
  });
  if (!code || code.status !== "active" || (code.expiresAt && code.expiresAt < new Date())) {
    throw Errors.notFound("Redeem code not found");
  }
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM redeem_codes WHERE id = ${code.id} FOR UPDATE`;
    const lockedCode = await tx.redeemCode.findUnique({
      where: { id: code.id },
    });
    if (
      !lockedCode ||
      lockedCode.status !== "active" ||
      (lockedCode.expiresAt && lockedCode.expiresAt < new Date())
    ) {
      throw Errors.notFound("Redeem code not found");
    }
    const coins = redeemCodeDreamcoins(lockedCode.reward);
    if (coins === null) {
      logger.error(
        {
          redeemCodeId: lockedCode.id,
          rewardType:
            lockedCode.reward === null
              ? "null"
              : Array.isArray(lockedCode.reward)
                ? "array"
                : typeof lockedCode.reward,
        },
        "redeem code reward authority is invalid",
      );
      throw Errors.internal("Redeem code reward is invalid");
    }

    // Reward exactly once per user — surface a graceful conflict on replay.
    const already = await tx.redeemCodeRedemption.findUnique({
      where: {
        redeemCodeId_userId: {
          redeemCodeId: lockedCode.id,
          userId: user.id,
        },
      },
    });
    if (already) throw Errors.conflict("Code already redeemed");

    if (lockedCode.maxRedemptions !== null) {
      const redemptions = await tx.redeemCodeRedemption.count({
        where: { redeemCodeId: lockedCode.id },
      });
      if (redemptions >= lockedCode.maxRedemptions) {
        throw Errors.conflict("Code redemption limit reached");
      }
    }

    const created = await tx.redeemCodeRedemption.create({
      data: { redeemCodeId: lockedCode.id, userId: user.id },
    });
    await appendLedger(tx, user.id, coins, "redeem", created.id);
    return { coins, redemption: created };
  });

  return ok({ redemption: result.redemption, dreamcoins: result.coins });
}

async function referrals(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const referrals = await prisma.referral.findMany({
    where: { inviterId: user.id },
    orderBy: { createdAt: "desc" },
  });
  return ok({ code: referralCode(user.id), referrals });
}

async function inviteReferral(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const code = referralCode(user.id);
  const existing = await prisma.referral.findFirst({
    where: { inviterId: user.id, code, inviteeId: null },
    orderBy: { createdAt: "asc" },
  });
  const referral =
    existing ??
    (await prisma.referral.create({
      data: {
        inviterId: user.id,
        code,
      },
    }));
  return ok({ referral, shareUrl: `/signup?ref=${referral.code}` });
}

async function signOutAll(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  await prisma.session.deleteMany({ where: { userId: user.id } });
  const response = ok({ signedOut: true });
  response.headers.append("set-cookie", clearSessionCookie());
  return response;
}

async function deleteRequest(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const eventId = `user_deleted_${user.id}`;
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { status: "deleted", deletedAt: new Date() },
    });
    await tx.session.deleteMany({ where: { userId: user.id } });
    await recordMainToChatEvent({
      eventId,
      eventType: MAIN_TO_CHAT_EVENTS.userDeleted,
      aggregateType: "user",
      aggregateId: user.id,
      payload: { userId: user.id },
    }, tx);
  });

  // The response is authorized by the committed Main transaction above.
  // Immediate dispatch is only a latency optimization: the durable pending row
  // remains retryable when Chat ingress or the BullMQ fallback is unavailable.
  try {
    await dispatchPendingChatEvents();
  } catch (error) {
    logger.error({ error, userId: user.id }, "failed to dispatch durable chat account erasure");
  }

  const response = ok({ requested: true });
  response.headers.append("set-cookie", clearSessionCookie());
  return response;
}

async function submitReport(
  request: Request,
  preset?: { targetType: string; targetId: string },
) {
  const ctx = await getAuthCtx(request);
  const body = reportSchema.partial({ targetType: true, targetId: true }).parse(await jsonBody(request));
  const targetType = preset?.targetType ?? body.targetType;
  const targetId = preset?.targetId ?? body.targetId;
  if (!targetType || !targetId || !body.category) {
    throw Errors.badRequest("targetType, targetId, and category are required");
  }
  const underage = body.category.includes("underage");
  const priority = underage ? 1 : 3;
  const report = await prisma.$transaction(async (tx) => {
    const created = await tx.contentReport.create({
      data: {
        reporterId: ctx.userId,
        targetType,
        targetId,
        category: body.category,
        description: body.description,
        priority,
      },
    });
    await tx.moderationEvent.create({
      data: {
        targetType,
        targetId,
        layer: "community_report",
        status: "flagged",
        policyCode: body.category,
        confidence: 1,
        details: { reportId: created.id },
      },
    });
    await ensureReviewCaseForReport(tx, created);
    return created;
  });

  // Compliance (roadmap M9 / spec §4.4): underage reports are priority 1 and
  // immediately hide the target pending human review — over-hiding is the safe
  // failure mode for CSAM-adjacent reports. Auto-hide is best-effort: if the
  // target can't be resolved we still record + triage the priority-1 report
  // rather than failing the submission.
  if (underage) {
    try {
      await applyModerationAction(targetType, targetId, body.category);
    } catch (error) {
      logger.error(
        { error, targetType, targetId },
        "underage auto-takedown could not resolve target; escalating via triage",
      );
    }
  }
  // The flagged moderationEvent + priority on the contentReport above are the
  // triage record the admin review queue reads — no separate async triage pass.
  await trackEvent("content_reported", { targetType, targetId, category: body.category }, ctx);
  return ok({ report });
}

async function reportStatus(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const report = await prisma.contentReport.findFirst({
    where: {
      id,
      OR: [{ reporterId: user.id }, { reporterId: null }],
    },
    include: { reviews: true },
  });
  if (!report) throw Errors.notFound("Report not found");
  return ok({ report });
}

async function createAppeal(request: Request) {
  const ctx = await getAuthCtx(request);
  requireAgeGate(ctx);
  const user = requireUser(ctx);
  const body = z
    .object({
      targetType: appealTargetTypeSchema,
      targetId: z.string().trim().min(1).max(300),
      appealText: z.string().min(1).max(4_000),
      originalDecisionId: z.string().trim().min(1).max(160).optional(),
    })
    .parse(await jsonBody(request));
  const appeal = await prisma.$transaction(async (tx) => {
    const created = await tx.appeal.create({
      data: { userId: user.id, ...body },
    });
    await ensureReviewCaseForAppeal(tx, created);
    return created;
  });
  await trackEvent("moderation_appeal_started", { appealId: appeal.id }, ctx);
  return ok({ appeal });
}

async function policies() {
  const items = await prisma.policyVersion.findMany({
    orderBy: [{ slug: "asc" }, { publishedAt: "desc" }],
  });
  return ok({ items });
}

async function track(request: Request) {
  const ctx = await getAuthCtx(request);
  const body = eventSchema.parse(await jsonBody(request));
  if (body.name === METRIC_PRODUCT_EVENTS.experimentExposed) {
    requireAgeGate(ctx);
    const exposure = experimentExposureClientSchema.parse(body.props);
    const subject = metricExposureSubject(ctx.userId, ctx.anonymousId);
    if (!subject) throw Errors.badRequest("Experiment exposure needs an authenticated or anonymous subject");
    const assignment = await prisma.experimentAssignment.findUnique({ where: { id: exposure.assignmentId } });
    if (!assignment || assignment.subjectType !== subject.subjectType || assignment.subjectId !== subject.subjectId) {
      throw Errors.badRequest("Experiment assignment does not belong to the current subject");
    }
    const recorded = await recordExperimentExposure(prisma, {
      ...exposure,
      occurredAt: new Date().toISOString(),
    }, { environment: env.APP_ENV });
    return ok({ exposure: recorded });
  }
  if (body.name === METRIC_PRODUCT_EVENTS.characterExposureRecorded) {
    requireAgeGate(ctx);
    const exposure = characterExposureClientSchema.parse(body.props);
    const subject = metricExposureSubject(ctx.userId, ctx.anonymousId);
    if (!subject) throw Errors.badRequest("Character exposure needs an authenticated or anonymous subject");
    const signedContext = verifyExposureContext(
      exposure.contextToken,
      subject,
      env.BETTER_AUTH_SECRET,
    );
    if (!signedContext) throw Errors.badRequest("Character exposure context is invalid or expired");
    const expectedExposureId = exposure.eventType === "eligible_impression"
      ? signedContext.impressionExposureId
      : signedContext.detailExposureId;
    const expectedParentId = exposure.eventType === "eligible_impression"
      ? null
      : signedContext.impressionExposureId;
    if (
      exposure.exposureId !== expectedExposureId ||
      exposure.parentExposureId !== expectedParentId ||
      exposure.journeyId !== signedContext.journeyId ||
      exposure.characterId !== signedContext.characterId ||
      exposure.placementId !== signedContext.placementId
    ) {
      throw Errors.badRequest("Character exposure does not match its signed context");
    }
    const authority = await prisma.character.findFirst({
      where: {
        AND: [
          publicCharacterAudienceWhere,
          { id: signedContext.characterId },
        ],
      },
      select: { id: true },
    });
    if (!authority) throw Errors.notFound("Live Character not found");
    const release = await prisma.characterRelease.findFirst({
      where: {
        id: signedContext.characterReleaseId,
        characterContentVersionId: signedContext.characterContentVersionId,
        status: "published",
      },
    });
    if (!release) throw Errors.conflict("Signed Character Release attribution is no longer valid");
    const contentVersion = await prisma.characterContentVersion.findUnique({
      where: { id: signedContext.characterContentVersionId },
      select: { id: true, characterId: true },
    });
    if (!contentVersion || contentVersion.characterId !== authority.id) {
      throw Errors.conflict("Character Release attribution is inconsistent");
    }
    const payload = characterExposureRecordedV2Schema.parse({
      exposureId: exposure.exposureId,
      eventType: exposure.eventType,
      parentExposureId: exposure.parentExposureId,
      journeyId: exposure.journeyId,
      characterId: exposure.characterId,
      placementId: exposure.placementId,
      visibleRatio: exposure.visibleRatio,
      visibleDurationMs: exposure.visibleDurationMs,
      userId: ctx.userId ?? null,
      anonymousId: ctx.userId ? null : (ctx.anonymousId ?? null),
      characterContentVersionId: contentVersion.id,
      characterReleaseId: release.id,
    });
    const event = await prisma.$transaction((tx) => appendCanonicalMetricEvent(tx, {
      sourceEventId: `character_exposure:${payload.exposureId}`,
      eventType: METRIC_PRODUCT_EVENTS.characterExposureRecorded,
      occurredAt: new Date(),
      userId: payload.userId,
      anonymousId: payload.anonymousId,
      trustClass: "typed_client",
      context: {
        servingVersion: signedContext.servingVersion,
        exposureContextVersion: signedContext.version,
      },
      payload,
    }));
    return ok({ event });
  }
  const event = await trackEvent(body.name, body.props, ctx);
  return ok({ event });
}

async function submitSupportRequest(request: Request) {
  const ctx = await getAuthCtx(request);
  requireAgeGate(ctx);
  const user = requireUser(ctx);
  const body = supportRequestSchema.parse(await jsonBody(request));
  const ticketId = supportTicketId();
  const supportRequest = await prisma.$transaction(async (tx) => {
    const created = await tx.supportRequest.create({
      data: {
        ticketId,
        userId: user.id,
        category: body.category,
        subject: body.subject,
        description: body.description,
        diagnosticConsent: body.diagnosticConsent,
        sourcePath: body.sourcePath ?? null,
        status: "received",
      },
    });
    await createClassifiedAnalyticsEvent(tx, {
      userId: user.id,
      anonymousId: ctx.anonymousId,
      name: "support_request_submitted",
      props: {
        ticketId,
        supportRequestId: created.id,
        category: body.category,
        subject: body.subject,
        description: body.description,
        diagnosticConsent: body.diagnosticConsent,
        sourcePath: body.sourcePath ?? null,
      },
    });
    await appendCanonicalMetricEvent(tx, {
      sourceEventId: `support_request:${created.id}`,
      eventType: METRIC_PRODUCT_EVENTS.supportRequestSubmitted,
      occurredAt: created.createdAt,
      userId: user.id,
      anonymousId: ctx.anonymousId,
      payload: {
        supportRequestId: created.id,
        userId: user.id,
        category: created.category,
      },
    });
    await ensureSupportCaseForRequest(tx, created);
    return created;
  });

  return ok(
    {
      request: {
        id: supportRequest.id,
        ticketId,
        status: supportRequest.status,
        category: supportRequest.category,
        createdAt: supportRequest.createdAt.toISOString(),
      },
    },
    { status: 201 },
  );
}

async function listFeedbackItems(request: Request) {
  const ctx = await getAuthCtx(request);
  const items = await prisma.productFeedbackItem.findMany({
    where: publicFeedbackAudienceWhere,
    orderBy: [{ voteCount: "desc" }, { createdAt: "desc" }],
    take: 12,
  });
  const votedIds = await userFeedbackVoteIds(ctx.userId, items.map((item) => item.id));
  return ok({ items: items.map((item) => feedbackItemDTO(item, votedIds)) });
}

async function createFeedbackItem(request: Request) {
  const ctx = await getAuthCtx(request);
  requireAgeGate(ctx);
  const user = requireUser(ctx);
  const body = feedbackItemCreateSchema.parse(await jsonBody(request));
  const countsAsEngagement = await isCustomerEngagementActor(user.id);
  const created = await prisma.$transaction(async (tx) => {
    const item = await tx.productFeedbackItem.create({
      data: {
        createdById: user.id,
        source: "user",
        title: body.title,
        description: body.description,
        category: body.category,
        status: "under_review",
        voteCount: countsAsEngagement ? 1 : 0,
      },
    });
    await tx.productFeedbackVote.create({
      data: { userId: user.id, itemId: item.id },
    });
    await createClassifiedAnalyticsEvent(tx, {
      userId: user.id,
      anonymousId: ctx.anonymousId,
      name: "feedback_item_created",
      props: {
        itemId: item.id,
        category: item.category,
        title: item.title,
      },
    });
    return item;
  });
  return ok({ item: feedbackItemDTO(created, new Set([created.id])) }, { status: 201 });
}

async function voteFeedbackItem(request: Request, itemId: string) {
  const ctx = await getAuthCtx(request);
  requireAgeGate(ctx);
  const user = requireUser(ctx);
  const countsAsEngagement = await isCustomerEngagementActor(user.id);
  const item = await prisma.$transaction(async (tx) => {
    const existingItem = await tx.productFeedbackItem.findFirst({
      where: { AND: [publicFeedbackAudienceWhere, { id: itemId }] },
    });
    if (!existingItem) throw Errors.notFound("Feedback item not found");
    const existingVote = await tx.productFeedbackVote.findUnique({
      where: { userId_itemId: { userId: user.id, itemId } },
    });
    if (existingVote) return existingItem;
    await tx.productFeedbackVote.create({ data: { userId: user.id, itemId } });
    const updated = countsAsEngagement
      ? await tx.productFeedbackItem.update({
          where: { id: itemId },
          data: { voteCount: { increment: 1 } },
        })
      : existingItem;
    await createClassifiedAnalyticsEvent(tx, {
      userId: user.id,
      anonymousId: ctx.anonymousId,
      name: "feedback_item_voted",
      props: { itemId },
    });
    return updated;
  });
  return ok({ item: feedbackItemDTO(item, new Set([item.id])) });
}

async function unvoteFeedbackItem(request: Request, itemId: string) {
  const ctx = await getAuthCtx(request);
  requireAgeGate(ctx);
  const user = requireUser(ctx);
  const countsAsEngagement = await isCustomerEngagementActor(user.id);
  const item = await prisma.$transaction(async (tx) => {
    const existingItem = await tx.productFeedbackItem.findFirst({
      where: { AND: [publicFeedbackAudienceWhere, { id: itemId }] },
    });
    if (!existingItem) throw Errors.notFound("Feedback item not found");
    const existingVote = await tx.productFeedbackVote.findUnique({
      where: { userId_itemId: { userId: user.id, itemId } },
    });
    if (!existingVote) return existingItem;
    await tx.productFeedbackVote.delete({ where: { id: existingVote.id } });
    const updated = countsAsEngagement
      ? await tx.productFeedbackItem.update({
          where: { id: itemId },
          data: { voteCount: { decrement: 1 } },
        })
      : existingItem;
    await createClassifiedAnalyticsEvent(tx, {
      userId: user.id,
      anonymousId: ctx.anonymousId,
      name: "feedback_item_unvoted",
      props: { itemId },
    });
    return updated;
  });
  return ok({ item: feedbackItemDTO(item, new Set()) });
}

async function userFeedbackVoteIds(userId: string | undefined, itemIds: string[]) {
  if (!userId || itemIds.length === 0) return new Set<string>();
  const votes = await prisma.productFeedbackVote.findMany({
    where: { userId, itemId: { in: itemIds } },
    select: { itemId: true },
  });
  return new Set(votes.map((vote) => vote.itemId));
}

function feedbackItemDTO(item: ProductFeedbackItemRow, votedIds: Set<string>) {
  return {
    id: item.id,
    sourceKey: item.sourceKey,
    title: item.title,
    description: item.description,
    category: item.category,
    status: item.status,
    voteCount: Math.max(0, item.voteCount),
    userVoted: votedIds.has(item.id),
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

async function feed(request: Request, segments: string[]) {
  const ctx = await getAuthCtx(request);
  requireAgeGate(ctx);
  const [, action, itemId, subAction] = segments;
  if (request.method === "GET") {
    // 运营策展：feed.featured（AppSetting）里仍 public+approved 的角色仅在首页置顶；
    // recent public collections are interleaved on the first page so Feed is not just a catalog mirror.
    const url = new URL(request.url);
    const limit = clampInt(url.searchParams.get("limit"), 1, 60, 20);
    const cursorState = decodeFeedCursor(url.searchParams.get("cursor"));
    const requestedScopeItemId = feedScopeItemId(url.searchParams.get("item"));
    if (
      cursorState &&
      requestedScopeItemId &&
      cursorState.scopeItemId !== requestedScopeItemId
    ) {
      throw Errors.badRequest("Feed cursor does not match the requested item");
    }
    const requestedItemId =
      cursorState?.scopeItemId ?? requestedScopeItemId;
    const publicWhere = publicCharacterAudienceWhere;

    if (cursorState) {
      const stablePage = await prisma.character.findMany({
        where: {
          AND: [
            publicWhere,
            { createdAt: { lte: cursorState.snapshotAt } },
            cursorState.excludedCharacterIds.length > 0
              ? { id: { notIn: cursorState.excludedCharacterIds } }
              : {},
            cursorState.lastCreatedAt && cursorState.lastId
              ? {
                  OR: [
                    { createdAt: { lt: cursorState.lastCreatedAt } },
                    {
                      createdAt: cursorState.lastCreatedAt,
                      id: { lt: cursorState.lastId },
                    },
                  ],
                }
              : {},
          ],
        },
        include: characterInclude(ctx.userId),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      });
      const page = stablePage.slice(0, limit);
      const lastCharacter = page.at(-1);
      return ok({
        items: page.map(feedCharacterItemDTO),
        focusedItemId: null,
        nextCursor:
          stablePage.length > limit && lastCharacter
            ? encodeFeedCursor({
                scopeItemId: cursorState.scopeItemId,
                snapshotAt: cursorState.snapshotAt,
                expiresAt: cursorState.expiresAt,
                excludedCharacterIds: cursorState.excludedCharacterIds,
                lastCreatedAt: lastCharacter.createdAt,
                lastId: lastCharacter.id,
              })
            : null,
      });
    }

    const snapshotAt = new Date();
    const focusedCharacterId = requestedItemId ? feedCharacterId(requestedItemId) : null;
    const focusedCollectionId = requestedItemId ? feedCollectionId(requestedItemId) : null;
    const snapshotPublicWhere = {
      AND: [publicWhere, { createdAt: { lte: snapshotAt } }],
    } satisfies Prisma.CharacterWhereInput;
    const [featuredSetting, focusedCharacter, focusedCollection] = await Promise.all([
      prisma.appSetting.findUnique({
        where: { key: FEATURED_SETTING_KEY },
      }),
      focusedCharacterId
        ? prisma.character.findFirst({
            where: { AND: [snapshotPublicWhere, { id: focusedCharacterId }] },
            include: characterInclude(ctx.userId),
          })
        : null,
      focusedCollectionId
        ? prisma.mediaCollection.findFirst({
            where: {
              AND: [
                feedPublicCollectionWhere([], focusedCollectionId),
                { createdAt: { lte: snapshotAt } },
              ],
            },
            include: mediaCollectionInclude(true),
          })
        : null,
    ]);
    const focusedItem = focusedCharacter
      ? feedCharacterItemDTO(focusedCharacter)
      : focusedCollection
        ? feedCollectionItemDTO(focusedCollection)
        : null;
    const focusedItemSlotCount = focusedItem ? 1 : 0;
    const collectionLimit = Math.min(
      2,
      Math.floor(limit / 4),
      Math.max(0, limit - focusedItemSlotCount),
    );
    const characterBudget = Math.max(
      0,
      limit - focusedItemSlotCount - collectionLimit,
    );
    const featuredIds = parseFeaturedSetting(featuredSetting?.value).characterIds;
    // Keep at least one live-ranked character in a character-bearing first page.
    // The immutable continuation cursor owns every first-page exclusion, so later
    // requests never recalculate this budget when the client changes `limit`.
    const maxPinnedFeatured = Math.max(0, characterBudget - 1);
    const pinnedFeaturedIds = [
      ...new Set(featuredIds.filter((id) => id !== focusedCharacter?.id)),
    ].slice(0, maxPinnedFeatured);
    const excludedFirstQueryIds = [
      ...new Set(
        [...pinnedFeaturedIds, focusedCharacter?.id].filter(
          (id): id is string => Boolean(id),
        ),
      ),
    ];
    const [popular, featured, recentCollections, publicCharacterCount] = await Promise.all([
      prisma.character.findMany({
        where: {
          AND: [
            snapshotPublicWhere,
            excludedFirstQueryIds.length > 0
              ? { id: { notIn: excludedFirstQueryIds } }
              : {},
          ],
        },
        include: characterInclude(ctx.userId),
        orderBy: [{ stats: { chatsCount: "desc" } }, { createdAt: "desc" }, { id: "desc" }],
        take: characterBudget + 1,
      }),
      pinnedFeaturedIds.length > 0
        ? prisma.character.findMany({
            where: {
              AND: [
                snapshotPublicWhere,
                { id: { in: pinnedFeaturedIds } },
              ],
            },
            include: characterInclude(ctx.userId),
          })
        : [],
      collectionLimit > 0
        ? prisma.mediaCollection.findMany({
            where: {
              AND: [
                feedPublicCollectionWhere(
                  focusedCollection ? [focusedCollection.id] : [],
                ),
                { createdAt: { lte: snapshotAt } },
              ],
            },
            include: mediaCollectionInclude(true),
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: collectionLimit,
          })
        : [],
      prisma.character.count({ where: snapshotPublicWhere }),
    ]);
    const featuredById = new Map(featured.map((character) => [character.id, character]));
    const orderedFeatured = pinnedFeaturedIds
      .map((id) => featuredById.get(id))
      .filter((character): character is (typeof featured)[number] => character !== undefined)
      .slice(0, characterBudget);
    const popularPage = popular.slice(
      0,
      Math.max(0, characterBudget - orderedFeatured.length),
    );
    const characterItems = [...orderedFeatured, ...popularPage].map(feedCharacterItemDTO);
    const collectionItems = recentCollections.map(feedCollectionItemDTO);
    const items = [
      ...(focusedItem ? [focusedItem] : []),
      ...interleaveFeedItems(characterItems, collectionItems),
    ];
    const renderedCharacterIds = [
      ...new Set(
        items.flatMap((item) =>
          item.type === "character" ? [item.character.id] : [],
        ),
      ),
    ];
    return ok({
      items,
      focusedItemId: focusedItem?.id ?? null,
      nextCursor:
        publicCharacterCount > renderedCharacterIds.length
          ? encodeFeedCursor({
              scopeItemId: requestedScopeItemId,
              snapshotAt,
              expiresAt: new Date(snapshotAt.getTime() + FEED_CURSOR_TTL_MS),
              excludedCharacterIds: renderedCharacterIds,
              lastCreatedAt: null,
              lastId: null,
            })
          : null,
    });
  }
  if (request.method === "POST" && action === "restart") return ok({ cursor: null });
  if (action === "items" && itemId && subAction === "like") {
    const character = await feedPublicCharacterByItemId(itemId);
    if (!character) throw Errors.notFound("Feed item not found");
    const characterId = character.id;
    if (request.method === "POST") {
      const user = requireUser(ctx);
      const countsAsEngagement = await isCustomerEngagementActor(user.id);
      // 幂等且并发安全：只有真正插入 like 行的请求才推进统计。
      const createdCount = await prisma.$transaction(async (tx) => {
        const created = await tx.characterLike.createMany({
          data: [{ userId: user.id, characterId }],
          skipDuplicates: true,
        });
        if (created.count > 0 && countsAsEngagement) {
          await tx.characterStats.upsert({
            where: { characterId },
            update: { likesCount: { increment: 1 } },
            create: { characterId, likesCount: 1 },
          });
        }
        return created.count;
      });
      if (createdCount > 0) {
        await trackEvent("feed_item_liked", { itemId }, ctx);
      }
      return ok({ liked: true });
    }
    if (request.method === "DELETE") {
      const user = requireUser(ctx);
      const countsAsEngagement = await isCustomerEngagementActor(user.id);
      // 对称：仅当确实删除了一行 like 才 -1，且永不低于 0。
      const removed = await prisma.characterLike.deleteMany({
        where: { userId: user.id, characterId },
      });
      if (removed.count > 0 && countsAsEngagement) {
        await prisma.characterStats.updateMany({
          where: { characterId, likesCount: { gt: 0 } },
          data: { likesCount: { decrement: 1 } },
        });
      }
      return ok({ liked: false });
    }
  }
  if (request.method === "POST" && action === "items" && itemId && subAction === "remix") {
    const character = await feedPublicCharacterByItemId(itemId);
    if (!character) throw Errors.notFound("Feed item not found");
    const characterId = character.id;
    await trackEvent("feed_item_remixed", { itemId, characterId }, ctx);
    const params = new URLSearchParams({
      characterId,
      remixFeedItemId: `character:${characterId}`,
    });
    return ok({
      remixUrl: `/generate?${params.toString()}`,
      characterId,
      remixFeedItemId: `character:${characterId}`,
    });
  }
  if (request.method === "POST" && action === "items" && itemId && subAction === "share") {
    const canonicalItemId = await canonicalPublicFeedItemId(itemId);
    if (!canonicalItemId) throw Errors.notFound("Feed item not found");
    await trackEvent("feed_item_shared", { itemId: canonicalItemId }, ctx);
    return ok({ shareUrl: `/feed?item=${encodeURIComponent(canonicalItemId)}` });
  }
  if (request.method === "POST" && action === "items" && itemId && subAction === "report") {
    return submitReport(request, {
      targetType: "feed_item",
      targetId: (await canonicalPublicFeedItemId(itemId)) ?? itemId,
    });
  }
  throw Errors.notFound("Feed route not found", {
    path: `/${segments.join("/")}`,
  });
}

function feedCharacterId(itemId: string) {
  let decoded = itemId;
  try {
    decoded = decodeURIComponent(itemId);
  } catch {
    return null;
  }
  return decoded.startsWith("character:") ? decoded.slice("character:".length) : null;
}

function feedScopeItemId(value: string | null) {
  if (value === null) return null;
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  const isCharacter =
    normalized.startsWith("character:") &&
    normalized.length > "character:".length;
  const isCollection =
    normalized.startsWith("collection:") &&
    normalized.length > "collection:".length;
  if (normalized.length > 512 || (!isCharacter && !isCollection)) {
    throw Errors.badRequest("Invalid Feed item scope");
  }
  return normalized;
}

type FeedCursorState = {
  scopeItemId: string | null;
  snapshotAt: Date;
  expiresAt: Date;
  excludedCharacterIds: string[];
  lastCreatedAt: Date | null;
  lastId: string | null;
};

const FEED_CURSOR_TTL_MS = 30 * 60 * 1_000;

function decodeFeedCursor(value: string | null): FeedCursorState | null {
  if (!value) return null;
  if (value.length > 8_192) {
    throw Errors.badRequest("Invalid or expired Feed cursor");
  }
  try {
    const [encodedPayload, suppliedSignature, extra] = value.split(".");
    if (!encodedPayload || !suppliedSignature || extra) {
      throw Errors.badRequest("Invalid or expired Feed cursor");
    }
    const expected = Buffer.from(feedCursorSignature(encodedPayload));
    const supplied = Buffer.from(suppliedSignature);
    if (
      expected.length !== supplied.length ||
      !timingSafeEqual(expected, supplied)
    ) {
      throw Errors.badRequest("Invalid or expired Feed cursor");
    }
    const decoded: unknown = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    );
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw Errors.badRequest("Invalid or expired Feed cursor");
    }
    const candidate = decoded as Record<string, unknown>;
    if (candidate.v !== 2) {
      throw Errors.badRequest("Invalid or expired Feed cursor");
    }
    const scopeItemId =
      candidate.scopeItemId === null
        ? null
        : typeof candidate.scopeItemId === "string" &&
            candidate.scopeItemId.length > 0 &&
            candidate.scopeItemId.length <= 512
        ? feedScopeItemId(candidate.scopeItemId)
        : undefined;
    const snapshotAt =
      typeof candidate.snapshotAt === "string"
        ? new Date(candidate.snapshotAt)
        : new Date(Number.NaN);
    const expiresAt =
      typeof candidate.expiresAt === "string"
        ? new Date(candidate.expiresAt)
        : new Date(Number.NaN);
    const lastCreatedAt =
      candidate.lastCreatedAt === null
        ? null
        : typeof candidate.lastCreatedAt === "string"
          ? new Date(candidate.lastCreatedAt)
          : new Date(Number.NaN);
    const lastId =
      candidate.lastId === null
        ? null
        : typeof candidate.lastId === "string" &&
            candidate.lastId.length > 0 &&
            candidate.lastId.length <= 512
          ? candidate.lastId
          : undefined;
    const excludedCharacterIds = Array.isArray(candidate.excludedCharacterIds)
      ? candidate.excludedCharacterIds
      : null;
    if (
      scopeItemId === undefined ||
      !Number.isFinite(snapshotAt.getTime()) ||
      snapshotAt.getTime() > Date.now() + 60_000 ||
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt <= snapshotAt ||
      expiresAt.getTime() - snapshotAt.getTime() > FEED_CURSOR_TTL_MS ||
      !excludedCharacterIds ||
      excludedCharacterIds.length > 60 ||
      excludedCharacterIds.some(
        (id) => typeof id !== "string" || id.length === 0 || id.length > 512,
      ) ||
      new Set(excludedCharacterIds).size !== excludedCharacterIds.length ||
      lastId === undefined ||
      !Number.isFinite(lastCreatedAt?.getTime() ?? snapshotAt.getTime()) ||
      (lastCreatedAt === null) !== (lastId === null) ||
      (lastCreatedAt !== null && lastCreatedAt > snapshotAt)
    ) {
      throw Errors.badRequest("Invalid or expired Feed cursor");
    }
    if (expiresAt.getTime() <= Date.now()) {
      throw Errors.gone("Feed cursor expired; refresh the Feed");
    }
    return {
      scopeItemId,
      snapshotAt,
      expiresAt,
      excludedCharacterIds: excludedCharacterIds as string[],
      lastCreatedAt,
      lastId,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw Errors.badRequest("Invalid or expired Feed cursor");
  }
}

function encodeFeedCursor(state: {
  scopeItemId: string | null;
  snapshotAt: Date;
  expiresAt: Date;
  excludedCharacterIds: string[];
  lastCreatedAt: Date | null;
  lastId: string | null;
}) {
  const encodedPayload = Buffer.from(
    JSON.stringify({
      v: 2,
      scopeItemId: state.scopeItemId,
      snapshotAt: state.snapshotAt.toISOString(),
      expiresAt: state.expiresAt.toISOString(),
      excludedCharacterIds: state.excludedCharacterIds,
      lastCreatedAt: state.lastCreatedAt?.toISOString() ?? null,
      lastId: state.lastId,
    }),
    "utf8",
  ).toString("base64url");
  return `${encodedPayload}.${feedCursorSignature(encodedPayload)}`;
}

function feedCursorSignature(encodedPayload: string) {
  return createHmac("sha256", env.INTERNAL_TOKEN)
    .update(`feed-pagination-v2\n${encodedPayload}`)
    .digest("base64url");
}

async function feedPublicCharacterByItemId(itemId: string) {
  const characterId = feedCharacterId(itemId);
  if (!characterId) return null;
  return prisma.character.findFirst({
    where: {
      AND: [
        publicCharacterAudienceWhere,
        { id: characterId },
      ],
    },
    select: {
      id: true,
      creatorId: true,
      name: true,
    },
  });
}

function feedCollectionId(itemId: string) {
  let decoded = itemId;
  try {
    decoded = decodeURIComponent(itemId);
  } catch {
    return null;
  }
  return decoded.startsWith("collection:") ? decoded.slice("collection:".length) : null;
}

function feedPublicCollectionWhere(excludedIds: string[] = [], id?: string) {
  const idFilter = id ? { id } : excludedIds.length > 0 ? { id: { notIn: excludedIds } } : {};
  return {
    AND: [
      publicCollectionAudienceWhere,
      idFilter,
      {
        items: {
          some: {
            mediaAsset: {
              deletedAt: null,
              safetyStatus: "passed",
              visibility: { in: ["public_pack", "unlisted"] },
            },
          },
        },
      },
    ],
  } satisfies Prisma.MediaCollectionWhereInput;
}

async function canonicalPublicFeedItemId(itemId: string) {
  const character = await feedPublicCharacterByItemId(itemId);
  if (character) return `character:${character.id}`;

  const collectionId = feedCollectionId(itemId);
  if (!collectionId) return null;
  const collection = await prisma.mediaCollection.findFirst({
    where: feedPublicCollectionWhere([], collectionId),
    select: { id: true },
  });
  return collection ? `collection:${collection.id}` : null;
}

function feedCharacterItemDTO(character: CharacterWithPublicRelations) {
  return {
    id: `character:${character.id}`,
    type: "character" as const,
    character: characterDTO(character),
  };
}

function feedCollectionItemDTO(collection: MediaCollectionWithRelations) {
  return {
    id: `collection:${collection.id}`,
    type: "collection" as const,
    collection: mediaCollectionDTO(collection),
  };
}

function interleaveFeedItems<T, U>(primary: T[], secondary: U[]) {
  const items: Array<T | U> = [];
  let secondaryIndex = 0;
  primary.forEach((item, index) => {
    items.push(item);
    if ((index + 1) % 3 === 0 && secondaryIndex < secondary.length) {
      items.push(secondary[secondaryIndex]);
      secondaryIndex += 1;
    }
  });
  while (secondaryIndex < secondary.length) {
    items.push(secondary[secondaryIndex]);
    secondaryIndex += 1;
  }
  return items;
}

async function community(request: Request, segments: string[]) {
  const ctx = await getAuthCtx(request);
  requireAgeGate(ctx);
  const [, view] = segments;
  const url = new URL(request.url);

  if (view === "collections") {
    const focusedCollectionId = url.searchParams.get("collection")?.trim() ?? "";
    const [recentCollections, focusedCollection] = await Promise.all([
      prisma.mediaCollection.findMany({
        where: publicCollectionAudienceWhere,
        include: mediaCollectionInclude(true),
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      focusedCollectionId
        ? prisma.mediaCollection.findFirst({
            where: {
              AND: [
                publicCollectionAudienceWhere,
                { id: focusedCollectionId },
              ],
            },
            include: mediaCollectionInclude(true),
          })
        : Promise.resolve(null),
    ]);
    const collections =
      focusedCollection &&
      !recentCollections.some((collection) => collection.id === focusedCollection.id)
        ? [...recentCollections, focusedCollection]
        : recentCollections;
    return ok({ collections: collections.map(mediaCollectionDTO) });
  }

  if (view === "campaigns") {
    const campaigns = await resolveCommunityCampaignPlacements(prisma);
    return ok({
      campaigns: campaigns.flatMap((placement) => {
        const campaign = communityCampaignDTO(placement);
        return campaign ? [campaign] : [];
      }),
    });
  }

  const exposureSubject = metricExposureSubject(ctx.userId, ctx.anonymousId);
  let rankingAssignment: Awaited<ReturnType<typeof assignExperiment>> | null = null;
  if (exposureSubject) {
    try {
      rankingAssignment = await assignExperiment(prisma, "community.character-ranking.v1", {
        subjectType: exposureSubject.subjectType,
        subjectId: exposureSubject.subjectId,
        eligibilitySnapshot: { surface: "community.leaderboard" },
      });
    } catch (error) {
      if (!(error instanceof ExperimentRuntimeError) || error.code !== "definition_not_running") throw error;
    }
  }
  const publicCharacterWhere = publicCharacterAudienceWhere;
  const followedCreatorIds = ctx.userId ? await communityFollowedCreatorIds(ctx.userId) : [];
  const [characters, topDreamerRows, followedDreamerRows] = await Promise.all([
    prisma.character.findMany({
      where: {
        ...publicCharacterWhere,
        gender: url.searchParams.get("gender") ?? undefined,
        style: url.searchParams.get("style") ?? undefined,
        createdAt:
          url.searchParams.get("release") === "30d"
            ? { gte: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30) }
            : undefined,
      },
      include: characterInclude(ctx.userId),
      orderBy: [{ stats: { likesCount: "desc" } }],
      take: 20,
    }),
    communityDreamerRows(),
    followedCreatorIds.length
      ? communityDreamerRows({ creatorIds: followedCreatorIds, limit: followedCreatorIds.length })
      : Promise.resolve([]),
  ]);
  const rankedCharacters = rankingAssignment?.status === "assigned" && rankingAssignment.variant === "relationship_first"
    ? [...characters].sort((left, right) =>
        (right.stats?.chatsCount ?? 0) - (left.stats?.chatsCount ?? 0) ||
        (right.stats?.likesCount ?? 0) - (left.stats?.likesCount ?? 0) ||
        left.id.localeCompare(right.id),
      )
    : characters;
  const dreamerRows = mergeCommunityDreamerRows(followedDreamerRows, topDreamerRows);
  const followingIds = new Set(followedCreatorIds);
  const dreamers = dreamerRows.map((dreamer) => ({
    id: dreamer.id,
    displayName: dreamer.displayName,
    image: dreamer.image,
    characters: numberFromDb(dreamer.characters),
    followers: numberFromDb(dreamer.followers),
    likes: formatCount(numberFromDb(dreamer.likes)),
    chats: formatCount(numberFromDb(dreamer.chats)),
    likesCount: numberFromDb(dreamer.likes),
    chatsCount: numberFromDb(dreamer.chats),
    isFollowing: followingIds.has(dreamer.id),
  }));
  const exposureJourneyId = `community-journey-${cryptoRandomId("journey")}`;
  return ok({
    leaderboards: {
      characters: rankedCharacters.map((character) => ({
        ...characterDTO(character, ctx.userId),
        exposureContext: exposureSubject && character.serving?.state === "live" &&
          character.serving.currentRelease?.status === "published"
          ? issueExposureContext({
              ...exposureSubject,
              characterId: character.id,
              characterContentVersionId: character.serving.currentRelease.characterContentVersionId,
              characterReleaseId: character.serving.currentRelease.id,
              servingVersion: character.serving.version,
              placementId: "community.leaderboard",
              journeyId: exposureJourneyId,
            }, env.BETTER_AUTH_SECRET)
          : null,
      })),
      dreamers,
      collections: [],
    },
    experimentAssignment: rankingAssignment?.status === "assigned" &&
      rankingAssignment.assignmentId &&
      (rankingAssignment.variant === "control" || rankingAssignment.variant === "relationship_first")
      ? {
          assignmentId: rankingAssignment.assignmentId,
          variant: rankingAssignment.variant,
          exposureId: `experiment-exposure-${cryptoRandomId("community-ranking")}`,
          surface: "community.leaderboard",
        }
      : null,
  });
}

function metricExposureSubject(
  userId: string | null | undefined,
  anonymousId: string | null | undefined,
): ExposureSubject | null {
  if (userId) return { subjectType: "user", subjectId: userId };
  if (anonymousId) return { subjectType: "anonymous", subjectId: anonymousId };
  return null;
}

type CommunityCampaignPlacement = Prisma.MediaAssetPlacementGetPayload<{
  include: { mediaAsset: true };
}>;

function communityCampaignDTO(placement: CommunityCampaignPlacement) {
  const copy = parseCommunityCampaignAuthoredCopy(placement.metadata);
  if (!copy) return null;
  const image = placement.mediaAsset.storageKey
    ? mediaViewUrl(placement.mediaAsset)
    : (placement.mediaAsset.thumbnailUrl ?? placement.mediaAsset.url);
  return {
    id: placement.id,
    eyebrow: copy.eyebrow,
    title: copy.title,
    ctaLabel: copy.ctaLabel,
    href: copy.href,
    image,
    source: "authority" as const,
  };
}

type CommunityDreamerRow = {
  id: string;
  displayName: string;
  image: string | null;
  characters: number | bigint;
  followers: number | bigint;
  likes: number | bigint;
  chats: number | bigint;
};

async function communityFollowedCreatorIds(userId: string) {
  const rows = await prisma.follow.findMany({
    where: { followerId: userId },
    orderBy: { createdAt: "desc" },
    select: { followeeId: true },
  });
  return rows.map((row) => row.followeeId);
}

function mergeCommunityDreamerRows(...groups: CommunityDreamerRow[][]) {
  const rows: CommunityDreamerRow[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const row of group) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
      if (rows.length >= 20) return rows;
    }
  }
  return rows;
}

async function communityDreamerRows(options: { creatorIds?: string[]; limit?: number } = {}) {
  const limit = Math.max(1, Math.min(options.limit ?? 20, 40));
  const creators = await prisma.user.findMany({
    where: {
      ...activeCustomerUserWhere,
      ...(options.creatorIds?.length
        ? { id: { in: options.creatorIds } }
        : {}),
      charactersCreated: { some: publicCharacterAudienceWhere },
    },
    select: {
      id: true,
      displayName: true,
      name: true,
      image: true,
      createdAt: true,
      charactersCreated: {
        where: publicCharacterAudienceWhere,
        select: {
          stats: {
            select: {
              likesCount: true,
              chatsCount: true,
            },
          },
        },
      },
      _count: {
        select: {
          followers: {
            where: {
              follower: {
                is: activeCustomerUserWhere,
              },
            },
          },
        },
      },
    },
  });
  return creators
    .map((creator) => {
      const totals = creator.charactersCreated.reduce(
        (sum, character) => ({
          likes: sum.likes + (character.stats?.likesCount ?? 0),
          chats: sum.chats + (character.stats?.chatsCount ?? 0),
        }),
        { likes: 0, chats: 0 },
      );
      return {
        id: creator.id,
        displayName: creator.displayName ?? creator.name ?? "Dreamer",
        image: creator.image,
        characters: creator.charactersCreated.length,
        followers: creator._count.followers,
        likes: totals.likes,
        chats: totals.chats,
        createdAt: creator.createdAt,
      };
    })
    .sort((left, right) =>
      (right.likes + right.chats) - (left.likes + left.chats) ||
      right.characters - left.characters ||
      right.createdAt.getTime() - left.createdAt.getTime()
    )
    .slice(0, limit)
    .map((creator): CommunityDreamerRow => ({
      id: creator.id,
      displayName: creator.displayName,
      image: creator.image,
      characters: creator.characters,
      followers: creator.followers,
      likes: creator.likes,
      chats: creator.chats,
    }));
}

async function followUser(request: Request, targetId: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  if (targetId === user.id) throw Errors.badRequest("Cannot follow yourself");
  const target = await prisma.user.findFirst({
    where: {
      id: targetId,
      ...activeCustomerUserWhere,
      charactersCreated: { some: publicCharacterAudienceWhere },
    },
  });
  if (!target) throw Errors.notFound("User not found");
  await prisma.follow.upsert({
    where: { followerId_followeeId: { followerId: user.id, followeeId: targetId } },
    update: {},
    create: { followerId: user.id, followeeId: targetId },
  });
  return ok({
    following: true,
    followers: await activeFollowerCount(targetId),
  });
}

async function unfollowUser(request: Request, targetId: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  await prisma.follow.deleteMany({
    where: { followerId: user.id, followeeId: targetId },
  });
  return ok({
    following: false,
    followers: await activeFollowerCount(targetId),
  });
}

function activeFollowerCount(targetId: string) {
  return prisma.follow.count({
    where: {
      followeeId: targetId,
      follower: { is: activeCustomerUserWhere },
    },
  });
}

// SPEC: public creator profile — displayName + totals + their public/approved characters.
// INTENT: gives Community/Feed a place to lead to (§G); read-only, age-gated, no private data.
async function creatorProfile(request: Request, creatorId: string) {
  const ctx = await getAuthCtx(request);
  requireAgeGate(ctx);
  const creator = await prisma.user.findFirst({
    where: {
      id: creatorId,
      ...activeCustomerUserWhere,
      charactersCreated: { some: publicCharacterAudienceWhere },
    },
    select: { id: true, displayName: true, name: true, image: true, createdAt: true },
  });
  if (!creator) throw Errors.notFound("Creator not found");
  const publicCreatorCharacterWhere: Prisma.CharacterWhereInput = {
    AND: [
      publicCharacterAudienceWhere,
      { creatorId },
    ],
  };
  const [characters, characterCount, characterTotals, followers, following] = await Promise.all([
    prisma.character.findMany({
      where: publicCreatorCharacterWhere,
      include: characterInclude(ctx.userId),
      orderBy: [{ stats: { likesCount: "desc" } }, { createdAt: "desc" }],
      take: 24,
    }),
    prisma.character.count({ where: publicCreatorCharacterWhere }),
    prisma.characterStats.aggregate({
      where: { character: { is: publicCreatorCharacterWhere } },
      _sum: { likesCount: true, chatsCount: true },
    }),
    prisma.follow.count({
      where: {
        followeeId: creatorId,
        follower: {
          is: {
            dataClass: "customer",
            status: "active",
            deletedAt: null,
          },
        },
      },
    }),
    ctx.userId
      ? prisma.follow.findFirst({
          where: { followerId: ctx.userId, followeeId: creatorId },
          select: { followerId: true },
        })
      : null,
  ]);
  const totalLikes = characterTotals._sum.likesCount ?? 0;
  const totalChats = characterTotals._sum.chatsCount ?? 0;
  return ok({
    creator: {
      id: creator.id,
      displayName: creator.displayName ?? creator.name ?? "Dreamer",
      image: creator.image,
      createdAt: creator.createdAt,
      isFollowing: Boolean(following),
      isSelf: ctx.userId === creator.id,
      stats: {
        characters: characterCount,
        followers,
        likes: formatCount(totalLikes),
        chats: formatCount(totalChats),
        likesCount: totalLikes,
        chatsCount: totalChats,
      },
    },
    characters: characters.map((character) => characterDTO(character, ctx.userId)),
  });
}

async function duplicateCharacter(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const duplicate = await prisma.$transaction(async (tx) => {
    await lockCharacterGenerationAuthority(tx, id);
    const source = await tx.character.findFirst({
      where: {
        id,
        deletedAt: null,
        OR: [
          publicCharacterAudienceWhere,
          { creatorId: user.id },
        ],
      },
    });
    if (!source) throw Errors.notFound("Character not found");

    const sourceImageAssetId = source.imageAssetId;
    if (sourceImageAssetId) {
      await lockMediaAssetAuthority(tx, sourceImageAssetId);
    }

    // The Character authority lock stabilizes its primary-image pointer while
    // the canonical MediaAsset authority lock serializes us with archive/delete.
    // Re-read both only after those locks: the discovery read is never authority.
    const lockedSource = await tx.character.findUnique({ where: { id } });
    if (!lockedSource || lockedSource.deletedAt !== null) {
      throw Errors.notFound("Character not found");
    }
    if (lockedSource.imageAssetId !== sourceImageAssetId) {
      throw Errors.conflict("Character image changed while the duplicate was being created");
    }

    const sourceImageAsset = sourceImageAssetId
      ? await tx.mediaAsset.findFirst({
          where: {
            id: sourceImageAssetId,
            deletedAt: null,
            type: "image",
          },
        })
      : null;
    if (
      sourceImageAssetId &&
      (
        !sourceImageAsset ||
        sourceImageAsset.safetyStatus !== "passed" ||
        !sourceImageAsset.url.trim() ||
        !isMediaAssetOperationalForAuthority(sourceImageAsset.metadata)
      )
    ) {
      throw Errors.conflict("The source Character image is no longer available");
    }
    if (sourceImageAsset) {
      assertNonSyntheticMediaAsset(
        sourceImageAsset,
        "Synthetic media cannot be copied as a character identity",
      );
    }

    const name = `${lockedSource.name} Copy`;
    const created = await tx.character.create({
      data: {
        creatorId: user.id,
        name,
        age: lockedSource.age,
        description: lockedSource.description,
        systemPrompt: buildCharacterSystemPrompt({
          name,
          age: lockedSource.age,
          description: lockedSource.description,
          relationship: lockedSource.relationship,
          style: lockedSource.style,
          gender: lockedSource.gender,
          appearance: lockedSource.appearance,
          advancedDetails: lockedSource.advancedDetails,
        }),
        visibility: "private",
        status: "approved",
        style: lockedSource.style,
        gender: lockedSource.gender,
        relationship: lockedSource.relationship,
        imageAssetId: null,
        appearance: toInputJson(lockedSource.appearance ?? {}),
        advancedDetails: toInputJson(lockedSource.advancedDetails ?? {}),
      },
    });

    const sourceBlobLocator = sourceImageAsset
      ? resolveMediaAssetBlobLocator(sourceImageAsset)
      : null;
    if (sourceImageAsset && sourceBlobLocator) {
      const duplicateImageAssetId = `media_${cryptoRandomId("character_duplicate")}`;
      const sourceMetadata = jsonRecord(sourceImageAsset.metadata);
      const backingKey = sourceBlobLocator.key;
      const duplicateRouteUrl = mediaViewUrl({
        id: duplicateImageAssetId,
        type: sourceImageAsset.type,
        contentType: sourceImageAsset.contentType,
        storageKey: null,
        url: sourceImageAsset.url,
      });
      const duplicateUrl = duplicateRouteUrl;
      const duplicateThumbnailUrl = duplicateRouteUrl;
      const retainedTechnicalMetadata: Record<string, unknown> = {};
      for (const key of [
        "backend",
        "consistencyMode",
        "contentType",
        "height",
        "index",
        "model",
        "profileId",
        "profileVersion",
        "provider",
        "recipeId",
        "recipeVersion",
        "referenceAssetIds",
        "seconds",
        "seed",
        "usage",
        "visualProfileId",
        "visualProfileVersion",
        "width",
        "workflow",
      ]) {
        if (Object.hasOwn(sourceMetadata, key)) {
          retainedTechnicalMetadata[key] = sourceMetadata[key];
        }
      }
      await tx.mediaAsset.create({
        data: {
          id: duplicateImageAssetId,
          ownerId: user.id,
          characterId: created.id,
          type: "image",
          url: duplicateUrl,
          thumbnailUrl: duplicateThumbnailUrl,
          storageKey: null,
          contentType: sourceImageAsset.contentType,
          width: sourceImageAsset.width,
          height: sourceImageAsset.height,
          providerAssetId: sourceImageAsset.providerAssetId,
          sourcePromptHash: sourceImageAsset.sourcePromptHash,
          prompt: sourceImageAsset.prompt,
          visibility: "private",
          // A distinct asset must earn its own review decision. Reusing the
          // source row's `passed`/platform approval would launder authority
          // across owners even though the underlying bytes are shared.
          safetyStatus: "unknown",
          metadata: toInputJson({
            ...retainedTechnicalMetadata,
            source: "character_duplicate",
            synthetic: false,
            providerKey: backingKey,
            blobLocator: {
              schemaVersion: SHARED_IMMUTABLE_BLOB_LOCATOR_SCHEMA,
              kind: "shared_immutable",
              key: backingKey,
              sourceAssetId: sourceImageAsset.id,
            },
            duplicateLineage: {
              schemaVersion: 1,
              sourceAssetId: sourceImageAsset.id,
              sourceCharacterId: lockedSource.id,
              sourceOwnerId: sourceImageAsset.ownerId,
              duplicateCharacterId: created.id,
              duplicatedByUserId: user.id,
            },
          }),
        },
      });
      await tx.character.update({
        where: { id: created.id },
        data: { imageAssetId: duplicateImageAssetId },
      });
    }

    await tx.characterStats.create({ data: { characterId: created.id } });
    return tx.character.findUniqueOrThrow({ where: { id: created.id } });
  });
  return ok({ character: duplicate });
}

async function updateCharacter(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const body = z
    .object({
      name: z.string().min(1).max(80).optional(),
      description: z.string().min(1).max(1_500).optional(),
      visibility: z.enum(["private", "unlisted", "public"]).optional(),
    })
    .parse(await jsonBody(request));
  const shouldRebuildPrompt = body.name !== undefined || body.description !== undefined;
  await prisma.$transaction(async (tx) => {
    await lockCharacterGenerationAuthority(tx, id);
    const existing = await tx.character.findFirst({
      where: { id, creatorId: user.id, deletedAt: null },
    });
    if (!existing) throw Errors.notFound("Character not found");
    const nextName = body.name ?? existing.name;
    const nextDescription = body.description ?? existing.description;
    const activeProfile = shouldRebuildPrompt
      ? await tx.characterVisualProfile.findFirst({
          where: { characterId: id, status: "active" },
          orderBy: { version: "desc" },
        })
      : null;
    await lockCharacterMediaAssetAuthorities(tx, [
      ...(body.visibility === "public" && existing.imageAssetId
        ? [existing.imageAssetId]
        : []),
      ...jsonStringArray(activeProfile?.anchorAssetIds),
      ...jsonStringArray(activeProfile?.referenceAssetIds),
    ]);
    if (shouldRebuildPrompt) {
      await assertCharacterIdentityAuthorityMutable(tx, id);
    }
    if (body.visibility === "public" && existing.imageAssetId) {
      const imageAsset = await tx.mediaAsset.findFirst({
        where: {
          id: existing.imageAssetId,
          deletedAt: null,
          type: "image",
        },
        select: {
          id: true,
          characterId: true,
          safetyStatus: true,
          metadata: true,
        },
      });
      if (
        !imageAsset ||
        imageAsset.characterId !== id ||
        imageAsset.safetyStatus !== "passed" ||
        !isMediaAssetOperationalForAuthority(imageAsset.metadata)
      ) {
        throw Errors.badRequest("The character identity image is no longer available");
      }
      assertNonSyntheticMediaAsset(
        imageAsset,
        "Synthetic media cannot be published as a character identity",
      );
    }
    const updated = await tx.character.update({
      where: { id: existing.id },
      data: {
        name: body.name,
        description: body.description,
        systemPrompt: shouldRebuildPrompt
          ? buildCharacterSystemPrompt({
              name: nextName,
              age: existing.age,
              description: nextDescription,
              relationship: existing.relationship,
              style: existing.style,
              gender: existing.gender,
              appearance: existing.appearance,
              advancedDetails: existing.advancedDetails,
            })
          : undefined,
        visibility: body.visibility,
        status: body.visibility === "public"
          ? "pending_review"
          : body.visibility && existing.status === "pending_review"
            ? "approved"
            : undefined,
      },
    });
    if (body.visibility === "public") {
      const pendingSubmission = await tx.characterSubmission.findFirst({
        where: { characterId: updated.id, status: "pending" },
        orderBy: [{ submittedAt: "desc" }, { id: "desc" }],
        select: { id: true },
      });
      if (!pendingSubmission) {
        await tx.characterSubmission.create({
          data: {
            characterId: updated.id,
            submitterId: user.id,
            status: "pending",
          },
        });
      }
    } else if (body.visibility && existing.status === "pending_review") {
      await tx.characterSubmission.updateMany({
        where: { characterId: updated.id, status: "pending" },
        data: {
          status: "rejected",
          reviewReason: "withdrawn_by_submitter",
          reviewedAt: new Date(),
        },
      });
    }
    if (shouldRebuildPrompt) {
      await createActiveCharacterVisualProfileVersion(tx, updated, {
        createdFrom: "character_update",
      });
    }
  });
  return getCharacter(request, id);
}

async function archiveCharacter(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const archived = await prisma.$transaction(async (tx) => {
    await lockCharacterGenerationAuthority(tx, id);
    const character = await tx.character.findFirst({
      where: { id, creatorId: user.id },
      select: { id: true, imageAssetId: true, status: true },
    });
    if (!character) return false;
    if (character.status === "archived") return false;
    const activeGeneration = await tx.generationJob.findFirst({
      where: {
        characterId: character.id,
        status: { in: activeGenerationStatuses() },
      },
      select: { id: true, status: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    if (activeGeneration) {
      throw Errors.conflict(
        "Character cannot be archived while image or video generation is active",
        {
          characterId: character.id,
          generationJobId: activeGeneration.id,
          generationStatus: activeGeneration.status,
        },
      );
    }
    if (character.imageAssetId) {
      await lockMediaAssetAuthority(tx, character.imageAssetId);
    }
    await tx.characterServing.updateMany({
      where: { characterId: character.id },
      data: {
        state: "retired",
        currentReleaseId: null,
        scheduledReleaseId: null,
        scheduledAt: null,
        version: { increment: 1 },
      },
    });
    await tx.characterSubmission.updateMany({
      where: { characterId: character.id, status: "pending" },
      data: {
        status: "rejected",
        reviewReason: "character_archived",
        reviewedAt: new Date(),
      },
    });
    await tx.character.update({
      where: { id: character.id },
      data: {
        status: "archived",
        deletedAt: new Date(),
        imageAssetId: null,
      },
    });
    const activeProjects = await tx.characterProject.findMany({
      where: {
        characterId: character.id,
        activeKey: { not: null },
        phase: { notIn: ["inactive", "retired"] },
      },
      select: { id: true, phase: true },
    });
    if (activeProjects.some((project) =>
      !isCharacterProjectPhaseTransitionAllowed(project.phase, "retired")
    )) {
      throw Errors.conflict("Character Project cannot be retired from its current phase");
    }
    await tx.characterProject.updateMany({
      where: {
        id: { in: activeProjects.map((project) => project.id) },
      },
      data: {
        phase: "retired",
        activeKey: null,
        version: { increment: 1 },
      },
    });
    await recordMainToChatEvent({
      eventId: `character_removed_${character.id}_${randomUUID()}`,
      eventType: MAIN_TO_CHAT_EVENTS.characterRemoved,
      aggregateType: "character",
      aggregateId: character.id,
      payload: { characterId: character.id },
    }, tx);
    return true;
  });
  if (archived) {
    try {
      await dispatchPendingChatEvents();
    } catch (error) {
      logger.error(
        { error, characterId: id },
        "failed to dispatch durable Chat character removal",
      );
    }
  }
  return ok({ archived: true });
}

function characterInclude(userId?: string) {
  return {
    imageAsset: true,
    stats: true,
    tags: { include: { tag: true } },
    visualProfiles: {
      where: { status: "active" },
      orderBy: { version: "desc" },
      take: 1,
    },
    creator: { select: { id: true, displayName: true, name: true } },
    serving: { include: { currentRelease: true } },
    likes: userId ? { where: { userId }, select: { userId: true } } : false,
  } satisfies Prisma.CharacterInclude;
}

type CharacterWithPublicRelations = Prisma.CharacterGetPayload<{
  include: ReturnType<typeof characterInclude>;
}>;

function hasPublicListReleaseManifestAuthority(
  character: CharacterWithPublicRelations,
) {
  const currentRelease = character.serving?.currentRelease ?? null;
  if (!currentRelease) return false;
  return currentRelease.legacy ||
    parseCharacterReleaseAssetManifest(
      currentRelease.releasePlacementManifest,
    ) !== null;
}

function characterDTO(character: CharacterWithPublicRelations, viewerId?: string | null) {
  const visualProfile = character.visualProfiles[0] ?? null;
  const image = character.imageAsset?.url ?? missingCharacterImage;
  const official = character.source === "official";
  const creatorName = official
    ? "Official"
    : (character.creator?.displayName ?? character.creator?.name ?? null);
  return {
    id: character.id,
    name: character.name,
    title: character.name,
    age: String(character.age),
    description: character.description,
    visibility: character.visibility,
    status: character.status,
    source: official ? "official" : "user",
    creatorType: official ? "official" : "user",
    style: character.style,
    gender: character.gender,
    relationship: character.relationship,
    creatorId: official ? null : character.creatorId,
    creator: creatorName ?? "Creator",
    creatorName,
    canEditIdentity: Boolean(!official && viewerId && character.creatorId === viewerId),
    image,
    imageAssetId: character.imageAsset?.id ?? null,
    thumbnailUrl: character.imageAsset?.thumbnailUrl ?? image,
    hasImage: Boolean(character.imageAsset?.url),
    likes: formatCount(character.stats?.likesCount ?? 0),
    chats: formatCount(character.stats?.chatsCount ?? 0),
    likesCount: character.stats?.likesCount ?? 0,
    chatsCount: character.stats?.chatsCount ?? 0,
    views: character.stats?.viewsCount ?? 0,
    vivid: character.vivid,
    liked: Array.isArray(character.likes) ? character.likes.length > 0 : false,
    visualProfile: visualProfile ? visualProfileDTO(visualProfile) : null,
    tags: character.tags.map(({ tag }) => tag),
    createdAt: character.createdAt,
  };
}

async function characterDetailDTO(
  character: CharacterWithPublicRelations,
  viewerId?: string | null,
) {
  const base = characterDTO(character, viewerId);
  const currentRelease = character.serving?.currentRelease ?? null;
  if (
    !currentRelease ||
    currentRelease.legacy ||
    currentRelease.status !== "published" ||
    character.serving?.state !== "live"
  ) {
    return {
      ...base,
      currentReleaseId: currentRelease?.id ?? null,
      heroImage: base.image,
      heroThumbnailUrl: base.thumbnailUrl,
      heroImageAssetId: base.imageAssetId,
      imageAuthority: {
        source: currentRelease?.legacy
          ? "legacy_projection"
          : "character_projection",
        releaseId: currentRelease?.id ?? null,
      },
    };
  }

  const assetPack = await resolvePublicCharacterReleaseAssetPack(prisma, {
    characterId: character.id,
    imageAssetId: character.imageAssetId,
    releasePlacementManifest: currentRelease.releasePlacementManifest,
  });
  if (!assetPack) throw Errors.notFound("Character not found");
  const heroImage = assetPack.hero.storageKey
    ? mediaViewUrl(assetPack.hero)
    : assetPack.hero.url;
  return {
    ...base,
    currentReleaseId: currentRelease.id,
    heroImage,
    heroThumbnailUrl: assetPack.hero.thumbnailUrl ?? heroImage,
    heroImageAssetId: assetPack.hero.id,
    imageAuthority: {
      source: "release",
      releaseId: currentRelease.id,
    },
  };
}

function userDTO(user: {
  id: string;
  email: string;
  displayName: string | null;
  name: string | null;
  image: string | null;
  role: string;
  status: string;
  createdAt: Date;
}) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName ?? user.name,
    image: user.image,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
  };
}

function mediaDTO(asset: {
  id: string;
  characterId?: string | null;
  type: string;
  url: string;
  thumbnailUrl: string | null;
  storageKey?: string | null;
  contentType?: string | null;
  width?: number | null;
  height?: number | null;
  prompt: string | null;
  visibility: string;
  safetyStatus: string;
  metadata?: Prisma.JsonValue;
  liked: boolean;
  createdAt: Date;
  sourceJob?: {
    characterId?: string | null;
    sourceType: string;
    sourceId: string | null;
    sourceMeta?: Prisma.JsonValue | null;
  } | null;
}, options: {
  editableCharacterIds?: ReadonlySet<string>;
  imageEditModelIds?: readonly string[];
} = {}) {
  const displayUrl = asset.storageKey ? mediaViewUrl(asset) : asset.url;
  const metadata = jsonRecord(asset.metadata);
  const quality = jsonRecord(metadata.quality);
  const visualProfileVersion =
    numberFromRecord(metadata, "visualProfileVersion") ??
    numberFromRecord(quality, "visualProfileVersion");
  const characterId = asset.characterId ?? null;
  return {
    id: asset.id,
    characterId,
    canEditIdentity: Boolean(characterId && options.editableCharacterIds?.has(characterId)),
    imageEditModelIds: options.imageEditModelIds ?? [],
    type: asset.type,
    url: displayUrl,
    thumbnailUrl: asset.storageKey ? displayUrl : (asset.thumbnailUrl ?? asset.url),
    prompt: asset.prompt,
    visibility: asset.visibility,
    safetyStatus: asset.safetyStatus,
    liked: asset.liked,
    contentType: asset.contentType ?? null,
    width: asset.width ?? null,
    height: asset.height ?? null,
    visualProfileId:
      stringFromRecord(metadata, "visualProfileId") ?? stringFromRecord(quality, "visualProfileId") ?? null,
    visualProfileVersion: visualProfileVersion ?? null,
    identity: {
      selectedAsCharacterImage: booleanFromRecord(quality, "selectedAsCharacterImage", false),
      addedToReferences: booleanFromRecord(quality, "addedToReferences", false),
    },
    quality: Object.keys(quality).length > 0 ? quality : null,
    isSynthetic: isSyntheticMediaAsset(asset.metadata),
    provenance: mediaProvenanceDTO(asset.sourceJob),
    createdAt: asset.createdAt,
  };
}

function mediaProvenanceDTO(sourceJob?: {
  sourceType: string;
  sourceId: string | null;
  sourceMeta?: Prisma.JsonValue | null;
} | null) {
  if (!sourceJob || sourceJob.sourceType === "generator") return null;
  const meta = jsonRecord(sourceJob.sourceMeta);

  if (sourceJob.sourceType === "feed_remix") {
    const feedItemId = stringFromRecord(meta, "feedItemId");
    const sourceCharacterId = stringFromRecord(meta, "sourceCharacterId");
    const sourceCharacterName = stringFromRecord(meta, "sourceCharacterName");
    return {
      sourceType: sourceJob.sourceType,
      sourceId: sourceJob.sourceId,
      label: "Remixed from Feed",
      feedItemId: feedItemId ?? null,
      sourceCharacterId: sourceCharacterId ?? null,
      sourceCharacterName: sourceCharacterName ?? null,
      href: feedItemId ? `/feed?item=${encodeURIComponent(feedItemId)}` : null,
    };
  }

  if (sourceJob.sourceType === "media_variation") {
    return {
      sourceType: sourceJob.sourceType,
      sourceId: sourceJob.sourceId,
      label: "Variation",
      sourceMediaId: stringFromRecord(meta, "sourceMediaId") ?? null,
      href: null,
    };
  }

  if (sourceJob.sourceType === "chat_image") {
    return {
      sourceType: sourceJob.sourceType,
      sourceId: sourceJob.sourceId,
      label: "From chat",
      chatSessionId: stringFromRecord(meta, "sessionId") ?? null,
      href: null,
    };
  }

  return {
    sourceType: sourceJob.sourceType,
    sourceId: sourceJob.sourceId,
    label: "Generated source",
    href: null,
  };
}

function mediaCollectionDTO(collection: MediaCollectionWithRelations) {
  const official = collection.source === "official";
  return {
    id: collection.id,
    name: collection.name,
    visibility: collection.visibility,
    source: official ? "official" : "user",
    ownerType: official ? "official" : "user",
    ownerId: official ? null : collection.ownerId,
    ownerName: official
      ? "Official collection"
      : (collection.owner.displayName ?? collection.owner.name),
    itemCount: collection._count.items,
    previews: collection.items
      .map(({ mediaAsset }) =>
        mediaAsset.storageKey ? mediaViewUrl(mediaAsset) : (mediaAsset.thumbnailUrl ?? mediaAsset.url),
      )
      .filter((url): url is string => Boolean(url)),
    createdAt: collection.createdAt.toISOString(),
  };
}

function mediaViewUrl(asset: {
  id: string;
  type: string;
  contentType?: string | null;
  storageKey?: string | null;
  url: string;
}) {
  const extension = mediaFileExtension(asset) || (asset.type === "image" ? ".png" : "");
  return `/user-content/${mediaRouteToken(asset.id)}/content${extension}`;
}

function mediaRouteToken(id: string) {
  return Buffer.from(id, "utf8").toString("base64url");
}

function generationJobInclude() {
  return {
    assets: true,
    events: { orderBy: { createdAt: "asc" as const } },
  } satisfies Prisma.GenerationJobInclude;
}

type GenerationJobWithRelations = Prisma.GenerationJobGetPayload<{
  include: ReturnType<typeof generationJobInclude>;
}>;

function generationJobDTO(job: GenerationJobWithRelations) {
  return {
    id: job.id,
    userId: job.userId,
    characterId: job.characterId,
    visualProfileId: job.visualProfileId,
    visualProfileVersion: job.visualProfileVersion,
    consistencyMode: job.consistencyMode,
    seed: job.seed,
    referenceAssetIds: job.referenceAssetIds,
    referenceSetRevisionId: job.referenceSetRevisionId,
    referenceManifest: job.referenceManifest,
    momentSpec: job.momentSpec,
    lookId: job.lookId,
    lookSnapshot: job.lookSnapshot,
    derivedFromJobId: job.derivedFromJobId,
    mode: job.mode,
    prompt: job.prompt,
    negativePrompt: job.negativePrompt,
    controls: job.controls,
    presetIds: job.presetIds,
    model: job.model,
    profileId: job.profileId,
    profileVersion: job.profileVersion,
    recipeId: job.recipeId,
    recipeVersion: job.recipeVersion,
    orientation: job.orientation,
    outputCount: job.outputCount,
    status: job.status,
    costDreamcoins: job.costDreamcoins,
    provider: job.provider,
    sourceType: job.sourceType,
    sourceId: job.sourceId,
    sourceMeta: job.sourceMeta,
    errorCode: job.errorCode,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
  };
}

function generationJobResponse(job: GenerationJobWithRelations) {
  const refunded = generationRefundAmount(job.events);
  const missingOutputs = Math.max(0, job.outputCount - job.assets.length);
  const sourceJob = {
    sourceType: job.sourceType,
    sourceId: job.sourceId,
    sourceMeta: job.sourceMeta,
  };
  return {
    job: generationJobDTO(job),
    assets: job.assets.map((asset) => mediaDTO({ ...asset, sourceJob })),
    events: job.events.map((event) => ({
      id: event.id,
      type: event.type,
      message: event.message,
      metadata: event.metadata,
      createdAt: event.createdAt,
    })),
    cost: {
      charged: job.costDreamcoins,
      refunded,
      finalCharge: Math.max(0, job.costDreamcoins - refunded),
      assetCount: job.assets.length,
      requestedCount: job.outputCount,
      missingOutputs,
    },
  };
}

function generationRefundAmount(events: GenerationJobWithRelations["events"]) {
  return events.reduce((total, event) => {
    if (event.type !== "refunded") return total;
    const metadata = isRecord(event.metadata) ? event.metadata : {};
    const amount = metadata.amount;
    return total + (typeof amount === "number" && Number.isFinite(amount) ? amount : 0);
  }, 0);
}

async function jsonBody(request: Request): Promise<unknown> {
  if (request.method === "GET" || request.method === "DELETE") return {};
  return parseJsonText(await bodyText(request));
}

async function bodyText(request: Request) {
  if (request.method === "GET" || request.method === "DELETE") return "";
  return request.text();
}

function parseJsonText(text: string): unknown {
  if (!text) return {};
  return JSON.parse(text) as unknown;
}

function parseRequestCookies(request: Request) {
  const header = request.headers.get("cookie");
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name) cookies.set(name, decodeURIComponent(value.join("=")));
  }
  return cookies;
}

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function jsonNonBlankString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function requiredCharacterPersonaFields(input: {
  description: string | null;
  relationship: string | null;
  advancedDetails: Record<string, unknown>;
}) {
  const missingFields: string[] = [];
  if (!input.description) missingFields.push("description");
  if (!input.relationship) missingFields.push("relationship");
  for (const field of ["personality", "tone", "backstory", "firstMessage"] as const) {
    if (!jsonNonBlankString(input.advancedDetails[field])) missingFields.push(field);
  }
  const exampleDialogue = input.advancedDetails.exampleDialogue;
  const hasExampleDialogue =
    jsonNonBlankString(exampleDialogue) !== null ||
    jsonStringArray(exampleDialogue).some((line) => line.trim().length > 0);
  if (!hasExampleDialogue) missingFields.push("exampleDialogue");
  return missingFields;
}

function normalizeMutedTags(values: readonly string[]) {
  return Array.from(new Set(values.map(slugify).filter(Boolean))).slice(0, 80);
}

async function mutedTagSlugsForUser(userId: string) {
  const preferences = await readPreferences(userId);
  return normalizeMutedTags(jsonStringArray(preferences.mutedTags));
}

function suggestRoutes(query: string, limit: number): SearchRouteSuggestion[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [];

  const querySlug = slugify(query);
  const queryTerms = normalizedQuery.split(/\s+/).filter(Boolean);
  return ourdreamRoutePaths
    .filter(
      (routePath) =>
        isSearchableRouteSuggestionPath(routePath) &&
        isPublicRouteDiscoverable(routePath),
    )
    .map((routePath) => getOurdreamRoute(routePath))
    .filter((route): route is OurdreamRoute => Boolean(route))
    .map((route) => ({
      route,
      score: scoreRouteSuggestion(route, normalizedQuery, querySlug, queryTerms),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.route.title.localeCompare(right.route.title);
    })
    .slice(0, limit)
    .map(({ route }) => ({
      description: route.description,
      href: route.path,
      template: route.template,
      title: route.title,
    }));
}

function isSearchableRouteSuggestionPath(routePath: string) {
  return (
    routePath === "/ai-girl" ||
    routePath === "/ai-girlfriend" ||
    routePath === "/ai-boyfriend" ||
    routePath === "/ai-instructions" ||
    routePath === "/free-ai-girlfriend" ||
    routePath === "/games" ||
    routePath === "/generate" ||
    routePath === "/nude-ai" ||
    routePath === "/resources-hub" ||
    routePath === "/romantasy" ||
    routePath === "/type" ||
    routePath === "/videos" ||
    routePath.startsWith("/ai-girlfriend/") ||
    routePath.startsWith("/comparison/") ||
    routePath.startsWith("/generate/") ||
    routePath.startsWith("/generator/") ||
    routePath.startsWith("/guides/") ||
    routePath.startsWith("/sex-chat/") ||
    routePath.startsWith("/type/") ||
    routePath.startsWith("/videos/") ||
    routePath.includes("alternatives")
  );
}

function scoreRouteSuggestion(
  route: OurdreamRoute,
  normalizedQuery: string,
  querySlug: string,
  queryTerms: string[],
) {
  const normalizedTitle = normalizeSearchText(route.title);
  const normalizedDescription = normalizeSearchText(route.description);
  const normalizedPath = normalizeSearchText(route.path.replaceAll("/", " "));
  const routeSlug = slugify(route.path);
  const searchableText = `${normalizedTitle} ${normalizedPath} ${normalizedDescription}`;

  if (normalizedTitle === normalizedQuery) return 120;
  if (normalizedTitle.startsWith(normalizedQuery)) return 100;
  if (normalizedTitle.includes(normalizedQuery)) return 90;
  if (querySlug && routeSlug.includes(querySlug)) return 85;
  if (queryTerms.every((term) => searchableText.includes(term))) return 70;
  if (normalizedDescription.includes(normalizedQuery)) return 55;
  return 0;
}

function normalizeSearchText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function stringControl(
  controls: Record<string, unknown>,
  key: string,
  fallback: string,
) {
  const value = controls[key];
  return typeof value === "string" && value.trim() ? value : fallback;
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function intParam(value: string | null) {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clampInt(value: string | null, min: number, max: number, fallback: number) {
  const parsed = value ? Number.parseInt(value, 10) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function encodeCursor(value: number) {
  return Buffer.from(String(value), "utf8").toString("base64url");
}

function decodeCursor(value: string | null) {
  if (!value) return 0;
  const decoded = Number.parseInt(Buffer.from(value, "base64url").toString("utf8"), 10);
  return Number.isFinite(decoded) && decoded >= 0 ? decoded : 0;
}

function formatCount(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function numberFromDb(value: number | bigint) {
  return typeof value === "bigint" ? Number(value) : value;
}

async function isCustomerEngagementActor(userId: string) {
  const actor = await prisma.user.findFirst({
    where: {
      id: userId,
      ...activeCustomerUserWhere,
    },
    select: { id: true },
  });
  return Boolean(actor);
}

async function assertDraftOwner(id: string, userId: string) {
  const draft = await prisma.characterDraft.findFirst({
    where: { id, ownerId: userId },
  });
  if (!draft) throw Errors.notFound("Character draft not found");
  return draft;
}

async function readableCharacter(id: string, userId: string) {
  const character = await prisma.character.findFirst({
    where: {
      id,
      deletedAt: null,
      OR: [
        publicCharacterAudienceWhere,
        { creatorId: userId },
      ],
    },
  });
  if (!character) throw Errors.notFound("Character not found");
  return character;
}

async function generationCharacter(id: string, userId: string) {
  const character = await readableCharacter(id, userId);
  if (character.age < 18) {
    throw Errors.badRequest("Character is not eligible for generation", {
      policyCode: "UNDERAGE",
    });
  }
  if (character.status !== "approved") {
    throw Errors.forbidden("Character is not approved for generation", {
      status: character.status,
    });
  }
  return character;
}

async function publishedGenerationVideoCharacter(id: string) {
  const character = await prisma.character.findFirst({
    where: {
      AND: [
        { id, age: { gte: 18 } },
        publicCharacterAudienceWhere,
      ],
    },
  });
  if (!character) throw Errors.notFound("Character not found");
  return character;
}

async function assertMediaOwner(id: string, userId: string) {
  const media = await prisma.mediaAsset.findFirst({
    where: { id, ownerId: userId, deletedAt: null },
  });
  if (!media) throw Errors.notFound("Media not found");
  return media;
}

async function findPublicReadableMediaAsset(id: string) {
  const media = await prisma.mediaAsset.findFirst({
    where: {
      AND: [
        publicReadableMediaAssetWhere,
        { id },
      ],
    },
  });
  return media &&
      evaluateMediaAssetCustomerPublishability({ metadata: media.metadata }).publishable
    ? media
    : null;
}

async function assertReadableMediaAsset(id: string, userId: string) {
  const media = await prisma.mediaAsset.findFirst({
    where: {
      id,
      deletedAt: null,
      OR: [
        ...(isReusablePlatformAssetWhere(userId).OR ?? []),
        publicReadableMediaAssetWhere,
      ],
    },
  });
  if (
    !media ||
    !isMediaAssetOperationalForAuthority(media.metadata)
  ) {
    throw Errors.notFound("Media not found");
  }
  return media;
}

async function assertIdentityImageMedia(id: string, userId: string) {
  const asset = await assertMediaOwner(id, userId);
  if (asset.type !== "image") throw Errors.badRequest("Only image media can update character identity");
  if (asset.safetyStatus !== "passed") {
    throw Errors.conflict("Only safety-passed media can update Character authority");
  }
  if (!isMediaAssetOperationalForAuthority(asset.metadata)) {
    throw Errors.conflict("Archived or rejected media cannot be used for Character authority");
  }
  assertNonSyntheticMediaAsset(
    asset,
    "Synthetic media cannot update character identity",
  );
  return asset;
}

async function assertIdentityImageMediaInTx(
  tx: Prisma.TransactionClient,
  id: string,
  userId: string,
) {
  const asset = await tx.mediaAsset.findFirst({
    where: { id, ownerId: userId, deletedAt: null },
  });
  if (!asset) throw Errors.notFound("Media not found");
  if (asset.type !== "image") {
    throw Errors.badRequest("Only image media can update character identity");
  }
  if (asset.safetyStatus !== "passed") {
    throw Errors.conflict("Only safety-passed media can update Character authority");
  }
  if (!isMediaAssetOperationalForAuthority(asset.metadata)) {
    throw Errors.conflict("Archived or rejected media cannot be used for Character authority");
  }
  assertNonSyntheticMediaAsset(
    asset,
    "Synthetic media cannot update character identity",
  );
  return asset;
}

async function assertIdentityImageMediaForCharacterInTx(
  tx: Prisma.TransactionClient,
  id: string,
  userId: string,
  characterId: string,
  options: { readonly allowUnassigned: boolean },
) {
  const asset = await assertIdentityImageMediaInTx(tx, id, userId);
  if (
    asset.characterId !== characterId &&
    !(options.allowUnassigned && asset.characterId === null)
  ) {
    throw Errors.conflict(
      "Media already belongs to another Character. Clone it before using it for a different Character.",
      {
        mediaAssetId: asset.id,
        mediaCharacterId: asset.characterId,
        targetCharacterId: characterId,
      },
    );
  }
  return asset;
}

function assertNonSyntheticMediaAsset(
  asset: { id: string; metadata: Prisma.JsonValue },
  message: string,
) {
  if (!isSyntheticMediaAsset(asset.metadata)) return;
  throw Errors.badRequest(message, { mediaAssetId: asset.id });
}

function assertPublicCollectionMediaAsset(asset: {
  id: string;
  type: string;
  url: string;
  deletedAt: Date | null;
  safetyStatus: string;
  metadata: Prisma.JsonValue;
}) {
  assertNonSyntheticMediaAsset(
    asset,
    "Synthetic media cannot be published in a public collection",
  );
  if (
    asset.deletedAt !== null ||
    !["image", "video"].includes(asset.type) ||
    !asset.url.trim() ||
    asset.safetyStatus !== "passed" ||
    !isMediaAssetOperationalForAuthority(asset.metadata)
  ) {
    throw Errors.badRequest(
      "Public collections require available, reviewed media",
      { mediaAssetId: asset.id },
    );
  }
}

async function assertIdentityTargetCharacter(characterId: string | null | undefined, userId: string) {
  if (!characterId) throw Errors.badRequest("Choose a character for this identity action");
  const character = await prisma.character.findFirst({
    where: { id: characterId, creatorId: userId, deletedAt: null },
  });
  if (!character) throw Errors.notFound("Owned character not found");
  return character;
}

async function assertIdentityTargetCharacterInTx(
  tx: Prisma.TransactionClient,
  characterId: string,
  userId: string,
) {
  const character = await tx.character.findFirst({
    where: { id: characterId, creatorId: userId, deletedAt: null },
  });
  if (!character) throw Errors.notFound("Owned character not found");
  return character;
}

async function assertCharacterIdentityAuthorityMutable(
  tx: Prisma.TransactionClient,
  characterId: string,
) {
  const serving = await tx.characterServing.findUnique({
    where: { characterId },
    select: { currentReleaseId: true, scheduledReleaseId: true },
  });
  if (serving?.currentReleaseId || serving?.scheduledReleaseId) {
    throw Errors.conflict(
      "Withdraw or replace serving Character Release authority before changing Visual Identity or Reference Set",
      {
        currentReleaseId: serving.currentReleaseId,
        scheduledReleaseId: serving.scheduledReleaseId,
        deepLink: `/admin/characters/${characterId}?tab=release`,
      },
    );
  }
  const projects = await tx.characterProject.findMany({
    where: { characterId },
    select: { id: true },
  });
  if (projects.length === 0) return;
  const activeRelease = await tx.characterRelease.findFirst({
    where: {
      projectId: { in: projects.map((project) => project.id) },
      status: { in: ["draft", "validating", "in_review", "approved"] },
    },
    select: { id: true, status: true },
  });
  if (!activeRelease) return;
  throw Errors.conflict(
    "Withdraw or finish the active Character Release before changing Visual Identity or Reference Set authority",
    {
      releaseId: activeRelease.id,
      releaseStatus: activeRelease.status,
      deepLink: `/admin/characters/${characterId}?tab=release`,
    },
  );
}

async function assertCharacterDisplayImageMutable(
  tx: Prisma.TransactionClient,
  characterId: string,
) {
  const serving = await tx.characterServing.findUnique({
    where: { characterId },
    select: { currentReleaseId: true, scheduledReleaseId: true },
  });
  if (serving?.currentReleaseId || serving?.scheduledReleaseId) {
    throw Errors.conflict(
      "Release-managed Character display images must change through Character Assets and Release",
      {
        currentReleaseId: serving.currentReleaseId,
        scheduledReleaseId: serving.scheduledReleaseId,
        deepLink: `/admin/characters/${characterId}?tab=assets`,
      },
    );
  }
  await assertCharacterIdentityAuthorityMutable(tx, characterId);
}

async function requireActiveVisualProfileInTx(
  tx: Prisma.TransactionClient,
  characterId: string,
) {
  const active = await tx.characterVisualProfile.findFirst({
    where: { characterId, status: "active" },
    orderBy: { version: "desc" },
  });
  if (!active) {
    throw Errors.conflict(
      "Establish a Character identity anchor before saving reusable Looks",
    );
  }
  if (jsonStringArray(active.anchorAssetIds).length === 0) {
    throw Errors.conflict(
      "Establish a Character identity anchor before saving reusable Looks",
    );
  }
  return active;
}

function mediaMetadataWithQuality(
  metadata: Prisma.JsonValue,
  qualityPatch: Record<string, unknown>,
) {
  const record = jsonRecord(metadata);
  const quality = jsonRecord(record.quality);
  return toInputJson({
    ...record,
    quality: {
      ...quality,
      ...qualityPatch,
    },
  });
}

function visualProfileDTO(profile: GenerationVisualProfile) {
  return {
    id: profile.id,
    version: profile.version,
    status: profile.status,
    style: profile.style,
    anchorAssetIds: profile.anchorAssetIds,
    referenceAssetIds: profile.referenceAssetIds,
    defaultSeed: profile.defaultSeed,
  };
}

type CharacterLookDTOInput = {
  id: string;
  characterId: string;
  visualProfileId: string;
  ownerId: string;
  label: string;
  appearanceDelta: Prisma.JsonValue;
  referenceAssetId: string | null;
  status: string;
  rebasedFromLookId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function characterLookSnapshot(look: CharacterLookDTOInput) {
  return {
    schemaVersion: "1",
    lookId: look.id,
    label: look.label,
    visualProfileId: look.visualProfileId,
    appearanceDelta: look.appearanceDelta,
    referenceAssetId: look.referenceAssetId,
    capturedAt: new Date().toISOString(),
  };
}

function characterLookDTO(look: CharacterLookDTOInput) {
  return {
    id: look.id,
    characterId: look.characterId,
    visualProfileId: look.visualProfileId,
    ownerId: look.ownerId,
    label: look.label,
    appearanceDelta: look.appearanceDelta,
    referenceAssetId: look.referenceAssetId,
    status: look.status,
    rebasedFromLookId: look.rebasedFromLookId,
    createdAt: look.createdAt,
    updatedAt: look.updatedAt,
  };
}

function referenceCandidateDTO(candidate: {
  id: string;
  visualProfileId: string;
  mediaAssetId: string;
  sourceJobId: string | null;
  proposedRole: string;
  qualityScore: number | null;
  identityScore: number | null;
  source: string;
  status: string;
  rejectionReason: string | null;
  promotedRevisionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: candidate.id,
    visualProfileId: candidate.visualProfileId,
    mediaAssetId: candidate.mediaAssetId,
    sourceJobId: candidate.sourceJobId,
    proposedRole: candidate.proposedRole,
    qualityScore: candidate.qualityScore,
    identityScore: candidate.identityScore,
    source: candidate.source,
    status: candidate.status,
    rejectionReason: candidate.rejectionReason,
    promotedRevisionId: candidate.promotedRevisionId,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
  };
}

function referenceSetRevisionDTO(revision: ReferenceSetWithReferences) {
  return {
    id: revision.id,
    visualProfileId: revision.visualProfileId,
    revision: revision.revision,
    status: revision.status,
    selectorVersion: revision.selectorVersion,
    createdFrom: revision.createdFrom,
    availableAtSnapshot: revision.availableAtSnapshot,
    references: referenceManifestFromRevision(revision),
    createdAt: revision.createdAt,
  };
}

function stringFromMediaDimensions(width: number | null, height: number | null) {
  if (!width || !height) return "4:5";
  const ratio = width / height;
  if (Math.abs(ratio - 1) < 0.08) return "1:1";
  if (ratio > 1.4) return "16:9";
  if (ratio < 0.62) return "9:16";
  if (ratio < 0.82) return "4:5";
  return "3:4";
}

function variationScenePrompt(prompt: string | null | undefined) {
  const clean = cleanPromptText(prompt, 1_200);
  const requested = /Requested scene:\s*([^.]*)/i.exec(clean)?.[1]?.trim();
  const scene = requested && requested.length > 0 ? requested : clean;
  const safeScene =
    scene && !/Locked identity:|Character:|Subject:/i.test(scene)
      ? scene
      : "the selected image composition, pose, outfit, lighting, and mood";
  return clampPrompt(`More like this image: ${safeScene}`, 900);
}

export async function moderateText(
  targetType: string,
  targetId: string,
  content: string,
  layer: string,
) {
  const result = await providers.moderation.check({
    targetType: "text",
    content,
  });
  if (!result.ok) throw Errors.internal(result.error.message, result.error);

  await prisma.moderationEvent.create({
    data: {
      targetType,
      targetId,
      layer,
      status: result.data.status,
      policyCode: result.data.policyCode,
      confidence: result.data.confidence,
      details: {},
    },
  });

  return result.data;
}

async function currentAgeVerificationStatus(userId: string) {
  const latest = await prisma.ageVerification.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  return latest?.status ?? "not_required";
}

async function dreamcoinBalance(userId: string, tx: Prisma.TransactionClient | typeof prisma = prisma) {
  const aggregate = await tx.dreamcoinLedger.aggregate({
    where: { userId },
    _sum: { delta: true },
  });
  return aggregate._sum.delta ?? 0;
}

async function appendLedger(
  tx: Prisma.TransactionClient,
  userId: string,
  delta: number,
  reason: string,
  sourceId?: string,
  idempotencyKey?: string,
) {
  if (idempotencyKey) {
    const existing = await tx.dreamcoinLedger.findUnique({ where: { idempotencyKey } });
    if (existing) {
      await linkGenerationLedgerEntry(tx, existing);
      return existing;
    }
  }
  await lockUserLedger(tx, userId);
  const balance = await dreamcoinBalance(userId, tx);
  const created = await tx.dreamcoinLedger.create({
    data: {
      userId,
      delta,
      balanceAfter: balance + delta,
      reason,
      sourceId,
      idempotencyKey,
    },
  });
  await linkGenerationLedgerEntry(tx, created);
  return created;
}

async function lockUserLedger(tx: Prisma.TransactionClient, userId: string) {
  await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
}

async function lockProviderEvent(tx: Prisma.TransactionClient, providerEventId: string) {
  await tx.$queryRaw`SELECT id FROM "provider_events" WHERE id = ${providerEventId} FOR UPDATE`;
}

async function lockCheckoutSession(tx: Prisma.TransactionClient, checkoutId: string) {
  await tx.$queryRaw`SELECT id FROM "checkout_sessions" WHERE id = ${checkoutId} FOR UPDATE`;
}

async function failQueuedGeneration(
  job: { id: string; userId: string; costDreamcoins: number },
  errorCode: string,
  error: unknown,
) {
  await prisma.$transaction(async (tx) => {
    const failedAt = new Date();
    await transitionGenerationRequest(tx, {
      requestId: job.id,
      to: "failed",
      expected: { from: "queued" },
      data: {
        errorCode,
        completedAt: null,
        finishedAt: failedAt,
        deliveredOutputCount: 0,
      },
    });
    if (job.costDreamcoins > 0) {
      await appendLedger(
        tx,
        job.userId,
        job.costDreamcoins,
        "refund",
        job.id,
        `generation:${job.id}:refund`,
      );
    }
    const attempt = await tx.generationAttempt.findFirst({
      where: { requestId: job.id },
      orderBy: { attemptNo: "desc" },
    });
    if (attempt) {
      await recordGenerationAttemptEvent(tx, {
        eventId: `${attempt.id}:terminal`,
        attemptId: attempt.id,
        eventType: "generation.attempt.failed.v1",
        outcome: "failed",
        occurredAt: failedAt,
        payload: { requestId: job.id, errorCode, stage: "queue_enqueue" },
        errorCode,
        retryability: "retryable",
      });
    }
    await appendGenerationEvent(tx, job.id, "failed", "Generation queue enqueue failed", {
      errorCode,
      message: error instanceof Error ? error.message : String(error),
    });
    await appendGenerationEvent(tx, job.id, "refunded", "Dreamcoins refunded", {
      amount: job.costDreamcoins,
    });
  });
}

async function appendGenerationEvent(
  tx: Prisma.TransactionClient,
  jobId: string,
  type: string,
  message: string,
  metadata: Record<string, unknown>,
) {
  return tx.generationJobEvent.create({
    data: {
      jobId,
      type,
      message,
      metadata: toInputJson(metadata),
    },
  });
}

async function enqueueGenerationJob(job: {
  id: string;
  userId: string;
  characterId: string | null;
  visualProfileId: string | null;
  visualProfileVersion: number | null;
  mode: string;
  prompt: string | null;
  negativePrompt: string | null;
  controls: Prisma.JsonValue;
  presetIds: Prisma.JsonValue;
  model: string | null;
  profileId: string | null;
  profileVersion: number | null;
  orientation: string | null;
  outputCount: number;
  seed?: string | null;
  sourceType?: string | null;
  referenceAssetIds?: Prisma.JsonValue | null;
  referenceSetRevisionId?: string | null;
  referenceManifest?: Prisma.JsonValue | null;
}) {
  return enqueueGenerationAttempt(job);
}

function generationModelCapabilities(runner: string, runnerConfig: Prisma.JsonValue) {
  const config = jsonRecord(runnerConfig);
  const capabilities = jsonRecord(config.capabilities);
  const initImageDefault = runner === "sd_cpp";
  return {
    textToImage: booleanFromRecord(capabilities, "textToImage", true),
    stableSeed: booleanFromRecord(capabilities, "stableSeed", true),
    referenceImages: booleanFromRecord(capabilities, "referenceImages", false),
    initImage: booleanFromRecord(capabilities, "initImage", initImageDefault),
    lora: booleanFromRecord(capabilities, "lora", false),
  };
}

function stringFromRecord(value: Record<string, unknown>, key: string) {
  const child = value[key];
  return typeof child === "string" && child.trim() ? child.trim() : undefined;
}

function numberFromRecord(value: Record<string, unknown>, key: string) {
  const child = value[key];
  return typeof child === "number" && Number.isFinite(child) ? child : undefined;
}

function booleanFromRecord(value: Record<string, unknown>, key: string, fallback: boolean) {
  const child = value[key];
  return typeof child === "boolean" ? child : fallback;
}

function pruneUndefined(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}

function activeGenerationStatuses() {
  return ["queued", "moderating_input", "running", "moderating_output"];
}

function maxInflightJobs(entitlements: Record<string, Prisma.JsonValue>) {
  const configured = Number.parseInt(process.env.MAX_INFLIGHT_JOBS_PER_USER ?? "3", 10);
  const base = Number.isFinite(configured) && configured > 0 ? configured : 3;
  const plan = entitlements.plan;
  if (isRecord(plan) && plan.slug === "deluxe") return Math.max(base, 6);
  return base;
}

function signedUrlTtlSeconds() {
  const configured = Number.parseInt(
    process.env.SIGNED_URL_TTL_SECONDS ?? process.env.SIGNED_URL_TTL ?? "900",
    10,
  );
  return Number.isFinite(configured) && configured > 0 ? configured : 900;
}

async function generationCost(mode: "image" | "video", outputCount: number, multiplier = 1) {
  return generationCostDreamcoins(mode, outputCount, multiplier);
}

type GenerationReferenceRouteRequirement = {
  readonly assetId: string;
  readonly role: "identity_anchor" | "identity_reference";
};

type GenerationReferenceProfile = {
  readonly profileKey: string;
  readonly version: number;
  readonly runner: string;
  readonly runnerConfig: Prisma.JsonValue | null;
  readonly workflowKey: string | null;
  readonly pipelineModel: string;
};

async function generationReferenceRouteRequirements(
  visualProfileId: string,
): Promise<GenerationReferenceRouteRequirement[]> {
  const revision = await prisma.referenceSetRevision.findFirst({
    where: { visualProfileId, status: "active" },
    orderBy: { revision: "desc" },
    select: {
      references: {
        orderBy: { position: "asc" },
        select: { mediaAssetId: true, role: true },
      },
    },
  });
  return revision?.references.map((reference) => ({
    assetId: reference.mediaAssetId,
    role: normalizedGenerationReferenceRole(reference.role),
  })) ?? [];
}

function generationRequirementsFromManifest(
  value: unknown,
): GenerationReferenceRouteRequirement[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = jsonRecord(entry);
    const assetId = stringFromRecord(record, "mediaAssetId");
    const role = stringFromRecord(record, "role");
    if (
      !assetId ||
      !role ||
      role === "source_image" ||
      role === "look_reference"
    ) {
      return [];
    }
    return [{
      assetId,
      role: normalizedGenerationReferenceRole(role),
    }];
  });
}

function normalizedGenerationReferenceRole(
  role: string,
): GenerationReferenceRouteRequirement["role"] {
  return role === "primary_face" || role === "identity_anchor"
    ? "identity_anchor"
    : "identity_reference";
}

function generationProfileReferenceIncompatibilities(input: {
  readonly profile: GenerationReferenceProfile;
  readonly workflowDescriptor: Awaited<ReturnType<typeof generationWorkflowDescriptor>>;
  readonly pinnedReferences: readonly GenerationReferenceRouteRequirement[];
  readonly sourceImageAssetId: string | null;
  readonly lookReferenceAssetId: string | null;
}) {
  const capabilities = generationModelCapabilities(
    input.profile.runner,
    input.profile.runnerConfig ?? {},
  );
  const reasons: string[] = [];
  if (
    (
      input.pinnedReferences.length > 0 ||
      input.lookReferenceAssetId
    ) &&
    !capabilities.referenceImages
  ) {
    reasons.push("profile_reference_images_unsupported");
  }
  if (input.sourceImageAssetId && !capabilities.initImage) {
    reasons.push("profile_source_image_unsupported");
  }
  const workflow = input.workflowDescriptor;
  const requiredRoles = [
    ...input.pinnedReferences.map((reference) => reference.role),
    ...(input.lookReferenceAssetId ? ["look_reference" as const] : []),
    ...(input.sourceImageAssetId ? ["source_image" as const] : []),
  ];
  if (!workflow && requiredRoles.length > 0) {
    reasons.push("workflow_descriptor_missing");
  }
  if (workflow) {
    if (
      requiredRoles.length > 0 &&
      (
        !workflow.capabilities.includes("referenceImages") ||
        workflow.identity.mode === "none"
      )
    ) {
      reasons.push("workflow_reference_images_unsupported");
    }
    const acceptedRoles = new Set(workflow.identity.acceptedRoles);
    if (
      acceptedRoles.size > 0 &&
      requiredRoles.some((role) => !acceptedRoles.has(role))
    ) {
      reasons.push("workflow_reference_role_unsupported");
    }
    const slotAuthority = assignWorkflowReferenceSlots(
      workflow,
      requiredRoles,
    );
    if (!slotAuthority.ok) {
      reasons.push(
        slotAuthority.reason === "reference_cardinality_mismatch"
          ? "workflow_reference_cardinality_mismatch"
          : "workflow_reference_slot_assignment_unsupported",
      );
    }
    if (
      input.lookReferenceAssetId &&
      !workflow.identity.supportsLookReference
    ) {
      reasons.push("workflow_look_reference_unsupported");
    }
    if (
      input.sourceImageAssetId &&
      (
        input.pinnedReferences.length > 0 ||
        Boolean(input.lookReferenceAssetId)
      ) &&
      !workflow.identity.supportsSourceImageWithIdentity
    ) {
      reasons.push("workflow_source_with_identity_unsupported");
    }
  }
  return [...new Set(reasons)];
}

function assertGenerationProfileCanDispatchReferences(input: {
  readonly profile: GenerationReferenceProfile;
  readonly workflowDescriptor: Awaited<ReturnType<typeof generationWorkflowDescriptor>>;
  readonly pinnedReferences: readonly GenerationReferenceRouteRequirement[];
  readonly sourceImageAssetId: string | null;
  readonly lookReferenceAssetId: string | null;
}) {
  const incompatibilities = generationProfileReferenceIncompatibilities(input);
  if (incompatibilities.length === 0) return;
  throw Errors.conflict(
    "Selected generation profile cannot preserve the complete pinned Character reference authority",
    {
      profileId: input.profile.profileKey,
      profileVersion: input.profile.version,
      pinnedReferenceAssetIds: input.pinnedReferences.map((reference) => reference.assetId),
      sourceImageAssetId: input.sourceImageAssetId,
      lookReferenceAssetId: input.lookReferenceAssetId,
      incompatibilities,
    },
  );
}

async function selectGenerationProfile(
  mode: "image" | "video",
  requested?: string,
  referenceRequirements?: {
    readonly pinnedReferences: readonly GenerationReferenceRouteRequirement[];
    readonly sourceImageAssetId: string | null;
    readonly lookReferenceAssetId: string | null;
  },
  requirePublicTextToImageProfile = false,
  accessibleEntitlements?: Readonly<Record<string, Prisma.JsonValue>>,
  requirePublicImageEditProfile = false,
) {
  const where: Prisma.GenerationModelProfileWhereInput = {
    mode,
    status: "active",
    enabled: true,
    OR: requested
      ? [{ profileKey: requested }, { id: requested }, { pipelineModel: requested }]
      : undefined,
  };
  const queriedCandidates = await prisma.generationModelProfile.findMany({
    where,
    orderBy: requested
      ? [{ version: "desc" }]
      : [{ costMultiplier: "asc" }, { version: "desc" }],
  });
  const automaticCandidates = requested
    ? queriedCandidates
    : queriedCandidates.filter(
        (candidate) => !generationProfileIsExplicitSelectionOnly(candidate),
      );
  const eligibleCandidates = requirePublicTextToImageProfile
    ? await filterPublicTextToImageGenerationProfiles(automaticCandidates)
    : requirePublicImageEditProfile
      ? (
          await projectPublicImageEditGenerationProfiles(automaticCandidates)
        ).map(({ profile }) => profile)
      : automaticCandidates.filter(isExecutableGenerationProfile);
  const accessibleCandidates =
    !requested && accessibleEntitlements
      ? eligibleCandidates.filter(
          (candidate) =>
            !candidate.requiredEntitlement ||
            Boolean(
              accessibleEntitlements[candidate.requiredEntitlement],
            ),
        )
      : eligibleCandidates;
  const gatedCandidates =
    !requested && accessibleEntitlements
      ? eligibleCandidates.filter(
          (candidate) => !accessibleCandidates.includes(candidate),
        )
      : [];
  if (referenceRequirements) {
    // Prefer an accessible compatible route. Only if none exists do we return
    // a gated compatible route so the caller can surface the exact entitlement
    // requirement instead of silently selecting it ahead of an accessible one.
    for (const candidateGroup of [accessibleCandidates, gatedCandidates]) {
      for (const candidate of candidateGroup) {
        const workflowDescriptor = await generationWorkflowDescriptor(
          candidate.workflowKey ?? candidate.pipelineModel,
        );
        if (
          generationProfileReferenceIncompatibilities({
            profile: candidate,
            workflowDescriptor,
            ...referenceRequirements,
          }).length === 0
        ) {
          return candidate;
        }
      }
    }
    if (eligibleCandidates.length === 0) {
      if (requested) {
        throw Errors.conflict("Requested generation profile is unavailable", {
          mode,
          requestedProfile: requested,
        });
      }
      throw Errors.unavailable(
        "No active generation model profile is configured",
        { mode, reason: "no_active_model" },
      );
    }
    throw Errors.conflict(
      requested
        ? "The selected generation profile cannot preserve pinned Character references"
        : "No active generation profile can preserve pinned Character references",
      {
        requestedProfile: requested ?? null,
        pinnedReferenceAssetIds: referenceRequirements.pinnedReferences.map(
          (reference) => reference.assetId,
        ),
        sourceImageAssetId: referenceRequirements.sourceImageAssetId,
        lookReferenceAssetId: referenceRequirements.lookReferenceAssetId,
      },
    );
  }
  const requestedProfile = requested ? eligibleCandidates[0] : null;
  if (requested && !requestedProfile) {
    throw Errors.conflict("Requested generation profile is unavailable", {
      mode,
      requestedProfile: requested,
    });
  }
  const fallbackProfile =
    requestedProfile ??
    accessibleCandidates[0] ??
    gatedCandidates[0] ??
    eligibleCandidates[0];
  if (!fallbackProfile) {
    throw Errors.unavailable(
      "No active generation model profile is configured",
      { mode, reason: "no_active_model" },
    );
  }
  return fallbackProfile;
}

async function selectRecipe(mode: "image" | "video", useCase: "character" | "freeplay") {
  const recipe = await prisma.generationRecipe.findFirst({
    where: { mode, useCase, status: "active" },
    orderBy: { version: "desc" },
  });
  if (!recipe) {
    throw Errors.unavailable(
      "No active generation prompt recipe is configured",
      { mode, useCase, reason: "no_active_recipe" },
    );
  }
  return recipe;
}

async function featureFlagEnabled(key: string) {
  const flag = await prisma.featureFlag.findUnique({
    where: { key },
    select: { enabled: true, rolloutPercent: true },
  });
  if (!flag?.enabled || flag.rolloutPercent !== 100) return false;
  return true;
}

type PublicOfferAvailability = {
  readonly videoGeneration: boolean;
};

async function publicOfferAvailability(): Promise<PublicOfferAvailability> {
  const now = new Date();
  const [videoEnabled, videoProfiles, videoRecipes, videoPricing] = await Promise.all([
    featureFlagEnabled("video_gen"),
    prisma.generationModelProfile.findMany({
      where: { mode: "video", status: "active", enabled: true },
      select: {
        allowedOrientations: true,
        maxCount: true,
        rolloutPercent: true,
      },
    }),
    prisma.generationRecipe.findMany({
      where: { mode: "video", status: "active" },
      select: { useCase: true },
    }),
    prisma.pricingRule.findMany({
      where: {
        mode: "video",
        status: "active",
        OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: now } }],
      },
      select: { id: true },
      take: 2,
    }),
  ]);

  return {
    videoGeneration:
      videoEnabled &&
      videoProfiles.some(isExecutableGenerationProfile) &&
      hasCompleteGenerationRecipeSet(videoRecipes) &&
      videoPricing.length === 1,
  };
}

function publicFeatureProjection(
  value: unknown,
  availability: PublicOfferAvailability,
) {
  const features =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : {};

  if (!availability.videoGeneration) {
    if ("videoGeneration" in features) features.videoGeneration = false;
    if ("video_generation" in features) features.video_generation = false;
  }

  return features;
}

function profileConfigDTO(profile: {
  id: string;
  profileKey: string;
  label: string;
  mode: string;
  allowedOrientations: Prisma.JsonValue;
  defaultWidth: number;
  defaultHeight: number;
  costMultiplier: number;
  requiredEntitlement: string | null;
  maxCount: number;
  rolloutPercent: number;
  version: number;
}) {
  return {
    id: profile.profileKey,
    label: profile.label,
    profileId: profile.profileKey,
    rowId: profile.id,
    version: profile.version,
    mode: profile.mode,
    orientations: supportedProfileOrientations(profile.allowedOrientations),
    defaultWidth: profile.defaultWidth,
    defaultHeight: profile.defaultHeight,
    costMultiplier: profile.costMultiplier,
    entitlement: profile.requiredEntitlement,
    maxCount: profile.maxCount,
    rolloutPercent: profile.rolloutPercent,
  };
}

function supportedProfileOrientations(value: Prisma.JsonValue) {
  return jsonStringArray(value).filter(
    (orientation) =>
      orientation === "2:3" ||
      imageOrientations.includes(
        orientation as (typeof imageOrientations)[number],
      ),
  );
}

function isExecutableGenerationProfile(profile: {
  readonly allowedOrientations: Prisma.JsonValue;
  readonly maxCount: number;
  readonly rolloutPercent: number;
}) {
  return (
    profile.rolloutPercent === 100 &&
    profile.maxCount >= 1 &&
    profile.maxCount <= 8 &&
    supportedProfileOrientations(profile.allowedOrientations).length > 0
  );
}

type PublicTextToImageGenerationProfile = {
  readonly mode: string;
  readonly runner: string;
  readonly runnerConfig: Prisma.JsonValue | null;
  readonly workflowKey: string | null;
  readonly pipelineModel: string;
  readonly allowedOrientations: Prisma.JsonValue;
  readonly maxCount: number;
  readonly rolloutPercent: number;
};

async function isPublicTextToImageGenerationProfile(
  profile: PublicTextToImageGenerationProfile,
) {
  if (
    profile.mode !== "image" ||
    !isExecutableGenerationProfile(profile)
  ) {
    return false;
  }

  const configuredCapabilities = jsonRecord(
    jsonRecord(profile.runnerConfig).capabilities,
  );
  const configuredTextToImage = configuredCapabilities.textToImage;
  if (configuredTextToImage === false) return false;

  const workflow = await generationWorkflowDescriptor(
    profile.workflowKey ?? profile.pipelineModel,
  );
  if (workflow) {
    return (
      workflow.capabilities.includes("textToImage") &&
      !workflow.inputs.some((input) => input.type === "image")
    );
  }

  // A profile without a declarative workflow still needs affirmative runtime
  // authority. sd.cpp is intrinsically text-to-image unless explicitly
  // disabled; every other runner must declare the capability itself.
  return configuredTextToImage === true || profile.runner === "sd_cpp";
}

async function filterPublicTextToImageGenerationProfiles<
  T extends PublicTextToImageGenerationProfile,
>(profiles: readonly T[]): Promise<T[]> {
  const eligibility = await Promise.all(
    profiles.map(async (profile) => ({
      profile,
      eligible: await isPublicTextToImageGenerationProfile(profile),
    })),
  );
  return eligibility.flatMap(({ profile, eligible }) =>
    eligible ? [profile] : [],
  );
}

type PublicImageEditReferenceMode = "source_only" | "identity_source";

function generationProfilePublicSelection(profile: {
  readonly runnerConfig: Prisma.JsonValue | null;
}) {
  return jsonRecord(jsonRecord(profile.runnerConfig).publicSelection);
}

function generationProfileIsExplicitSelectionOnly(profile: {
  readonly runnerConfig: Prisma.JsonValue | null;
}) {
  return generationProfilePublicSelection(profile).explicitOnly === true;
}

async function projectPublicImageEditGenerationProfiles<
  T extends PublicTextToImageGenerationProfile,
>(profiles: readonly T[]) {
  const projections = await Promise.all(
    profiles.map(async (profile) => {
      const publicSelection = generationProfilePublicSelection(profile);
      if (
        publicSelection.surface !== "generator_image_edit" ||
        profile.mode !== "image" ||
        !isExecutableGenerationProfile(profile) ||
        !generationModelCapabilities(
          profile.runner,
          profile.runnerConfig ?? {},
        ).initImage
      ) {
        return null;
      }
      const workflow = await generationWorkflowDescriptor(
        profile.workflowKey ?? profile.pipelineModel,
      );
      if (
        !workflow ||
        !workflow.capabilities.includes("img2img") ||
        !workflow.inputs.some(
          (input) =>
            input.type === "image" &&
            "referenceRoles" in input &&
            input.referenceRoles?.includes("source_image"),
        )
      ) {
        return null;
      }
      const referenceMode: PublicImageEditReferenceMode =
        workflow.identity.supportsSourceImageWithIdentity
          ? "identity_source"
          : "source_only";
      return { profile, referenceMode, workflowDescriptor: workflow };
    }),
  );
  return projections.flatMap((projection) =>
    projection ? [projection] : [],
  );
}

function recipeConfigDTO(recipe: {
  id: string;
  recipeKey: string;
  label: string;
  mode: string;
  useCase: string;
  version: number;
}) {
  return {
    id: recipe.recipeKey,
    rowId: recipe.id,
    label: recipe.label,
    mode: recipe.mode,
    useCase: recipe.useCase,
    version: recipe.version,
  };
}

function hasCompleteGenerationRecipeSet(
  recipes: ReadonlyArray<{ readonly useCase: string }>,
) {
  const useCases = new Set(recipes.map((recipe) => recipe.useCase));
  return useCases.has("character") && useCases.has("freeplay");
}

function hasCharacterGenerationRecipe(
  recipes: ReadonlyArray<{ readonly useCase: string }>,
) {
  return recipes.some((recipe) => recipe.useCase === "character");
}

async function entitlementMap(userId: string) {
  const now = new Date();
  const [entitlements, activeSubscriptions] = await Promise.all([
    prisma.entitlement.findMany({
      where: {
        userId,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    }),
    prisma.subscription.findMany({
      where: {
        userId,
        status: "active",
        OR: [{ currentPeriodEnd: null }, { currentPeriodEnd: { gt: now } }],
      },
      include: { plan: true },
      orderBy: [{ currentPeriodEnd: "desc" }, { createdAt: "desc" }],
    }),
  ]);
  const map: Record<string, Prisma.JsonValue> = {};

  for (const subscription of activeSubscriptions) {
    if (map.plan === undefined) {
      map.plan = {
        slug: subscription.plan.slug,
        billingPeriod: subscription.plan.billingPeriod,
      };
    }
    mergeDerivedEntitlement(map, "premium_controls", true);
    for (const [key, value] of Object.entries(subscription.plan.features as JsonRecord)) {
      mergeDerivedEntitlement(map, featureKey(key), value ?? false);
    }
  }

  for (const entitlement of entitlements) map[entitlement.key] = entitlement.value;
  return map;
}

type PublicSubscriptionSource = {
  id: string;
  userId: string;
  planId: string;
  provider: string;
  providerSubscriptionId: string | null;
  status: string;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
};

async function publicSubscriptionDTO(subscription: PublicSubscriptionSource) {
  const checkout = subscription.providerSubscriptionId
    ? await prisma.checkoutSession.findUnique({
        where: {
          provider_providerSessionId: {
            provider: subscription.provider,
            providerSessionId: subscription.providerSubscriptionId,
          },
        },
        select: { offerSnapshot: true, planId: true },
      })
    : null;
  const offerSnapshot = checkoutOfferSnapshotSchema.safeParse(
    checkout?.offerSnapshot,
  );
  const authoritativeOffer =
    offerSnapshot.success &&
    offerSnapshot.data.planId === subscription.planId &&
    checkout?.planId === subscription.planId
      ? offerSnapshot.data
      : null;
  const availability = authoritativeOffer
    ? await publicOfferAvailability()
    : null;
  return {
    id: subscription.id,
    userId: subscription.userId,
    planId: subscription.planId,
    status: subscription.status,
    offerAuthority: authoritativeOffer
      ? "checkout_snapshot"
      : "unavailable",
    plan: authoritativeOffer
      ? {
          id: authoritativeOffer.planId,
          slug: authoritativeOffer.slug,
          name: authoritativeOffer.name,
          billingPeriod: authoritativeOffer.billingPeriod,
          priceCents: authoritativeOffer.priceCents,
          includedDreamcoins: authoritativeOffer.includedDreamcoins,
          features: publicFeatureProjection(
            authoritativeOffer.features,
            availability ?? { videoGeneration: false },
          ),
        }
      : null,
  };
}

function billingAccessDTO(subscription: PublicSubscriptionSource) {
  const capabilities = paymentProviderCapabilities(subscription.provider);
  const benefitsEndAt =
    subscription.currentPeriodEnd?.toISOString() ?? null;
  return {
    provider: subscription.provider,
    ...capabilities,
    benefitsEndAt,
    renewsAt:
      capabilities.billingModel === "recurring" &&
      !subscription.cancelAtPeriodEnd
        ? benefitsEndAt
        : null,
  };
}

function assertRenewalMutationSupported(
  subscription: Pick<PublicSubscriptionSource, "provider">,
) {
  const capabilities = paymentProviderCapabilities(subscription.provider);
  if (capabilities.renewalCapability === "cancel_resume") return;
  throw Errors.conflict(
    capabilities.billingModel === "prepaid_period"
      ? "This access is prepaid and does not renew automatically."
      : "Renewal changes are not supported for this billing provider.",
    {
      code: "renewal_not_supported",
      ...capabilities,
    },
  );
}

async function assertNoActiveSamePlanAccessInTx(
  tx: Prisma.TransactionClient,
  userId: string,
  planId: string,
  now: Date,
) {
  await expireEndedSubscriptionsInTx(tx, userId, now);
  const activeSamePlan = await tx.subscription.findFirst({
    where: {
      ...activeSubscriptionWhere(userId, now),
      planId,
    },
    orderBy: [{ currentPeriodEnd: "desc" }, { createdAt: "desc" }],
  });
  if (!activeSamePlan) return;

  const capabilities = paymentProviderCapabilities(activeSamePlan.provider);
  throw Errors.conflict(
    capabilities.billingModel === "prepaid_period"
      ? "This prepaid plan is already active. Buy it again after the current access period ends."
      : "This plan is already active.",
    {
      code: "active_prepaid_access_exists",
      idempotencyAction: "new_key",
      billingModel: capabilities.billingModel,
      renewalCapability: capabilities.renewalCapability,
      benefitsEndAt: activeSamePlan.currentPeriodEnd?.toISOString() ?? null,
    },
  );
}

async function activeSamePlanProviderDispatchInTx(
  tx: Prisma.TransactionClient,
  userId: string,
  planId: string,
  excludedCheckoutId: string,
  now: Date,
) {
  return tx.checkoutSession.findFirst({
    where: {
      id: { not: excludedCheckoutId },
      userId,
      planId,
      status: "provider_dispatching",
      providerSessionId: null,
      providerAttemptedAt: { not: null },
      dispatchToken: { not: null },
      dispatchLeaseUntil: { gt: now },
    },
    select: {
      id: true,
      dispatchLeaseUntil: true,
    },
  });
}

async function expireEndedSubscriptionsInTx(
  tx: Prisma.TransactionClient,
  userId: string,
  now: Date,
) {
  const ended = await tx.subscription.findMany({
    where: {
      userId,
      status: "active",
      currentPeriodEnd: { lte: now },
    },
    select: { id: true, userId: true },
  });
  if (ended.length === 0) return;

  const endedIds = ended.map((subscription) => subscription.id);
  await tx.subscription.updateMany({
    where: {
      id: { in: endedIds },
      status: "active",
      currentPeriodEnd: { lte: now },
    },
    data: {
      status: "expired",
      cancelAtPeriodEnd: false,
    },
  });
  await tx.entitlement.deleteMany({
    where: {
      userId,
      source: "subscription",
      expiresAt: { lte: now },
    },
  });
  for (const subscription of ended) {
    await appendCanonicalMetricEvent(tx, {
      sourceEventId: `subscription:${subscription.id}:ended:period_expired`,
      eventType: METRIC_PRODUCT_EVENTS.subscriptionEnded,
      occurredAt: now,
      userId: subscription.userId,
      context: { source: "checkout_expiry_reconciliation" },
      payload: {
        subscriptionId: subscription.id,
        userId: subscription.userId,
        reason: "period_expired",
      },
    });
  }
}

function activeSubscriptionWhere(userId: string, now = new Date()): Prisma.SubscriptionWhereInput {
  return {
    userId,
    status: "active",
    OR: [{ currentPeriodEnd: null }, { currentPeriodEnd: { gt: now } }],
  };
}

function mergeDerivedEntitlement(
  map: Record<string, Prisma.JsonValue>,
  key: string,
  value: Prisma.JsonValue,
) {
  const current = map[key];
  if (current === undefined) {
    map[key] = value;
    return;
  }
  if (typeof current === "boolean" && typeof value === "boolean") {
    map[key] = current || value;
    return;
  }
  if (typeof current === "number" && typeof value === "number") {
    map[key] = Math.max(current, value);
  }
}

async function findPlan(input: z.infer<typeof checkoutSchema>) {
  const plan = input.planId
    ? await prisma.plan.findUnique({ where: { id: input.planId } })
    : await prisma.plan.findUnique({
        where: {
          slug_billingPeriod: {
            slug: input.slug ?? "premium",
            billingPeriod: input.billingPeriod,
          },
        },
      });
  if (!plan || !plan.active) throw Errors.notFound("Plan not found");
  return plan;
}

async function activateSubscriptionInTx(
  tx: Prisma.TransactionClient,
  userId: string,
  planId: string,
  providerSubscriptionId: string,
  provider: string,
  offerSnapshot: z.infer<typeof checkoutOfferSnapshotSchema>,
  purchaseAuthority: {
    checkoutId: string;
    createdAt: Date;
  },
) {
  if (offerSnapshot.planId !== planId) {
    throw Errors.conflict("Checkout offer snapshot does not match its plan");
  }
  const entitlementPlan = {
    slug: offerSnapshot.slug,
    billingPeriod: offerSnapshot.billingPeriod,
    features: offerSnapshot.features as Prisma.JsonValue,
  };
  const includedDreamcoins = offerSnapshot.includedDreamcoins;
  // A payment replay is identified by the provider invoice, never merely by plan.
  // Distinct settled invoices are distinct purchases and must not be silently
  // discarded as a same-plan replay.
  await lockUserLedger(tx, userId);
  const competingDispatch = await activeSamePlanProviderDispatchInTx(
    tx,
    userId,
    planId,
    purchaseAuthority.checkoutId,
    new Date(),
  );
  if (competingDispatch) {
    return {
      subscription: null,
      created: false,
      reconciliationRequired: false,
      settlementDeferred: true,
      deferredByCheckoutId: competingDispatch.id,
    } as const;
  }
  const replay = await tx.subscription.findFirst({
    where: {
      provider,
      providerSubscriptionId,
    },
  });
  if (replay) {
    if (replay.userId !== userId || replay.planId !== planId) {
      throw Errors.conflict(
        "The provider invoice is already bound to different billing authority.",
        { provider, providerSubscriptionId },
      );
    }
    if (replay.status === "active") {
      await syncSubscriptionEntitlements(
        tx,
        userId,
        entitlementPlan,
        replay.currentPeriodEnd,
      );
    }
    return {
      subscription: replay,
      created: false,
      reconciliationRequired: false,
      settlementDeferred: false,
    } as const;
  }

  const now = new Date();
  await expireEndedSubscriptionsInTx(tx, userId, now);
  const superseded = await tx.subscription.findMany({
    where: activeSubscriptionWhere(userId, now),
    select: {
      id: true,
      userId: true,
      planId: true,
      provider: true,
      providerSubscriptionId: true,
      currentPeriodEnd: true,
    },
  });
  const activePurchaseAuthority = await resolveActivePurchaseOrderAuthority(
    tx,
    superseded,
    purchaseAuthority,
  );
  if (activePurchaseAuthority.kind === "unavailable") {
    return {
      subscription: null,
      created: false,
      reconciliationRequired: true,
      reconciliationReason: "active_purchase_authority_unavailable",
      settlementDeferred: false,
    } as const;
  }
  const billingPeriod = offerSnapshot.billingPeriod;
  if (billingPeriod !== "monthly" && billingPeriod !== "yearly") {
    throw Errors.conflict("Plan billing period is not supported");
  }

  if (activePurchaseAuthority.kind === "newer") {
    const newerAccess = activePurchaseAuthority.subscription;
    const convertedAccess = convertedPrepaidAccessEnd({
      currentOffer: offerSnapshot,
      newerOffer: activePurchaseAuthority.offerSnapshot,
      newerAccessEnd: newerAccess.currentPeriodEnd,
      now,
    });
    if (!convertedAccess.ok) {
      return {
        subscription: null,
        created: false,
        reconciliationRequired: true,
        reconciliationReason: "prepaid_value_conversion_unavailable",
        settlementDeferred: false,
      } as const;
    }
    const extendedEnd = convertedAccess.currentPeriodEnd;
    const preserved = await tx.subscription.update({
      where: { id: newerAccess.id },
      data: { currentPeriodEnd: extendedEnd },
    });
    await tx.entitlement.updateMany({
      where: { userId, source: "subscription" },
      data: { expiresAt: extendedEnd },
    });
    const appliedPurchase = await tx.subscription.create({
      data: {
        userId,
        planId,
        provider,
        providerSubscriptionId,
        status: "checkout_completed",
        currentPeriodEnd: extendedEnd,
      },
    });
    await appendLedger(
      tx,
      userId,
      includedDreamcoins,
      "subscription_grant",
      appliedPurchase.id,
      `subscription:grant:${provider}:${providerSubscriptionId}`,
    );
    await appendCanonicalMetricEvent(tx, {
      sourceEventId: `subscription:${appliedPurchase.id}:activated`,
      eventType: METRIC_PRODUCT_EVENTS.subscriptionActivated,
      occurredAt: appliedPurchase.createdAt,
      userId,
      context: {
        providerSubscriptionId,
        source: "late_purchase_applied_to_newer_access",
        activeSubscriptionId: preserved.id,
      },
      payload: {
        subscriptionId: appliedPurchase.id,
        userId,
        planId,
      },
    });
    return {
      subscription: preserved,
      created: true,
      reconciliationRequired: false,
      settlementDeferred: false,
    } as const;
  }

  const samePlanAccess = superseded.find(
    (subscription) => subscription.planId === planId,
  );
  const supersededCount = await tx.subscription.updateMany({
    where: activeSubscriptionWhere(userId, now),
    data: { status: "canceled", cancelAtPeriodEnd: false },
  });
  if (supersededCount.count > 0) {
    await tx.entitlement.deleteMany({ where: { userId, source: "subscription" } });
    for (const previous of superseded) {
      const samePlanPurchase = previous.planId === planId;
      await appendCanonicalMetricEvent(tx, {
        sourceEventId: `subscription:${previous.id}:ended:${providerSubscriptionId}`,
        eventType: METRIC_PRODUCT_EVENTS.subscriptionEnded,
        occurredAt: now,
        userId: previous.userId,
        context: {
          source: samePlanPurchase
            ? "new_prepaid_period"
            : "plan_switch",
        },
        payload: {
          subscriptionId: previous.id,
          userId: previous.userId,
          reason: samePlanPurchase
            ? "superseded_by_new_prepaid_period"
            : "superseded_by_plan_switch",
        },
      });
    }
  }
  const periodStartsAt =
    samePlanAccess?.currentPeriodEnd &&
    samePlanAccess.currentPeriodEnd > now
      ? samePlanAccess.currentPeriodEnd
      : now;
  const currentPeriodEnd = billingPeriodEnd(periodStartsAt, billingPeriod);
  const subscription = await tx.subscription.create({
    data: {
      userId,
      planId,
      provider,
      providerSubscriptionId,
      status: "active",
      currentPeriodEnd,
    },
  });
  await syncSubscriptionEntitlements(tx, userId, entitlementPlan, currentPeriodEnd);
  await appendLedger(
    tx,
    userId,
    includedDreamcoins,
    "subscription_grant",
    subscription.id,
    `subscription:grant:${provider}:${providerSubscriptionId}`,
  );
  await appendCanonicalMetricEvent(tx, {
    sourceEventId: `subscription:${subscription.id}:activated`,
    eventType: METRIC_PRODUCT_EVENTS.subscriptionActivated,
    occurredAt: subscription.createdAt,
    userId,
    context: { providerSubscriptionId },
    payload: { subscriptionId: subscription.id, userId, planId },
  });
  return {
    subscription,
    created: true,
    reconciliationRequired: false,
    settlementDeferred: false,
  } as const;
}

async function resolveActivePurchaseOrderAuthority(
  tx: Prisma.TransactionClient,
  activeSubscriptions: readonly {
    id: string;
    userId: string;
    planId: string;
    provider: string;
    providerSubscriptionId: string | null;
    currentPeriodEnd: Date | null;
  }[],
  currentPurchase: {
    checkoutId: string;
    createdAt: Date;
  },
) {
  // Provider delivery order is nondeterministic. The durable checkout intent is
  // the purchase-order authority: createdAt orders intents, with id as the
  // stable tie-breaker for the rare equal-timestamp case.
  if (activeSubscriptions.length === 0) return { kind: "none" } as const;
  const providerPurchases = activeSubscriptions.filter(
    (
      subscription,
    ): subscription is typeof subscription & {
      providerSubscriptionId: string;
    } => subscription.providerSubscriptionId !== null,
  );
  if (providerPurchases.length !== activeSubscriptions.length) {
    return { kind: "unavailable" } as const;
  }

  const checkoutAuthorities = await tx.checkoutSession.findMany({
    where: {
      OR: providerPurchases.map((subscription) => ({
        provider: subscription.provider,
        providerSessionId: subscription.providerSubscriptionId,
      })),
    },
    select: {
      id: true,
      provider: true,
      providerSessionId: true,
      createdAt: true,
      userId: true,
      planId: true,
      amountCents: true,
      currency: true,
      offerSnapshot: true,
      status: true,
    },
  });
  const checkoutByProviderInvoice = new Map(
    checkoutAuthorities.map((checkout) => [
      `${checkout.provider}:${checkout.providerSessionId ?? ""}`,
      checkout,
    ]),
  );
  const authorities = [];
  for (const subscription of providerPurchases) {
    const checkout = checkoutByProviderInvoice.get(
      `${subscription.provider}:${subscription.providerSubscriptionId}`,
    );
    const offerSnapshot = checkoutOfferSnapshotSchema.safeParse(
      checkout?.offerSnapshot,
    );
    if (
      !checkout ||
      checkout.userId !== subscription.userId ||
      checkout.planId !== subscription.planId ||
      checkout.status !== "completed" ||
      !offerSnapshot.success ||
      offerSnapshot.data.planId !== subscription.planId ||
      checkout.amountCents !== offerSnapshot.data.priceCents ||
      checkout.currency?.toLowerCase() !==
        offerSnapshot.data.currency.toLowerCase()
    ) {
      return { kind: "unavailable" } as const;
    }
    authorities.push({
      subscription,
      checkout,
      offerSnapshot: offerSnapshot.data,
    });
  }

  const newer = authorities
    .filter(
      (candidate) =>
        compareCheckoutPurchaseOrder(candidate.checkout, currentPurchase) > 0,
    )
    .sort((left, right) =>
      compareCheckoutPurchaseOrder(right.checkout, left.checkout),
    )[0];
  return newer
    ? {
        kind: "newer",
        subscription: newer.subscription,
        offerSnapshot: newer.offerSnapshot,
      } as const
    : { kind: "none" } as const;
}

function convertedPrepaidAccessEnd(input: {
  currentOffer: z.infer<typeof checkoutOfferSnapshotSchema>;
  newerOffer: z.infer<typeof checkoutOfferSnapshotSchema>;
  newerAccessEnd: Date | null;
  now: Date;
}) {
  if (
    input.currentOffer.priceCents <= 0 ||
    input.newerOffer.priceCents <= 0 ||
    input.currentOffer.currency.toLowerCase() !==
      input.newerOffer.currency.toLowerCase()
  ) {
    return { ok: false } as const;
  }
  if (input.newerAccessEnd === null) {
    return { ok: true, currentPeriodEnd: null } as const;
  }

  const startsAt =
    input.newerAccessEnd > input.now ? input.newerAccessEnd : input.now;
  const newerUnitEnd = billingPeriodEnd(
    startsAt,
    input.newerOffer.billingPeriod,
  );
  const newerUnitDurationMs =
    newerUnitEnd.getTime() - startsAt.getTime();
  const convertedDurationMs = Math.max(
    1,
    Math.floor(
      newerUnitDurationMs *
        (input.currentOffer.priceCents / input.newerOffer.priceCents),
    ),
  );
  const convertedEndMs = startsAt.getTime() + convertedDurationMs;
  if (
    !Number.isSafeInteger(convertedDurationMs) ||
    !Number.isFinite(convertedEndMs)
  ) {
    return { ok: false } as const;
  }
  return {
    ok: true,
    currentPeriodEnd: new Date(convertedEndMs),
  } as const;
}

function compareCheckoutPurchaseOrder(
  left: { id: string; createdAt: Date },
  right: { checkoutId?: string; id?: string; createdAt: Date },
) {
  const createdAtDelta = left.createdAt.getTime() - right.createdAt.getTime();
  if (createdAtDelta !== 0) return createdAtDelta;
  return left.id.localeCompare(right.checkoutId ?? right.id ?? "");
}

async function syncSubscriptionEntitlements(
  tx: Prisma.TransactionClient,
  userId: string,
  plan: {
    slug: string;
    billingPeriod: string;
    features: Prisma.JsonValue;
  },
  expiresAt: Date | null,
) {
  await tx.entitlement.upsert({
    where: { userId_key: { userId, key: "plan" } },
    update: { value: { slug: plan.slug, billingPeriod: plan.billingPeriod }, source: "subscription", expiresAt },
    create: { userId, key: "plan", value: { slug: plan.slug, billingPeriod: plan.billingPeriod }, source: "subscription", expiresAt },
  });
  const featureEntries = Object.entries(plan.features as JsonRecord);
  for (const [key, value] of featureEntries) {
    const entitlementValue = toInputJson(value ?? false);
    await tx.entitlement.upsert({
      where: { userId_key: { userId, key: featureKey(key) } },
      update: { value: entitlementValue, source: "subscription", expiresAt },
      create: { userId, key: featureKey(key), value: entitlementValue, source: "subscription", expiresAt },
    });
  }
  await tx.entitlement.upsert({
    where: { userId_key: { userId, key: "premium_controls" } },
    update: { value: true, source: "subscription", expiresAt },
    create: { userId, key: "premium_controls", value: true, source: "subscription", expiresAt },
  });
}

function featureKey(key: string) {
  return key.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
}

async function readPreferences(userId: string) {
  const preferences = await prisma.userPreferences.findUnique({
    where: { userId },
  });
  return preferences ?? {
    userId,
    locale: "en",
    mutedTags: [],
    safeModeFlags: {},
    notificationSettings: {},
    updatedAt: null,
  };
}

async function applyModerationAction(
  targetType: string,
  targetId: string,
  policyCode?: string,
) {
  // INVARIANT: a takedown must actually remove something. Feed items wrap a
  // character, so resolve and take that down; unknown target types throw so the
  // caller can escalate instead of recording a false "blocked" event.
  const removedCharacterId = await prisma.$transaction(async (tx) => {
    let characterId: string | null = null;
    if (targetType === "character") {
      const removed = await tx.character.updateMany({
        where: { id: targetId },
        data: { status: "removed" },
      });
      if (removed.count > 0) characterId = targetId;
    } else if (targetType === "media") {
      await lockMediaAssetAuthority(tx, targetId);
      await tx.mediaAsset.updateMany({
        where: { id: targetId },
        data: { safetyStatus: "blocked" },
      });
    } else if (targetType === "feed_item") {
      const feedTargetCharacterId = feedCharacterId(targetId);
      const collectionId = feedCollectionId(targetId);
      if (feedTargetCharacterId) {
        const removed = await tx.character.updateMany({
          where: { id: feedTargetCharacterId },
          data: { status: "removed" },
        });
        if (removed.count > 0) {
          characterId = feedTargetCharacterId;
          await recordMainToChatEvent({
            eventId: `character_removed_${feedTargetCharacterId}_${randomUUID()}`,
            eventType: MAIN_TO_CHAT_EVENTS.characterRemoved,
            aggregateType: "character",
            aggregateId: feedTargetCharacterId,
            payload: { characterId: feedTargetCharacterId },
          }, tx);
        }
      } else if (collectionId) {
        await tx.mediaCollection.updateMany({
          where: { id: collectionId },
          data: { visibility: "private" },
        });
      } else {
        throw Errors.badRequest(`Cannot resolve feed_item moderation target: ${targetId}`);
      }
    } else {
      throw Errors.badRequest(`Unsupported moderation target type: ${targetType}`);
    }
    await tx.moderationEvent.create({
      data: {
        targetType,
        targetId,
        layer: "human_review",
        status: "blocked",
        policyCode,
        details: {},
      },
    });
    if (characterId && targetType === "character") {
      await recordMainToChatEvent({
        eventId: `character_removed_${characterId}_${randomUUID()}`,
        eventType: MAIN_TO_CHAT_EVENTS.characterRemoved,
        aggregateType: "character",
        aggregateId: characterId,
        payload: { characterId },
      }, tx);
    }
    return characterId;
  });
  if (removedCharacterId) {
    try {
      await dispatchPendingChatEvents();
    } catch (error) {
      logger.error(
        { error, characterId: removedCharacterId },
        "failed to dispatch durable Chat character removal",
      );
    }
  }
}

async function trackEvent(
  name: string,
  props: unknown,
  ctx: { userId?: string; anonymousId?: string },
) {
  return createClassifiedAnalyticsEvent(prisma, {
    userId: ctx.userId,
    anonymousId: ctx.anonymousId,
    name,
    props,
  });
}

async function trackEventOnce(
  name: string,
  props: unknown,
  ctx: { userId?: string; anonymousId?: string },
  sourceEventId: string,
) {
  return createClassifiedAnalyticsEvent(prisma, {
    userId: ctx.userId,
    anonymousId: ctx.anonymousId,
    name,
    props,
    sourceEventId,
  });
}

function referralCode(userId: string) {
  return `DREAM-${userId.slice(-8).toUpperCase()}`;
}

function cryptoRandomId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function supportTicketId() {
  // 10 random base36 chars from two independent draws — collision-resistant and NOT
  // time-derived. The previous slice(-10) kept the trailing Date.now() tail (~8 chars) plus
  // only ~2 random chars, so same-millisecond submissions collided on the @unique ticketId
  // (→ P2002 → 500) and the IDs were time-ordered / trivially enumerable.
  const random = `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 10)
    .toUpperCase();
  return `SUP-${random}`;
}
