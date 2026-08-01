import { describe, expect, it } from "vitest";
import {
  completedUtcCharacterPerformanceWindow,
  evaluateCharacterPerformance,
  evaluateContributionMargin,
  utcProductDayCeiling,
} from "./performance";

const asOf = new Date("2026-07-11T00:00:00.000Z");

function exposureRows(impressions: number, details: number) {
  return [
    ...Array.from({ length: impressions }, (_, index) => ({
      exposureId: `impression-${index}`,
      parentExposureId: null,
      eventType: "eligible_impression",
      coverageState: "exact",
      occurredAt: new Date("2026-07-10T00:00:00.000Z"),
    })),
    ...Array.from({ length: details }, (_, index) => ({
      exposureId: `detail-${index}`,
      parentExposureId: `impression-${index}`,
      eventType: "detail_view",
      coverageState: "exact",
      occurredAt: new Date("2026-07-10T01:00:00.000Z"),
    })),
  ];
}

describe("canonical Character Performance", () => {
  it("uses only complete UTC product days for daily and timestamp facts", () => {
    expect(completedUtcCharacterPerformanceWindow({
      asOf: new Date("2026-07-17T12:34:56.000Z"),
      window: "7d",
    })).toEqual({
      start: new Date("2026-07-10T00:00:00.000Z"),
      end: new Date("2026-07-17T00:00:00.000Z"),
    });
    expect(utcProductDayCeiling(new Date("2026-07-17T00:00:00.000Z")))
      .toEqual(new Date("2026-07-17T00:00:00.000Z"));
    expect(utcProductDayCeiling(new Date("2026-07-17T00:00:00.001Z")))
      .toEqual(new Date("2026-07-18T00:00:00.000Z"));
  });

  it("computes a golden exact 7d release/placement cohort without inventing margin", () => {
    const summary = evaluateCharacterPerformance({
      characterContentVersionId: "content-v2",
      characterReleaseId: "release-v2",
      placementId: "feed.hero",
      releasePublishedAt: new Date("2026-06-01T00:00:00.000Z"),
      window: "7d",
      asOf,
      exposureRows: exposureRows(120, 60),
      funnelRows: [{
        eligibleImpressions: 120,
        detailViews: 60,
        firstSuccessfulExchanges: 30,
        qceCount: 15,
        relationshipActivations: 8,
        sameCharacterD7EligiblePairs: 10,
        sameCharacterD7Returns: 4,
        paidAttributions: 3,
        coverageState: "exact",
        latestDataAt: new Date("2026-07-10T02:00:00.000Z"),
        sourceEvidence: ["projector:character-funnel-v1"],
      }],
      economicsRows: [{
        kind: "variable_cost",
        amountMicros: BigInt(200),
        currency: "USD",
        authorityType: "ai_usage_fact",
        authorityId: "usage-1",
        auditState: "audited",
        coverageState: "exact",
      }],
      economicsAuthority: {
        cashCaptureComplete: false,
        refundsComplete: false,
        creditsComplete: false,
        variableCostsComplete: true,
      },
    });

    expect(summary).toMatchObject({
      qualityState: "certified",
      maturity: "mature",
      detailCtr: 0.5,
      chatStartRate: 0.5,
      qceRate: 0.5,
      sameCharacterD7: 0.4,
      contributionMargin: {
        valueMicros: null,
        qualityState: "invalid",
        variableCostMicros: 200,
      },
    });
    expect(summary.contributionMargin.evidence).toContain("cash_capture_attribution_authority_incomplete");
  });

  it("fails all rates closed when attribution is partial", () => {
    const summary = evaluateCharacterPerformance({
      characterContentVersionId: "content-v2",
      characterReleaseId: "release-v2",
      placementId: null,
      releasePublishedAt: new Date("2026-06-01T00:00:00.000Z"),
      window: "28d",
      asOf,
      exposureRows: [{
        exposureId: "unattributed-impression",
        parentExposureId: null,
        eventType: "eligible_impression",
        coverageState: "exact_unattributed",
        occurredAt: asOf,
      }],
      funnelRows: [],
      economicsRows: [],
      economicsAuthority: {
        cashCaptureComplete: false,
        refundsComplete: false,
        creditsComplete: false,
        variableCostsComplete: false,
      },
    });
    expect(summary).toMatchObject({
      qualityState: "invalid",
      detailCtr: null,
      chatStartRate: null,
      qceRate: null,
      sameCharacterD7: null,
    });
  });

  // SPEC: 无观测 ≠ 观测不可信。以前两者都落 invalid，还附带两条并不存在的链路故障原因，
  // 结果是每个刚上线的角色天天报"数据不可用"，运营很快学会无视这个字段。
  it("reports no_data instead of inventing a broken pipeline when nothing was observed", () => {
    const summary = evaluateCharacterPerformance({
      characterContentVersionId: "content-v2",
      characterReleaseId: "release-v2",
      placementId: null,
      releasePublishedAt: new Date("2026-07-09T00:00:00.000Z"),
      window: "7d",
      asOf,
      exposureRows: [],
      funnelRows: [],
      economicsRows: [],
      economicsAuthority: {
        cashCaptureComplete: false,
        refundsComplete: false,
        creditsComplete: false,
        variableCostsComplete: false,
      },
    });
    expect(summary).toMatchObject({
      qualityState: "no_data",
      coverageState: "unavailable",
      sampleSize: 0,
      detailCtr: null,
      chatStartRate: null,
      qceRate: null,
      sameCharacterD7: null,
    });
    expect(summary.evidence).toContain("no_observations_recorded");
    expect(summary.evidence).not.toContain("eligible_impression_or_detail_chain_not_exact");
    expect(summary.evidence).not.toContain("funnel_projection_not_exact");
  });

  it("still reports invalid when only half of the observation chain arrived", () => {
    const summary = evaluateCharacterPerformance({
      characterContentVersionId: "content-v2",
      characterReleaseId: "release-v2",
      placementId: null,
      releasePublishedAt: new Date("2026-06-01T00:00:00.000Z"),
      window: "7d",
      asOf,
      exposureRows: [],
      funnelRows: [{
        eligibleImpressions: 40,
        detailViews: 20,
        firstSuccessfulExchanges: 10,
        qceCount: 5,
        relationshipActivations: 2,
        sameCharacterD7EligiblePairs: 4,
        sameCharacterD7Returns: 1,
        paidAttributions: 1,
        coverageState: "exact",
        latestDataAt: new Date("2026-07-10T02:00:00.000Z"),
        sourceEvidence: ["projector:character-funnel-v1"],
      }],
      economicsRows: [],
      economicsAuthority: {
        cashCaptureComplete: false,
        refundsComplete: false,
        creditsComplete: false,
        variableCostsComplete: false,
      },
    });
    expect(summary.qualityState).toBe("invalid");
    expect(summary.evidence).toContain("eligible_impression_or_detail_chain_not_exact");
    expect(summary.evidence).not.toContain("no_observations_recorded");
  });

  it("keeps verified funnel rates directional when only paid attribution is unavailable", () => {
    const summary = evaluateCharacterPerformance({
      characterContentVersionId: "content-v2",
      characterReleaseId: "release-v2",
      placementId: "feed.hero",
      releasePublishedAt: new Date("2026-06-01T00:00:00.000Z"),
      window: "7d",
      asOf,
      exposureRows: exposureRows(120, 60),
      funnelRows: [{
        eligibleImpressions: 120,
        detailViews: 60,
        firstSuccessfulExchanges: 30,
        qceCount: 15,
        relationshipActivations: 8,
        sameCharacterD7EligiblePairs: 10,
        sameCharacterD7Returns: 4,
        paidAttributions: 0,
        coverageState: "exact_through_same_character_d7_paid_attribution_unavailable",
        latestDataAt: new Date("2026-07-10T02:00:00.000Z"),
        sourceEvidence: ["paid_attribution:unavailable"],
      }],
      economicsRows: [],
      economicsAuthority: {
        cashCaptureComplete: false,
        refundsComplete: false,
        creditsComplete: false,
        variableCostsComplete: false,
      },
    });
    expect(summary).toMatchObject({
      qualityState: "directional",
      coverageState: "partial",
      detailCtr: 0.5,
      chatStartRate: 0.5,
      qceRate: 0.5,
      sameCharacterD7: 0.4,
    });
    expect(summary.evidence).toContain("paid_attribution_unavailable");
  });

  it("excludes a detail view whose parent impression is outside the reporting cohort", () => {
    const summary = evaluateCharacterPerformance({
      characterContentVersionId: "content-v2",
      characterReleaseId: "release-v2",
      placementId: "feed.hero",
      releasePublishedAt: new Date("2026-06-01T00:00:00.000Z"),
      window: "7d",
      asOf,
      exposureRows: [{
        exposureId: "detail-inside-window",
        parentExposureId: "impression-before-window",
        eventType: "detail_view",
        coverageState: "exact",
        occurredAt: new Date("2026-07-10T01:00:00.000Z"),
      }],
      funnelRows: [],
      economicsRows: [],
      economicsAuthority: {
        cashCaptureComplete: false,
        refundsComplete: false,
        creditsComplete: false,
        variableCostsComplete: false,
      },
    });

    expect(summary).toMatchObject({
      eligibleImpressions: 0,
      detailViews: 0,
      qualityState: "invalid",
    });
    expect(summary.evidence).toContain("detail_view_parent_outside_reporting_cohort");
  });

  it("can certify margin only when every audited authority is complete", () => {
    expect(evaluateContributionMargin({
      facts: [
        { kind: "cash_revenue", amountMicros: BigInt(1_000), currency: "USD", authorityType: "payment_capture_v2", authorityId: "pay-1", auditState: "audited", coverageState: "exact" },
        { kind: "refund", amountMicros: BigInt(100), currency: "USD", authorityType: "payment_refund_v2", authorityId: "refund-1", auditState: "audited", coverageState: "exact" },
        { kind: "credit", amountMicros: BigInt(50), currency: "USD", authorityType: "cash_credit_v2", authorityId: "credit-1", auditState: "audited", coverageState: "exact" },
        { kind: "variable_cost", amountMicros: BigInt(200), currency: "USD", authorityType: "ai_usage_fact", authorityId: "usage-1", auditState: "audited", coverageState: "exact" },
      ],
      authority: {
        cashCaptureComplete: true,
        refundsComplete: true,
        creditsComplete: true,
        variableCostsComplete: true,
      },
    })).toMatchObject({ valueMicros: 650, qualityState: "certified" });
  });
});
