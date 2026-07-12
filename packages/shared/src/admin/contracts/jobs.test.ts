import { describe, expect, it } from "vitest";
import {
  generationJobListResponseSchema,
  generationJobQuerySchema,
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
      asOf: "2026-07-11T12:02:00.000Z",
      freshness: "fresh",
    };
    expect(generationJobListResponseSchema.parse(response).summary.totalCount).toBe(12);
    expect(generationJobListResponseSchema.safeParse({
      ...response,
      items: [{ ...response.items[0], prompt: "must not cross the list boundary" }],
    }).success).toBe(false);
    expect(generationJobListResponseSchema.safeParse({ ...response, summary: undefined }).success).toBe(false);
  });
});
