"use client";
// SPEC: 一次生成（图片或视频）失败时的就地说明 —— 人话原因 + 运行详情去处 + 可选的「为什么在那里重试」。
// INTENT: 图片候选失败早就走 FailureReason（翻译后的原因，机器码折进技术详情），视频失败却直接
//         打印原始 errorCode，只给一个跳转。两边是同一类失败，运营不该看到两种说法。
// INVARIANTS: 首屏只见人话；errorCode 与服务端原文只在 FailureReason 的折叠区。
//             重试不在这里发起 —— retry-failed 是 Run 页那台带落盘幂等键的持久命令机，不复制第二份。
import Link from "next/link";
import { useAdminI18n } from "@/components/admin/i18n";
import { FailureReason } from "./FailureReason";

export function GenerationRunFailure({
  errorCode,
  detail,
  runHref,
  linkLabel = "Open run details",
  retryHint,
  className = "mt-3",
}: {
  errorCode: string | null | undefined;
  /** 服务端给的原文（如 operatorGuidance），折进技术详情。 */
  detail?: string | null;
  runHref: string | null;
  linkLabel?: string;
  /** 说明为什么重试要去 Run 页；不传就不说。 */
  retryHint?: string;
  className?: string;
}) {
  const { t } = useAdminI18n();
  return (
    <div
      className={`${className} rounded-lg bg-[var(--ad-red-bg)] p-3 text-left text-xs text-[var(--ad-red-text)]`}
      data-testid="generation-run-failure"
      role="alert"
    >
      <FailureReason code={errorCode} detail={detail ?? undefined} />
      {retryHint ? <p className="mt-2 leading-5 text-[var(--ad-text)]">{t(retryHint)}</p> : null}
      {runHref ? (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Link className="inline-flex min-h-8 items-center font-semibold underline" href={runHref}>
            {t(linkLabel)}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
