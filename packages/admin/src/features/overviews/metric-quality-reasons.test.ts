import { describe, expect, it } from "vitest";
import { translateAdmin } from "@/components/admin/i18n-dictionary";
import {
  METRIC_QUALITY_REASONS,
  hasMetricQualityReason,
  metricQualityBlocked,
  primaryMetricQualityReason,
  resolveMetricQualityReason,
  summariseMetricQualityReasons,
} from "./metric-quality-reasons";

// 实测抓自本地 /api/v2/admin/metrics 的一张卡：15 张卡全部 invalid，每张挂着这一串失败。
const REAL_EVIDENCE = [
  "definition_snapshot_missing",
  "quality_check_missing:metrics.server_outcome_completeness",
  "quality_check_missing:metrics.duplicate_effect",
  "quality_check_missing:metrics.impossible_state",
  "quality_check_missing:metrics.fixture_internal_leakage",
  "quality_check_missing:metrics.authoritative_join_coverage",
  "quality_check_missing:metrics.event_lag_p95",
  "quality_check_missing:metrics.eligible_fact_presence",
  "source_fact_missing:chat_exchange_fact",
  "metric_snapshot_missing",
];

describe("metric certification reasons", () => {
  // SPEC: 这张表里的每一条都会出现在中文后台的「产品健康」上，一条都不能漏中文。
  // INTENT: i18n-completeness 那条用例只扫 JSX 字面量，扫不到这里——本文件此前只对
  //         三四条做了点名断言，改动别的条目不会报红。实测就漏过：改文案时中文还停在旧句上，
  //         中文界面照样印英文原文，而两条用例都是绿的。
  it("has Chinese for every title and hint", () => {
    for (const [code, entry] of Object.entries(METRIC_QUALITY_REASONS)) {
      expect(translateAdmin("zh", entry.title), `${code} title 缺中文`).not.toBe(entry.title);
      expect(translateAdmin("zh", entry.hint), `${code} hint 缺中文`).not.toBe(entry.hint);
    }
  });

  // SPEC: 这两条的下一步不许承诺一个不会到来的恢复。
  // INTENT: `cash_attribution_authority_unavailable` 是 metrics/query.ts:400 写死的字符串，
  //         那张毛利卡整张是静态拼的，它引用的 cash_attribution_fact 表在库里不存在——
  //         原文「它恢复之前……」让运营一直等。`source_fact_missing` 原文断言投影器没跑过，
  //         而实测投影器跑了并拒了全部 11280 条事件，会让工程去查一个没停的任务。
  it("does not promise a recovery that is not coming", () => {
    expect(METRIC_QUALITY_REASONS.cash_attribution_authority_unavailable!.hint)
      .toContain("placeholder, not an outage");
    expect(METRIC_QUALITY_REASONS.source_fact_missing!.hint)
      .toContain("metric_projection_receipts");
  });

  it("explains every explicit validation failure and prioritises its actionable cause", () => {
    for (const code of [
      "definition_validation_failed", "definition_validation_identity_mismatch",
      "definition_validation_formula_mismatch",
      "definition_validation_from_future", "definition_validation_mature_sample_missing",
      "definition_validation_cohort_invalid", "definition_validation_projection_incomplete",
      "definition_evaluator_unavailable",
    ]) expect(hasMetricQualityReason(code), code).toBe(true);
    expect(primaryMetricQualityReason([
      "definition_validation_failed", "definition_validation_mature_sample_missing",
    ])?.code).toBe("definition_validation_mature_sample_missing");
    expect(translateAdmin("zh", resolveMetricQualityReason("definition_validation_mature_sample_missing").hint))
      .toContain("内部测试数据不能用于认证");
    expect(translateAdmin("zh", resolveMetricQualityReason("definition_validation_projection_incomplete").hint))
      .toContain("先修复权威数据");
  });

  it("reads the parameterised prefix of a code", () => {
    expect(resolveMetricQualityReason("source_fact_missing:chat_exchange_fact")).toMatchObject({
      code: "source_fact_missing:chat_exchange_fact",
      title: "Source fact table is empty",
    });
  });

  // SPEC: `quality_check_${status}` 的 status 有三个取值，不是只有 failed。
  // INTENT: certification.ts:72 直接把 DataQualityCheck.status 拼进码里，而取值域是
  //         ["passed","failed","unavailable"]（contracts/metrics.ts:124）。
  //         `metrics.event_lag_p95` 在 eventLagP95Ms 为 null 时就是 unavailable
  //         （metrics/query.ts:175）—— 空环境下必然发生，漏登记就会显示成"未识别"。
  it("recognises every quality-check status the authority can interpolate", () => {
    for (const status of ["failed", "unavailable"]) {
      const reason = resolveMetricQualityReason(`quality_check_${status}:metrics.event_lag_p95`);
      expect(reason.title, `quality_check_${status} 未登记`).not.toBe(
        "Unrecognised certification failure",
      );
    }
  });

  it("falls back without inventing a cause", () => {
    expect(resolveMetricQualityReason("future_certification_rule")).toMatchObject({
      title: "Unrecognised certification failure",
      hint: "Hand the raw code to engineering",
    });
  });

  it("explains the actual blocked provider cost evidence and its next action in Chinese", () => {
    const empty = primaryMetricQualityReason([
      "priced_invocations=0/0", "Cash revenue is not inferred from provider cost.",
    ]);
    expect(empty).toMatchObject({ title: "No eligible provider invocations in this window" });
    expect(translateAdmin("zh", empty!.title)).toBe("当前窗口没有符合口径的模型调用");
    expect(translateAdmin("zh", empty!.hint)).toBe("最近七天尚无符合生产环境、客户和权威事实口径的调用，暂时没有可报告的成本");

    const partial = primaryMetricQualityReason([
      "priced_invocations=2/3", "Cash revenue is not inferred from provider cost.",
    ]);
    expect(partial).toMatchObject({ title: "Provider pricing coverage is incomplete" });
    expect(translateAdmin("zh", partial!.hint)).toBe("为每次符合口径的调用补齐经核实的价格，再使用成本总额");
    expect(summariseMetricQualityReasons([{ qualityEvidence: ["priced_invocations=0/0", "Cash revenue is not inferred from provider cost."] }])).toMatchObject([
      { title: "No eligible provider invocations in this window", cardCount: 1 },
    ]);
  });

  it("recognises unsafe totals without treating complete pricing coverage as a failure", () => {
    expect(hasMetricQualityReason("priced_invocations=3/3")).toBe(false);
    expect(hasMetricQualityReason("priced_invocations=2/3")).toBe(true);
    expect(hasMetricQualityReason("priced_invocations=3/2")).toBe(false);
    const overflow = primaryMetricQualityReason([
      "priced_invocations=3/3", "provider_cost_total_exceeds_safe_numeric_range",
      "Cash revenue is not inferred from provider cost.",
    ]);
    expect(overflow).toMatchObject({ title: "Provider cost total exceeds the supported numeric range" });
    expect(translateAdmin("zh", overflow!.title)).toBe("模型成本总额超出支持的数值范围");
  });

  // SPEC: 卡面那一条要是最靠近根因的，不是数组第一条。
  // INTENT: 后端按检查顺序 push failures，第一条是 definition_snapshot_missing；但真正让
  //         这张卡算不出数的是"源事实表是空的"。照抄第一条会把运营指向错误的下一步。
  it("picks the root cause over the first failure the authority pushed", () => {
    expect(REAL_EVIDENCE[0]).toBe("definition_snapshot_missing");
    expect(primaryMetricQualityReason(REAL_EVIDENCE)?.title).toBe("Source fact table is empty");
  });

  it("returns nothing when the authority reported no failure", () => {
    expect(primaryMetricQualityReason([])).toBeNull();
  });

  // SPEC: 章节汇总回答"到底有几件事坏了"，同一原因在一张卡里只算一次。
  it("collapses seven identical quality-check codes on one card into a single reason", () => {
    const summary = summariseMetricQualityReasons([{ qualityEvidence: REAL_EVIDENCE }]);

    expect(summary.map((reason) => reason.title)).toEqual([
      "Source fact table is empty",
      "Metric definition has never been persisted",
      "Required data-quality check has never run",
      "Metric snapshot has never been produced",
    ]);
    expect(summary.every((reason) => reason.cardCount === 1)).toBe(true);
  });

  // SPEC: qualityEvidence 不是纯失败码数组 —— 认证通过时装的是正面证据，
  //       buildBusinessFactCards 还会往里塞给人读的散文。两者都不是失败原因。
  // INTENT: 实测 `cost.provider_variable_7d` 恒为 directional，evidence 就是这两条散文；
  //         把它们当失败码翻译，汇总里会凭空多出一行「未识别的认证失败」。
  it("does not turn the authority's prose evidence into an extra failure reason", () => {
    const summary = summariseMetricQualityReasons([
      {
        qualityEvidence: [
          "cash_attribution_authority_unavailable",
          "Dreamcoin consumption is not cash revenue.",
        ],
      },
    ]);

    expect(summary.map((reason) => reason.title)).toEqual([
      "Cash attribution authority is unavailable",
    ]);
  });

  // 一条都认不出来时仍然要说话，只是只说一次：那是真的有个没登记的码。
  it("keeps exactly one fallback when nothing on the card is recognised", () => {
    const summary = summariseMetricQualityReasons([
      { qualityEvidence: ["priced_invocations=3/3", "Cash revenue is not inferred from provider cost."] },
    ]);

    expect(summary).toMatchObject([
      { title: "Unrecognised certification failure", cardCount: 1 },
    ]);
  });

  // SPEC: 「有没有失败原因可讲」按 decisionUse 判，不按 qualityState。
  // INTENT: directional 不是 certified，却是认证**通过**的一种。实测 `cost.provider_variable_7d`
  //         恒为 directional/directional_only —— 按 qualityState 判，这张健康的卡会永远挂着
  //         「未识别的认证失败」，并被计进"N 个指标不能用于决策"。
  it("treats directional metrics as usable, not as failing", () => {
    expect(metricQualityBlocked({ decisionUse: "directional_only" })).toBe(false);
    expect(metricQualityBlocked({ decisionUse: "allowed" })).toBe(false);
    expect(metricQualityBlocked({ decisionUse: "blocked" })).toBe(true);
  });

  it("counts how many cards each reason affects", () => {
    const summary = summariseMetricQualityReasons([
      { qualityEvidence: ["metric_snapshot_missing"] },
      { qualityEvidence: ["metric_snapshot_missing", "source_fact_missing:customer_signup_fact"] },
    ]);

    expect(summary).toMatchObject([
      { title: "Source fact table is empty", cardCount: 1 },
      { title: "Metric snapshot has never been produced", cardCount: 2 },
    ]);
  });
});
