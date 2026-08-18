"use client";
import { cn } from "@/lib/utils";
import { useAdminI18n } from "@/components/admin/i18n";
import { statusTone, STATUS_TONE_CLASS } from "./status-tone";

// SPEC: pastel 状态 pill。印出来的词一律过 value()（zhValues 枚举通道）——label 传了就翻 label，
//       没传就翻 status 本身。
// INTENT: label 过去直接渲染，等于把翻译责任推给每一个调用方；EntityCard 和 DetailPage 只是把
//         statusLabel 原样转进来，于是"某个调用方忘了 t()"必然漏成英文，而 pill 自己看不见。
// INVARIANT: value() 幂等——中文不是 zhValues 的 key，已经翻过的 label 原样返回，所以调用方
//            继续写 t()/value() 也不会被翻第二次。
export function StatusPill({ status, label }: { status: string; label?: string }) {
  const { value } = useAdminI18n();
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-[0.05em]",
        STATUS_TONE_CLASS[statusTone(status)],
      )}
    >
      {value(label ?? status)}
    </span>
  );
}
