"use client";

import { z } from "zod";
import {
  parseGenerationJobDetailResponse,
  parseGenerationQuoteResponse,
  type RuntimeGenerationQuote,
} from "@/lib/public-api-contracts";

export type GenerationFetcher = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;

export type GenerationQuoteAuthority = {
  profileId: string;
  profileVersion: number;
  routeFingerprint: string;
  pricingFingerprint: string;
  outputCount: number;
  costDreamcoins: number;
};

export type GenerationWriteJob = {
  id: string;
  mode: "image" | "video";
  status: string;
  costDreamcoins: number;
  outputCount: number;
  errorCode: string | null;
  createdAt: string;
};

export type GenerationWriteResult = {
  job: GenerationWriteJob;
  assets: unknown[];
};

type GenerationWriteEnvelope = {
  ok: boolean;
  data?: GenerationWriteResult;
  error?: { message?: string };
};

type GenerationSubmissionRequest = {
  body: Record<string, unknown>;
  createIdempotencyKey?: () => string;
  idempotencyKeys?: Map<string, string>;
  isCurrent?: () => boolean;
  persistence?: GenerationReceiptPersistence;
};

type MediaVariationRequest = {
  consistencyMode: "balanced" | "strict" | "creative";
  createIdempotencyKey?: () => string;
  idempotencyKeys?: Map<string, string>;
  isCurrent?: () => boolean;
  persistence?: GenerationReceiptPersistence;
  mediaId: string;
  model?: string;
  negativePrompt?: string;
  outputCount: number;
  prompt?: string;
  quote?: RuntimeGenerationQuote | null;
};

export class GenerationRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GenerationRequestError";
  }
}

type GenerationReceiptKind = "generation" | "media_variation" | "generation_retry" | "media_enhancement";
export type GenerationReceipt = {
  record: string;
  key: string;
  kind: GenerationReceiptKind;
  url: string;
  body: Record<string, unknown>;
};
export type GenerationReceiptPersistence = {
  ownerScope: string;
  storage?: Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">;
  onWarning?: (message: string) => void;
};
const receiptPrefix = "idream:generation-receipt:v1:";
const storageWarning = "This browser cannot save pending requests. Keep this page open until your job appears.";
const receiptQuoteSchema = z.object({
  profileId: z.string().min(1).max(160), profileVersion: z.number().int().positive(),
  routeFingerprint: z.string().regex(/^[a-f0-9]{64}$/), pricingFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  outputCount: z.number().int().min(1).max(8), costDreamcoins: z.number().int().nonnegative(),
});
const receiptRecordSchema = z.object({
  version: z.literal(1), ownerScope: z.string().startsWith("user:").max(240),
  record: z.string().max(24_000), idempotencyKey: z.string().min(8).max(160),
}).strict();

function receiptStorage(input: GenerationReceiptPersistence) {
  return input.storage ?? window.localStorage;
}
function receiptStorageKey(ownerScope: string, key: string) {
  return `${receiptPrefix}${encodeURIComponent(ownerScope)}:${encodeURIComponent(key)}`;
}
function parseGenerationReceipt(record: string, key: string): GenerationReceipt | null {
  const value = pendingWriteFromKey(record);
  if (!value || key.length < 8 || key.length > 160 || (value.requestKey !== undefined && value.requestKey !== key) ||
    !receiptQuoteSchema.safeParse(value.body.quoteAuthority).success) return null;
  const localId = "[A-Za-z0-9._~%\\-]+";
  if (value.kind === "generation") {
    if (value.url !== "/api/v1/generation/jobs" || !["image", "video"].includes(String(value.body.mode)) ||
      !Number.isInteger(value.body.outputCount) || Number(value.body.outputCount) < 1 || Number(value.body.outputCount) > 8) return null;
  } else if (value.kind === "media_variation") {
    if (!new RegExp(`^/api/v1/media/${localId}/variation$`).test(value.url) ||
      !Number.isInteger(value.body.outputCount) || Number(value.body.outputCount) < 1 || Number(value.body.outputCount) > 4 ||
      !["balanced", "strict", "creative"].includes(String(value.body.consistencyMode))) return null;
  } else if (value.kind === "generation_retry") {
    if (!new RegExp(`^/api/v1/generation/jobs/${localId}/retry$`).test(value.url)) return null;
  } else if (value.kind === "media_enhancement") {
    if (!new RegExp(`^/api/v1/media/${localId}/enhance$`).test(value.url) || value.body.scale !== 2) return null;
  } else return null;
  // Stored IDs must stay a single local path segment, including after decoding.
  try {
    if (value.url.split("/").some((part) => {
      const decoded = decodeURIComponent(part);
      return decoded === "." || decoded === ".." || /[/\\]/.test(decoded);
    })) return null;
  } catch { return null; }
  return { record, key, ...value, kind: value.kind };
}

export function listGenerationReceipts(keys: ReadonlyMap<string, string>): GenerationReceipt[] {
  return [...keys].flatMap(([record, key]) => {
    const receipt = parseGenerationReceipt(record, key);
    return receipt ? [receipt] : [];
  });
}

export function readGenerationReceipts(input: GenerationReceiptPersistence): GenerationReceipt[] {
  const receipts: GenerationReceipt[] = [];
  try {
    const storage = receiptStorage(input);
    const ownerPrefix = `${receiptPrefix}${encodeURIComponent(input.ownerScope)}:`;
    for (let index = 0; index < storage.length; index += 1) {
      const name = storage.key(index);
      if (!name?.startsWith(ownerPrefix)) continue;
      const raw = storage.getItem(name);
      let receipt: GenerationReceipt | null = null;
      try {
        const saved = receiptRecordSchema.parse(JSON.parse(raw ?? "null"));
        if (saved.ownerScope === input.ownerScope && name === receiptStorageKey(input.ownerScope, saved.idempotencyKey)) {
          receipt = parseGenerationReceipt(saved.record, saved.idempotencyKey);
        }
      } catch { /* An invalid local record never becomes a callable URL. */ }
      if (receipt) receipts.push(receipt);
      else input.onWarning?.("A saved request could not be restored. Check Jobs or contact support before repeating it.");
    }
  } catch { input.onWarning?.(storageWarning); }
  return receipts;
}

function saveGenerationReceipt(input: GenerationReceiptPersistence | undefined, record: string, key: string) {
  if (!input) return;
  try {
    receiptStorage(input).setItem(receiptStorageKey(input.ownerScope, key), JSON.stringify({
      version: 1, ownerScope: input.ownerScope, record, idempotencyKey: key,
    }));
  } catch { input.onWarning?.(storageWarning); }
}

function removeGenerationReceipt(input: GenerationReceiptPersistence | undefined, record: string, key: string) {
  if (!input) return;
  try {
    const storage = receiptStorage(input);
    const name = receiptStorageKey(input.ownerScope, key);
    const raw = storage.getItem(name);
    // A late response must not erase a different request's saved authority.
    if (raw && JSON.parse(raw).record === record) storage.removeItem(name);
  } catch { input.onWarning?.("The accepted request could not be cleared from this browser. Checking it again will return the same job."); }
}

export function requestGenerationReceipt(
  receipt: GenerationReceipt,
  input: { idempotencyKeys: Map<string, string>; persistence?: GenerationReceiptPersistence; isCurrent?: () => boolean },
  fetcher: GenerationFetcher = fetch,
) {
  const checked = parseGenerationReceipt(receipt.record, receipt.key);
  if (!checked || input.idempotencyKeys.get(receipt.record) !== receipt.key) {
    return Promise.reject(new GenerationRequestError("This pending request is no longer available. Refresh Jobs.", 409));
  }
  return requestIdempotentGenerationWrite({ ...input, body: checked.body, url: checked.url, intentKind: checked.kind, replayReceipt: checked,
    fallbackMessage: "The original request could not be confirmed. Check it again or contact support.",
  }, fetcher);
}

export function exactGenerationQuoteForCount(
  quote: RuntimeGenerationQuote | null,
  outputCount: number,
) {
  if (!quote || outputCount < 1 || outputCount > quote.maxCount) {
    return null;
  }
  const cost = quote.costs.find(
    (entry) => entry.outputCount === outputCount,
  );
  if (!cost) return null;
  return {
    costDreamcoins: cost.costDreamcoins,
    affordable: cost.costDreamcoins <= quote.balance,
    authority: {
      profileId: quote.profileId,
      profileVersion: quote.profileVersion,
      routeFingerprint: quote.routeFingerprint,
      pricingFingerprint: quote.pricing.fingerprint,
      outputCount,
      costDreamcoins: cost.costDreamcoins,
    } satisfies GenerationQuoteAuthority,
  };
}

function generationWriteIntentKey(kind: string, url: string, body: Record<string, unknown>) {
  return JSON.stringify({
    kind,
    url,
    body: Object.fromEntries(Object.entries(body).filter(([key]) => key !== "quoteAuthority")),
  });
}

function pendingWriteFromKey(record: string) {
  try {
    const value = JSON.parse(record) as { kind: string; url: string; body: Record<string, unknown>; requestKey?: string };
    return typeof value.kind === "string" && typeof value.url === "string" &&
      value.body && typeof value.body === "object" && !Array.isArray(value.body) ? value : null;
  } catch { return null; }
}

function unconfirmedGenerationWrite(kind: string, url: string, body: Record<string, unknown>, keys?: ReadonlyMap<string, string>) {
  const requested = generationWriteIntentKey(kind, url, body);
  for (const [record, key] of keys ?? []) {
    const pending = pendingWriteFromKey(record);
    if (pending && generationWriteIntentKey(pending.kind, pending.url, pending.body) === requested) {
      return { record, key, body: pending.body };
    }
  }
  return null;
}

export function hasUnconfirmedMediaEnhancement(mediaId: string, keys?: ReadonlyMap<string, string>) {
  return unconfirmedGenerationWrite("media_enhancement", `/api/v1/media/${encodeURIComponent(mediaId)}/enhance`, { scale: 2 }, keys) !== null;
}

export function hasUnconfirmedGenerationSubmission(body: Record<string, unknown>, keys?: ReadonlyMap<string, string>) {
  return unconfirmedGenerationWrite("generation", "/api/v1/generation/jobs", body, keys) !== null;
}

export function hasUnconfirmedGenerationRetry(jobId: string, keys?: ReadonlyMap<string, string>) {
  return unconfirmedGenerationWrite("generation_retry", `/api/v1/generation/jobs/${encodeURIComponent(jobId)}/retry`, {}, keys) !== null;
}

function mediaVariationBody(input: MediaVariationRequest, orientation?: string) {
  return {
    model: input.model,
    prompt: input.prompt,
    negativePrompt: input.negativePrompt,
    outputCount: input.outputCount,
    consistencyMode: input.consistencyMode,
    orientation,
  };
}

function unconfirmedMediaVariationBody(input: MediaVariationRequest, keys = input.idempotencyKeys) {
  // Orientation is chosen by the quote, not by this action's user inputs. A
  // later route must not turn a check of the accepted request into a new one.
  const requested = JSON.stringify(mediaVariationBody(input));
  for (const key of keys?.keys() ?? []) {
    const intent = pendingWriteFromKey(key);
    if (intent?.kind !== "media_variation" || intent.url !== `/api/v1/media/${encodeURIComponent(input.mediaId)}/variation`) continue;
    if (JSON.stringify({ ...intent.body, orientation: undefined, quoteAuthority: undefined }) === requested) return intent.body;
  }
  return null;
}

export function hasUnconfirmedMediaVariation(input: MediaVariationRequest, keys = input.idempotencyKeys) {
  return unconfirmedMediaVariationBody(input, keys) !== null;
}

async function requestIdempotentGenerationWrite(
  input: {
    body: Record<string, unknown>;
    createIdempotencyKey?: () => string;
    // Each intent names its own failure, so a retry never reports itself as a
    // fresh generation.
    fallbackMessage: string;
    idempotencyKeys?: Map<string, string>;
    isCurrent?: () => boolean;
    persistence?: GenerationReceiptPersistence;
    replayReceipt?: GenerationReceipt;
    intentKind: "generation" | "media_variation" | "media_enhancement" | "generation_retry";
    url: string;
  },
  fetcher: GenerationFetcher,
): Promise<GenerationWriteResult> {
  if (input.isCurrent?.() === false) throw new DOMException("Viewer changed", "AbortError");
  const unconfirmed = input.replayReceipt ?? unconfirmedGenerationWrite(input.intentKind, input.url, input.body, input.idempotencyKeys);
  // The map is an in-memory receipt: semantic matching ignores a later quote,
  // but replay preserves the entire originally submitted body and authority.
  const createKey =
    input.createIdempotencyKey ?? (() => crypto.randomUUID());
  const idempotencyKey =
    unconfirmed?.key ?? createKey();
  // Two tabs can independently submit the same body before either sees the
  // other's receipt. Keep both requests addressable in the existing Map.
  const intentKey = unconfirmed?.record ?? JSON.stringify({ kind: input.intentKind, url: input.url, body: input.body, requestKey: idempotencyKey });
  input.idempotencyKeys?.set(intentKey, idempotencyKey);
  saveGenerationReceipt(input.persistence, intentKey, idempotencyKey);

  const response = await fetcher(input.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      ...(input.persistence ? { "x-idream-viewer-scope": input.persistence.ownerScope } : {}),
    },
    body: JSON.stringify(unconfirmed?.body ?? input.body),
  });
  let raw: GenerationWriteEnvelope | null = null;
  try {
    raw = (await response.json()) as GenerationWriteEnvelope;
  } catch {
    throw new GenerationRequestError(
      "The generation response was interrupted. Retry to check the same request.",
      response.status,
    );
  }

  // Reading the body can outlive the viewer context even after headers arrive.
  // Keep the receipt when that context can no longer publish the accepted job.
  if (input.isCurrent?.() === false) throw new DOMException("Viewer changed", "AbortError");

  if (!response.ok || !raw?.ok || !raw.data?.job) {
    // A rejection of a later check says nothing about the earlier POST, which
    // may still be committing or may precede today's auth/schema/route rules.
    if (!unconfirmed && response.status >= 400 && response.status < 500) {
      if (input.idempotencyKeys?.get(intentKey) === idempotencyKey) input.idempotencyKeys.delete(intentKey);
      removeGenerationReceipt(input.persistence, intentKey, idempotencyKey);
    }
    throw new GenerationRequestError(
      raw?.error?.message ?? input.fallbackMessage,
      response.status,
    );
  }

  // A malformed 2xx is still ambiguous; only the normal Job DTO is an ACK.
  const result = parseGenerationJobDetailResponse(raw);
  if (input.idempotencyKeys?.get(intentKey) === idempotencyKey) input.idempotencyKeys.delete(intentKey);
  removeGenerationReceipt(input.persistence, intentKey, idempotencyKey);
  return result;
}

export function requestGenerationJobWithExactAuthority(
  input: GenerationSubmissionRequest,
  fetcher: GenerationFetcher = fetch,
) {
  return requestIdempotentGenerationWrite(
    {
      ...input,
      fallbackMessage: "Generation failed.",
      intentKind: "generation",
      url: "/api/v1/generation/jobs",
    },
    fetcher,
  );
}

/**
 * A retry is a second write against the same failed job, so its intent — and
 * therefore its idempotency key — is identified by the job's own URL.
 */
export async function requestGenerationRetryWithExactAuthority(
  input: {
    createIdempotencyKey?: () => string;
    idempotencyKeys?: Map<string, string>;
    isCurrent?: () => boolean;
    persistence?: GenerationReceiptPersistence;
    jobId: string;
    quoteAuthority?: GenerationQuoteAuthority;
  },
  fetcher: GenerationFetcher = fetch,
): Promise<GenerationWriteJob> {
  if (!input.quoteAuthority && !hasUnconfirmedGenerationRetry(input.jobId, input.idempotencyKeys)) {
    throw new GenerationRequestError("The exact retry price is unavailable.", 409);
  }
  const result = await requestIdempotentGenerationWrite(
    {
      body: { quoteAuthority: input.quoteAuthority },
      createIdempotencyKey: input.createIdempotencyKey,
      fallbackMessage: "Retry failed",
      idempotencyKeys: input.idempotencyKeys,
      isCurrent: input.isCurrent,
      persistence: input.persistence,
      intentKind: "generation_retry",
      url: `/api/v1/generation/jobs/${encodeURIComponent(input.jobId)}/retry`,
    },
    fetcher,
  );
  return result.job;
}

export async function requestMediaVariationWithExactQuote(
  input: MediaVariationRequest,
  fetcher: GenerationFetcher = fetch,
): Promise<GenerationWriteResult> {
  const unconfirmed = unconfirmedMediaVariationBody(input);
  if (unconfirmed) return requestIdempotentGenerationWrite({
    body: unconfirmed,
    createIdempotencyKey: input.createIdempotencyKey,
    idempotencyKeys: input.idempotencyKeys,
    isCurrent: input.isCurrent,
    persistence: input.persistence,
    fallbackMessage: "Variation could not be confirmed. Retry to check the same request.",
    intentKind: "media_variation",
    url: `/api/v1/media/${encodeURIComponent(input.mediaId)}/variation`,
  }, fetcher);
  let quote = input.quote ?? null;
  if (!quote) {
    const quoteResponse = await fetcher(
      `/api/v1/media/${encodeURIComponent(input.mediaId)}/variation/quote`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          consistencyMode: input.consistencyMode,
          model: input.model,
        }),
      },
    );
    const quoteRaw: unknown = await quoteResponse
      .json()
      .catch(() => null);
    if (!quoteResponse.ok) {
      throw new GenerationRequestError(
        apiPayloadErrorMessage(quoteRaw) ??
          "The exact variation price is unavailable.",
        quoteResponse.status,
      );
    }
    quote = parseGenerationQuoteResponse(quoteRaw).quote;
  }

  const exactQuote = exactGenerationQuoteForCount(
    quote,
    input.outputCount,
  );
  if (!exactQuote) {
    throw new GenerationRequestError(
      "The requested variation count is unavailable for this exact route.",
      400,
    );
  }
  if (!exactQuote.affordable) {
    throw new GenerationRequestError(
      `Need ${exactQuote.costDreamcoins} coins · you have ${quote.balance}.`,
      402,
    );
  }

  return requestIdempotentGenerationWrite(
    {
      body: {
        ...mediaVariationBody(input, quote.defaultOrientation),
        quoteAuthority: exactQuote.authority,
      },
      createIdempotencyKey: input.createIdempotencyKey,
      fallbackMessage: "Generation failed.",
      idempotencyKeys: input.idempotencyKeys,
      isCurrent: input.isCurrent,
      persistence: input.persistence,
      intentKind: "media_variation",
      url: `/api/v1/media/${encodeURIComponent(input.mediaId)}/variation`,
    },
    fetcher,
  );
}

export function requestMediaEnhancementWithExactQuote(
  input: {
    mediaId: string;
    quote: RuntimeGenerationQuote | null;
    createIdempotencyKey?: () => string;
    idempotencyKeys?: Map<string, string>;
    isCurrent?: () => boolean;
    persistence?: GenerationReceiptPersistence;
  },
  fetcher: GenerationFetcher = fetch,
): Promise<GenerationWriteResult> {
  const exactQuote = exactGenerationQuoteForCount(input.quote, 1);
  const unconfirmed = hasUnconfirmedMediaEnhancement(input.mediaId, input.idempotencyKeys);
  if (!exactQuote && !unconfirmed) {
    return Promise.reject(new GenerationRequestError("The exact enhancement price is unavailable.", 400));
  }
  // An accepted request may have consumed the balance before its response was
  // lost. Replaying its key checks that request; it cannot bypass Main's debit.
  if (exactQuote && !exactQuote.affordable && !unconfirmed) {
    return Promise.reject(new GenerationRequestError(
      `Need ${exactQuote.costDreamcoins} coins · you have ${input.quote?.balance ?? 0}.`, 402,
    ));
  }
  return requestIdempotentGenerationWrite({
    body: { scale: 2, quoteAuthority: exactQuote?.authority },
    createIdempotencyKey: input.createIdempotencyKey,
    idempotencyKeys: input.idempotencyKeys,
    isCurrent: input.isCurrent,
    persistence: input.persistence,
    fallbackMessage: "Enhancement could not be confirmed. Retry to check the same request.",
    intentKind: "media_enhancement",
    url: `/api/v1/media/${encodeURIComponent(input.mediaId)}/enhance`,
  }, fetcher);
}

export function apiPayloadErrorMessage(payload: unknown) {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return undefined;
  }
  const error = (payload as Record<string, unknown>).error;
  if (
    typeof error !== "object" ||
    error === null ||
    Array.isArray(error)
  ) {
    return undefined;
  }
  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" ? message : undefined;
}
