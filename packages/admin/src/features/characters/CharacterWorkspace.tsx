"use client";

import { adminDateLocale, useAdminI18n } from "@/components/admin/i18n";
import Link from "next/link";
import Image from "next/image";
import {
  type AdminPermissionKey,
  type CharacterWorkspaceDetail,
} from "@idream/shared/admin";
import { ImageIcon, RefreshCcw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import type { AdminSubview } from "@/components/admin/nav-config";
import { CharacterAssetStudio } from "@/features/characters/CharacterAssetStudio";
import { CharacterVideoStudio } from "@/features/characters/CharacterVideoStudio";
import { CharacterCreateWizard } from "@/features/characters/CharacterCreateWizard";
import { CharacterVoicePanel } from "@/features/characters/CharacterVoicePanel";
import { CharacterSoulPanel } from "@/features/characters/CharacterSoulPanel";
import {
  characterWorkspaceTabFromSearch,
  characterWorkspaceTabs,
  type CharacterWorkspaceTab,
} from "@/features/image-workflow-transport";
import {
  EmptyWorkspace,
  LoadingWorkspace,
  StatusBadge,
  WorkspaceButton,
  fieldClass,
  textAreaClass,
} from "@/features/operations/WorkspaceUi";
import { setWorkspaceUrl } from "@/lib/admin-v2-api";
import {
  adminV2Operation,
  adminV2OperationAllowed,
} from "@/lib/admin-v2-operation";
import {
  usePollingTask,
  type PollDecision,
  type PollingTask,
} from "@/lib/authority-resource";
import { createLatestRequestGate } from "@/lib/latest-request";
import { cn } from "@/lib/utils";
import {
  characterWorkspacePermissions,
  type CharacterWorkspacePermissions,
  type RunCommittedCharacterMutation,
} from "./character-workspace-permissions";
import { percent } from "./character-workspace-format";
import { permissionDenied } from "./character-permission-denied";
import { CharacterPortfolio } from "./CharacterPortfolio";
import { ProjectEditor } from "./ProjectEditor";
import { VisualIdentityPanel } from "./VisualIdentityPanel";
import { PreviewDiff } from "./PreviewDiff";
import { ReleasePanel } from "./ReleasePanel";
import {
  CharacterMediaOperationsCard,
  shouldReleaseVoiceReclaimIdempotencyKey,
} from "./CharacterMediaOperationsCard";
import {
  committedCharacterProjectionWarning,
  createCharacterCommandJournal,
  type PendingCharacterCommand,
} from "./character-command-journal";

type Permissions = CharacterWorkspacePermissions;

type Tab = CharacterWorkspaceTab;

const characterWorkspaceTabLabels: Record<Tab, string> = {
  project: "Details",
  soul: "Soul",
  visual: "Visual identity",
  assets: "Images",
  video: "Video",
  voice: "Voice",
  preview: "Launch preview",
  release: "Release",
  monitor: "Live performance",
};

export function characterWorkspaceTabLabel(tab: Tab) {
  return characterWorkspaceTabLabels[tab];
}

// SPEC: 把 journal 给出的非受理处置翻译成操作员能读的一句话。
// INTENT: 处置本身（解锁 / 保持锁定 / 改挂到别的命令）已经由 journal 做完并生效了，
// 这里只负责措辞——所以三种出口的文案改错也改不动写入锁的行为。
function localCleanupWarning(cause: unknown) {
  return cause instanceof Error
    ? `The authoritative workspace refreshed, but local cleanup needs attention: ${cause.message}`
    : "The authoritative workspace refreshed, but local cleanup needs attention.";
}

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

export function characterMonitorWindows(
  monitors: ReadonlyArray<{ readonly window: string }>,
) {
  return [
    ...new Set([
      "route_qualification",
      "24h",
      "72h",
      ...monitors.map((monitor) => monitor.window),
    ]),
  ];
}

export function MonitorPanel({
  data,
  permissions,
  runCommittedMutation,
  onOpenVisual,
}: {
  data: CharacterWorkspaceDetail;
  permissions: Permissions;
  runCommittedMutation: RunCommittedCharacterMutation;
  onOpenVisual: () => void;
}) {
  const { t } = useAdminI18n();
  const current = data.releases.find(
    ({ release }) => release.id === data.serving?.currentReleaseId,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshIdempotencyKeys = useRef<Record<string, string>>({});
  const refresh = async (window: "24h" | "72h") => {
    if (!current) return;
    setBusy(true);
    setError(null);
    const signature = `${current.release.id}:${current.release.version}:${window}`;
    const idempotencyKey =
      refreshIdempotencyKeys.current[signature] ?? crypto.randomUUID();
    refreshIdempotencyKeys.current[signature] = idempotencyKey;
    try {
      await runCommittedMutation({
        action: `${window} Release monitor refresh`,
        commit: () =>
          adminV2Operation(
            "POST /api/v2/admin/characters/:id/releases/:releaseId/monitors/:window/refresh",
            {
              path: {
                id: data.character.id,
                releaseId: current.release.id,
                window,
              },
              idempotencyKey,
              body: { entityVersion: current.release.version },
            },
          ),
        afterRefresh: () => {
          delete refreshIdempotencyKeys.current[signature];
        },
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("Monitor refresh failed"),
      );
    } finally {
      setBusy(false);
    }
  };
  if (!current)
    return <EmptyWorkspace filtered={false} onClear={() => undefined} />;
  const windows = characterMonitorWindows(current.monitors);
  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2">
        <WorkspaceButton
          disabled={busy || !permissions.reviewRelease}
          onClick={() => void refresh("24h")}
        >
          <RefreshCcw className="h-4 w-4" /> {t("Refresh 24h")}
        </WorkspaceButton>
        <WorkspaceButton
          disabled={busy || !permissions.reviewRelease}
          onClick={() => void refresh("72h")}
        >
          <RefreshCcw className="h-4 w-4" /> {t("Refresh 72h")}
        </WorkspaceButton>
      </div>
      {!permissions.reviewRelease ? (
        <p className="mb-4 text-xs text-[var(--ad-text-muted)]">
          {t("Read-only: character.release.review is not granted.")}
        </p>
      ) : null}
      {error ? (
        <p className="mb-4 text-sm text-[var(--ad-red-text)]" role="alert">
          {error}
        </p>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {windows.map((window) => {
          const monitor = current.monitors.find(
            (item) => item.window === window,
          );
          const emptyStatus =
            window === "route_qualification" ? "not_required" : "pending";
          return (
            <article
              className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"
              key={window}
            >
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">
                  {t(window.replaceAll("_", " "))} {t("guardrail")}
                </h3>
                <StatusBadge value={monitor?.status ?? emptyStatus} />
              </div>
              {monitor ? (
                <>
                  <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
                    {Object.entries(monitor.observed).map(([key, value]) => (
                      <div key={key}>
                        <dt className="text-[var(--ad-text-muted)]">{key}</dt>
                        <dd className="mt-1 font-semibold">
                          {String(value ?? t("Unavailable"))}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <p className="mt-4 text-xs text-[var(--ad-text-muted)]">
                    {t("Recommendation:")}{" "}
                    {t(
                      String(
                        monitor.verification.recommendation ??
                          (window === "route_qualification" &&
                          monitor.status === "action_required"
                            ? "refresh the active image route before the next Release"
                            : "continue_monitoring"),
                      ),
                    )}
                  </p>
                  {window === "route_qualification" &&
                  monitor.status === "action_required" ? (
                    <button
                      className="mt-3 inline-flex min-h-11 items-center text-xs font-semibold underline"
                      onClick={onOpenVisual}
                      type="button"
                    >
                      {t("Open image route")}
                    </button>
                  ) : null}
                </>
              ) : (
                <p className="mt-4 text-sm text-[var(--ad-text-muted)]">
                  {window === "route_qualification"
                    ? t("No image route action is currently required.")
                    : t(
                        "No observation yet. Refresh once the release is published.",
                      )}
                </p>
              )}
            </article>
          );
        })}
      </div>
    </div>
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
  permissions: Permissions;
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

function CharacterDetail({
  actorId,
  id,
  permissions: granted,
}: {
  actorId: string;
  id: string;
  permissions: ReadonlySet<AdminPermissionKey>;
}) {
  const permissions = useMemo(
    () => characterWorkspacePermissions(granted, false),
    [granted],
  );
  const { locale, t } = useAdminI18n();
  const [data, setData] = useState<CharacterWorkspaceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reclaimingVoiceRequestId, setReclaimingVoiceRequestId] = useState<
    string | null
  >(null);
  // SPEC: 待决命令与写入锁只有 journal 一份权威，组件通过订阅镜像它。
  // INTENT: 这两个事实此前同时存在于 2 个 useState、2 个 useRef 和 coordinator 内部共 5 份
  //         副本里，refs 的存在只是为了让异步回调读到当前值。订阅之后 5 份塌成 1 份，
  //         "忘了同步 ref" 这一整类 bug 不再可表达。
  const [journal] = useState(() =>
    createCharacterCommandJournal({ actorId, characterId: id }),
  );
  const {
    command: pendingCommand,
    notice: mutationNotice,
    recoveryError: commandRecoveryError,
    writesLocked: commandWritesLocked,
  } = useSyncExternalStore(
    journal.subscribe,
    journal.getSnapshot,
    journal.getSnapshot,
  );
  const requestGate = useRef(createLatestRequestGate());
  const [tab, setTab] = useState<Tab>(() => {
    if (typeof window === "undefined") return "project";
    if (journal.hasPersistedCommand()) return "release";
    return characterWorkspaceTabFromSearch(window.location.search);
  });
  const tabRef = useRef(tab);
  const load = useCallback(async () => {
    const request = requestGate.current.begin();
    setLoading(true);
    setError(null);
    try {
      const next = await adminV2Operation("GET /api/v2/admin/characters/:id", {
        path: { id },
      });
      if (request.isCurrent()) setData(next);
    } catch (cause) {
      if (request.isCurrent()) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Character workspace could not be loaded",
        );
      }
      throw cause;
    } finally {
      if (request.isCurrent()) setLoading(false);
    }
  }, [id]);
  const loadAuthoritative = useCallback(async () => {
    requestGate.current.invalidate();
    setLoading(true);
    setError(null);
    try {
      const next = await adminV2Operation("GET /api/v2/admin/characters/:id", {
        path: { id },
      });
      setData(next);
      return next;
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Character workspace could not be loaded",
      );
      throw cause;
    } finally {
      setLoading(false);
    }
  }, [id]);
  const refreshCommittedProjection = useCallback(
    async (action: string, commandId?: string, afterRefresh?: () => void) => {
      const result = await journal.refresh({
        load: loadAuthoritative,
        onUnlock: () => {
          journal.setNotice(null);
          afterRefresh?.();
        },
      });
      if (result.status === "superseded") {
        return !("error" in result);
      }
      if (result.status === "failed") {
        setError(null);
        journal.setNotice({
          kind: "refresh_required",
          message: committedCharacterProjectionWarning(action, result.error),
          ...(commandId ? { commandId } : {}),
        });
        return false;
      }
      // SPEC: kept_locked 说明服务端仍有命令在跑；journal 已把日志改挂到那一条上。
      if (result.status === "kept_locked") return true;
      setError(null);
      if (result.status === "cleanup_failed") {
        journal.setRecoveryError(localCleanupWarning(result.error));
      }
      return true;
    },
    [journal, loadAuthoritative],
  );
  const runCommittedMutation = useCallback(
    async <T,>(input: {
      readonly action: string;
      readonly commit: () => Promise<T>;
      readonly afterRefresh?: () => void;
    }) => {
      if (
        !journal.beginSubmission(
          `${input.action} is being committed. Character writes stay locked until the authoritative workspace refreshes.`,
        )
      ) {
        throw new Error(
          "Refresh the authoritative Character workspace before another write.",
        );
      }
      const generation = journal.getGeneration();
      let result: T;
      try {
        result = await input.commit();
      } catch (cause) {
        if (journal.isCurrentGeneration(generation)) journal.setNotice(null);
        throw cause;
      }
      const refreshed = await refreshCommittedProjection(
        input.action,
        undefined,
        input.afterRefresh,
      );
      return { result, refreshed };
    },
    [journal, refreshCommittedProjection],
  );
  const reclaimVoiceRequest = useCallback(
    async (input: {
      readonly requestId: string;
      readonly confirmation: string;
      readonly reason: string;
    }) => {
      const signature = `voice-clip-reclaim:${input.requestId}`;
      const idempotencyKey = journal.takeIdempotencyKey(signature);
      setReclaimingVoiceRequestId(input.requestId);
      setError(null);
      try {
        await runCommittedMutation({
          action: "Voice request reclaim",
          commit: () =>
            adminV2Operation(
              "POST /api/v2/admin/characters/:id/voice-clips/:requestId/commands/reclaim",
              {
                path: { id, requestId: input.requestId },
                idempotencyKey,
                body: {
                  requestId: input.requestId,
                  confirmation: input.confirmation,
                  reason: input.reason,
                },
              },
            ),
        });
        journal.releaseIdempotencyKey(signature);
      } catch (cause) {
        if (shouldReleaseVoiceReclaimIdempotencyKey(cause)) {
          journal.releaseIdempotencyKey(signature);
        }
        setError(
          cause instanceof Error
            ? cause.message
            : "Voice request reclaim failed",
        );
        throw cause;
      } finally {
        setReclaimingVoiceRequestId(null);
      }
    },
    [id, journal, runCommittedMutation],
  );
  const settlePendingCommand = useCallback(
    (
      action: string,
      commandId: string | undefined,
      afterRefresh?: () => void,
    ) => refreshCommittedProjection(action, commandId, afterRefresh),
    [refreshCommittedProjection],
  );
  const refreshAuthoritativeWorkspace = useCallback(async () => {
    const current = journal.getSnapshot().notice;
    if (
      current?.kind === "command_pending" ||
      current?.kind === "command_submission_unknown" ||
      current?.kind === "command_reconfirmation_required"
    )
      return false;
    const result = await journal.refresh({
      load: loadAuthoritative,
      reusePendingCleanup: true,
    });
    if (result.status === "superseded") {
      return !("error" in result);
    }
    if (result.status === "failed") {
      setError(null);
      journal.setNotice({
        kind: "refresh_required",
        message:
          current?.kind === "refresh_required"
            ? current.message
            : committedCharacterProjectionWarning(
                "Character mutation",
                result.error,
              ),
        ...(current?.kind === "refresh_required" && current.commandId
          ? { commandId: current.commandId }
          : {}),
      });
      return false;
    }
    if (result.status === "kept_locked") return true;
    setError(null);
    if (result.status === "cleanup_failed") {
      journal.setRecoveryError(localCleanupWarning(result.error));
    }
    return true;
  }, [journal, loadAuthoritative]);
  const reconcilePendingCommandAuthority = useCallback(
    async (command: PendingCharacterCommand, message: string) => {
      if (!journal.currentCommandIs(command)) return false;
      const generation = journal.getGeneration();
      journal.setNotice({
        kind: "refresh_required",
        message,
        ...(command.commandId ? { commandId: command.commandId } : {}),
      });
      try {
        const authoritative = await loadAuthoritative();
        if (
          !journal.isCurrentGeneration(generation) ||
          !journal.currentCommandIs(command)
        )
          return false;
        if (authoritative.activeCommand) {
          const active = journal.attachAuthorityCommand(
            authoritative.activeCommand,
          );
          journal.setRecoveryError(
            `${active.action} is still active according to server authority. Character writes remain locked.`,
          );
          return false;
        }
        if (!journal.discard(command)) return false;
        journal.setRecoveryError(null);
        return true;
      } catch (cause) {
        if (
          !journal.isCurrentGeneration(generation) ||
          !journal.currentCommandIs(command)
        )
          return false;
        setError(null);
        journal.setNotice({
          kind: "refresh_required",
          message: committedCharacterProjectionWarning(
            `${command.action} command reconciliation`,
            cause,
          ),
          ...(command.commandId ? { commandId: command.commandId } : {}),
        });
        return false;
      }
    },
    [journal, loadAuthoritative],
  );
  useEffect(() => {
    if (!permissions.read) return;
    const gate = requestGate.current;
    const timer = window.setTimeout(
      () => void load().catch(() => undefined),
      0,
    );
    return () => {
      gate.invalidate();
      window.clearTimeout(timer);
    };
  }, [load, permissions.read]);
  useEffect(() => {
    const restore = () => {
      if (!journal.restore()) return;
      setTab("release");
      setWorkspaceUrl(new URLSearchParams({ tab: "release" }), {
        mode: "replace",
      });
    };
    const timer = window.setTimeout(restore, 0);
    const onStorage = (event: StorageEvent) => {
      if (!journal.ownsStorageEvent(event)) return;
      if (event.newValue !== null) {
        restore();
        return;
      }
      const current = journal.getSnapshot().command;
      if (!current) return;
      void reconcilePendingCommandAuthority(
        current,
        `${current.action} was completed or cleared in another tab. This tab must refresh server authority before writes resume.`,
      );
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("storage", onStorage);
    };
  }, [journal, reconcilePendingCommandAuthority]);
  // INTENT: 与上面的日志恢复一样延后一个 tick 再切页签——effect 里同步 setState 会触发级联
  //          渲染（构建期 react-hooks/set-state-in-effect 会拦），而这里本来就是"服务端说还有
  //          命令在跑"的异步事实，不需要在同一次提交里生效。
  useEffect(() => {
    const active = data?.activeCommand;
    if (
      !active ||
      journal.getSnapshot().command?.commandId === active.commandId
    )
      return;
    const timer = window.setTimeout(() => {
      journal.attachAuthorityCommand(active);
      setTab("release");
      setWorkspaceUrl(new URLSearchParams({ tab: "release" }), {
        mode: "replace",
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [data?.activeCommand, journal]);
  // SPEC: 待决命令的恢复循环。每个分支只做两件事——把 journal 的处置翻成一句运营能读的话，
  //       并把它给的重试间隔交回调度器。
  // INTENT: 处置本身（能不能重放、该不该解锁、等多久）全在 journal 里，所以这里改错文案
  //         也改不动安全语义；反过来，任何一条出口漏接都会立刻表现为"运营看不到发生了什么"。
  // INVARIANT: cancelled 只在本轮开始前判一次，拿到 journal 的处置之后不再中途退出。
  //            journal 的每次状态推进（受理 / 挂到别的命令 / 标记终态）都会 publish 并触发
  //            重渲染，于是本轮任务当场被换掉、cancelled 立刻为 true——中途判一次就等于把
  //            刚拿到的终态丢掉，命令永远settle不了、写入锁永远解不开。防重放靠的是 journal
  //            自己的命令身份与代际校验，不是这个标志位。
  const recoverPendingCommand = useCallback<PollingTask>(
    async (context): Promise<PollDecision> => {
      if (!pendingCommand || context.cancelled) return null;
      if (!pendingCommand.commandId) {
        const replay = await journal.replay(pendingCommand);
        switch (replay.kind) {
          case "accepted":
            return null;
          case "attached":
            journal.setRecoveryError(
              `${replay.command.action} is already active according to server authority. The workspace attached to that command instead of submitting a second one.`,
            );
            return null;
          case "window_expired":
            journal.setRecoveryError(
              `${pendingCommand.action} requires fresh operator confirmation before the saved request can be replayed.`,
            );
            return null;
          case "evidence_incomplete":
            journal.setRecoveryError(
              `${pendingCommand.action} recovery journal is incomplete. The authoritative workspace must be reconciled before writes resume.`,
            );
            await reconcilePendingCommandAuthority(
              pendingCommand,
              `${pendingCommand.action} recovery evidence is incomplete. Server authority must be reconciled before writes resume.`,
            );
            return null;
          case "blocked":
            journal.setRecoveryError(
              `${pendingCommand.action} acceptance cannot be proven with the current session or permissions. The original command may already exist, so Character writes remain locked while the exact idempotent request waits to retry.`,
            );
            return replay.retryInMs;
          case "reconcile": {
            journal.setRecoveryError(
              `${pendingCommand.action} replay was rejected, but the original acceptance is still unknown. Server-side Character authority must reconcile the active command before writes resume.`,
            );
            const reconciled = await reconcilePendingCommandAuthority(
              pendingCommand,
              `${pendingCommand.action} replay was rejected after its original response was lost. Server-side Character authority must prove that no command remains active before writes resume.`,
            );
            if (reconciled) {
              journal.setRecoveryError(
                replay.cause instanceof Error
                  ? `${pendingCommand.action} replay was rejected, and server-side Character authority confirmed that no active command remains: ${replay.cause.message}`
                  : `${pendingCommand.action} replay was rejected, and server-side Character authority confirmed that no active command remains.`,
              );
            }
            return null;
          }
          case "retry":
            journal.setRecoveryError(
              replay.cause instanceof Error
                ? `${pendingCommand.action} acceptance is still unknown: ${replay.cause.message}. Retrying the exact command safely.`
                : `${pendingCommand.action} acceptance is still unknown. Retrying the exact command safely.`,
            );
            return replay.retryInMs;
        }
      }

      const status = await journal.pollStatus(pendingCommand);
      switch (status.kind) {
        case "settled":
          await settlePendingCommand(
            status.succeeded
              ? pendingCommand.action
              : `${pendingCommand.action} ${status.status}`,
            pendingCommand.commandId,
            () => journal.discard(pendingCommand),
          );
          journal.setRecoveryError(
            status.succeeded
              ? null
              : `${pendingCommand.action} command ${status.status}. Open command evidence for the authoritative result.`,
          );
          return null;
        case "evidence_missing": {
          const reconciled = await reconcilePendingCommandAuthority(
            pendingCommand,
            `${pendingCommand.action} command evidence returned 404. Server-side Character authority must prove that no command remains active before writes resume.`,
          );
          journal.setRecoveryError(
            reconciled
              ? `${pendingCommand.action} command evidence was unavailable, and server-side Character authority confirmed that no command remains active.`
              : `${pendingCommand.action} command evidence is unavailable. Character writes remain locked until server authority can be reconciled.`,
          );
          return null;
        }
        case "blocked":
          journal.setRecoveryError(
            `${pendingCommand.action} command evidence cannot be read with the current session or permissions. The command may still be running, so Character writes remain locked.`,
          );
          return status.retryInMs;
        case "unavailable":
          journal.setRecoveryError(
            status.cause instanceof Error
              ? `${pendingCommand.action} status could not be refreshed: ${status.cause.message}`
              : `${pendingCommand.action} status could not be refreshed.`,
          );
          return status.retryInMs;
        case "running":
          journal.setRecoveryError(null);
          return status.retryInMs;
      }
    },
    [
      journal,
      pendingCommand,
      reconcilePendingCommandAuthority,
      settlePendingCommand,
    ],
  );
  usePollingTask(
    pendingCommand && !pendingCommand.terminal ? recoverPendingCommand : null,
    // INTENT: 首轮延迟必须在 effect 执行时才求值——它要拿 createdAt 和此刻的 Date.now()
    //         算差值，好让"刚提交就刷新页面"的场景等满命令的最短受理窗口再去查。
    () => (pendingCommand ? journal.initialRecoveryDelayMs(pendingCommand) : 0),
  );
  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);
  useEffect(() => {
    if (tab !== "visual") return;
    const targetId = window.location.hash.replace(/^#/, "");
    if (
      ![
        "visual-production-readiness",
        "visual-identity-version",
        "visual-reference-set",
        "route-qualification-workbench",
      ].includes(targetId)
    )
      return;
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(targetId);
      target?.scrollIntoView({ block: "start" });
      target?.querySelector("summary")?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [tab, data?.visual.imageReadiness?.state, data?.visual.readiness.ready]);
  useEffect(() => {
    const restoreTab = () => {
      if (journal.getSnapshot().writesLocked || data?.activeCommand) {
        setWorkspaceUrl(new URLSearchParams({ tab: tabRef.current }), {
          mode: "replace",
        });
        return;
      }
      setTab(characterWorkspaceTabFromSearch(window.location.search));
    };
    window.addEventListener("popstate", restoreTab);
    return () => window.removeEventListener("popstate", restoreTab);
  }, [data?.activeCommand, id, journal]);
  if (!permissions.read) return permissionDenied("character.project.read");
  if (loading && !data && !pendingCommand) {
    return (
      <LoadingWorkspace label="Loading Character Project, Release and Monitor evidence" />
    );
  }
  if (!data) {
    return (
      <section className="space-y-3">
        {mutationNotice ? (
          <div
            className="rounded-xl bg-[var(--ad-blue-bg)] p-4 text-sm text-[var(--ad-blue-text)]"
            role="status"
          >
            <p>{mutationNotice.message}</p>
            <div className="mt-3 flex flex-wrap gap-3">
              {mutationNotice.kind === "refresh_required" ? (
                <button
                  className="font-semibold underline"
                  onClick={() => void refreshAuthoritativeWorkspace()}
                  type="button"
                >
                  {t("Retry authoritative workspace")}
                </button>
              ) : null}
              {mutationNotice.kind === "command_reconfirmation_required" &&
              pendingCommand ? (
                <button
                  className="font-semibold underline"
                  onClick={() => journal.authorizeReplay()}
                  type="button"
                >
                  {t("Review and resume saved command")}
                </button>
              ) : null}
              {"commandId" in mutationNotice && mutationNotice.commandId ? (
                <Link
                  className="font-semibold underline"
                  href={`/admin/system/audit?commandId=${encodeURIComponent(mutationNotice.commandId)}`}
                >
                  {t("Open command evidence")}
                </Link>
              ) : null}
            </div>
          </div>
        ) : null}
        {commandRecoveryError ? (
          <p
            className="rounded-xl bg-[var(--ad-yellow-bg)] p-4 text-sm text-[var(--ad-yellow-text)]"
            role="alert"
          >
            {commandRecoveryError}
          </p>
        ) : null}
        <div
          className="rounded-xl bg-[var(--ad-red-bg)] p-5 text-sm text-[var(--ad-red-text)]"
          role="alert"
        >
          {error ??
            (loading
              ? t("Loading the authoritative Character workspace…")
              : t("Character not found"))}
          <button
            className="ml-2 font-semibold underline"
            onClick={() => void load().catch(() => undefined)}
            type="button"
          >
            {t("Retry workspace")}
          </button>
        </div>
      </section>
    );
  }
  const selectTab = (next: Tab) => {
    if (
      (journal.getSnapshot().writesLocked || data.activeCommand) &&
      next !== tab
    )
      return;
    setTab(next);
    setWorkspaceUrl(new URLSearchParams({ tab: next }), {
      mode: "push",
    });
  };
  const onTabKey = (
    event: KeyboardEvent<HTMLButtonElement>,
    current: number,
  ) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (mutationNotice || pendingCommand || data.activeCommand) return;
    const visibleTabs = characterWorkspaceTabs;
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? visibleTabs.length - 1
          : (current +
              (event.key === "ArrowRight" ? 1 : -1) +
              visibleTabs.length) %
            visibleTabs.length;
    const next = visibleTabs[nextIndex];
    selectTab(next);
    document.getElementById(`character-tab-${next}`)?.focus();
  };
  const workspaceName =
    data.preview.draft?.name ?? data.preview.live?.name ?? data.character.name;
  const workspaceImageUrl =
    data.preview.draft?.imageUrl ??
    data.preview.live?.imageUrl ??
    data.character.imageUrl;
  const visibleTabs = characterWorkspaceTabs;
  const writesLocked = commandWritesLocked || data.activeCommand !== null;
  const guardedPermissions = characterWorkspacePermissions(granted, writesLocked);
  return (
    <section aria-labelledby="character-workspace-title">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          {workspaceImageUrl ? (
            <Image
              alt={t("{name} primary role portrait", { name: workspaceName })}
              className="h-24 w-24 shrink-0 rounded-lg object-cover"
              height={96}
              loading="eager"
              src={workspaceImageUrl}
              unoptimized
              width={96}
            />
          ) : (
            <div className="grid h-24 w-24 shrink-0 place-items-center rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] text-[var(--ad-text-muted)]">
              <ImageIcon aria-hidden="true" className="h-5 w-5" />
            </div>
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h2
                className="truncate text-2xl font-semibold"
                id="character-workspace-title"
              >
                {workspaceName}
              </h2>
              <p className="inline-flex items-center gap-2 text-sm text-[var(--ad-text-muted)]">
                <span
                  aria-hidden="true"
                  className={cn(
                    "h-2 w-2 rounded-full",
                    data.serving?.state === "live"
                      ? "bg-[var(--ad-green-text)]"
                      : "bg-[var(--ad-text-muted)]/45",
                  )}
                />
                {t(data.serving?.state ?? "not_live")}{" "}
                <span aria-hidden="true">·</span> {t(data.character.visibility)}
              </p>
            </div>
            <p className="mt-1 text-sm text-[var(--ad-text-muted)]">
              {t("Updated")}{" "}
              {new Date(data.character.updatedAt).toLocaleDateString(
                adminDateLocale(locale),
              )}
            </p>
          </div>
        </div>
        <details className="text-xs text-[var(--ad-text-muted)] sm:text-right">
          <summary className="cursor-pointer py-2 font-semibold">
            {t("Technical status")}
          </summary>
          <p>
            {t("Project v")}
            {data.project.version} {t("· Serving v")}
            {data.serving?.version ?? 0}
          </p>
          <p className="mt-1 break-all">
            {t("Character ID")} · {data.character.id}
          </p>
          <p className="mt-1 break-all">
            {t("Project ID")} · {data.project.id}
          </p>
        </details>
      </div>
      {error ? (
        <p
          className="mt-4 rounded-lg bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]"
          role="alert"
        >
          {error}{" "}
          <button
            className="ml-2 underline"
            onClick={() => void load().catch(() => undefined)}
            type="button"
          >
            {t("Retry workspace")}
          </button>
        </p>
      ) : null}
      {commandRecoveryError ? (
        <p
          className="mt-4 rounded-lg bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)]"
          role="alert"
        >
          {commandRecoveryError}
        </p>
      ) : null}
      {mutationNotice ? (
        <div
          className={cn(
            "mt-4 rounded-lg p-3 text-sm",
            [
              "command_pending",
              "command_submission_unknown",
              "mutation_in_flight",
            ].includes(mutationNotice.kind)
              ? "bg-[var(--ad-blue-bg)] text-[var(--ad-blue-text)]"
              : "bg-[var(--ad-yellow-bg)] text-[var(--ad-yellow-text)]",
          )}
          role="status"
        >
          <p>{mutationNotice.message}</p>
          <div className="mt-2 flex flex-wrap gap-3">
            {mutationNotice.kind === "refresh_required" ? (
              <button
                className="font-semibold underline"
                onClick={() => void refreshAuthoritativeWorkspace()}
                type="button"
              >
                {t("Refresh authoritative workspace")}
              </button>
            ) : null}
            {mutationNotice.kind === "command_reconfirmation_required" &&
            pendingCommand ? (
              <button
                className="font-semibold underline"
                onClick={() => journal.authorizeReplay()}
                type="button"
              >
                {t("Review and resume saved command")}
              </button>
            ) : null}
            {"commandId" in mutationNotice && mutationNotice.commandId ? (
              <Link
                className="font-semibold underline"
                href={`/admin/system/audit?commandId=${encodeURIComponent(mutationNotice.commandId)}`}
              >
                {t("Open command evidence")}
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
      <CharacterMediaOperationsCard
        canReclaimVoice={guardedPermissions.writeProject}
        onReclaimVoice={reclaimVoiceRequest}
        projection={data.mediaOperations}
        reclaimingVoiceRequestId={reclaimingVoiceRequestId}
      />
      <label className="mt-4 block sm:hidden">
        <span className="sr-only">{t("Workspace page")}</span>
        <select
          aria-label={t("Workspace page")}
          className={fieldClass}
          disabled={writesLocked}
          onChange={(event) => selectTab(event.target.value as Tab)}
          value={tab}
        >
          {visibleTabs.map((item) => (
            <option key={item} value={item}>
              {t(characterWorkspaceTabLabel(item))}
            </option>
          ))}
        </select>
      </label>
      <div
        className="mt-4 hidden gap-1 overflow-x-auto border-b border-[var(--ad-border)] sm:flex"
        role="tablist"
        aria-label={t("Character workspace")}
      >
        {visibleTabs.map((item, index) => (
          <button
            aria-controls={`character-panel-${item}`}
            aria-selected={tab === item}
            className={cn(
              "min-h-11 shrink-0 border-b-2 px-3 text-sm capitalize focus-visible:outline focus-visible:outline-2",
              tab === item
                ? "border-[var(--ad-ink)] font-semibold text-[var(--ad-ink)]"
                : "border-transparent text-[var(--ad-text-muted)]",
            )}
            disabled={writesLocked && item !== tab}
            id={`character-tab-${item}`}
            key={item}
            onClick={() => selectTab(item)}
            onKeyDown={(event) => onTabKey(event, index)}
            role="tab"
            tabIndex={tab === item ? 0 : -1}
            type="button"
          >
            {t(characterWorkspaceTabLabel(item))}
          </button>
        ))}
      </div>
      <div
        className="mt-5"
        id={`character-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`character-tab-${tab}`}
      >
        {tab === "project" ? (
          <ProjectEditor
            data={data}
            key={data.project.version}
            onReload={async () => {
              await loadAuthoritative();
            }}
            permissions={guardedPermissions}
            runCommittedMutation={runCommittedMutation}
          />
        ) : tab === "soul" ? (
          <CharacterSoulPanel
            canWrite={guardedPermissions.writeProject}
            data={data}
            key={data.soul.current.contentVersionId}
            runCommittedMutation={runCommittedMutation}
          />
        ) : tab === "visual" ? (
          <VisualIdentityPanel
            data={data}
            key={data.visual.activeIdentity?.id ?? "visual-empty"}
            navigateToTab={selectTab}
            permissions={guardedPermissions}
            runCommittedMutation={runCommittedMutation}
          />
        ) : tab === "assets" ? (
          <div id="character-image-studio">
            <CharacterAssetStudio
              actorId={actorId}
              commitProjectMutation={runCommittedMutation}
              data={data}
              key={`${actorId}:${data.character.id}`}
              onContinue={selectTab}
              onProjectReload={load}
              permissions={{
                read: permissions.readAssets,
                create: guardedPermissions.createAssets,
                review: guardedPermissions.reviewAssets,
                selectDraft: guardedPermissions.writeProject,
              }}
            />
          </div>
        ) : tab === "video" ? (
          <CharacterVideoStudio
            actorId={actorId}
            data={data}
            onCreateImage={() => selectTab("assets")}
            permissions={{
              read: permissions.readAssets,
              create: guardedPermissions.createAssets,
              review: guardedPermissions.reviewAssets,
            }}
            runCommittedMutation={runCommittedMutation}
          />
        ) : tab === "voice" ? (
          <CharacterVoicePanel
            canActivate={guardedPermissions.publishRelease}
            canManageDefaults={guardedPermissions.manageVoiceDefaults}
            canWrite={guardedPermissions.writeProject}
            data={data}
            runCommittedMutation={runCommittedMutation}
          />
        ) : tab === "preview" ? (
          <PreviewDiff
            data={data}
            permissions={guardedPermissions}
            runCommittedMutation={runCommittedMutation}
          />
        ) : tab === "release" ? (
          <ReleasePanel
            data={data}
            journal={journal}
            permissions={guardedPermissions}
            runCommittedMutation={runCommittedMutation}
            writesLocked={writesLocked}
          />
        ) : (
          // SPEC: 「线上」= 表现证据 → 组合决策 → 发布护栏，自上而下就是运营复盘的顺序。
          <div className="space-y-5">
            <PerformancePanel
              data={data}
              permissions={guardedPermissions}
              runCommittedMutation={runCommittedMutation}
            />
            <details className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
              <summary className="cursor-pointer p-4 font-semibold">
                {t("Release monitoring")}
              </summary>
              <div className="border-t border-[var(--ad-border)] p-4">
                <MonitorPanel
                  data={data}
                  onOpenVisual={() => selectTab("visual")}
                  permissions={guardedPermissions}
                  runCommittedMutation={runCommittedMutation}
                />
              </div>
            </details>
          </div>
        )}
      </div>
    </section>
  );
}

export function CharacterWorkspace({
  actorId,
  view,
  permissions: granted,
}: {
  actorId: string;
  view: AdminSubview;
  permissions: ReadonlySet<AdminPermissionKey>;
}) {
  const permissions = characterWorkspacePermissions(granted, false);
  if (view.kind === "new") {
    return (
      <CharacterCreateWizard
        actorId={actorId}
        canCreate={permissions.writeProject}
        key={actorId}
      />
    );
  }
  return view.kind === "detail" ? (
    <CharacterDetail
      actorId={actorId}
      id={view.id}
      key={`${actorId}:${view.id}`}
      permissions={granted}
    />
  ) : (
    <CharacterPortfolio
      canOpenAssets={permissions.readAssets}
      canCreate={permissions.writeProject}
      canOpenProjects={permissions.read}
      canRead={permissions.read}
      mode="studio"
    />
  );
}

export function CharacterPerformanceWorkspace({
  permissions,
}: {
  permissions: ReadonlySet<AdminPermissionKey>;
}) {
  return (
    <CharacterPortfolio
      canOpenAssets={false}
      canCreate={false}
      canOpenProjects={adminV2OperationAllowed(
        "GET /api/v2/admin/characters/:id",
        permissions,
      )}
      canRead={permissions.has("character.performance.read")}
      mode="performance"
    />
  );
}
