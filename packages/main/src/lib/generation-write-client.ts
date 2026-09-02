"use client";

import {
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
};

type MediaVariationRequest = {
  consistencyMode: "balanced" | "strict" | "creative";
  createIdempotencyKey?: () => string;
  idempotencyKeys?: Map<string, string>;
  isCurrent?: () => boolean;
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
    const value = JSON.parse(record) as { kind: string; url: string; body: Record<string, unknown> };
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
    intentKind: "generation" | "media_variation" | "media_enhancement" | "generation_retry";
    url: string;
  },
  fetcher: GenerationFetcher,
): Promise<GenerationWriteResult> {
  const unconfirmed = unconfirmedGenerationWrite(input.intentKind, input.url, input.body, input.idempotencyKeys);
  // The map is an in-memory receipt: semantic matching ignores a later quote,
  // but replay preserves the entire originally submitted body and authority.
  const intentKey = unconfirmed?.record ?? JSON.stringify({ kind: input.intentKind, url: input.url, body: input.body });
  const createKey =
    input.createIdempotencyKey ?? (() => crypto.randomUUID());
  const idempotencyKey =
    unconfirmed?.key ?? createKey();
  input.idempotencyKeys?.set(intentKey, idempotencyKey);

  const response = await fetcher(input.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
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
    if (response.status >= 400 && response.status < 500) {
      if (input.idempotencyKeys?.get(intentKey) === idempotencyKey) input.idempotencyKeys.delete(intentKey);
    }
    throw new GenerationRequestError(
      raw?.error?.message ?? input.fallbackMessage,
      response.status,
    );
  }

  if (input.idempotencyKeys?.get(intentKey) === idempotencyKey) input.idempotencyKeys.delete(intentKey);
  return raw.data;
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
