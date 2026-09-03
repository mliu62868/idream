"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
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
import {
  hasUnconfirmedGenerationRetry,
  hasUnconfirmedGenerationSubmission,
  hasUnconfirmedMediaVariation,
  listGenerationReceipts,
  readGenerationReceipts,
  requestGenerationReceipt,
  GenerationRequestError,
  type GenerationReceipt,
  type GenerationReceiptPersistence,
} from "@/lib/generation-write-client";

// SPEC: binds the generation request lifecycle to React — the machine's state,
// the two price reads that feed it, and the three writes that spend it.
//
// INTENT: no rule lives here. Everything the surface could get wrong (which
// authority a failure invalidates, when an idempotency key rotates, what each
// config-authority state permits) is in `@/lib/generation-request`, where it is
// tested without a DOM. This file is the wiring those rules run on.

export type UseGenerationRequestOptions = {
  /** Only the server-confirmed signed-in viewer may load local receipts. */
  receiptOwnerScope?: string | null;
  onReceiptWarning?: (message: string) => void;
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
  negativePrompt?: string;
  prompt?: string;
  /** Supplied to spend a quote already in hand; omit to price afresh. */
  quote?: RuntimeGenerationQuote | null;
};

export type GenerationRequestController = {
  receipts: readonly GenerationReceipt[];
  recoveringReceiptKeys: ReadonlySet<string>;
  recoverReceipt: (receipt: GenerationReceipt, effects: GenerationRequestEffects) => Promise<void>;
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
  /** Suspend projections; retain receipts only during revalidation of the current viewer. */
  resetViewerScope: (preserveUnconfirmed?: boolean) => void;
  isSubmissionUnconfirmed: (body: Record<string, unknown>) => boolean;
  isVariationUnconfirmed: (input: GenerationVariationInput) => boolean;
  hasUnconfirmedVariations: () => boolean;
  isRetryUnconfirmed: (jobId: string) => boolean;
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
  const receiptOwnerRef = useRef<GenerationReceiptPersistence | undefined>(undefined);
  const lastReceiptOwnerRef = useRef<string | null>(null);
  const [receiptSnapshot, setReceiptSnapshot] = useState<{ ownerScope: string | null; items: GenerationReceipt[] }>({ ownerScope: null, items: [] });
  const [recoveringReceiptKeys, setRecoveringReceiptKeys] = useState<Set<string>>(new Set());
  const receiptChecksRef = useRef(new Set<string>());
  const refreshReceipts = useCallback(() => {
    const ownerScope = receiptOwnerRef.current?.ownerScope ?? null;
    setReceiptSnapshot({ ownerScope, items: ownerScope ? Object.values(keysRef.current).flatMap(listGenerationReceipts) : [] });
  }, []);
  const viewerEpochRef = useRef(0);
  const quoteControllerRef = useRef<AbortController | null>(null);
  const retryQuoteControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const scope = options.receiptOwnerScope;
    receiptOwnerRef.current = scope ? { ownerScope: scope, onWarning: options.onReceiptWarning } : undefined;
    if (!scope) return;
    if (lastReceiptOwnerRef.current !== scope) {
      keysRef.current = createGenerationIdempotencyKeys();
      lastReceiptOwnerRef.current = scope;
    }
    const restore = () => {
      const owner = receiptOwnerRef.current;
      if (!owner || owner.ownerScope !== scope) return;
      for (const receipt of readGenerationReceipts(owner)) {
        const map = receipt.kind === "generation" ? keysRef.current.generation
          : receipt.kind === "media_variation" ? keysRef.current.variation
          : receipt.kind === "generation_retry" ? keysRef.current.retry : null;
        if (map && !map.has(receipt.record)) map.set(receipt.record, receipt.key);
      }
    };
    // Restore keys before any user event can submit; publish the owner-bound
    // browser snapshot separately, without deriving rendered authority from a ref.
    restore();
    const timer = window.setTimeout(refreshReceipts, 0);
    const onStorage = () => { restore(); refreshReceipts(); };
    // This only refreshes the local list; it never submits or chooses a viewer.
    window.addEventListener("storage", onStorage);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("storage", onStorage);
    };
  }, [options.receiptOwnerScope, options.onReceiptWarning, refreshReceipts]);

  useEffect(
    () => () => {
      viewerEpochRef.current += 1;
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
    (effects: GenerationRequestEffects) => {
      const viewerEpoch = viewerEpochRef.current;
      return {
        state: latestRef.current.state,
        dispatch,
        effects,
        keys: keysRef.current,
        persistence: receiptOwnerRef.current,
        isCurrent: () => viewerEpochRef.current === viewerEpoch,
      };
    },
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
      refreshReceipts();
    },
    [context, refreshReceipts],
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
          negativePrompt: input.negativePrompt,
          prompt: input.prompt,
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
      refreshReceipts();
    },
    [context, refreshReceipts],
  );

  const retry = useCallback(
    async (jobId: string, effects: GenerationRequestEffects) => {
      await runGenerationWrite({ kind: "retry", jobId }, context(effects));
      refreshReceipts();
    },
    [context, refreshReceipts],
  );

  const recoverReceipt = useCallback(async (receipt: GenerationReceipt, effects: GenerationRequestEffects) => {
    const ctx = context(effects);
    if (!ctx.persistence || receiptChecksRef.current.has(receipt.key)) return;
    const map = receipt.kind === "generation" ? ctx.keys.generation
      : receipt.kind === "media_variation" ? ctx.keys.variation
      : receipt.kind === "generation_retry" ? ctx.keys.retry : null;
    if (!map) return;
    const checks = receiptChecksRef.current;
    checks.add(receipt.key);
    setRecoveringReceiptKeys(new Set(checks));
    try {
      const result = await requestGenerationReceipt(receipt, { idempotencyKeys: map, persistence: ctx.persistence, isCurrent: ctx.isCurrent });
      if (!ctx.isCurrent()) return;
      effects.applyJob(result.job);
      effects.showStatus("Original request confirmed.");
      effects.revealJobs();
      effects.trackJob(result.job.id);
      effects.refreshBalance();
    } catch (error) {
      if (!ctx.isCurrent()) return;
      if (error instanceof GenerationRequestError && error.status === 401) effects.refreshBalance();
      effects.showStatus(error instanceof GenerationRequestError && error.status === 401
        ? "Sign in to the same account to check this request. Your pending request is kept."
        : `${error instanceof Error ? error.message : "The request could not be confirmed."} Your original request is kept; check again or contact support.`);
    } finally {
      checks.delete(receipt.key);
      if (ctx.isCurrent()) { setRecoveringReceiptKeys(new Set(checks)); refreshReceipts(); }
    }
  }, [context, refreshReceipts]);

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
  const resetViewerScope = useCallback((preserveUnconfirmed = false) => {
    // In-flight requests keep their own keys and cannot project into the next viewer.
    viewerEpochRef.current += 1;
    receiptChecksRef.current = new Set();
    setRecoveringReceiptKeys(new Set());
    setReceiptSnapshot({ ownerScope: null, items: [] });
    if (!preserveUnconfirmed) keysRef.current = createGenerationIdempotencyKeys();
    quoteControllerRef.current?.abort();
    retryQuoteControllerRef.current?.abort();
    dispatch({ type: "viewer_scope_reset" });
  }, []);
  const isSubmissionUnconfirmed = useCallback((body: Record<string, unknown>) =>
    hasUnconfirmedGenerationSubmission(body, keysRef.current.generation), []);
  const isVariationUnconfirmed = useCallback((input: GenerationVariationInput) =>
    hasUnconfirmedMediaVariation({ ...input, outputCount: input.outputCount ?? 1 }, keysRef.current.variation), []);
  const hasUnconfirmedVariations = useCallback(() => keysRef.current.variation.size > 0, []);
  const isRetryUnconfirmed = useCallback((jobId: string) =>
    hasUnconfirmedGenerationRetry(jobId, keysRef.current.retry), []);

  return {
    receipts: options.receiptOwnerScope && options.receiptOwnerScope === receiptSnapshot.ownerScope ? receiptSnapshot.items : [],
    recoveringReceiptKeys,
    recoverReceipt,
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
    isSubmissionUnconfirmed,
    isVariationUnconfirmed,
    hasUnconfirmedVariations,
    isRetryUnconfirmed,
  };
}
