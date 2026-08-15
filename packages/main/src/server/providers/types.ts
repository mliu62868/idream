import type {
  FishAudioDeliverySettings,
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

export type VoiceProviderKey =
  | "mock"
  | "pipeline"
  | "pocket_tts"
  | "fish_audio";

export const VOICE_PROVIDER_REPLAY = {
  mock: "durable_same_key",
  fish_audio: "durable_same_key",
  pipeline: "non_replayable",
  pocket_tts: "non_replayable",
} as const satisfies Record<
  VoiceProviderKey,
  "durable_same_key" | "non_replayable"
>;

export interface VoiceClipPort {
  readonly providerKey: VoiceProviderKey;
  readonly providerReplay: "durable_same_key" | "non_replayable";
  synthesize(input: {
    requestId: string;
    attemptNo: number;
    idempotencyKey: string;
    text: string;
    voiceId?: string;
    // Free-form delivery instruction (emotion/persona/intonation). Sourced from the
    // character today; later a per-message emotion tag from chat can flow in here.
    tone?: string;
    delivery?: FishAudioDeliverySettings;
    scene?: {
      version: number;
      location: string | null;
      time: string | null;
      participants: string[];
      emotionalBeat: string | null;
      unresolvedThreads: string[];
    } | null;
  }): Promise<ProviderResult<{
    key: string;
    durationMs: number;
    sceneApplied?: boolean;
    sceneAdapter?: string;
  }>>;
}

export function voiceSceneInstructions(
  scene: Parameters<VoiceClipPort["synthesize"]>[0]["scene"],
): string | null {
  if (!scene) return null;
  return [
    scene.location ? `Location: ${scene.location}.` : null,
    scene.time ? `Time: ${scene.time}.` : null,
    scene.emotionalBeat ? `Emotional beat: ${scene.emotionalBeat}.` : null,
    scene.participants.length > 0 ? `Present: ${scene.participants.join(", ")}.` : null,
    scene.unresolvedThreads.length > 0
      ? `Unresolved context: ${scene.unresolvedThreads.join("; ")}.`
      : null,
  ].filter(Boolean).join(" ") || "Maintain continuity with the current scene.";
}

export interface VoiceIdentityPort {
  readonly providerKey: VoiceProviderKey;
  previewVoice(input: {
    text: string;
    voiceId: string;
    delivery?: FishAudioDeliverySettings;
  }): Promise<
    ProviderResult<{
      body: Uint8Array;
      contentType: "audio/wav";
      durationMs: number;
    }>
  >;
  cloneVoice(input: {
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
  deleteVoice(input: {
    voiceId: string;
  }): Promise<ProviderResult<{ deleted: true }>>;
  inspectCapabilities(): Promise<
    ProviderResult<{
      voiceCloning: boolean;
      runtime?: string;
      runtimeVersion?: string;
      acceleration?: string;
    }>
  >;
}

export type VoicePorts = {
  readonly clip: VoiceClipPort;
  readonly identity: VoiceIdentityPort | null;
};

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

export type PaymentRefundState =
  | "claimable"
  | "awaiting_approval"
  | "awaiting_payment"
  | "in_progress"
  | "completed"
  | "canceled";

export type PaymentRefundPayout = {
  payoutId: string;
  amount: string;
  currency: string;
  state: Exclude<PaymentRefundState, "claimable">;
  paymentProofId?: string;
};

export type PaymentRefund = {
  provider: "mock" | "btcpay";
  refundId: string;
  reference: string;
  claimUrl: string;
  amount: string;
  currency: string;
  state: PaymentRefundState;
  payouts: PaymentRefundPayout[];
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
  createRefund(input: {
    invoiceId: string;
    reference: string;
    reason: string;
    amountCents: number;
    currency: string;
    signal?: AbortSignal;
  }): Promise<ProviderResult<PaymentRefund>>;
  findRefund(input: {
    reference?: string;
    refundId?: string;
    signal?: AbortSignal;
  }): Promise<ProviderResult<PaymentRefund | null>>;
  parseWebhook(input: {
    providerEventId: string;
    payload: unknown;
    signature?: string;
    rawBody?: string;
  }): Promise<
    ProviderResult<
      | {
          providerEventId: string;
          deliveryId: string;
          type: "invoice.confirmed" | "invoice.ignored";
          invoiceId?: string;
          orderId?: string;
        }
      | {
          providerEventId: string;
          deliveryId: string;
          type: "refund.updated";
          refundId: string;
          payoutId: string;
          payoutState: Exclude<PaymentRefundState, "claimable">;
        }
    >
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
  getPrivate?(input: {
    key: string;
  }): Promise<ProviderResult<{ body: Uint8Array; contentType: string | null }>>;
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
    deliveryId?: string;
    payload: unknown;
    signature?: string;
    rawBody?: string;
  }): Promise<
    ProviderResult<{
      providerEventId: string;
      deliveryId: string;
      userId?: string;
      providerVerificationId?: string;
      status: "pending" | "verified" | "failed" | "expired";
    }>
  >;
}

export interface ProviderRegistry {
  chat: ChatModel;
  voice: VoicePorts;
  moderation: ModerationProvider;
  payment: PaymentProvider;
  blob: BlobStore;
  ageVerification: AgeVerificationProvider;
}
