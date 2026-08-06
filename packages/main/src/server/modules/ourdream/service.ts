import {
  Prisma,
  type GenerationJob as GenerationJobRow,
} from "@prisma/client";
import {
  APPEAL_TARGET_TYPES,
  CHARACTER_STYLES,
  CHARACTER_VISIBILITY,
  GENDERS,
  GENERATION_JOB_STATUSES,
  MEDIA_ASSET_VISIBILITY,
  PRODUCT_FEEDBACK_CATEGORIES,
  SUPPORT_REQUEST_CATEGORIES,
  TERMINAL_GENERATION_JOB_STATUSES,
} from "@idream/shared/catalog";
import { parseCharacterReleaseAssetManifest } from "@idream/shared/admin";
import { resolveLocalBlobPath, resolveLocalBlobRoot } from "@idream/shared/storage/local-blob";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ChatImageRequestedPayload } from "@/server/ai/schemas";
import {
  assertPinnedLegacyCharacterGenerationAuthority,
  legacyCharacterGenerationAuthorityFromControls,
  loadLockedLiveEditorialLegacyGenerationAuthority,
  type LegacyCharacterGenerationAuthority,
} from "@/server/modules/generation/attempt-dispatch";
import {
  dispatchGenerationAttemptOutbox,
  reserveInitialGenerationAttempt as reserveInitialGenerationAttemptAuthority,
} from "@/server/modules/generation/generation-attempt-authority";
import {
  isProductionLtxVideoProfile,
} from "@/server/modules/generation/production-video-profile";
import { dispatchAdmin } from "@/server/modules/admin/service";
import { generationWorkflowDescriptor } from "@/server/modules/generation/generation-catalog";
import {
  assertQuoteStillValid,
  generationPlanRouteFingerprint,
  generationPricingFingerprint,
  generationQuoteAuthoritySchema,
  quoteGeneration,
  resolveGenerationPlan,
  type GenerationProfileSelectionAuthority,
} from "./generation-quote";
import {
  billingPortal,
  billingWebhook,
  cancelSubscription,
  checkout,
  listPlans,
  resumeSubscription,
} from "./billing-checkout";
import {
  activeSubscriptionWhere,
  billingAccessDTO,
  entitlementMap,
  lockUserLedger,
  publicSubscriptionDTO,
} from "./subscription-lifecycle";
import {
  community,
  communityFollowedCreatorIds,
  creatorProfile,
  feed,
  feedPublicCharacterByItemId,
  followUser,
  unfollowUser,
} from "./discovery";
import {
  ensureReviewCaseForAppeal,
  ensureSupportCaseForRequest,
} from "@/server/modules/admin-v2/cases/service";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { listActiveTemplates } from "./character-templates";
import { isReusablePlatformAssetWhere } from "@/server/modules/ourdream/chat-image-reuse";
import { referenceSetSnapshotHash } from "@/server/modules/admin-v2/characters/release-snapshot";
import {
  UserCharacterSoulCompileError,
  compileUserCharacterContent,
  materializeUserCharacterContentVersion,
  type UserCharacterSoulInput,
} from "./character-soul";
import {
  lockCharacterGenerationAuthority,
  lockCharacterMediaAssetAuthorities,
  lockMediaAssetAuthority,
} from "@/server/modules/admin-v2/characters/generation-authority-lock";
import { invalidateCharacterDraftAssetPack } from "@/server/modules/admin-v2/characters/draft-asset-authority";
import { proxyChatRequest } from "@/server/bff/chat-proxy";
import {
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
import { recordExperimentExposure } from "@/server/modules/admin-v2/experiments/runtime";
import {
  dreamcoinBalance,
  postDreamcoinEntry,
} from "@/server/modules/billing/ledger";
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
import {
  transitionCharacterProject,
  transitionCharacterServing,
} from "@/server/modules/admin-v2/characters/transition";
import {
  isReservedInternalEmail,
  registeredUserDataClass,
} from "@/server/lib/user-data-provenance";
import { empty, fail, ok } from "@/server/lib/http";
import { cryptoRandomId } from "@/server/lib/random-id";
import {
  bodyText,
  isRecord,
  jsonBody,
  parseJsonText,
  toInputJson,
} from "@/server/lib/request-json";
import { clampInt } from "@/server/lib/request-query";
import { getOurdreamRoute, ourdreamRoutePaths } from "@/lib/ourdream-data";
import { isPublicRouteDiscoverable } from "@/lib/public-route-authority";
import { activeAnnouncements, readAnnouncements } from "@/server/announcements/store";
import { logger } from "@/server/lib/logger";
import {
  redeemCodeDreamcoins,
  redeemCodeHashCandidates,
} from "@/server/lib/redeem-codes";
import { providers } from "@/server/providers";
import type { OurdreamRoute, OurdreamRouteTemplate } from "@/types/ourdream";
import {
  dimensionsForImageOrientation,
  imageOrientations,
  normalizeImageOrientation,
} from "./generation-dimensions";
import {
  metricExposureSubject,
  verifyExposureContext,
} from "./exposure-context";
import { createVoiceClip as createDurableVoiceClip } from "./voice-clip";
import { trackEvent } from "./product-events";
import { submitReport } from "./reports";
import { moderateText } from "@/server/moderation/text-authority";
import {
  generationJobSchema,
  type GenerationCreateBody,
  type GenerationSource,
} from "./generation-request-schema";
import {
  assertCharacterIdentityAuthorityMutable,
  characterVisualProfileCreateData,
  readableCharacter,
  resolveGenerationLook,
  resolveGenerationVisualProfile,
  type GenerationPromptCharacter,
  type GenerationVisualProfile,
} from "./generation-character-authority";
import {
  featureFlagEnabled,
  hasCharacterGenerationRecipe,
  hasCompleteGenerationRecipeSet,
  isExecutableGenerationProfile,
  supportedProfileOrientations,
} from "./generation-profile-catalog";
import {
  publicFeatureProjection,
  publicOfferAvailability,
} from "./offer-availability";
import {
  assertGenerationProfileCanDispatchReferences,
  filterPublicTextToImageGenerationProfiles,
  generationProfileReferenceIncompatibilities,
  generationReferenceRouteRequirements,
  generationRequirementsFromManifest,
  normalizedGenerationReferenceRole,
  projectPublicImageEditGenerationProfiles,
  selectGenerationProfile,
  selectRecipe,
} from "./generation-profile-selection";
import {
  isCustomerEngagementActor,
  publicCharacterAudienceWhere,
  publicFeedbackAudienceWhere,
  publicReadableMediaAssetWhere,
  resolvePublicCharacterReleaseAssetPack,
} from "./public-content-audience";
import {
  characterDTO,
  characterInclude,
  mediaCollectionDTO,
  mediaCollectionInclude,
  mediaFileExtension,
  mediaViewUrl,
  visualProfileDTO,
  type CharacterWithPublicRelations,
} from "./public-read-model";

type ApiMethod = "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
type SearchRouteSuggestion = {
  description: string;
  href: string;
  template: OurdreamRouteTemplate;
  title: string;
};

const credentialProvider = "credential";

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
  gender: z.enum(GENDERS).optional(),
  style: z.enum(CHARACTER_STYLES).optional(),
  name: z.string().trim().min(1).max(80).optional(),
});

const draftPatchSchema = z.object({
  step: z.number().int().min(0).max(12).optional(),
  gender: z.enum(GENDERS).nullable().optional(),
  style: z.enum(CHARACTER_STYLES).nullable().optional(),
  name: z.string().trim().min(1).max(80).nullable().optional(),
  appearance: z.record(z.string(), z.unknown()).optional(),
  hair: z.record(z.string(), z.unknown()).optional(),
  body: z.record(z.string(), z.unknown()).optional(),
  advancedDetails: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
});

const draftSubmitSchema = z.object({
  visibility: z.enum(CHARACTER_VISIBILITY).default("private"),
  description: z.string().trim().min(1).max(1_500).optional(),
  age: z.number().int().min(18).max(99).default(21),
});

const draftPreviewSelectSchema = z.object({
  previewJobId: z.string().trim().min(1),
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

const appealTargetTypeSchema = z.enum(APPEAL_TARGET_TYPES);

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
  category: z.enum(SUPPORT_REQUEST_CATEGORIES),
  subject: z.string().trim().min(3).max(120),
  description: z.string().trim().min(10).max(2_000),
  diagnosticConsent: z.boolean().default(false),
  sourcePath: z.string().trim().max(240).optional(),
});

const feedbackItemCreateSchema = z.object({
  category: z.enum(PRODUCT_FEEDBACK_CATEGORIES).default("feature"),
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
    if (id === "voice" && !action && method === "POST") {
      return createDurableVoiceClip(request, {
        entitlementMap,
        readableCharacter,
      });
    }
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
    await postDreamcoinEntry(tx, {
      kind: "signup_bonus",
      userId: created.id,
      amount: 250,
      sourceId: `signup:${created.id}`,
      idempotencyKey: `signup_bonus:${created.id}`,
    });
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
        await postDreamcoinEntry(tx, {
          kind: "referral",
          beneficiary: "invitee",
          userId: created.id,
          amount: REFERRAL_INVITEE_BONUS,
          sourceId: conversion.id,
          idempotencyKey: `referral_invitee:${created.id}`,
        });
        await postDreamcoinEntry(tx, {
          kind: "referral",
          beneficiary: "inviter",
          userId: referral.inviterId,
          amount: REFERRAL_INVITER_REWARD,
          sourceId: created.id,
          idempotencyKey: `referral_inviter:${created.id}`,
        });
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

  const profile = await selectGenerationProfile({
    mode: "image",
    referenceRequirements: {
      pinnedReferences: [],
      sourceImageAssetId: null,
      lookReferenceAssetId: null,
    },
    catalogScope: "public_text_to_image",
    accessibleEntitlements: await entitlementMap(user.id),
  });
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

  // INVARIANT: Preview business state, Generation Request, first Attempt and
  // dispatch Outbox either all exist or none do. Gen consumes the same formal
  // image envelope as every other image use case.
  const reservation = await prisma.$transaction(async (tx) => {
    const previewJob = await tx.characterPreviewJob.create({
      data: {
        draftId: id,
        status: "queued",
        provider: profile.runner,
      },
    });
    const generationJob = await tx.generationJob.create({
      data: {
        userId: user.id,
        mode: "image",
        prompt,
        negativePrompt: recipe.negativeBase,
        controls: toInputJson(pruneUndefined({
          width: dimensions.width,
          height: dimensions.height,
          orientation,
          workflowKey: profile.workflowKey ?? undefined,
        })),
        presetIds: toInputJson([]),
        model: profile.workflowKey ?? profile.pipelineModel,
        profileId: profile.profileKey,
        profileVersion: profile.version,
        recipeId: recipe.recipeKey,
        recipeVersion: recipe.version,
        orientation,
        outputCount: 1,
        costDreamcoins: 0,
        provider: profile.runner,
        sourceType: "character_preview",
        sourceId: previewJob.id,
        sourceMeta: toInputJson({
          draftId: id,
          previewJobId: previewJob.id,
        }),
      },
    });
    await appendGenerationEvent(
      tx,
      generationJob.id,
      "created",
      "Character Preview Generation Request accepted",
      { previewJobId: previewJob.id, draftId: id },
    );
    await appendGenerationEvent(
      tx,
      generationJob.id,
      "queued",
      "Character Preview Generation Request queued",
      {},
    );
    const attempt = await reserveInitialGenerationAttempt(tx, generationJob);
    return {
      previewJob,
      outboxId: attempt.outbox.id,
    };
  });
  await dispatchGenerationAttemptOutbox(prisma, {
    outboxIds: [reservation.outboxId],
  });
  return ok({ previewJob: reservation.previewJob });
}

// GET character-drafts/:id/preview — poll one async preview by durable identity.
// Omitting previewJobId preserves the operator-facing "latest preview" read.
async function previewStatus(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  const draft = await assertDraftOwner(id, user.id);
  const requestedPreviewJobId = new URL(request.url).searchParams
    .get("previewJobId")
    ?.trim();
  const job = await prisma.characterPreviewJob.findFirst({
    where: {
      draftId: draft.id,
      ...(requestedPreviewJobId ? { id: requestedPreviewJobId } : {}),
    },
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
  const userContent = compileUserSoulOrBadRequest({
    name: draftName,
    age: body.age,
    description,
    relationship,
    style,
    gender,
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
        systemPrompt: userContent.personaSnapshot.compiled.systemPrompt,
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

    const contentVersion = await materializeUserCharacterContentVersion({
      tx,
      characterId: created.id,
      sourceId: draft.id,
      createdById: user.id,
      content: userContent,
    });
    await tx.character.update({
      where: { id: created.id },
      data: { currentContentVersionId: contentVersion.id },
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

    return tx.character.findUniqueOrThrow({ where: { id: created.id } });
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
      isProductionLtxVideoProfile(profile) &&
      isExecutableGenerationProfile(profile),
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
  const quoted = await quoteGeneration({
    userId,
    body,
    profileSelectionAuthority,
    source: options.source,
  });
  return ok({ quote: quoted.quote });
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
  if (existing) await wakeQueuedGenerationDispatch(existing);
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

async function reserveInitialGenerationAttempt(
  tx: Prisma.TransactionClient,
  job: {
    readonly id: string;
    readonly provider: string | null;
    readonly profileId: string | null;
    readonly profileVersion: number | null;
    readonly model: string | null;
    readonly controls: Prisma.JsonValue;
  },
) {
  return reserveInitialGenerationAttemptAuthority(tx, {
    requestId: job.id,
    dispatch: {
      outboxId: `generation_initial_${job.id}`,
      eventType: "generation.retry.dispatch.v2",
    },
  });
}

async function wakeQueuedGenerationDispatch(job: {
  readonly id: string;
  readonly status: string;
  readonly provider: string | null;
  readonly profileId: string | null;
  readonly profileVersion: number | null;
  readonly model: string | null;
  readonly controls: Prisma.JsonValue;
}) {
  if (job.status !== "queued") return;
  const reservation = await prisma.$transaction((tx) =>
    reserveInitialGenerationAttempt(tx, job),
  );
  await dispatchGenerationAttemptOutbox(prisma, {
    outboxIds: [reservation.outbox.id],
  });
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
  if (preexisting) {
    await wakeQueuedGenerationDispatch(preexisting);
    return preexisting;
  }
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

  const plan = await resolveGenerationPlan(userId, body, {
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
  if (body.quoteAuthority) {
    assertQuoteStillValid(body.quoteAuthority, {
      profileId: profile.profileKey,
      profileVersion: profile.version,
      routeFingerprint,
      pricingFingerprint,
      outputCount: body.outputCount,
      costDreamcoins: cost,
    });
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
        const reservation = existing.status === "queued"
          ? await reserveInitialGenerationAttempt(tx, existing)
          : null;
        return {
          job: existing,
          outboxId: reservation?.outbox.id ?? null,
        };
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
        select: { id: true, imageAssetId: true },
      });
      if (!lockedCharacter) {
        throw Errors.conflict(
          "Character changed before generation authority could be reserved",
          { characterId: character.id },
        );
      }
      if (
        body.mode === "video" &&
        lockedCharacter.imageAssetId !== requestedSourceImageAssetId
      ) {
        throw Errors.conflict(
          "Character primary image changed before video authority could be reserved",
          {
            characterId: character.id,
            pinnedSourceImageAssetId: requestedSourceImageAssetId,
            currentSourceImageAssetId: lockedCharacter.imageAssetId,
          },
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
    await postDreamcoinEntry(tx, {
      kind: "generation_spend",
      userId,
      amount: cost,
      sourceId: created.id,
      idempotencyKey: `generation:${created.id}:reserve`,
    });
    await appendGenerationEvent(tx, created.id, "reserved", "Dreamcoins reserved", {
      amount: cost,
    });
    await appendGenerationEvent(tx, created.id, "queued", "Generation job queued", {});
    const reservation = await reserveInitialGenerationAttempt(tx, created);
    return { job: created, outboxId: reservation.outbox.id };
  });

  let reservation: Awaited<ReturnType<typeof runCreateTx>>;
  try {
    reservation = await runCreateTx();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const existing = await findExistingGenerationJob(userId, options);
      if (existing) {
        await wakeQueuedGenerationDispatch(existing);
        return existing;
      }
    }
    throw error;
  }
  const job = reservation.job;

  if (job.status !== "queued") return job;
  if (reservation.outboxId) {
    await dispatchGenerationAttemptOutbox(prisma, {
      outboxIds: [reservation.outboxId],
    });
  }
  return job;
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

// SPEC: 为还没有 active Reference Set 的身份建出首个参考集。
// INTENT: 只用 anchorAssetIds（候选图池）——参考集本身的权威是 ReferenceSetRevision，
// 「没有 revision」就等于「还没有参考集」，此时唯一可信的线索就是图池里的锚点。
function referenceSnapshotInputs(profile: GenerationVisualProfile) {
  return jsonStringArray(profile.anchorAssetIds).map((mediaAssetId, index) => ({
    mediaAssetId,
    position: index,
    role: index === 0 ? "primary_face" : "identity_anchor",
    weight: index === 0 ? 1 : 0.9,
    selectionReason: index === 0 ? "primary_identity_anchor" : "supporting_identity_angle",
  }));
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

  // 「没有任何参考图」以 active Reference Set 为准（anchorAssetIds 是候选图池，非空只说明
  // 有候选、不代表已发布参考集）。归一后无 active revision ⟺ 无参考图。
  const bootstrapWithoutReferences =
    activeProfile.createdFrom.startsWith("generation_bootstrap") &&
    jsonStringArray(activeProfile.anchorAssetIds).length === 0 &&
    (await tx.referenceSetRevision.count({
      where: { visualProfileId: activeProfile.id, status: "active" },
    })) === 0;
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
  const profile =
    exactProfile &&
    isExecutableGenerationProfile(exactProfile) &&
    (job.mode !== "video" || isProductionLtxVideoProfile(exactProfile))
    ? exactProfile
    : generationJobRequiresPinnedLegacyAuthority(job) &&
        !job.profileId &&
        job.profileVersion === null
      ? await selectGenerationProfile({
          mode: job.mode,
          requested: job.model ?? undefined,
          referenceRequirements: retryReferenceRequirements,
          accessibleEntitlements: entitlements,
        })
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
    await wakeQueuedGenerationDispatch(existing);
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
  // 重试走同一条 fail-closed 协议，只是路线指纹来自被重试的 job 而不是新计划。
  assertQuoteStillValid(
    body.quoteAuthority,
    {
      profileId: profile.profileKey,
      profileVersion: profile.version,
      routeFingerprint,
      pricingFingerprint,
      outputCount: job.outputCount,
      costDreamcoins: cost,
    },
    "retry",
  );
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
      const dispatch = existingRetry.status === "queued"
        ? await reserveInitialGenerationAttempt(tx, existingRetry)
        : null;
      return {
        job: existingRetry,
        created: false,
        outboxId: dispatch?.outbox.id ?? null,
      } as const;
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
        select: { id: true, imageAssetId: true },
      });
      if (!character) {
        throw Errors.conflict(
          "Character changed before retry authority could be reserved",
          { characterId: job.characterId },
        );
      }
      if (
        job.mode === "video" &&
        character.imageAssetId !== retrySourceImageAssetId
      ) {
        throw Errors.conflict(
          "Character primary image changed before video retry authority could be reserved",
          {
            characterId: job.characterId,
            pinnedSourceImageAssetId: retrySourceImageAssetId ?? null,
            currentSourceImageAssetId: character.imageAssetId,
          },
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
    await postDreamcoinEntry(tx, {
      kind: "generation_spend",
      userId: user.id,
      amount: cost,
      sourceId: created.id,
      idempotencyKey: `generation:${created.id}:reserve`,
    });
    await appendGenerationEvent(tx, created.id, "reserved", "Dreamcoins reserved", {
      amount: cost,
    });
    await appendGenerationEvent(tx, created.id, "queued", "Retry generation job queued", {});
    const dispatch = await reserveInitialGenerationAttempt(tx, created);
    return {
      job: created,
      created: true,
      outboxId: dispatch.outbox.id,
    } as const;
  });
  const retry = reservation.job;
  if (reservation.outboxId) {
    await dispatchGenerationAttemptOutbox(prisma, {
      outboxIds: [reservation.outboxId],
    });
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
      // anchorAssetIds 是候选图池，可含参考集之外的图，仍要锁；referenceAssetIds 是参考集的
      // 影子副本，其内容已由下面的 currentReferenceSet 覆盖。
      ...jsonStringArray(activeProfile.anchorAssetIds),
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
    visualProfile: visualProfileDTO(
      result.visualProfile,
      result.referenceSetRevision?.references.map((reference) => reference.mediaAssetId) ?? [],
    ),
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
  if (existing) await wakeQueuedGenerationDispatch(existing);
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
      visibility: z.enum(MEDIA_ASSET_VISIBILITY).optional(),
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
    await postDreamcoinEntry(tx, {
      kind: "redeem",
      userId: user.id,
      amount: coins,
      sourceId: created.id,
      idempotencyKey: `redeem:${created.id}`,
    });
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
  // remains retryable when Chat HTTP ingress is unavailable.
  try {
    await dispatchPendingChatEvents();
  } catch (error) {
    logger.error({ error, userId: user.id }, "failed to dispatch durable chat account erasure");
  }

  const response = ok({ requested: true });
  response.headers.append("set-cookie", clearSessionCookie());
  return response;
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
    const immutableContentSnapshot = await loadCurrentCharacterContentSnapshot(
      tx,
      lockedSource.id,
      lockedSource.currentContentVersionId,
    );
    const userContent = compileUserSoulOrBadRequest({
      name,
      age: lockedSource.age,
      description: lockedSource.description,
      relationship: lockedSource.relationship,
      style: lockedSource.style,
      gender: lockedSource.gender,
      appearance: lockedSource.appearance,
      advancedDetails: lockedSource.advancedDetails,
      immutableContentSnapshot,
    });
    const created = await tx.character.create({
      data: {
        creatorId: user.id,
        name,
        age: lockedSource.age,
        description: lockedSource.description,
        systemPrompt: userContent.personaSnapshot.compiled.systemPrompt,
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
    const contentVersion = await materializeUserCharacterContentVersion({
      tx,
      characterId: created.id,
      sourceId: lockedSource.id,
      createdById: user.id,
      content: userContent,
    });
    await tx.character.update({
      where: { id: created.id },
      data: { currentContentVersionId: contentVersion.id },
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
      visibility: z.enum(CHARACTER_VISIBILITY).optional(),
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
    const immutableContentSnapshot = shouldRebuildPrompt
      ? await loadCurrentCharacterContentSnapshot(
          tx,
          existing.id,
          existing.currentContentVersionId,
        )
      : null;
    const userContent = shouldRebuildPrompt
      ? compileUserSoulOrBadRequest({
          name: nextName,
          age: existing.age,
          description: nextDescription,
          relationship: existing.relationship,
          style: existing.style,
          gender: existing.gender,
          appearance: existing.appearance,
          advancedDetails: existing.advancedDetails,
          immutableContentSnapshot: immutableContentSnapshot ?? undefined,
        })
      : null;
    const activeProfile = shouldRebuildPrompt
      ? await tx.characterVisualProfile.findFirst({
          where: { characterId: id, status: "active" },
          orderBy: { version: "desc" },
          include: {
            referenceSetRevisions: {
              where: { status: "active" },
              orderBy: { revision: "desc" },
              take: 1,
              select: { references: { select: { mediaAssetId: true } } },
            },
          },
        })
      : null;
    await lockCharacterMediaAssetAuthorities(tx, [
      ...(body.visibility === "public" && existing.imageAssetId
        ? [existing.imageAssetId]
        : []),
      // anchorAssetIds 是候选图池仍要锁；参考集本身取 active Reference Set，不读影子副本。
      ...jsonStringArray(activeProfile?.anchorAssetIds),
      ...(activeProfile?.referenceSetRevisions[0]?.references
        .map((reference) => reference.mediaAssetId) ?? []),
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
    const contentVersion = userContent
      ? await materializeUserCharacterContentVersion({
          tx,
          characterId: existing.id,
          sourceId: existing.id,
          createdById: user.id,
          content: userContent,
        })
      : null;
    const updated = await tx.character.update({
      where: { id: existing.id },
      data: {
        name: body.name,
        description: body.description,
        systemPrompt: userContent?.personaSnapshot.compiled.systemPrompt,
        currentContentVersionId: contentVersion?.id,
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
    const serving = await tx.characterServing.findUnique({
      where: { characterId: character.id },
    });
    if (serving) {
      await transitionCharacterServing(tx, {
        servingId: serving.id,
        to: "retired",
        expected: {
          from: serving.state as "inactive" | "live" | "paused",
          version: serving.version,
        },
        data: {
        currentReleaseId: null,
        scheduledReleaseId: null,
        scheduledAt: null,
        },
      });
    }
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
      select: { id: true, phase: true, version: true },
    });
    for (const project of activeProjects) {
      await transitionCharacterProject(tx, {
        projectId: project.id,
        to: "retired",
        expected: {
          from: project.phase as "idea" | "planned" | "producing" | "qa" | "launch_ready" | "live_management",
          version: project.version,
        },
        data: { activeKey: null },
      });
    }
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

function compileUserSoulOrBadRequest(input: UserCharacterSoulInput) {
  try {
    return compileUserCharacterContent(input);
  } catch (error) {
    if (error instanceof UserCharacterSoulCompileError) {
      throw Errors.badRequest("Complete the Character Soul before saving", {
        diagnostics: error.diagnostics,
      });
    }
    throw error;
  }
}

async function loadCurrentCharacterContentSnapshot(
  tx: Prisma.TransactionClient,
  characterId: string,
  currentContentVersionId: string | null,
): Promise<{
  personaSnapshot: unknown;
  openingSnapshot: unknown;
  appearanceSnapshot: unknown;
} | undefined> {
  let contentVersionId = currentContentVersionId;
  if (!contentVersionId) {
    const serving = await tx.characterServing.findUnique({
      where: { characterId },
      select: {
        currentRelease: {
          select: { characterContentVersionId: true },
        },
      },
    });
    contentVersionId = serving?.currentRelease?.characterContentVersionId ?? null;
  }
  if (!contentVersionId) return undefined;
  const content = await tx.characterContentVersion.findFirst({
    where: { id: contentVersionId, characterId },
    select: {
      personaSnapshot: true,
      openingSnapshot: true,
      appearanceSnapshot: true,
    },
  });
  if (!content) {
    throw Errors.conflict("The Character's immutable content version is unavailable");
  }
  return content;
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

function encodeCursor(value: number) {
  return Buffer.from(String(value), "utf8").toString("base64url");
}

function decodeCursor(value: string | null) {
  if (!value) return 0;
  const decoded = Number.parseInt(Buffer.from(value, "base64url").toString("utf8"), 10);
  return Number.isFinite(decoded) && decoded >= 0 ? decoded : 0;
}

async function assertDraftOwner(id: string, userId: string) {
  const draft = await prisma.characterDraft.findFirst({
    where: { id, ownerId: userId },
  });
  if (!draft) throw Errors.notFound("Character draft not found");
  return draft;
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

async function currentAgeVerificationStatus(userId: string) {
  const latest = await prisma.ageVerification.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  return latest?.status ?? "not_required";
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

// INTENT: 「活跃」= 非终态。以终态集合取反，新增一个状态时不会漏进这里。
function activeGenerationStatuses() {
  return GENERATION_JOB_STATUSES.filter(
    (status) => !(TERMINAL_GENERATION_JOB_STATUSES as readonly string[]).includes(status),
  );
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

function referralCode(userId: string) {
  return `DREAM-${userId.slice(-8).toUpperCase()}`;
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
