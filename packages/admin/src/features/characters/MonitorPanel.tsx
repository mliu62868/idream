"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { RefreshCcw } from "lucide-react";
import { useRef, useState } from "react";
import {
  EmptyWorkspace,
  StatusBadge,
  WorkspaceButton,
} from "@/features/operations/WorkspaceUi";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import type {
  CharacterWorkspacePermissions,
  RunCommittedCharacterMutation,
} from "./character-workspace-permissions";

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
  permissions: CharacterWorkspacePermissions;
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
