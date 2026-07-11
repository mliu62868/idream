import type {
  CharacterContributionMargin,
  CharacterPerformanceSummary,
  CharacterPerformanceWindow,
} from "@idream/shared/admin";

const DAY_MS = 24 * 60 * 60 * 1_000;
const MIN_IMPRESSIONS = 100;
const MIN_CHAT_STARTS = 20;

export interface CharacterFunnelRow {
  readonly eligibleImpressions: number;
  readonly detailViews: number;
  readonly firstSuccessfulExchanges: number;
  readonly qceCount: number;
  readonly relationshipActivations: number;
  readonly sameCharacterD7EligiblePairs: number;
  readonly sameCharacterD7Returns: number;
  readonly paidAttributions: number;
  readonly coverageState: string;
  readonly latestDataAt: Date | null;
  readonly sourceEvidence: unknown;
}

export interface CharacterExposureRow {
  readonly eventType: string;
  readonly coverageState: string;
  readonly occurredAt: Date;
}

export interface CharacterEconomicsRow {
  readonly kind: string;
  readonly amountMicros: bigint;
  readonly currency: string;
  readonly authorityType: string;
  readonly authorityId: string;
  readonly auditState: string;
  readonly coverageState: string;
}

export interface EconomicsAuthorityCoverage {
  readonly cashCaptureComplete: boolean;
  readonly refundsComplete: boolean;
  readonly creditsComplete: boolean;
  readonly variableCostsComplete: boolean;
}

function windowDays(window: CharacterPerformanceWindow) {
  return window === "7d" ? 7 : 28;
}

function ratio(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : null;
}

function evidenceStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function safeBigIntNumber(value: bigint): number | null {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) return null;
  return Number(value);
}

export function evaluateContributionMargin(input: {
  readonly facts: readonly CharacterEconomicsRow[];
  readonly authority: EconomicsAuthorityCoverage;
}): CharacterContributionMargin {
  const exactAudited = input.facts.filter((fact) => fact.auditState === "audited" && fact.coverageState === "exact");
  const currencies = new Set(exactAudited.map((fact) => fact.currency.toUpperCase()));
  const sum = (kind: string) => exactAudited
    .filter((fact) => fact.kind === kind)
    .reduce((total, fact) => total + fact.amountMicros, BigInt(0));
  const revenue = sum("cash_revenue");
  const refunds = sum("refund");
  const credits = sum("credit");
  const costs = sum("variable_cost");
  const evidence = [
    ...exactAudited.map((fact) => `${fact.authorityType}:${fact.authorityId}`),
    ...(!input.authority.cashCaptureComplete ? ["cash_capture_attribution_authority_incomplete"] : []),
    ...(!input.authority.refundsComplete ? ["refund_attribution_authority_incomplete"] : []),
    ...(!input.authority.creditsComplete ? ["credit_attribution_authority_incomplete"] : []),
    ...(!input.authority.variableCostsComplete ? ["variable_cost_authority_incomplete"] : []),
    ...(currencies.size > 1 ? ["mixed_currency_requires_certified_fx"] : []),
    ...(revenue === BigInt(0) ? ["no_audited_attributed_cash_revenue"] : []),
  ];
  const authorityComplete = Object.values(input.authority).every(Boolean);
  const components = [revenue, refunds, credits, costs].map(safeBigIntNumber);
  const valid = authorityComplete && currencies.size === 1 && revenue > BigInt(0) && components.every((value) => value !== null);
  if (!valid) {
    return {
      valueMicros: null,
      currency: currencies.size === 1 ? [...currencies][0] : null,
      attributedRevenueMicros: input.authority.cashCaptureComplete ? components[0] : null,
      refundMicros: input.authority.refundsComplete ? components[1] : null,
      creditMicros: input.authority.creditsComplete ? components[2] : null,
      variableCostMicros: input.authority.variableCostsComplete ? components[3] : null,
      qualityState: "invalid",
      evidence: evidence.length > 0 ? evidence : ["auditable_economics_authority_unavailable"],
    };
  }
  return {
    valueMicros: (components[0] as number) - (components[1] as number) - (components[2] as number) - (components[3] as number),
    currency: [...currencies][0],
    attributedRevenueMicros: components[0],
    refundMicros: components[1],
    creditMicros: components[2],
    variableCostMicros: components[3],
    qualityState: "certified",
    evidence: evidence.length > 0 ? evidence : ["audited_character_economics_facts"],
  };
}

export function evaluateCharacterPerformance(input: {
  readonly characterContentVersionId: string;
  readonly characterReleaseId: string;
  readonly placementId: string | null;
  readonly releasePublishedAt: Date;
  readonly window: CharacterPerformanceWindow;
  readonly asOf: Date;
  readonly funnelRows: readonly CharacterFunnelRow[];
  readonly exposureRows: readonly CharacterExposureRow[];
  readonly economicsRows: readonly CharacterEconomicsRow[];
  readonly economicsAuthority: EconomicsAuthorityCoverage;
}): CharacterPerformanceSummary {
  const days = windowDays(input.window);
  const windowStart = new Date(input.asOf.getTime() - days * DAY_MS);
  const exactExposures = input.exposureRows.filter((row) => row.coverageState === "exact");
  const eligibleImpressions = exactExposures.filter((row) => row.eventType === "eligible_impression").length;
  const detailViews = exactExposures.filter((row) => row.eventType === "detail_view").length;
  const sum = (key: keyof Omit<CharacterFunnelRow, "coverageState" | "latestDataAt" | "sourceEvidence">) =>
    input.funnelRows.reduce((total, row) => total + row[key], 0);
  const firstSuccessfulExchanges = sum("firstSuccessfulExchanges");
  const qceCount = sum("qceCount");
  const relationshipActivations = sum("relationshipActivations");
  const sameCharacterD7EligiblePairs = sum("sameCharacterD7EligiblePairs");
  const sameCharacterD7Returns = sum("sameCharacterD7Returns");
  const paidAttributions = sum("paidAttributions");
  const impossible = detailViews > eligibleImpressions ||
    firstSuccessfulExchanges > detailViews ||
    qceCount > firstSuccessfulExchanges ||
    sameCharacterD7Returns > sameCharacterD7EligiblePairs;
  const exactFunnel = input.funnelRows.length > 0 && input.funnelRows.every((row) => row.coverageState === "exact");
  const exactExposure = input.exposureRows.length > 0 && exactExposures.length === input.exposureRows.length;
  const qualityState = impossible || !exactFunnel || !exactExposure ? "invalid" as const : "certified" as const;
  const observationMature = input.releasePublishedAt.getTime() + days * DAY_MS <= input.asOf.getTime();
  const maturity = !observationMature
    ? "immature" as const
    : eligibleImpressions < MIN_IMPRESSIONS || firstSuccessfulExchanges < MIN_CHAT_STARTS
      ? "insufficient_data" as const
      : "mature" as const;
  const latestTimes = [
    ...input.exposureRows.map((row) => row.occurredAt.getTime()),
    ...input.funnelRows.flatMap((row) => row.latestDataAt ? [row.latestDataAt.getTime()] : []),
  ];
  const evidence = [
    `grain:${input.characterContentVersionId}/${input.characterReleaseId}/${input.placementId ?? "all"}`,
    ...input.funnelRows.flatMap((row) => evidenceStrings(row.sourceEvidence)),
    ...(!exactExposure ? ["eligible_impression_or_detail_chain_not_exact"] : []),
    ...(!exactFunnel ? ["funnel_projection_not_exact"] : []),
    ...(impossible ? ["numerator_outside_denominator_cohort"] : []),
    ...(maturity === "insufficient_data" ? [`minimum_sample:${MIN_IMPRESSIONS}_impressions/${MIN_CHAT_STARTS}_chat_starts`] : []),
  ];
  return {
    characterContentVersionId: input.characterContentVersionId,
    characterReleaseId: input.characterReleaseId,
    placementId: input.placementId,
    window: input.window,
    windowStart: windowStart.toISOString(),
    windowEnd: input.asOf.toISOString(),
    eligibleImpressions,
    detailViews,
    firstSuccessfulExchanges,
    qceCount,
    relationshipActivations,
    sameCharacterD7EligiblePairs,
    sameCharacterD7Returns,
    paidAttributions,
    detailCtr: qualityState === "invalid" ? null : ratio(detailViews, eligibleImpressions),
    chatStartRate: qualityState === "invalid" ? null : ratio(firstSuccessfulExchanges, detailViews),
    qceRate: qualityState === "invalid" ? null : ratio(qceCount, firstSuccessfulExchanges),
    sameCharacterD7: qualityState === "invalid" ? null : ratio(sameCharacterD7Returns, sameCharacterD7EligiblePairs),
    sampleSize: eligibleImpressions,
    maturity,
    qualityState,
    coverageState: qualityState === "invalid" ? "invalid" : "exact",
    latestDataAt: latestTimes.length > 0 ? new Date(Math.max(...latestTimes)).toISOString() : null,
    evidence: evidence.length > 0 ? [...new Set(evidence)] : ["canonical_character_performance_v1"],
    contributionMargin: evaluateContributionMargin({ facts: input.economicsRows, authority: input.economicsAuthority }),
  };
}
