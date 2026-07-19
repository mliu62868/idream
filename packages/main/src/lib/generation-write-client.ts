"use client";

import {
  parseGenerationQuoteResponse,
  type RuntimeGenerationQuote,
} from "@/lib/public-api-contracts";

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
};

type MediaVariationRequest = {
  consistencyMode: "balanced" | "strict" | "creative";
  createIdempotencyKey?: () => string;
  idempotencyKeys?: Map<string, string>;
  mediaId: string;
  outputCount: number;
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

async function requestIdempotentGenerationWrite(
  input: {
    body: Record<string, unknown>;
    createIdempotencyKey?: () => string;
    idempotencyKeys?: Map<string, string>;
    intentKind: "generation" | "media_variation";
    url: string;
  },
  fetcher: typeof fetch,
): Promise<GenerationWriteResult> {
  const semanticBody = Object.fromEntries(
    Object.entries(input.body).filter(
      ([key]) => key !== "quoteAuthority",
    ),
  );
  const intentKey = JSON.stringify({
    kind: input.intentKind,
    url: input.url,
    body: semanticBody,
  });
  const createKey =
    input.createIdempotencyKey ?? (() => crypto.randomUUID());
  const idempotencyKey =
    input.idempotencyKeys?.get(intentKey) ?? createKey();
  input.idempotencyKeys?.set(intentKey, idempotencyKey);

  const response = await fetcher(input.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(input.body),
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

  if (!response.ok || !raw?.ok || !raw.data?.job) {
    if (response.status >= 400 && response.status < 500) {
      input.idempotencyKeys?.delete(intentKey);
    }
    throw new GenerationRequestError(
      raw?.error?.message ?? "Generation failed.",
      response.status,
    );
  }

  input.idempotencyKeys?.delete(intentKey);
  return raw.data;
}

export function requestGenerationJobWithExactAuthority(
  input: GenerationSubmissionRequest,
  fetcher: typeof fetch = fetch,
) {
  return requestIdempotentGenerationWrite(
    {
      ...input,
      intentKind: "generation",
      url: "/api/v1/generation/jobs",
    },
    fetcher,
  );
}

export async function requestMediaVariationWithExactQuote(
  input: MediaVariationRequest,
  fetcher: typeof fetch = fetch,
): Promise<GenerationWriteResult> {
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
        outputCount: input.outputCount,
        consistencyMode: input.consistencyMode,
        orientation: quote.defaultOrientation,
        quoteAuthority: exactQuote.authority,
      },
      createIdempotencyKey: input.createIdempotencyKey,
      idempotencyKeys: input.idempotencyKeys,
      intentKind: "media_variation",
      url: `/api/v1/media/${encodeURIComponent(input.mediaId)}/variation`,
    },
    fetcher,
  );
}

function apiPayloadErrorMessage(payload: unknown) {
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
