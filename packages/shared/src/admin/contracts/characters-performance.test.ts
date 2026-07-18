import { describe, expect, it } from "vitest";
import {
  characterContributionMarginSchema,
  characterPerformanceSummarySchema,
  characterPortfolioDecisionRequestSchema,
  characterReleaseChangeMarkerSchema,
} from "./characters";
import {
  characterExposureRecordedV2Schema,
  chatExchangeCompletedV2Schema,
} from "../../contracts/metric-events";

const invalidMargin = {
  valueMicros: null,
  currency: null,
  attributedRevenueMicros: null,
  refundMicros: null,
  creditMicros: null,
  variableCostMicros: 42,
  qualityState: "invalid" as const,
  evidence: ["captured cash revenue authority is unavailable"],
};

describe("Character Portfolio v2 contracts", () => {
  it("fails closed when contribution margin has no audited revenue authority", () => {
    expect(characterContributionMarginSchema.parse(invalidMargin)).toEqual(invalidMargin);
    expect(characterContributionMarginSchema.safeParse({
      ...invalidMargin,
      valueMicros: -42,
    }).success).toBe(false);
  });

  it("rejects rates whose numerators do not belong to their denominators", () => {
    const result = characterPerformanceSummarySchema.safeParse({
      characterContentVersionId: "content-v2",
      characterReleaseId: "release-v2",
      placementId: "feed.hero",
      window: "7d",
      windowStart: "2026-07-04T00:00:00.000Z",
      windowEnd: "2026-07-11T00:00:00.000Z",
      eligibleImpressions: 10,
      detailViews: 11,
      firstSuccessfulExchanges: 4,
      qceCount: 3,
      relationshipActivations: 2,
      sameCharacterD7EligiblePairs: 2,
      sameCharacterD7Returns: 1,
      paidAttributions: 0,
      detailCtr: 1,
      chatStartRate: 4 / 11,
      qceRate: 0.75,
      sameCharacterD7: 0.5,
      sampleSize: 10,
      maturity: "mature",
      qualityState: "certified",
      coverageState: "exact",
      latestDataAt: "2026-07-10T00:00:00.000Z",
      evidence: ["character_funnel_daily:v1"],
      contributionMargin: invalidMargin,
    });
    expect(result.success).toBe(false);
  });

  it("keeps impossible raw cohort counts only as an explicit fail-closed diagnostic", () => {
    const result = characterPerformanceSummarySchema.safeParse({
      characterContentVersionId: "content-v2",
      characterReleaseId: "release-v2",
      placementId: "feed.hero",
      window: "7d",
      windowStart: "2026-07-04T00:00:00.000Z",
      windowEnd: "2026-07-11T00:00:00.000Z",
      eligibleImpressions: 0,
      detailViews: 0,
      firstSuccessfulExchanges: 4,
      qceCount: 3,
      relationshipActivations: 2,
      sameCharacterD7EligiblePairs: 2,
      sameCharacterD7Returns: 1,
      paidAttributions: 0,
      detailCtr: null,
      chatStartRate: null,
      qceRate: null,
      sameCharacterD7: null,
      sampleSize: 0,
      maturity: "insufficient_data",
      qualityState: "invalid",
      coverageState: "invalid",
      latestDataAt: "2026-07-10T00:00:00.000Z",
      evidence: ["numerator_outside_denominator_cohort"],
      contributionMargin: invalidMargin,
    });
    expect(result.success).toBe(true);
  });

  it("requires evidence and review criteria for all five portfolio decisions", () => {
    for (const decision of ["Promote", "Maintain", "Improve", "Pause", "Retire"] as const) {
      expect(characterPortfolioDecisionRequestSchema.parse({
        releaseId: "release-v2",
        decision,
        question: "What should we do with this supply investment?",
        evidenceRefs: ["performance:release-v2:28d"],
        evidenceLevel: "observational",
        successCriteria: ["QCE rate improves without D7 regression"],
      }).decision).toBe(decision);
    }
  });

  it("does not expose version deltas when releases are not comparable", () => {
    expect(characterReleaseChangeMarkerSchema.safeParse({
      currentReleaseId: "release-v2",
      previousReleaseId: "release-v1",
      changedAt: "2026-07-01T00:00:00.000Z",
      window: "28d",
      comparable: false,
      qceRateDelta: 0.1,
      sameCharacterD7Delta: null,
      contributionMarginDeltaMicros: null,
      evidence: ["previous release has insufficient sample"],
    }).success).toBe(false);
  });

  it("requires a parent exposure for detail-view attribution", () => {
    expect(characterExposureRecordedV2Schema.safeParse({
      exposureId: "detail-1",
      eventType: "detail_view",
      journeyId: "journey-1",
      characterId: "character-1",
      characterContentVersionId: "content-1",
      characterReleaseId: "release-1",
      placementId: "feed.hero",
      userId: "user-1",
      visibleRatio: 1,
      visibleDurationMs: 0,
    }).success).toBe(false);
  });

  it("requires complete entry attribution on chat exchange outcomes", () => {
    expect(chatExchangeCompletedV2Schema.safeParse({
      exchangeId: "exchange-1",
      userMessageId: "user-message-1",
      assistantMessageId: "assistant-message-1",
      selectedAssistantMessageId: "assistant-message-1",
      assistantAttemptNo: 1,
      isRegeneration: false,
      sessionId: "session-1",
      engagementSessionId: "engagement-1",
      userId: "user-1",
      characterId: "character-1",
      characterContentVersionId: "content-1",
      characterReleaseId: "release-1",
      entryExposureId: "detail-1",
    }).success).toBe(false);
  });
});
