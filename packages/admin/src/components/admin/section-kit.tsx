"use client";

// SPEC: 视图组（starters / recipes / presets / placements / assets 五件套 + 单页视图）共享的
//       骨架件：写操作反馈出口、InfoGrid、列表页防抖重载、URL 游标恢复、详情页加载门。
// INTENT: 这些片段此前在五个 section 里逐字节复制了 5 份（远超"事不过三"）。共享件放在本目录，
//         不动 ui/——那是全站原语的地盘，本文件只服务视图层。
// SEAM(toast): useWriteFeedback + WriteFeedbackBanner 是全局 toast 的唯一接缝。全局 toast
//   （ui/Toast.tsx + useToast()）落地后，只需把 WriteFeedbackBanner 换成 toast 渲染、把
//   reportSuccess/reportFailure 转发给 useToast().show()，26 个调用点一行都不用改。
//   注意 reportFailure 目前收的是 requestErrorMessage() 的原文；换成 toast 时应改走
//   useFailureToast(cause)，那条路径才有「下一步 + 复制给工程」。

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import type { AdminPageInfo } from "@idream/shared/admin";
import { useAdminI18n } from "@/components/admin/i18n";
import type { LatestRequestGate } from "@/lib/latest-request";
import { cn } from "@/lib/utils";

// INVARIANT: 成功提示自动消失，失败提示不会——运营没读到的失败等于没发生。
const SUCCESS_DISMISS_MS = 8_000;

// SPEC: authority 的原文，一个字不加工——它的去处是「技术详情」折叠区，不是运营的首屏。
// INVARIANT: 运营读到的那两句（发生了什么 / 下一步）由 ui/request-error-copy.ts 在渲染边界产出，
//   入口是 AuthorityRequestError 的 `cause`。所以失败时要把异常对象一起存下来
//   （authority-state 的 authorityRequestFailed 收第四个参数 cause），只存 message 会让
//   code / status / requestId 在这一层就丢光，横幅退回「读不到最新数据」的通用兜底。
export function requestErrorMessage(error: unknown, t: (key: string) => string): string {
  return error instanceof Error ? error.message : t("Request failed");
}

// SPEC: 「上一页」是否可以点。
// INVARIANT: hasPreviousPage 缺席 ≠「你在第一页」，而是「这个 operation 还是单向 keyset」——置灰。
//   见 packages/shared/src/admin/contracts/common.ts 的 SPEC。
// TRAP: 光信响应体不够。content/* 与 generation catalog 都经 paginateAdminKeyset 回了
//   hasPreviousPage / startCursor，但它们的查询契约里根本没有 `before` 参数（shared/admin/contracts
//   里只有 access / approvals / audit-log / billing / customers / promo / dead-letter 有），把
//   startCursor 当 before 发过去会被 .strict() 挡成 400。所以「我这个 operation 收不收 before」
//   必须由调用方交代，不能从 pageInfo 推断。
export function canGoPrevious(pageInfo: AdminPageInfo, acceptsBefore: boolean): boolean {
  return acceptsBefore && pageInfo.hasPreviousPage === true && Boolean(pageInfo.startCursor);
}

// SPEC: 列表页地址栏 = 该页的 API 查询参数 + page。page 只给 UI 用，永远不发给 authority。
// INTENT: 页码进 URL 是为了后退能落回正确的「第 N 页」——不进 URL 的话后退只恢复游标，
//   页码归零，运营会读到一个编出来的数字。
export function listUrlSearch(apiParams: URLSearchParams, page: number): string {
  const params = new URLSearchParams(apiParams);
  if (page > 1) params.set("page", String(page));
  return params.size ? `?${params}` : "";
}

// SPEC: 翻页写 pushState，改筛选/搜索写 replaceState。
// INTENT: 翻页是运营心里的一次导航，后退必须回得来（这五个列表页此前一律 replaceState，
//   后退连上一页都回不去）；而搜索框每敲一个字符就压一条历史，等于把后退键废掉。
export function syncListUrl(apiParams: URLSearchParams, page: number): void {
  const next = `${window.location.pathname}${listUrlSearch(apiParams, page)}`;
  const current = new URLSearchParams(window.location.search);
  const paged = apiParams.get("cursor") !== current.get("cursor")
    || String(page) !== (current.get("page") ?? "1");
  window.history[paged ? "pushState" : "replaceState"](null, "", next);
}

export function listPageFromParams(params: URLSearchParams): number {
  const page = Number(params.get("page"));
  return Number.isInteger(page) && page > 0 ? page : 1;
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
// INVARIANT: page 一起传下去 —— reload 要拿它写地址栏（游标不携带页码，光看 cursor 说不出第几页）。
export function useDebouncedReload({
  cursor,
  page,
  ready,
  reload,
  search,
}: {
  cursor: string | undefined;
  page: number;
  ready: boolean;
  reload: (cursor: string | undefined, page: number) => void;
  search: string;
}) {
  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => reload(cursor, page), search.trim() ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [cursor, page, ready, reload, search]);
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

  // SPEC: 后退/前进要把列表带回那一页 —— pushState 只改地址栏，状态得自己接回来。
  // INVARIANT: apply 与 bootstrap 用同一个回调，所以「从 URL 恢复」只有一套逻辑。
  useEffect(() => {
    const onPopState = () => apply(new URLSearchParams(window.location.search));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [apply]);
}
