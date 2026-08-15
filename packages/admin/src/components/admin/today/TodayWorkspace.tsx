"use client";

import { Loader2 } from "lucide-react";
import { useCallback, useEffect } from "react";
import type { TodayProjection } from "@idream/shared/admin";
import { apiGet } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import type { WorkMode } from "@/components/admin/nav-config";
import { useAuthorityResource } from "@/lib/authority-resource";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import { TodayView, type TodayData, type TodayLegacyData } from "./TodayView";

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
              {t("Reconnect and retry to restore the authoritative queue.")}
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
 * INTENT: 这两个请求原先住在 AdminConsoleClient 的 fetchSection 里，是整个 shell 里
 *         唯一真正预取数据的 section。为它保留的 data/loading/error 状态机让另外 37 个
 *         section 也要先走一遍"假取数"才肯渲染。取数下沉到这里之后，shell 不再有任何
 *         与具体 section 相关的代码。
 * INVARIANT: workMode 进 key —— 切换工作模式等于换一份投影，迟到的旧响应不得覆盖新的。
 */
export function TodayWorkspace({ workMode }: { workMode: WorkMode }) {
  const { t } = useAdminI18n();

  const load = useCallback(async (): Promise<TodayData> => {
    const [legacy, projection] = await Promise.all([
      apiGet<TodayLegacyData>("/api/v1/admin/dashboard"),
      apiGet<TodayProjection>(`/api/v2/admin/today?workMode=${encodeURIComponent(workMode)}`),
    ]);
    return { legacy, projection };
  }, [workMode]);

  const resource = useAuthorityResource<TodayData>({ key: `today:${workMode}`, load });
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
      <TodayView data={resource.data} onPreferenceChanged={refresh} workMode={workMode} />
    </>
  );
}
