// SPEC: 前端 SSoT——把指标认证失败的机器码翻成运营看得懂的人话原因 + 下一步动作。
//       纯前端，不依赖后端返回结构；未收录的码走兜底，绝不把原始码漏到运营首屏。
// INTENT: 「产品健康」上 15 张卡片一律只写一句"口径异常"，运营据此只能猜是不是口径配错了。
//         而后端其实已经把原因算得很细并放在 card.qualityEvidence 里
//         （packages/main/src/server/modules/admin-v2/metrics/certification.ts 的 failures），
//         前端一个字都没用——诊断结论就摆在响应里，界面上却看不到。
// INTENT: 这份表照抄 components/admin/generation/failureReasons.ts 的做法：只登记能在生产
//         代码里查到发出点的码，查不到就兜底。编一条不存在的原因比一句"把码给工程"更贵。
// EXAMPLE: resolveMetricQualityReason("metric_snapshot_missing")
//          → { title: "Metric snapshot has never been produced", rank: 3, … }

export type MetricQualityReason = {
  /** 原始机器码，留给工程展开时对照后端。 */
  code: string;
  /** i18n key —— 人话原因。 */
  title: string;
  /** i18n key —— 运营/工程该做的下一步。 */
  hint: string;
  /**
   * 因果顺序：数字越小越靠近根因。一张卡往往同时挂七八条失败，
   * 卡面只放得下一条——放最靠近根因的那条，而不是数组里的第一条。
   */
  rank: number;
};

type ReasonEntry = Omit<MetricQualityReason, "code">;

// 带 `:` 的码是「前缀:参数」形态（source_fact_missing:chat_exchange_fact），
// 查表用前缀，参数只在工程详情里保留。
// 导出只为一件事：让用例能穷举它，钉住「每条都有中文」。
export const METRIC_QUALITY_REASONS: Record<string, ReasonEntry> = {
  // --- 源事实：投影表本身是空的，后面所有环节都无从谈起 ---
  // INTENT: 原文断言「投影器还没写过这张表」，听起来像是任务没跑。实测**跑了**：
  //   开发库里 metric_projection_receipts 有 11280 行，applied 是 0，
  //   8766 行 skipped/ineligible_data + 2514 行 skipped/legacy_untyped ——
  //   投影器每一条都读了，然后每一条都拒了。把这两种情况说成同一句，会让工程去查
  //   一个没停的任务。这里不替权威下结论，只说事实并指出证据在哪。
  source_fact_missing: {
    title: "Source fact table is empty",
    hint: "No row ever reached this fact table. The projector may be running and rejecting every event — engineering has to read metric_projection_receipts to tell which",
    rank: 1,
  },
  source_fact_stale: {
    title: "Source fact is older than the freshness SLO",
    hint: "The metric projector is behind — needs engineering",
    rank: 2,
  },

  // --- 定义快照：口径没有被落库固定，指标无法被复核 ---
  definition_snapshot_missing: {
    title: "Metric definition has never been persisted",
    hint: "Publish the definition snapshot before the number can be trusted",
    rank: 3,
  },
  definition_snapshot_mismatch: {
    title: "Persisted definition no longer matches the shipped one",
    hint: "The definition drifted — re-publish the snapshot",
    rank: 3,
  },
  definition_query_hash_mismatch: {
    title: "Persisted definition no longer matches the shipped one",
    hint: "The definition drifted — re-publish the snapshot",
    rank: 3,
  },
  definition_snapshot_not_effective: {
    title: "Definition snapshot is not in effect yet",
    hint: "It becomes usable at its effective time",
    rank: 4,
  },
  definition_not_certified: {
    title: "Definition snapshot is not certified",
    hint: "Certify the definition before using the number for decisions",
    rank: 4,
  },
  definition_validation_timestamp_missing: {
    title: "Definition has never been validated",
    hint: "Run definition validation — needs engineering",
    rank: 4,
  },
  definition_validation_evidence_missing: {
    title: "Definition validation left no evidence",
    hint: "Re-run validation so the result is auditable",
    rank: 4,
  },

  // 显式校验的具体失败优先于笼统的 validation_failed，避免把等待成熟样本误报成故障。
  definition_validation_formula_mismatch: {
    title: "Metric formula disagrees with independently verified examples",
    hint: "Engineering must repair the formula and pass the fixed golden examples before validating again",
    rank: 2,
  },
  definition_validation_failed: {
    title: "Latest definition validation failed",
    hint: "Engineering must resolve the recorded failures and run definition validation again",
    rank: 4,
  },
  definition_validation_identity_mismatch: {
    title: "Validation evidence belongs to a different definition or validator",
    hint: "Engineering must validate the current definition with the current validator",
    rank: 3,
  },
  definition_validation_from_future: {
    title: "Definition validation is timestamped after this report",
    hint: "Engineering must check the clock and report time before validating again",
    rank: 3,
  },
  definition_validation_mature_sample_missing: {
    title: "Definition validation has no eligible mature sample",
    hint: "Wait for real production customer cohorts to mature and replay their canonical events; internal test data cannot certify this metric",
    rank: 1,
  },
  definition_validation_cohort_invalid: {
    title: "Definition validation found an invalid cohort result",
    hint: "Engineering must repair cohort calculations or source facts before validating again",
    rank: 2,
  },
  definition_validation_projection_incomplete: {
    title: "Eligible canonical events have not finished projection",
    hint: "Engineering must preview and backfill canonical events; quarantined events need their authority repaired before explicit requeue",
    rank: 1,
  },
  definition_evaluator_unavailable: {
    title: "This metric has no authoritative evaluator",
    hint: "Engineering must provide the real data source, evaluator, and independent golden coverage before validating this definition",
    rank: 1,
  },

  // --- 质量校验：从没跑过 / 没通过 ---
  quality_check_missing: {
    title: "Required data-quality check has never run",
    hint: "Start the metric quality checks — needs engineering",
    rank: 5,
  },
  quality_check_failed: {
    title: "Required data-quality check failed",
    hint: "Fix the underlying data before trusting the number",
    rank: 5,
  },
  // INTENT: `certification.ts:72` 是 `quality_check_${check.status}`，而 status 的取值域是
  //         `["passed","failed","unavailable"]`（shared/admin/contracts/metrics.ts:124）——
  //         也就是说 failed 之外还有 unavailable 这一支。`metrics.event_lag_p95` 在
  //         `query.ts:175` 只要 eventLagP95Ms 为 null 就是 unavailable，空环境下必然命中。
  //         漏登记它，运营看到的是"未识别的认证失败"，而这条其实完全解释得清。
  quality_check_unavailable: {
    title: "Required data-quality check could not be evaluated",
    hint: "The check had nothing to measure — needs engineering",
    rank: 5,
  },
  quality_check_stale: {
    title: "Data-quality check is older than the freshness SLO",
    hint: "The check schedule is behind — needs engineering",
    rank: 5,
  },
  quality_check_evidence_missing: {
    title: "Data-quality check left no evidence",
    hint: "Re-run the check so the result is auditable",
    rank: 5,
  },

  // --- 指标快照：定义与数据都在，但没人把结果算出来 ---
  metric_snapshot_missing: {
    title: "Metric snapshot has never been produced",
    hint: "Run the metric snapshot job — needs engineering",
    rank: 6,
  },
  metric_snapshot_stale: {
    title: "Metric snapshot is older than the freshness SLO",
    hint: "The snapshot job is behind — needs engineering",
    rank: 6,
  },
  metric_snapshot_not_certified: {
    title: "Metric snapshot is not certified",
    hint: "The snapshot was produced but not certified — needs engineering",
    rank: 6,
  },
  metric_snapshot_data_invalid: {
    title: "Metric snapshot holds invalid data",
    hint: "Re-run the snapshot job — needs engineering",
    rank: 6,
  },
  metric_snapshot_query_hash_mismatch: {
    title: "Snapshot was computed from a different definition",
    hint: "Re-run the snapshot against the current definition",
    rank: 6,
  },
  metric_snapshot_publication_mismatch: {
    title: "Snapshot publication status does not match the definition",
    hint: "Re-publish so both sides agree — needs engineering",
    rank: 6,
  },
  metric_snapshot_evidence_missing: {
    title: "Metric snapshot left no evidence",
    hint: "Re-run the snapshot so the result is auditable",
    rank: 6,
  },
  metric_snapshot_latest_data_missing: {
    title: "Metric snapshot does not say how fresh its data is",
    hint: "Re-run the snapshot — needs engineering",
    rank: 6,
  },
  metric_snapshot_from_future: {
    title: "Metric snapshot is timestamped in the future",
    hint: "Clock or backfill problem — needs engineering",
    rank: 6,
  },
  metric_snapshot_source_freshness_mismatch: {
    title: "Snapshot and its source facts disagree on freshness",
    hint: "Re-run the snapshot after the projector catches up",
    rank: 6,
  },
  // INTENT: 「unavailable」和「until it is back」都在暗示这是一次故障、会恢复。它不会。
  //   这张毛利卡在 metrics/query.ts:378-401 是**静态拼出来**的：value/numerator/denominator
  //   全是 null，decisionUse 恒为 blocked，这条码是写死的字符串，没有任何判定参与；
  //   它引用的 cash_attribution_fact 表在库里根本不存在。运营盯着一张永远红的卡等它恢复，
  //   等的是一件不会发生的事——所以这里说清楚它是占位而不是故障。
  cash_attribution_authority_unavailable: {
    title: "Cash attribution authority is unavailable",
    hint: "There is no cash-attribution source in the product yet, so margin cannot be computed — this card is a placeholder, not an outage",
    rank: 2,
  },
  provider_cost_total_exceeds_safe_numeric_range: {
    title: "Provider cost total exceeds the supported numeric range",
    hint: "Engineering must support this total without losing precision before it can be reported",
    rank: 2,
  },
};

const FALLBACK: ReasonEntry = {
  // INVARIANT: 兜底不猜原因。运营能做的只有把原始码转给工程，文案就照这个说。
  title: "Unrecognised certification failure",
  hint: "Hand the raw code to engineering",
  rank: 99,
};

function providerPricingReason(code: string): ReasonEntry | null {
  // Main reports observed pricing coverage in both usable and blocked cards.
  // Only empty or incomplete coverage explains a failure; 3/3 does not.
  const match = /^priced_invocations=(\d+)\/(\d+)$/.exec(code);
  if (!match) return null;
  const priced = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isSafeInteger(priced) || !Number.isSafeInteger(total) || priced > total) return null;
  if (total === 0) return {
    title: "No eligible provider invocations in this window",
    hint: "No production customer canonical invocations were recorded in the last seven days, so there is no cost total to report",
    rank: 1,
  };
  if (priced < total) return {
    title: "Provider pricing coverage is incomplete",
    hint: "Record verified prices for every eligible invocation before using the cost total",
    rank: 2,
  };
  return null;
}

export function resolveMetricQualityReason(code: string): MetricQualityReason {
  const prefix = code.split(":")[0] ?? code;
  return { code, ...(METRIC_QUALITY_REASONS[code] ?? METRIC_QUALITY_REASONS[prefix] ?? providerPricingReason(code) ?? FALLBACK) };
}

/**
 * SPEC: 这条 evidence 是不是一条认得出来的失败码。
 * INTENT: `qualityEvidence` 不是纯失败码数组 —— 认证**通过**时后端塞的是正面证据
 *         （`persisted_definition_snapshot_verified`…），而 buildBusinessFactCards 还会塞给人
 *         读的散文（`priced_invocations=3/3`、"Cash revenue is not inferred from provider cost."）。
 *         把这些一律翻成"未识别的认证失败"，等于对着一张健康的卡报一条不存在的故障。
 */
export function hasMetricQualityReason(code: string) {
  const prefix = code.split(":")[0] ?? code;
  return code in METRIC_QUALITY_REASONS || prefix in METRIC_QUALITY_REASONS || providerPricingReason(code) !== null;
}

/**
 * SPEC: 这张卡到底有没有"失败原因"可讲 —— 判据是 decisionUse，不是 qualityState。
 * INTENT: `directional` 也不是 `certified`，但它是认证**通过**的一种
 *         （decisionUse=directional_only），evidence 里装的是正面证据或散文。按
 *         `qualityState !== "certified"` 判，恒为 directional 的成本卡就会永远挂着一句
 *         「未识别的认证失败」并被计进"不能用于决策"——两条都是编出来的。
 */
export function metricQualityBlocked(card: { readonly decisionUse: string }) {
  return card.decisionUse === "blocked";
}

/**
 * SPEC: 一张卡挂着七八条失败时，卡面只显示最靠近根因的那一条。
 * INTENT: 按 rank 取最小值而不是取数组第一项——后端的 failures 是按检查顺序 push 的，
 *         第一条通常是"定义快照缺失"，而真正的根因往往是更靠前的"源事实是空的"。
 */
export function primaryMetricQualityReason(
  evidence: readonly string[],
): MetricQualityReason | null {
  let best: MetricQualityReason | null = null;
  for (const code of evidence) {
    const reason = resolveMetricQualityReason(code);
    if (!best || reason.rank < best.rank) best = reason;
  }
  return best;
}

/**
 * SPEC: 章节级汇总——把所有卡片的失败去重成"几个不同原因，各影响几张卡"。
 * INTENT: 15 张卡 × 8 条码 = 120 行噪音；运营要看的是"到底有几件事坏了"。
 */
export function summariseMetricQualityReasons(
  cards: readonly { readonly qualityEvidence: readonly string[] }[],
): readonly (MetricQualityReason & { cardCount: number })[] {
  const byTitle = new Map<string, MetricQualityReason & { cardCount: number }>();
  for (const card of cards) {
    // INVARIANT: 认得出来的码优先；一整张卡一条都认不出来时才留一条兜底。
    //            否则后端混在同一个数组里的散文会各自伪装成一条独立的失败原因 ——
    //            利润卡的 "Dreamcoin consumption is not cash revenue." 就会在汇总里多列一行
    //            「未识别的认证失败」，而它根本不是一条失败。
    const recognised = card.qualityEvidence.filter(hasMetricQualityReason);
    const codes = recognised.length > 0 ? recognised : card.qualityEvidence.slice(0, 1);
    const seen = new Set<string>();
    for (const code of codes) {
      const reason = resolveMetricQualityReason(code);
      if (seen.has(reason.title)) continue;
      seen.add(reason.title);
      const existing = byTitle.get(reason.title);
      if (existing) existing.cardCount += 1;
      else byTitle.set(reason.title, { ...reason, cardCount: 1 });
    }
  }
  return [...byTitle.values()].sort(
    (left, right) => left.rank - right.rank || right.cardCount - left.cardCount,
  );
}
