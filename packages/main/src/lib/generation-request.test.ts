import { describe, expect, it, vi } from "vitest";
import {
  createGenerationIdempotencyKeys,
  generationAuthorityActionForStatus,
  generationQuoteKeyFor,
  generationRetryRefusal,
  initialGenerationRequestState,
  loadGenerationQuote,
  loadGenerationRetryQuotes,
  pendingGenerationJobIds,
  projectGenerationRequest,
  projectServerJobArrival,
  quoteAuthorityMatchesQuote,
  reduceGenerationRequest,
  runGenerationWrite,
  type GenerationRequestAction,
  type GenerationQuoteRequest,
  type GenerationRequestEffects,
  type GenerationRequestState,
  type GenerationRequestViewInput,
  type GenerationWriteRequest,
} from "./generation-request";
import { GENERATION_JOB_STATUSES } from "@idream/shared/catalog";
import {
  listGenerationReceipts,
  readGenerationReceipts,
  requestGenerationReceipt,
  requestGenerationJobWithExactAuthority,
  requestGenerationRetryWithExactAuthority,
  requestMediaEnhancementWithExactQuote,
  requestMediaVariationWithExactQuote,
  type GenerationReceiptPersistence,
} from "./generation-write-client";
import type {
  RuntimeGenerationQuote,
  RuntimeGenerationRetryQuote,
} from "@/lib/public-api-contracts";

const quote: RuntimeGenerationQuote = {
  mode: "image",
  profileId: "character-image-multi-identity",
  profileVersion: 3,
  routeFingerprint: "a".repeat(64),
  pricing: {
    ruleId: "image-price-v1",
    ruleKey: "image-default",
    version: 1,
    effectiveFrom: null,
    fingerprint: "b".repeat(64),
  },
  orientations: ["4:5", "16:9"],
  defaultOrientation: "4:5",
  maxCount: 2,
  costs: [
    { outputCount: 1, costDreamcoins: 7 },
    { outputCount: 2, costDreamcoins: 14 },
  ],
  balance: 20,
  identityLocked: false,
};

const retryQuote: RuntimeGenerationRetryQuote = {
  generationJobId: "job-1",
  mode: "image",
  profileId: "character-image-multi-identity",
  profileVersion: 3,
  routeFingerprint: "a".repeat(64),
  pricing: quote.pricing,
  outputCount: 1,
  costDreamcoins: 7,
  balance: 20,
};

function stateWith(
  overrides: Partial<GenerationRequestState> = {},
): GenerationRequestState {
  return { ...initialGenerationRequestState(), ...overrides };
}

function heldQuote(key = "route-key") {
  return stateWith({ quote: { key, quote } });
}

function viewInput(
  overrides: Partial<GenerationRequestViewInput> = {},
): GenerationRequestViewInput {
  return {
    quoteKey: "route-key",
    configAuthority: "ready",
    mode: "image",
    count: 1,
    modeAvailable: true,
    hasTarget: true,
    ...overrides,
  };
}

function recordingEffects() {
  const effects: GenerationRequestEffects & {
    calls: string[];
  } = {
    calls: [],
    applyJob: vi.fn((job) => {
      effects.calls.push(`applyJob:${job.id}`);
    }),
    showStatus: vi.fn((message: string) => {
      effects.calls.push(`status:${message}`);
    }),
    revealJobs: vi.fn(() => {
      effects.calls.push("revealJobs");
    }),
    refreshBalance: vi.fn(() => {
      effects.calls.push("refreshBalance");
    }),
    trackJob: vi.fn((jobId: string) => {
      effects.calls.push(`trackJob:${jobId}`);
    }),
  };
  return effects;
}

function jobResponse(id: string) {
  return Response.json({
    ok: true,
    data: {
      job: {
        id,
        mode: "image",
        status: "queued",
        costDreamcoins: 7,
        outputCount: 1,
        errorCode: null,
        createdAt: new Date().toISOString(),
      },
      assets: [],
    },
  });
}

function submissionBody(overrides: Record<string, unknown> = {}) {
  return {
    mode: "image",
    characterId: "character-1",
    freeplay: false,
    outputCount: 1,
    quoteAuthority: {
      profileId: quote.profileId,
      profileVersion: quote.profileVersion,
      routeFingerprint: quote.routeFingerprint,
      pricingFingerprint: quote.pricing.fingerprint,
      outputCount: 1,
      costDreamcoins: 7,
    },
    ...overrides,
  };
}

// INVARIANT 1 — idempotency key rotation
describe("generation request idempotency", () => {
  it.each([200, 409])("a late HTTP %s from an older replay cannot clear a newer request's key", async (status) => {
    const keys = createGenerationIdempotencyKeys();
    const observed: string[] = [];
    let resolveOld!: (response: Response) => void;
    let resolveNew!: (response: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => { resolveOld = resolve; });
    const newResponse = new Promise<Response>((resolve) => { resolveNew = resolve; });
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      observed.push(new Headers(init?.headers).get("idempotency-key") ?? "");
      if (observed.length === 1) return oldResponse;
      if (observed.length === 2) return jobResponse("accepted-old-job");
      return newResponse;
    });
    const request: GenerationWriteRequest = { kind: "generation", body: submissionBody(), quote, quoteKey: "route-key" };
    const context = () => ({ state: heldQuote(), dispatch: () => {}, effects: recordingEffects(), keys, fetcher });
    const old = runGenerationWrite(request, context());
    await runGenerationWrite(request, context());
    expect(observed[1]).toBe(observed[0]);
    const fresh = runGenerationWrite(request, context());
    expect(observed[2]).not.toBe(observed[0]);
    resolveOld(status === 200 ? jobResponse("accepted-old-job") : Response.json({ ok: false, error: { message: "Old rejection" } }, { status }));
    await old;
    expect([...keys.generation.values()]).toEqual([observed[2]]);
    resolveNew(Response.json({ ok: false, error: { message: "Unconfirmed" } }, { status: 503 }));
    await fresh;
    expect([...keys.generation.values()]).toEqual([observed[2]]);
  });

  it.each(["generation", "variation", "retry"] as const)("checks the original unconfirmed %s when its route can no longer be quoted", async (kind) => {
    const keys = createGenerationIdempotencyKeys();
    const observed: Array<{ key: string; body: Record<string, unknown> }> = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      observed.push({ key: new Headers(init?.headers).get("idempotency-key") ?? "", body: JSON.parse(String(init?.body)) });
      if (observed.length === 1) throw new TypeError("Response lost after acceptance");
      return jobResponse("accepted-job");
    });
    const request: GenerationWriteRequest = kind === "generation"
      ? { kind, body: submissionBody(), quote, quoteKey: "route-key" }
      : kind === "retry" ? { kind, jobId: "job-1" } : {
        kind, mediaId: "image-1", outputCount: 1, consistencyMode: "balanced",
        prompt: "A blue raincoat", quote, quoteKey: "route-key", queuedMessage: "Variation queued.",
      };
    expect((await runGenerationWrite(request, { state: stateWith({ retryQuotes: { "job-1": retryQuote } }),
      dispatch: () => {}, effects: recordingEffects(), keys, fetcher })).kind).toBe("rejected");
    const replay = await runGenerationWrite(request.kind === "retry" ? request : { ...request, quote: null, quoteKey: null }, {
      state: stateWith(), dispatch: () => {}, effects: recordingEffects(), keys, fetcher,
    });
    expect(replay).toMatchObject({ kind: "queued", job: { id: "accepted-job" } });
    expect(observed).toHaveLength(2);
    expect(observed[1].key).toBe(observed[0].key);
    expect(observed[1].body).toEqual(observed[0].body);
    if (kind === "variation") expect(observed[1].body.orientation).toBe("4:5");
  });

  it.each(["variation", "retry"] as const)("checks the same unconfirmed %s after its accepted charge consumed the balance", async (kind) => {
    const keys = createGenerationIdempotencyKeys();
    const observed: string[] = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      observed.push(new Headers(init?.headers).get("idempotency-key") ?? "");
      if (observed.length === 1) throw new TypeError("Response lost after acceptance");
      return jobResponse("accepted-job");
    });
    const request: GenerationWriteRequest = kind === "retry" ? { kind, jobId: "job-1" } : {
      kind, mediaId: "image-1", outputCount: 1, consistencyMode: "balanced",
      prompt: "A blue raincoat", quote, quoteKey: "route-key", queuedMessage: "Variation queued.",
    };
    const initial = await runGenerationWrite(request, {
      state: stateWith({ retryQuotes: { "job-1": retryQuote } }), dispatch: () => {},
      effects: recordingEffects(), keys, fetcher,
    });
    expect(initial.kind).toBe("rejected");
    const replay = await runGenerationWrite(request.kind === "variation" ? { ...request, quote: { ...quote, balance: 0 } } : request, {
      state: stateWith({ retryQuotes: { "job-1": { ...retryQuote, balance: 0 } } }),
      dispatch: () => {}, effects: recordingEffects(), keys, fetcher,
    });
    expect(replay).toMatchObject({ kind: "queued", job: { id: "accepted-job" } });
    expect(observed).toHaveLength(2);
    expect(observed[0]).toBeTruthy();
    expect(observed[1]).toBe(observed[0]);
    expect(keys[kind].size).toBe(0);
  });

  it("reuses the submission key after an ambiguous network failure and drops it once the write is known to have landed", async () => {
    const keys = createGenerationIdempotencyKeys();
    const observed: string[] = [];
    let attempt = 0;
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        observed.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        attempt += 1;
        if (attempt === 1) throw new TypeError("connection reset after commit");
        return jobResponse("same-main-job");
      },
    ) as unknown as typeof fetch;

    const context = {
      state: heldQuote(),
      dispatch: () => {},
      effects: recordingEffects(),
      keys,
      fetcher,
    };
    const request = {
      kind: "generation" as const,
      body: submissionBody(),
      quote,
      quoteKey: "route-key",
    };

    const first = await runGenerationWrite(request, context);
    expect(first).toMatchObject({ kind: "rejected" });
    // Ambiguous: the write may have committed, so the key must survive.
    expect(keys.generation.size).toBe(1);

    const second = await runGenerationWrite(request, context);
    expect(second).toMatchObject({ kind: "queued", job: { id: "same-main-job" } });
    expect(observed[0]).toBe(observed[1]);
    expect(keys.generation.size).toBe(0);
  });

  it("rotates the submission key after a definitive 4xx refusal", async () => {
    const keys = createGenerationIdempotencyKeys();
    const observed: string[] = [];
    let attempt = 0;
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        observed.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        attempt += 1;
        if (attempt === 1) {
          return Response.json(
            { ok: false, error: { message: "Route moved." } },
            { status: 409 },
          );
        }
        return jobResponse("fresh-job");
      },
    ) as unknown as typeof fetch;

    const context = {
      state: heldQuote(),
      dispatch: () => {},
      effects: recordingEffects(),
      keys,
      fetcher,
    };
    const request = {
      kind: "generation" as const,
      body: submissionBody(),
      quote,
      quoteKey: "route-key",
    };

    await runGenerationWrite(request, context);
    expect(keys.generation.size).toBe(0);
    await runGenerationWrite(request, context);
    expect(observed[0]).not.toBe(observed[1]);
  });

  it("keeps one retry key per job across an ambiguous failure", async () => {
    const keys = createGenerationIdempotencyKeys();
    const observed: string[] = [];
    let attempt = 0;
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        observed.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        attempt += 1;
        if (attempt === 1) throw new TypeError("connection reset after commit");
        return jobResponse("retried-job");
      },
    ) as unknown as typeof fetch;

    const context = {
      state: stateWith({ retryQuotes: { "job-1": retryQuote } }),
      dispatch: () => {},
      effects: recordingEffects(),
      keys,
      fetcher,
    };

    await runGenerationWrite({ kind: "retry", jobId: "job-1" }, context);
    expect(keys.retry.size).toBe(1);
    await runGenerationWrite({ kind: "retry", jobId: "job-1" }, context);
    expect(observed).toEqual([observed[0], observed[0]]);
    expect(keys.retry.size).toBe(0);
  });
});

// INVARIANT 2 — the submitted authority must be the held quote's
describe("generation quote authority", () => {
  it("recognises the exact quote a submission was priced under", () => {
    expect(
      quoteAuthorityMatchesQuote(submissionBody().quoteAuthority, quote),
    ).toBe(true);
  });

  it.each([
    ["profileId", { profileId: "other-profile" }],
    ["profileVersion", { profileVersion: 4 }],
    ["routeFingerprint", { routeFingerprint: "c".repeat(64) }],
    ["pricingFingerprint", { pricingFingerprint: "d".repeat(64) }],
  ])("rejects a submission whose %s drifted from the held quote", (_field, drift) => {
    expect(
      quoteAuthorityMatchesQuote(
        { ...submissionBody().quoteAuthority, ...drift },
        quote,
      ),
    ).toBe(false);
  });

  it("never leaves the browser when the authority no longer matches the held quote", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const effects = recordingEffects();

    const outcome = await runGenerationWrite(
      {
        kind: "generation",
        body: submissionBody({
          quoteAuthority: {
            ...submissionBody().quoteAuthority,
            pricingFingerprint: "c".repeat(64),
          },
        }),
        quote,
        quoteKey: "route-key",
      },
      {
        state: heldQuote(),
        dispatch: () => {},
        effects,
        keys: createGenerationIdempotencyKeys(),
        fetcher,
      },
    );

    expect(fetcher).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      kind: "rejected",
      authorityAction: "refresh_quote",
    });
  });

  it("refuses a submission with no quote at all", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;

    await runGenerationWrite(
      {
        kind: "generation",
        body: submissionBody(),
        quote: null,
        quoteKey: null,
      },
      {
        state: initialGenerationRequestState(),
        dispatch: () => {},
        effects: recordingEffects(),
        keys: createGenerationIdempotencyKeys(),
        fetcher,
      },
    );

    expect(fetcher).not.toHaveBeenCalled();
  });

  it("only reads a quote through the key it was priced for", () => {
    const state = heldQuote("route-a");

    expect(projectGenerationRequest(state, viewInput({ quoteKey: "route-a" })).quote)
      .not.toBeNull();
    expect(
      projectGenerationRequest(state, viewInput({ quoteKey: "route-b" })).quote,
    ).toBeNull();
    expect(
      projectGenerationRequest(state, viewInput({ quoteKey: "route-b" })).canSubmit,
    ).toBe(false);
  });
});

// INVARIANT 3 — a balance change forces a reprice
describe("generation quote reprice after a balance change", () => {
  it("drops the held quote and asks both price lists to reprice", () => {
    const before = stateWith({
      quote: { key: "route-key", quote },
      quoteFailure: { key: "route-key", message: "stale" },
      retryQuotes: { "job-1": retryQuote },
    });

    const after = reduceGenerationRequest(before, { type: "balance_changed" });

    expect(after.quote).toBeNull();
    expect(after.quoteFailure).toBeNull();
    expect(after.quoteNonce).toBe(before.quoteNonce + 1);
    expect(after.retryQuoteNonce).toBe(before.retryQuoteNonce + 1);
  });

  it.each([402, 409])(
    "cannot submit against the pre-change quote after a concurrent %s",
    (status) => {
      const rejected = reduceGenerationRequest(heldQuote(), {
        type: "write_settled",
        write: { kind: "generation" },
        quoteKey: "route-key",
        outcome: {
          kind: "rejected",
          statusMessage: "Price moved.",
          authorityAction: generationAuthorityActionForStatus(status),
        },
      });

      expect(rejected.quote).toBeNull();
      expect(rejected.quoteNonce).toBe(1);
      expect(projectGenerationRequest(rejected, viewInput()).canSubmit).toBe(false);
    },
  );

  it("reprices after a queued write, since the coins are already committed", () => {
    const queued = reduceGenerationRequest(heldQuote(), {
      type: "write_settled",
      write: { kind: "generation" },
      quoteKey: "route-key",
      outcome: {
        kind: "queued",
        statusMessage: "Generation queued.",
        job: {
          id: "job-9",
          mode: "image",
          status: "queued",
          costDreamcoins: 7,
          outputCount: 1,
          errorCode: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });

    expect(queued.quote).toBeNull();
    expect(queued.quoteNonce).toBe(1);
  });

  it("classifies which authority a failed status invalidates", () => {
    expect(generationAuthorityActionForStatus(402)).toBe(
      "refresh_balance_and_quote",
    );
    expect(generationAuthorityActionForStatus(409)).toBe("refresh_quote");
    expect(generationAuthorityActionForStatus(500)).toBe("none");
  });

  it("leaves the form's quote alone when a gallery variation priced itself", () => {
    const before = heldQuote();
    const after = reduceGenerationRequest(before, {
      type: "write_settled",
      write: { kind: "variation", mediaId: "media-1" },
      quoteKey: null,
      outcome: {
        kind: "rejected",
        statusMessage: "Route moved.",
        authorityAction: "refresh_quote",
      },
    });

    expect(after.quote).toEqual(before.quote);
    expect(after.quoteNonce).toBe(before.quoteNonce);
  });

  it("reprices only the retry list when a retry hits a moved route", () => {
    const before = heldQuote();
    const after = reduceGenerationRequest(before, {
      type: "write_settled",
      write: { kind: "retry", jobId: "job-1" },
      quoteKey: null,
      outcome: {
        kind: "rejected",
        statusMessage: "Route moved.",
        authorityAction: "refresh_quote",
      },
    });

    expect(after.quote).toEqual(before.quote);
    expect(after.retryQuoteNonce).toBe(before.retryQuoteNonce + 1);
  });
});

// INVARIANT 4 — what each config-authority state permits
describe("generator config authority", () => {
  it("only lets a signed-in viewer with loaded config submit", () => {
    expect(
      projectGenerationRequest(heldQuote(), viewInput({ configAuthority: "ready" }))
        .canSubmit,
    ).toBe(true);
    for (const authority of ["anonymous", "suspended", "revoked"] as const) {
      expect(
        projectGenerationRequest(heldQuote(), viewInput({ configAuthority: authority }))
          .canSubmit,
      ).toBe(false);
    }
  });

  it("still prices for an anonymous viewer but never calls it unaffordable silently", () => {
    const poor = stateWith({
      quote: { key: "route-key", quote: { ...quote, balance: 1 } },
    });

    const anonymous = projectGenerationRequest(
      poor,
      viewInput({ configAuthority: "anonymous" }),
    );
    expect(anonymous.estimatedCost).toBe(7);
    expect(anonymous.insufficientBalance).toBe(true);
    expect(anonymous.canSubmit).toBe(false);
  });

  it("makes no affordability claim once the config has been withdrawn", () => {
    const poor = stateWith({
      quote: { key: "route-key", quote: { ...quote, balance: 1 } },
    });

    for (const authority of ["suspended", "revoked"] as const) {
      const view = projectGenerationRequest(
        poor,
        viewInput({ configAuthority: authority }),
      );
      expect(view.insufficientBalance).toBe(false);
      expect(view.canSubmit).toBe(false);
    }
  });

  it("drops every in-flight marker and price when the viewer scope resets", () => {
    const busy = stateWith({
      quote: { key: "route-key", quote },
      quoteFailure: { key: "route-key", message: "stale" },
      retryQuotes: { "job-1": retryQuote },
      retryQuoteFailures: { "job-2": "no price" },
      submitting: true,
      retryingJobIds: new Set(["job-1"]),
      variationPendingMediaIds: new Set(["media-1"]),
      quoteNonce: 4,
      retryQuoteNonce: 6,
    });

    const after = reduceGenerationRequest(busy, { type: "viewer_scope_reset" });

    expect(after).toEqual(
      stateWith({ quoteNonce: 4, retryQuoteNonce: 6 }),
    );
  });
});

// INVARIANT 5 — terminal job detection
describe("generation job settlement", () => {
  it("stops polling an unconfirmed outcome without announcing a refund", () => {
    const job = { id: "uncertain-job", mode: "video" as const, status: "queued", errorCode: "provider_outcome_unknown" };
    expect(pendingGenerationJobIds([job])).toEqual([]);
    expect(projectServerJobArrival(job)).toEqual({
      settled: true,
      statusMessage: "The generation result needs review. Contact support before trying again.",
      showResults: false,
      refreshBalanceAndQuote: false,
    });
  });

  it("keeps polling every non-terminal status and stops at every terminal one", () => {
    const jobs = GENERATION_JOB_STATUSES.map((status) => ({
      id: status,
      mode: "image" as const,
      status,
      errorCode: null,
    }));

    expect(pendingGenerationJobIds(jobs)).toEqual([
      "queued",
      "moderating_input",
      "running",
      "moderating_output",
    ]);
  });

  // Regression: the admin cancel command writes generation_jobs.status =
  // "cancelled" and refunds in the same transaction, but the shared catalog did
  // not carry that status — so it read as non-terminal and the workspace polled
  // the job forever while showing nothing and never repricing the refund.
  it("settles a cancelled job and reprices the refund it already moved", () => {
    expect(
      pendingGenerationJobIds([
        { id: "job-1", mode: "image", status: "cancelled", errorCode: null },
      ]),
    ).toEqual([]);
    expect(
      projectServerJobArrival({
        id: "job-1",
        mode: "image",
        status: "cancelled",
        errorCode: null,
      }),
    ).toEqual({
      settled: true,
      statusMessage: "Generation stopped.",
      showResults: false,
      refreshBalanceAndQuote: true,
    });
  });

  it("says nothing about a job that is still in motion", () => {
    expect(
      projectServerJobArrival({
        id: "job-1",
        mode: "image",
        status: "running",
        errorCode: null,
      }),
    ).toEqual({
      settled: false,
      statusMessage: null,
      showResults: false,
      refreshBalanceAndQuote: false,
    });
  });

  it("hands back results and reprices on completion", () => {
    expect(
      projectServerJobArrival({
        id: "job-1",
        mode: "video",
        status: "completed",
        errorCode: null,
      }),
    ).toEqual({
      settled: true,
      statusMessage: "Generation complete.",
      showResults: true,
      refreshBalanceAndQuote: true,
    });
  });

  it.each([
    ["failed", "nsfw_block", "Failed: nsfw_block"],
    ["failed", null, "Failed."],
    ["blocked", "underage", "Blocked: underage"],
    ["blocked", null, "Blocked."],
    ["refunded", null, "Refunded."],
  ])(
    "reports a %s job truthfully and reprices the balance it moved",
    (status, errorCode, message) => {
      expect(
        projectServerJobArrival({
          id: "job-1",
          mode: "image",
          status,
          errorCode,
        }),
      ).toEqual({
        settled: true,
        statusMessage: message,
        showResults: false,
        refreshBalanceAndQuote: true,
      });
    },
  );
});

describe("generation retry refusal", () => {
  it("refuses a retry that has no exact price yet, quoting the reason it failed to price", () => {
    expect(
      generationRetryRefusal(
        stateWith({ retryQuoteFailures: { "job-1": "Retry pricing is down." } }),
        "job-1",
      ),
    ).toEqual({ reason: "no_quote", message: "Retry pricing is down." });

    expect(generationRetryRefusal(initialGenerationRequestState(), "job-1")).toEqual({
      reason: "no_quote",
      message: "Wait for the exact retry price before retrying.",
    });
  });

  it("refuses a retry the viewer cannot afford", () => {
    expect(
      generationRetryRefusal(
        stateWith({
          retryQuotes: { "job-1": { ...retryQuote, balance: 3 } },
        }),
        "job-1",
      ),
    ).toEqual({
      reason: "unaffordable",
      message: "Need 7 coins · you have 3.",
    });
  });

  it("swallows a duplicate click on an in-flight retry", async () => {
    const effects = recordingEffects();
    const fetcher = vi.fn() as unknown as typeof fetch;

    await runGenerationWrite(
      { kind: "retry", jobId: "job-1" },
      {
        state: stateWith({
          retryQuotes: { "job-1": retryQuote },
          retryingJobIds: new Set(["job-1"]),
        }),
        dispatch: () => {},
        effects,
        keys: createGenerationIdempotencyKeys(),
        fetcher,
      },
    );

    expect(fetcher).not.toHaveBeenCalled();
    expect(effects.calls).toEqual([]);
  });

  it("never marks a refused retry as in flight", async () => {
    const dispatched: GenerationRequestAction[] = [];
    const effects = recordingEffects();

    await runGenerationWrite(
      { kind: "retry", jobId: "job-1" },
      {
        state: initialGenerationRequestState(),
        dispatch: (action) => dispatched.push(action),
        effects,
        keys: createGenerationIdempotencyKeys(),
        fetcher: vi.fn() as unknown as typeof fetch,
      },
    );

    expect(dispatched).toEqual([]);
    expect(effects.calls).toEqual([
      "status:Wait for the exact retry price before retrying.",
    ]);
  });
});

describe("generation write outcome protocol", () => {
  it("keeps image-edit instructions and exclusions in the variation write", async () => {
    let body: Record<string, unknown> | null = null;
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        return jobResponse("edit-job-1");
      },
    ) as unknown as typeof fetch;

    await runGenerationWrite(
      {
        kind: "variation",
        mediaId: "source-media-1",
        outputCount: 1,
        consistencyMode: "balanced",
        prompt: "Change the jacket to deep red velvet.",
        negativePrompt: "visible text, duplicate person",
        quote,
        quoteKey: "route-key",
        queuedMessage: "Image edit queued.",
      },
      {
        state: heldQuote(),
        dispatch: () => {},
        effects: recordingEffects(),
        keys: createGenerationIdempotencyKeys(),
        fetcher,
      },
    );

    expect(body).toMatchObject({
      prompt: "Change the jacket to deep red velvet.",
      negativePrompt: "visible text, duplicate person",
      outputCount: 1,
      consistencyMode: "balanced",
    });
  });

  it("marks in flight, applies the job, reveals it, and reprices — in that order", async () => {
    const dispatched: GenerationRequestAction[] = [];
    const effects = recordingEffects();

    await runGenerationWrite(
      {
        kind: "generation",
        body: submissionBody(),
        quote,
        quoteKey: "route-key",
      },
      {
        state: heldQuote(),
        dispatch: (action) => dispatched.push(action),
        effects,
        keys: createGenerationIdempotencyKeys(),
        fetcher: (async () => jobResponse("job-7")) as unknown as typeof fetch,
      },
    );

    expect(dispatched.map((action) => action.type)).toEqual([
      "write_started",
      "write_settled",
    ]);
    expect(effects.calls).toEqual([
      "applyJob:job-7",
      "status:Generation queued.",
      "revealJobs",
      "trackJob:job-7",
      "refreshBalance",
    ]);
  });

  it("keeps a retry inside the jobs list it was fired from", async () => {
    const effects = recordingEffects();

    await runGenerationWrite(
      { kind: "retry", jobId: "job-1" },
      {
        state: stateWith({ retryQuotes: { "job-1": retryQuote } }),
        dispatch: () => {},
        effects,
        keys: createGenerationIdempotencyKeys(),
        fetcher: (async () => jobResponse("job-1")) as unknown as typeof fetch,
      },
    );

    expect(effects.calls).toEqual([
      "applyJob:job-1",
      "status:Retry queued.",
      "refreshBalance",
    ]);
  });

  it.each(["generation", "variation", "retry"] as const)(
    "does not publish an accepted %s result after its viewer is invalidated",
    async (kind) => {
      let resolve!: (response: Response) => void;
      const response = new Promise<Response>((complete) => { resolve = complete; });
      let current = true;
      const dispatch = vi.fn();
      const effects = recordingEffects();
      const keys = createGenerationIdempotencyKeys();
      const request: GenerationWriteRequest = kind === "generation"
        ? { kind, body: submissionBody(), quote, quoteKey: "route-key" }
        : kind === "retry"
          ? { kind, jobId: "job-1" }
          : {
            kind, mediaId: "image-1", outputCount: 1, consistencyMode: "balanced",
            quote, quoteKey: "route-key", queuedMessage: "Variation queued.",
          };
      const pending = runGenerationWrite(request, {
        state: stateWith({ retryQuotes: { "job-1": retryQuote } }),
        dispatch, effects, keys,
        fetcher: () => response,
        isCurrent: () => current,
      });
      current = false;
      resolve(jobResponse("previous-viewer-job"));
      expect(await pending).toMatchObject({ kind: "rejected" });
      expect(keys[kind].size).toBe(1);
      expect(dispatch.mock.calls.map(([action]) => action.type)).toEqual(["write_started"]);
      expect(effects.calls).toEqual([]);
    },
  );

  it("names the failure the way its own intent does", async () => {
    const failing = (async () =>
      Response.json({ ok: false }, { status: 500 })) as unknown as typeof fetch;

    const retryOutcome = await runGenerationWrite(
      { kind: "retry", jobId: "job-1" },
      {
        state: stateWith({ retryQuotes: { "job-1": retryQuote } }),
        dispatch: () => {},
        effects: recordingEffects(),
        keys: createGenerationIdempotencyKeys(),
        fetcher: failing,
      },
    );
    expect(retryOutcome).toMatchObject({ statusMessage: "Retry failed" });

    const submitOutcome = await runGenerationWrite(
      {
        kind: "generation",
        body: submissionBody(),
        quote,
        quoteKey: "route-key",
      },
      {
        state: heldQuote(),
        dispatch: () => {},
        effects: recordingEffects(),
        keys: createGenerationIdempotencyKeys(),
        fetcher: failing,
      },
    );
    expect(submitOutcome).toMatchObject({ statusMessage: "Generation failed." });
  });

  it.each(["Failed to fetch", "NetworkError when attempting to fetch resource.", ""])("uses actionable retry copy for the browser network error %s", async (message) => {
    const outcome = await runGenerationWrite(
      { kind: "retry", jobId: "job-1" },
      {
        state: stateWith({ retryQuotes: { "job-1": retryQuote } }),
        dispatch: () => {},
        effects: recordingEffects(),
        keys: createGenerationIdempotencyKeys(),
        fetcher: async () => { throw new TypeError(message); },
      },
    );

    expect(outcome).toEqual({
      kind: "rejected",
      statusMessage: "Retry failed. Check your connection and try again.",
      authorityAction: "none",
    });
  });

  it("preserves the server's actionable retry error after an HTTP response", async () => {
    const outcome = await runGenerationWrite({ kind: "retry", jobId: "job-1" }, {
      state: stateWith({ retryQuotes: { "job-1": retryQuote } }), dispatch: () => {},
      effects: recordingEffects(), keys: createGenerationIdempotencyKeys(),
      fetcher: async () => Response.json({ ok: false, error: { message: "The generation route is unavailable. Refresh and choose another model." } }, { status: 503 }),
    });
    expect(outcome).toMatchObject({
      kind: "rejected",
      statusMessage: "The generation route is unavailable. Refresh and choose another model.",
    });
  });

  it("refreshes the balance after a 402 but not after an unrelated failure", async () => {
    const insufficient = recordingEffects();
    await runGenerationWrite(
      {
        kind: "generation",
        body: submissionBody(),
        quote,
        quoteKey: "route-key",
      },
      {
        state: heldQuote(),
        dispatch: () => {},
        effects: insufficient,
        keys: createGenerationIdempotencyKeys(),
        fetcher: (async () =>
          Response.json(
            { ok: false, error: { message: "Need 7 coins." } },
            { status: 402 },
          )) as unknown as typeof fetch,
      },
    );
    expect(insufficient.calls).toEqual(["status:Need 7 coins.", "refreshBalance"]);

    const serverError = recordingEffects();
    await runGenerationWrite(
      {
        kind: "generation",
        body: submissionBody(),
        quote,
        quoteKey: "route-key",
      },
      {
        state: heldQuote(),
        dispatch: () => {},
        effects: serverError,
        keys: createGenerationIdempotencyKeys(),
        fetcher: (async () =>
          Response.json({ ok: false }, { status: 500 })) as unknown as typeof fetch,
      },
    );
    expect(serverError.calls).toEqual(["status:Generation failed."]);
  });

  it("tracks concurrent variations one media id at a time", () => {
    const started = reduceGenerationRequest(
      reduceGenerationRequest(initialGenerationRequestState(), {
        type: "write_started",
        write: { kind: "variation", mediaId: "media-1" },
      }),
      { type: "write_started", write: { kind: "variation", mediaId: "media-2" } },
    );
    expect([...started.variationPendingMediaIds]).toEqual(["media-1", "media-2"]);

    const settled = reduceGenerationRequest(started, {
      type: "write_settled",
      write: { kind: "variation", mediaId: "media-1" },
      quoteKey: null,
      outcome: { kind: "rejected", statusMessage: "no", authorityAction: "none" },
    });
    expect([...settled.variationPendingMediaIds]).toEqual(["media-2"]);
  });
});

// The hook watches only the quote key to know a held quote went stale, so the
// key must move whenever anything that moves the price moves.
describe("generation quote key", () => {
  const baseline = {
    viewerScope: "user:viewer-1",
    mode: "image",
    consistencyMode: "balanced",
    target: "generation",
    characterId: "character-1",
    freeplay: false,
  } as const satisfies GenerationQuoteRequest;

  it.each([
    ["the viewer", { viewerScope: "user:viewer-2" }],
    ["the mode", { mode: "video" as const }],
    ["the character", { characterId: "character-2" }],
    ["freeplay", { freeplay: true }],
    ["consistency", { consistencyMode: "strict" as const }],
    ["the explicit model", { model: "public-t2i" }],
    ["the look", { lookId: "look-1" }],
  ])("changes when %s changes", (_field, drift) => {
    expect(generationQuoteKeyFor({ ...baseline, ...drift })).not.toBe(
      generationQuoteKeyFor(baseline),
    );
  });

  it("is stable for an unchanged route", () => {
    expect(generationQuoteKeyFor({ ...baseline })).toBe(
      generationQuoteKeyFor(baseline),
    );
  });

  it("never lets a character route and an image edit share a key", () => {
    expect(
      generationQuoteKeyFor({
        viewerScope: "user:viewer-1",
        mode: "image",
        consistencyMode: "balanced",
        target: "variation",
        mediaId: "media-1",
      }),
    ).not.toBe(generationQuoteKeyFor(baseline));
  });

  it("prices an image edit as a source route, never a character one", () => {
    const key = JSON.parse(
      generationQuoteKeyFor({
        viewerScope: "user:viewer-1",
        mode: "image",
        consistencyMode: "balanced",
        target: "variation",
        mediaId: "media-1",
      }),
    );
    expect(key).toMatchObject({
      sourceMediaId: "media-1",
      characterId: null,
      freeplay: true,
      lookId: null,
    });
  });
});

describe("generation quote transport", () => {
  it("prices the resolved route for a character image request", async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      return Response.json({ ok: true, data: { quote } });
    }) as unknown as typeof fetch;

    const request: GenerationQuoteRequest = {
      viewerScope: "user:viewer-1",
      target: "generation",
      mode: "image",
      characterId: "character-1",
      freeplay: false,
      consistencyMode: "balanced",
      model: "public-t2i",
      lookId: "look-1",
    };
    const outcome = await loadGenerationQuote(request, { fetcher });

    expect(outcome).toMatchObject({
      kind: "resolved",
      key: generationQuoteKeyFor(request),
    });
    expect(seen[0]?.url).toBe("/api/v1/generation/quote");
    expect(seen[0]?.body).toMatchObject({
      mode: "image",
      characterId: "character-1",
      freeplay: false,
      outputCount: 1,
      controls: { model: "public-t2i", lookId: "look-1" },
    });
  });

  it("omits the character when the request is freeplay", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(typeof init?.body === "string" ? JSON.parse(init.body) : {});
      return Response.json({ ok: true, data: { quote } });
    }) as unknown as typeof fetch;

    await loadGenerationQuote(
      {
        viewerScope: "user:viewer-1",
        target: "generation",
        mode: "image",
        characterId: "character-1",
        freeplay: true,
        consistencyMode: "balanced",
      },
      { fetcher },
    );

    expect(seen[0]).not.toHaveProperty("characterId");
  });

  it("prices an image edit against its source media", async () => {
    const seen: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return Response.json({ ok: true, data: { quote } });
    }) as unknown as typeof fetch;

    await loadGenerationQuote(
      {
        viewerScope: "user:viewer-1",
        mode: "image",
        target: "variation",
        mediaId: "media/with spaces",
        consistencyMode: "strict",
      },
      { fetcher },
    );

    expect(seen).toEqual([
      "/api/v1/media/media%2Fwith%20spaces/variation/quote",
    ]);
  });

  it("carries the server's own reason for an unpriceable route", async () => {
    const request: GenerationQuoteRequest = {
      viewerScope: "user:viewer-1",
      target: "generation",
      mode: "video",
      freeplay: true,
      consistencyMode: "balanced",
    };
    const outcome = await loadGenerationQuote(request, {
        fetcher: (async () =>
          Response.json(
          { ok: false, error: { message: "Video is unavailable." } },
          { status: 503 },
        )) as unknown as typeof fetch,
    });

    expect(outcome).toEqual({
      kind: "failed",
      key: generationQuoteKeyFor(request),
      message: "Video is unavailable.",
    });
  });

  it("discards a quote whose request was already abandoned", async () => {
    const controller = new AbortController();
    controller.abort();

    const outcome = await loadGenerationQuote(
      {
        viewerScope: "user:viewer-1",
        target: "generation",
        mode: "image",
        freeplay: true,
        consistencyMode: "balanced",
      },
      {
        fetcher: (async () =>
          Response.json({ ok: true, data: { quote } })) as unknown as typeof fetch,
        signal: controller.signal,
      },
    );

    expect(outcome).toEqual({ kind: "discarded" });
  });

  it("prices each failed job independently, keeping the ones that resolved", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("job-2")) {
        return Response.json(
          { ok: false, error: { message: "No longer retryable." } },
          { status: 409 },
        );
      }
      return Response.json({ ok: true, data: { quote: retryQuote } });
    }) as unknown as typeof fetch;

    const outcome = await loadGenerationRetryQuotes(["job-1", "job-2"], {
      fetcher,
    });

    expect(outcome).toEqual({
      kind: "resolved",
      quotes: { "job-1": retryQuote },
      failures: { "job-2": "No longer retryable." },
    });
  });
});

describe("generation request projection", () => {
  it("clamps the requested count to the quote's ceiling", () => {
    expect(projectGenerationRequest(heldQuote(), viewInput({ count: 9 })).outputCount)
      .toBe(2);
    expect(projectGenerationRequest(heldQuote(), viewInput({ count: 0 })).outputCount)
      .toBe(1);
  });

  it("prices video one clip at a time regardless of the count control", () => {
    const view = projectGenerationRequest(
      heldQuote(),
      viewInput({ mode: "video", count: 2 }),
    );
    expect(view.outputCount).toBe(1);
    expect(view.estimatedCost).toBe(7);
  });

  it("blocks submission while the image-edit source is unpicked", () => {
    expect(
      projectGenerationRequest(heldQuote(), viewInput({ editSourceMediaId: null }))
        .canSubmit,
    ).toBe(false);
  });

  it("counts an in-flight edit of the chosen source as the form submitting", () => {
    const editing = stateWith({
      quote: { key: "route-key", quote },
      variationPendingMediaIds: new Set(["media-1"]),
    });

    const onSource = projectGenerationRequest(
      editing,
      viewInput({ editSourceMediaId: "media-1" }),
    );
    expect(onSource.submitting).toBe(true);
    expect(onSource.canSubmit).toBe(false);

    // A variation running on some other gallery card is not this form's write.
    const elsewhere = projectGenerationRequest(
      editing,
      viewInput({ editSourceMediaId: "media-2" }),
    );
    expect(elsewhere.submitting).toBe(false);
    expect(elsewhere.canSubmit).toBe(true);
  });

  it("blocks submission for an unavailable mode or a missing target", () => {
    expect(
      projectGenerationRequest(heldQuote(), viewInput({ modeAvailable: false }))
        .canSubmit,
    ).toBe(false);
    expect(
      projectGenerationRequest(heldQuote(), viewInput({ hasTarget: false })).canSubmit,
    ).toBe(false);
  });

  it("blocks submission while one is already in flight", () => {
    const busy = stateWith({ quote: { key: "route-key", quote }, submitting: true });
    const view = projectGenerationRequest(busy, viewInput());
    expect(view.submitting).toBe(true);
    expect(view.canSubmit).toBe(false);
  });

  it("shows a pricing failure only for the route it belongs to", () => {
    const failed = stateWith({
      quoteFailure: { key: "route-a", message: "Price unavailable." },
    });

    expect(
      projectGenerationRequest(failed, viewInput({ quoteKey: "route-a" })).quoteError,
    ).toBe("Price unavailable.");
    expect(
      projectGenerationRequest(failed, viewInput({ quoteKey: "route-b" })).quoteError,
    ).toBe("");
  });
});

// These cases cross the writer boundary: storage is a receipt, never proof
// that a later rejected check cancelled an earlier accepted request.
describe("generation receipts across page lifetimes", () => {
  function memoryStorage() {
    const values = new Map<string, string>();
    return {
      values,
      get length() { return values.size; },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
  }
  const authority = {
    profileId: quote.profileId, profileVersion: quote.profileVersion,
    routeFingerprint: quote.routeFingerprint, pricingFingerprint: quote.pricing.fingerprint,
    outputCount: 1, costDreamcoins: 7,
  };
  const kinds = ["generation", "variation", "retry", "enhancement"] as const;
  function send(kind: typeof kinds[number], keys: Map<string, string>, persistence: GenerationReceiptPersistence,
    fetcher: Parameters<typeof requestGenerationJobWithExactAuthority>[1]) {
    const common = { idempotencyKeys: keys, persistence, createIdempotencyKey: () => `${kind}-original-key` };
    if (kind === "generation") return requestGenerationJobWithExactAuthority({ ...common, body: {
      mode: "image", freeplay: true, prompt: "User portrait", outputCount: 1,
      controls: { orientation: "4:5" }, quoteAuthority: authority,
    } }, fetcher);
    if (kind === "variation") return requestMediaVariationWithExactQuote({ ...common, mediaId: "source-1",
      outputCount: 1, consistencyMode: "balanced", prompt: "Blue coat", quote,
    }, fetcher);
    if (kind === "retry") return requestGenerationRetryWithExactAuthority({ ...common, jobId: "failed-job", quoteAuthority: authority }, fetcher);
    return requestMediaEnhancementWithExactQuote({ ...common, mediaId: "source-1", quote }, fetcher);
  }

  it.each(kinds)("persists %s before POST and restores the original body without a new quote", async (kind) => {
    const storage = memoryStorage();
    const persistence = { ownerScope: "user:one", storage };
    let sent = "";
    await expect(send(kind, new Map(), persistence, async (_url, init) => {
      expect(storage.values.size).toBe(1);
      expect(new Headers(init?.headers).get("x-idream-viewer-scope")).toBe("user:one");
      sent = String(init?.body);
      throw new TypeError("connection lost");
    })).rejects.toThrow();
    expect(readGenerationReceipts({ ...persistence, ownerScope: "user:two" })).toEqual([]);
    const [receipt] = readGenerationReceipts(persistence);
    expect(receipt).toBeDefined();
    const restored = new Map([[receipt.record, receipt.key]]);
    const accepted = await requestGenerationReceipt(receipt, { idempotencyKeys: restored, persistence }, async (_url, init) => {
      expect(init?.body).toBe(sent);
      expect(new Headers(init?.headers).get("idempotency-key")).toBe(`${kind}-original-key`);
      expect(new Headers(init?.headers).get("x-idream-viewer-scope")).toBe("user:one");
      return jobResponse("accepted-once");
    });
    expect(accepted.job.id).toBe("accepted-once");
    expect(restored.size).toBe(0);
    expect(storage.values.size).toBe(0);
  });

  it.each([400, 401, 402, 403, 404, 409, 429])("retains a previously unknown request after a %i check until its Job ACK", async (status) => {
    const storage = memoryStorage();
    const persistence = { ownerScope: "user:one", storage };
    const keys = new Map<string, string>();
    await expect(send("generation", keys, persistence, async () => { throw new TypeError("lost"); })).rejects.toThrow();
    const [receipt] = listGenerationReceipts(keys);
    await expect(requestGenerationReceipt(receipt, { idempotencyKeys: keys, persistence }, async () =>
      Response.json({ ok: false, error: { message: "Current request rejected" } }, { status }),
    )).rejects.toThrow("Current request rejected");
    expect(readGenerationReceipts(persistence)).toEqual([receipt]);
    expect(keys.get(receipt.record)).toBe(receipt.key);
    await requestGenerationReceipt(receipt, { idempotencyKeys: keys, persistence }, async () => jobResponse("original-committed-later"));
    expect(storage.values.size).toBe(0);
  });

  it("clears an initial definite refusal and does not block new writes when storage is denied", async () => {
    const storage = memoryStorage();
    const persistence = { ownerScope: "user:one", storage };
    const keys = new Map<string, string>();
    await expect(send("generation", keys, persistence, async () => Response.json({ ok: false }, { status: 402 }))).rejects.toThrow();
    expect(keys.size).toBe(0);
    expect(storage.values.size).toBe(0);
    const warning = vi.fn();
    storage.setItem = () => { throw new Error("Storage denied"); };
    const fetcher = vi.fn(async () => { throw new TypeError("lost"); });
    await expect(send("generation", keys, { ...persistence, onWarning: warning }, fetcher)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(keys.size).toBe(1);
    expect(warning).toHaveBeenCalled();
  });

  it("keeps an old owner's receipt when JSON resolves after the viewer is revoked", async () => {
    const storage = memoryStorage();
    const persistence = { ownerScope: "user:one", storage };
    const keys = new Map<string, string>();
    let current = true;
    let resolveJson!: (value: unknown) => void;
    const response = jobResponse("old-viewer-job");
    vi.spyOn(response, "json").mockImplementation(() => new Promise((resolve) => { resolveJson = resolve; }));
    const pending = requestGenerationJobWithExactAuthority({ body: { mode: "image", freeplay: true, outputCount: 1, quoteAuthority: authority },
      idempotencyKeys: keys, persistence, isCurrent: () => current, createIdempotencyKey: () => "old-viewer-request",
    }, async () => response);
    await Promise.resolve();
    current = false;
    resolveJson({ ok: true, data: { job: { id: "old-viewer-job" }, assets: [] } });
    await expect(pending).rejects.toThrow("Viewer changed");
    expect(readGenerationReceipts({ ...persistence, ownerScope: "user:two" })).toEqual([]);
    expect(readGenerationReceipts(persistence)).toHaveLength(1);
  });

  it("ignores corrupt or foreign target storage and never turns its URL into a POST", async () => {
    const storage = memoryStorage();
    const persistence = { ownerScope: "user:one", storage };
    await expect(send("generation", new Map(), persistence, async () => { throw new TypeError("lost"); })).rejects.toThrow();
    const [name, value] = [...storage.values][0];
    const saved = JSON.parse(value);
    const record = JSON.parse(saved.record);
    saved.record = JSON.stringify({ ...record, url: "https://example.com/collect" });
    storage.values.set(name, JSON.stringify(saved));
    const onWarning = vi.fn();
    expect(readGenerationReceipts({ ...persistence, onWarning })).toEqual([]);
    expect(onWarning).toHaveBeenCalled();
  });

  it("keeps two independently submitted identical bodies addressable and ACKs only the selected key", async () => {
    const storage = memoryStorage();
    const persistence = { ownerScope: "user:one", storage };
    for (const key of ["first-tab-key", "second-tab-key"]) {
      await expect(requestGenerationJobWithExactAuthority({ body: { mode: "image", freeplay: true, outputCount: 1, quoteAuthority: authority },
        idempotencyKeys: new Map(), persistence, createIdempotencyKey: () => key,
      }, async () => { throw new TypeError("lost"); })).rejects.toThrow();
    }
    const receipts = readGenerationReceipts(persistence);
    const keys = new Map(receipts.map((receipt) => [receipt.record, receipt.key]));
    expect(keys.size).toBe(2);
    await requestGenerationReceipt(receipts[1], { idempotencyKeys: keys, persistence }, async (_url, init) => {
      expect(new Headers(init?.headers).get("idempotency-key")).toBe("second-tab-key");
      return jobResponse("second-tab-job");
    });
    expect(readGenerationReceipts(persistence).map((receipt) => receipt.key)).toEqual(["first-tab-key"]);
  });

  it("does not consume a receipt for an unreadable success Job", async () => {
    const storage = memoryStorage();
    const persistence = { ownerScope: "user:one", storage };
    const keys = new Map<string, string>();
    await expect(send("generation", keys, persistence, async () =>
      Response.json({ ok: true, data: { job: { id: "incomplete" }, assets: [] } }),
    )).rejects.toThrow();
    expect(keys.size).toBe(1);
    expect(readGenerationReceipts(persistence)).toHaveLength(1);
  });
});
