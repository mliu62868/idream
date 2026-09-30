"use client";

import { useAdminI18n, type AdminLocale } from "@/components/admin/i18n";
import { formatDateTime } from "@/components/admin/ui/format";
import { RefreshCcw } from "lucide-react";
import { RequestErrorDetails } from "./RequestErrorDetails";
import { operatorErrorCopy } from "./request-error-copy";

// SPEC: authority 请求失败的横幅：一句运营看得懂的话 + 下一步，原始报错折进「技术详情」。
// INTENT: 这里以前直接把 authority 的英文报错糊在运营脸上。运营从
//         `conflict: Character version changed` 里读不出「我现在该干什么」，而工程需要的
//         requestId 又根本没显示——两边都没服务到。
export function AuthorityRequestError({
  cause,
  message,
  onRetry,
  snapshotAt,
  requestKind = "write",
}: {
  /** 原始异常。给了就按错误码映射文案；只有 message 时按「读不到最新数据」兜底。 */
  cause?: unknown;
  message: string;
  onRetry: () => void;
  snapshotAt?: string | null;
  /** 历史调用方也用它呈现保存失败；显式标注读取，才能省去写入结果核对。 */
  requestKind?: "read" | "write";
}) {
  const { locale, t } = useAdminI18n();
  const copy = cause === undefined ? null : operatorErrorCopy(cause);
  const headline = copy
    ? t(copy.headline)
    : t("The latest data could not be loaded.");
  // INVARIANT: 只对读取的断网/5xx 使用通用重试；被拒输入、权限与限流的恢复指引仍照权威映射。
  // 未知写结果仍需核对，不能因复用横幅而丢掉警示。
  const retryFailedRead = requestKind === "read" &&
    (copy?.technical.status == null || copy.technical.status >= 500);
  const nextStep = copy && !retryFailedRead
    ? t(copy.nextStep, copy.nextStepValues)
    : t(requestKind === "read" ? "Retry to load the latest data. The technical details identify the failed read." : "Retry below; the technical details tell engineering what failed.");
  return (
    <div
      className="rounded-md bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]"
      role="alert"
    >
      <div className="flex items-start justify-between gap-3">
        <span>
          <span className="block font-semibold">{headline}</span>
          <span className="mt-1 block">{nextStep}</span>
          {snapshotAt ? (
            <span className="mt-1 block text-xs">

              {t("Showing the last successful snapshot from")}{" "}
              <time dateTime={snapshotAt}>{formatSnapshotTime(snapshotAt, locale)}</time>.
            </span>
          ) : null}
        </span>
        <button
          className="inline-flex min-h-9 shrink-0 items-center gap-2 rounded border border-current px-3 font-semibold"
          onClick={onRetry}
          type="button"
        >
          <RefreshCcw className="h-4 w-4" />

          {t("Retry")}
        </button>
      </div>
      <RequestErrorDetails technical={copy?.technical ?? fallbackTechnical(message)} />
    </div>
  );
}

// INTENT: 十一处调用点只传了 message（历史上就没有异常对象可传）。它们照样得有技术详情，
//         所以把这句 message 当成 authority 原文放进去——不伪造 code/status/requestId。
function fallbackTechnical(message: string) {
  return { code: null, status: null, requestId: null, message };
}

function formatSnapshotTime(value: string, locale: AdminLocale) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : formatDateTime(value, locale);
}
