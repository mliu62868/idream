"use client";

import { isTerminalGenerationJobStatus } from "@idream/shared/catalog";
import {
  parseGenerationQuoteResponse,
  parseGenerationRetryQuoteResponse,
  type RuntimeGenerationQuote,
  type RuntimeGenerationRetryQuote,
} from "@/lib/public-api-contracts";
import {
  GenerationRequestError,
  apiPayloadErrorMessage,
  exactGenerationQuoteForCount,
  requestGenerationJobWithExactAuthority,
  requestGenerationRetryWithExactAuthority,
  requestMediaVariationWithExactQuote,
  type GenerationQuoteAuthority,
  type GenerationWriteJob,
} from "@/lib/generation-write-client";

// SPEC: one generation request, from the priced quote that authorizes it to the
// terminal job it becomes. The chain has server facts at every link — the quote
// fingerprints, the idempotency key, the job status — so it is modelled as an
// explicit state plus pure transitions rather than as scattered component state.
//
// INTENT: nothing here touches React, `window`, or a bare `fetch`. Transport is
// injected, so every invariant below is exercisable without a DOM. The React
// binding is `@/hooks/useGenerationRequest`.

export type ConsistencyMode = "balanced" | "strict" | "creative";
export type GenerationMode = "image" | "video";

const QUOTE_UNAVAILABLE = "The exact generation price is unavailable.";
const RETRY_QUOTE_UNAVAILABLE = "The exact retry price is unavailable.";
const RETRY_QUOTE_MISSING = "Wait for the exact retry price before retrying.";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * INVARIANT: a quote is only ever readable through the key it was priced for.
 * The key encodes the whole route (viewer scope, mode, target, consistency,
 * look, explicit model); when any of it changes the old quote stops being
 * visible instead of silently authorizing a different request.
 */
export type GenerationRequestState = {
  quote: { key: string; quote: RuntimeGenerationQuote } | null;
  quoteFailure: { key: string; message: string } | null;
  /** Bumped to ask the owner to re-price; the fetch itself lives outside. */
  quoteNonce: number;
  retryQuotes: Readonly<Record<string, RuntimeGenerationRetryQuote>>;
  retryQuoteFailures: Readonly<Record<string, string>>;
  retryQuoteNonce: number;
  submitting: boolean;
  retryingJobIds: ReadonlySet<string>;
  variationPendingMediaIds: ReadonlySet<string>;
};

export function initialGenerationRequestState(): GenerationRequestState {
  return {
    quote: null,
    quoteFailure: null,
    quoteNonce: 0,
    retryQuotes: {},
    retryQuoteFailures: {},
    retryQuoteNonce: 0,
    submitting: false,
    retryingJobIds: new Set(),
    variationPendingMediaIds: new Set(),
  };
}

/** Which write is in flight. Each one settles differently. */
export type GenerationWriteKind =
  | { kind: "generation" }
  | { kind: "variation"; mediaId: string }
  | { kind: "retry"; jobId: string };

export type GenerationAuthorityAction =
  | "refresh_balance_and_quote"
  | "refresh_quote"
  | "none";

export type GenerationWriteOutcome =
  | { kind: "queued"; job: GenerationWriteJob; statusMessage: string }
  | {
      kind: "rejected";
      statusMessage: string;
      authorityAction: GenerationAuthorityAction;
    };

export type GenerationRequestAction =
  | { type: "quote_pending" }
  | { type: "quote_resolved"; key: string; quote: RuntimeGenerationQuote }
  | { type: "quote_failed"; key: string; message: string }
  | { type: "retry_quotes_pending" }
  | {
      type: "retry_quotes_resolved";
      quotes: Record<string, RuntimeGenerationRetryQuote>;
      failures: Record<string, string>;
    }
  | { type: "balance_changed" }
  | { type: "write_started"; write: GenerationWriteKind }
  | {
      type: "write_settled";
      write: GenerationWriteKind;
      outcome: GenerationWriteOutcome;
      /**
       * The main quote key this write consumed, or null when it did not consume
       * one (a gallery variation prices itself; a retry uses its own quote).
       */
      quoteKey: string | null;
    }
  | { type: "viewer_scope_reset" };

// SPEC: 402 means the balance moved under us — the coin count and the price are
// both suspect. 409 means the route or the price list moved — only the quote is.
export function generationAuthorityActionForStatus(
  status: number,
): GenerationAuthorityAction {
  if (status === 402) return "refresh_balance_and_quote";
  if (status === 409) return "refresh_quote";
  return "none";
}

function withoutMember<T>(set: ReadonlySet<T>, member: T): ReadonlySet<T> {
  const next = new Set(set);
  next.delete(member);
  return next;
}

/**
 * INVARIANT: coins moving invalidates affordability. The quote is dropped, its
 * failure with it, and both price lists are asked to reprice — a submission can
 * never carry a price that predates the balance it was checked against.
 */
function afterBalanceChange(
  state: GenerationRequestState,
): GenerationRequestState {
  return {
    ...state,
    quote: null,
    quoteFailure: null,
    quoteNonce: state.quoteNonce + 1,
    retryQuoteNonce: state.retryQuoteNonce + 1,
  };
}

function afterWriteRejection(
  state: GenerationRequestState,
  action: Extract<GenerationRequestAction, { type: "write_settled" }>,
  outcome: Extract<GenerationWriteOutcome, { kind: "rejected" }>,
): GenerationRequestState {
  if (outcome.authorityAction === "refresh_balance_and_quote") {
    return afterBalanceChange(state);
  }
  if (outcome.authorityAction !== "refresh_quote") return state;
  if (action.write.kind === "retry") {
    return { ...state, retryQuoteNonce: state.retryQuoteNonce + 1 };
  }
  // A write that priced itself leaves the form's quote alone: it never spoke
  // for the route the form is showing.
  if (!action.quoteKey) return state;
  return {
    ...state,
    quote: null,
    quoteFailure: { key: action.quoteKey, message: outcome.statusMessage },
    quoteNonce: state.quoteNonce + 1,
  };
}

export function reduceGenerationRequest(
  state: GenerationRequestState,
  action: GenerationRequestAction,
): GenerationRequestState {
  switch (action.type) {
    case "quote_pending":
      return { ...state, quote: null, quoteFailure: null };
    case "quote_resolved":
      return {
        ...state,
        quote: { key: action.key, quote: action.quote },
        quoteFailure: null,
      };
    case "quote_failed":
      return {
        ...state,
        quote: null,
        quoteFailure: { key: action.key, message: action.message },
      };
    case "retry_quotes_pending":
      return { ...state, retryQuotes: {}, retryQuoteFailures: {} };
    case "retry_quotes_resolved":
      return {
        ...state,
        retryQuotes: action.quotes,
        retryQuoteFailures: action.failures,
      };
    case "balance_changed":
      return afterBalanceChange(state);
    case "write_started":
      if (action.write.kind === "generation") {
        return { ...state, submitting: true };
      }
      if (action.write.kind === "retry") {
        return {
          ...state,
          retryingJobIds: new Set(state.retryingJobIds).add(action.write.jobId),
        };
      }
      return {
        ...state,
        variationPendingMediaIds: new Set(state.variationPendingMediaIds).add(
          action.write.mediaId,
        ),
      };
    case "write_settled": {
      const settled: GenerationRequestState =
        action.write.kind === "generation"
          ? { ...state, submitting: false }
          : action.write.kind === "retry"
            ? {
                ...state,
                retryingJobIds: withoutMember(
                  state.retryingJobIds,
                  action.write.jobId,
                ),
              }
            : {
                ...state,
                variationPendingMediaIds: withoutMember(
                  state.variationPendingMediaIds,
                  action.write.mediaId,
                ),
              };
      if (action.outcome.kind === "queued") return afterBalanceChange(settled);
      return afterWriteRejection(settled, action, action.outcome);
    }
    case "viewer_scope_reset":
      return {
        ...initialGenerationRequestState(),
        quoteNonce: state.quoteNonce,
        retryQuoteNonce: state.retryQuoteNonce,
      };
  }
}

// ---------------------------------------------------------------------------
// Derived view
// ---------------------------------------------------------------------------

/**
 * SPEC: what the generation config currently authorizes.
 *
 * - `ready` — config loaded and the viewer is signed in.
 * - `anonymous` — config loaded, no viewer. Prices are visible, writes are not.
 * - `suspended` — config withdrawn pending revalidation. No error is shown
 *   because nothing is known to be wrong yet.
 * - `revoked` — config withdrawn after a failure, with the failure on screen.
 */
export type GeneratorConfigAuthority =
  | "ready"
  | "anonymous"
  | "suspended"
  | "revoked";

export function generatorConfigAuthorityState(
  config: { viewer: { authenticated: boolean } } | null,
  configError: string,
): GeneratorConfigAuthority {
  if (config) return config.viewer.authenticated ? "ready" : "anonymous";
  return configError ? "revoked" : "suspended";
}

/** `suspended`/`revoked` mean the config is gone, not merely unauthenticated. */
function configIsLoaded(authority: GeneratorConfigAuthority) {
  return authority === "ready" || authority === "anonymous";
}

export type GenerationRequestViewInput = {
  /** Null when the current form does not describe a priceable route. */
  quoteKey: string | null;
  configAuthority: GeneratorConfigAuthority;
  mode: GenerationMode;
  /** The requested count before the quote's ceiling is applied. */
  count: number;
  modeAvailable: boolean;
  /** A character, freeplay, or an image-edit source — something to generate for. */
  hasTarget: boolean;
  /** False only while image-edit is selected without a source picked. */
  hasEditSource: boolean;
};

export type GenerationRequestView = {
  quote: RuntimeGenerationQuote | null;
  quoteError: string;
  maxCount: number;
  orientations: readonly string[];
  outputCount: number;
  exactQuote: ReturnType<typeof exactGenerationQuoteForCount>;
  estimatedCost: number | null;
  insufficientBalance: boolean;
  canSubmit: boolean;
  submitting: boolean;
};

export function projectGenerationRequest(
  state: GenerationRequestState,
  input: GenerationRequestViewInput,
): GenerationRequestView {
  const quote =
    input.quoteKey && state.quote?.key === input.quoteKey
      ? state.quote.quote
      : null;
  const quoteError =
    input.quoteKey && state.quoteFailure?.key === input.quoteKey
      ? state.quoteFailure.message
      : "";
  const maxCount = quote?.maxCount ?? 1;
  // Video is priced and delivered one clip at a time; the count control is an
  // image-only affordance.
  const outputCount = input.mode === "video" ? 1 : countWithinCeiling(input.count, maxCount);
  const exactQuote = exactGenerationQuoteForCount(quote, outputCount);
  const estimatedCost = exactQuote?.costDreamcoins ?? null;
  const configLoaded = configIsLoaded(input.configAuthority);
  const insufficientBalance =
    configLoaded && estimatedCost !== null && exactQuote?.affordable === false;

  return {
    quote,
    quoteError,
    maxCount,
    orientations: quote?.orientations ?? [],
    outputCount,
    exactQuote,
    estimatedCost,
    insufficientBalance,
    submitting: state.submitting,
    // INVARIANT: only `ready` authority may submit. `anonymous` can see a price
    // but not spend; `suspended`/`revoked` have no config to price against.
    canSubmit:
      !state.submitting &&
      input.hasTarget &&
      input.configAuthority === "ready" &&
      estimatedCost !== null &&
      input.modeAvailable &&
      input.hasEditSource &&
      !insufficientBalance,
  };
}

function countWithinCeiling(count: number, maxCount: number) {
  return Math.max(1, Math.min(count, maxCount));
}

/** The quote is authority over how many outputs may be asked for. */
export function countWithinQuote(count: number, quote: RuntimeGenerationQuote) {
  return countWithinCeiling(count, quote.maxCount);
}

/** …and over which aspect ratios exist on the resolved route. */
export function orientationWithinQuote(
  orientation: string,
  quote: RuntimeGenerationQuote,
) {
  return quote.orientations.includes(orientation)
    ? orientation
    : quote.defaultOrientation;
}

// ---------------------------------------------------------------------------
// Job lifecycle
// ---------------------------------------------------------------------------

export type GenerationJobFact = {
  id: string;
  mode: GenerationMode;
  status: string;
  errorCode: string | null;
};

/**
 * INVARIANT: polling stops at a terminal status and nowhere else. `queued`,
 * `running`, and both moderation waypoints are still in motion.
 */
export function pendingGenerationJobIds(
  jobs: readonly GenerationJobFact[],
): string[] {
  return jobs
    .filter((job) => !isTerminalGenerationJobStatus(job.status))
    .map((job) => job.id);
}

export function settledGenerationStatusMessage(job: GenerationJobFact) {
  if (job.status === "blocked") {
    return job.errorCode ? `Blocked: ${job.errorCode}` : "Blocked.";
  }
  if (job.status === "failed") {
    return job.errorCode ? `Failed: ${job.errorCode}` : "Failed.";
  }
  if (job.status === "refunded") return "Refunded.";
  return "Generation stopped.";
}

export type ServerJobArrival = {
  settled: boolean;
  /** Null while the job is still in motion — no news is not news. */
  statusMessage: string | null;
  /** Completed jobs hand back assets and pull the gallery to their mode. */
  showResults: boolean;
  /** Every terminal status moved coins: spent, or refunded back. */
  refreshBalanceAndQuote: boolean;
};

export function projectServerJobArrival(job: GenerationJobFact): ServerJobArrival {
  const settled = isTerminalGenerationJobStatus(job.status);
  const completed = job.status === "completed";
  return {
    settled,
    statusMessage: completed
      ? "Generation complete."
      : settled
        ? settledGenerationStatusMessage(job)
        : null,
    showResults: completed,
    refreshBalanceAndQuote: settled,
  };
}

// ---------------------------------------------------------------------------
// Quote transport
// ---------------------------------------------------------------------------

export type GenerationQuoteIntent = {
  key: string;
} & (
  | {
      target: "variation";
      mediaId: string;
      consistencyMode: ConsistencyMode;
      model?: string;
    }
  | {
      target: "generation";
      mode: GenerationMode;
      characterId?: string;
      freeplay: boolean;
      consistencyMode: ConsistencyMode;
      model?: string;
      lookId?: string;
    }
);

export type GenerationQuoteOutcome =
  | { kind: "discarded" }
  | { kind: "resolved"; key: string; quote: RuntimeGenerationQuote }
  | { kind: "failed"; key: string; message: string };

type TransportDeps = {
  fetcher?: typeof fetch;
  signal?: AbortSignal;
};

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function requestErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export async function loadGenerationQuote(
  intent: GenerationQuoteIntent,
  deps: TransportDeps = {},
): Promise<GenerationQuoteOutcome> {
  const fetcher = deps.fetcher ?? fetch;
  const url =
    intent.target === "variation"
      ? `/api/v1/media/${encodeURIComponent(intent.mediaId)}/variation/quote`
      : "/api/v1/generation/quote";
  const body =
    intent.target === "variation"
      ? { consistencyMode: intent.consistencyMode, model: intent.model }
      : {
          mode: intent.mode,
          characterId: intent.freeplay ? undefined : intent.characterId,
          freeplay: intent.freeplay,
          consistencyMode: intent.consistencyMode,
          // Priced per output elsewhere; one is enough to resolve the route.
          outputCount: 1,
          controls: { model: intent.model, lookId: intent.lookId },
        };

  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      signal: deps.signal,
      body: JSON.stringify(body),
    });
    const raw: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(apiPayloadErrorMessage(raw) ?? QUOTE_UNAVAILABLE);
    }
    const data = parseGenerationQuoteResponse(raw);
    if (deps.signal?.aborted) return { kind: "discarded" };
    return { kind: "resolved", key: intent.key, quote: data.quote };
  } catch (error) {
    if (deps.signal?.aborted || isAbortError(error)) return { kind: "discarded" };
    return {
      kind: "failed",
      key: intent.key,
      message: requestErrorMessage(error, QUOTE_UNAVAILABLE),
    };
  }
}

export type GenerationRetryQuotesOutcome =
  | { kind: "discarded" }
  | {
      kind: "resolved";
      quotes: Record<string, RuntimeGenerationRetryQuote>;
      failures: Record<string, string>;
    };

export async function loadGenerationRetryQuotes(
  jobIds: readonly string[],
  deps: TransportDeps = {},
): Promise<GenerationRetryQuotesOutcome> {
  const fetcher = deps.fetcher ?? fetch;
  const results = await Promise.all(
    jobIds.map(async (jobId) => {
      try {
        const response = await fetcher(
          `/api/v1/generation/jobs/${encodeURIComponent(jobId)}/retry/quote`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            cache: "no-store",
            signal: deps.signal,
            body: "{}",
          },
        );
        const raw: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(
            apiPayloadErrorMessage(raw) ?? RETRY_QUOTE_UNAVAILABLE,
          );
        }
        return {
          jobId,
          quote: parseGenerationRetryQuoteResponse(raw).quote,
          error: null,
        };
      } catch (error) {
        if (deps.signal?.aborted || isAbortError(error)) return null;
        return {
          jobId,
          quote: null,
          error: requestErrorMessage(error, RETRY_QUOTE_UNAVAILABLE),
        };
      }
    }),
  );
  if (deps.signal?.aborted) return { kind: "discarded" };

  const quotes: Record<string, RuntimeGenerationRetryQuote> = {};
  const failures: Record<string, string> = {};
  for (const result of results) {
    if (!result) continue;
    if (result.quote) quotes[result.jobId] = result.quote;
    if (result.error) failures[result.jobId] = result.error;
  }
  return { kind: "resolved", quotes, failures };
}

// ---------------------------------------------------------------------------
// Write protocol
// ---------------------------------------------------------------------------

/**
 * SPEC: one map per write intent. An entry survives only an *ambiguous* failure
 * — the write client removes it on success and on a 4xx, so the key rotates
 * exactly when the previous attempt is known not to have committed.
 */
export type GenerationIdempotencyKeys = {
  generation: Map<string, string>;
  variation: Map<string, string>;
  retry: Map<string, string>;
};

export function createGenerationIdempotencyKeys(): GenerationIdempotencyKeys {
  return { generation: new Map(), variation: new Map(), retry: new Map() };
}

export function clearGenerationIdempotencyKeys(keys: GenerationIdempotencyKeys) {
  keys.generation.clear();
  keys.variation.clear();
  keys.retry.clear();
}

/**
 * What the owning surface must do that this module cannot: it does not own the
 * jobs projection, the status line, the view, or the coin balance.
 */
export type GenerationRequestEffects = {
  applyJob: (job: GenerationWriteJob) => void;
  showStatus: (message: string) => void;
  /** A write was accepted — reveal where its progress is visible. */
  revealJobs: () => void;
  /** Coins moved; re-read the viewer's balance. */
  refreshBalance: () => void;
  /** Follow this job until it settles. */
  trackJob: (jobId: string) => void;
};

export type GenerationWriteRequest =
  | {
      kind: "generation";
      body: Record<string, unknown>;
      /** The quote key whose authority is inside `body.quoteAuthority`. */
      quoteKey: string | null;
      quote: RuntimeGenerationQuote | null;
    }
  | {
      kind: "variation";
      mediaId: string;
      outputCount: number;
      consistencyMode: ConsistencyMode;
      model?: string;
      /** Null lets the write client price the variation itself. */
      quote: RuntimeGenerationQuote | null;
      /** Non-null only when the form's own quote is the one being spent. */
      quoteKey: string | null;
      queuedMessage: string;
    }
  | { kind: "retry"; jobId: string };

export type GenerationRequestContext = {
  state: GenerationRequestState;
  dispatch: (action: GenerationRequestAction) => void;
  effects: GenerationRequestEffects;
  keys: GenerationIdempotencyKeys;
  fetcher?: typeof fetch;
};

/**
 * INVARIANT: the four fingerprints a submission carries must be the ones the
 * currently held quote was priced under. The server rejects a mismatch too, but
 * a request built from a quote we no longer hold must not leave the browser.
 */
export function quoteAuthorityMatchesQuote(
  authority: GenerationQuoteAuthority | null | undefined,
  quote: RuntimeGenerationQuote | null,
): boolean {
  if (!authority || !quote) return false;
  return (
    authority.profileId === quote.profileId &&
    authority.profileVersion === quote.profileVersion &&
    authority.routeFingerprint === quote.routeFingerprint &&
    authority.pricingFingerprint === quote.pricing.fingerprint
  );
}

export type GenerationRetryRefusal =
  /** Already in flight — the click is a duplicate and says nothing new. */
  | { reason: "in_flight" }
  | { reason: "no_quote"; message: string }
  | { reason: "unaffordable"; message: string };

/**
 * Why a retry cannot be sent, or null when it can. Answered before anything is
 * marked in flight, so a refused retry never flashes a spinner.
 *
 * INVARIANT: a retry is never sent without its own exact quote. The main form's
 * quote prices a different route and cannot stand in for it.
 */
export function generationRetryRefusal(
  state: GenerationRequestState,
  jobId: string,
): GenerationRetryRefusal | null {
  if (state.retryingJobIds.has(jobId)) return { reason: "in_flight" };
  const quote = state.retryQuotes[jobId];
  if (!quote) {
    return {
      reason: "no_quote",
      message: state.retryQuoteFailures[jobId] ?? RETRY_QUOTE_MISSING,
    };
  }
  if (quote.costDreamcoins > quote.balance) {
    return {
      reason: "unaffordable",
      message: `Need ${quote.costDreamcoins} coins · you have ${quote.balance}.`,
    };
  }
  return null;
}

function rejection(
  error: unknown,
  fallback: string,
): Extract<GenerationWriteOutcome, { kind: "rejected" }> {
  return {
    kind: "rejected",
    statusMessage:
      error instanceof GenerationRequestError
        ? error.message
        : requestErrorMessage(error, fallback),
    authorityAction:
      error instanceof GenerationRequestError
        ? generationAuthorityActionForStatus(error.status)
        : "none",
  };
}

async function writeOnce(
  request: GenerationWriteRequest,
  context: GenerationRequestContext,
): Promise<GenerationWriteOutcome> {
  const fetcher = context.fetcher ?? fetch;
  try {
    if (request.kind === "generation") {
      // INVARIANT: refuse locally rather than spend a round trip proving the
      // form's authority no longer matches the quote it came from.
      if (
        !request.quoteKey ||
        !quoteAuthorityMatchesQuote(
          request.body.quoteAuthority as GenerationQuoteAuthority | undefined,
          request.quote,
        )
      ) {
        return {
          kind: "rejected",
          statusMessage: QUOTE_UNAVAILABLE,
          authorityAction: "refresh_quote",
        };
      }
      const result = await requestGenerationJobWithExactAuthority(
        { body: request.body, idempotencyKeys: context.keys.generation },
        fetcher,
      );
      return {
        kind: "queued",
        job: result.job,
        statusMessage: "Generation queued.",
      };
    }
    if (request.kind === "variation") {
      const result = await requestMediaVariationWithExactQuote(
        {
          mediaId: request.mediaId,
          outputCount: request.outputCount,
          consistencyMode: request.consistencyMode,
          model: request.model,
          quote: request.quote,
          idempotencyKeys: context.keys.variation,
        },
        fetcher,
      );
      return {
        kind: "queued",
        job: result.job,
        statusMessage: request.queuedMessage,
      };
    }
    // Guaranteed present: `runGenerationWrite` refuses a quoteless retry before
    // it gets here.
    const quote = context.state.retryQuotes[request.jobId]!;
    const job = await requestGenerationRetryWithExactAuthority(
      {
        jobId: request.jobId,
        idempotencyKeys: context.keys.retry,
        quoteAuthority: {
          profileId: quote.profileId,
          profileVersion: quote.profileVersion,
          routeFingerprint: quote.routeFingerprint,
          pricingFingerprint: quote.pricing.fingerprint,
          outputCount: quote.outputCount,
          costDreamcoins: quote.costDreamcoins,
        },
      },
      fetcher,
    );
    return { kind: "queued", job, statusMessage: "Retry queued." };
  } catch (error) {
    if (request.kind === "retry") {
      return rejection(
        error,
        "Retry failed. Check your connection and try again.",
      );
    }
    return rejection(
      error,
      request.kind === "generation"
        ? "Generation request failed. Check your connection and try again."
        : "Variation failed. Check your connection and try again.",
    );
  }
}

/**
 * One write, start to settled. Every collaborator is injected, so the outcome
 * protocol below — mark in flight, spend, apply the job, reprice, unmark — is
 * exercisable with plain fakes.
 */
export async function runGenerationWrite(
  request: GenerationWriteRequest,
  context: GenerationRequestContext,
): Promise<GenerationWriteOutcome> {
  if (request.kind === "retry") {
    const refusal = generationRetryRefusal(context.state, request.jobId);
    if (refusal) {
      if (refusal.reason !== "in_flight") {
        context.effects.showStatus(refusal.message);
      }
      return {
        kind: "rejected",
        statusMessage: refusal.reason === "in_flight" ? "" : refusal.message,
        authorityAction: "none",
      };
    }
  }

  const write: GenerationWriteKind =
    request.kind === "generation"
      ? { kind: "generation" }
      : request.kind === "variation"
        ? { kind: "variation", mediaId: request.mediaId }
        : { kind: "retry", jobId: request.jobId };

  context.dispatch({ type: "write_started", write });
  const outcome = await writeOnce(request, context);
  const quoteKey = request.kind === "retry" ? null : request.quoteKey;
  context.dispatch({ type: "write_settled", write, outcome, quoteKey });

  if (outcome.kind === "queued") {
    context.effects.applyJob(outcome.job);
    context.effects.showStatus(outcome.statusMessage);
    // A retry is fired from the jobs list and is already followed by the poll
    // loop that the non-terminal job re-enters.
    if (request.kind !== "retry") {
      context.effects.revealJobs();
      context.effects.trackJob(outcome.job.id);
    }
    context.effects.refreshBalance();
    return outcome;
  }

  context.effects.showStatus(outcome.statusMessage);
  if (outcome.authorityAction === "refresh_balance_and_quote") {
    context.effects.refreshBalance();
  }
  return outcome;
}
