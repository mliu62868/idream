"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import { useAdminFormat } from "@/components/admin/ui/format";
import { EngineeringDetails } from "@/components/admin/generation/EngineeringDetails";
import { RequestErrorDetails } from "@/components/admin/ui/RequestErrorDetails";
import { operatorErrorCopy } from "@/components/admin/ui/request-error-copy";
import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { RefreshCcw } from "lucide-react";
import { useState } from "react";
import {
  EmptyWorkspace,
  StatusBadge,
  WorkspaceButton,
} from "@/features/operations/WorkspaceUi";
import { routeStaleReasonCopy } from "./route-stale-reason";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import type {
  CharacterWorkspacePermissions,
  RunCommittedCharacterMutation,
} from "./character-workspace-permissions";
import { characterReleaseMonitorNeedsAttention } from "./character-workspace-format";

type Monitor = CharacterWorkspaceDetail["releases"][number]["monitors"][number];

const CHECK_LABELS: Record<string, string> = {
  releaseReadinessReady: "Release readiness",
  releaseAssetManifestComplete: "Required release assets",
  servingPointerLive: "Live release pointer",
  servingProjectionLive: "Customer-facing character availability",
  immutableContentAvailable: "Published character content",
  releaseAvatarRenderable: "Avatar can be rendered",
  releaseAvatarVisible: "Avatar can be viewed by customers",
  releaseHeroRenderable: "Hero image can be rendered",
  releaseHeroVisible: "Hero image can be viewed by customers",
  releaseChatRenderable: "Chat image can be rendered",
  releaseChatVisible: "Chat image can be viewed by customers",
  chatAuthorityReady: "Chat delivery readiness",
};

const RECOMMENDATIONS: Record<string, string> = {
  rollback_review: "Review rollback before changing the live release.",
  continue_monitoring: "Continue observing this release.",
  investigate_no_chat_usage: "Investigate why no chat usage was observed.",
  keep: "Keep this release live.",
  no_longer_serving: "This release is no longer serving customers.",
};

// INVARIANT: 只从权威的布尔检查提取成败；缺失值和旧 JSON 不能被推断成通过或失败。
function operationalChecks(monitor: Monitor) {
  const raw = monitor.observed.operationalChecks;
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? Object.entries(raw).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean")
    : [];
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
  onOpenRelease,
}: {
  data: CharacterWorkspaceDetail;
  permissions: CharacterWorkspacePermissions;
  runCommittedMutation: RunCommittedCharacterMutation;
  onOpenVisual: () => void;
  onOpenRelease: () => void;
}) {
  const { t } = useAdminI18n();
  const format = useAdminFormat();
  const current = data.releases.find(
    ({ release }) => release.id === data.serving?.currentReleaseId,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ cause: unknown } | null>(null);
  const refresh = async (window: "24h" | "72h") => {
    if (!current) return;
    setBusy(true);
    setError(null);
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
              body: { entityVersion: current.release.version },
            },
          ),
      });
    } catch (cause) {
      setError({ cause });
    } finally {
      setBusy(false);
    }
  };
  if (!current)
    return <EmptyWorkspace filtered={false} onClear={() => undefined} />;
  const windows = characterMonitorWindows(current.monitors).sort((left, right) => {
    const needsAttention = (window: string) => current.monitors.some((monitor) => monitor.window === window && characterReleaseMonitorNeedsAttention(monitor));
    return Number(needsAttention(right)) - Number(needsAttention(left));
  });
  const errorCopy = error ? operatorErrorCopy(error.cause) : null;
  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2">
        <WorkspaceButton
          disabled={busy || !permissions.publishRelease}
          onClick={() => void refresh("24h")}
        >
          <RefreshCcw className="h-4 w-4" /> {t("Refresh 24h")}
        </WorkspaceButton>
        <WorkspaceButton
          disabled={busy || !permissions.publishRelease}
          onClick={() => void refresh("72h")}
        >
          <RefreshCcw className="h-4 w-4" /> {t("Refresh 72h")}
        </WorkspaceButton>
      </div>
      {!permissions.publishRelease ? (
        <p className="mb-4 text-xs text-[var(--ad-text-muted)]">
          {t("Read-only: character.release.publish is not granted.")}
        </p>
      ) : null}
      {errorCopy ? (
        <div className="mb-4 rounded-md bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]" role="alert">
          <p className="font-semibold">{t(errorCopy.headline)}</p>
          <p className="mt-1">{t(errorCopy.nextStep, errorCopy.nextStepValues)}</p>
          <RequestErrorDetails technical={errorCopy.technical} />
        </div>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {windows.map((window) => {
          const monitor = current.monitors.find(
            (item) => item.window === window,
          );
          const emptyStatus =
            window === "route_qualification" ? "not_required" : "pending";
          const checks = monitor ? operationalChecks(monitor) : [];
          const failedChecks = checks.filter(([, passed]) => !passed);
          const recommendation = monitor?.verification.recommendation;
          const metrics = [
            ["uniqueUsers", "Unique users"],
            ["exchangeCount", "Chat exchanges"],
            ["generationCount", "Generations"],
            ["failedGenerations", "Failed generations"],
            ["generationFailureRate", "Generation failure rate"],
            ["latencyP95Ms", "p95 latency"],
          ] as const;
          return (
            <article
              className="min-w-0 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"
              key={window}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold">
                  {t(window.replaceAll("_", " "))} {t("guardrail")}
                </h3>
                <StatusBadge value={monitor?.status ?? emptyStatus} />
              </div>
              {monitor ? (
                <>
                  <p className="mt-3 text-sm leading-6">
                    {t("Recommendation:")}{" "}
                    {/*
                      SPEC: 线路失效时照权威算出来的 observed.reason 给下一步，不要写死一句话。
                      INTENT: 这里曾经恒定写着「重新资质化需要工程介入」。权威其实分了 11 种原因，
                        其中六种（profile 被禁用 / 归档、策略或评估器版本变了……）运营发一个新
                        Release 就能收口。一句话全推给工程，等于让本可自己修的下架烂在队列里。
                    */}
                    {monitor.verification.recommendation == null &&
                    window === "route_qualification" &&
                    monitor.status === "action_required"
                      ? (() => {
                          const copy = routeStaleReasonCopy(
                            monitor.observed.reason,
                          );
                          return `${t(copy.cause)} ${t(copy.recovery)}`;
                        })()
                      : t(typeof recommendation === "string"
                          ? RECOMMENDATIONS[recommendation] ?? "Review the recorded monitor evidence."
                          : "No recommendation was recorded.")}
                  </p>
                  {typeof monitor.verification.asOf === "string" ? (
                    <p className="mt-1 text-xs text-[var(--ad-text-muted)]">{t("As of {time}", { time: format.dateTime(monitor.verification.asOf) })}</p>
                  ) : null}
                  {checks.length > 0 ? (
                    <div className="mt-4 border-t border-[var(--ad-border)] pt-3">
                      <p className="text-xs font-semibold">{t("{passed} of {count} operational checks passed", { passed: checks.length - failedChecks.length, count: checks.length })}</p>
                      {failedChecks.length > 0 ? <ul className="mt-2 list-disc space-y-1 pl-4 text-sm text-[var(--ad-red-text)]">
                        {failedChecks.map(([key]) => <li className="break-words" key={key}>{t(CHECK_LABELS[key] ?? key)}</li>)}
                      </ul> : null}
                    </div>
                  ) : null}
                  {metrics.some(([key]) => Object.hasOwn(monitor.observed, key)) ? (
                    <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-[var(--ad-border)] pt-3 text-xs">
                      {metrics.map(([key, label]) => {
                        const value = monitor.observed[key];
                        return <div className="min-w-0" key={key}>
                          <dt className="text-[var(--ad-text-muted)]">{t(label)}</dt>
                          <dd className="mt-1 break-words font-semibold tabular-nums">
                            {typeof value !== "number" || !Number.isFinite(value) ? t("Unavailable")
                              : key === "generationFailureRate" ? `${format.count(value * 100)}%`
                              : key === "latencyP95Ms" ? t("{value} ms", { value: format.count(value) })
                              : format.count(value)}
                          </dd>
                        </div>;
                      })}
                    </dl>
                  ) : null}
                  {recommendation === "rollback_review" ? (
                    <button className="mt-4 inline-flex min-h-11 items-center rounded-md border border-[var(--ad-border)] px-3 text-sm font-semibold" onClick={onOpenRelease} type="button">
                      {t("Review release and rollback")}
                    </button>
                  ) : null}
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
                  <div className="mt-4">
                    <EngineeringDetails summary={t("Full monitor evidence")}>
                      <pre className="whitespace-pre-wrap [overflow-wrap:anywhere]">{JSON.stringify({ observed: monitor.observed, verification: monitor.verification, baseline: monitor.baseline }, null, 2)}</pre>
                    </EngineeringDetails>
                  </div>
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
