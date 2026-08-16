"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import { getStoredAdminLocale, translateAdmin, useAdminI18n } from "@/components/admin/i18n";
import { cn } from "@/lib/utils";
import { operatorErrorCopy, technicalDetailText } from "./request-error-copy";

export type ToastTone = "success" | "error" | "info";

export type ToastInput = {
  tone: ToastTone;
  /** 一句话说清结果，调用处已经 t() 过。 */
  title: string;
  description?: string;
  /** 「查看详情 / 撤销」这类跟进入口；点完这条 toast 就收起。 */
  action?: { label: string; onClick: () => void };
};

type Toast = ToastInput & { id: string };

// SPEC: success/info 自动消失，error 不会。
// INTENT: 失败文案里带着运营的下一步动作和要转给工程的技术详情，自动消失等于把它藏起来。
const AUTO_DISMISS_MS: Record<ToastTone, number | null> = {
  success: 5_000,
  info: 7_000,
  error: null,
};

const MAX_VISIBLE = 4;

// INTENT: 不用 crypto.randomUUID —— 挂载测试普遍把它 stub 成固定值来钉幂等键，
//         那会让同时在场的两条 toast 撞成同一个 React key。
let nextToastId = 0;

type ToastContextValue = {
  toast: (input: ToastInput) => string;
  dismiss: (id: string) => void;
};

// SPEC: Provider 缺失时静默丢弃，不抛错。
// INTENT: 全后台只有 AdminConsoleClientOnly 一个挂载点，漏挂是布线错误，不该让整个控制台白屏；
//         布线由 AdminConsoleClientOnly.test.tsx 守住。
const ToastContext = createContext<ToastContextValue>({
  toast: () => "",
  dismiss: () => undefined,
});

export function useToast() {
  return useContext(ToastContext);
}

// SPEC: 写操作失败的标准反馈——人话标题 + 下一步动作，行动槽位挂「复制给工程」。
// INTENT: 每个 workspace 各写一遍 `cause instanceof Error ? cause.message : "..."` 的结果，
//         就是现在这样：运营看到一串英文，工程拿不到 requestId。这里两边一次性给齐。
// INVARIANT: 只在 AdminI18nProvider 内部调用（所有 workspace 都在），所以 t() 是真中文。
export function useFailureToast() {
  const { t } = useAdminI18n();
  const { toast } = useToast();
  return useCallback(
    (cause: unknown) => {
      const copy = operatorErrorCopy(cause);
      const detail = technicalDetailText(copy.technical);
      toast({
        tone: "error",
        title: t(copy.headline),
        description: t(copy.nextStep, copy.nextStepValues),
        action: {
          label: t("Copy for engineering"),
          onClick: () => void navigator.clipboard?.writeText(detail),
        },
      });
    },
    [t, toast],
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, number>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) window.clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback(
    (input: ToastInput) => {
      nextToastId += 1;
      const id = `toast-${nextToastId}`;
      setToasts((current) => [...current, { ...input, id }].slice(-MAX_VISIBLE));
      const ttl = AUTO_DISMISS_MS[input.tone];
      if (ttl !== null) timers.current.set(id, window.setTimeout(() => dismiss(id), ttl));
      return id;
    },
    [dismiss],
  );

  const value = useMemo(() => ({ dismiss, toast }), [dismiss, toast]);

  return (
    <ToastContext value={value}>
      {children}
      {/* INTENT: toasts 只可能被用户操作填上，也就是水合之后——所以这里不需要额外的
          mounted 闸门就已经碰不到服务端渲染，document.body 也一定存在。 */}
      {toasts.length > 0
        ? createPortal(<ToastViewport onDismiss={dismiss} toasts={toasts} />, document.body)
        : null}
    </ToastContext>
  );
}

const TONE_CLASS: Record<ToastTone, string> = {
  success: "border-[var(--ad-green-text)]/25 bg-[var(--ad-green-bg)] text-[var(--ad-green-text)]",
  error: "border-[var(--ad-red-text)]/25 bg-[var(--ad-red-bg)] text-[var(--ad-red-text)]",
  info: "border-[var(--ad-border)] bg-[var(--ad-surface)] text-[var(--ad-text)]",
};

const TONE_ICON = { success: CheckCircle2, error: XCircle, info: Info };

function ToastViewport({
  onDismiss,
  toasts,
}: {
  onDismiss: (id: string) => void;
  toasts: readonly Toast[];
}) {
  // INTENT: Provider 挂在 AdminI18nProvider 之外（AdminConsoleClientOnly 是唯一允许的挂载点），
  //         useAdminI18n() 在这里只拿得到默认英文 context。正文由调用处翻译好再传进来，
  //         只有下面两句外壳文案自己查表——查的仍然是同一张词典，不是第二套 i18n。
  const locale = getStoredAdminLocale();
  return (
    <div
      aria-label={translateAdmin(locale, "Action results")}
      className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
      role="region"
    >
      {toasts.map((item) => {
        const Icon = TONE_ICON[item.tone];
        return (
          <div
            aria-live={item.tone === "error" ? "assertive" : "polite"}
            className={cn(
              "pointer-events-auto flex items-start gap-2 rounded-lg border p-3 shadow-sm",
              TONE_CLASS[item.tone],
            )}
            data-testid="admin-action-status"
            data-tone={item.tone}
            key={item.id}
            role={item.tone === "error" ? "alert" : "status"}
          >
            <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{item.title}</p>
              {item.description ? <p className="mt-1 text-xs">{item.description}</p> : null}
              {item.action ? (
                <button
                  className="mt-2 text-xs font-semibold underline underline-offset-2"
                  onClick={() => {
                    item.action?.onClick();
                    onDismiss(item.id);
                  }}
                  type="button"
                >
                  {item.action.label}
                </button>
              ) : null}
            </div>
            <button
              aria-label={translateAdmin(locale, "Dismiss")}
              className="grid h-6 w-6 shrink-0 place-items-center rounded"
              onClick={() => onDismiss(item.id)}
              type="button"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
