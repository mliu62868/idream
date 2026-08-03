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

  if (resource.error && !resource.data) {
    return (
      <div
        aria-live="assertive"
        className="rounded-lg border border-[var(--ad-red-text)]/20 bg-[var(--ad-red-bg)] px-4 py-3 text-sm text-[var(--ad-red-text)]"
        role="alert"
      >
        {resource.error}
      </div>
    );
  }
  if (!resource.data) {
    return (
      <div className="flex h-48 items-center justify-center text-[var(--ad-text-muted)]">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        {t("Loading")}
      </div>
    );
  }
  return <TodayView data={resource.data} onPreferenceChanged={refresh} workMode={workMode} />;
}
