import { Prisma } from "@prisma/client";
import { buildCharacterSystemPrompt } from "@idream/shared";
import { resolveLocalBlobPath, resolveLocalBlobRoot } from "@idream/shared/storage/local-blob";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type {
  ChatImageRequestedPayload,
  ImageGeneratePayload,
  VideoGeneratePayload,
} from "@/server/ai/schemas";
import { imageReferenceInputsForGenerationJob } from "@/server/ai/reference-images";
import {
  recordGenerationAttemptEvent,
  recordGenerationAttemptQueuedEvent,
} from "@/server/ai/generation-attempt-events";
import { dispatchAdmin } from "@/server/modules/admin/service";
import {
  ensureReviewCaseForAppeal,
  ensureReviewCaseForReport,
  ensureSupportCaseForRequest,
} from "@/server/modules/admin-v2/cases/service";
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
import { proxyChatRequest } from "@/server/bff/chat-proxy";
import { jobQueue } from "@/server/jobs/queue";
import {
  MAIN_TO_CHAT_QUEUE,
  MAIN_TO_CHAT_EVENTS,
  METRIC_PRODUCT_EVENTS,
  characterExposureRecordedV2Schema,
  idempotencyKeys,
} from "@idream/shared/contracts";
import { appendCanonicalMetricEvent } from "@/server/modules/admin-v2/metrics/event-writer";
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
import { generationCostDreamcoins } from "@/server/lib/generation-pricing";
import { env } from "@/server/lib/env";
import { AppError, Errors } from "@/server/lib/errors";
import { empty, fail, ok } from "@/server/lib/http";
import { getOurdreamRoute, ourdreamRoutePaths } from "@/lib/ourdream-data";
import { activeAnnouncements, readAnnouncements } from "@/server/announcements/store";
import { logger } from "@/server/lib/logger";
import { redeemCodeHashCandidates } from "@/server/lib/redeem-codes";
import { providers } from "@/server/providers";
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

type ApiMethod = "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
type JsonRecord = Record<string, Prisma.JsonValue>;
type SearchRouteSuggestion = {
  description: string;
  href: string;
  template: OurdreamRouteTemplate;
  title: string;
};

const credentialProvider = "credential";
const fallbackCharacterImages = [
  "/images/ourdream/card-melissa-burke.webp",
  "/images/ourdream/card-summoned-world.webp",
  "/images/ourdream/card-sarah-mercer.webp",
  "/images/ourdream/card-alexa-reeves.webp",
  "/images/ourdream/card-tamsin-jacobs.webp",
  "/images/ourdream/card-truth-confessional.webp",
  "/images/ourdream/card-truth-stepmother.webp",
  "/images/ourdream/card-stephanie.webp",
  "/images/ourdream/card-kennedy-graham.webp",
  "/images/ourdream/card-eleanor-dawn.webp",
  "/images/ourdream/card-bailey-price.webp",
  "/images/ourdream/card-sophie.webp",
  "/images/ourdream/card-raya-reyes.webp",
  "/images/ourdream/card-emily-coming-home.webp",
  "/images/ourdream/card-diana-weird-girl.webp",
  "/images/ourdream/card-lola-moonstruck.webp",
] as const;

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
    orientation: z.enum(imageOrientations).optional(),
    model: z.string().trim().min(1).max(120).optional(),
    seconds: z.number().int().min(1).max(30).optional(),
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
    orientation: z.enum(imageOrientations).optional(),
    outputCount: z.number().int().min(1).max(4).default(1),
    model: z.string().max(80).optional(),
    remixFeedItemId: z.string().max(180).optional(),
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
  returnPath: z.string().max(240).default("/profile"),
  autoConfirm: z.boolean().default(true),
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

const defaultFeedbackItems = [
  {
    sourceKey: "generator-recipes",
    title: "Saved generator recipes",
    description: "Save a prompt, character, style, orientation, and preset stack so it can be reused later.",
    category: "feature",
    status: "planned",
  },
  {
    sourceKey: "creator-collections",
    title: "Creator collection boards",
    description: "Let creators group characters and generated media into public boards followers can browse.",
    category: "feature",
    status: "under_review",
  },
  {
    sourceKey: "chat-memory-review",
    title: "Memory review before long chats",
    description: "Give users a quick way to inspect and adjust remembered facts before continuing a session.",
    category: "improvement",
    status: "under_review",
  },
] as const;

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
    return await dispatchV1Unsafe(request, segments);
  } catch (error) {
    if (error instanceof AppError) return fail(error);
    if (error instanceof z.ZodError) {
      return fail(new AppError("bad_request", "Validation failed", error.flatten()));
    }
    logger.error(
      { error, method: request.method, path: new URL(request.url).pathname },
      "Unhandled v1 route error",
    );
    return fail(new AppError("internal", "Internal error"));
  }
}

async function dispatchV1Unsafe(request: Request, segments: string[]) {
  const method = request.method as ApiMethod;
  const [resource, id, action, child] = segments;

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
    if (id === "jobs" && !action && method === "POST") return createGenerationJob(request);
    if (id === "voice" && !action && method === "POST") return createVoiceClip(request);
    if (id === "jobs" && !action && method === "GET") return listGenerationJobs(request);
    if (id === "jobs" && action && !child && method === "GET") return getGenerationJob(request, action);
    if (id === "jobs" && action && child === "retry" && method === "POST") {
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
    if (id && action === "variation" && method === "POST") return createMediaVariation(request, id);
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
  const existing = await prisma.user.findUnique({ where: { email: body.email } });
  if (existing) throw Errors.conflict("Email already registered");

  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
  const token = createSessionToken();
  const user = await prisma.$transaction(async (tx) => {
    const anonymousId = await claimableAnonymousId(tx, ctx.anonymousId);
    const created = await tx.user.create({
      data: {
        email: body.email,
        emailVerified: true,
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
  const entitlements = ctx.userId ? await entitlementMap(ctx.userId) : {};
  const balance = ctx.userId ? await dreamcoinBalance(ctx.userId) : 0;

  return ok({
    user: user ? userDTO(user) : null,
    anonymousId: ctx.anonymousId,
    ageGate: { accepted: ctx.ageGateAccepted },
    ageVerification: { status: ctx.ageVerificationStatus },
    entitlements,
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
    visibility: "public",
    status: "approved",
    deletedAt: null,
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

  const page = characters.slice(0, limit);
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
        { visibility: "public", status: "approved" },
        ctx.userId ? { creatorId: ctx.userId } : {},
      ].filter((item) => Object.keys(item).length > 0),
    },
    include: characterInclude(ctx.userId),
  });
  if (!character) throw Errors.notFound("Character not found");

  await prisma.characterStats.upsert({
    where: { characterId: character.id },
    update: {
      viewsCount: { increment: 1 },
      lastActivityAt: new Date(),
    },
    create: {
      characterId: character.id,
      viewsCount: 1,
      lastActivityAt: new Date(),
    },
  });

  await trackEvent("character_viewed", { characterId: character.id }, ctx);
  return ok({ character: characterDTO(character, ctx.userId) });
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
  const character = await assertIdentityTargetCharacter(characterId, user.id);
  const visualProfile = await ensureActiveVisualProfile(character, {
    anchorAssetId: null,
    createdFrom: "look_bootstrap",
  });
  if (body.referenceAssetId) await assertIdentityImageMedia(body.referenceAssetId, user.id);

  const look = await prisma.$transaction((tx) =>
    persistCharacterLook(tx, {
      characterId,
      visualProfileId: visualProfile.id,
      ownerId: user.id,
      label: body.label,
      appearanceDelta: toInputJson(body.appearanceDelta),
      referenceAssetId: body.referenceAssetId ?? null,
    }),
  );
  return ok({ look: characterLookDTO(look) }, { status: 201 });
}

async function updateCharacterLook(request: Request, characterId: string, lookId: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const body = characterLookPatchSchema.parse(await jsonBody(request));
  await assertIdentityTargetCharacter(characterId, user.id);
  const current = await prisma.characterLook.findFirst({
    where: { id: lookId, characterId, ownerId: user.id, status: { not: "archived" } },
  });
  if (!current) throw Errors.notFound("Character Look not found");
  if (body.referenceAssetId) await assertIdentityImageMedia(body.referenceAssetId, user.id);
  const look = await prisma.characterLook.update({
    where: { id: current.id },
    data: {
      label: body.label,
      appearanceDelta: body.appearanceDelta ? toInputJson(body.appearanceDelta) : undefined,
      referenceAssetId: body.referenceAssetId,
      status: body.status,
      activeKey:
        (body.status ?? current.status) === "active"
          ? characterLookActiveKey(user.id, characterId, body.label ?? current.label)
          : null,
    },
  });
  return ok({ look: characterLookDTO(look) });
}

async function archiveCharacterLook(request: Request, characterId: string, lookId: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  await assertIdentityTargetCharacter(characterId, user.id);
  const updated = await prisma.characterLook.updateMany({
    where: { id: lookId, characterId, ownerId: user.id, status: { not: "archived" } },
    data: { status: "archived", activeKey: null },
  });
  if (updated.count === 0) throw Errors.notFound("Character Look not found");
  return empty();
}

async function likeCharacter(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  await prisma.$transaction([
    prisma.characterLike.upsert({
      where: { userId_characterId: { userId: user.id, characterId: id } },
      update: {},
      create: { userId: user.id, characterId: id },
    }),
    prisma.characterStats.upsert({
      where: { characterId: id },
      update: { likesCount: { increment: 1 } },
      create: { characterId: id, likesCount: 1 },
    }),
  ]);
  return ok({ liked: true });
}

async function unlikeCharacter(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const deleted = await prisma.characterLike.deleteMany({
    where: { userId: user.id, characterId: id },
  });
  if (deleted.count > 0) {
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
              character: {
                deletedAt: null,
                status: "approved",
                visibility: "public",
              },
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
        deletedAt: null,
        visibility: "public",
        status: "approved",
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
  await assertDraftOwner(id, user.id);

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
    },
  });

  return ok({ draft });
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

  // Async: enqueue and return the queued job immediately so a slow image provider
  // never blocks this request. The worker (drainLocalAiPipeline → character.preview)
  // generates the image and settles the job; the client polls GET .../preview.
  const job = await prisma.characterPreviewJob.create({
    data: {
      draftId: id,
      status: "queued",
      provider: "mock",
    },
  });
  await jobQueue.enqueue({
    queue: "character.preview",
    payload: { draftId: id, previewJobId: job.id },
    dedupeKey: `character.preview:${job.id}`,
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
  if (!job) return ok({ previewJob: null });
  if (job.status === "completed" && job.resultAssetId) {
    const asset = await prisma.mediaAsset.findUnique({ where: { id: job.resultAssetId } });
    return ok({ previewJob: job, asset: asset ? mediaDTO(asset) : null });
  }
  return ok({ previewJob: job });
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

  const description =
    body.description ??
    `Custom ${draft.style ?? "realistic"} companion created from the Ourdream creator.`;
  const style = draft.style ?? "realistic";
  const gender = draft.gender ?? "female";
  const systemPrompt = buildCharacterSystemPrompt({
    name: draftName,
    age: body.age,
    description,
    style,
    gender,
    tags: jsonStringArray(draft.tags),
    appearance: draft.appearance,
    advancedDetails: draft.advancedDetails,
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
  const latestPreview =
    selectedPreview ??
    (await prisma.characterPreviewJob.findFirst({
      where: { draftId: draft.id, status: "completed", resultAssetId: { not: null } },
      orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }],
    }));
  const anchorAssetId = latestPreview?.resultAssetId ?? null;

  const character = await prisma.$transaction(async (tx) => {
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
        imageAssetId: anchorAssetId,
        appearance: toInputJson(draft.appearance ?? {}),
        advancedDetails: toInputJson(draft.advancedDetails ?? {}),
      },
    });

    if (anchorAssetId) {
      await tx.mediaAsset.updateMany({
        where: { id: anchorAssetId, ownerId: user.id },
        data: { characterId: created.id },
      });
    }
    await tx.characterVisualProfile.create({
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
        anchorAssetIds: anchorAssetId ? [anchorAssetId] : [],
        createdFrom: anchorAssetId ? "create_preview" : "create_submit",
      }),
    });
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
  const [profiles, recipes, presets, videoEnabled, imageBaseCost, videoBaseCost] = await Promise.all([
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
    generationCost("image", 1),
    generationCost("video", 1),
  ]);

  const visibleProfiles = profiles.filter((profile) =>
    profile.requiredEntitlement ? Boolean(entitlements[profile.requiredEntitlement]) : true,
  );
  const imageProfiles = visibleProfiles.filter((profile) => profile.mode === "image");
  const videoProfiles = visibleProfiles.filter((profile) => profile.mode === "video");
  const defaultImageProfile = imageProfiles[0] ?? profiles.find((profile) => profile.mode === "image");

  return ok({
    viewer: { authenticated: Boolean(ctx.userId) },
    entitlements,
    dreamcoins: { balance },
    pricing: {
      image: {
        baseCost: imageBaseCost,
        maxCount: defaultImageProfile?.maxCount ?? 4,
      },
      video: {
        baseCost: videoBaseCost,
      },
    },
    image: {
      orientations: jsonStringArray(defaultImageProfile?.allowedOrientations).length
        ? jsonStringArray(defaultImageProfile?.allowedOrientations)
        : ["1:1", "4:5", "3:4", "9:16", "16:9"],
      models: imageProfiles.map(profileConfigDTO),
      recipes: recipes
        .filter((recipe) => recipe.mode === "image")
        .map(recipeConfigDTO),
    },
    video: {
      enabled: videoEnabled,
      requiredEntitlement: "video_generation",
      models: videoEnabled ? videoProfiles.map(profileConfigDTO) : [],
      recipes: recipes
        .filter((recipe) => recipe.mode === "video")
        .map(recipeConfigDTO),
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
  const idempotencyKey = normalizeHeader(request.headers.get("idempotency-key"));
  const source = await resolveFeedRemixGenerationSource(user.id, body, idempotencyKey);
  const job = await createGenerationJobForUser(user.id, body, { idempotencyKey, source });
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

async function resolveFeedRemixGenerationSource(
  userId: string,
  body: GenerationCreateBody,
  idempotencyKey?: string | null,
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
    sourceId: `feed:${itemId}:user:${userId}:remix:${idempotencyKey ?? cryptoRandomId("feedremix")}`,
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
  const active = await tx.characterVisualProfile.findFirst({
    where: { characterId: character.id, status: "active" },
    orderBy: { version: "desc" },
  });
  const anchorAssetIds = active
    ? jsonStringArray(active.anchorAssetIds)
    : character.imageAssetId
      ? [character.imageAssetId]
      : [];
  const referenceAssetIds = active ? jsonStringArray(active.referenceAssetIds) : [];
  if (active) {
    await tx.characterVisualProfile.updateMany({
      where: { characterId: character.id, status: "active" },
      data: { status: "archived" },
    });
  }
  const version = (active?.version ?? 0) + 1;
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
      createdFrom: input.createdFrom,
    }),
  });
  if (active) {
    await tx.characterLook.updateMany({
      where: { visualProfileId: active.id, status: "active" },
      data: { status: "needs_rebase", activeKey: null },
    });
  }
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
  options: { idempotencyKey?: string | null; source?: GenerationSource },
) {
  if (options.idempotencyKey) {
    const existing = await prisma.generationJob.findFirst({
      where: { userId, idempotencyKey: options.idempotencyKey },
    });
    if (existing) return existing;
  }
  if (options.source) {
    const existing = await prisma.generationJob.findFirst({
      where: { sourceType: options.source.sourceType, sourceId: options.source.sourceId },
    });
    if (existing) return existing;
  }
  return null;
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

async function resolveGenerationVisualProfile(
  character: GenerationPromptCharacter,
  requestedProfileId?: string,
  opts: { fallbackToActiveOnStale?: boolean } = {},
): Promise<GenerationVisualProfile | null> {
  if (requestedProfileId) {
    const profile = await prisma.characterVisualProfile.findFirst({
      where: { id: requestedProfileId, characterId: character.id },
      orderBy: { version: "desc" },
    });
    if (!profile) {
      // Chat path (fallbackToActiveOnStale): async fire-and-forget, so a stale/unknown
      // passport id must never fail the image — fall back to whatever is active now.
      if (opts.fallbackToActiveOnStale) return resolveActiveVisualProfile(character);
      throw Errors.notFound("Character visual profile not found");
    }
    if (profile.status === "archived") {
      if (opts.fallbackToActiveOnStale) return resolveActiveVisualProfile(character);
      throw Errors.badRequest("Character visual profile is archived", { visualProfileId: requestedProfileId });
    }
    return profile;
  }

  return resolveActiveVisualProfile(character);
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
  });
  if (!look) throw Errors.notFound("Character Look not found");
  if (look.visualProfileId !== visualProfileId) {
    throw Errors.badRequest("Character Look must be rebased to the active identity", {
      lookId,
      lookVisualProfileId: look.visualProfileId,
      activeVisualProfileId: visualProfileId,
    });
  }
  return look;
}

async function resolveActiveVisualProfile(
  character: GenerationPromptCharacter,
): Promise<GenerationVisualProfile | null> {
  const active = await prisma.characterVisualProfile.findFirst({
    where: { characterId: character.id, status: "active" },
    orderBy: { version: "desc" },
  });
  if (active) return active;
  return bootstrapCharacterVisualProfile(character);
}

async function bootstrapCharacterVisualProfile(
  character: GenerationPromptCharacter,
): Promise<GenerationVisualProfile | null> {
  try {
    return await prisma.characterVisualProfile.create({
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
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    return prisma.characterVisualProfile.findFirst({
      where: { characterId: character.id, status: "active" },
      orderBy: { version: "desc" },
    });
  }
}

async function createGenerationJobForUser(
  userId: string,
  body: GenerationCreateBody,
  options: {
    idempotencyKey?: string | null;
    source?: GenerationSource;
    fallbackToActiveOnStaleVisualProfile?: boolean;
  } = {},
) {
  const preexisting = await findExistingGenerationJob(userId, options);
  if (preexisting) return preexisting;

  const entitlements = await entitlementMap(userId);
  const character = body.characterId ? await generationCharacter(body.characterId, userId) : null;
  const consistencyMode = body.consistencyMode ?? "balanced";
  const visualProfile =
    body.mode === "image" && character
      ? await resolveGenerationVisualProfile(character, body.visualProfileId, {
          fallbackToActiveOnStale: options.fallbackToActiveOnStaleVisualProfile,
        })
      : null;
  const selectedLook = await resolveGenerationLook(
    userId,
    character?.id ?? null,
    visualProfile?.id ?? null,
    body.controls.lookId,
  );
  const lookSnapshot = selectedLook ? characterLookSnapshot(selectedLook) : null;
  const selectedModel = body.model ?? body.controls.model;
  const profile = await selectGenerationProfile(body.mode, selectedModel);
  // Guard: if "chat-image-edit" was requested (edit_last_image) but selectGenerationProfile
  // fell back to a different profile — missing/disabled edit profile — the fallback's
  // capabilities are unrelated to img2img (it may even have initImage:true for an unrelated
  // reason, e.g. an sd_cpp default), so forwarding sourceImageAssetId into it risks the wrong
  // pipeline rather than a clean degrade. Drop it explicitly so degradation to plain
  // generation is deterministic and independent of whatever profile ends up resolved.
  const requestedSourceImageAssetId = (body.controls as Record<string, unknown>).sourceImageAssetId;
  const sourceImageAssetIdDroppedOnFallback =
    typeof requestedSourceImageAssetId === "string" &&
    selectedModel === "chat-image-edit" &&
    profile.profileKey !== "chat-image-edit";
  if (sourceImageAssetIdDroppedOnFallback) {
    logger.warn(
      { requestedProfile: selectedModel, resolvedProfile: profile.profileKey },
      "chat-image-edit profile unavailable; dropping sourceImageAssetId to avoid mismatched pipeline",
    );
  }

  if (body.mode === "video" && !entitlements.video_generation) {
    throw Errors.paymentRequired("Video generation requires Deluxe entitlement");
  }
  if (body.mode === "video" && !(await featureFlagEnabled("video_gen"))) {
    throw Errors.forbidden("Video generation is disabled");
  }
  const systemPromptSource = isTrustedGenerationPromptSource(options.source?.sourceType);
  const freeCharacterMoment = body.mode === "image" && Boolean(character) && Boolean(body.prompt);
  if (
    (body.negativePrompt || (body.prompt && !freeCharacterMoment)) &&
    !systemPromptSource &&
    !entitlements.premium_controls
  ) {
    throw Errors.paymentRequired("Custom prompt controls require Premium");
  }
  if (profile.requiredEntitlement && !entitlements[profile.requiredEntitlement]) {
    throw Errors.paymentRequired("Selected model requires entitlement", {
      entitlement: profile.requiredEntitlement,
    });
  }
  if (body.outputCount > profile.maxCount) {
    throw Errors.badRequest("Output count exceeds selected model limit", {
      maxCount: profile.maxCount,
    });
  }

  const recipe = await selectRecipe(body.mode, body.characterId ? "character" : "freeplay");
  const orientation =
    body.orientation ??
    body.controls.orientation ??
    jsonStringArray(profile.allowedOrientations)[0] ??
    "4:5";
  const dimensions =
    body.mode === "image"
      ? dimensionsForImageOrientation({
          orientation,
          defaultWidth: profile.defaultWidth,
          defaultHeight: profile.defaultHeight,
        })
      : { width: profile.defaultWidth, height: profile.defaultHeight };
  const referenceAssetIds = visualProfile ? visualProfileReferenceAssetIds(visualProfile) : [];
  const referenceSetRevision = visualProfile
    ? await ensureReferenceSetRevision(visualProfile, "generation_lazy_snapshot")
    : null;
  const referenceManifest = referenceSetRevision
    ? referenceManifestFromRevision(referenceSetRevision, consistencyMode)
    : [];
  const momentSpec = buildMomentSpec(body, options.source);
  const seed = body.seed ?? visualProfile?.defaultSeed ?? null;
  const controls = pruneUndefined({
    ...body.controls,
    orientation,
    model: profile.profileKey,
    profileId: profile.profileKey,
    width: dimensions.width,
    height: dimensions.height,
    sourceImageAssetId: sourceImageAssetIdDroppedOnFallback ? undefined : requestedSourceImageAssetId,
    consistencyMode: visualProfile ? consistencyMode : undefined,
    visualIdentity: visualProfile
      ? {
          visualProfileId: visualProfile.id,
          visualProfileVersion: visualProfile.version,
          consistencyMode,
          referenceAssetIds,
          referenceSetRevisionId: referenceSetRevision?.id,
          referenceManifest,
          anchorAssetIds: jsonStringArray(visualProfile.anchorAssetIds),
          seed,
        }
      : undefined,
  });
  const cost = await generationCost(body.mode, body.outputCount, profile.costMultiplier);
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
    if (options.source) {
      const existing = await tx.generationJob.findFirst({
        where: { sourceType: options.source.sourceType, sourceId: options.source.sourceId },
      });
      if (existing) return existing;
    }
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
      // edit_last_image routes to the img2img profile; selectGenerationProfile falls back to
      // the cheapest active profile if "chat-image-edit" is missing/disabled. That fallback's
      // capabilities are unrelated to img2img (it may even have initImage:true for an
      // unrelated reason), so createGenerationJobForUser explicitly drops sourceImageAssetId
      // whenever the resolved profileKey isn't "chat-image-edit" — plain generation, no
      // mismatched pipeline, no failure.
      model: sourceImageAssetId ? "chat-image-edit" : undefined,
    },
    {
      idempotencyKey: idempotencyKeys.chatImage(payload.attachmentId),
      source: {
        sourceType: "chat_image",
        sourceId: payload.attachmentId,
        sourceMeta: toInputJson({
          sessionId: payload.sessionId,
          messageId: payload.messageId,
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

function visualProfileReferenceAssetIds(profile: GenerationVisualProfile) {
  return Array.from(
    new Set([
      ...jsonStringArray(profile.anchorAssetIds),
      ...jsonStringArray(profile.referenceAssetIds),
    ]),
  );
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

async function createReferenceSetRevision(
  tx: Prisma.TransactionClient,
  profile: GenerationVisualProfile,
  createdFrom: string,
) {
  const proposedReferences = referenceSnapshotInputs(profile);
  const existingAssets = await tx.mediaAsset.findMany({
    where: { id: { in: proposedReferences.map((reference) => reference.mediaAssetId) }, deletedAt: null },
    select: { id: true },
  });
  const existingAssetIds = new Set(existingAssets.map((asset) => asset.id));
  const availableReferences = proposedReferences.filter((reference) =>
    existingAssetIds.has(reference.mediaAssetId),
  );
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

async function ensureReferenceSetRevisionInTx(
  tx: Prisma.TransactionClient,
  profile: GenerationVisualProfile,
  createdFrom: string,
) {
  const existing = await tx.referenceSetRevision.findFirst({
    where: { visualProfileId: profile.id, status: "active" },
    include: { references: { orderBy: { position: "asc" } } },
    orderBy: { revision: "desc" },
  });
  return existing ?? createReferenceSetRevision(tx, profile, createdFrom);
}

async function ensureReferenceSetRevision(
  profile: GenerationVisualProfile,
  createdFrom: string,
): Promise<ReferenceSetWithReferences> {
  const existing = await prisma.referenceSetRevision.findFirst({
    where: { visualProfileId: profile.id, status: "active" },
    include: { references: { orderBy: { position: "asc" } } },
    orderBy: { revision: "desc" },
  });
  if (existing) return existing;
  try {
    return await prisma.$transaction((tx) =>
      ensureReferenceSetRevisionInTx(tx, profile, createdFrom),
    );
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    return prisma.referenceSetRevision.findFirstOrThrow({
      where: { visualProfileId: profile.id, status: "active" },
      include: { references: { orderBy: { position: "asc" } } },
      orderBy: { revision: "desc" },
    });
  }
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

function buildMomentSpec(body: GenerationCreateBody, source?: GenerationSource) {
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

// SPEC: On-demand TTS for a single assistant chat turn ("play voice" button).
// INTENT: synchronous + cached — voice is fast, so skip the async job pipeline.
//         One MediaAsset per messageId acts as the cache; replays cost nothing.
// INVARIANTS: gated by the `voice_enabled` entitlement; charges Dreamcoins once
//         (refunded if synthesis fails); character must be age>=18.
// EXAMPLE: POST /api/v1/generation/voice {characterId, messageId, text}
//          → {assetId, contentUrl, durationMs}
const voiceClipSchema = z.object({
  characterId: z.string().min(1),
  messageId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  text: z.string().trim().min(1).max(2_000),
});

const voiceClipCacheVersion = 5;

async function createVoiceClip(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const body = voiceClipSchema.parse(await jsonBody(request));

  // Release gate: a single flag fronts all voice traffic for controlled rollout /
  // kill-switch, mirroring video_gen.
  if (!(await featureFlagEnabled("voice_gen"))) {
    throw Errors.forbidden("Voice generation is disabled");
  }

  const entitlements = await entitlementMap(user.id);
  if (entitlements.voice_enabled !== true) {
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
  // Fast-fail only when the allowance is already exhausted. The authoritative
  // metering decision happens after synthesis because duration determines coverage.
  if (
    !hasStaleCachedClip &&
    overflowCost > 0 &&
    (await voiceMinutesRemainingMs(user.id, entitlements)) <= 0 &&
    (await dreamcoinBalance(user.id)) < overflowCost
  ) {
    throw Errors.paymentRequired("Insufficient dreamcoins", {
      cost: overflowCost,
      required: overflowCost,
    });
  }

  const result = await providers.voice.synthesize({
    text: body.text,
    voiceId: character.voiceId ?? undefined,
    tone,
  });
  if (!result.ok) throw Errors.internal("Voice synthesis failed", result.error);

  const mediaId = `media_${cryptoRandomId("voice")}`;
  // Debit + persist atomically under the per-user ledger lock. The lock also makes
  // the cache re-check race-free, so a concurrent double-click can neither create a
  // duplicate clip nor double-charge; a create failure rolls the charge back.
  const asset = await prisma.$transaction(async (tx) => {
    await lockUserLedger(tx, user.id);
    const racedAssets = await tx.mediaAsset.findMany({
      where: cacheWhere,
      orderBy: { createdAt: "desc" },
    });
    const raced = racedAssets.find(isCurrentVoiceClip);
    if (raced) return raced;
    const staleAssetIds = racedAssets.map((asset) => asset.id);
    if (staleAssetIds.length > 0) {
      await tx.mediaAsset.updateMany({
        where: { id: { in: staleAssetIds } },
        data: { deletedAt: new Date() },
      });
    }
    const durationMs = Math.max(0, result.data.durationMs);
    const remainingMs = await voiceMinutesRemainingMs(user.id, entitlements, tx);
    const cost = staleAssetIds.length > 0 || remainingMs >= durationMs ? 0 : overflowCost;
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
          voiceId: character.voiceId ?? null,
          tone,
          durationMs,
          providerKey: result.data.key,
          costDreamcoins: cost,
          replacedAssetIds: staleAssetIds,
        }),
      },
    });
  });

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
  const pricing = await prisma.pricingRule.findFirst({
    where: { mode: "voice", status: "active" },
    orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
  });
  return Math.max(0, pricing?.baseCost ?? 2);
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

async function retryGenerationJob(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const job = await prisma.generationJob.findFirst({ where: { id, userId: user.id } });
  if (!job) throw Errors.notFound("Generation job not found");
  if (job.status === "blocked") {
    throw Errors.forbidden("Blocked generation jobs cannot be retried");
  }
  if (job.status !== "failed") {
    throw Errors.badRequest("Only failed generation jobs can be retried");
  }
  if (job.mode !== "image" && job.mode !== "video") {
    throw Errors.badRequest("Unsupported generation mode");
  }
  const retryCount = await prisma.generationJob.count({ where: { derivedFromJobId: job.id } });
  if (retryCount >= 3) {
    throw Errors.rateLimited("Retry limit reached for this generation job", {
      retries: retryCount,
      max: 3,
    });
  }
  const entitlements = await entitlementMap(user.id);
  const controls = jsonRecord(job.controls);
  const profile = await selectGenerationProfile(job.mode, job.profileId ?? job.model ?? undefined);
  if (profile.requiredEntitlement && !entitlements[profile.requiredEntitlement]) {
    throw Errors.paymentRequired("Selected model requires entitlement", {
      entitlement: profile.requiredEntitlement,
    });
  }
  const cost = await generationCost(job.mode, job.outputCount, profile.costMultiplier);
  const retry = await prisma.$transaction(async (tx) => {
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
        mode: job.mode,
        prompt: job.prompt,
        negativePrompt: job.negativePrompt,
        controls: toInputJson(controls),
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
    return created;
  });
  try {
    await enqueueGenerationJob(retry);
  } catch (error) {
    await failQueuedGeneration(retry, "queue_enqueue_failed", error);
    throw Errors.internal("Generation queue unavailable", { jobId: retry.id });
  }
  const queued = await prisma.generationJob.findUniqueOrThrow({
    where: { id: retry.id },
    include: generationJobInclude(),
  });
  return ok(generationJobResponse(queued), { status: 202 });
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
  const mediaCharacterIds = [
    ...new Set(page.map((asset) => asset.characterId).filter((id): id is string => Boolean(id))),
  ];
  const editableCharacters =
    mediaCharacterIds.length > 0
      ? await prisma.character.findMany({
          where: { id: { in: mediaCharacterIds }, creatorId: user.id, deletedAt: null },
          select: { id: true },
        })
      : [];
  const editableCharacterIds = new Set(editableCharacters.map((character) => character.id));
  return ok({
    items: page.map((asset) => mediaDTO(asset, { editableCharacterIds })),
    nextCursor: assets.length > limit ? encodeCursor(offset + limit) : null,
  });
}

function mediaCollectionInclude() {
  return {
    items: {
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
    _count: { select: { items: true } },
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
    select: { id: true, characterId: true },
  });
  if (!job) throw Errors.notFound("Generation job not found for media feedback");
  const character = job.characterId ? await generationCharacter(job.characterId, user.id) : null;
  const visualProfile = character ? await resolveActiveVisualProfile(character) : null;

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

  const revision = (current?.revision ?? 0) + 1;
  const feedback = {
    id: `feedback:${user.id}:${asset.id}:identity`,
    dimension: "identity",
    value,
    revision,
    sourceSurface: body.sourceSurface,
  } as const;
  const result = await prisma.$transaction(async (tx) => {
    const currentFeedbackRow = await tx.generationFeedback.findFirst({
      where: {
        actorId: user.id,
        mediaAssetId: asset.id,
        dimension: feedback.dimension,
        active: true,
      },
      orderBy: { revision: "desc" },
    });
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
      supersedesEventId: current?.eventId ?? null,
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
        metadata: mediaMetadataWithQuality(asset.metadata, {
          identityFeedback: storedFeedback,
        }),
      },
    });
    const referenceCandidate = visualProfile
      ? await tx.referenceCandidate.upsert({
          where: {
            visualProfileId_mediaAssetId: {
              visualProfileId: visualProfile.id,
              mediaAssetId: asset.id,
            },
          },
          update: {
            sourceJobId: job.id,
            status: value === "match" ? "candidate" : "rejected",
            rejectionReason: value === "mismatch" ? "user_identity_mismatch" : null,
          },
          create: {
            visualProfileId: visualProfile.id,
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
  const activeProfile = await ensureActiveVisualProfile(character, {
    anchorAssetId: asset.id,
    createdFrom: "gallery_character_image",
  });
  const activeAnchorIds = jsonStringArray(activeProfile.anchorAssetIds);
  const activeReferenceIds = jsonStringArray(activeProfile.referenceAssetIds);
  const nextAnchorIds = [asset.id, ...activeAnchorIds.filter((anchorId) => anchorId !== asset.id)];
  const referenceChanged =
    nextAnchorIds.length !== activeAnchorIds.length ||
    nextAnchorIds.some((anchorId, index) => anchorId !== activeAnchorIds[index]) ||
    activeReferenceIds.includes(asset.id);
  const result = await prisma.$transaction(async (tx) => {
    const updatedProfile = await tx.characterVisualProfile.update({
      where: { id: activeProfile.id },
      data: {
        anchorAssetIds: toInputJson(nextAnchorIds),
        referenceAssetIds: toInputJson(
          activeReferenceIds.filter((referenceId) => referenceId !== asset.id),
        ),
      },
    });
    await tx.character.update({
      where: { id: character.id },
      data: { imageAssetId: asset.id },
    });
    await tx.mediaAsset.update({
      where: { id: asset.id },
      data: {
        characterId: character.id,
        metadata: mediaMetadataWithQuality(asset.metadata, {
          selectedAsCharacterImage: true,
          visualProfileId: updatedProfile.id,
          visualProfileVersion: updatedProfile.version,
        }),
      },
    });
    const referenceSetRevision = referenceChanged
      ? await createReferenceSetRevision(tx, updatedProfile, "gallery_character_image")
      : await ensureReferenceSetRevisionInTx(tx, updatedProfile, "gallery_character_image_existing");
    await tx.referenceCandidate.updateMany({
      where: { mediaAssetId: asset.id, status: "candidate" },
      data: { status: "promoted", promotedRevisionId: referenceSetRevision.id },
    });
    return { visualProfile: updatedProfile, referenceSetRevision };
  });

  return ok({
    characterId: character.id,
    imageAssetId: asset.id,
    visualProfile: visualProfileDTO(result.visualProfile),
    referenceSetRevision: referenceSetRevisionDTO(result.referenceSetRevision),
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
  const activeProfile = await ensureActiveVisualProfile(character, {
    anchorAssetId: null,
    createdFrom: "gallery_reference_bootstrap",
  });
  const anchorIds = jsonStringArray(activeProfile.anchorAssetIds);
  const currentReferenceIds = jsonStringArray(activeProfile.referenceAssetIds);
  if (anchorIds.includes(asset.id) || currentReferenceIds.includes(asset.id)) {
    const referenceSetRevision = await ensureReferenceSetRevision(
      activeProfile,
      "gallery_reference_existing",
    );
    const updated = await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: {
        characterId: character.id,
        metadata: mediaMetadataWithQuality(asset.metadata, {
          addedToReferences: true,
          visualProfileId: activeProfile.id,
          visualProfileVersion: activeProfile.version,
        }),
      },
    });
    return ok({
      visualProfile: visualProfileDTO(activeProfile),
      referenceSetRevision: referenceSetRevisionDTO(referenceSetRevision),
      media: mediaDTO({ ...updated, liked: false }),
    });
  }

  const nextReferenceIds = [...currentReferenceIds, asset.id];
  const result = await prisma.$transaction(async (tx) => {
    const updatedProfile = await tx.characterVisualProfile.update({
      where: { id: activeProfile.id },
      data: { referenceAssetIds: toInputJson(nextReferenceIds) },
    });
    await tx.mediaAsset.update({
      where: { id: asset.id },
      data: {
        characterId: character.id,
        metadata: mediaMetadataWithQuality(asset.metadata, {
          addedToReferences: true,
          visualProfileId: updatedProfile.id,
          visualProfileVersion: updatedProfile.version,
        }),
      },
    });
    const referenceSetRevision = await createReferenceSetRevision(
      tx,
      updatedProfile,
      "gallery_reference",
    );
    await tx.referenceCandidate.updateMany({
      where: { mediaAssetId: asset.id, status: "candidate" },
      data: { status: "promoted", promotedRevisionId: referenceSetRevision.id },
    });
    return { visualProfile: updatedProfile, referenceSetRevision };
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
  const visualProfile = await ensureActiveVisualProfile(character, {
    anchorAssetId: null,
    createdFrom: "media_look_bootstrap",
  });
  const look = await prisma.$transaction((tx) =>
    persistCharacterLook(tx, {
      characterId: character.id,
      visualProfileId: visualProfile.id,
      ownerId: user.id,
      label: body.label,
      appearanceDelta: toInputJson(body.appearanceDelta),
      referenceAssetId: asset.id,
    }),
  );
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

async function createMediaVariation(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const body = z
    .object({
      outputCount: z.number().int().min(1).max(4).default(1),
      consistencyMode: z.enum(["balanced", "strict", "creative"]).default("balanced"),
    })
    .parse(await jsonBody(request));
  const asset = await assertIdentityImageMedia(id, user.id);
  const sourceJob = asset.sourceJobId
    ? await prisma.generationJob.findFirst({
        where: { id: asset.sourceJobId, userId: user.id },
      })
    : null;
  const characterId = asset.characterId ?? sourceJob?.characterId ?? undefined;
  const sourceControls = jsonRecord(sourceJob?.controls);
  const orientation = normalizeImageOrientation(
    sourceJob?.orientation ?? stringControl(sourceControls, "orientation", stringFromMediaDimensions(asset.width, asset.height)),
    "4:5",
  );
  const controls = pruneUndefined({
    orientation,
    model: sourceJob?.profileId ?? sourceJob?.model ?? stringFromRecord(sourceControls, "model"),
    backgroundPresetId: stringFromRecord(sourceControls, "backgroundPresetId"),
    posePresetId: stringFromRecord(sourceControls, "posePresetId"),
    outfitPresetId: stringFromRecord(sourceControls, "outfitPresetId"),
    sourceImageAssetId: asset.id,
  });
  const idempotencyKey = normalizeHeader(request.headers.get("idempotency-key"));
  const sourceId = idempotencyKey
    ? `media:${asset.id}:variation:${idempotencyKey}`
    : `media:${asset.id}:variation:${cryptoRandomId("variation")}`;
  const job = await createGenerationJobForUser(
    user.id,
    {
      mode: "image",
      characterId,
      freeplay: !characterId,
      consistencyMode: body.consistencyMode,
      // A variation is an img2img request even when the source asset has no
      // originating job/profile. Route it through the qualified edit profile;
      // the common generation path will deterministically drop the source and
      // degrade to text-to-image if that profile is unavailable.
      model: "chat-image-edit",
      prompt: variationScenePrompt(asset.prompt ?? sourceJob?.prompt),
      controls,
      presetIds: sourceJob ? jsonStringArray(sourceJob.presetIds) : [],
      orientation,
      outputCount: body.outputCount,
    },
    {
      idempotencyKey,
      source: {
        sourceType: "media_variation",
        sourceId,
        sourceMeta: toInputJson({
          sourceMediaId: asset.id,
          sourceJobId: sourceJob?.id ?? null,
        }),
      },
    },
  );
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
    await prisma.mediaAsset.updateMany({
      where: { id: { in: body.ids }, ownerId: user.id },
      data: { deletedAt: new Date() },
    });
    return ok({ deleted: body.ids.length });
  }

  await prisma.mediaAsset.updateMany({
    where: { id: { in: body.ids }, ownerId: user.id },
    data: { visibility: body.visibility ?? "private" },
  });
  return ok({ updated: body.ids.length });
}

async function downloadMedia(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const asset = await assertReadableMediaAsset(id, user.id);
  const metadata = jsonRecord(asset.metadata);
  const providerKey = typeof metadata.providerKey === "string" ? metadata.providerKey : undefined;
  const key = asset.storageKey ?? providerKey ?? asset.url;
  if ((process.env.BLOB_PROVIDER ?? "mock") === "mock" && (asset.storageKey ?? providerKey)) {
    return ok({ url: `${mediaViewUrl(asset)}?download=1` });
  }
  const signed = await providers.blob.signGetUrl({
    key,
    expiresInSeconds: signedUrlTtlSeconds(),
    downloadFilename: mediaDownloadFilename(asset),
  });
  return ok({ url: signed.ok ? signed.data.url : asset.url });
}

async function contentMedia(request: Request, id: string) {
  const ctx = await getAuthCtx(request);
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
  const metadata = jsonRecord(asset.metadata);
  const providerKey = typeof metadata.providerKey === "string" ? metadata.providerKey : undefined;
  const key = asset.storageKey ?? providerKey;

  if (key && (process.env.BLOB_PROVIDER ?? "mock") === "mock") {
    const body = await readFile(localBlobPath(key)).catch(() => null);
    if (!body) throw Errors.notFound("Media not found");
    return localMediaResponse(request, asset, body);
  }

  const signed = await providers.blob.signGetUrl({
    key: key ?? asset.url,
    expiresInSeconds: signedUrlTtlSeconds(),
    downloadFilename:
      new URL(request.url).searchParams.get("download") === "1"
        ? mediaDownloadFilename(asset)
        : undefined,
  });
  return Response.redirect(signed.ok ? signed.data.url : asset.url, 302);
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
    "cache-control": "private, max-age=60",
    "content-type": asset.contentType ?? "application/octet-stream",
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
  await prisma.mediaAsset.updateMany({
    where: { id, ownerId: user.id },
    data: { deletedAt: new Date() },
  });
  return ok({ deleted: true });
}

async function listPlans() {
  const plans = await prisma.plan.findMany({
    where: { active: true },
    orderBy: [{ slug: "asc" }, { billingPeriod: "asc" }],
  });
  return ok({ items: plans, billing: checkoutMode() });
}

function checkoutMode() {
  const provider = env.PAYMENT_PROVIDER;
  return {
    provider,
    demoMode: provider === "mock",
    autoConfirmAvailable: provider === "mock",
  };
}

async function checkout(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const body = checkoutSchema.parse(await jsonBody(request));
  const mode = checkoutMode();
  const autoConfirm = body.autoConfirm && mode.autoConfirmAvailable;
  const plan = await findPlan(body);
  const invoice = await providers.payment.createInvoice({
    userId: user.id,
    amountCents: plan.priceCents,
    currency: plan.currency,
    metadata: { planId: plan.id },
  });
  if (!invoice.ok) throw Errors.internal(invoice.error.message, invoice.error);

  const checkoutSession = await prisma.checkoutSession.create({
    data: {
      userId: user.id,
      provider: invoice.data.provider,
      providerSessionId: invoice.data.invoiceId,
      returnPath: body.returnPath,
      status: autoConfirm ? "completed" : "created",
    },
  });

  let subscription = null;
  let subscriptionStarted = false;
  if (autoConfirm) {
    const activation = await activateSubscription(user.id, plan.id, invoice.data.invoiceId);
    subscription = activation.subscription;
    subscriptionStarted = activation.created;
  }

  await trackEvent("checkout_started", { planId: plan.id, autoConfirm, provider: mode.provider }, ctx);
  if (subscriptionStarted) {
    await trackEvent(
      "subscription_started",
      { planId: plan.id, provider: invoice.data.provider, source: "checkout" },
      ctx,
    );
  }
  return ok({
    checkout: checkoutSession,
    invoice: invoice.data,
    subscription,
    billing: mode,
  });
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
      message: "No active subscription. Compare plans to upgrade.",
    });
  }

  return ok({
    mode: "manage",
    url: "/profile#billing",
    subscription,
    message: subscription.cancelAtPeriodEnd
      ? "Renewal is already canceled. Benefits stay active until the period ends."
      : "Subscription management is available for the active local plan.",
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
  if (subscription.cancelAtPeriodEnd) {
    return ok({ subscription, message: "Renewal is already canceled." });
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
    subscription: updated,
    message: "Renewal canceled. Benefits stay active until the current period ends.",
  });
}

async function resumeSubscription(request: Request) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  const subscription = await prisma.subscription.findFirst({
    where: { ...activeSubscriptionWhere(user.id), cancelAtPeriodEnd: true },
    include: { plan: true },
    orderBy: { createdAt: "desc" },
  });
  if (!subscription) throw Errors.badRequest("No canceled renewal to resume.");

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
  return ok({ subscription: updated, message: "Renewal resumed." });
}

async function billingWebhook(request: Request, provider: string) {
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

  const event = await prisma.providerEvent.upsert({
    where: { provider_providerEventId: { provider, providerEventId } },
    update: { payload: toInputJson(payload) },
    create: {
      provider,
      providerEventId,
      type: parsed.data.type,
      payload: toInputJson(payload),
    },
  });

  type BillingWebhookSettlement = {
    processed: boolean;
    idempotent?: boolean;
    subscriptionStarted?: { userId: string; planId: string; provider: string };
  };

  const result: BillingWebhookSettlement = await prisma.$transaction(async (tx) => {
    // Lock the provider event while settling. processedAt is written LAST, so a
    // failed activation/checkout update rolls back and remains retryable.
    await lockProviderEvent(tx, event.id);
    const current = await tx.providerEvent.findUniqueOrThrow({ where: { id: event.id } });
    if (current.processedAt) return { processed: false, idempotent: true };

    let subscriptionStarted: BillingWebhookSettlement["subscriptionStarted"];
    if (parsed.data.type === "invoice.confirmed" && parsed.data.invoiceId) {
      const checkoutSession = await tx.checkoutSession.findFirst({
        where: { providerSessionId: parsed.data.invoiceId },
      });
      if (checkoutSession) {
        // planId is echoed in the webhook payload from the invoice metadata set at
        // checkout (createInvoice metadata.planId). A CheckoutSession.planId column
        // fallback was intentionally dropped to avoid a user DB migration in the
        // controlled-beta scope; re-add the column + fallback when the BTCPay webhook
        // path is reactivated for providers that don't echo metadata.
        const planId =
          isRecord(payload) && typeof payload.planId === "string" ? payload.planId : undefined;
        if (planId) {
          const activation = await activateSubscriptionInTx(
            tx,
            checkoutSession.userId,
            planId,
            parsed.data.invoiceId,
          );
          if (activation.created) {
            subscriptionStarted = { userId: checkoutSession.userId, planId, provider };
          }
        }
        await tx.checkoutSession.update({
          where: { id: checkoutSession.id },
          data: { status: "completed" },
        });
      }
    }

    await tx.providerEvent.update({
      where: { id: event.id },
      data: { processedAt: new Date() },
    });
    return { processed: true, subscriptionStarted };
  });

  const { subscriptionStarted, ...response } = result;
  if (subscriptionStarted) {
    await trackEvent(
      "subscription_started",
      {
        planId: subscriptionStarted.planId,
        provider: subscriptionStarted.provider,
        source: "webhook",
      },
      { userId: subscriptionStarted.userId },
    );
  }

  return ok(response);
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
  const [fullUser, balance, subscription, entitlements] = await Promise.all([
    prisma.user.findUnique({ where: { id: user.id }, include: { preferences: true } }),
    dreamcoinBalance(user.id),
    prisma.subscription.findFirst({
      where: activeSubscriptionWhere(user.id),
      include: { plan: true },
      orderBy: { createdAt: "desc" },
    }),
    entitlementMap(user.id),
  ]);
  return ok({ user: fullUser, balance, subscription, entitlements });
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
  const preferences = await ensurePreferences(user.id);
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
  const reward = isRecord(code.reward) ? code.reward : {};
  const coins = typeof reward.dreamcoins === "number" ? reward.dreamcoins : 100;

  const redemption = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM redeem_codes WHERE id = ${code.id} FOR UPDATE`;

    // Reward exactly once per user — surface a graceful conflict on replay.
    const already = await tx.redeemCodeRedemption.findUnique({
      where: { redeemCodeId_userId: { redeemCodeId: code.id, userId: user.id } },
    });
    if (already) throw Errors.conflict("Code already redeemed");

    if (code.maxRedemptions !== null) {
      const redemptions = await tx.redeemCodeRedemption.count({
        where: { redeemCodeId: code.id },
      });
      if (redemptions >= code.maxRedemptions) {
        throw Errors.conflict("Code redemption limit reached");
      }
    }

    const created = await tx.redeemCodeRedemption.create({
      data: { redeemCodeId: code.id, userId: user.id },
    });
    await appendLedger(tx, user.id, coins, "redeem", created.id);
    return created;
  });

  return ok({ redemption, dreamcoins: coins });
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
  await prisma.user.update({
    where: { id: user.id },
    data: { status: "deleted", deletedAt: new Date() },
  });
  await prisma.session.deleteMany({ where: { userId: user.id } });

  // Propagate the deletion to the chat domain so it erases chat rows + the file
  // layer and emits chat.account_erasure.completed (design P0-F). Best-effort,
  // at-least-once: the chat consumer is idempotent on eventId; a delivery failure
  // is logged but must not block the user's deletion response.
  try {
    await jobQueue.enqueue({
      queue: MAIN_TO_CHAT_QUEUE,
      payload: {
        eventId: `user_deleted_${user.id}`,
        eventType: MAIN_TO_CHAT_EVENTS.userDeleted,
        payload: { userId: user.id },
      },
      dedupeKey: `user_deleted_${user.id}`,
    });
  } catch (error) {
    logger.error({ error, userId: user.id }, "failed to enqueue chat account erasure");
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
        id: signedContext.characterId,
        deletedAt: null,
        visibility: "public",
        status: "approved",
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
    await tx.analyticsEvent.create({
      data: {
        userId: user.id,
        anonymousId: ctx.anonymousId,
        name: "support_request_submitted",
        props: toInputJson({
          ticketId,
          supportRequestId: created.id,
          category: body.category,
          subject: body.subject,
          description: body.description,
          diagnosticConsent: body.diagnosticConsent,
          sourcePath: body.sourcePath ?? null,
        }),
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
  await ensureDefaultFeedbackItems();
  const items = await prisma.productFeedbackItem.findMany({
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
  const created = await prisma.$transaction(async (tx) => {
    const item = await tx.productFeedbackItem.create({
      data: {
        createdById: user.id,
        title: body.title,
        description: body.description,
        category: body.category,
        status: "under_review",
        voteCount: 1,
      },
    });
    await tx.productFeedbackVote.create({
      data: { userId: user.id, itemId: item.id },
    });
    await tx.analyticsEvent.create({
      data: {
        userId: user.id,
        anonymousId: ctx.anonymousId,
        name: "feedback_item_created",
        props: toInputJson({
          itemId: item.id,
          category: item.category,
          title: item.title,
        }),
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
  const item = await prisma.$transaction(async (tx) => {
    const existingItem = await tx.productFeedbackItem.findUnique({ where: { id: itemId } });
    if (!existingItem) throw Errors.notFound("Feedback item not found");
    const existingVote = await tx.productFeedbackVote.findUnique({
      where: { userId_itemId: { userId: user.id, itemId } },
    });
    if (existingVote) return existingItem;
    await tx.productFeedbackVote.create({ data: { userId: user.id, itemId } });
    const updated = await tx.productFeedbackItem.update({
      where: { id: itemId },
      data: { voteCount: { increment: 1 } },
    });
    await tx.analyticsEvent.create({
      data: {
        userId: user.id,
        anonymousId: ctx.anonymousId,
        name: "feedback_item_voted",
        props: toInputJson({ itemId }),
      },
    });
    return updated;
  });
  return ok({ item: feedbackItemDTO(item, new Set([item.id])) });
}

async function unvoteFeedbackItem(request: Request, itemId: string) {
  const ctx = await getAuthCtx(request);
  requireAgeGate(ctx);
  const user = requireUser(ctx);
  const item = await prisma.$transaction(async (tx) => {
    const existingItem = await tx.productFeedbackItem.findUnique({ where: { id: itemId } });
    if (!existingItem) throw Errors.notFound("Feedback item not found");
    const existingVote = await tx.productFeedbackVote.findUnique({
      where: { userId_itemId: { userId: user.id, itemId } },
    });
    if (!existingVote) return existingItem;
    await tx.productFeedbackVote.delete({ where: { id: existingVote.id } });
    const updated = await tx.productFeedbackItem.update({
      where: { id: itemId },
      data: { voteCount: { decrement: 1 } },
    });
    await tx.analyticsEvent.create({
      data: {
        userId: user.id,
        anonymousId: ctx.anonymousId,
        name: "feedback_item_unvoted",
        props: toInputJson({ itemId }),
      },
    });
    return updated;
  });
  return ok({ item: feedbackItemDTO(item, new Set()) });
}

let defaultFeedbackItemsSeeded: Promise<void> | null = null;
async function ensureDefaultFeedbackItems() {
  // The defaults are static, so seed them once per process instead of running an upsert
  // $transaction on EVERY feedback read (write-on-read row-lock contention that scales with
  // read traffic). A failed attempt is not cached, so a transient DB error retries next call.
  if (!defaultFeedbackItemsSeeded) {
    defaultFeedbackItemsSeeded = prisma
      .$transaction(
        defaultFeedbackItems.map((item) =>
          prisma.productFeedbackItem.upsert({
            where: { sourceKey: item.sourceKey },
            update: {
              title: item.title,
              description: item.description,
              category: item.category,
              status: item.status,
            },
            create: item,
          }),
        ),
      )
      .then(() => undefined)
      .catch((error) => {
        defaultFeedbackItemsSeeded = null;
        throw error;
      });
  }
  return defaultFeedbackItemsSeeded;
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
    const cursor = decodeCursor(url.searchParams.get("cursor"));
    const requestedItemId = url.searchParams.get("item")?.trim() ?? "";
    const focusedCharacterId = requestedItemId ? feedCharacterId(requestedItemId) : null;
    const focusedCollectionId = requestedItemId ? feedCollectionId(requestedItemId) : null;
    const featuredSetting = await prisma.appSetting.findUnique({
      where: { key: "feed.featured" },
    });
    const featuredIds = featuredCharacterIds(featuredSetting?.value);
    const excludedIds = [...new Set([...featuredIds, focusedCharacterId].filter((id): id is string => Boolean(id)))];
    const publicWhere = {
      visibility: "public",
      status: "approved",
      deletedAt: null,
    } satisfies Prisma.CharacterWhereInput;
    const collectionLimit = cursor === 0 ? Math.min(3, Math.floor(limit / 4)) : 0;
    const [popular, featured, focusedCharacter, recentCollections, focusedCollection] = await Promise.all([
      // 热度游标分页：排除置顶角色，稳定排序（热度→新→id）。
      prisma.character.findMany({
        where: { ...publicWhere, id: { notIn: excludedIds } },
        include: characterInclude(ctx.userId),
        orderBy: [{ stats: { chatsCount: "desc" } }, { createdAt: "desc" }, { id: "desc" }],
        skip: cursor,
        take: limit + 1,
      }),
      // 置顶角色只在首页（cursor=0）拉取；后续分页排除它们，避免重复。
      cursor === 0 && featuredIds.length > 0
        ? prisma.character.findMany({
            where: { ...publicWhere, id: { in: featuredIds } },
            include: characterInclude(ctx.userId),
          })
        : [],
      cursor === 0 && focusedCharacterId
        ? prisma.character.findFirst({
            where: { ...publicWhere, id: focusedCharacterId },
            include: characterInclude(ctx.userId),
          })
        : null,
      cursor === 0 && collectionLimit > 0
        ? prisma.mediaCollection.findMany({
            where: feedPublicCollectionWhere(focusedCollectionId ? [focusedCollectionId] : []),
            include: mediaCollectionInclude(),
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: collectionLimit,
          })
        : [],
      cursor === 0 && focusedCollectionId
        ? prisma.mediaCollection.findFirst({
            where: feedPublicCollectionWhere([], focusedCollectionId),
            include: mediaCollectionInclude(),
          })
        : null,
    ]);
    const featuredById = new Map(featured.map((character) => [character.id, character]));
    const orderedFeatured = featuredIds
      .map((id) => featuredById.get(id))
      .filter((character): character is (typeof featured)[number] => character !== undefined)
      .filter((character) => character.id !== focusedCharacter?.id);
    const popularPage = popular.slice(0, limit);
    const popularItemIds = new Set(popularPage.map((character) => `character:${character.id}`));
    const characterItems = [...orderedFeatured, ...popularPage].map(feedCharacterItemDTO);
    const collectionItems = recentCollections
      .filter((collection) => collection.id !== focusedCollection?.id)
      .map(feedCollectionItemDTO);
    const focusedItem = focusedCharacter
      ? feedCharacterItemDTO(focusedCharacter)
      : focusedCollection
        ? feedCollectionItemDTO(focusedCollection)
        : null;
    const items = [
      ...(focusedItem ? [focusedItem] : []),
      ...interleaveFeedItems(characterItems, collectionItems),
    ].slice(0, limit);
    const renderedPopularCount = items.filter((item) => popularItemIds.has(item.id)).length;
    return ok({
      items,
      focusedItemId: focusedItem?.id ?? null,
      nextCursor:
        renderedPopularCount > 0 && popular.length > renderedPopularCount
          ? encodeCursor(cursor + renderedPopularCount)
          : null,
    });
  }
  if (request.method === "POST" && action === "restart") return ok({ cursor: null });
  if (action === "items" && itemId && subAction === "like") {
    const characterId = feedCharacterId(itemId);
    if (!characterId) return ok({ accepted: true });
    if (request.method === "POST") {
      const user = requireUser(ctx);
      // 幂等且并发安全：只有真正插入 like 行的请求才推进统计。
      const createdCount = await prisma.$transaction(async (tx) => {
        const created = await tx.characterLike.createMany({
          data: [{ userId: user.id, characterId }],
          skipDuplicates: true,
        });
        if (created.count > 0) {
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
      // 对称：仅当确实删除了一行 like 才 -1，且永不低于 0。
      const removed = await prisma.characterLike.deleteMany({
        where: { userId: user.id, characterId },
      });
      if (removed.count > 0) {
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
  return ok({ accepted: true });
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

async function feedPublicCharacterByItemId(itemId: string) {
  const characterId = feedCharacterId(itemId);
  if (!characterId) return null;
  return prisma.character.findFirst({
    where: {
      id: characterId,
      visibility: "public",
      status: "approved",
      deletedAt: null,
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
    ...idFilter,
    visibility: "public",
    items: {
      some: {
        mediaAsset: {
          deletedAt: null,
          safetyStatus: "passed",
          visibility: { in: ["public_pack", "unlisted"] },
        },
      },
    },
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

// 解析 AppSetting(feed.featured).value = { characterIds: string[] }；脏数据安全降级为空。
function featuredCharacterIds(value: Prisma.JsonValue | null | undefined): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const ids = (value as Record<string, unknown>).characterIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

async function community(request: Request, segments: string[]) {
  const ctx = await getAuthCtx(request);
  requireAgeGate(ctx);
  const [, view] = segments;
  const url = new URL(request.url);
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
  const publicCharacterWhere = {
    visibility: "public",
    status: "approved",
    deletedAt: null,
  } satisfies Prisma.CharacterWhereInput;

  if (view === "collections") {
    const collections = await prisma.mediaCollection.findMany({
      where: { visibility: "public" },
      include: mediaCollectionInclude(),
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    return ok({ collections: collections.map(mediaCollectionDTO) });
  }

  if (view === "campaigns") {
    const campaigns = await prisma.mediaAssetPlacement.findMany({
      where: {
        slot: "campaign",
        status: "published",
        mediaAsset: {
          deletedAt: null,
          safetyStatus: "passed",
          type: "image",
          visibility: { in: ["public_pack", "unlisted"] },
        },
      },
      include: { mediaAsset: true },
      orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
      take: 6,
    });
    return ok({ campaigns: campaigns.map(communityCampaignDTO) });
  }

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
  const metadata = jsonRecord(placement.metadata);
  const image = placement.mediaAsset.storageKey
    ? mediaViewUrl(placement.mediaAsset)
    : (placement.mediaAsset.thumbnailUrl ?? placement.mediaAsset.url);
  return {
    id: placement.id,
    eyebrow: stringMetadata(metadata, "eyebrow", 80) ?? "Community",
    title: stringMetadata(metadata, "title", 120) ?? "Dreamers, Characters, Collections",
    ctaLabel: stringMetadata(metadata, "ctaLabel", 60),
    href: publicCampaignHref(stringMetadata(metadata, "href", 512)),
    image,
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
  const creatorFilter = options.creatorIds?.length
    ? Prisma.sql`AND u.id IN (${Prisma.join(options.creatorIds)})`
    : Prisma.empty;
  const limit = Math.max(1, Math.min(options.limit ?? 20, 40));
  return prisma.$queryRaw<CommunityDreamerRow[]>`
    SELECT
      u.id,
      COALESCE(u."displayName", u.name, 'Dreamer') AS "displayName",
      u.image,
      COUNT(c.id)::int AS characters,
      COALESCE(f.followers, 0)::int AS followers,
      COALESCE(SUM(cs."likesCount"), 0)::bigint AS likes,
      COALESCE(SUM(cs."chatsCount"), 0)::bigint AS chats
    FROM "users" u
    JOIN "characters" c
      ON c."creatorId" = u.id
      AND c.visibility = 'public'
      AND c.status = 'approved'
      AND c."deletedAt" IS NULL
    LEFT JOIN "character_stats" cs ON cs."characterId" = c.id
    LEFT JOIN (
      SELECT "followeeId", COUNT(*)::int AS followers
      FROM "follows"
      GROUP BY "followeeId"
    ) f ON f."followeeId" = u.id
    WHERE u.status = 'active'
      AND u."deletedAt" IS NULL
      ${creatorFilter}
    GROUP BY u.id, u."displayName", u.name, u.image, f.followers
    ORDER BY
      (COALESCE(SUM(cs."likesCount"), 0) + COALESCE(SUM(cs."chatsCount"), 0)) DESC,
      COUNT(c.id) DESC,
      u."createdAt" DESC
    LIMIT ${limit}
  `;
}

async function followUser(request: Request, targetId: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  if (targetId === user.id) throw Errors.badRequest("Cannot follow yourself");
  const target = await prisma.user.findFirst({
    where: { id: targetId, status: "active", deletedAt: null },
  });
  if (!target) throw Errors.notFound("User not found");
  await prisma.follow.upsert({
    where: { followerId_followeeId: { followerId: user.id, followeeId: targetId } },
    update: {},
    create: { followerId: user.id, followeeId: targetId },
  });
  return ok({ following: true });
}

async function unfollowUser(request: Request, targetId: string) {
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  await prisma.follow.deleteMany({
    where: { followerId: user.id, followeeId: targetId },
  });
  return ok({ following: false });
}

// SPEC: public creator profile — displayName + totals + their public/approved characters.
// INTENT: gives Community/Feed a place to lead to (§G); read-only, age-gated, no private data.
async function creatorProfile(request: Request, creatorId: string) {
  const ctx = await getAuthCtx(request);
  requireAgeGate(ctx);
  const creator = await prisma.user.findFirst({
    where: { id: creatorId, status: "active", deletedAt: null },
    select: { id: true, displayName: true, name: true, image: true, createdAt: true },
  });
  if (!creator) throw Errors.notFound("Creator not found");
  const [characters, followers, following] = await Promise.all([
    prisma.character.findMany({
      where: { creatorId, visibility: "public", status: "approved", deletedAt: null },
      include: characterInclude(ctx.userId),
      orderBy: [{ stats: { likesCount: "desc" } }, { createdAt: "desc" }],
      take: 24,
    }),
    prisma.follow.count({ where: { followeeId: creatorId } }),
    ctx.userId
      ? prisma.follow.findFirst({
          where: { followerId: ctx.userId, followeeId: creatorId },
          select: { followerId: true },
        })
      : null,
  ]);
  const totalLikes = characters.reduce((sum, c) => sum + (c.stats?.likesCount ?? 0), 0);
  const totalChats = characters.reduce((sum, c) => sum + (c.stats?.chatsCount ?? 0), 0);
  return ok({
    creator: {
      id: creator.id,
      displayName: creator.displayName ?? creator.name ?? "Dreamer",
      image: creator.image,
      createdAt: creator.createdAt,
      isFollowing: Boolean(following),
      isSelf: ctx.userId === creator.id,
      stats: {
        characters: characters.length,
        followers,
        likes: formatCount(totalLikes),
        chats: formatCount(totalChats),
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
  const source = await readableCharacter(id, user.id);
  const name = `${source.name} Copy`;
  const duplicate = await prisma.character.create({
    data: {
      creatorId: user.id,
      name,
      age: source.age,
      description: source.description,
      systemPrompt: buildCharacterSystemPrompt({
        name,
        age: source.age,
        description: source.description,
        relationship: source.relationship,
        style: source.style,
        gender: source.gender,
        appearance: source.appearance,
        advancedDetails: source.advancedDetails,
      }),
      visibility: "private",
      status: "approved",
      style: source.style,
      gender: source.gender,
      relationship: source.relationship,
      imageAssetId: source.imageAssetId,
      appearance: toInputJson(source.appearance ?? {}),
      advancedDetails: toInputJson(source.advancedDetails ?? {}),
    },
  });
  await prisma.characterStats.create({ data: { characterId: duplicate.id } });
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
  const existing = await prisma.character.findFirst({ where: { id, creatorId: user.id } });
  if (!existing) throw Errors.notFound("Character not found");

  const nextName = body.name ?? existing.name;
  const nextDescription = body.description ?? existing.description;
  const shouldRebuildPrompt = body.name !== undefined || body.description !== undefined;
  await prisma.$transaction(async (tx) => {
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
        status: body.visibility === "public" ? "pending_review" : undefined,
      },
    });
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
  await prisma.character.updateMany({
    where: { id, creatorId: user.id },
    data: { status: "archived", deletedAt: new Date() },
  });
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

function characterDTO(character: CharacterWithPublicRelations, viewerId?: string | null) {
  const visualProfile = character.visualProfiles[0] ?? null;
  const fallbackImage = fallbackCharacterImage(character.id);
  const creatorName = character.creator?.displayName ?? character.creator?.name ?? null;
  return {
    id: character.id,
    name: character.name,
    title: character.name,
    age: String(character.age),
    description: character.description,
    visibility: character.visibility,
    status: character.status,
    style: character.style,
    gender: character.gender,
    relationship: character.relationship,
    creatorId: character.creatorId,
    creator: creatorName ?? (character.source === "official" ? "@ourdream" : "Creator"),
    creatorName,
    canEditIdentity: Boolean(viewerId && character.creatorId === viewerId),
    image: character.imageAsset?.url ?? fallbackImage,
    thumbnailUrl: character.imageAsset?.thumbnailUrl ?? character.imageAsset?.url ?? fallbackImage,
    likes: formatCount(character.stats?.likesCount ?? 0),
    chats: formatCount(character.stats?.chatsCount ?? 0),
    views: character.stats?.viewsCount ?? 0,
    vivid: character.vivid,
    liked: Array.isArray(character.likes) ? character.likes.length > 0 : false,
    visualProfile: visualProfile ? visualProfileDTO(visualProfile) : null,
    tags: character.tags.map(({ tag }) => tag),
    createdAt: character.createdAt,
  };
}

function fallbackCharacterImage(characterId: string) {
  let hash = 0;
  for (let index = 0; index < characterId.length; index += 1) {
    hash = (hash * 31 + characterId.charCodeAt(index)) >>> 0;
  }
  return fallbackCharacterImages[hash % fallbackCharacterImages.length];
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
    sourceType: string;
    sourceId: string | null;
    sourceMeta?: Prisma.JsonValue | null;
  } | null;
}, options: { editableCharacterIds?: ReadonlySet<string> } = {}) {
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
  return {
    id: collection.id,
    name: collection.name,
    visibility: collection.visibility,
    ownerId: collection.ownerId,
    ownerName: collection.owner.displayName ?? collection.owner.name,
    itemCount: collection._count.items,
    previews: collection.items
      .filter(({ mediaAsset }) => {
        if (mediaAsset.deletedAt) return false;
        if (mediaAsset.safetyStatus !== "passed") return false;
        return mediaAsset.visibility === "public_pack" || mediaAsset.visibility === "unlisted";
      })
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
  return {
    job: generationJobDTO(job),
    assets: job.assets.map((asset) => mediaDTO(asset)),
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

function stringMetadata(record: Record<string, unknown>, key: string, max: number) {
  const value = record[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function publicCampaignHref(value: string | null) {
  if (!value) return null;
  if (value.startsWith("/")) return value;
  if (/^https?:\/\//i.test(value)) return value;
  return null;
}

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeMutedTags(values: readonly string[]) {
  return Array.from(new Set(values.map(slugify).filter(Boolean))).slice(0, 80);
}

async function mutedTagSlugsForUser(userId: string) {
  const preferences = await ensurePreferences(userId);
  return normalizeMutedTags(jsonStringArray(preferences.mutedTags));
}

function suggestRoutes(query: string, limit: number): SearchRouteSuggestion[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [];

  const querySlug = slugify(query);
  const queryTerms = normalizedQuery.split(/\s+/).filter(Boolean);
  return ourdreamRoutePaths
    .filter(isSearchableRouteSuggestionPath)
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

function numericControl(
  controls: Record<string, unknown>,
  key: string,
  fallback: number,
) {
  const value = controls[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return value;
}

function normalizeHeader(value: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 160) : null;
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
        { visibility: "public", status: "approved" },
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

async function assertMediaOwner(id: string, userId: string) {
  const media = await prisma.mediaAsset.findFirst({
    where: { id, ownerId: userId, deletedAt: null },
  });
  if (!media) throw Errors.notFound("Media not found");
  return media;
}

async function findPublicReadableMediaAsset(id: string) {
  return prisma.mediaAsset.findFirst({
    where: {
      id,
      deletedAt: null,
      visibility: "public_pack",
      safetyStatus: { in: ["passed", "unknown"] },
    },
  });
}

async function assertReadableMediaAsset(id: string, userId: string) {
  const media = await prisma.mediaAsset.findFirst({
    where: {
      id,
      deletedAt: null,
      OR: [
        ...(isReusablePlatformAssetWhere(userId).OR ?? []),
        {
          visibility: "public_pack",
          safetyStatus: { in: ["passed", "unknown"] },
        },
      ],
    },
  });
  if (!media) throw Errors.notFound("Media not found");
  return media;
}

async function assertIdentityImageMedia(id: string, userId: string) {
  const asset = await assertMediaOwner(id, userId);
  if (asset.type !== "image") throw Errors.badRequest("Only image media can update character identity");
  return asset;
}

async function assertIdentityTargetCharacter(characterId: string | null | undefined, userId: string) {
  if (!characterId) throw Errors.badRequest("Choose a character for this identity action");
  const character = await prisma.character.findFirst({
    where: { id: characterId, creatorId: userId, deletedAt: null },
  });
  if (!character) throw Errors.notFound("Owned character not found");
  return character;
}

async function ensureActiveVisualProfile(
  character: GenerationPromptCharacter,
  input: { anchorAssetId: string | null; createdFrom: string },
) {
  const active = await prisma.characterVisualProfile.findFirst({
    where: { characterId: character.id, status: "active" },
    orderBy: { version: "desc" },
  });
  if (active) return active;
  try {
    return await prisma.characterVisualProfile.create({
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
        anchorAssetIds: input.anchorAssetId ? [input.anchorAssetId] : [],
        createdFrom: input.createdFrom,
      }),
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    return prisma.characterVisualProfile.findFirstOrThrow({
      where: { characterId: character.id, status: "active" },
      orderBy: { version: "desc" },
    });
  }
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

async function failQueuedGeneration(
  job: { id: string; userId: string; costDreamcoins: number },
  errorCode: string,
  error: unknown,
) {
  await prisma.$transaction(async (tx) => {
    const failedAt = new Date();
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
    await tx.generationJob.update({
      where: { id: job.id },
      data: { status: "failed", errorCode, completedAt: null, finishedAt: failedAt, deliveredOutputCount: 0, version: { increment: 1 } },
    });
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
  referenceAssetIds?: Prisma.JsonValue | null;
  referenceManifest?: Prisma.JsonValue | null;
}) {
  const attempt = await prisma.$transaction(async (tx) => {
    const row = await tx.generationAttempt.upsert({
      where: { requestId_attemptNo: { requestId: job.id, attemptNo: 1 } },
      create: { requestId: job.id, attemptNo: 1, status: "queued" },
      update: {},
    });
    await recordGenerationAttemptQueuedEvent(tx, row);
    return row;
  });
  const controls = await internalGenerationControls(job);
  const modelCapabilities = modelCapabilitiesFromControls(controls);
  const referenceImages =
    job.mode === "image" && (modelCapabilities.referenceImages || modelCapabilities.initImage)
      ? filterReferenceImagesForCapabilities(
          await imageReferenceInputsForGenerationJob({
            userId: job.userId,
            characterId: job.characterId,
            controls,
            referenceAssetIds: job.referenceAssetIds,
            referenceManifest: job.referenceManifest,
          }),
          modelCapabilities,
        )
      : [];
  const common = {
    version: 1 as const,
    requestId: cryptoRandomId("gen_req"),
    generationJobId: job.id,
    attemptId: attempt.id,
    attemptNo: attempt.attemptNo,
    userId: job.userId,
    characterId: job.characterId,
    prompt: job.prompt ?? `${job.mode === "video" ? "Video" : "Image"} generation ${job.id}`,
    negativePrompt: job.negativePrompt,
    controls,
    seed: job.seed ?? job.id,
    model: job.model ?? (job.mode === "video" ? "mock-video" : "mock-image"),
    outputPrefix: `gen/${job.id}/`,
  };
  const payload: ImageGeneratePayload | VideoGeneratePayload =
    job.mode === "video"
      ? {
          ...common,
          kind: "video",
          seconds: numericControl(controls, "seconds", 4),
        }
      : {
          ...common,
          kind: "image",
          presetIds: jsonStringArray(job.presetIds),
          orientation: job.orientation ?? stringControl(controls, "orientation", "4:5"),
          count: job.outputCount,
          ...(referenceImages.length > 0 ? { referenceImages } : {}),
        };
  await jobQueue.enqueue({
    queue: job.mode === "video" ? "ai.video.generate" : "ai.image.generate",
    payload: toInputJson(payload),
    dedupeKey: `generation:${job.id}`,
    maxAttempts: 3,
  });
}

async function internalGenerationControls(job: {
  controls: Prisma.JsonValue;
  profileId: string | null;
  profileVersion: number | null;
}) {
  const controls = jsonRecord(job.controls);
  if (!job.profileId || !job.profileVersion) return controls;
  const profile = await prisma.generationModelProfile.findFirst({
    where: {
      version: job.profileVersion,
      OR: [{ profileKey: job.profileId }, { id: job.profileId }],
    },
  });
  if (!profile) return controls;
  const capabilities = generationModelCapabilities(profile.runner, profile.runnerConfig);
  if (profile.runner !== "sd_cpp") {
    return pruneUndefined({
      ...controls,
      modelCapabilities: capabilities,
    });
  }
  return {
    ...controls,
    modelCapabilities: capabilities,
    sdcpp: sdcppProfileRuntimeConfig(profile),
  };
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

function modelCapabilitiesFromControls(controls: Record<string, unknown>) {
  const capabilities = jsonRecord(controls.modelCapabilities);
  return {
    textToImage: booleanFromRecord(capabilities, "textToImage", true),
    stableSeed: booleanFromRecord(capabilities, "stableSeed", true),
    referenceImages: booleanFromRecord(capabilities, "referenceImages", false),
    initImage: booleanFromRecord(capabilities, "initImage", false),
    lora: booleanFromRecord(capabilities, "lora", false),
  };
}

function filterReferenceImagesForCapabilities(
  images: Awaited<ReturnType<typeof imageReferenceInputsForGenerationJob>>,
  capabilities: ReturnType<typeof modelCapabilitiesFromControls>,
) {
  return images.filter((image) => {
    if (image.role === "source_image") return capabilities.initImage;
    return capabilities.referenceImages;
  });
}

function sdcppProfileRuntimeConfig(profile: {
  profileKey: string;
  version: number;
  pipelineModel: string;
  sourceModelPath: string | null;
  convertedModelPath: string | null;
  modelFormat: string;
  runnerConfig: Prisma.JsonValue;
  steps: number;
  sampler: string;
  scheduler: string;
  cfgScale: number;
  defaultWidth: number;
  defaultHeight: number;
}) {
  const config = jsonRecord(profile.runnerConfig);
  const conversion = jsonRecord(config.conversion);
  return pruneUndefined({
    profileKey: profile.profileKey,
    profileVersion: profile.version,
    apiModelId: profile.pipelineModel,
    modelFormat: profile.modelFormat,
    sourceModelPath: profile.sourceModelPath,
    convertedModelPath: profile.convertedModelPath,
    modelPath: stringFromRecord(config, "modelPath"),
    diffusionModelPath: stringFromRecord(config, "diffusionModelPath"),
    llmPath: stringFromRecord(config, "llmPath"),
    vaePath: stringFromRecord(config, "vaePath"),
    llmVisionPath: stringFromRecord(config, "llmVisionPath"),
    clipLPath: stringFromRecord(config, "clipLPath"),
    clipGPath: stringFromRecord(config, "clipGPath"),
    t5xxlPath: stringFromRecord(config, "t5xxlPath"),
    backend: stringFromRecord(config, "backend"),
    loraModelDir: stringFromRecord(config, "loraModelDir"),
    loraApplyMode: stringFromRecord(config, "loraApplyMode"),
    loras: normalizeSdcppLoras(config.loras),
    conversion: conversion.enabled === true ? pruneUndefined({
      enabled: true,
      targetFormat: "gguf",
      outputPath: stringFromRecord(conversion, "outputPath") ?? profile.convertedModelPath,
      type: stringFromRecord(conversion, "type") ?? "q8_0",
      sourceArg: stringFromRecord(conversion, "sourceArg") ?? "model",
      convertName: conversion.convertName === true,
      tensorTypeRules: stringFromRecord(conversion, "tensorTypeRules"),
    }) : undefined,
    steps: profile.steps,
    sampler: profile.sampler,
    scheduler: profile.scheduler,
    cfgScale: profile.cfgScale,
    defaultWidth: profile.defaultWidth,
    defaultHeight: profile.defaultHeight,
  });
}

function normalizeSdcppLoras(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const loras = value
    .filter(isRecord)
    .map((item) =>
      pruneUndefined({
        key: stringFromRecord(item, "key"),
        path: stringFromRecord(item, "path"),
        weight: typeof item.weight === "number" && Number.isFinite(item.weight) ? item.weight : 1,
        enabled: item.enabled !== false,
      }),
    )
    .filter((item) => typeof item.key === "string" || typeof item.path === "string");
  return loras.length ? loras : undefined;
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

async function selectGenerationProfile(mode: "image" | "video", requested?: string) {
  const where: Prisma.GenerationModelProfileWhereInput = {
    mode,
    status: "active",
    enabled: true,
    OR: requested
      ? [{ profileKey: requested }, { id: requested }, { pipelineModel: requested }]
      : undefined,
  };
  const requestedProfile = requested
    ? await prisma.generationModelProfile.findFirst({
        where,
        orderBy: { version: "desc" },
      })
    : null;
  const fallbackProfile =
    requestedProfile ??
    (await prisma.generationModelProfile.findFirst({
      where: { mode, status: "active", enabled: true },
      orderBy: [{ costMultiplier: "asc" }, { version: "desc" }],
    }));
  if (!fallbackProfile) {
    throw Errors.internal("No active generation model profile is configured", { mode });
  }
  return fallbackProfile;
}

async function selectRecipe(mode: "image" | "video", useCase: "character" | "freeplay") {
  const recipe = await prisma.generationRecipe.findFirst({
    where: { mode, useCase, status: "active" },
    orderBy: { version: "desc" },
  });
  if (!recipe) {
    throw Errors.internal("No active generation prompt template is configured", { mode, useCase });
  }
  return recipe;
}

async function featureFlagEnabled(key: string) {
  const flag = await prisma.featureFlag.findUnique({ where: { key } });
  return Boolean(flag?.enabled);
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
    orientations: jsonStringArray(profile.allowedOrientations),
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

async function activateSubscription(userId: string, planId: string, providerSubscriptionId: string) {
  return prisma.$transaction((tx) => activateSubscriptionInTx(tx, userId, planId, providerSubscriptionId));
}

async function activateSubscriptionInTx(
  tx: Prisma.TransactionClient,
  userId: string,
  planId: string,
  providerSubscriptionId: string,
) {
  const plan = await tx.plan.findUniqueOrThrow({ where: { id: planId } });
  // SPEC: one active subscription per (user, plan). Checkout auto-confirm and the
  // billing webhook can both fire for the same purchase (and the demo auto-confirm
  // is replayable), so re-activation must be a no-op rather than stacking subs or
  // re-minting included dreamcoins. The ledger grant below is also keyed on the
  // provider invoice id as a second line of defense against concurrent races.
  await lockUserLedger(tx, userId);
  const existing = await tx.subscription.findFirst({
    where: { userId, planId, status: "active" },
  });
  if (existing) {
    await syncSubscriptionEntitlements(tx, userId, plan, existing.currentPeriodEnd);
    return { subscription: existing, created: false };
  }
  // SPEC: one active subscription per USER. Re-activating the SAME plan is the no-op above;
  // switching to a DIFFERENT plan must SUPERSEDE the prior one, not stack a second active
  // sub. Without this, both subs keep renewing (each re-granting its includedDreamcoins) and
  // entitlementMap max-merges both tiers, so the old tier's exclusive perks linger. Cancel
  // any other active sub and drop its subscription-sourced entitlements; the new plan's
  // syncSubscriptionEntitlements below re-establishes the authoritative set.
  const superseded = await tx.subscription.findMany({
    where: { userId, status: "active", planId: { not: planId } },
    select: { id: true, userId: true },
  });
  const endedAt = new Date();
  const supersededCount = await tx.subscription.updateMany({
    where: { userId, status: "active", planId: { not: planId } },
    data: { status: "canceled", cancelAtPeriodEnd: false },
  });
  if (supersededCount.count > 0) {
    await tx.entitlement.deleteMany({ where: { userId, source: "subscription" } });
    for (const previous of superseded) {
      await appendCanonicalMetricEvent(tx, {
        sourceEventId: `subscription:${previous.id}:ended:${providerSubscriptionId}`,
        eventType: METRIC_PRODUCT_EVENTS.subscriptionEnded,
        occurredAt: endedAt,
        userId: previous.userId,
        context: { source: "plan_switch" },
        payload: {
          subscriptionId: previous.id,
          userId: previous.userId,
          reason: "superseded_by_plan_switch",
        },
      });
    }
  }
  const currentPeriodEnd = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
  const subscription = await tx.subscription.create({
    data: {
      userId,
      planId,
      provider: "mock",
      providerSubscriptionId,
      status: "active",
      currentPeriodEnd,
    },
  });
  await syncSubscriptionEntitlements(tx, userId, plan, currentPeriodEnd);
  await appendLedger(
    tx,
    userId,
    plan.includedDreamcoins,
    "subscription_grant",
    subscription.id,
    `subscription:grant:${providerSubscriptionId}`,
  );
  await appendCanonicalMetricEvent(tx, {
    sourceEventId: `subscription:${subscription.id}:activated`,
    eventType: METRIC_PRODUCT_EVENTS.subscriptionActivated,
    occurredAt: subscription.createdAt,
    userId,
    context: { providerSubscriptionId },
    payload: { subscriptionId: subscription.id, userId, planId },
  });
  return { subscription, created: true };
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

async function ensurePreferences(userId: string) {
  return prisma.userPreferences.upsert({
    where: { userId },
    update: {},
    create: {
      userId,
      mutedTags: [],
      safeModeFlags: {},
      notificationSettings: {},
    },
  });
}

async function applyModerationAction(
  targetType: string,
  targetId: string,
  policyCode?: string,
) {
  // INVARIANT: a takedown must actually remove something. Feed items wrap a
  // character, so resolve and take that down; unknown target types throw so the
  // caller can escalate instead of recording a false "blocked" event.
  if (targetType === "character") {
    await prisma.character.updateMany({
      where: { id: targetId },
      data: { status: "removed" },
    });
  } else if (targetType === "media") {
    await prisma.mediaAsset.updateMany({
      where: { id: targetId },
      data: { safetyStatus: "blocked" },
    });
  } else if (targetType === "feed_item") {
    const characterId = feedCharacterId(targetId);
    const collectionId = feedCollectionId(targetId);
    if (characterId) {
      await prisma.character.updateMany({
        where: { id: characterId },
        data: { status: "removed" },
      });
    } else if (collectionId) {
      await prisma.mediaCollection.updateMany({
        where: { id: collectionId },
        data: { visibility: "private" },
      });
    } else {
      throw Errors.badRequest(`Cannot resolve feed_item moderation target: ${targetId}`);
    }
  } else {
    throw Errors.badRequest(`Unsupported moderation target type: ${targetType}`);
  }
  await prisma.moderationEvent.create({
    data: {
      targetType,
      targetId,
      layer: "human_review",
      status: "blocked",
      policyCode,
      details: {},
    },
  });
}

async function trackEvent(
  name: string,
  props: unknown,
  ctx: { userId?: string; anonymousId?: string },
) {
  return prisma.analyticsEvent.create({
    data: {
      userId: ctx.userId,
      anonymousId: ctx.anonymousId,
      name,
      props: toInputJson(props),
    },
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
