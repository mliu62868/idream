-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT,
    "image" TEXT,
    "displayName" TEXT,
    "role" TEXT NOT NULL DEFAULT 'user',
    "status" TEXT NOT NULL DEFAULT 'active',
    "anonymousId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "password" TEXT,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verifications" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_preferences" (
    "userId" TEXT NOT NULL,
    "mutedTags" JSONB NOT NULL,
    "safeModeFlags" JSONB NOT NULL,
    "notificationSettings" JSONB NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "age_gate_acceptances" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "anonymousId" TEXT,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "country" TEXT,
    "sourcePath" TEXT,
    "policyVersion" TEXT,

    CONSTRAINT "age_gate_acceptances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "age_verifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerVerificationId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'required',
    "jurisdiction" TEXT,
    "requiredReason" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "age_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "characters" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT,
    "name" TEXT NOT NULL,
    "age" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "systemPrompt" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "source" TEXT NOT NULL DEFAULT 'user',
    "style" TEXT NOT NULL DEFAULT 'realistic',
    "gender" TEXT NOT NULL DEFAULT 'female',
    "relationship" TEXT,
    "voiceId" TEXT,
    "imageAssetId" TEXT,
    "appearance" JSONB NOT NULL,
    "advancedDetails" JSONB NOT NULL,
    "vivid" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "characters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "character_drafts" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "step" INTEGER NOT NULL DEFAULT 0,
    "gender" TEXT,
    "style" TEXT,
    "appearance" JSONB NOT NULL,
    "hair" JSONB NOT NULL,
    "body" JSONB NOT NULL,
    "name" TEXT,
    "advancedDetails" JSONB NOT NULL,
    "tags" JSONB NOT NULL,
    "previewJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "character_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "character_preview_jobs" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "provider" TEXT,
    "resultAssetId" TEXT,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "character_preview_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "character_visual_profiles" (
    "id" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "style" TEXT NOT NULL DEFAULT 'realistic',
    "identityPrompt" TEXT NOT NULL,
    "negativeIdentityPrompt" TEXT,
    "faceTraits" JSONB NOT NULL,
    "hairTraits" JSONB NOT NULL,
    "bodyTraits" JSONB NOT NULL,
    "signatureTraits" JSONB NOT NULL,
    "styleTraits" JSONB NOT NULL,
    "anchorAssetIds" JSONB NOT NULL,
    "referenceAssetIds" JSONB NOT NULL,
    "defaultSeed" TEXT,
    "adapterRefs" JSONB NOT NULL,
    "qualityScore" DOUBLE PRECISION,
    "consistencyScore" DOUBLE PRECISION,
    "createdFrom" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "character_visual_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "character_looks" (
    "id" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "visualProfileId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "appearanceDelta" JSONB NOT NULL,
    "referenceAssetId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "activeKey" TEXT,
    "rebasedFromLookId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "character_looks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reference_set_revisions" (
    "id" TEXT NOT NULL,
    "visualProfileId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'active',
    "selectorVersion" TEXT NOT NULL DEFAULT 'v1',
    "createdFrom" TEXT NOT NULL,
    "availableAtSnapshot" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reference_set_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reference_candidates" (
    "id" TEXT NOT NULL,
    "visualProfileId" TEXT NOT NULL,
    "mediaAssetId" TEXT NOT NULL,
    "sourceJobId" TEXT,
    "proposedRole" TEXT NOT NULL DEFAULT 'identity_reference',
    "qualityScore" DOUBLE PRECISION,
    "identityScore" DOUBLE PRECISION,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'candidate',
    "rejectionReason" TEXT,
    "promotedRevisionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reference_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "character_visual_reference_snapshots" (
    "id" TEXT NOT NULL,
    "referenceSetRevisionId" TEXT NOT NULL,
    "mediaAssetId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "crop" JSONB,
    "qualityScore" DOUBLE PRECISION,
    "identityScore" DOUBLE PRECISION,
    "selectorVersion" TEXT NOT NULL DEFAULT 'v1',
    "selectionReason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "character_visual_reference_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "category" TEXT,
    "isSensitive" BOOLEAN NOT NULL DEFAULT false,
    "isMutedByDefault" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "character_tags" (
    "characterId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    CONSTRAINT "character_tags_pkey" PRIMARY KEY ("characterId","tagId")
);

-- CreateTable
CREATE TABLE "character_stats" (
    "characterId" TEXT NOT NULL,
    "likesCount" INTEGER NOT NULL DEFAULT 0,
    "chatsCount" INTEGER NOT NULL DEFAULT 0,
    "viewsCount" INTEGER NOT NULL DEFAULT 0,
    "lastActivityAt" TIMESTAMP(3),

    CONSTRAINT "character_stats_pkey" PRIMARY KEY ("characterId")
);

-- CreateTable
CREATE TABLE "character_likes" (
    "userId" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "character_likes_pkey" PRIMARY KEY ("userId","characterId")
);

-- CreateTable
CREATE TABLE "character_submissions" (
    "id" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "submitterId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewReason" TEXT,
    "reviewerId" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "character_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "character_templates" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'built_in',
    "name" TEXT NOT NULL,
    "summary" TEXT,
    "gender" TEXT,
    "style" TEXT,
    "appearance" JSONB NOT NULL,
    "advancedDetails" JSONB NOT NULL,
    "tags" JSONB NOT NULL,
    "coverAssetId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "character_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recent_chats" (
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "title" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastMessageAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recent_chats_pkey" PRIMARY KEY ("sessionId")
);

-- CreateTable
CREATE TABLE "generation_presets" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT,
    "scope" TEXT NOT NULL DEFAULT 'user',
    "type" TEXT NOT NULL,
    "category" TEXT,
    "label" TEXT NOT NULL,
    "controls" JSONB NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generation_presets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_jobs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "characterId" TEXT,
    "visualProfileId" TEXT,
    "visualProfileVersion" INTEGER,
    "consistencyMode" TEXT,
    "seed" TEXT,
    "referenceAssetIds" JSONB,
    "referenceSetRevisionId" TEXT,
    "referenceManifest" JSONB,
    "momentSpec" JSONB,
    "lookId" TEXT,
    "lookSnapshot" JSONB,
    "derivedFromJobId" TEXT,
    "idempotencyKey" TEXT,
    "mode" TEXT NOT NULL,
    "prompt" TEXT,
    "negativePrompt" TEXT,
    "controls" JSONB NOT NULL,
    "presetIds" JSONB NOT NULL,
    "model" TEXT,
    "profileId" TEXT,
    "profileVersion" INTEGER,
    "recipeId" TEXT,
    "recipeVersion" INTEGER,
    "orientation" TEXT,
    "outputCount" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "costDreamcoins" INTEGER NOT NULL DEFAULT 0,
    "provider" TEXT,
    "sourceType" TEXT NOT NULL DEFAULT 'generator',
    "sourceId" TEXT,
    "sourceMeta" JSONB,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "generation_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_job_events" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generation_job_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_feedback" (
    "id" TEXT NOT NULL,
    "feedbackKey" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "mediaAssetId" TEXT NOT NULL,
    "generationJobId" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "sourceSurface" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "supersedesId" TEXT,
    "eventId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generation_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_assets" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "sourceJobId" TEXT,
    "characterId" TEXT,
    "type" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "thumbnailUrl" TEXT,
    "storageKey" TEXT,
    "contentType" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "providerAssetId" TEXT,
    "sourcePromptHash" TEXT,
    "prompt" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "safetyStatus" TEXT NOT NULL DEFAULT 'unknown',
    "metadata" JSONB NOT NULL,
    "liked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_production_batches" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "targetType" TEXT NOT NULL DEFAULT 'none',
    "targetId" TEXT,
    "profileId" TEXT,
    "profileVersion" INTEGER,
    "recipeId" TEXT,
    "recipeVersion" INTEGER,
    "presetIds" JSONB NOT NULL,
    "orientation" TEXT,
    "brief" TEXT,
    "count" INTEGER NOT NULL DEFAULT 1,
    "totalItems" INTEGER NOT NULL DEFAULT 0,
    "completedItems" INTEGER NOT NULL DEFAULT 0,
    "failedItems" INTEGER NOT NULL DEFAULT 0,
    "approvedItems" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostDreamcoins" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_production_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_production_items" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "jobId" TEXT,
    "mediaAssetId" TEXT,
    "itemIndex" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "reviewNote" TEXT,
    "rating" INTEGER,
    "tags" JSONB NOT NULL,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_production_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_asset_placements" (
    "id" TEXT NOT NULL,
    "mediaAssetId" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "scheduledAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_asset_placements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_likes" (
    "userId" TEXT NOT NULL,
    "mediaAssetId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_likes_pkey" PRIMARY KEY ("userId","mediaAssetId")
);

-- CreateTable
CREATE TABLE "media_collections" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_collection_items" (
    "collectionId" TEXT NOT NULL,
    "mediaAssetId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "media_collection_items_pkey" PRIMARY KEY ("collectionId","mediaAssetId")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "billingPeriod" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "includedDreamcoins" INTEGER NOT NULL DEFAULT 0,
    "features" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerCustomerId" TEXT,
    "providerSubscriptionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'checkout_created',
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entitlements" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entitlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dreamcoin_ledger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "sourceId" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dreamcoin_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checkout_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerSessionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'created',
    "returnPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checkout_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderation_events" (
    "id" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "layer" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "policyCode" TEXT,
    "confidence" DOUBLE PRECISION,
    "details" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moderation_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_reports" (
    "id" TEXT NOT NULL,
    "reporterId" TEXT,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "priority" INTEGER NOT NULL DEFAULT 3,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderation_reviews" (
    "id" TEXT NOT NULL,
    "reportId" TEXT,
    "reviewerId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "policyCode" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moderation_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appeals" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "originalDecisionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "appealText" TEXT NOT NULL,
    "reviewerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "appeals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_requests" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "diagnosticConsent" BOOLEAN NOT NULL DEFAULT true,
    "sourcePath" TEXT,
    "status" TEXT NOT NULL DEFAULT 'received',
    "priority" INTEGER NOT NULL DEFAULT 3,
    "assignedToId" TEXT,
    "slaEscalatedAt" TIMESTAMP(3),
    "slaEscalatedById" TEXT,
    "slaEscalationReason" TEXT,
    "resolutionNotes" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_feedback_items" (
    "id" TEXT NOT NULL,
    "sourceKey" TEXT,
    "createdById" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'feature',
    "status" TEXT NOT NULL DEFAULT 'under_review',
    "voteCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_feedback_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_feedback_votes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_feedback_votes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_versions" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "title" TEXT,
    "body" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceUrl" TEXT,

    CONSTRAINT "policy_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "redeem_codes" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "reward" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "maxRedemptions" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "redeem_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "redeem_code_redemptions" (
    "id" TEXT NOT NULL,
    "redeemCodeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rewardStatus" TEXT NOT NULL DEFAULT 'granted',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "redeem_code_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referrals" (
    "id" TEXT NOT NULL,
    "inviterId" TEXT NOT NULL,
    "inviteeId" TEXT,
    "code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "subscriptionId" TEXT,
    "rewardStatus" TEXT NOT NULL DEFAULT 'none',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "follows" (
    "followerId" TEXT NOT NULL,
    "followeeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "follows_pkey" PRIMARY KEY ("followerId","followeeId")
);

-- CreateTable
CREATE TABLE "provider_events" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "type" TEXT,
    "payload" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_events" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "anonymousId" TEXT,
    "name" TEXT NOT NULL,
    "props" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_pages" (
    "path" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "canonical" TEXT,
    "contentStatus" TEXT NOT NULL DEFAULT 'template',
    "body" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "route_pages_pkey" PRIMARY KEY ("path")
);

-- CreateTable
CREATE TABLE "admin_audit_logs" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "reason" TEXT,
    "before" JSONB,
    "after" JSONB,
    "requestId" TEXT,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_action_requests" (
    "id" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "permissionKey" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "admin_action_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_flags" (
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "rolloutPercent" INTEGER NOT NULL DEFAULT 0,
    "targetRoles" JSONB NOT NULL,
    "targetPlans" JSONB NOT NULL,
    "hardPolicy" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'active',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "generation_model_profiles" (
    "id" TEXT NOT NULL,
    "profileKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'image',
    "runner" TEXT NOT NULL DEFAULT 'sd_cpp',
    "pipelineModel" TEXT NOT NULL,
    "workflowKey" TEXT,
    "sourceModelPath" TEXT,
    "convertedModelPath" TEXT,
    "modelFormat" TEXT NOT NULL DEFAULT 'safetensors',
    "runnerConfig" JSONB,
    "defaultWidth" INTEGER NOT NULL DEFAULT 768,
    "defaultHeight" INTEGER NOT NULL DEFAULT 1024,
    "allowedOrientations" JSONB NOT NULL,
    "steps" INTEGER NOT NULL DEFAULT 28,
    "sampler" TEXT NOT NULL DEFAULT 'dpm++2m',
    "scheduler" TEXT NOT NULL DEFAULT 'model_default',
    "cfgScale" DOUBLE PRECISION NOT NULL DEFAULT 7,
    "costMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "requiredEntitlement" TEXT,
    "maxCount" INTEGER NOT NULL DEFAULT 4,
    "concurrencyLimit" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "rolloutPercent" INTEGER NOT NULL DEFAULT 100,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "dryRunSummary" JSONB,
    "publishedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generation_model_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_recipes" (
    "id" TEXT NOT NULL,
    "recipeKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'image',
    "useCase" TEXT NOT NULL DEFAULT 'character',
    "body" TEXT NOT NULL,
    "negativeBase" TEXT,
    "presetOrder" JSONB NOT NULL,
    "safetyHints" JSONB NOT NULL,
    "sampleMatrix" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "dryRunSummary" JSONB,
    "publishedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generation_recipes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_provider_routes" (
    "id" TEXT NOT NULL,
    "profileKey" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "endpointRef" TEXT,
    "weight" INTEGER NOT NULL DEFAULT 100,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generation_provider_routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_rules" (
    "id" TEXT NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "baseCost" INTEGER NOT NULL,
    "multiplier" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "effectiveFrom" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pricing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_saved_views" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_saved_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_user_permissions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "permissionKey" TEXT NOT NULL,
    "effect" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_user_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_consent_grants" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "scope" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_consent_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_holds" (
    "id" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "caseNumber" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "approvedById" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "releasedById" TEXT,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legal_holds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_anonymousId_key" ON "users"("anonymousId");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "accounts_userId_idx" ON "accounts"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_providerId_accountId_key" ON "accounts"("providerId", "accountId");

-- CreateIndex
CREATE INDEX "verifications_identifier_idx" ON "verifications"("identifier");

-- CreateIndex
CREATE INDEX "age_gate_acceptances_userId_idx" ON "age_gate_acceptances"("userId");

-- CreateIndex
CREATE INDEX "age_gate_acceptances_anonymousId_idx" ON "age_gate_acceptances"("anonymousId");

-- CreateIndex
CREATE INDEX "age_verifications_userId_status_idx" ON "age_verifications"("userId", "status");

-- CreateIndex
CREATE INDEX "characters_visibility_status_idx" ON "characters"("visibility", "status");

-- CreateIndex
CREATE INDEX "characters_source_visibility_status_idx" ON "characters"("source", "visibility", "status");

-- CreateIndex
CREATE INDEX "characters_creatorId_idx" ON "characters"("creatorId");

-- CreateIndex
CREATE INDEX "characters_gender_style_idx" ON "characters"("gender", "style");

-- CreateIndex
CREATE INDEX "characters_createdAt_idx" ON "characters"("createdAt");

-- CreateIndex
CREATE INDEX "character_drafts_ownerId_idx" ON "character_drafts"("ownerId");

-- CreateIndex
CREATE INDEX "character_preview_jobs_draftId_idx" ON "character_preview_jobs"("draftId");

-- CreateIndex
CREATE INDEX "character_visual_profiles_characterId_status_idx" ON "character_visual_profiles"("characterId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "character_visual_profiles_characterId_version_key" ON "character_visual_profiles"("characterId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "character_looks_activeKey_key" ON "character_looks"("activeKey");

-- CreateIndex
CREATE INDEX "character_looks_ownerId_characterId_status_idx" ON "character_looks"("ownerId", "characterId", "status");

-- CreateIndex
CREATE INDEX "character_looks_visualProfileId_idx" ON "character_looks"("visualProfileId");

-- CreateIndex
CREATE INDEX "character_looks_referenceAssetId_idx" ON "character_looks"("referenceAssetId");

-- CreateIndex
CREATE INDEX "reference_set_revisions_visualProfileId_status_idx" ON "reference_set_revisions"("visualProfileId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "reference_set_revisions_visualProfileId_revision_key" ON "reference_set_revisions"("visualProfileId", "revision");

-- CreateIndex
CREATE INDEX "reference_candidates_visualProfileId_status_idx" ON "reference_candidates"("visualProfileId", "status");

-- CreateIndex
CREATE INDEX "reference_candidates_sourceJobId_idx" ON "reference_candidates"("sourceJobId");

-- CreateIndex
CREATE INDEX "reference_candidates_promotedRevisionId_idx" ON "reference_candidates"("promotedRevisionId");

-- CreateIndex
CREATE UNIQUE INDEX "reference_candidates_visualProfileId_mediaAssetId_key" ON "reference_candidates"("visualProfileId", "mediaAssetId");

-- CreateIndex
CREATE INDEX "character_visual_reference_snapshots_mediaAssetId_idx" ON "character_visual_reference_snapshots"("mediaAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "character_visual_reference_snapshots_referenceSetRevisionId_key" ON "character_visual_reference_snapshots"("referenceSetRevisionId", "mediaAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "tags_slug_key" ON "tags"("slug");

-- CreateIndex
CREATE INDEX "tags_category_idx" ON "tags"("category");

-- CreateIndex
CREATE INDEX "character_tags_tagId_idx" ON "character_tags"("tagId");

-- CreateIndex
CREATE INDEX "character_stats_likesCount_idx" ON "character_stats"("likesCount");

-- CreateIndex
CREATE INDEX "character_stats_chatsCount_idx" ON "character_stats"("chatsCount");

-- CreateIndex
CREATE INDEX "character_likes_characterId_idx" ON "character_likes"("characterId");

-- CreateIndex
CREATE INDEX "character_submissions_status_idx" ON "character_submissions"("status");

-- CreateIndex
CREATE INDEX "character_submissions_characterId_idx" ON "character_submissions"("characterId");

-- CreateIndex
CREATE INDEX "character_templates_isActive_sortOrder_idx" ON "character_templates"("isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "recent_chats_userId_lastMessageAt_idx" ON "recent_chats"("userId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "recent_chats_characterId_idx" ON "recent_chats"("characterId");

-- CreateIndex
CREATE INDEX "generation_presets_scope_type_idx" ON "generation_presets"("scope", "type");

-- CreateIndex
CREATE INDEX "generation_presets_ownerId_idx" ON "generation_presets"("ownerId");

-- CreateIndex
CREATE INDEX "generation_jobs_userId_createdAt_idx" ON "generation_jobs"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "generation_jobs_derivedFromJobId_idx" ON "generation_jobs"("derivedFromJobId");

-- CreateIndex
CREATE INDEX "generation_jobs_status_idx" ON "generation_jobs"("status");

-- CreateIndex
CREATE INDEX "generation_jobs_sourceType_idx" ON "generation_jobs"("sourceType");

-- CreateIndex
CREATE INDEX "generation_jobs_visualProfileId_visualProfileVersion_idx" ON "generation_jobs"("visualProfileId", "visualProfileVersion");

-- CreateIndex
CREATE INDEX "generation_jobs_referenceSetRevisionId_idx" ON "generation_jobs"("referenceSetRevisionId");

-- CreateIndex
CREATE INDEX "generation_jobs_lookId_idx" ON "generation_jobs"("lookId");

-- CreateIndex
CREATE INDEX "generation_jobs_profileId_profileVersion_idx" ON "generation_jobs"("profileId", "profileVersion");

-- CreateIndex
CREATE INDEX "generation_jobs_recipeId_recipeVersion_idx" ON "generation_jobs"("recipeId", "recipeVersion");

-- CreateIndex
CREATE UNIQUE INDEX "generation_jobs_userId_idempotencyKey_key" ON "generation_jobs"("userId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "generation_jobs_sourceType_sourceId_key" ON "generation_jobs"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "generation_job_events_jobId_createdAt_idx" ON "generation_job_events"("jobId", "createdAt");

-- CreateIndex
CREATE INDEX "generation_job_events_type_idx" ON "generation_job_events"("type");

-- CreateIndex
CREATE UNIQUE INDEX "generation_feedback_eventId_key" ON "generation_feedback"("eventId");

-- CreateIndex
CREATE INDEX "generation_feedback_actorId_mediaAssetId_dimension_active_idx" ON "generation_feedback"("actorId", "mediaAssetId", "dimension", "active");

-- CreateIndex
CREATE INDEX "generation_feedback_generationJobId_createdAt_idx" ON "generation_feedback"("generationJobId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "generation_feedback_actorId_mediaAssetId_dimension_revision_key" ON "generation_feedback"("actorId", "mediaAssetId", "dimension", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_storageKey_key" ON "media_assets"("storageKey");

-- CreateIndex
CREATE INDEX "media_assets_ownerId_type_createdAt_idx" ON "media_assets"("ownerId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "media_assets_sourceJobId_idx" ON "media_assets"("sourceJobId");

-- CreateIndex
CREATE INDEX "media_assets_characterId_idx" ON "media_assets"("characterId");

-- CreateIndex
CREATE INDEX "content_production_batches_purpose_status_createdAt_idx" ON "content_production_batches"("purpose", "status", "createdAt");

-- CreateIndex
CREATE INDEX "content_production_batches_targetType_targetId_idx" ON "content_production_batches"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "content_production_batches_profileId_profileVersion_idx" ON "content_production_batches"("profileId", "profileVersion");

-- CreateIndex
CREATE INDEX "content_production_batches_recipeId_recipeVersion_idx" ON "content_production_batches"("recipeId", "recipeVersion");

-- CreateIndex
CREATE INDEX "content_production_batches_createdById_idx" ON "content_production_batches"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "content_production_items_jobId_key" ON "content_production_items"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "content_production_items_mediaAssetId_key" ON "content_production_items"("mediaAssetId");

-- CreateIndex
CREATE INDEX "content_production_items_batchId_status_idx" ON "content_production_items"("batchId", "status");

-- CreateIndex
CREATE INDEX "content_production_items_mediaAssetId_idx" ON "content_production_items"("mediaAssetId");

-- CreateIndex
CREATE INDEX "media_asset_placements_mediaAssetId_status_idx" ON "media_asset_placements"("mediaAssetId", "status");

-- CreateIndex
CREATE INDEX "media_asset_placements_slot_targetType_targetId_idx" ON "media_asset_placements"("slot", "targetType", "targetId");

-- CreateIndex
CREATE INDEX "media_asset_placements_createdById_idx" ON "media_asset_placements"("createdById");

-- CreateIndex
CREATE INDEX "media_likes_mediaAssetId_idx" ON "media_likes"("mediaAssetId");

-- CreateIndex
CREATE INDEX "media_collections_ownerId_idx" ON "media_collections"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "plans_slug_billingPeriod_key" ON "plans"("slug", "billingPeriod");

-- CreateIndex
CREATE INDEX "subscriptions_userId_status_idx" ON "subscriptions"("userId", "status");

-- CreateIndex
CREATE INDEX "subscriptions_providerSubscriptionId_idx" ON "subscriptions"("providerSubscriptionId");

-- CreateIndex
CREATE INDEX "entitlements_userId_idx" ON "entitlements"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "entitlements_userId_key_key" ON "entitlements"("userId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "dreamcoin_ledger_idempotencyKey_key" ON "dreamcoin_ledger"("idempotencyKey");

-- CreateIndex
CREATE INDEX "dreamcoin_ledger_userId_createdAt_idx" ON "dreamcoin_ledger"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "dreamcoin_ledger_sourceId_idx" ON "dreamcoin_ledger"("sourceId");

-- CreateIndex
CREATE INDEX "checkout_sessions_userId_idx" ON "checkout_sessions"("userId");

-- CreateIndex
CREATE INDEX "moderation_events_targetType_targetId_idx" ON "moderation_events"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "moderation_events_policyCode_idx" ON "moderation_events"("policyCode");

-- CreateIndex
CREATE INDEX "content_reports_status_priority_idx" ON "content_reports"("status", "priority");

-- CreateIndex
CREATE INDEX "content_reports_targetType_targetId_idx" ON "content_reports"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "moderation_reviews_reportId_idx" ON "moderation_reviews"("reportId");

-- CreateIndex
CREATE INDEX "appeals_userId_idx" ON "appeals"("userId");

-- CreateIndex
CREATE INDEX "appeals_status_idx" ON "appeals"("status");

-- CreateIndex
CREATE UNIQUE INDEX "support_requests_ticketId_key" ON "support_requests"("ticketId");

-- CreateIndex
CREATE INDEX "support_requests_status_priority_createdAt_idx" ON "support_requests"("status", "priority", "createdAt");

-- CreateIndex
CREATE INDEX "support_requests_category_idx" ON "support_requests"("category");

-- CreateIndex
CREATE INDEX "support_requests_userId_idx" ON "support_requests"("userId");

-- CreateIndex
CREATE INDEX "support_requests_slaEscalatedAt_idx" ON "support_requests"("slaEscalatedAt");

-- CreateIndex
CREATE INDEX "support_requests_assignedToId_idx" ON "support_requests"("assignedToId");

-- CreateIndex
CREATE UNIQUE INDEX "product_feedback_items_sourceKey_key" ON "product_feedback_items"("sourceKey");

-- CreateIndex
CREATE INDEX "product_feedback_items_status_voteCount_createdAt_idx" ON "product_feedback_items"("status", "voteCount", "createdAt");

-- CreateIndex
CREATE INDEX "product_feedback_items_createdById_idx" ON "product_feedback_items"("createdById");

-- CreateIndex
CREATE INDEX "product_feedback_votes_itemId_idx" ON "product_feedback_votes"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "product_feedback_votes_userId_itemId_key" ON "product_feedback_votes"("userId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "policy_versions_slug_version_key" ON "policy_versions"("slug", "version");

-- CreateIndex
CREATE UNIQUE INDEX "redeem_codes_codeHash_key" ON "redeem_codes"("codeHash");

-- CreateIndex
CREATE UNIQUE INDEX "redeem_code_redemptions_redeemCodeId_userId_key" ON "redeem_code_redemptions"("redeemCodeId", "userId");

-- CreateIndex
CREATE INDEX "referrals_code_idx" ON "referrals"("code");

-- CreateIndex
CREATE INDEX "referrals_inviteeId_idx" ON "referrals"("inviteeId");

-- CreateIndex
CREATE INDEX "referrals_inviterId_idx" ON "referrals"("inviterId");

-- CreateIndex
CREATE INDEX "follows_followeeId_idx" ON "follows"("followeeId");

-- CreateIndex
CREATE UNIQUE INDEX "provider_events_provider_providerEventId_key" ON "provider_events"("provider", "providerEventId");

-- CreateIndex
CREATE INDEX "analytics_events_name_createdAt_idx" ON "analytics_events"("name", "createdAt");

-- CreateIndex
CREATE INDEX "analytics_events_userId_idx" ON "analytics_events"("userId");

-- CreateIndex
CREATE INDEX "route_pages_template_idx" ON "route_pages"("template");

-- CreateIndex
CREATE INDEX "admin_audit_logs_actorId_createdAt_idx" ON "admin_audit_logs"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "admin_audit_logs_action_createdAt_idx" ON "admin_audit_logs"("action", "createdAt");

-- CreateIndex
CREATE INDEX "admin_audit_logs_targetType_targetId_idx" ON "admin_audit_logs"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "admin_action_requests_status_createdAt_idx" ON "admin_action_requests"("status", "createdAt");

-- CreateIndex
CREATE INDEX "admin_action_requests_requestedById_idx" ON "admin_action_requests"("requestedById");

-- CreateIndex
CREATE INDEX "feature_flags_enabled_idx" ON "feature_flags"("enabled");

-- CreateIndex
CREATE INDEX "app_settings_status_idx" ON "app_settings"("status");

-- CreateIndex
CREATE INDEX "generation_model_profiles_profileKey_status_idx" ON "generation_model_profiles"("profileKey", "status");

-- CreateIndex
CREATE INDEX "generation_model_profiles_mode_status_idx" ON "generation_model_profiles"("mode", "status");

-- CreateIndex
CREATE INDEX "generation_recipes_recipeKey_status_idx" ON "generation_recipes"("recipeKey", "status");

-- CreateIndex
CREATE INDEX "generation_recipes_mode_useCase_status_idx" ON "generation_recipes"("mode", "useCase", "status");

-- CreateIndex
CREATE INDEX "generation_provider_routes_profileKey_enabled_idx" ON "generation_provider_routes"("profileKey", "enabled");

-- CreateIndex
CREATE INDEX "pricing_rules_ruleKey_status_idx" ON "pricing_rules"("ruleKey", "status");

-- CreateIndex
CREATE INDEX "pricing_rules_mode_status_idx" ON "pricing_rules"("mode", "status");

-- CreateIndex
CREATE INDEX "admin_saved_views_ownerId_scope_idx" ON "admin_saved_views"("ownerId", "scope");

-- CreateIndex
CREATE INDEX "admin_user_permissions_userId_idx" ON "admin_user_permissions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "admin_user_permissions_userId_permissionKey_effect_key" ON "admin_user_permissions"("userId", "permissionKey", "effect");

-- CreateIndex
CREATE INDEX "support_consent_grants_userId_targetType_targetId_idx" ON "support_consent_grants"("userId", "targetType", "targetId");

-- CreateIndex
CREATE INDEX "support_consent_grants_ticketId_idx" ON "support_consent_grants"("ticketId");

-- CreateIndex
CREATE INDEX "legal_holds_targetType_targetId_status_idx" ON "legal_holds"("targetType", "targetId", "status");

-- CreateIndex
CREATE INDEX "legal_holds_caseNumber_idx" ON "legal_holds"("caseNumber");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "age_gate_acceptances" ADD CONSTRAINT "age_gate_acceptances_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "age_verifications" ADD CONSTRAINT "age_verifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "characters" ADD CONSTRAINT "characters_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "characters" ADD CONSTRAINT "characters_imageAssetId_fkey" FOREIGN KEY ("imageAssetId") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_drafts" ADD CONSTRAINT "character_drafts_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_preview_jobs" ADD CONSTRAINT "character_preview_jobs_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "character_drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_visual_profiles" ADD CONSTRAINT "character_visual_profiles_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_looks" ADD CONSTRAINT "character_looks_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_looks" ADD CONSTRAINT "character_looks_visualProfileId_fkey" FOREIGN KEY ("visualProfileId") REFERENCES "character_visual_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_looks" ADD CONSTRAINT "character_looks_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_looks" ADD CONSTRAINT "character_looks_referenceAssetId_fkey" FOREIGN KEY ("referenceAssetId") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_looks" ADD CONSTRAINT "character_looks_rebasedFromLookId_fkey" FOREIGN KEY ("rebasedFromLookId") REFERENCES "character_looks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_set_revisions" ADD CONSTRAINT "reference_set_revisions_visualProfileId_fkey" FOREIGN KEY ("visualProfileId") REFERENCES "character_visual_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_candidates" ADD CONSTRAINT "reference_candidates_visualProfileId_fkey" FOREIGN KEY ("visualProfileId") REFERENCES "character_visual_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_candidates" ADD CONSTRAINT "reference_candidates_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_candidates" ADD CONSTRAINT "reference_candidates_sourceJobId_fkey" FOREIGN KEY ("sourceJobId") REFERENCES "generation_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_candidates" ADD CONSTRAINT "reference_candidates_promotedRevisionId_fkey" FOREIGN KEY ("promotedRevisionId") REFERENCES "reference_set_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_visual_reference_snapshots" ADD CONSTRAINT "character_visual_reference_snapshots_referenceSetRevisionI_fkey" FOREIGN KEY ("referenceSetRevisionId") REFERENCES "reference_set_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_visual_reference_snapshots" ADD CONSTRAINT "character_visual_reference_snapshots_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_tags" ADD CONSTRAINT "character_tags_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_tags" ADD CONSTRAINT "character_tags_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_stats" ADD CONSTRAINT "character_stats_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_likes" ADD CONSTRAINT "character_likes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_likes" ADD CONSTRAINT "character_likes_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_submissions" ADD CONSTRAINT "character_submissions_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_templates" ADD CONSTRAINT "character_templates_coverAssetId_fkey" FOREIGN KEY ("coverAssetId") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recent_chats" ADD CONSTRAINT "recent_chats_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recent_chats" ADD CONSTRAINT "recent_chats_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_presets" ADD CONSTRAINT "generation_presets_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_referenceSetRevisionId_fkey" FOREIGN KEY ("referenceSetRevisionId") REFERENCES "reference_set_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_lookId_fkey" FOREIGN KEY ("lookId") REFERENCES "character_looks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_derivedFromJobId_fkey" FOREIGN KEY ("derivedFromJobId") REFERENCES "generation_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_job_events" ADD CONSTRAINT "generation_job_events_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "generation_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_feedback" ADD CONSTRAINT "generation_feedback_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_feedback" ADD CONSTRAINT "generation_feedback_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_feedback" ADD CONSTRAINT "generation_feedback_generationJobId_fkey" FOREIGN KEY ("generationJobId") REFERENCES "generation_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_feedback" ADD CONSTRAINT "generation_feedback_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "generation_feedback"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_sourceJobId_fkey" FOREIGN KEY ("sourceJobId") REFERENCES "generation_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_production_batches" ADD CONSTRAINT "content_production_batches_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_production_items" ADD CONSTRAINT "content_production_items_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "content_production_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_production_items" ADD CONSTRAINT "content_production_items_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "generation_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_production_items" ADD CONSTRAINT "content_production_items_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_asset_placements" ADD CONSTRAINT "media_asset_placements_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_asset_placements" ADD CONSTRAINT "media_asset_placements_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_likes" ADD CONSTRAINT "media_likes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_likes" ADD CONSTRAINT "media_likes_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_collections" ADD CONSTRAINT "media_collections_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_collection_items" ADD CONSTRAINT "media_collection_items_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "media_collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_collection_items" ADD CONSTRAINT "media_collection_items_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dreamcoin_ledger" ADD CONSTRAINT "dreamcoin_ledger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_reports" ADD CONSTRAINT "content_reports_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation_reviews" ADD CONSTRAINT "moderation_reviews_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "content_reports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_feedback_items" ADD CONSTRAINT "product_feedback_items_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_feedback_votes" ADD CONSTRAINT "product_feedback_votes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_feedback_votes" ADD CONSTRAINT "product_feedback_votes_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "product_feedback_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redeem_code_redemptions" ADD CONSTRAINT "redeem_code_redemptions_redeemCodeId_fkey" FOREIGN KEY ("redeemCodeId") REFERENCES "redeem_codes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redeem_code_redemptions" ADD CONSTRAINT "redeem_code_redemptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_inviteeId_fkey" FOREIGN KEY ("inviteeId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follows" ADD CONSTRAINT "follows_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follows" ADD CONSTRAINT "follows_followeeId_fkey" FOREIGN KEY ("followeeId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
