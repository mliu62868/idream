import { S3CompatibleBlobStore, SafetyGatewayModerationProvider } from "@idream/shared";
import { env } from "@/server/lib/env";
import { MockBlobStore } from "./blob/mock";
import { MockChatModel } from "./chat/mock";
import { PipelineChatModel } from "./chat/pipeline";
import { MockModerationProvider } from "./moderation/mock";
import { BtcPayPaymentProvider } from "./payment/btcpay";
import { MockPaymentProvider } from "./payment/mock";
import type { ProviderRegistry } from "./types";
import { GoCamAgeVerificationProvider } from "./verify/gocam";
import { MockAgeVerificationProvider } from "./verify/mock";
import { createConfiguredVoicePorts } from "./voice/factory";

// INVARIANT: Main owns request, billing, and projection authority. Image/video
// provider execution belongs exclusively to packages/gen, including tests.
function assertMockProvidersConfigured() {
  const unsupported = [
    unsupportedProvider("CHAT_PROVIDER", env.CHAT_PROVIDER, ["mock", "pipeline"]),
    unsupportedProvider("VOICE_PROVIDER", env.VOICE_PROVIDER, [
      "mock",
      "pipeline",
      "pocket-tts",
      "fish-audio",
    ]),
    unsupportedProvider("MODERATION_PROVIDER", env.MODERATION_PROVIDER, ["mock", "safety-gateway"]),
    unsupportedProvider("PAYMENT_PROVIDER", env.PAYMENT_PROVIDER, ["mock", "btcpay"]),
    unsupportedProvider("BLOB_PROVIDER", env.BLOB_PROVIDER, ["mock", "r2", "s3"]),
    unsupportedProvider("AGE_VERIFICATION_PROVIDER", env.AGE_VERIFICATION_PROVIDER, ["mock", "gocam"]),
  ].flat();
  if (unsupported.length > 0) {
    throw new Error(
      `Unsupported provider configuration: ${unsupported.join(", ")}`,
    );
  }
}

function unsupportedProvider(name: string, value: string, supported: readonly string[]) {
  return supported.includes(value) ? [] : [`${name}=${value}`];
}

function assertProductionProvidersConfigured() {
  if (env.APP_ENV !== "production") return;

  const mockProviders = [
    ["CHAT_PROVIDER", env.CHAT_PROVIDER],
    ["VOICE_PROVIDER", env.VOICE_PROVIDER],
    ["MODERATION_PROVIDER", env.MODERATION_PROVIDER],
    ["PAYMENT_PROVIDER", env.PAYMENT_PROVIDER],
    ["BLOB_PROVIDER", env.BLOB_PROVIDER],
    ["AGE_VERIFICATION_PROVIDER", env.AGE_VERIFICATION_PROVIDER],
  ]
    .filter(([, provider]) => provider === "mock")
    .map(([name]) => name);

  if (mockProviders.length > 0) {
    throw new Error(
      `Production requires non-mock providers: ${mockProviders.join(", ")}`,
    );
  }

  if (!env.CHAT_SERVICE_URL || !env.CHAT_BFF_SIGNING_SECRET) {
    throw new Error(
      "Production requires CHAT_SERVICE_URL and CHAT_BFF_SIGNING_SECRET",
    );
  }
}

function createBlobStore() {
  if (env.BLOB_PROVIDER === "mock") return new MockBlobStore();

  return new S3CompatibleBlobStore({
    endpoint: requireEnv("BLOB_ENDPOINT", env.BLOB_ENDPOINT),
    bucket: requireEnv("BLOB_BUCKET", env.BLOB_BUCKET),
    region: env.BLOB_REGION,
    accessKeyId: requireEnv(
      "BLOB_ACCESS_KEY_ID",
      env.BLOB_ACCESS_KEY_ID ?? env.BLOB_ACCESS_KEY ?? env.AWS_ACCESS_KEY_ID,
    ),
    secretAccessKey: requireEnv(
      "BLOB_SECRET_ACCESS_KEY",
      env.BLOB_SECRET_ACCESS_KEY ?? env.BLOB_SECRET_KEY ?? env.AWS_SECRET_ACCESS_KEY,
    ),
  });
}

function createChatProvider() {
  if (env.CHAT_PROVIDER === "mock") return new MockChatModel();

  return new PipelineChatModel({
    baseUrl: requireProviderEnv(
      "PIPELINE_API_URL",
      env.PIPELINE_API_URL,
      "CHAT_PROVIDER",
      env.CHAT_PROVIDER,
    ),
    apiKey: env.PIPELINE_API_TOKEN,
    model: env.PIPELINE_CHAT_MODEL_DEFAULT,
    timeoutMs: env.PIPELINE_TIMEOUT_MS,
  });
}

function createPaymentProvider() {
  if (env.PAYMENT_PROVIDER === "mock") return new MockPaymentProvider();

  return new BtcPayPaymentProvider({
    baseUrl: requireProviderEnv(
      "BTCPAY_BASE_URL",
      env.BTCPAY_BASE_URL,
      "PAYMENT_PROVIDER",
      env.PAYMENT_PROVIDER,
    ),
    storeId: requireProviderEnv(
      "BTCPAY_STORE_ID",
      env.BTCPAY_STORE_ID,
      "PAYMENT_PROVIDER",
      env.PAYMENT_PROVIDER,
    ),
    apiKey: requireProviderEnv(
      "BTCPAY_API_KEY",
      env.BTCPAY_API_KEY,
      "PAYMENT_PROVIDER",
      env.PAYMENT_PROVIDER,
    ),
    webhookSecret: requireProviderEnv(
      "BTCPAY_WEBHOOK_SECRET",
      env.BTCPAY_WEBHOOK_SECRET,
      "PAYMENT_PROVIDER",
      env.PAYMENT_PROVIDER,
    ),
  });
}

function createModerationProvider() {
  if (env.MODERATION_PROVIDER === "mock") return new MockModerationProvider();

  if (env.MODERATION_PROVIDER === "safety-gateway") {
    return new SafetyGatewayModerationProvider({
      serviceUrl: requireProviderEnv(
        "MODERATION_SERVICE_URL",
        env.MODERATION_SERVICE_URL,
        "MODERATION_PROVIDER",
        env.MODERATION_PROVIDER,
      ),
      apiKey: requireProviderEnv(
        "MODERATION_API_KEY",
        env.MODERATION_API_KEY,
        "MODERATION_PROVIDER",
        env.MODERATION_PROVIDER,
      ),
      timeoutMs: env.MODERATION_TIMEOUT_MS,
    });
  }

  throw new Error(`Unsupported MODERATION_PROVIDER=${env.MODERATION_PROVIDER}`);
}

function createAgeVerificationProvider() {
  if (env.AGE_VERIFICATION_PROVIDER === "mock") {
    return new MockAgeVerificationProvider();
  }

  return new GoCamAgeVerificationProvider({
    serviceUrl: requireProviderEnv(
      "AGE_VERIFY_SERVICE_URL",
      env.AGE_VERIFY_SERVICE_URL,
      "AGE_VERIFICATION_PROVIDER",
      env.AGE_VERIFICATION_PROVIDER,
    ),
    apiKey: requireProviderEnv(
      "AGE_VERIFY_API_KEY",
      env.AGE_VERIFY_API_KEY,
      "AGE_VERIFICATION_PROVIDER",
      env.AGE_VERIFICATION_PROVIDER,
    ),
    webhookSecret: requireProviderEnv(
      "AGE_VERIFY_WEBHOOK_SECRET",
      env.AGE_VERIFY_WEBHOOK_SECRET,
      "AGE_VERIFICATION_PROVIDER",
      env.AGE_VERIFICATION_PROVIDER,
    ),
    linkBackUrl: requireProviderEnv(
      "AGE_VERIFY_LINK_BACK_URL",
      env.AGE_VERIFY_LINK_BACK_URL,
      "AGE_VERIFICATION_PROVIDER",
      env.AGE_VERIFICATION_PROVIDER,
    ),
    callbackUrl: requireProviderEnv(
      "AGE_VERIFY_CALLBACK_URL",
      env.AGE_VERIFY_CALLBACK_URL,
      "AGE_VERIFICATION_PROVIDER",
      env.AGE_VERIFICATION_PROVIDER,
    ),
    timeoutMs: env.AGE_VERIFY_TIMEOUT_MS,
  });
}

function requireEnv(name: string, value: string | undefined) {
  if (!value) throw new Error(`${name} is required when BLOB_PROVIDER=${env.BLOB_PROVIDER}`);
  return value;
}

function requireProviderEnv(
  name: string,
  value: string | undefined,
  providerName: string,
  provider: string,
) {
  if (!value) throw new Error(`${name} is required when ${providerName}=${provider}`);
  return value;
}

export function createProviderRegistry(): ProviderRegistry {
  assertProductionProvidersConfigured();
  assertMockProvidersConfigured();
  const blob = createBlobStore();

  return {
    chat: createChatProvider(),
    voice: createConfiguredVoicePorts(blob),
    moderation: createModerationProvider(),
    payment: createPaymentProvider(),
    blob,
    ageVerification: createAgeVerificationProvider(),
  };
}

export const providers = createProviderRegistry();
export type { ProviderRegistry } from "./types";
