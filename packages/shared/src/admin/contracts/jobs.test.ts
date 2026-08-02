import { describe, expect, it } from "vitest";
import {
  generationArtifactValidationStateSchema,
  generationAttemptStatusSchema,
  generationDeliveryStatusSchema,
  generationJobDetailResponseSchema,
  generationJobListResponseSchema,
  generationJobQuerySchema,
  unknownGenerationReconciliationCommandSchema,
  unknownGenerationReconciliationResultSchema,
} from "./jobs";

describe("Generation Jobs v2 contracts", () => {
  it("parses bounded server filters and explicit stable sort", () => {
    expect(generationJobQuerySchema.parse({
      search: "timeout",
      mode: "image",
      legacyStatus: "failed",
      provider: "local",
      sourceType: "generator",
      userId: "user-1",
      characterId: "character-1",
      sort: "created_desc",
      limit: "25",
    })).toMatchObject({ mode: "image", legacyStatus: "failed", sort: "created_desc", limit: 25 });
  });

  it("rejects unknown filters, unsupported states, and unbounded limits", () => {
    expect(generationJobQuerySchema.parse({}).mode).toBe("image");
    expect(generationJobQuerySchema.safeParse({ arbitrary: "client-only" }).success).toBe(false);
    expect(generationJobQuerySchema.safeParse({ legacyStatus: "mystery" }).success).toBe(false);
    expect(generationJobQuerySchema.safeParse({ status: "failed" }).success).toBe(false);
    expect(generationJobQuerySchema.safeParse({ sort: "random" }).success).toBe(false);
    expect(generationJobQuerySchema.safeParse({ limit: 201 }).success).toBe(false);
  });

  it("accepts every authoritative Delivery terminal state and rejects unknown values", () => {
    for (const status of ["pending", "delivered", "failed", "suppressed"]) {
      expect(generationDeliveryStatusSchema.parse(status)).toBe(status);
    }
    expect(generationDeliveryStatusSchema.safeParse("cancelled").success).toBe(false);
  });

  it("represents recovered evidence without rewriting an unknown Attempt", () => {
    expect(generationArtifactValidationStateSchema.parse("late_after_unknown"))
      .toBe("late_after_unknown");
  });

  it("requires an explicit audited resolution for an unknown Attempt", () => {
    expect(unknownGenerationReconciliationCommandSchema.parse({
      resolution: "adopt_succeeded",
      entityVersion: 3,
      reason: "Validated late terminal evidence contains the delivered output.",
      providerEvidenceRefs: ["terminal-record:attempt-1"],
      confirmation: "request-1:adopt_succeeded",
    })).toMatchObject({ resolution: "adopt_succeeded" });

    expect(unknownGenerationReconciliationCommandSchema.parse({
      resolution: "confirm_failed",
      entityVersion: 3,
      reason: "Provider support confirmed that no output was produced.",
      providerEvidenceRefs: ["provider-ticket:case-42"],
      confirmation: "request-1:confirm_failed",
    })).toMatchObject({ resolution: "confirm_failed", entityVersion: 3 });

    expect(unknownGenerationReconciliationCommandSchema.parse({
      resolution: "remain_unknown",
      entityVersion: 3,
      reason: "Provider support investigation is still in progress.",
      providerEvidenceRefs: ["provider-request:req-42"],
      nextReviewAt: "2026-08-03T12:00:00.000Z",
      confirmation: "request-1:remain_unknown",
    })).toMatchObject({ resolution: "remain_unknown" });

    expect(unknownGenerationReconciliationCommandSchema.safeParse({
      resolution: "remain_unknown",
      entityVersion: 3,
      reason: "Wait",
      providerEvidenceRefs: [],
      confirmation: "request-1:remain_unknown",
    }).success).toBe(false);
    expect(unknownGenerationReconciliationCommandSchema.safeParse({
      resolution: "confirm_failed",
      entityVersion: 3,
      reason: "Provider confirmed failure.",
      providerEvidenceRefs: [],
      nextReviewAt: "2026-08-03T12:00:00.000Z",
      confirmation: "request-1:confirm_failed",
    }).success).toBe(false);

    expect(unknownGenerationReconciliationResultSchema.parse({
      commandId: "command-1",
      requestId: "request-1",
      attemptId: "attempt-1",
      attemptStatus: "unknown",
      resolution: "confirm_failed",
      requestStatus: "failed",
      version: 4,
      refundAmount: 8,
      deliveredCount: 0,
      nextReviewAt: null,
      reconciledAt: "2026-08-02T12:00:00.000Z",
    }).attemptStatus).toBe("unknown");
  });

  it("projects blocked attempts and terminal-record transport evidence", () => {
    expect(generationAttemptStatusSchema.parse("blocked")).toBe("blocked");
    const transport = {
      id: "transport-1",
      attemptId: "attempt-1",
      transportAttemptNo: 1,
      provider: "backend",
      providerRequestId: null,
      idempotencyKey: "generation:attempt-1:provider",
      status: "failed",
      latencyMs: 400,
      costMicros: null,
      pricingVersion: null,
      terminalRecordRef: "gen/terminal-records/attempt-1/terminal.json",
      startedAt: "2026-07-11T12:00:00.000Z",
      finishedAt: "2026-07-11T12:00:01.000Z",
    };
    expect(
      generationJobDetailResponseSchema.shape.transportExecutions.parse([transport]),
    ).toEqual([transport]);
    expect(
      generationJobDetailResponseSchema.shape.transportExecutions.safeParse([
        { ...transport, terminalRecordRef: undefined, manifestRef: transport.terminalRecordRef },
      ]).success,
    ).toBe(false);
  });

  it("requires exact totals, facets, freshness, and redacted job rows", () => {
    const response = {
      items: [{
        id: "job-1",
        userId: "user-1",
        characterId: null,
        derivedFromJobId: null,
        mode: "image",
        requestOutcome: "failed",
        legacyStatus: "failed",
        latestAttempt: null,
        unknownReview: { status: "not_applicable", nextReviewAt: null },
        delivery: { expectedOutputCount: 2, deliveredCount: 0, pendingCount: 0, failedCount: 0, suppressedCount: 0 },
        settlement: { view: "captured", capturedDreamcoins: 4, refundedDreamcoins: 0 },
        provider: "local",
        model: "flux",
        profileId: "profile-1",
        profileVersion: 2,
        recipeId: null,
        recipeVersion: null,
        sourceType: "generator",
        sourceId: null,
        errorCode: "timeout",
        outputCount: 2,
        deliveredOutputCount: 0,
        assetCount: 0,
        costDreamcoins: 4,
        promptHidden: true,
        negativePromptHidden: false,
        version: 1,
        createdAt: "2026-07-11T12:00:00.000Z",
        updatedAt: "2026-07-11T12:01:00.000Z",
        finishedAt: null,
      }],
      pageInfo: { endCursor: "opaque-cursor", hasNextPage: true },
      facets: {
        legacyStatuses: [{ value: "failed", count: 12 }],
        modes: [{ value: "image", count: 12 }],
        providers: [{ value: "local", count: 12 }],
        sourceTypes: [{ value: "generator", count: 12 }],
      },
      summary: {
        totalCount: 12,
        totalCostDreamcoins: 48,
        totalOutputCount: 24,
        totalDeliveredOutputCount: 0,
      },
      dataScope: {
        kind: "operational",
        includedDataClasses: ["customer", "internal"],
        excludedDataClasses: ["fixture", "audit"],
      },
      asOf: "2026-07-11T12:02:00.000Z",
      freshness: "fresh",
    };
    expect(generationJobListResponseSchema.parse(response).summary.totalCount).toBe(12);
    expect(generationJobListResponseSchema.parse(response).dataScope).toEqual({
      kind: "operational",
      includedDataClasses: ["customer", "internal"],
      excludedDataClasses: ["fixture", "audit"],
    });
    expect(generationJobListResponseSchema.safeParse({
      ...response,
      items: [{ ...response.items[0], prompt: "must not cross the list boundary" }],
    }).success).toBe(false);
    expect(generationJobListResponseSchema.safeParse({ ...response, summary: undefined }).success).toBe(false);
  });
});
