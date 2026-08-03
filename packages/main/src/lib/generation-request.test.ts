import { describe, expect, it, vi } from "vitest";
import {
  createGenerationIdempotencyKeys,
  generationAuthorityActionForStatus,
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
  type GenerationRequestEffects,
  type GenerationRequestState,
  type GenerationRequestViewInput,
} from "./generation-request";
import { GENERATION_JOB_STATUSES } from "@idream/shared/catalog";
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

  it("falls back to a connection message when the write never reached a status", async () => {
    const outcome = await runGenerationWrite(
      { kind: "retry", jobId: "job-1" },
      {
        state: stateWith({ retryQuotes: { "job-1": retryQuote } }),
        dispatch: () => {},
        effects: recordingEffects(),
        keys: createGenerationIdempotencyKeys(),
        fetcher: (async () => {
          throw new TypeError("");
        }) as unknown as typeof fetch,
      },
    );

    expect(outcome).toEqual({
      kind: "rejected",
      statusMessage: "Retry failed. Check your connection and try again.",
      authorityAction: "none",
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

    const outcome = await loadGenerationQuote(
      {
        key: "route-key",
        target: "generation",
        mode: "image",
        characterId: "character-1",
        freeplay: false,
        consistencyMode: "balanced",
        model: "public-t2i",
        lookId: "look-1",
      },
      { fetcher },
    );

    expect(outcome).toMatchObject({ kind: "resolved", key: "route-key" });
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
        key: "route-key",
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
        key: "route-key",
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
    const outcome = await loadGenerationQuote(
      {
        key: "route-key",
        target: "generation",
        mode: "video",
        freeplay: true,
        consistencyMode: "balanced",
      },
      {
        fetcher: (async () =>
          Response.json(
            { ok: false, error: { message: "Video is unavailable." } },
            { status: 503 },
          )) as unknown as typeof fetch,
      },
    );

    expect(outcome).toEqual({
      kind: "failed",
      key: "route-key",
      message: "Video is unavailable.",
    });
  });

  it("discards a quote whose request was already abandoned", async () => {
    const controller = new AbortController();
    controller.abort();

    const outcome = await loadGenerationQuote(
      {
        key: "route-key",
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
