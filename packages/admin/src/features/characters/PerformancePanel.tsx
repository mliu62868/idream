"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import { useAdminFormat } from "@/components/admin/ui/format";
import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import {
  EmptyWorkspace,
  StatusBadge,
} from "@/features/operations/WorkspaceUi";
import { cn } from "@/lib/utils";
import { percent } from "./character-workspace-format";

// SPEC: 零观测本身不是结论——「窗口还没走完」要等，「整个窗口都没有」要查投放和埋点。
// INTENT: 不加字段，maturity 已经把时间维度算好了；缺的只是把这个组合翻译成一句能照做的话。
export function characterNoDataDiagnosis(metric: {
  readonly qualityState: string;
  readonly maturity: string;
  readonly window: string;
}) {
  if (metric.qualityState !== "no_data") return null;
  return metric.maturity === "immature"
    ? {
        message:
          "No observations yet. The {window} window has not closed since publish.",
        alert: false,
      }
    : {
        message:
          "No observations across a full {window} window. Check placement targeting and event delivery.",
        alert: true,
      };
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
    <article className="grid gap-3 border-b border-[var(--ad-border)] px-1 py-3 last:border-b-0 sm:grid-cols-[minmax(9rem,1.4fr)_repeat(4,minmax(4.5rem,.7fr))_auto] sm:items-center">
      <div>
        <h3 className="text-sm font-semibold">{metric.window}</h3>
        <p className="mt-0.5 text-xs text-[var(--ad-text-muted)]">
          {metric.placementId ? t(metric.placementId) : t("all placements")}
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-3 text-xs sm:contents">
        <div>
          <dt className="text-[var(--ad-text-muted)]">{t("QCE")}</dt>
          <dd className="mt-0.5 font-semibold">{percent(metric.qceRate)}</dd>
        </div>
        <div>
          <dt className="text-[var(--ad-text-muted)]">
            {t("Same-character D7")}
          </dt>
          <dd className="mt-0.5 font-semibold">
            {percent(metric.sameCharacterD7)}
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
  const primaryDiagnosisMetric =
    data.performance.find(
      (metric) => characterNoDataDiagnosis(metric)?.alert,
    ) ?? data.performance.find((metric) => characterNoDataDiagnosis(metric));
  const primaryDiagnosis = primaryDiagnosisMetric
    ? characterNoDataDiagnosis(primaryDiagnosisMetric)
    : null;
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
