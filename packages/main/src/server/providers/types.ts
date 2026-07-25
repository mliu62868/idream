import type {
  ImageGeneratePayload,
  VideoGeneratePayload,
} from "@idream/shared/contracts";

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
    negativePrompt?: string | null;
    model?: string;
    controls?: Record<string, unknown>;
    requestId?: string;
    orientation?: string;
    referenceImages?: NonNullable<ImageGeneratePayload["referenceImages"]>;
  }): Promise<
    ProviderResult<{
      assets: Array<{
        key: string;
        width: number;
        height: number;
        body?: Uint8Array;
        contentType?: string;
      }>;
    }>
  >;
}

export interface VideoModel {
  generate(input: {
    prompt: string;
    seconds: number;
    seed?: string;
    negativePrompt?: string | null;
    model?: string;
    controls?: Record<string, unknown>;
    requestId?: string;
    referenceImages?: NonNullable<VideoGeneratePayload["referenceImages"]>;
  }): Promise<ProviderResult<{ asset: { key: string; seconds: number } }>>;
}

export interface VoiceModel {
  readonly providerKey: "mock" | "pipeline" | "pocket_tts";
  readonly supportsVoiceCloning: boolean;
  synthesize(input: {
    text: string;
    voiceId?: string;
    // Free-form delivery instruction (emotion/persona/intonation). Sourced from the
    // character today; later a per-message emotion tag from chat can flow in here.
    tone?: string;
  }): Promise<ProviderResult<{ key: string; durationMs: number }>>;
  previewVoice?(input: {
    text: string;
    voiceId: string;
  }): Promise<
    ProviderResult<{
      body: Uint8Array;
      contentType: "audio/wav";
      durationMs: number;
    }>
  >;
  cloneVoice?(input: {
    voiceId: string;
    audio: Uint8Array;
    contentType: string;
    filename: string;
    language: string;
    referenceText: string;
  }): Promise<
    ProviderResult<{
      voiceId: string;
      model: string;
      language: string;
    }>
  >;
  deleteVoice?(input: {
    voiceId: string;
  }): Promise<ProviderResult<{ deleted: true }>>;
  inspectCapabilities?(): Promise<
    ProviderResult<{
      voiceCloning: boolean;
      runtime?: string;
      runtimeVersion?: string;
      acceleration?: string;
    }>
  >;
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

export type PaymentInvoiceStatus =
  | "created"
  | "processing"
  | "settled"
  | "expired"
  | "invalid";

export type PaymentInvoiceAdditionalStatus =
  | "none"
  | "marked"
  | "paid_late"
  | "paid_over"
  | "paid_partial";

export type PaymentInvoice = {
  provider: "mock" | "btcpay";
  invoiceId: string;
  checkoutUrl: string;
  status: PaymentInvoiceStatus;
  additionalStatus: PaymentInvoiceAdditionalStatus;
  orderId: string;
  amountCents: number;
  currency: string;
};

export type BillingModel = "prepaid_period" | "recurring" | "unknown";
export type RenewalCapability = "none" | "cancel_resume";

export type PaymentProviderCapabilities = {
  billingModel: BillingModel;
  renewalCapability: RenewalCapability;
};

export interface PaymentProvider {
  readonly capabilities: PaymentProviderCapabilities;
  createInvoice(input: {
    orderId: string;
    userId: string;
    amountCents: number;
    currency: string;
    metadata?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<
    ProviderResult<PaymentInvoice>
  >;
  findInvoiceByOrderId(input: {
    orderId: string;
    signal?: AbortSignal;
  }): Promise<
    ProviderResult<PaymentInvoice | null>
  >;
  parseWebhook(input: {
    providerEventId: string;
    payload: unknown;
    signature?: string;
    rawBody?: string;
  }): Promise<
    ProviderResult<{
      providerEventId: string;
      deliveryId: string;
      type: "invoice.confirmed" | "invoice.ignored";
      invoiceId?: string;
      orderId?: string;
    }>
  >;
}

export interface BlobStore {
  putPrivate(input: {
    key: string;
    body: Uint8Array;
    contentType: string;
  }): Promise<ProviderResult<{ key: string; size: number }>>;
  signGetUrl(input: {
    key: string;
    expiresInSeconds: number;
    downloadFilename?: string;
  }): Promise<ProviderResult<{ url: string }>>;
  delete(input: { key: string }): Promise<ProviderResult<{ deleted: true }>>;
}

export interface AgeVerificationProvider {
  createSession(input: {
    userId: string;
    jurisdiction?: string;
  }): Promise<
    ProviderResult<{
      provider: "mock" | "gocam";
      providerVerificationId: string;
      status: "not_required" | "pending" | "verified" | "failed" | "expired";
      url?: string;
    }>
  >;
  parseWebhook(input: {
    providerEventId: string;
    payload: unknown;
    signature?: string;
    rawBody?: string;
  }): Promise<
    ProviderResult<{
      providerEventId: string;
      userId?: string;
      providerVerificationId?: string;
      status: "pending" | "verified" | "failed" | "expired";
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
