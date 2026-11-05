"use client";

import Link from "next/link";
import { useAdminI18n } from "@/components/admin/i18n";
import { useAdminFormat } from "@/components/admin/ui/format";
import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import {
  EmptyWorkspace,
  StatusBadge,
} from "@/features/operations/WorkspaceUi";
import { cn } from "@/lib/utils";
import { percent } from "./character-workspace-format";
import {
  CHARACTER_RECOMMENDATION_LABELS,
  CHARACTER_RECOMMENDATION_SENTENCES,
} from "./character-recommendation-copy";

// SPEC: 零观测本身不是结论——「窗口还没走完」要等；窗口走完了也只说事实。只有权威判定真的
//       零流量（无曝光、无漏斗、无合格聊天）时才派运营去查投放和事件投递。
// INTENT: 聊天没带曝光入口时漏斗是空的，但人在聊。曾在这里一律要求查投放，派人去查没坏的东西。
export function characterNoDataDiagnosis(
  metric: {
    readonly qualityState: string;
    readonly maturity: string;
    readonly window: string;
  },
  options: { readonly noTraffic?: boolean } = {},
) {
  if (metric.qualityState !== "no_data") return null;
  if (metric.maturity === "immature") {
    return {
      message:
        "No observations yet. The {window} window has not closed since publish.",
      alert: false,
    };
  }
  return options.noTraffic
    ? {
        message:
          "No traffic across a full {window} window. Check placement targeting and event delivery.",
        alert: true,
      }
    : {
        message: "No exposure or funnel data in this {window} window.",
        alert: false,
      };
}

// SPEC: 没有证据的指标说「数据不足」，不写 0% 也不写 N/A。
export function performanceRateLabel(value: number | null) {
  return value === null ? "Insufficient data" : percent(value);
}

// SPEC: 新旧 Release 对比的一句话；只对有分母的指标出数字。
export function releaseComparisonLabel(
  marker: CharacterWorkspaceDetail["portfolio"]["changeMarkers"][number],
) {
  const points = (value: number) =>
    `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}`;
  return [
    marker.qceRateDelta === null ? null : `QCE ${points(marker.qceRateDelta)}`,
    marker.sameCharacterD7Delta === null ? null : `D7 ${points(marker.sameCharacterD7Delta)}`,
  ].filter((part): part is string => part !== null).join(" · ");
}

// SPEC: 零数据首屏只显示一次诊断，不重复渲染多个完全相同的 N/A 指标行。
// INTENT: 观测窗口仍由服务端权威决定；这里只把“还没有有效样本”压缩成一个可理解的空状态。
export function characterPerformanceHasObservations(
  performance: CharacterWorkspaceDetail["performance"],
) {
  return performance.some(
    (metric) =>
      metric.sampleSize > 0 ||
      metric.qceRate !== null ||
      metric.sameCharacterD7 !== null ||
      metric.contributionMargin.valueMicros !== null,
  );
}

function PerformanceMetricCard({
  metric,
}: {
  metric: CharacterWorkspaceDetail["performance"][number];
}) {
  const { t } = useAdminI18n();
  const format = useAdminFormat();
  return (
    <article className="grid gap-3 border-b border-[var(--ad-border)] px-1 py-3 last:border-b-0 sm:grid-cols-[minmax(7rem,1.2fr)_repeat(7,minmax(4rem,.7fr))_auto] sm:items-center">
      <div>
        <h3 className="text-sm font-semibold">{metric.window}</h3>
        <p className="mt-0.5 text-xs text-[var(--ad-text-muted)]">
          {metric.placementId ? t(metric.placementId) : t("all placements")}
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-3 text-xs sm:contents">
        <div>
          <dt className="text-[var(--ad-text-muted)]">{t("Exposure")}</dt>
          <dd className="mt-0.5 font-semibold">{format.count(metric.eligibleImpressions)}</dd>
        </div>
        <div>
          <dt className="text-[var(--ad-text-muted)]">{t("Detail views")}</dt>
          <dd className="mt-0.5 font-semibold">{format.count(metric.detailViews)}</dd>
        </div>
        <div>
          <dt className="text-[var(--ad-text-muted)]">{t("Chat starts")}</dt>
          <dd className="mt-0.5 font-semibold">{format.count(metric.firstSuccessfulExchanges)}</dd>
        </div>
        <div>
          <dt className="text-[var(--ad-text-muted)]">{t("QCE")}</dt>
          <dd className="mt-0.5 font-semibold">{t(performanceRateLabel(metric.qceRate))}</dd>
        </div>
        <div>
          <dt className="text-[var(--ad-text-muted)]">
            {t("Same-character D7")}
          </dt>
          <dd className="mt-0.5 font-semibold">
            {t(performanceRateLabel(metric.sameCharacterD7))}
          </dd>
        </div>
        <div>
          <dt className="text-[var(--ad-text-muted)]">{t("Sample")}</dt>
          <dd className="mt-0.5 font-semibold">{metric.sampleSize}</dd>
        </div>
        <div>
          <dt className="text-[var(--ad-text-muted)]">{t("Margin")}</dt>
          <dd className="mt-0.5 font-semibold">
            {metric.contributionMargin.valueMicros === null
              ? t("Unavailable")
              : format.count(metric.contributionMargin.valueMicros)}
          </dd>
        </div>
      </dl>
      <span className="justify-self-start">
        <StatusBadge value={metric.maturity} />
      </span>
    </article>
  );
}

// INTENT: 线上监控只呈现产品事实。负责人、排期、置信度和“成功标准”不改变角色状态，
// 也不触发任何产品动作，因此不在这里建立第二套项目管理流程。
export function PerformancePanel({ data }: { data: CharacterWorkspaceDetail }) {
  const { t } = useAdminI18n();
  const noTraffic = data.portfolio.attentionReason === "no_traffic_after_window";
  const primaryDiagnosisMetric =
    data.performance.find(
      (metric) => characterNoDataDiagnosis(metric, { noTraffic })?.alert,
    ) ??
    data.performance.find((metric) =>
      characterNoDataDiagnosis(metric, { noTraffic }),
    );
  const primaryDiagnosis = primaryDiagnosisMetric
    ? characterNoDataDiagnosis(primaryDiagnosisMetric, { noTraffic })
    : null;
  const recommendation = data.portfolio.recommendation;
  const comparisons = data.portfolio.changeMarkers.filter((marker) => marker.comparable);
  const primaryQualityProblem = data.performance.find(
    (metric) => metric.qualityState === "invalid",
  );
  const hasObservations = characterPerformanceHasObservations(data.performance);
  return (
    <section
      aria-labelledby="character-performance-title"
      className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold" id="character-performance-title">
            {t("Performance")}
          </h3>
          {primaryQualityProblem ? (
            <p className="mt-1 text-sm text-[var(--ad-red-text)]">
              {t(primaryQualityProblem.qualityState)}
            </p>
          ) : primaryDiagnosis && primaryDiagnosisMetric ? (
            <p
              className={cn(
                "mt-1 text-sm",
                primaryDiagnosis.alert
                  ? "text-[var(--ad-yellow-text)]"
                  : "text-[var(--ad-text-muted)]",
              )}
            >
              {t(primaryDiagnosis.message, {
                window: primaryDiagnosisMetric.window,
              })}
            </p>
          ) : null}
        </div>
        <span className="text-xs text-[var(--ad-text-muted)]">
          {t("{count} monitoring windows", {
            count: data.performance.length,
          })}
        </span>
      </div>
      {recommendation ? (
        <p className="mt-3 text-sm" data-testid="character-recommendation">
          <strong>{t(CHARACTER_RECOMMENDATION_LABELS[recommendation.recommendation])}</strong>{" "}
          <span className="text-[var(--ad-text-muted)]">
            {t(CHARACTER_RECOMMENDATION_SENTENCES[recommendation.reasonCode])}
          </span>
          {recommendation.recommendation !== "insufficient_data" && recommendation.targetTab !== "monitor" ? (
            <Link
              className="ml-2 text-xs font-semibold underline-offset-4 hover:underline"
              href={recommendation.targetTab
                ? `/admin/characters/${encodeURIComponent(data.character.id)}?tab=${recommendation.targetTab}`
                : "/admin/ops/incidents"}
            >
              {t("Open")}
            </Link>
          ) : null}
        </p>
      ) : null}
      {comparisons.length > 0 ? (
        <ul aria-label={t("Compared with the previous Release")} className="mt-3 grid gap-1 text-sm">
          {comparisons.map((marker) => (
            <li key={marker.window}>
              {t("{window} vs previous Release: {delta} pts", {
                window: marker.window,
                delta: releaseComparisonLabel(marker),
              })}
              {marker.comparisonQuality === "directional" ? (
                <span className="ml-2 text-xs text-[var(--ad-text-muted)]">{t("Directional")}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-3">
        {data.performance.length === 0 ? (
          <EmptyWorkspace filtered={false} onClear={() => undefined} />
        ) : !hasObservations ? (
          <div
            className="border-t border-[var(--ad-border)] py-5"
            role="status"
          >
            <strong className="text-sm">
              {t("No performance data yet")}
            </strong>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-[var(--ad-text-muted)]">
              {t(
                "{count} monitoring windows are active. QCE, same-character D7, and margin will appear after the first valid events arrive.",
                { count: data.performance.length },
              )}
            </p>
          </div>
        ) : (
          data.performance.map((metric) => (
            <PerformanceMetricCard
              key={`${metric.window}-${metric.placementId ?? "all"}`}
              metric={metric}
            />
          ))
        )}
      </div>
    </section>
  );
}
