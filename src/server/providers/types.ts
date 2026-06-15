export interface ProviderFailure {
  code: string;
  message: string;
  retryable: boolean;
}

export type ProviderResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ProviderFailure };

export interface ChatChunk {
  delta: string;
  done: boolean;
}

export interface ChatModel {
  stream(input: {
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    characterName?: string;
  }): AsyncIterable<ChatChunk>;
}

export interface ImageModel {
  generate(input: {
    prompt: string;
    count: number;
    seed?: string;
  }): Promise<ProviderResult<{ assets: Array<{ key: string; width: number; height: number }> }>>;
}

export interface VideoModel {
  generate(input: {
    prompt: string;
    seconds: number;
    seed?: string;
  }): Promise<ProviderResult<{ asset: { key: string; seconds: number } }>>;
}

export interface VoiceModel {
  synthesize(input: {
    text: string;
    voiceId?: string;
  }): Promise<ProviderResult<{ key: string; durationMs: number }>>;
}

export interface ModerationProvider {
  check(input: {
    targetType: "text" | "image" | "video";
    content: string;
  }): Promise<
    ProviderResult<{
      status: "passed" | "flagged" | "blocked";
      policyCode?: string;
      confidence: number;
    }>
  >;
}

export interface PaymentProvider {
  createInvoice(input: {
    userId: string;
    amountCents: number;
    currency: string;
    metadata?: Record<string, string>;
  }): Promise<
    ProviderResult<{
      provider: "mock";
      invoiceId: string;
      checkoutUrl: string;
      status: "created";
    }>
  >;
  parseWebhook(input: {
    providerEventId: string;
    payload: unknown;
    signature?: string;
  }): Promise<
    ProviderResult<{
      providerEventId: string;
      type: "invoice.confirmed";
      invoiceId: string;
    }>
  >;
}

export interface BlobStore {
  putPrivate(input: {
    key: string;
    body: Uint8Array;
    contentType: string;
  }): Promise<ProviderResult<{ key: string; size: number }>>;
  signGetUrl(input: { key: string; expiresInSeconds: number }): Promise<ProviderResult<{ url: string }>>;
  delete(input: { key: string }): Promise<ProviderResult<{ deleted: true }>>;
}

export interface AgeVerificationProvider {
  createSession(input: {
    userId: string;
    jurisdiction?: string;
  }): Promise<
    ProviderResult<{
      provider: "mock";
      providerVerificationId: string;
      status: "not_required";
      url?: string;
    }>
  >;
}

export interface ProviderRegistry {
  chat: ChatModel;
  image: ImageModel;
  video: VideoModel;
  voice: VoiceModel;
  moderation: ModerationProvider;
  payment: PaymentProvider;
  blob: BlobStore;
  ageVerification: AgeVerificationProvider;
}
