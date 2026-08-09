"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { useRef, useState } from "react";
import {
  EmptyWorkspace,
  StatusBadge,
  WorkspaceButton,
  fieldClass,
  textAreaClass,
} from "@/features/operations/WorkspaceUi";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import { cn } from "@/lib/utils";
import { percent } from "./character-workspace-format";
import type {
  CharacterWorkspacePermissions,
  RunCommittedCharacterMutation,
} from "./character-workspace-permissions";

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
  return (
    <article className="grid gap-3 border-b border-[var(--ad-border)] px-1 py-3 last:border-b-0 sm:grid-cols-[minmax(9rem,1.4fr)_repeat(4,minmax(4.5rem,.7fr))_auto] sm:items-center">
      <div>
        <h3 className="text-sm font-semibold">{metric.window}</h3>
        <p className="mt-0.5 text-xs text-[var(--ad-text-muted)]">
          {metric.placementId ? t(metric.placementId) : t("all placements")}
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-3 text-xs sm:contents">
        <div><dt className="text-[var(--ad-text-muted)]">{t("QCE")}</dt><dd className="mt-0.5 font-semibold">{percent(metric.qceRate)}</dd></div>
        <div><dt className="text-[var(--ad-text-muted)]">{t("Same-character D7")}</dt><dd className="mt-0.5 font-semibold">{percent(metric.sameCharacterD7)}</dd></div>
        <div><dt className="text-[var(--ad-text-muted)]">{t("Sample")}</dt><dd className="mt-0.5 font-semibold">{metric.sampleSize}</dd></div>
        <div><dt className="text-[var(--ad-text-muted)]">{t("Margin")}</dt><dd className="mt-0.5 font-semibold">{metric.contributionMargin.valueMicros === null ? t("Unavailable") : metric.contributionMargin.valueMicros.toLocaleString()}</dd></div>
      </dl>
      <span className="justify-self-start">
        <StatusBadge value={metric.maturity} />
      </span>
    </article>
  );
}

export const portfolioDecisions = [
  "Promote",
  "Maintain",
  "Improve",
  "Pause",
  "Retire",
] as const;

export function PerformancePanel({
  data,
  permissions,
  runCommittedMutation,
}: {
  data: CharacterWorkspaceDetail;
  permissions: CharacterWorkspacePermissions;
  runCommittedMutation: RunCommittedCharacterMutation;
}) {
  const { t } = useAdminI18n();
  const releaseId =
    data.serving?.currentReleaseId ?? data.releases[0]?.release.id ?? "";
  const [decision, setDecision] =
    useState<(typeof portfolioDecisions)[number]>("Maintain");
  // INTENT: 这三条是决策记录的正文，运营会改后提交——初值用 lazy t()，跟随 PreviewDiff 的 reason 惯例。
  const [question, setQuestion] = useState(() =>
    t(
      "What should we do with this Character based on current release evidence?",
    ),
  );
  const [evidenceRefs, setEvidenceRefs] = useState("");
  const [evidenceLevel, setEvidenceLevel] = useState<
    "observational" | "attribution" | "causal"
  >("observational");
  const [confidence, setConfidence] = useState("");
  const [successCriteria, setSuccessCriteria] = useState(() =>
    t("Review the selected action at the next portfolio window"),
  );
  const [guardrails, setGuardrails] = useState(() =>
    t("Do not regress qualified conversation or Same-character D7"),
  );
  const [reviewAt, setReviewAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decisionIdempotencyKeys = useRef<Record<string, string>>({});
  const recordDecision = async () => {
    setBusy(true);
    setError(null);
    const body = {
      releaseId,
      decision,
      question,
      evidenceRefs: evidenceRefs
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      evidenceLevel,
      confidence: confidence ? Number(confidence) : null,
      successCriteria: successCriteria
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean),
      guardrails: guardrails
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean),
      reviewAt: reviewAt ? new Date(reviewAt).toISOString() : null,
    };
    const signature = JSON.stringify(body);
    const idempotencyKey =
      decisionIdempotencyKeys.current[signature] ?? crypto.randomUUID();
    decisionIdempotencyKeys.current[signature] = idempotencyKey;
    try {
      await runCommittedMutation({
        action: "Portfolio decision",
        commit: () =>
          adminV2Operation(
            "POST /api/v2/admin/characters/:id/portfolio-decisions",
            {
              path: { id: data.character.id },
              idempotencyKey,
              body,
            },
          ),
        afterRefresh: () => {
          delete decisionIdempotencyKeys.current[signature];
        },
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("Could not record portfolio decision"),
      );
    } finally {
      setBusy(false);
    }
  };
  const latest = data.portfolio.latestDecision;
  const primaryDiagnosisMetric =
    data.performance.find((metric) => characterNoDataDiagnosis(metric)?.alert) ??
    data.performance.find((metric) => characterNoDataDiagnosis(metric));
  const primaryDiagnosis = primaryDiagnosisMetric
    ? characterNoDataDiagnosis(primaryDiagnosisMetric)
    : null;
  const primaryQualityProblem = data.performance.find(
    (metric) => metric.qualityState === "invalid",
  );
  const hasObservations = characterPerformanceHasObservations(
    data.performance,
  );
  return (
    <div className="space-y-5">
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
            {t("{count} views", { count: data.performance.length })}
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
              <strong className="text-sm">{t("No performance data yet")}</strong>
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
      <section
        aria-labelledby="latest-portfolio-decision-title"
        className="border-b border-[var(--ad-border)] pb-5"
      >
        <h3 className="font-semibold" id="latest-portfolio-decision-title">
          {t("Latest Decision Record")}
        </h3>
          {latest ? (
            <div className="mt-3 text-sm">
              <div className="flex flex-wrap gap-2">
                <StatusBadge value={latest.decision} />
                <StatusBadge value={latest.evidenceLevel} />
              </div>
              <p className="mt-3">{latest.question}</p>
              <p className="mt-2 text-xs text-[var(--ad-text-muted)]">
                {t("Owner")} {latest.ownerId} {t("· review")}{" "}
                {latest.reviewAt ?? t("not scheduled")} {t("· confidence")}{" "}
                {latest.confidence ?? t("unavailable")}
              </p>
            </div>
          ) : (
            <p className="mt-3 text-sm text-[var(--ad-text-muted)]">
              {t("No portfolio decision has been recorded.")}
            </p>
          )}
      </section>
      <details className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
        <summary className="cursor-pointer p-4 font-semibold">
          {t("New portfolio decision")}
        </summary>
        <div className="border-t border-[var(--ad-border)] p-4">
          {/* SPEC: option 必须显式带 value —— 提交给后端的是 characterPortfolioDecisionSchema 的英文枚举，
          缺了 value 时译文会当成枚举值提交并被后端拒掉。 */}
          <label className="mt-4 block text-xs font-semibold text-[var(--ad-text-muted)]">
            {t("Action")}
            <select
              className={`${fieldClass} mt-1`}
              onChange={(event) =>
                setDecision(event.target.value as typeof decision)
              }
              value={decision}
            >
              {portfolioDecisions.map((value) => (
                <option key={value} value={value}>
                  {t(value)}
                </option>
              ))}
            </select>
          </label>
          <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">
            {t("Decision question")}
            <textarea
              className={`${textAreaClass} mt-1`}
              onChange={(event) => setQuestion(event.target.value)}
              value={question}
            />
          </label>
          <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">
            {t("Evidence references")}
            <input
              className={`${fieldClass} mt-1`}
              onChange={(event) => setEvidenceRefs(event.target.value)}
              placeholder={t("metric:, release:, qa: (comma separated)")}
              value={evidenceRefs}
            />
          </label>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
              {t("Evidence level")}
              <select
                className={`${fieldClass} mt-1`}
                onChange={(event) =>
                  setEvidenceLevel(event.target.value as typeof evidenceLevel)
                }
                value={evidenceLevel}
              >
                <option value="observational">{t("Observational")}</option>
                <option value="attribution">{t("Attribution")}</option>
                <option value="causal">{t("Causal")}</option>
              </select>
            </label>
            <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
              {t("Confidence")}
              <input
                className={`${fieldClass} mt-1`}
                max="1"
                min="0"
                onChange={(event) => setConfidence(event.target.value)}
                step="0.01"
                type="number"
                value={confidence}
              />
            </label>
          </div>
          <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">
            {t("Success criteria")}
            <textarea
              className={`${textAreaClass} mt-1`}
              onChange={(event) => setSuccessCriteria(event.target.value)}
              value={successCriteria}
            />
          </label>
          <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">
            {t("Guardrails")}
            <textarea
              className={`${textAreaClass} mt-1`}
              onChange={(event) => setGuardrails(event.target.value)}
              value={guardrails}
            />
          </label>
          <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">
            {t("Review at")}
            <input
              className={`${fieldClass} mt-1`}
              onChange={(event) => setReviewAt(event.target.value)}
              type="datetime-local"
              value={reviewAt}
            />
          </label>
          {error ? (
            <p className="mt-3 text-xs text-[var(--ad-red-text)]" role="alert">
              {error}
            </p>
          ) : null}
          <div className="mt-4">
            <WorkspaceButton
              disabled={
                !permissions.writeProject ||
                busy ||
                !releaseId ||
                question.trim().length < 3 ||
                !evidenceRefs.trim() ||
                !successCriteria.trim()
              }
              onClick={() => void recordDecision()}
              tone="primary"
            >
              {t("Record Decision")}
            </WorkspaceButton>
          </div>
        </div>
      </details>
    </div>
  );
}
