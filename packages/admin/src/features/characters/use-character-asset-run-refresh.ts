"use client";

// SPEC: Character Asset Studio 里「Run 交付后刷新工作区」与「生成中的 Run 轮询」两段自足的 hook。
// INTENT: 从 CharacterAssetStudio.tsx 原样移出，纯机械搬运，没有任何行为改动。两个 hook 各在组件里
//         原先那段 hook 的位置调用，内部 hook 的声明顺序不变；依赖数组只多了 setRefreshWarning，
//         它是 useState 的 setter，身份稳定，不会让 effect / callback 多跑一次。
import type { CreativeRun, CreativeRunDetail } from "@idream/shared/admin";
import { useCallback, useEffect, useRef } from "react";
import type { AdminI18nContextValue } from "@/components/admin/i18n";
import { usePollingTask, type PollingTask } from "@/lib/authority-resource";
import { isProjectionRequestCancellation } from "@/lib/committed-projection";

export function useCharacterAssetRunDeliveryRefresh(
  selectedRun: CreativeRunDetail | null,
  onProjectReload: () => Promise<void>,
  setRefreshWarning: (warning: string | null) => void,
) {
  const refreshedDeliveries = useRef(new Set<string>());
  useEffect(() => {
    if (!selectedRun) return;
    const assetIds = selectedRun.items.flatMap((item) => item.asset ? [item.asset.id] : []);
    const terminal = ["succeeded", "partially_succeeded", "failed", "cancelled"].includes(selectedRun.executionOutcome);
    const itemFailure = selectedRun.items.some((item) => item.executionState === "failed");
    if (assetIds.length === 0 && !terminal && !itemFailure) return;
    const receipt = `${selectedRun.id}:${terminal ? selectedRun.executionOutcome : itemFailure ? "needs_confirmation" : "delivered"}:${assetIds.sort().join(",")}`;
    if (refreshedDeliveries.current.has(receipt)) return;
    // A Run projection can deliver an image without a project mutation. Refresh
    // the library and workspace once per delivered asset set, including recovery.
    refreshedDeliveries.current.add(receipt);
    void onProjectReload().catch((cause) => {
      setRefreshWarning(cause instanceof Error ? cause.message : "Character assets could not be refreshed");
    });
  }, [onProjectReload, selectedRun, setRefreshWarning]);
}

export function useCharacterAssetRunPolling({
  activeRuns,
  loadRun,
  loadRuns,
  selectedRun,
  setRefreshWarning,
  t,
}: {
  activeRuns: readonly CreativeRun[];
  loadRun: (runId: string) => Promise<unknown>;
  loadRuns: (options: { readonly activeOnly: boolean }) => Promise<unknown>;
  selectedRun: CreativeRunDetail | null;
  setRefreshWarning: (warning: string | null) => void;
  t: AdminI18nContextValue["t"];
}) {
  const pollingRunId = selectedRun?.id ?? null;
  const shouldPollSelectedRun =
    selectedRun !== null &&
    (["pending", "running"].includes(selectedRun.executionOutcome) ||
      activeRuns.some((run) => ["pending", "running"].includes(run.executionOutcome)));
  // SPEC: 生成中的 Run 每 4s 刷新一次，失败退避到 8s。
  const pollAssetRun = useCallback<PollingTask>(
    async (context) => {
      if (!pollingRunId) return null;
      try {
        await Promise.all([loadRun(pollingRunId), loadRuns({ activeOnly: true })]);
        if (!context.cancelled) setRefreshWarning(null);
        return 4_000;
      } catch (cause) {
        // INTENT: 这一轮被取代不是故障，但取代它的未必是另一轮轮询（可能是一次手动读取），
        //         没人接管循环。只有循环本身被取消才停，否则按正常节奏继续。
        if (isProjectionRequestCancellation(cause)) return context.cancelled ? null : 4_000;
        if (!context.cancelled) {
          setRefreshWarning(
            cause instanceof Error
              ? t("Automatic refresh was delayed: {detail}. Retrying in the background; Refresh is also available.", { detail: t(cause.message) })
              : "Automatic refresh was delayed. Retrying in the background; Refresh is also available.",
          );
        }
        return 8_000;
      }
    },
    [loadRun, loadRuns, pollingRunId, setRefreshWarning, t],
  );
  usePollingTask(
    pollingRunId && shouldPollSelectedRun ? pollAssetRun : null,
    4_000,
  );
}
