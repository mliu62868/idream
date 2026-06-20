import { env } from "@/server/lib/env";
import { MockBlobStore } from "./blob/mock";
import { MockChatModel } from "./chat/mock";
import { MockImageModel } from "./image/mock";
import { MockModerationProvider } from "./moderation/mock";
import { MockPaymentProvider } from "./payment/mock";
import type { ProviderRegistry } from "./types";
import { MockAgeVerificationProvider } from "./verify/mock";
import { MockVideoModel } from "./video/mock";
import { MockVoiceModel } from "./voice/mock";

function assertMockProvidersConfigured() {
  const configured = [
    env.CHAT_PROVIDER,
    env.IMAGE_PROVIDER,
    env.VIDEO_PROVIDER,
    env.VOICE_PROVIDER,
    env.MODERATION_PROVIDER,
    env.PAYMENT_PROVIDER,
    env.BLOB_PROVIDER,
    env.AGE_VERIFICATION_PROVIDER,
  ];

  const unsupported = configured.filter((provider) => provider !== "mock");
  if (unsupported.length > 0) {
    throw new Error(
      `Only mock providers are wired in M0. Unsupported: ${unsupported.join(", ")}`,
    );
  }
}

export function createProviderRegistry(): ProviderRegistry {
  assertMockProvidersConfigured();

  return {
    chat: new MockChatModel(),
    image: new MockImageModel(),
    video: new MockVideoModel(),
    voice: new MockVoiceModel(),
    moderation: new MockModerationProvider(),
    payment: new MockPaymentProvider(),
    blob: new MockBlobStore(),
    ageVerification: new MockAgeVerificationProvider(),
  };
}

export const providers = createProviderRegistry();
export type { ProviderRegistry } from "./types";
