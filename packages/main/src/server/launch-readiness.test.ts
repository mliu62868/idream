import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAIN_TO_CHAT_EVENTS } from "@idream/shared/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  assessLaunchReadiness as assessLaunchReadinessRaw,
  formatLaunchReadinessReport,
  loadLaunchReadinessEnv,
  parseLaunchReadinessCliArgs,
  type LaunchReadinessReport,
} from "./launch-readiness";
import { inspectMainToChatFailedBacklog } from "./readiness/main-to-chat-backlog-authority";
import type {
  AgeVerificationProbeEvidence,
  BlobStorageProbeEvidence,
  ChatModelProbeEvidence,
  ChatServiceProbeEvidence,
  GenerationPersistenceProbeEvidence,
  ImagePipelineProbeEvidence,
  PaymentProviderProbeEvidence,
  ProductConfigProbeEvidence,
  PublicCatalogProbeEvidence,
  SafetyGatewayProbeEvidence,
  SentryCanaryProbeEvidence,
  SentryCanaryService,
  VideoGenerationProbeEvidence,
  VoiceModelProbeEvidence,
  WebSurfaceProbeEvidence,
} from "./readiness/evidence";

const now = new Date("2026-06-25T00:00:00.000Z");
const externalModerationServiceUrl = "https://moderation.ourdream.internal";
const externalModerationApiKey = "production-moderation-token-0123456789";
const externalModerationProbeReport = ".tmp/launch-safety-probe.json";

const productionEnv = {
  APP_ENV: "production",
  BETTER_AUTH_URL: "https://ourdream.ai",
  MAIN_WEB_URL: "https://ourdream.ai",
  ADMIN_WEB_URL: "https://admin.ourdream.ai",
  DATABASE_URL: "postgresql://app:secret@db.ourdream.internal:5432/idream",
  BETTER_AUTH_SECRET: "production-auth-secret-0123456789abcdef",
  INTERNAL_TOKEN: "production-internal-token-0123456789",
  CRON_SECRET: "production-cron-token-0123456789",
  REDIS_URL: "redis://redis.ourdream.internal:6379/0",
  BULLMQ_PREFIX: "idream:prod",
  CHAT_PROVIDER: "pipeline",
  CHAT_DATABASE_URL:
    "postgresql://chat_service:secret@db.ourdream.internal:5432/idream",
  CHAT_FS_ROOT: "/var/lib/idream/chat",
  CHAT_MODEL_PROVIDER: "pipeline",
  CHAT_MODEL_BASE_URL: "https://pipeline.ourdream.internal",
  CHAT_MODEL_NAME: "chat-default",
  CHAT_MODEL_API_KEY: "production-pipeline-token-0123456789",
  CHAT_MODEL_PROBE_REPORT: ".tmp/launch-chat-probe.json",
  CHAT_MODERATION_PROVIDER: "mock",
  VOICE_PROVIDER: "pipeline",
  MODERATION_PROVIDER: "mock",
  PAYMENT_PROVIDER: "btcpay",
  BLOB_PROVIDER: "r2",
  AGE_VERIFICATION_PROVIDER: "gocam",
  CHAT_SERVICE_URL: "https://chat.ourdream.internal",
  CHAT_BFF_SIGNING_SECRET: "production-chat-bff-secret-0123456789",
  ADMIN_BFF_SIGNING_SECRET: "production-admin-bff-secret-0123456789",
  CHAT_SERVICE_PROBE_REPORT: ".tmp/launch-chat-service-probe.json",
  PRODUCT_CONFIG_PROBE_REPORT: ".tmp/launch-product-config-probe.json",
  PUBLIC_CATALOG_PROBE_REPORT: ".tmp/public-catalog-probe.json",
  WEB_SURFACE_PROBE_REPORT: ".tmp/launch-web-surface-probe.json",
  GEN_IMAGE_PROVIDER: "pipeline",
  GEN_VIDEO_PROVIDER: "backend",
  PIPELINE_API_URL: "https://pipeline.ourdream.internal",
  PIPELINE_VOICE_API_URL: "https://voice.ourdream.internal/v1",
  PIPELINE_API_TOKEN: "production-pipeline-token-0123456789",
  PIPELINE_VOICE_API_TOKEN: "production-voice-token-0123456789",
  PIPELINE_IMAGE_MODEL_DEFAULT: "pornmaster-zimage-turbo",
  PIPELINE_VOICE_MODEL_DEFAULT: "voice-default",
  PIPELINE_VIDEO_MODEL_DEFAULT: "video-default",
  COMFYUI_API_URL: "https://comfyui-video.ourdream.internal",
  PIPELINE_IMAGE_PROBE_REPORT: ".tmp/launch-image-probe.json",
  VIDEO_GENERATION_PROBE_REPORT: ".tmp/launch-video-probe.json",
  GENERATION_IMAGE_PERSISTENCE_PROBE_REPORT:
    ".tmp/launch-image-persistence-probe.json",
  GENERATION_VIDEO_PERSISTENCE_PROBE_REPORT:
    ".tmp/launch-video-persistence-probe.json",
  VOICE_MODEL_PROBE_REPORT: ".tmp/launch-voice-probe.json",
  BLOB_STORAGE_PROBE_REPORT: ".tmp/launch-blob-probe.json",
  BTCPAY_BASE_URL: "https://btcpay.ourdream.ai",
  BTCPAY_STORE_ID: "store-1",
  BTCPAY_API_KEY: "btcpay-api-key",
  BTCPAY_WEBHOOK_SECRET: "btcpay-webhook-secret",
  PAYMENT_PROVIDER_PROBE_REPORT: ".tmp/launch-payment-probe.json",
  AGE_VERIFY_SERVICE_URL: "https://age.ourdream.internal",
  AGE_VERIFY_API_KEY: "production-age-token-0123456789",
  AGE_VERIFY_WEBHOOK_SECRET: "production-age-webhook-secret-0123456789",
  AGE_VERIFY_LINK_BACK_URL: "https://ourdream.ai/age-verification/return",
  AGE_VERIFY_CALLBACK_URL:
    "https://ourdream.ai/api/v1/age-verification/webhooks/gocam",
  AGE_VERIFICATION_PROBE_REPORT: ".tmp/launch-age-probe.json",
  BLOB_BUCKET: "idream-private-media",
  BLOB_ENDPOINT: "https://a1b2c3d4e5f6.r2.cloudflarestorage.com",
  BLOB_ACCESS_KEY_ID: "blob-access-key",
  BLOB_SECRET_ACCESS_KEY: "blob-secret-key",
  SENTRY_DSN: "https://public@o123456.ingest.sentry.io/987654",
  SENTRY_RELEASE: "idream@0123456789abcdef",
  NEXT_PUBLIC_SENTRY_DSN: "https://public@o123456.ingest.sentry.io/987654",
  NEXT_PUBLIC_APP_ENV: "production",
  SENTRY_MAIN_PROBE_REPORT: ".tmp/launch-sentry-main-probe.json",
  SENTRY_MAIN_PROBE_MAX_AGE_MINUTES: "1440",
  SENTRY_ADMIN_PROBE_REPORT: ".tmp/launch-sentry-admin-probe.json",
  SENTRY_ADMIN_PROBE_MAX_AGE_MINUTES: "1440",
  SENTRY_CHAT_PROBE_REPORT: ".tmp/launch-sentry-chat-probe.json",
  SENTRY_CHAT_PROBE_MAX_AGE_MINUTES: "1440",
  SENTRY_GEN_PROBE_REPORT: ".tmp/launch-sentry-gen-probe.json",
  SENTRY_GEN_PROBE_MAX_AGE_MINUTES: "1440",
} satisfies Record<string, string>;

const externalModerationEnv = {
  ...productionEnv,
  CHAT_MODERATION_PROVIDER: "safety-gateway",
  MODERATION_PROVIDER: "safety-gateway",
  CHAT_MODERATION_SERVICE_URL: externalModerationServiceUrl,
  CHAT_MODERATION_API_KEY: externalModerationApiKey,
  MODERATION_SERVICE_URL: externalModerationServiceUrl,
  MODERATION_API_KEY: externalModerationApiKey,
  SAFETY_GATEWAY_PROBE_REPORT: externalModerationProbeReport,
} satisfies Record<string, string>;

function passingImageProbe(
  override: Partial<ImagePipelineProbeEvidence> = {},
): ImagePipelineProbeEvidence {
  return {
    ok: true,
    checkedAt: "2026-06-24T23:55:00.000Z",
    durationMs: 12_345,
    provider: "pipeline",
    pipelineUrl: productionEnv.PIPELINE_API_URL,
    model: productionEnv.PIPELINE_IMAGE_MODEL_DEFAULT,
    orientation: "1:1",
    count: 1,
    blobRoot: "/var/lib/idream/blob",
    generationJobId: "probe_123",
    backendKind: null,
    backendTarget: null,
    workflowKey: null,
    workflowVersion: null,
    blobAuthority: {
      provider: productionEnv.BLOB_PROVIDER,
      endpoint: productionEnv.BLOB_ENDPOINT,
      bucket: productionEnv.BLOB_BUCKET,
      root: null,
    },
    terminal: {
      ref: "gen/terminal-records/attempt_probe/terminal.json",
      checksum: "a".repeat(64),
      outcome: "succeeded",
      assets: 1,
      error: null,
    },
    ...override,
  };
}

function passingBackendImageProbe(
  override: Partial<ImagePipelineProbeEvidence> = {},
): ImagePipelineProbeEvidence {
  return passingImageProbe({
    provider: "backend",
    pipelineUrl: null,
    backendKind: "comfyui",
    backendTarget: "https://comfyui.ourdream.internal",
    model: "redcraft-krea2-redmix3-txt2img",
    workflowKey: "redcraft-krea2-redmix3-txt2img",
    workflowVersion: 1,
    ...override,
  });
}

function passingVideoProbe(
  override: Partial<VideoGenerationProbeEvidence> = {},
): VideoGenerationProbeEvidence {
  return {
    ok: true,
    checkedAt: "2026-06-24T23:55:30.000Z",
    durationMs: 620_000,
    provider: "backend",
    backendKind: "comfyui",
    backendTarget: productionEnv.COMFYUI_API_URL,
    workflowKey: "ltx23-gtanimation-i2v",
    workflowVersion: 1,
    model: "ltx23-gtanimation-i2v",
    seconds: 4,
    referenceSha256: "c".repeat(64),
    generationJobId: "probe_video_123",
    blobAuthority: {
      provider: productionEnv.BLOB_PROVIDER,
      endpoint: productionEnv.BLOB_ENDPOINT,
      bucket: productionEnv.BLOB_BUCKET,
      root: null,
    },
    terminal: {
      ref: "gen/terminal-records/attempt_video_probe/terminal.json",
      checksum: "d".repeat(64),
      outcome: "succeeded",
      assets: 1,
      error: null,
    },
    ...override,
  };
}

function passingGenerationPersistenceProbe(
  mode: "image" | "video",
  override: Partial<GenerationPersistenceProbeEvidence> = {},
): GenerationPersistenceProbeEvidence {
  const isVideo = mode === "video";
  return {
    ok: true,
    checkedAt: isVideo
      ? "2026-06-24T23:58:30.000Z"
      : "2026-06-24T23:58:00.000Z",
    observedAt: isVideo
      ? "2026-06-24T23:58:00.000Z"
      : "2026-06-24T23:57:30.000Z",
    mode,
    generationJobId: isVideo ? "job_video_123" : "job_image_123",
    attemptId: isVideo ? "attempt_video_123" : "attempt_image_123",
    attemptNo: 1,
    jobStatus: "completed",
    attemptStatus: "succeeded",
    provider: "backend",
    profileKey: isVideo ? "video-default" : "image-premium",
    profileVersion: 1,
    workflowKey: isVideo
      ? "ltx23-gtanimation-i2v"
      : "redcraft-krea2-redmix3-txt2img",
    workflowVersion: 1,
    terminal: {
      ref: isVideo
        ? "gen/terminal-records/attempt_video_123/terminal.json"
        : "gen/terminal-records/attempt_image_123/terminal.json",
      checksum: (isVideo ? "d" : "a").repeat(64),
      receiptId: isVideo ? "receipt_video_123" : "receipt_image_123",
      receiptState: "processed",
      outboxState: "delivered",
      transportCount: 1,
      transportStatus: "succeeded",
      artifactCount: 1,
      deliveredCount: 1,
      mediaAssetCount: 1,
    },
    error: null,
    ...override,
  };
}

function passingBlobProbe(
  override: Partial<BlobStorageProbeEvidence> = {},
): BlobStorageProbeEvidence {
  return {
    ok: true,
    checkedAt: "2026-06-24T23:56:00.000Z",
    durationMs: 1_234,
    provider: productionEnv.BLOB_PROVIDER,
    endpoint: productionEnv.BLOB_ENDPOINT,
    bucket: productionEnv.BLOB_BUCKET,
    key: "launch-probes/probe.txt",
    bytes: 96,
    put: { ok: true, size: 96, error: null },
    signedGetUrl: {
      ok: true,
      host: "a1b2c3d4e5f6.r2.cloudflarestorage.com",
      pathname: "/idream-private-media/launch-probes/probe.txt",
      expiresInSeconds: 60,
      error: null,
    },
    readback: {
      ok: true,
      source: "signed-url",
      status: 200,
      bytes: 96,
      matches: true,
      sha256: "abc123",
      error: null,
    },
    delete: { ok: true, error: null },
    ...override,
  };
}

function passingSafetyProbe(
  override: Partial<SafetyGatewayProbeEvidence> = {},
): SafetyGatewayProbeEvidence {
  return {
    ok: true,
    checkedAt: "2026-06-24T23:57:00.000Z",
    durationMs: 456,
    provider: productionEnv.MODERATION_PROVIDER,
    serviceUrl: externalModerationServiceUrl,
    targetType: "text",
    status: "passed",
    policyCode: null,
    confidence: 0.42,
    error: null,
    ...override,
  };
}

function passingChatServiceProbe(
  override: Partial<ChatServiceProbeEvidence> = {},
): ChatServiceProbeEvidence {
  return {
    ok: true,
    checkedAt: "2026-06-24T23:57:30.000Z",
    durationMs: 234,
    serviceUrl: productionEnv.CHAT_SERVICE_URL,
    userId: "seed-chat-probe-user",
    actorDataClass: "audit",
    dedicatedActor: true,
    usedSignedBff: true,
    health: {
      ok: true,
      status: 200,
      service: "chat",
      error: null,
    },
    signedRequest: {
      ok: true,
      status: 200,
      sessionsCount: 0,
      error: null,
    },
    unsignedRequest: {
      ok: true,
      status: 401,
      error: null,
    },
    conversation: {
      ok: true,
      attempted: true,
      preflightCleanup: { ok: true, status: 200, error: null },
      createSession: { ok: true, status: 201, error: null },
      sendMessage: { ok: true, status: 202, error: null },
      stream: {
        ok: true,
        status: 200,
        sawStart: true,
        sawDelta: true,
        sawDone: true,
        error: null,
      },
      getSession: {
        ok: true,
        status: 200,
        assistantMessageId: "msg_probe_assistant",
        assistantSent: true,
        assistantStatus: "sent",
        derivationSettled: true,
        error: null,
      },
      regenerateAnchor: {
        ok: true,
        status: 202,
        assistantMessageId: "msg_probe_assistant",
        originalAttempt: 1,
        regeneratedAttempt: 2,
        originalSceneVersion: 0,
        futureUserSceneVersion: 1,
        futureSceneVersion: 1,
        regeneratedSceneVersion: 0,
        error: null,
      },
      noMemory: {
        ok: true,
        status: 202,
        assistantMessageId: "msg_probe_no_memory_assistant",
        authorityPinned: true,
        relationshipUnchanged: true,
        memorySourceAbsent: true,
        error: null,
      },
      blockedInput: {
        ok: true,
        status: 202,
        status_: "blocked",
        error: null,
      },
      cleanup: {
        ok: true,
        status: 404,
        memoryGone: true,
        memoriesDeleted: 0,
        relationshipDeleted: true,
        relationshipsDeleted: 1,
        relationshipsGone: true,
        sessionDeleted: true,
        sessionGone: true,
        error: null,
      },
      error: null,
    },
    error: null,
    ...override,
  };
}

function passingChatProbe(
  override: Partial<ChatModelProbeEvidence> = {},
): ChatModelProbeEvidence {
  return {
    ok: true,
    checkedAt: "2026-06-24T23:58:00.000Z",
    durationMs: 789,
    provider: productionEnv.CHAT_MODEL_PROVIDER,
    baseUrl: productionEnv.CHAT_MODEL_BASE_URL,
    model: productionEnv.CHAT_MODEL_NAME,
    chunks: 1,
    characters: 24,
    assistantPreview: "Launch readiness acknowledged.",
    done: true,
    error: null,
    ...override,
  };
}

function passingVoiceProbe(
  override: Partial<VoiceModelProbeEvidence> = {},
): VoiceModelProbeEvidence {
  return {
    ok: true,
    checkedAt: "2026-06-24T23:58:30.000Z",
    durationMs: 1_111,
    provider: productionEnv.VOICE_PROVIDER,
    baseUrl: productionEnv.PIPELINE_VOICE_API_URL,
    model: productionEnv.PIPELINE_VOICE_MODEL_DEFAULT,
    voiceId: "default",
    key: "voice/probe.mp3",
    audioDurationMs: 1_234,
    bytes: 2048,
    contentType: "audio/mpeg",
    error: null,
    ...override,
  };
}

function passingProductConfigProbe(
  override: Partial<ProductConfigProbeEvidence> = {},
): ProductConfigProbeEvidence {
  return {
    ok: true,
    checkedAt: "2026-06-24T23:58:45.000Z",
    durationMs: 222,
    videoFeatureEnabled: false,
    activeImageProfiles: 1,
    activeImageExecutionBindings: [
      {
        profileId: "profile-image-pipeline-v1",
        runner: "pipeline",
        model: productionEnv.PIPELINE_IMAGE_MODEL_DEFAULT,
        workflowKey: null,
        workflowVersion: null,
      },
    ],
    invalidActiveImageProfileIds: [],
    activeImageCharacterTemplates: 1,
    activeImageFreeplayTemplates: 1,
    activeImagePricingRules: 1,
    activeVideoProfiles: 0,
    activeVideoCharacterTemplates: 0,
    activeVideoFreeplayTemplates: 0,
    activeVideoPricingRules: 0,
    activeVoicePricingRules: 1,
    publicCharacters: 16,
    publicCharactersWithSystemPrompt: 16,
    error: null,
    ...override,
  };
}

function passingBackendProductConfigProbe(
  override: Partial<ProductConfigProbeEvidence> = {},
): ProductConfigProbeEvidence {
  return passingProductConfigProbe({
    activeImageExecutionBindings: [
      {
        profileId: "profile-image-backend-v1",
        runner: "comfyui",
        model: "redcraft-krea2-redmix3-txt2img",
        workflowKey: "redcraft-krea2-redmix3-txt2img",
        workflowVersion: 1,
      },
    ],
    ...override,
  });
}

function passingWebSurfaceProbe(
  override: Partial<WebSurfaceProbeEvidence> = {},
): WebSurfaceProbeEvidence {
  return {
    ok: true,
    checkedAt: "2026-06-24T23:59:15.000Z",
    durationMs: 345,
    mainUrl: productionEnv.MAIN_WEB_URL,
    adminUrl: productionEnv.ADMIN_WEB_URL,
    home: {
      ok: true,
      status: 200,
      bytes: 30_000,
      contentType: "text/html; charset=utf-8",
      containsBrand: true,
      nextErrorShell: false,
      assets: { ok: true, checked: 8, failures: [] },
      error: null,
    },
    generate: {
      ok: true,
      status: 200,
      bytes: 30_000,
      contentType: "text/html; charset=utf-8",
      containsGenerator: true,
      nextErrorShell: false,
      assets: { ok: true, checked: 8, failures: [] },
      error: null,
    },
    apiAgeGate: {
      ok: true,
      status: 403,
      code: "forbidden",
      reason: "age_gate_required",
      error: null,
    },
    admin: {
      ok: true,
      status: 200,
      bytes: 8_000,
      contentType: "text/html; charset=utf-8",
      protected: true,
      protectedReason: "access_denied",
      nextErrorShell: false,
      assets: { ok: true, checked: 8, failures: [] },
      error: null,
    },
    adminApi: {
      ok: true,
      status: 401,
      code: "unauthorized",
      error: null,
    },
    error: null,
    ...override,
  };
}

function passingPublicCatalogProbe(
  override: Partial<PublicCatalogProbeEvidence> = {},
): PublicCatalogProbeEvidence {
  return {
    ok: true,
    checkedAt: "2026-06-24T23:59:00.000Z",
    durationMs: 111,
    counts: {
      publicCharacters: 16,
      publicCollections: 3,
      publicCreators: 13,
      publicFeedbackItems: 3,
      distinctImages: 16,
    },
    issueTotals: {
      total: 0,
      fail: 0,
      warn: 0,
    },
    error: null,
    ...override,
  };
}

function passingPaymentProbe(
  override: Partial<PaymentProviderProbeEvidence> = {},
): PaymentProviderProbeEvidence {
  return {
    ok: true,
    checkedAt: "2026-06-24T23:59:00.000Z",
    durationMs: 321,
    provider: productionEnv.PAYMENT_PROVIDER,
    baseUrl: productionEnv.BTCPAY_BASE_URL,
    storeId: productionEnv.BTCPAY_STORE_ID,
    canViewStore: true,
    returnedStoreId: productionEnv.BTCPAY_STORE_ID,
    canLookupInvoice: true,
    canCreateInvoice: true,
    invoiceId: "btcpay-probe-invoice-1",
    checkoutUrl: "https://btcpay.ourdream.ai/i/btcpay-probe-invoice-1",
    invoiceAmountCents: 1,
    invoiceCurrency: "USD",
    terminal: {
      authorityVersion: "payment_product_settlement_v1",
      checkoutId: "checkout-probe-1",
      checkoutStatus: "completed",
      checkoutReturnPath: "/generate",
      providerInvoiceId: "btcpay-probe-invoice-1",
      providerInvoiceStatus: "settled",
      providerInvoiceAdditionalStatus: "none",
      providerLookupVerified: true,
      providerEventId: "btcpay-event-1",
      providerEventType: "invoice.confirmed",
      providerEventProcessedAt: "2026-06-24T23:58:30.000Z",
      providerEventTargetHash: "a".repeat(64),
      providerDeliveryCount: 2,
      providerDeliveryIds: ["btcpay-delivery-1", "btcpay-delivery-2"],
      providerDeliveryPayloadHashes: ["d".repeat(64), "e".repeat(64)],
      replayVerified: true,
      subscriptionId: "subscription-probe-1",
      subscriptionStatus: "active",
      subscriptionEffectCount: 1,
      entitlementCount: 3,
      ledgerEntryId: "ledger-probe-1",
      ledgerEntryCount: 1,
    },
    error: null,
    ...override,
  };
}

function passingAgeProbe(
  override: Partial<AgeVerificationProbeEvidence> = {},
): AgeVerificationProbeEvidence {
  return {
    ok: true,
    checkedAt: "2026-06-24T23:59:30.000Z",
    durationMs: 654,
    provider: productionEnv.AGE_VERIFICATION_PROVIDER,
    serviceUrl: productionEnv.AGE_VERIFY_SERVICE_URL,
    jurisdiction: "US",
    providerVerificationId: "gocam-session-1",
    status: "verified",
    url: "https://go.cam/verify/session-1",
    terminal: {
      authorityVersion: "age_verified_callback_v1",
      verificationId: "age-verification-probe-1",
      verificationStatus: "verified",
      verifiedAt: "2026-06-24T23:59:20.000Z",
      callbackUrl: productionEnv.AGE_VERIFY_CALLBACK_URL,
      linkBackUrl: productionEnv.AGE_VERIFY_LINK_BACK_URL,
      providerEventId: "gocam-event-1",
      providerEventType: "age.verification",
      providerEventProcessedAt: "2026-06-24T23:59:20.000Z",
      providerEventTargetHash: "b".repeat(64),
      providerDeliveryCount: 2,
      providerDeliveryIds: ["gocam-delivery-1", "gocam-delivery-2"],
      providerDeliveryPayloadHashes: ["f".repeat(64), "f".repeat(64)],
      providerPayloadHash: "c".repeat(64),
      verificationEffectCount: 1,
      replayVerified: true,
    },
    error: null,
    ...override,
  };
}

function passingSentryProbe(
  service: SentryCanaryService = "main",
  override: Partial<SentryCanaryProbeEvidence> = {},
): SentryCanaryProbeEvidence {
  return {
    ok: true,
    checkedAt: "2026-06-24T23:59:00.000Z",
    durationMs: 321,
    provider: "sentry",
    service,
    emitter:
      service === "main"
        ? "main-nextjs"
        : service === "admin"
          ? "admin-nextjs"
          : service === "chat"
            ? "chat-node"
            : "gen-node",
    release: "idream@0123456789abcdef",
    correlationId: "sentry-canary-123",
    eventId: "0123456789abcdef0123456789abcdef",
    projectId: "987654",
    verified: true,
    verifiedAt: "2026-06-24T23:59:01.000Z",
    error: null,
    ...override,
  };
}

function passingSentryProbes() {
  return {
    sentryMainCanaryProbe: passingSentryProbe("main"),
    sentryAdminCanaryProbe: passingSentryProbe("admin"),
    sentryChatCanaryProbe: passingSentryProbe("chat"),
    sentryGenCanaryProbe: passingSentryProbe("gen"),
  };
}

function assessLaunchReadiness(
  options: Parameters<typeof assessLaunchReadinessRaw>[0] = {},
) {
  return assessLaunchReadinessRaw({
    imageGenerationPersistenceProbe:
      passingGenerationPersistenceProbe("image"),
    videoGenerationPersistenceProbe:
      passingGenerationPersistenceProbe("video"),
    ...options,
  });
}

function failedIds(report: LaunchReadinessReport) {
  return report.checks
    .filter((check) => check.status === "fail")
    .map((check) => check.id);
}

function checkById(report: LaunchReadinessReport, id: string) {
  return report.checks.find((check) => check.id === id);
}

function envTemplateValues(relativePath: string) {
  const content = readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf8",
  );
  return Object.fromEntries(
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)] as const;
      }),
  );
}

function dotenvContent(values: Record<string, string>) {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

describe("launch readiness", () => {
  it("does not treat a configured Sentry DSN as live observability evidence", () => {
    const report = assessLaunchReadiness({
      env: {
        APP_ENV: "production",
        SENTRY_DSN: "https://public@o123456.ingest.sentry.io/987654",
        SENTRY_MAIN_PROBE_REPORT: ".tmp/launch-sentry-main-probe.json",
        SENTRY_ADMIN_PROBE_REPORT: ".tmp/launch-sentry-admin-probe.json",
        SENTRY_CHAT_PROBE_REPORT: ".tmp/launch-sentry-chat-probe.json",
        SENTRY_GEN_PROBE_REPORT: ".tmp/launch-sentry-gen-probe.json",
      },
      now,
      sentryMainCanaryProbe: null,
      sentryAdminCanaryProbe: null,
      sentryChatCanaryProbe: null,
      sentryGenCanaryProbe: null,
    });

    expect(
      report.checks.find((check) => check.id === "sentry-dsn")?.status,
    ).toBe("pass");
    expect(
      report.checks.find((check) => check.id === "sentry-live-probe"),
    ).toMatchObject({
      status: "fail",
    });
  });

  it("requires an explicit production marker for browser Sentry", () => {
    const report = assessLaunchReadiness({
      env: {
        APP_ENV: "production",
        SENTRY_DSN: "https://public@o123456.ingest.sentry.io/987654",
        NEXT_PUBLIC_SENTRY_DSN:
          "https://public@o123456.ingest.sentry.io/987654",
      },
      now,
      sentryMainCanaryProbe: null,
      sentryAdminCanaryProbe: null,
      sentryChatCanaryProbe: null,
      sentryGenCanaryProbe: null,
    });

    expect(
      report.checks.find((check) => check.id === "sentry-browser-app-env"),
    ).toMatchObject({
      status: "fail",
    });
  });

  it("accepts fresh correlation-tagged Sentry canaries from all four runtimes", () => {
    const probe: SentryCanaryProbeEvidence = {
      ok: true,
      checkedAt: "2026-06-24T23:59:00.000Z",
      durationMs: 321,
      provider: "sentry",
      service: "main",
      emitter: "main-nextjs",
      release: "idream@0123456789abcdef",
      correlationId: "sentry-canary-123",
      eventId: "0123456789abcdef0123456789abcdef",
      projectId: "987654",
      verified: true,
      verifiedAt: "2026-06-24T23:59:01.000Z",
      error: null,
    };
    const report = assessLaunchReadiness({
      env: {
        APP_ENV: "production",
        SENTRY_DSN: "https://public@o123456.ingest.sentry.io/987654",
        SENTRY_RELEASE: "idream@0123456789abcdef",
        SENTRY_MAIN_PROBE_REPORT: ".tmp/launch-sentry-main-probe.json",
        SENTRY_ADMIN_PROBE_REPORT: ".tmp/launch-sentry-admin-probe.json",
        SENTRY_CHAT_PROBE_REPORT: ".tmp/launch-sentry-chat-probe.json",
        SENTRY_GEN_PROBE_REPORT: ".tmp/launch-sentry-gen-probe.json",
      },
      now,
      ...passingSentryProbes(),
      sentryMainCanaryProbe: probe,
    });

    expect(
      report.checks.find((check) => check.id === "sentry-live-probe"),
    ).toMatchObject({
      status: "pass",
    });
  });

  it.each([
    ["main", "sentryMainCanaryProbe"],
    ["admin", "sentryAdminCanaryProbe"],
    ["chat", "sentryChatCanaryProbe"],
    ["gen", "sentryGenCanaryProbe"],
  ] as const)(
    "rejects a missing %s runtime Sentry canary",
    (service, probeName) => {
      const report = assessLaunchReadiness({
        env: productionEnv,
        now,
        ...passingSentryProbes(),
        [probeName]: null,
      });

      expect(checkById(report, "sentry-live-probe")).toMatchObject({
        status: "fail",
      });
      expect(checkById(report, "sentry-live-probe")?.message).toContain(
        `${service} runtime report`,
      );
    },
  );

  it.each([
    ["main", "sentryMainCanaryProbe"],
    ["admin", "sentryAdminCanaryProbe"],
    ["chat", "sentryChatCanaryProbe"],
    ["gen", "sentryGenCanaryProbe"],
  ] as const)(
    "rejects a legacy %s Sentry report that does not prove its runtime emitter",
    (service, probeName) => {
      const report = assessLaunchReadiness({
        env: productionEnv,
        now,
        ...passingSentryProbes(),
        [probeName]: {
          ...passingSentryProbe(service),
          emitter: undefined,
        },
      });

      expect(checkById(report, "sentry-live-probe")).toMatchObject({
        status: "fail",
      });
      expect(checkById(report, "sentry-live-probe")?.message).toContain(
        `${service} runtime emitter`,
      );
    },
  );

  it.each([
    ["main", "sentryMainCanaryProbe", "admin"],
    ["admin", "sentryAdminCanaryProbe", "chat"],
    ["chat", "sentryChatCanaryProbe", "gen"],
    ["gen", "sentryGenCanaryProbe", "main"],
  ] as const)(
    "rejects a %s runtime report labeled as another service",
    (service, probeName, wrongService) => {
      const report = assessLaunchReadiness({
        env: productionEnv,
        now,
        ...passingSentryProbes(),
        [probeName]: passingSentryProbe(wrongService),
      });

      expect(checkById(report, "sentry-live-probe")).toMatchObject({
        status: "fail",
      });
      expect(checkById(report, "sentry-live-probe")?.message).toContain(
        `${service} runtime report service is not ${service}`,
      );
    },
  );

  it.each([
    ["main", "sentryMainCanaryProbe"],
    ["admin", "sentryAdminCanaryProbe"],
    ["chat", "sentryChatCanaryProbe"],
    ["gen", "sentryGenCanaryProbe"],
  ] as const)(
    "rejects a stale %s runtime Sentry canary",
    (service, probeName) => {
      const report = assessLaunchReadiness({
        env: productionEnv,
        now,
        ...passingSentryProbes(),
        [probeName]: passingSentryProbe(service, {
          checkedAt: "2026-06-20T00:00:00.000Z",
          verifiedAt: "2026-06-20T00:00:01.000Z",
        }),
      });

      expect(checkById(report, "sentry-live-probe")).toMatchObject({
        status: "fail",
      });
      expect(checkById(report, "sentry-live-probe")?.message).toContain(
        `${service} runtime probe is older`,
      );
    },
  );

  it("fails closed for an empty or local-development environment", () => {
    const report = assessLaunchReadiness({ env: {}, now });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toEqual(
      expect.arrayContaining([
        "app-env-production",
        "database-url",
        "web-surface-live-probe",
        "chat-provider-non-mock",
        "chat-service-live-probe",
        "chat-model-live-probe",
        "voice-model-live-probe",
        "gen-image-provider",
        "pipeline-image-live-probe",
        "product-config-live-probe",
        "public-catalog-live-probe",
        "blob-bucket",
        "age-verification-live-probe",
        "blob-storage-live-probe",
        "payment-provider-live-probe",
        "sentry-dsn",
      ]),
    );
    expect(report.checks.map((check) => check.id)).not.toContain(
      "pipeline-api-url",
    );
    expect(report.checks.map((check) => check.id)).not.toContain(
      "pipeline-api-token",
    );
    expect(report.checks.map((check) => check.id)).not.toContain(
      "pipeline-image-model",
    );
  });

  it("does not require legacy pipeline credentials for a mock image provider", () => {
    const report = assessLaunchReadiness({
      env: {
        ...productionEnv,
        GEN_IMAGE_PROVIDER: "mock",
        PIPELINE_API_URL: "",
        PIPELINE_API_TOKEN: "",
        PIPELINE_IMAGE_MODEL_DEFAULT: "",
      },
      imagePipelineProbe: null,
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(checkById(report, "gen-image-provider")?.status).toBe("fail");
    expect(report.checks.map((check) => check.id)).not.toContain(
      "pipeline-api-url",
    );
    expect(report.checks.map((check) => check.id)).not.toContain(
      "pipeline-api-token",
    );
    expect(report.checks.map((check) => check.id)).not.toContain(
      "pipeline-image-model",
    );
  });

  it("separates configured provider env from code implementation readiness", () => {
    const report = assessLaunchReadiness({
      env: { ...productionEnv, AGE_VERIFICATION_PROVIDER: "persona" },
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toEqual(
      expect.arrayContaining(["age-verification-provider-implementation"]),
    );
    expect(failedIds(report)).not.toContain("chat-provider-non-mock");
    expect(failedIds(report)).not.toContain("chat-provider-implementation");
    expect(failedIds(report)).not.toContain("voice-provider-implementation");
    expect(failedIds(report)).not.toContain("payment-provider-implementation");
    expect(failedIds(report)).not.toContain(
      "moderation-provider-implementation",
    );
    expect(failedIds(report)).not.toContain("blob-provider-implementation");
    expect(failedIds(report)).not.toContain("gen-image-provider");
  });

  it("fails when production env is configured but the live image probe is missing", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: null,
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("pipeline-image-live-probe");
  });

  it("fails closed when generation reports predate Blob authority evidence", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe({ blobAuthority: undefined }),
      videoGenerationProbe: passingVideoProbe({ blobAuthority: undefined }),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe({
        videoFeatureEnabled: true,
        activeVideoProfiles: 1,
        activeVideoCharacterTemplates: 1,
        activeVideoFreeplayTemplates: 1,
        activeVideoPricingRules: 1,
      }),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(checkById(report, "pipeline-image-live-probe")).toMatchObject({
      status: "fail",
    });
    expect(checkById(report, "video-generation-live-probe")).toMatchObject({
      status: "fail",
    });
    expect(checkById(report, "pipeline-image-live-probe")?.message).toContain(
      "Blob authority",
    );
    expect(checkById(report, "video-generation-live-probe")?.message).toContain(
      "Blob authority",
    );
  });

  it("rejects generation reports bound to a different Blob target", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe({
        blobAuthority: {
          provider: "r2",
          endpoint: "https://different.r2.cloudflarestorage.com",
          bucket: productionEnv.BLOB_BUCKET,
          root: null,
        },
      }),
      videoGenerationProbe: passingVideoProbe({
        blobAuthority: {
          provider: "r2",
          endpoint: productionEnv.BLOB_ENDPOINT,
          bucket: "different-private-media",
          root: null,
        },
      }),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe({
        videoFeatureEnabled: true,
        activeVideoProfiles: 1,
        activeVideoCharacterTemplates: 1,
        activeVideoFreeplayTemplates: 1,
        activeVideoPricingRules: 1,
      }),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(checkById(report, "pipeline-image-live-probe")?.message).toContain(
      "Blob endpoint",
    );
    expect(checkById(report, "video-generation-live-probe")?.message).toContain(
      "Blob bucket",
    );
  });

  it("rejects Gen Blob provider drift even when reports match the Gen override", () => {
    const driftedBlobAuthority = {
      provider: "s3",
      endpoint: productionEnv.BLOB_ENDPOINT,
      bucket: productionEnv.BLOB_BUCKET,
      root: null,
    } as const;
    const report = assessLaunchReadiness({
      env: {
        ...productionEnv,
        GEN_BLOB_PROVIDER: "s3",
      },
      imagePipelineProbe: passingImageProbe({
        blobAuthority: driftedBlobAuthority,
      }),
      videoGenerationProbe: passingVideoProbe({
        blobAuthority: driftedBlobAuthority,
      }),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe({
        videoFeatureEnabled: true,
        activeVideoProfiles: 1,
        activeVideoCharacterTemplates: 1,
        activeVideoFreeplayTemplates: 1,
        activeVideoPricingRules: 1,
      }),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(checkById(report, "pipeline-image-live-probe")?.message).toContain(
      "does not match Main BLOB_PROVIDER",
    );
    expect(checkById(report, "video-generation-live-probe")?.message).toContain(
      "does not match Main BLOB_PROVIDER",
    );
  });

  it("passes the generation image provider check for a backend (ComfyUI) deploy", () => {
    const report = assessLaunchReadiness({
      env: {
        ...productionEnv,
        GEN_IMAGE_PROVIDER: "backend",
        COMFYUI_API_URL: "https://comfyui.ourdream.internal",
      },
      imagePipelineProbe: passingBackendImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingBackendProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(checkById(report, "gen-image-provider")?.status).toBe("pass");
    expect(checkById(report, "comfyui-api-url")?.status).toBe("pass");
    expect(failedIds(report)).not.toContain("gen-image-provider");
    expect(failedIds(report)).not.toContain("comfyui-api-url");
    // A backend deploy skips legacy gateway credentials but still requires a
    // real workflow-bound TerminalRecord probe through the backend adapter.
    expect(failedIds(report)).not.toContain("pipeline-image-live-probe");
    expect(report.checks.map((check) => check.id)).not.toContain(
      "pipeline-api-url",
    );
    expect(report.checks.map((check) => check.id)).not.toContain(
      "pipeline-api-token",
    );
    expect(report.checks.map((check) => check.id)).toContain(
      "pipeline-image-live-probe",
    );
  });

  it("rejects a backend image probe that does not cover the active public binding", () => {
    const report = assessLaunchReadiness({
      env: {
        ...productionEnv,
        GEN_IMAGE_PROVIDER: "backend",
        COMFYUI_API_URL: "https://comfyui.ourdream.internal",
      },
      imagePipelineProbe: passingBackendImageProbe({
        model: "unrelated-model",
        workflowKey: "unrelated-workflow",
        workflowVersion: 9,
      }),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingBackendProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(checkById(report, "pipeline-image-live-probe")?.message).toContain(
      "does not cover active public image profile binding",
    );
  });

  it("rejects a legacy image report without immutable terminal evidence", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe({ terminal: undefined }),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(checkById(report, "pipeline-image-live-probe")?.message).toContain(
      "predates immutable terminal record evidence",
    );
  });

  it("does not treat a Gen provider terminal record as Main persistence evidence", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      productConfigProbe: passingProductConfigProbe(),
      imageGenerationPersistenceProbe: null,
      now,
    });

    expect(checkById(report, "pipeline-image-live-probe")?.status).toBe(
      "pass",
    );
    expect(
      checkById(report, "generation-image-main-persistence")?.status,
    ).toBe("fail");
  });

  it("requires fresh exact Main generation finalization evidence", () => {
    const base = passingGenerationPersistenceProbe("image");
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      productConfigProbe: passingProductConfigProbe(),
      imageGenerationPersistenceProbe: passingGenerationPersistenceProbe(
        "image",
        {
          checkedAt: "2026-06-24T23:59:00.000Z",
          observedAt: "2026-06-23T23:59:00.000Z",
          terminal: { ...base.terminal, deliveredCount: 0 },
        },
      ),
      now,
    });

    expect(
      checkById(report, "generation-image-main-persistence"),
    ).toMatchObject({ status: "fail" });
    expect(
      checkById(report, "generation-image-main-persistence")?.message,
    ).toContain("artifact, delivery, and MediaAsset counts do not match");
  });

  it("fails closed when a backend image deploy has no live generation probe", () => {
    const report = assessLaunchReadiness({
      env: {
        ...productionEnv,
        GEN_IMAGE_PROVIDER: "backend",
        COMFYUI_API_URL: "https://comfyui.ourdream.internal",
      },
      imagePipelineProbe: null,
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("pipeline-image-live-probe");
  });

  it("fails the ComfyUI URL check for a backend deploy missing COMFYUI_API_URL", () => {
    const report = assessLaunchReadiness({
      env: {
        ...productionEnv,
        GEN_IMAGE_PROVIDER: "backend",
        COMFYUI_API_URL: undefined,
      },
      imagePipelineProbe: null,
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(checkById(report, "comfyui-api-url")?.status).toBe("fail");
    expect(failedIds(report)).toContain("comfyui-api-url");
  });

  it("accepts a Draw Things-only backend deploy without requiring ComfyUI", () => {
    const report = assessLaunchReadiness({
      env: {
        ...productionEnv,
        GEN_IMAGE_PROVIDER: "backend",
        GEN_VIDEO_PROVIDER: "mock",
        COMFYUI_API_URL: undefined,
        DRAWTHINGS_CLI: "/opt/drawthings/draw-things-cli",
      },
      imagePipelineProbe: null,
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(checkById(report, "gen-image-provider")?.status).toBe("pass");
    expect(checkById(report, "drawthings-cli")?.status).toBe("pass");
    expect(report.checks.map((check) => check.id)).not.toContain(
      "comfyui-api-url",
    );
  });

  it("requires the split chat service to use its own least-privilege database role", () => {
    const report = assessLaunchReadiness({
      env: {
        ...productionEnv,
        CHAT_DATABASE_URL: productionEnv.DATABASE_URL,
      },
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("chat-database-url");
  });

  it("requires a shared production BullMQ prefix across services", () => {
    const report = assessLaunchReadiness({
      env: {
        ...productionEnv,
        BULLMQ_PREFIX: "idream:gen",
      },
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("bullmq-prefix");
  });

  it("requires Better Auth to use the public production origin", () => {
    const report = assessLaunchReadiness({
      env: {
        ...productionEnv,
        BETTER_AUTH_URL: "http://localhost:3000",
      },
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("better-auth-url");
  });

  it("does not substitute Better Auth for a missing main-site origin", () => {
    const report = assessLaunchReadiness({
      env: {
        ...productionEnv,
        MAIN_WEB_URL: undefined,
      },
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("main-web-url");
    expect(failedIds(report)).toContain("web-surface-live-probe");
  });

  it("does not classify bracketed IPv6 loopback as a public production origin", () => {
    const report = assessLaunchReadiness({
      env: {
        ...productionEnv,
        BETTER_AUTH_URL: "https://[::1]:3000",
      },
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("better-auth-url");
  });

  it("requires the split chat service to use durable file storage", () => {
    const report = assessLaunchReadiness({
      env: {
        ...productionEnv,
        CHAT_FS_ROOT: "./data/chat",
      },
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("chat-fs-root");
  });

  it("requires public age verification return and callback URLs", () => {
    const report = assessLaunchReadiness({
      env: {
        ...productionEnv,
        AGE_VERIFY_LINK_BACK_URL:
          "http://localhost:3000/age-verification/return",
        AGE_VERIFY_CALLBACK_URL: "",
      },
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toEqual(
      expect.arrayContaining([
        "age-verification-link-back-url",
        "age-verification-callback-url",
      ]),
    );
  });

  it("requires packages/chat to use a real model and supported moderation provider", () => {
    const report = assessLaunchReadiness({
      env: {
        ...productionEnv,
        CHAT_MODEL_PROVIDER: "mock",
        CHAT_MODERATION_PROVIDER: "unsupported",
      },
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toEqual(
      expect.arrayContaining([
        "chat-model-provider",
        "chat-moderation-provider",
      ]),
    );
  });

  it("rejects development-looking secrets even when they are long enough", () => {
    const report = assessLaunchReadiness({
      env: {
        ...productionEnv,
        BETTER_AUTH_SECRET: "dev-better-auth-secret-bypass-for-local-check",
        INTERNAL_TOKEN: "development-internal-token-0123456789",
        CRON_SECRET: "local-check-cron-token-0123456789",
      },
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toEqual(
      expect.arrayContaining([
        "better-auth-secret",
        "internal-token",
        "cron-secret",
        "service-token-separation",
      ]),
    );
  });

  it("fails when production template placeholders are copied unchanged", () => {
    const templateEnv = envTemplateValues("../../.env.production.example");
    const report = assessLaunchReadiness({
      env: templateEnv,
      imagePipelineProbe: passingImageProbe({
        pipelineUrl: templateEnv.PIPELINE_API_URL,
        model: templateEnv.PIPELINE_IMAGE_MODEL_DEFAULT,
      }),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe({
        provider: templateEnv.BLOB_PROVIDER,
        endpoint: templateEnv.BLOB_ENDPOINT,
        bucket: templateEnv.BLOB_BUCKET,
      }),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe({
        provider: templateEnv.MODERATION_PROVIDER,
        serviceUrl: templateEnv.MODERATION_SERVICE_URL,
      }),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toEqual(
      expect.arrayContaining([
        "database-url",
        "chat-model-api-key",
        "payment-btcpay-base-url",
        "blob-endpoint",
        "sentry-dsn",
      ]),
    );
  });

  it("parses launch gate CLI options for env files and JSON output", () => {
    expect(
      parseLaunchReadinessCliArgs(["--launch-env-file", "prod.env", "--json"]),
    ).toEqual({
      envFile: "prod.env",
      help: false,
      json: true,
    });
    expect(parseLaunchReadinessCliArgs(["--env-file", "prod.env"])).toEqual({
      envFile: "prod.env",
      help: false,
      json: false,
    });
    expect(parseLaunchReadinessCliArgs(["--launch-env-file=prod.env"])).toEqual(
      {
        envFile: "prod.env",
        help: false,
        json: false,
      },
    );
    expect(parseLaunchReadinessCliArgs(["--env-file=prod.env"])).toEqual({
      envFile: "prod.env",
      help: false,
      json: false,
    });
    expect(() => parseLaunchReadinessCliArgs(["--launch-env-file"])).toThrow(
      "--launch-env-file requires a path",
    );
    expect(() => parseLaunchReadinessCliArgs(["--unknown"])).toThrow(
      "Unknown option: --unknown",
    );
  });

  it("loads production launch env from a dotenv file with file values taking precedence", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "idream-launch-"));
    try {
      const envFile = path.join(dir, "production.env");
      writeFileSync(
        envFile,
        dotenvContent({ ...productionEnv, LAUNCH_SCOPE: "core" }),
      );

      const loadedEnv = loadLaunchReadinessEnv(envFile, {
        APP_ENV: "development",
        DATABASE_URL: "file:./dev.db",
        CHAT_PROVIDER: "mock",
      });
      const report = assessLaunchReadiness({
        env: loadedEnv,
        imagePipelineProbe: passingImageProbe(),
        ageVerificationProbe: passingAgeProbe(),
        blobStorageProbe: passingBlobProbe(),
        chatModelProbe: passingChatProbe(),
        voiceModelProbe: passingVoiceProbe(),
        chatServiceProbe: passingChatServiceProbe(),
        paymentProviderProbe: passingPaymentProbe(),
        safetyGatewayProbe: passingSafetyProbe(),
        productConfigProbe: passingProductConfigProbe(),
        webSurfaceProbe: passingWebSurfaceProbe(),
        publicCatalogProbe: passingPublicCatalogProbe(),
        ...passingSentryProbes(),
        now,
      });

      expect(loadedEnv.APP_ENV).toBe("production");
      expect(loadedEnv.LAUNCH_SCOPE).toBe("core");
      expect(loadedEnv.DATABASE_URL).toBe(productionEnv.DATABASE_URL);
      expect(loadedEnv.CHAT_PROVIDER).toBe("pipeline");
      expect(report.ok).toBe(true);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("does not inherit product credentials omitted from an explicit launch env file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "idream-launch-isolated-"));
    try {
      const envFile = path.join(dir, "production.env");
      writeFileSync(
        envFile,
        "APP_ENV=production\nMAIN_WEB_URL=https://ourdream.ai\n",
      );

      const loadedEnv = loadLaunchReadinessEnv(envFile, {
        PATH: "/usr/bin:/bin",
        DATABASE_URL: productionEnv.DATABASE_URL,
        CHAT_MODEL_API_KEY: productionEnv.CHAT_MODEL_API_KEY,
        PAYMENT_PROVIDER_PROBE_REPORT:
          productionEnv.PAYMENT_PROVIDER_PROBE_REPORT,
      });

      expect(loadedEnv).toMatchObject({
        APP_ENV: "production",
        MAIN_WEB_URL: "https://ourdream.ai",
        PATH: "/usr/bin:/bin",
      });
      expect(loadedEnv.DATABASE_URL).toBeUndefined();
      expect(loadedEnv.CHAT_MODEL_API_KEY).toBeUndefined();
      expect(loadedEnv.PAYMENT_PROVIDER_PROBE_REPORT).toBeUndefined();
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("includes launch preflight failures in an otherwise passing report", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      ...passingSentryProbes(),
      now,
      preflightChecks: [
        {
          id: "launch-env-file",
          area: "Runtime",
          status: "fail",
          message:
            "Launch env file does not exist: .tmp/production-launch.env.",
          remediation: "Create the production launch env file.",
        },
      ],
    });

    expect(report.ok).toBe(false);
    expect(report.checks[0]).toMatchObject({
      id: "launch-env-file",
      status: "fail",
    });
    expect(failedIds(report)).toContain("launch-env-file");
  });

  it("fails the launch backlog authority for exact failed Main to Chat carriers", async () => {
    const count = vi.fn().mockResolvedValue(48);

    await expect(inspectMainToChatFailedBacklog({
      mainOutboxEvent: { count },
    })).resolves.toEqual({
      ok: false,
      failed: 48,
    });
    expect(count).toHaveBeenCalledWith({
      where: {
        eventType: { in: Object.values(MAIN_TO_CHAT_EVENTS) },
        status: "failed",
      },
    });
  });

  it("passes the launch backlog authority when every Main to Chat carrier is recoverable or terminal", async () => {
    const count = vi.fn().mockResolvedValue(0);

    await expect(inspectMainToChatFailedBacklog({
      mainOutboxEvent: { count },
    })).resolves.toEqual({
      ok: true,
      failed: 0,
    });
  });

  it("fails when the live image probe did not complete a generation", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe({
        ok: false,
        terminal: {
          ref: "gen/terminal-records/attempt_probe/terminal.json",
          checksum: "b".repeat(64),
          outcome: "failed",
          assets: 0,
          error: { code: "timeout", message: "Pipeline timed out" },
        },
      }),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      ...passingSentryProbes(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("pipeline-image-live-probe");
  });

  it("fails when the live image probe is stale", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe({
        checkedAt: "2026-06-20T00:00:00.000Z",
      }),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("pipeline-image-live-probe");
  });

  it("fails when production env is configured but the live blob storage probe is missing", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: null,
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("blob-storage-live-probe");
  });

  it("fails when the live blob storage probe cannot read matching bytes", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe({
        readback: {
          ok: true,
          source: "signed-url",
          status: 200,
          bytes: 12,
          matches: false,
          sha256: "mismatch",
          error: null,
        },
      }),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("blob-storage-live-probe");
  });

  it("fails when the live blob storage probe is stale", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe({
        checkedAt: "2026-06-20T00:00:00.000Z",
      }),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("blob-storage-live-probe");
  });

  it("fails when production env opts into the live safety gateway but the probe is missing", () => {
    const report = assessLaunchReadiness({
      env: externalModerationEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: null,
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("safety-gateway-live-probe");
  });

  it("fails when the opted-in live safety gateway probe blocks benign text", () => {
    const report = assessLaunchReadiness({
      env: externalModerationEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe({
        provider: externalModerationEnv.MODERATION_PROVIDER,
        serviceUrl: externalModerationEnv.MODERATION_SERVICE_URL,
        ok: false,
        status: "blocked",
        policyCode: "false_positive",
        confidence: 0.91,
      }),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("safety-gateway-live-probe");
  });

  it("fails when the opted-in live safety gateway probe is stale", () => {
    const report = assessLaunchReadiness({
      env: externalModerationEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe({
        provider: externalModerationEnv.MODERATION_PROVIDER,
        serviceUrl: externalModerationEnv.MODERATION_SERVICE_URL,
        checkedAt: "2026-06-20T00:00:00.000Z",
      }),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("safety-gateway-live-probe");
  });

  it("fails when production env is configured but the live chat service probe is missing", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: null,
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("chat-service-live-probe");
  });

  it("preserves dedicated actor, no-memory authority, and cleanup evidence when loading a probe report", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "idream-chat-probe-"));
    try {
      const reportPath = path.join(dir, "chat-service.json");
      writeFileSync(reportPath, JSON.stringify(passingChatServiceProbe()));
      const report = assessLaunchReadiness({
        env: {
          ...productionEnv,
          CHAT_SERVICE_PROBE_REPORT: reportPath,
        },
        imagePipelineProbe: passingImageProbe(),
        ageVerificationProbe: passingAgeProbe(),
        blobStorageProbe: passingBlobProbe(),
        chatModelProbe: passingChatProbe(),
        voiceModelProbe: passingVoiceProbe(),
        paymentProviderProbe: passingPaymentProbe(),
        safetyGatewayProbe: passingSafetyProbe(),
        productConfigProbe: passingProductConfigProbe(),
        webSurfaceProbe: passingWebSurfaceProbe(),
        publicCatalogProbe: passingPublicCatalogProbe(),
        now,
      });

      expect(
        report.checks.find((check) => check.id === "chat-service-live-probe"),
      ).toMatchObject({
        status: "pass",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when the live chat service probe cannot complete a signed request", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe({
        ok: false,
        signedRequest: {
          ok: false,
          status: 401,
          error: "HTTP 401",
        },
        error: {
          code: "chat_service_probe_failed",
          message: "bad signature",
        },
      }),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("chat-service-live-probe");
  });

  it("fails when the live chat service probe does not use the dedicated audit actor", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe({
        userId: "seed-dev-user",
        actorDataClass: "internal",
        dedicatedActor: false,
      }),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(
      report.checks.find((check) => check.id === "chat-service-live-probe")
        ?.message,
    ).toContain("probe actor is not classified as audit");
    expect(
      report.checks.find((check) => check.id === "chat-service-live-probe")
        ?.message,
    ).toContain(
      "probe user id is not the dedicated actor seed-chat-probe-user",
    );
  });

  it("fails when the live chat service probe does not prove unsigned requests are rejected", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe({
        ok: false,
        unsignedRequest: {
          ok: false,
          status: 200,
          error: "HTTP 200",
        },
      }),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("chat-service-live-probe");
  });

  it("fails when the live chat service probe skips the conversation smoke", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe({
        ok: false,
        conversation: {
          ok: false,
          attempted: false,
          createSession: { ok: false, error: "skipped" },
          sendMessage: { ok: false, error: "skipped" },
          stream: { ok: false, error: "skipped" },
          getSession: { ok: false, error: "skipped" },
          noMemory: { ok: false, error: "skipped" },
          blockedInput: { ok: false, error: "skipped" },
          error: "CHAT_SERVICE_PROBE_CHARACTER_ID not set",
        },
      }),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("chat-service-live-probe");
    expect(
      report.checks.find((check) => check.id === "chat-service-live-probe")
        ?.message,
    ).toContain("conversation smoke did not complete");
  });

  it("fails when the live chat service probe cannot prove no-memory authority or cleanup", () => {
    const passing = passingChatServiceProbe();
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe({
        conversation: {
          ...passing.conversation,
          noMemory: {
            ...passing.conversation?.noMemory,
            ok: false,
            relationshipUnchanged: false,
          },
          cleanup: {
            ...passing.conversation?.cleanup,
            ok: false,
            sessionGone: false,
          },
        },
      }),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    const message = report.checks.find(
      (check) => check.id === "chat-service-live-probe",
    )?.message;
    expect(message).toContain(
      "conversation smoke did not prove no-memory turn authority",
    );
    expect(message).toContain(
      "conversation smoke did not clean its audit state",
    );
  });

  it("fails when the live chat service probe is stale", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe({
        checkedAt: "2026-06-20T00:00:00.000Z",
      }),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("chat-service-live-probe");
  });

  it("fails when production env is configured but the live chat model probe is missing", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: null,
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("chat-model-live-probe");
  });

  it("fails when the live chat model probe returns no assistant text", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe({
        ok: false,
        chunks: 0,
        characters: 0,
        done: true,
      }),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("chat-model-live-probe");
  });

  it("fails when the live chat model probe returns a mock template response", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe({
        ok: false,
        assistantPreview: "Mock Launch Probe reply: hello",
      }),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("chat-model-live-probe");
  });

  it("fails when the live chat model probe is stale", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe({
        checkedAt: "2026-06-20T00:00:00.000Z",
      }),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("chat-model-live-probe");
  });

  it("fails when production env is configured but the live voice model probe is missing", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: null,
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("voice-model-live-probe");
  });

  it("fails when the live voice model probe returns no voice asset", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe({
        ok: false,
        key: null,
        audioDurationMs: 0,
        bytes: 0,
        error: {
          code: "voice_request_failed",
          message: "gateway unavailable",
        },
      }),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("voice-model-live-probe");
  });

  it("requires Pocket TTS probe evidence to include real oMLX voice cloning", () => {
    const pocketEnv = {
      ...productionEnv,
      VOICE_PROVIDER: "pocket-tts",
      POCKET_TTS_API_URL: "https://voice.ourdream.internal/v1",
      POCKET_TTS_MODEL: "pocket-tts-4bit",
    };
    const input = {
      env: pocketEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    };
    const missingAccess = assessLaunchReadiness({
      ...input,
      voiceModelProbe: passingVoiceProbe({
        provider: "pocket-tts",
        baseUrl: pocketEnv.POCKET_TTS_API_URL,
        model: pocketEnv.POCKET_TTS_MODEL,
        voiceCloningAvailable: false,
        voiceCloneVerified: false,
      }),
    });
    const cloneBroken = assessLaunchReadiness({
      ...input,
      voiceModelProbe: passingVoiceProbe({
        provider: "pocket-tts",
        baseUrl: pocketEnv.POCKET_TTS_API_URL,
        model: pocketEnv.POCKET_TTS_MODEL,
        voiceCloningAvailable: true,
        voiceCloneVerified: false,
      }),
    });
    const cloneReady = assessLaunchReadiness({
      ...input,
      voiceModelProbe: passingVoiceProbe({
        provider: "pocket-tts",
        baseUrl: pocketEnv.POCKET_TTS_API_URL,
        model: pocketEnv.POCKET_TTS_MODEL,
        voiceCloningAvailable: true,
        voiceCloneVerified: true,
      }),
    });

    expect(
      checkById(missingAccess, "voice-model-live-probe")?.message,
    ).toContain("did not confirm oMLX voice cloning");
    expect(checkById(cloneBroken, "voice-model-live-probe")?.message).toContain(
      "did not complete clone, synthesize, and delete",
    );
    expect(checkById(cloneReady, "voice-model-live-probe")?.status).toBe(
      "pass",
    );
  });

  it("requires Fish Audio probe evidence to include resident MLX cloning", () => {
    const fishEnv = {
      ...productionEnv,
      VOICE_PROVIDER: "fish-audio",
      FISH_AUDIO_API_URL: "https://fish.ourdream.internal/v1",
      FISH_AUDIO_MODEL: "fish-audio-s2-pro-8bit",
    };
    const report = assessLaunchReadiness({
      env: fishEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      voiceModelProbe: passingVoiceProbe({
        provider: "fish-audio",
        baseUrl: fishEnv.FISH_AUDIO_API_URL,
        model: fishEnv.FISH_AUDIO_MODEL,
        voiceCloningAvailable: true,
        voiceCloneVerified: true,
      }),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(checkById(report, "voice-model-live-probe")?.status).toBe("pass");
  });

  it("preserves Pocket TTS clone evidence when loading the voice probe report", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "idream-voice-probe-"));
    try {
      const reportPath = path.join(dir, "voice-model.json");
      const pocketEnv = {
        ...productionEnv,
        VOICE_PROVIDER: "pocket-tts",
        POCKET_TTS_API_URL: "https://voice.ourdream.internal/v1",
        POCKET_TTS_MODEL: "pocket-tts-4bit",
        VOICE_MODEL_PROBE_REPORT: reportPath,
      };
      writeFileSync(
        reportPath,
        JSON.stringify(
          passingVoiceProbe({
            provider: "pocket-tts",
            baseUrl: pocketEnv.POCKET_TTS_API_URL,
            model: pocketEnv.POCKET_TTS_MODEL,
            voiceCloningAvailable: true,
            voiceCloneVerified: true,
          }),
        ),
      );
      const report = assessLaunchReadiness({
        env: pocketEnv,
        imagePipelineProbe: passingImageProbe(),
        ageVerificationProbe: passingAgeProbe(),
        blobStorageProbe: passingBlobProbe(),
        chatModelProbe: passingChatProbe(),
        chatServiceProbe: passingChatServiceProbe(),
        paymentProviderProbe: passingPaymentProbe(),
        safetyGatewayProbe: passingSafetyProbe(),
        productConfigProbe: passingProductConfigProbe(),
        webSurfaceProbe: passingWebSurfaceProbe(),
        publicCatalogProbe: passingPublicCatalogProbe(),
        now,
      });

      expect(checkById(report, "voice-model-live-probe")?.status).toBe("pass");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when the live voice model probe is stale", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe({
        checkedAt: "2026-06-20T00:00:00.000Z",
      }),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("voice-model-live-probe");
  });

  it("fails when production env is configured but the live payment provider probe is missing", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: null,
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("payment-provider-live-probe");
  });

  it("fails when the live payment provider probe cannot read the store", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe({
        ok: false,
        canViewStore: false,
        returnedStoreId: null,
        error: {
          code: "btcpay_store_read_failed",
          message: "forbidden",
        },
      }),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("payment-provider-live-probe");
  });

  it("fails when the live payment provider probe has only legacy store-read evidence", () => {
    const {
      canCreateInvoice: _canCreateInvoice,
      canLookupInvoice: _canLookupInvoice,
      invoiceId: _invoiceId,
      checkoutUrl: _checkoutUrl,
      invoiceAmountCents: _invoiceAmountCents,
      invoiceCurrency: _invoiceCurrency,
      ...legacyProbe
    } = passingPaymentProbe();

    void _canCreateInvoice;
    void _canLookupInvoice;
    void _invoiceId;
    void _checkoutUrl;
    void _invoiceAmountCents;
    void _invoiceCurrency;

    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: legacyProbe,
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("payment-provider-live-probe");
    expect(checkById(report, "payment-provider-live-probe")?.message).toContain(
      "probe could not look up the product-bound BTCPay invoice",
    );
  });

  it("rejects outbound-only BTCPay evidence without a product settlement authority", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      paymentProviderProbe: passingPaymentProbe({ terminal: null }),
      now,
    });

    expect(checkById(report, "payment-provider-live-probe")).toMatchObject({
      status: "fail",
    });
    expect(checkById(report, "payment-provider-live-probe")?.message).toContain(
      "product checkout settlement evidence is missing",
    );
  });

  it("rejects settlement replay evidence without two auditable delivery identities", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      paymentProviderProbe: passingPaymentProbe({
        terminal: {
          ...passingPaymentProbe().terminal!,
          providerDeliveryIds: ["same-delivery", "same-delivery"],
        },
      }),
      now,
    });

    expect(checkById(report, "payment-provider-live-probe")).toMatchObject({
      status: "fail",
    });
    expect(checkById(report, "payment-provider-live-probe")?.message).toContain(
      "replay was not proven idempotent",
    );
  });

  it("fails when the live payment provider probe cannot look up the product invoice", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe({
        ok: false,
        canLookupInvoice: false,
        invoiceId: null,
        checkoutUrl: null,
        error: {
          code: "btcpay_invoice_create_failed",
          message: "forbidden",
        },
      }),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("payment-provider-live-probe");
    expect(checkById(report, "payment-provider-live-probe")?.message).toContain(
      "probe could not look up the product-bound BTCPay invoice",
    );
  });

  it("fails when the live payment provider probe is stale", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe({
        checkedAt: "2026-06-20T00:00:00.000Z",
      }),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("payment-provider-live-probe");
  });

  it("fails when production env is configured but the live age verification probe is missing", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: null,
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("age-verification-live-probe");
  });

  it("rejects outbound-only Go.cam evidence without a signed verified callback authority", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      ageVerificationProbe: passingAgeProbe({ terminal: null }),
      now,
    });

    expect(checkById(report, "age-verification-live-probe")).toMatchObject({
      status: "fail",
    });
    expect(checkById(report, "age-verification-live-probe")?.message).toContain(
      "verified callback evidence is missing",
    );
  });

  it("rejects age replay evidence without one exact terminalized effect", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      ageVerificationProbe: passingAgeProbe({
        terminal: {
          ...passingAgeProbe().terminal!,
          verificationEffectCount: 2,
        },
      }),
      now,
    });

    expect(checkById(report, "age-verification-live-probe")).toMatchObject({
      status: "fail",
    });
    expect(checkById(report, "age-verification-live-probe")?.message).toContain(
      "replay was not proven idempotent",
    );
  });

  it("fails when the live age verification probe cannot audit a verified product intent", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe({
        ok: false,
        providerVerificationId: null,
        status: "failed",
        url: null,
        error: {
          code: "age_session_failed",
          message: "gateway unavailable",
        },
      }),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("age-verification-live-probe");
  });

  it("fails when the live age verification probe is stale", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe({
        checkedAt: "2026-06-20T00:00:00.000Z",
      }),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("age-verification-live-probe");
  });

  it("passes when production env, provider implementations, and live probe are ready", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      ...passingSentryProbes(),
      now,
    });
    expect(report.ok).toBe(true);
    expect(report.summary.fail).toBe(0);
    expect(report.summary.warn).toBe(0);
    expect(report.checks.map((check) => check.id)).toContain(
      "pipeline-image-model",
    );
    expect(report.checks.map((check) => check.id)).toContain(
      "pipeline-image-live-probe",
    );
    expect(report.checks.map((check) => check.id)).toContain(
      "chat-model-live-probe",
    );
    expect(report.checks.map((check) => check.id)).toContain(
      "chat-service-live-probe",
    );
    expect(report.checks.map((check) => check.id)).toContain(
      "voice-model-live-probe",
    );
    expect(report.checks.map((check) => check.id)).toContain(
      "age-verification-live-probe",
    );
    expect(report.checks.map((check) => check.id)).toContain(
      "blob-storage-live-probe",
    );
    expect(report.checks.map((check) => check.id)).toContain(
      "payment-provider-live-probe",
    );
    expect(report.checks.map((check) => check.id)).toContain(
      "safety-gateway-live-probe",
    );
    expect(report.checks.map((check) => check.id)).toContain(
      "product-config-live-probe",
    );
    expect(report.checks.map((check) => check.id)).toContain(
      "public-catalog-live-probe",
    );
    expect(report.checks.map((check) => check.id)).toContain(
      "web-surface-live-probe",
    );
    expect(report.checks.map((check) => check.id)).toContain(
      "gen-video-provider",
    );
  });

  it("lets the explicit core launch scope omit billing and age authority without weakening other gates", () => {
    const report = assessLaunchReadiness({
      env: {
        ...productionEnv,
        LAUNCH_SCOPE: "core",
        PAYMENT_PROVIDER: "mock",
        AGE_VERIFICATION_PROVIDER: "mock",
        BTCPAY_BASE_URL: "",
        BTCPAY_STORE_ID: "",
        BTCPAY_API_KEY: "",
        BTCPAY_WEBHOOK_SECRET: "",
        PAYMENT_PROVIDER_PROBE_REPORT: "",
        AGE_VERIFY_SERVICE_URL: "",
        AGE_VERIFY_API_KEY: "",
        AGE_VERIFY_WEBHOOK_SECRET: "",
        AGE_VERIFY_LINK_BACK_URL: "",
        AGE_VERIFY_CALLBACK_URL: "",
        AGE_VERIFICATION_PROBE_REPORT: "",
      },
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: null,
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: null,
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      ...passingSentryProbes(),
      now,
    });

    expect(report.ok).toBe(true);
    expect(checkById(report, "launch-scope")).toMatchObject({
      status: "pass",
    });
    expect(report.checks.map((check) => check.id)).not.toEqual(
      expect.arrayContaining([
        "payment-provider-non-mock",
        "payment-api-key",
        "payment-provider-live-probe",
        "age-verification-provider-non-mock",
        "age-verification-service-url",
        "age-verification-live-probe",
      ]),
    );
  });

  it("fails closed on an unknown launch scope instead of treating it as core", () => {
    const report = assessLaunchReadiness({
      env: { ...productionEnv, LAUNCH_SCOPE: "skip-everything" },
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      ...passingSentryProbes(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(checkById(report, "launch-scope")).toMatchObject({
      status: "fail",
    });
  });

  it("fails when the web surface probe is missing", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: null,
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("web-surface-live-probe");
  });

  it("fails when production env is configured but the public catalog probe is missing", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: null,
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("public-catalog-live-probe");
  });

  it("fails when the public catalog probe finds launch-blocking issues", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe({
        ok: false,
        issueTotals: {
          total: 2,
          fail: 1,
          warn: 1,
        },
      }),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("public-catalog-live-probe");
    expect(checkById(report, "public-catalog-live-probe")?.message).toContain(
      "1 launch-blocking catalog issue",
    );
  });

  it("fails when the public catalog probe is stale", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe({
        checkedAt: "2026-06-20T00:00:00.000Z",
      }),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("public-catalog-live-probe");
  });

  it("fails when the public catalog probe finds no launchable catalog content", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe({
        counts: {
          publicCharacters: 0,
          publicCollections: 0,
          publicCreators: 0,
          publicFeedbackItems: 0,
          distinctImages: 0,
        },
      }),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("public-catalog-live-probe");
  });

  it("fails when the web surface probe finds an unprotected admin surface", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe({
        ok: false,
        admin: {
          ok: false,
          status: 200,
          bytes: 8_000,
          contentType: "text/html; charset=utf-8",
          protected: false,
          protectedReason: null,
          nextErrorShell: false,
          error: "admin content was public",
        },
      }),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("web-surface-live-probe");
  });

  it("rejects a development login wall as production admin protection", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe({
        admin: {
          ok: true,
          status: 200,
          bytes: 8_000,
          contentType: "text/html; charset=utf-8",
          protected: true,
          protectedReason: "dev_login_wall",
          nextErrorShell: false,
          assets: { ok: true, checked: 8, failures: [] },
          error: null,
        },
      }),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("web-surface-live-probe");
    expect(checkById(report, "web-surface-live-probe")?.message).toContain(
      "production access denial",
    );
  });

  it("fails when HTML is healthy but a linked Next asset is missing", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe({
        ok: true,
        home: {
          ok: true,
          status: 200,
          bytes: 30_000,
          contentType: "text/html; charset=utf-8",
          containsBrand: true,
          nextErrorShell: false,
          assets: {
            ok: false,
            checked: 8,
            failures: [
              {
                url: "https://app.example/_next/static/chunks/missing.js",
                status: 500,
                bytes: 21,
                contentType: "text/plain",
                error: "Linked Next asset returned HTTP 500",
              },
            ],
          },
          error: null,
        },
      }),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("web-surface-live-probe");
    expect(checkById(report, "web-surface-live-probe")?.message).toContain(
      "complete linked assets",
    );
  });

  it("fails when the web surface probe finds an unlocked admin API", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe({
        ok: false,
        adminApi: {
          ok: false,
          status: 200,
          code: null,
          error: "admin API was public",
        },
      }),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("web-surface-live-probe");
  });

  it("fails when the web surface probe is stale", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe({
        checkedAt: "2026-06-20T00:00:00.000Z",
      }),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("web-surface-live-probe");
  });

  it("fails when the product config probe is missing", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: null,
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("product-config-live-probe");
  });

  it("fails when the product config probe finds no active image model profile", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe({
        ok: false,
        activeImageProfiles: 0,
        error: {
          code: "product_config_incomplete",
          message: "missing active image model profile",
        },
      }),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("product-config-live-probe");
  });

  it("fails when an active ComfyUI image profile has no workflow descriptor", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe({
        invalidActiveImageProfileIds: ["seed-profile-image-premium-v1"],
      }),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("product-config-live-probe");
  });

  it("fails closed for a fresh legacy product config report without descriptor evidence", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe({
        invalidActiveImageProfileIds: undefined,
      }),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("product-config-live-probe");
  });

  it("fails when public characters have no chat system prompts", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe({
        ok: false,
        publicCharacters: 16,
        publicCharactersWithSystemPrompt: 0,
        error: {
          code: "product_config_incomplete",
          message: "public characters have no chat system prompts",
        },
      }),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("product-config-live-probe");
  });

  it("fails when even one public character has no chat system prompt", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe({
        publicCharacters: 16,
        publicCharactersWithSystemPrompt: 15,
      }),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("product-config-live-probe");
  });

  it("fails when video_gen is enabled but the video provider is mock", () => {
    const report = assessLaunchReadiness({
      env: {
        ...productionEnv,
        GEN_VIDEO_PROVIDER: "mock",
      },
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe({
        videoFeatureEnabled: true,
        activeVideoProfiles: 1,
        activeVideoCharacterTemplates: 1,
        activeVideoFreeplayTemplates: 1,
        activeVideoPricingRules: 1,
      }),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("gen-video-provider");
    expect(failedIds(report)).not.toContain("product-config-live-probe");
  });

  it("passes the video provider check when video_gen is disabled", () => {
    const report = assessLaunchReadiness({
      env: {
        ...productionEnv,
        GEN_VIDEO_PROVIDER: "mock",
      },
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe({
        videoFeatureEnabled: false,
      }),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      ...passingSentryProbes(),
      now,
    });

    expect(report.ok).toBe(true);
    expect(report.summary.warn).toBe(0);
    expect(
      report.checks.find((check) => check.id === "gen-video-provider"),
    ).toMatchObject({
      status: "pass",
    });
  });

  it("passes the production video provider check for a ComfyUI backend", () => {
    const report = assessLaunchReadiness({
      env: {
        ...productionEnv,
        GEN_VIDEO_PROVIDER: "backend",
        COMFYUI_API_URL: "https://comfyui-video.ourdream.internal",
      },
      imagePipelineProbe: passingImageProbe(),
      videoGenerationProbe: passingVideoProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      voiceModelProbe: passingVoiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe({
        videoFeatureEnabled: true,
        activeVideoProfiles: 1,
        activeVideoCharacterTemplates: 1,
        activeVideoFreeplayTemplates: 1,
        activeVideoPricingRules: 1,
      }),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(checkById(report, "gen-video-provider")?.status).toBe("pass");
    expect(checkById(report, "video-comfyui-api-url")?.status).toBe("pass");
    expect(checkById(report, "pipeline-image-live-probe")?.status).toBe("pass");
    expect(checkById(report, "video-generation-live-probe")?.status).toBe(
      "pass",
    );
  });

  it("rejects video evidence that is not bound to the exact production recipe", () => {
    const report = assessLaunchReadiness({
      env: {
        ...productionEnv,
        GEN_VIDEO_PROVIDER: "backend",
        COMFYUI_API_URL: "https://comfyui-video.ourdream.internal",
      },
      imagePipelineProbe: passingImageProbe(),
      videoGenerationProbe: passingVideoProbe({
        workflowVersion: 2,
        referenceSha256: "not-a-source-hash",
      }),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      voiceModelProbe: passingVoiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe({
        videoFeatureEnabled: true,
        activeVideoProfiles: 1,
        activeVideoCharacterTemplates: 1,
        activeVideoPricingRules: 1,
      }),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(checkById(report, "video-generation-live-probe")?.message).toContain(
      "workflow version does not match",
    );
    expect(checkById(report, "video-generation-live-probe")?.message).toContain(
      "exact source image bytes",
    );
  });

  it("fails closed when enabled production video has no live workflow probe", () => {
    const report = assessLaunchReadiness({
      env: {
        ...productionEnv,
        GEN_VIDEO_PROVIDER: "backend",
        COMFYUI_API_URL: "https://comfyui-video.ourdream.internal",
      },
      imagePipelineProbe: passingImageProbe(),
      videoGenerationProbe: null,
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      voiceModelProbe: passingVoiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe({
        videoFeatureEnabled: true,
        activeVideoProfiles: 1,
        activeVideoCharacterTemplates: 1,
        activeVideoPricingRules: 1,
      }),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("video-generation-live-probe");
  });

  it("rejects the generic pipeline provider for production video", () => {
    const report = assessLaunchReadiness({
      env: {
        ...productionEnv,
        GEN_VIDEO_PROVIDER: "pipeline",
      },
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      voiceModelProbe: passingVoiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe({
        videoFeatureEnabled: true,
        activeVideoProfiles: 1,
        activeVideoCharacterTemplates: 1,
        activeVideoFreeplayTemplates: 1,
        activeVideoPricingRules: 1,
      }),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("gen-video-provider");
  });

  it("fails when the video worker is configured for an unsupported provider", () => {
    const report = assessLaunchReadiness({
      env: {
        ...productionEnv,
        GEN_VIDEO_PROVIDER: "sdcpp",
      },
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("gen-video-provider");
  });

  it("does not show remediation text for passing checks", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe(),
      productConfigProbe: passingProductConfigProbe(),
      webSurfaceProbe: passingWebSurfaceProbe(),
      publicCatalogProbe: passingPublicCatalogProbe(),
      now,
    });

    expect(formatLaunchReadinessReport(report)).not.toMatch(
      /\[PASS\].* Remediation:/,
    );
  });

  it("keeps production env templates aligned with the launch gate", () => {
    const mainKeys = new Set(
      Object.keys(envTemplateValues("../../.env.production.example")),
    );
    const chatKeys = new Set(
      Object.keys(envTemplateValues("../../../chat/.env.production.example")),
    );
    const genKeys = new Set(
      Object.keys(envTemplateValues("../../../gen/.env.production.example")),
    );

    expect(
      [...Object.keys(productionEnv)].filter((key) => !mainKeys.has(key)),
    ).toEqual([]);
    expect(
      [
        ...[
          "CHAT_DATABASE_URL",
          "CHAT_REDIS_URL",
          "BULLMQ_PREFIX",
          "CHAT_FS_ROOT",
          "CHAT_PORT",
          "CHAT_BFF_SIGNING_SECRET",
          "CHAT_MODEL_PROVIDER",
          "CHAT_MODEL_BASE_URL",
          "CHAT_MODEL_NAME",
          "CHAT_MODEL_API_KEY",
          "CHAT_MODERATION_PROVIDER",
          "CHAT_MODERATION_TIMEOUT_MS",
        ],
      ].filter((key) => !chatKeys.has(key)),
    ).toEqual([]);
    expect(
      [
        ...[
          "GEN_REDIS_URL",
          "GEN_IMAGE_PROVIDER",
          "GEN_VIDEO_PROVIDER",
          "GEN_MODERATION_PROVIDER",
          "PIPELINE_API_URL",
          "PIPELINE_API_TOKEN",
          "PIPELINE_IMAGE_MODEL_DEFAULT",
          "PIPELINE_VIDEO_MODEL_DEFAULT",
          "GEN_BLOB_PROVIDER",
          "BLOB_ENDPOINT",
          "BLOB_BUCKET",
          "BLOB_ACCESS_KEY_ID",
          "BLOB_SECRET_ACCESS_KEY",
        ],
      ].filter((key) => !genKeys.has(key)),
    ).toEqual([]);
  });

  it("keeps the production video worker on the workflow-native backend", () => {
    const mainValues = envTemplateValues("../../.env.production.example");
    const genValues = envTemplateValues("../../../gen/.env.production.example");

    expect(mainValues.GEN_VIDEO_PROVIDER).toBe("backend");
    expect(genValues.GEN_VIDEO_PROVIDER).toBe("backend");
    expect(genValues.GEN_VIDEO_TIMEOUT_MS).toBe("1800000");
  });

  it("keeps Fish Audio S2 Pro as the production voice authority", () => {
    const mainValues = envTemplateValues("../../.env.production.example");

    expect(mainValues.VOICE_PROVIDER).toBe("fish-audio");
    expect(mainValues.FISH_AUDIO_API_URL).toBe("http://127.0.0.1:8062/v1");
    expect(mainValues.FISH_AUDIO_MODEL).toBe("fish-audio-s2-pro-8bit");
    expect(mainValues.FISH_AUDIO_MODEL_PATH).toBeTruthy();
    expect(mainValues.FISH_AUDIO_API_TOKEN).toBeTruthy();
  });
});
