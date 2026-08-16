"use client";

import { AlertTriangle, CheckCircle2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAdminI18n } from "@/components/admin/i18n";
import { AdminV2RequestError } from "@/lib/admin-v2-api";

export type ActionFeedback = {
  tone: "success" | "error";
  message: string;
  values?: Record<string, string | number>;
  /** 原始技术串。只在展开后出现 —— 它是证据，不是给运营读的原因。 */
  detail?: string;
  undo?: { label: string; run: () => void | Promise<void> };
};

const AUTO_DISMISS_MS = 8_000;

/**
 * SPEC: Today 上所有写操作（单条 / 批量 / 撤销）共用的唯一反馈出口。
 * INTENT: 反馈原先长在每个 WorkItem 内部，成功和失败同为一行灰字、永不消失，
 *         批量操作更没有落点。收成一个出口后，成功/失败的视觉才有可能不同。
 * SEAM: 全局 toast（ui/Toast.tsx 的 useToast()）合并后，把这个 hook 的实现换成它，
 *       调用方 report()/failureFeedback() 的签名不用动。
 */
export function useActionFeedback() {
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null);
  const dismiss = useCallback(() => setFeedback(null), []);

  useEffect(() => {
    if (!feedback || feedback.tone === "error") return;
    const timer = window.setTimeout(() => setFeedback(null), AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  return { feedback, report: setFeedback, dismiss };
}

/**
 * SPEC: HTTP 状态 → 人话。
 * INTENT: 状态码是服务端真的返回的事实，据此说话不算编造；对不上的一律如实说"操作失败"，
 *         把原始串收进可展开的技术详情，绝不合成一个听起来合理的原因。
 */
export function failureFeedback(error: unknown): ActionFeedback {
  const detail = error instanceof Error ? error.message : String(error);
  if (error instanceof AdminV2RequestError) {
    if (error.status === 403) return { tone: "error", message: "You are not authorized to run this action", detail };
    if (error.status === 404) return { tone: "error", message: "This work item no longer exists", detail };
    if (error.status === 409 || error.status === 412) {
      return { tone: "error", message: "Someone changed this item first. Refresh and retry.", detail };
    }
  }
  return { tone: "error", message: "Action failed", detail };
}

export function ActionFeedbackBar({ feedback, onDismiss }: { feedback: ActionFeedback | null; onDismiss: () => void }) {
  const { t } = useAdminI18n();
  if (!feedback) return null;
  const failed = feedback.tone === "error";
  return (
    <div
      aria-live={failed ? "assertive" : "polite"}
      className={`fixed bottom-4 right-4 z-40 max-w-sm rounded-lg border px-4 py-3 shadow-[var(--ad-shadow-hover)] ${
        failed
          ? "border-[var(--ad-red-text)]/25 bg-[var(--ad-red-bg)] text-[var(--ad-red-text)]"
          : "border-[var(--ad-green-text)]/25 bg-[var(--ad-green-bg)] text-[var(--ad-green-text)]"
      }`}
      data-testid="today-action-feedback"
      role={failed ? "alert" : "status"}
    >
      <div className="flex items-start gap-2">
        {failed ? <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" /> : <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{t(feedback.message, feedback.values)}</p>
          {feedback.undo ? (
            <button
              className="mt-1 min-h-9 text-xs font-semibold underline underline-offset-2"
              onClick={() => void feedback.undo?.run()}
              type="button"
            >
              {t(feedback.undo.label)}
            </button>
          ) : null}
          {failed && feedback.detail ? (
            <details className="mt-1">
              <summary className="cursor-pointer text-xs">{t("Technical details")}</summary>
              <p className="mt-1 break-words text-[11px] opacity-80">{feedback.detail}</p>
            </details>
          ) : null}
        </div>
        <button aria-label={t("Dismiss")} className="min-h-9 shrink-0" onClick={onDismiss} type="button">
          <X aria-hidden className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
