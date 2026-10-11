"use client";

import { Loader2 } from "lucide-react";
import { useCallback, useEffect } from "react";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import { useAdminI18n } from "@/components/admin/i18n";
import type { WorkMode } from "@/components/admin/nav-config";
import { useAuthorityResource } from "@/lib/authority-resource";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import { TodayView } from "./TodayView";

export function TodayRecoveryNotice({
  error,
  hasData,
  loading,
  onRetry,
  t,
}: {
  error: string | null;
  hasData: boolean;
  loading: boolean;
  onRetry: () => void;
  t: (key: string) => string;
}) {
  if (error) {
    return (
      <div
        aria-live="assertive"
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--ad-red-text)]/20 bg-[var(--ad-red-bg)] px-4 py-3 text-sm text-[var(--ad-red-text)]"
        role="alert"
      >
        <div>
          <p className="font-semibold">
            {t(hasData
              ? "Today refresh failed. Showing the last loaded snapshot."
              : "Today's work could not be loaded.")}
          </p>
          {!hasData ? (
            <p className="mt-1 text-xs">
              {t("Reconnect and retry to restore the queue.")}
            </p>
          ) : null}
        </div>
        <button
          className="min-h-9 rounded-md border border-current px-3 font-semibold"
          onClick={onRetry}
          type="button"
        >
          {t("Retry")}
        </button>
      </div>
    );
  }

  if (loading && hasData) {
    return (
      <div
        aria-live="polite"
        className="flex items-center gap-2 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] px-4 py-3 text-sm text-[var(--ad-text-muted)]"
        role="status"
      >
        <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
        {t("Refreshing Today. Showing the last loaded snapshot.")}
      </div>
    );
  }

  return null;
}

/**
 * SPEC: Today 的取数外壳 —— 自取数、自报加载/错误，与其余 37 个工作台一致。
 * INTENT: 主任务队列独立加载；折叠的背景统计不能决定今天的工作是否可用。
 * INVARIANT: workMode 进 key —— 切换工作模式等于换一份投影，迟到的旧响应不得覆盖新的。
 */
export function TodayWorkspace({ workMode }: { workMode: WorkMode }) {
  const { t } = useAdminI18n();

  const load = useCallback(() =>
    adminV2Operation("GET /api/v2/admin/today", { query: new URLSearchParams({ workMode }) }),
  [workMode]);

  const resource = useAuthorityResource({ key: `today:${workMode}`, load });
  const { refresh } = resource;

  useEffect(() => {
    const onRefresh = () => void refresh();
    window.addEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, onRefresh);
  }, [refresh]);

  const recoveryNotice = (
    <TodayRecoveryNotice
      error={resource.error}
      hasData={Boolean(resource.data)}
      loading={resource.loading}
      onRetry={() => void refresh()}
      t={t}
    />
  );

  if (resource.error && !resource.data) return recoveryNotice;
  if (!resource.data) {
    return (
      <div className="flex h-48 items-center justify-center text-[var(--ad-text-muted)]">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        {t("Loading")}
      </div>
    );
  }
  return (
    <>
      {resource.loading || resource.error ? (
        <div className="mb-4">{recoveryNotice}</div>
      ) : null}
      <TodayView data={{ projection: resource.data }} onPreferenceChanged={refresh} workMode={workMode} />
    </>
  );
}
