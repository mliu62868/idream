"use client";

// SPEC: 视图组（starters / recipes / presets / placements / assets 五件套 + 单页视图）共享的
//       骨架件：写操作反馈出口、InfoGrid、列表页防抖重载、URL 游标恢复、详情页加载门。
// INTENT: 这些片段此前在五个 section 里逐字节复制了 5 份（远超"事不过三"）。共享件放在本目录，
//         不动 ui/——那是全站原语的地盘，本文件只服务视图层。
// SEAM(toast): useWriteFeedback + WriteFeedbackBanner 是全局 toast 的唯一接缝。全局 toast
//   （ui/Toast.tsx + useToast()）落地后，只需把 WriteFeedbackBanner 换成 toast 渲染、把
//   reportSuccess/reportFailure 转发给 useToast().show()，26 个调用点一行都不用改。

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import { useAdminI18n } from "@/components/admin/i18n";
import type { LatestRequestGate } from "@/lib/latest-request";
import { cn } from "@/lib/utils";

// INVARIANT: 成功提示自动消失，失败提示不会——运营没读到的失败等于没发生。
const SUCCESS_DISMISS_MS = 8_000;

// SPEC: 请求失败时给运营看什么。有 Error 就用它自己的话，否则一句通用兜底。
// SEAM(request-error-copy): 上游已落地 ui/request-error-copy.ts —— 把 AppErrorCode 映射成人话 +
//   下一步，映射不到就如实说「原因未能识别」，5xx 与网络故障一律不承诺"没有写入"。合并后只改
//   这一个函数体（`return requestErrorCopy(error).message`），26 个调用点一行都不用动。
// INTENT: 兜底刻意只有一句通用文案 —— 绝不在 26 处各编一句自己的中文，那正是要消灭的东西。
export function requestErrorMessage(error: unknown, t: (key: string) => string): string {
  return error instanceof Error ? error.message : t("Request failed");
}

export type WriteFeedback = { tone: "success" | "failure"; message: string };

export type WriteFeedbackHandle = {
  feedback: WriteFeedback | null;
  reportSuccess: (message: string) => void;
  reportFailure: (message: string) => void;
  clearFeedback: () => void;
};

export function useWriteFeedback(): WriteFeedbackHandle {
  const [feedback, setFeedback] = useState<WriteFeedback | null>(null);
  const timer = useRef<number | null>(null);

  const stopTimer = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => stopTimer, [stopTimer]);

  // INVARIANT: 三个 report/clear 的引用必须恒定——调用点会把它们放进 useCallback/useEffect
  // 的依赖数组，引用一变就会把 bootstrap 或 load 重跑一遍。
  const reportSuccess = useCallback((message: string) => {
    stopTimer();
    setFeedback({ tone: "success", message });
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setFeedback(null);
    }, SUCCESS_DISMISS_MS);
  }, [stopTimer]);

  const reportFailure = useCallback((message: string) => {
    stopTimer();
    setFeedback({ tone: "failure", message });
  }, [stopTimer]);

  const clearFeedback = useCallback(() => {
    stopTimer();
    setFeedback(null);
  }, [stopTimer]);

  return useMemo(
    () => ({ feedback, reportSuccess, reportFailure, clearFeedback }),
    [clearFeedback, feedback, reportFailure, reportSuccess],
  );
}

export function WriteFeedbackBanner({
  feedback,
  onDismiss,
}: {
  feedback: WriteFeedback | null;
  onDismiss: () => void;
}) {
  const { t } = useAdminI18n();
  if (!feedback) return null;
  const succeeded = feedback.tone === "success";
  return (
    <p
      className={cn(
        "flex items-start justify-between gap-3 rounded-md px-3 py-2 text-xs",
        succeeded
          ? "bg-[var(--ad-green-bg)] text-[var(--ad-green-text)]"
          : "bg-[var(--ad-red-bg)] text-[var(--ad-red-text)]",
      )}
      role={succeeded ? "status" : "alert"}
    >
      <span>{feedback.message}</span>
      <button
        aria-label={t("Dismiss")}
        className="-my-0.5 shrink-0 rounded p-0.5 hover:bg-black/[0.06]"
        onClick={onDismiss}
        type="button"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </p>
  );
}

export function InfoGrid({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
      {items.map((item) => (
        <div key={item.label}>
          <dt className="text-xs text-[var(--ad-text-muted)]">{item.label}</dt>
          <dd className="mt-0.5 text-sm text-[var(--ad-ink)]">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// SPEC: 列表页重载——有搜索词时防抖 250ms，其余（翻页/换筛选）立即发。
export function useDebouncedReload({
  cursor,
  ready,
  reload,
  search,
}: {
  cursor: string | undefined;
  ready: boolean;
  reload: (cursor?: string) => void;
  search: string;
}) {
  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => reload(cursor), search.trim() ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [cursor, ready, reload, search]);
}

// SPEC: 挂载后从 URL 恢复筛选/游标，然后才允许首次取数。
// INVARIANT: 卸载时作废在途请求——否则慢响应会覆盖新一轮筛选的结果（Placements 曾漏掉这一条）。
// INTENT: apply 必须是 useCallback([]) 稳定引用，否则每次渲染都会重跑 bootstrap。
export function useUrlBootstrap(
  apply: (params: URLSearchParams) => void,
  gate: LatestRequestGate | null = null,
) {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const timer = window.setTimeout(() => apply(params), 0);
    return () => {
      gate?.invalidate();
      window.clearTimeout(timer);
    };
  }, [apply, gate]);
}
