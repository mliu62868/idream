import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assessLaunchReadiness,
  formatLaunchReadinessReport,
  loadLaunchReadinessEnv,
  parseLaunchReadinessCliArgs,
  type AgeVerificationProbeEvidence,
  type BlobStorageProbeEvidence,
  type ChatModelProbeEvidence,
  type ChatServiceProbeEvidence,
  type ImagePipelineProbeEvidence,
  type LaunchReadinessReport,
  type PaymentProviderProbeEvidence,
  type ProductConfigProbeEvidence,
  type SafetyGatewayProbeEvidence,
  type VoiceModelProbeEvidence,
  type WebSurfaceProbeEvidence,
} from "./launch-readiness";

const now = new Date("2026-06-25T00:00:00.000Z");

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
  CHAT_DATABASE_URL: "postgresql://chat_service:secret@db.ourdream.internal:5432/idream",
  CHAT_FS_ROOT: "/var/lib/idream/chat",
  CHAT_MODEL_PROVIDER: "pipeline",
  CHAT_MODEL_BASE_URL: "https://pipeline.ourdream.internal",
  CHAT_MODEL_NAME: "chat-default",
  CHAT_MODEL_API_KEY: "production-pipeline-token-0123456789",
  CHAT_MODEL_PROBE_REPORT: ".tmp/launch-chat-probe.json",
  CHAT_MODERATION_PROVIDER: "safety-gateway",
  VOICE_PROVIDER: "pipeline",
  MODERATION_PROVIDER: "safety-gateway",
  PAYMENT_PROVIDER: "btcpay",
  BLOB_PROVIDER: "r2",
  AGE_VERIFICATION_PROVIDER: "gocam",
  CHAT_SERVICE_URL: "https://chat.ourdream.internal",
  CHAT_BFF_SIGNING_SECRET: "production-chat-bff-secret-0123456789",
  CHAT_SERVICE_PROBE_REPORT: ".tmp/launch-chat-service-probe.json",
  PRODUCT_CONFIG_PROBE_REPORT: ".tmp/launch-product-config-probe.json",
  WEB_SURFACE_PROBE_REPORT: ".tmp/launch-web-surface-probe.json",
  GEN_IMAGE_PROVIDER: "pipeline",
  GEN_VIDEO_PROVIDER: "pipeline",
  PIPELINE_API_URL: "https://pipeline.ourdream.internal",
  PIPELINE_VOICE_API_URL: "https://voice.ourdream.internal/v1",
  PIPELINE_API_TOKEN: "production-pipeline-token-0123456789",
  PIPELINE_VOICE_API_TOKEN: "production-voice-token-0123456789",
  PIPELINE_IMAGE_MODEL_DEFAULT: "pornmaster-zimage-turbo",
  PIPELINE_VOICE_MODEL_DEFAULT: "voice-default",
  PIPELINE_VIDEO_MODEL_DEFAULT: "video-default",
  PIPELINE_IMAGE_PROBE_REPORT: ".tmp/launch-image-probe.json",
  VOICE_MODEL_PROBE_REPORT: ".tmp/launch-voice-probe.json",
  BLOB_STORAGE_PROBE_REPORT: ".tmp/launch-blob-probe.json",
  MODERATION_SERVICE_URL: "https://moderation.ourdream.internal",
  MODERATION_API_KEY: "production-moderation-token-0123456789",
  SAFETY_GATEWAY_PROBE_REPORT: ".tmp/launch-safety-probe.json",
  BTCPAY_BASE_URL: "https://btcpay.ourdream.ai",
  BTCPAY_STORE_ID: "store-1",
  BTCPAY_API_KEY: "btcpay-api-key",
  BTCPAY_WEBHOOK_SECRET: "btcpay-webhook-secret",
  PAYMENT_PROVIDER_PROBE_REPORT: ".tmp/launch-payment-probe.json",
  AGE_VERIFY_SERVICE_URL: "https://age.ourdream.internal",
  AGE_VERIFY_API_KEY: "production-age-token-0123456789",
  AGE_VERIFY_WEBHOOK_SECRET: "production-age-webhook-secret-0123456789",
  AGE_VERIFY_LINK_BACK_URL: "https://ourdream.ai/age-verification/return",
  AGE_VERIFY_CALLBACK_URL: "https://ourdream.ai/api/v1/age-verification/webhooks/gocam",
  AGE_VERIFICATION_PROBE_REPORT: ".tmp/launch-age-probe.json",
  BLOB_BUCKET: "idream-private-media",
  BLOB_ENDPOINT: "https://a1b2c3d4e5f6.r2.cloudflarestorage.com",
  BLOB_ACCESS_KEY_ID: "blob-access-key",
  BLOB_SECRET_ACCESS_KEY: "blob-secret-key",
  SENTRY_DSN: "https://public@o123456.ingest.sentry.io/987654",
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
    generationJobId: "probe_123",
    finalize: {
      kind: "generation.completed",
      assets: 1,
      error: null,
    },
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
    serviceUrl: productionEnv.MODERATION_SERVICE_URL,
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
    userId: "seed-dev-user",
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
    activeImageCharacterTemplates: 1,
    activeImageFreeplayTemplates: 1,
    activeImagePricingRules: 1,
    activeVideoProfiles: 0,
    activeVideoCharacterTemplates: 0,
    activeVideoFreeplayTemplates: 0,
    activeVideoPricingRules: 0,
    error: null,
    ...override,
  };
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
      error: null,
    },
    generate: {
      ok: true,
      status: 200,
      bytes: 30_000,
      contentType: "text/html; charset=utf-8",
      containsGenerator: true,
      nextErrorShell: false,
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
      nextErrorShell: false,
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
    status: "pending",
    url: "https://go.cam/verify/session-1",
    error: null,
    ...override,
  };
}

function failedIds(report: LaunchReadinessReport) {
  return report.checks
    .filter((check) => check.status === "fail")
    .map((check) => check.id);
}

function envTemplateValues(relativePath: string) {
  const content = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
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
        "pipeline-api-url",
        "pipeline-image-live-probe",
        "product-config-live-probe",
        "blob-bucket",
        "age-verification-live-probe",
        "blob-storage-live-probe",
        "payment-provider-live-probe",
        "safety-gateway-live-probe",
        "sentry-dsn",
      ]),
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
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toEqual(
      expect.arrayContaining([
        "age-verification-provider-implementation",
      ]),
    );
    expect(failedIds(report)).not.toContain("chat-provider-non-mock");
    expect(failedIds(report)).not.toContain("chat-provider-implementation");
    expect(failedIds(report)).not.toContain("voice-provider-implementation");
    expect(failedIds(report)).not.toContain("payment-provider-implementation");
    expect(failedIds(report)).not.toContain("moderation-provider-implementation");
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
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("pipeline-image-live-probe");
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
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("chat-fs-root");
  });

  it("requires public age verification return and callback URLs", () => {
    const report = assessLaunchReadiness({
      env: {
        ...productionEnv,
        AGE_VERIFY_LINK_BACK_URL: "http://localhost:3000/age-verification/return",
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

  it("requires packages/chat to use a real model and moderation provider", () => {
    const report = assessLaunchReadiness({
      env: {
        ...productionEnv,
        CHAT_MODEL_PROVIDER: "mock",
        CHAT_MODERATION_PROVIDER: "mock",
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
        "pipeline-api-token",
        "payment-btcpay-base-url",
        "blob-endpoint",
        "sentry-dsn",
      ]),
    );
  });

  it("parses launch gate CLI options for env files and JSON output", () => {
    expect(parseLaunchReadinessCliArgs(["--launch-env-file", "prod.env", "--json"])).toEqual({
      envFile: "prod.env",
      help: false,
      json: true,
    });
    expect(parseLaunchReadinessCliArgs(["--env-file", "prod.env"])).toEqual({
      envFile: "prod.env",
      help: false,
      json: false,
    });
    expect(parseLaunchReadinessCliArgs(["--launch-env-file=prod.env"])).toEqual({
      envFile: "prod.env",
      help: false,
      json: false,
    });
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
      writeFileSync(envFile, dotenvContent(productionEnv));

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
        now,
      });

      expect(loadedEnv.APP_ENV).toBe("production");
      expect(loadedEnv.DATABASE_URL).toBe(productionEnv.DATABASE_URL);
      expect(loadedEnv.CHAT_PROVIDER).toBe("pipeline");
      expect(report.ok).toBe(true);
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
      now,
      preflightChecks: [
        {
          id: "launch-env-file",
          area: "Runtime",
          status: "fail",
          message: "Launch env file does not exist: .tmp/production-launch.env.",
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

  it("fails when the live image probe did not complete a generation", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe({
        ok: false,
        finalize: {
          kind: "generation.failed",
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
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("blob-storage-live-probe");
  });

  it("fails when production env is configured but the live safety gateway probe is missing", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
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

  it("fails when the live safety gateway probe blocks benign text", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe({
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

  it("fails when the live safety gateway probe is stale", () => {
    const report = assessLaunchReadiness({
      env: productionEnv,
      imagePipelineProbe: passingImageProbe(),
      ageVerificationProbe: passingAgeProbe(),
      blobStorageProbe: passingBlobProbe(),
      chatModelProbe: passingChatProbe(),
      voiceModelProbe: passingVoiceProbe(),
      chatServiceProbe: passingChatServiceProbe(),
      paymentProviderProbe: passingPaymentProbe(),
      safetyGatewayProbe: passingSafetyProbe({
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
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("chat-service-live-probe");
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
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("chat-service-live-probe");
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
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("chat-service-live-probe");
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
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("voice-model-live-probe");
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
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("payment-provider-live-probe");
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
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("age-verification-live-probe");
  });

  it("fails when the live age verification probe cannot create a pending session", () => {
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
      "web-surface-live-probe",
    );
    expect(report.checks.map((check) => check.id)).toContain(
      "gen-video-provider",
    );
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
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("web-surface-live-probe");
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
          nextErrorShell: false,
          error: "admin content was public",
        },
      }),
      now,
    });

    expect(report.ok).toBe(false);
    expect(failedIds(report)).toContain("web-surface-live-probe");
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
      now,
    });

    expect(report.ok).toBe(true);
    expect(report.summary.warn).toBe(0);
    expect(report.checks.find((check) => check.id === "gen-video-provider")).toMatchObject({
      status: "pass",
    });
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
      now,
    });

    expect(formatLaunchReadinessReport(report)).not.toMatch(
      /\[PASS\].* Remediation:/,
    );
  });

  it("keeps production env templates aligned with the launch gate", () => {
    const mainKeys = new Set(Object.keys(envTemplateValues("../../.env.production.example")));
    const chatKeys = new Set(Object.keys(envTemplateValues("../../../chat/.env.production.example")));
    const genKeys = new Set(Object.keys(envTemplateValues("../../../gen/.env.production.example")));

    expect([...Object.keys(productionEnv)].filter((key) => !mainKeys.has(key))).toEqual([]);
    expect([...[
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
      "CHAT_MODERATION_SERVICE_URL",
      "CHAT_MODERATION_API_KEY",
      "CHAT_MODERATION_TIMEOUT_MS",
    ]].filter((key) => !chatKeys.has(key))).toEqual([]);
    expect([...[
      "GEN_REDIS_URL",
      "GEN_IMAGE_PROVIDER",
      "GEN_VIDEO_PROVIDER",
      "GEN_MODERATION_PROVIDER",
      "PIPELINE_API_URL",
      "PIPELINE_API_TOKEN",
      "PIPELINE_IMAGE_MODEL_DEFAULT",
      "PIPELINE_VIDEO_MODEL_DEFAULT",
      "MODERATION_SERVICE_URL",
      "MODERATION_API_KEY",
      "GEN_BLOB_PROVIDER",
      "BLOB_ENDPOINT",
      "BLOB_BUCKET",
      "BLOB_ACCESS_KEY_ID",
      "BLOB_SECRET_ACCESS_KEY",
    ]].filter((key) => !genKeys.has(key))).toEqual([]);
  });
});
