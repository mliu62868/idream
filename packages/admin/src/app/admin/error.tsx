"use client";

import { useState } from "react";
import { translateAdmin } from "@/components/admin/i18n";
import { readAdminLocaleFromDocument } from "@/components/admin/shell-preferences";

// SPEC: 后台渲染崩溃时的兜底页。运营读到的是「出了什么事 + 下一步」，
//       React 抛出的 message / digest 折进技术详情，可一键复制给工程。
// INTENT: 这里以前把 `error.message` 直接打在页面上——那串东西可能带组件名或堆栈片段，
//         运营既看不懂也没法据此做任何事，而工程真正需要的 digest 反倒没显示。
// INTENT: 错误边界替换的是整棵子树，AdminI18nProvider 已经不在上层了，所以和 ui/Toast.tsx
//         一样直接查词典——同一张表，不是第二套 i18n。
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const locale = readAdminLocaleFromDocument();
  const t = (key: string) => translateAdmin(locale, key);
  const [copied, setCopied] = useState(false);
  const detail = [
    error.digest ? `digest: ${error.digest}` : null,
    `message: ${error.message || "(none)"}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  return (
    <main className="grid min-h-screen place-items-center bg-[var(--ad-canvas)] p-6 text-[var(--ad-ink)]">
      <section
        className="w-full max-w-lg rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-6"
        role="alert"
      >
        <h1 className="text-xl font-semibold">{t("This workspace stopped rendering.")}</h1>
        <p className="mt-2 text-sm text-[var(--ad-text-muted)]">

          {t("Nothing was written by the failure itself. Retry below; if it keeps happening, send the technical details to engineering.")}
        </p>
        <details className="mt-4 rounded-lg border border-[var(--ad-border)] bg-black/[0.03] text-xs">
          <summary className="cursor-pointer list-none px-3 py-2 text-[var(--ad-text-muted)] [&::-webkit-details-marker]:hidden">
            {t("Engineering details")}
          </summary>
          <div className="border-t border-[var(--ad-border)] px-3 py-2">
            <pre className="whitespace-pre-wrap break-all font-mono text-[var(--ad-text-muted)]">{detail}</pre>
            <button
              className="mt-2 inline-flex min-h-8 items-center rounded border border-current px-2 font-semibold text-[var(--ad-text-muted)]"
              onClick={() => {
                void navigator.clipboard?.writeText(detail);
                setCopied(true);
              }}
              type="button"
            >
              {copied ? t("Copied") : t("Copy for engineering")}
            </button>
          </div>
        </details>
        <button
          className="mt-5 min-h-11 rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white"
          onClick={reset}
          type="button"
        >

          {t("Retry")}
        </button>
      </section>
    </main>
  );
}
