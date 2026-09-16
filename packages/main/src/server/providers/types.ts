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
  | "pocket_tts"
  | "fish_audio";

// SPEC: every voice adapter is durably replayable under the same provider
//   idempotency key — re-sending one key returns the original synthesis instead
//   of billing and rendering a second one.
// INTENT: this used to be a per-adapter `providerReplay` axis, because the
//   `pipeline` gateway could not be replayed. That adapter was deleted (zero
//   enablement, and the rollback URL it justified itself with was an
//   `example.com` placeholder), leaving one value behind a whole state axis.
//   Callers therefore no longer branch on replayability; `reserveVoiceProviderInvocation`
//   states the reservation rule once.
// INVARIANT: an adapter that cannot honour same-key replay may NOT implement this
//   interface — it needs its own unknown-outcome handling, not a boolean here.
export interface VoiceClipPort {
  readonly providerKey: VoiceProviderKey;
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
    // SPEC: synthesized audio, NOT a stored blob key. Naming and persistence are
    //   the caller's; an adapter that also wrote the blob forced all four of them
    //   to re-implement `voiceArtifactKey` + `putPrivate` + duration accounting,
    //   and left an undelivered object behind whenever the commit that followed
    //   failed. `VoiceIdentityPort.previewVoice` below already had this shape.
  }): Promise<ProviderResult<{
    body: Uint8Array;
    contentType: string;
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
  createPresetVoice?(input: {
    voiceId: string;
    presetVoiceId: string;
    language: string;
  }): Promise<
    ProviderResult<{
      voiceId: string;
      presetVoiceId: string;
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
      catalogVoices?: readonly string[];
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

/** Actual original-currency receipts, independent of invoice face value and FX. */
export type SettledInvoicePayment = {
  paymentId: string;
  paymentMethodId: string;
  amount: string;
  currency: string;
  /** Provider-recorded payment receipt time; not the later settlement transition. */
  receivedAt: string;
  /** Greenfield payment methods expose receipt time, not settlement time. */
  settledAt: null;
};

export type PaymentInvoicePaymentEvidence = {
  provider: "mock" | "btcpay";
  invoiceId: string;
  orderId: string;
} & (
  | {
      status: "verified";
      merchantAccountId: string;
      source: "btcpay_accounted_invoice_payments";
      /** Only independently Settled payments; not an assertion of full invoice payment. */
      payments: readonly SettledInvoicePayment[];
    }
  | {
      status: "unknown";
      reason: "provider_has_no_cash_authority" | "settled_payments_missing" | "payment_evidence_incomplete";
      payments: readonly [];
    }
);

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
  readInvoicePaymentEvidence(input: {
    invoiceId: string;
    orderId: string;
    signal?: AbortSignal;
  }): Promise<ProviderResult<PaymentInvoicePaymentEvidence>>;
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
