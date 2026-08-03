"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  clearGenerationIdempotencyKeys,
  createGenerationIdempotencyKeys,
  generationQuoteKeyFor,
  initialGenerationRequestState,
  loadGenerationQuote,
  loadGenerationRetryQuotes,
  projectGenerationRequest,
  reduceGenerationRequest,
  runGenerationWrite,
  type ConsistencyMode,
  type GenerationQuoteRequest,
  type GenerationRequestEffects,
  type GenerationRequestView,
  type GenerationRequestViewInput,
} from "@/lib/generation-request";
import type {
  RuntimeGenerationQuote,
  RuntimeGenerationRetryQuote,
} from "@/lib/public-api-contracts";

// SPEC: binds the generation request lifecycle to React — the machine's state,
// the two price reads that feed it, and the three writes that spend it.
//
// INTENT: no rule lives here. Everything the surface could get wrong (which
// authority a failure invalidates, when an idempotency key rotates, what each
// config-authority state permits) is in `@/lib/generation-request`, where it is
// tested without a DOM. This file is the wiring those rules run on.

export type UseGenerationRequestOptions = {
  /** Null while the form does not describe a route the server can price. */
  quoteRequest: GenerationQuoteRequest | null;
  /**
   * The failed jobs whose exact retry price should be held, joined into one
   * value-stable string. Empty means hold none.
   */
  retryQuoteScopeKey: string;
  view: Omit<GenerationRequestViewInput, "quoteKey">;
  /** A fresh quote is authority over the form's count and aspect ratio. */
  onQuoteResolved: (quote: RuntimeGenerationQuote) => void;
};

export type GenerationVariationInput = {
  mediaId: string;
  outputCount?: number;
  consistencyMode: ConsistencyMode;
  model?: string;
  /** Supplied to spend a quote already in hand; omit to price afresh. */
  quote?: RuntimeGenerationQuote | null;
};

export type GenerationRequestController = {
  view: GenerationRequestView;
  retryQuotes: Readonly<Record<string, RuntimeGenerationRetryQuote>>;
  retryQuoteFailures: Readonly<Record<string, string>>;
  retryingJobIds: ReadonlySet<string>;
  variationPendingMediaIds: ReadonlySet<string>;
  // INTENT: effects are passed per write rather than held by the hook. What to
  // do with a queued job — where it lands, what the status line says, whose
  // balance to re-read — belongs to the surface, and the surface's own config
  // refresh is what resets this hook's viewer scope. Holding them here would
  // make those two depend on each other.
  /** The form's own generate. The quote authority is attached here, not by the caller. */
  submit: (
    body: Record<string, unknown>,
    effects: GenerationRequestEffects,
  ) => Promise<void>;
  createVariation: (
    input: GenerationVariationInput,
    effects: GenerationRequestEffects,
  ) => Promise<void>;
  retry: (jobId: string, effects: GenerationRequestEffects) => Promise<void>;
  requestQuoteRetry: () => void;
  requestRetryQuoteRetry: () => void;
  /** Coins moved outside a write we ran — reprice everything. */
  balanceChanged: () => void;
  /** The signed-in viewer changed; nothing priced for the old one survives. */
  resetViewerScope: () => void;
};

export function useGenerationRequest(
  options: UseGenerationRequestOptions,
): GenerationRequestController {
  const [state, dispatch] = useReducer(
    reduceGenerationRequest,
    undefined,
    initialGenerationRequestState,
  );

  const quoteKey = options.quoteRequest
    ? generationQuoteKeyFor(options.quoteRequest)
    : null;
  const view = projectGenerationRequest(state, {
    ...options.view,
    quoteKey,
  });

  // INVARIANT: everything the actions and the price reads need is read through
  // one ref, so both can hold stable identities. They feed dependency arrays in
  // the workspace; a fresh closure per render would turn one read into a loop.
  // The ref is seeded with the first render's values and re-synced after every
  // commit, before the reads below run.
  const latestRef = useRef({ options, state, view, quoteKey });
  useEffect(() => {
    latestRef.current = { options, state, view, quoteKey };
  });

  const keysRef = useRef(createGenerationIdempotencyKeys());
  const quoteControllerRef = useRef<AbortController | null>(null);
  const retryQuoteControllerRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      quoteControllerRef.current?.abort();
      retryQuoteControllerRef.current?.abort();
    },
    [],
  );

  // INVARIANT: the key is a total function of the priced route (proved in
  // generation-request.test.ts), so watching it — plus the reprice nonce — is
  // enough. Reading the request itself through the ref keeps a new object per
  // render from re-firing a settled price read.
  useEffect(() => {
    quoteControllerRef.current?.abort();
    if (!quoteKey) return;

    const controller = new AbortController();
    quoteControllerRef.current = controller;
    dispatch({ type: "quote_pending" });

    void (async () => {
      const request = latestRef.current.options.quoteRequest;
      if (!request) return;
      const outcome = await loadGenerationQuote(request, {
        signal: controller.signal,
      });
      if (quoteControllerRef.current === controller) {
        quoteControllerRef.current = null;
      }
      if (outcome.kind === "discarded") return;
      if (outcome.kind === "failed") {
        dispatch({
          type: "quote_failed",
          key: outcome.key,
          message: outcome.message,
        });
        return;
      }
      dispatch({
        type: "quote_resolved",
        key: outcome.key,
        quote: outcome.quote,
      });
      latestRef.current.options.onQuoteResolved(outcome.quote);
    })();

    return () => controller.abort();
  }, [quoteKey, state.quoteNonce]);

  const retryQuoteScopeKey = options.retryQuoteScopeKey;
  useEffect(() => {
    retryQuoteControllerRef.current?.abort();
    if (!retryQuoteScopeKey) {
      dispatch({ type: "retry_quotes_pending" });
      return;
    }
    const controller = new AbortController();
    retryQuoteControllerRef.current = controller;
    const jobIds = retryQuoteScopeKey.split("|").filter(Boolean);
    dispatch({ type: "retry_quotes_pending" });

    void (async () => {
      const outcome = await loadGenerationRetryQuotes(jobIds, {
        signal: controller.signal,
      });
      if (outcome.kind === "discarded") return;
      dispatch({
        type: "retry_quotes_resolved",
        quotes: outcome.quotes,
        failures: outcome.failures,
      });
    })();

    return () => controller.abort();
  }, [retryQuoteScopeKey, state.retryQuoteNonce]);

  const context = useCallback(
    (effects: GenerationRequestEffects) => ({
      state: latestRef.current.state,
      dispatch,
      effects,
      keys: keysRef.current,
    }),
    [],
  );

  const submit = useCallback(
    async (
      body: Record<string, unknown>,
      effects: GenerationRequestEffects,
    ) => {
      const latest = latestRef.current;
      await runGenerationWrite(
        {
          kind: "generation",
          // The caller supplies what to generate; the price it is authorized at
          // is not theirs to forget.
          body: { ...body, quoteAuthority: latest.view.exactQuote?.authority },
          quote: latest.view.quote,
          quoteKey: latest.quoteKey,
        },
        context(effects),
      );
    },
    [context],
  );

  const createVariation = useCallback(
    async (
      input: GenerationVariationInput,
      effects: GenerationRequestEffects,
    ) => {
      const latest = latestRef.current;
      // Only the source the form is editing spends the form's quote; every
      // other card prices itself and must not invalidate what the form shows.
      const editSourceMediaId = latest.options.view.editSourceMediaId;
      await runGenerationWrite(
        {
          kind: "variation",
          mediaId: input.mediaId,
          outputCount: input.outputCount ?? 1,
          consistencyMode: input.consistencyMode,
          model: input.model,
          quote: input.quote ?? null,
          quoteKey:
            editSourceMediaId === input.mediaId ? latest.quoteKey : null,
          // An image-edit workflow names its own writes, even the ones fired
          // from a gallery card.
          queuedMessage:
            editSourceMediaId === undefined
              ? "Variation queued."
              : "Image edit queued.",
        },
        context(effects),
      );
    },
    [context],
  );

  const retry = useCallback(
    async (jobId: string, effects: GenerationRequestEffects) => {
      await runGenerationWrite({ kind: "retry", jobId }, context(effects));
    },
    [context],
  );

  const requestQuoteRetry = useCallback(
    () => dispatch({ type: "quote_retry_requested" }),
    [],
  );
  const requestRetryQuoteRetry = useCallback(
    () => dispatch({ type: "retry_quotes_retry_requested" }),
    [],
  );
  const balanceChanged = useCallback(
    () => dispatch({ type: "balance_changed" }),
    [],
  );
  const resetViewerScope = useCallback(() => {
    // A key only means anything to the viewer who minted it: keeping one across
    // a scope change would let the next viewer replay someone else's write.
    clearGenerationIdempotencyKeys(keysRef.current);
    dispatch({ type: "viewer_scope_reset" });
  }, []);

  return {
    view,
    retryQuotes: state.retryQuotes,
    retryQuoteFailures: state.retryQuoteFailures,
    retryingJobIds: state.retryingJobIds,
    variationPendingMediaIds: state.variationPendingMediaIds,
    submit,
    createVariation,
    retry,
    requestQuoteRetry,
    requestRetryQuoteRetry,
    balanceChanged,
    resetViewerScope,
  };
}
