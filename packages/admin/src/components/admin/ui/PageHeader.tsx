import type { ReactNode } from "react";

// SPEC: 每页固定头 —— 一句话用途 + 右侧主动作；页名交给 shell 的粘性标题栏。
// INTENT: 页名曾在这里再印一遍，于是每一页都有两个标题，而且有七处两边写的名字还不一样
//         （侧栏"Billing Operations"→页内"Billing & Ledger"）。标题只留一个可见来源，
//         两边就不可能再漂移。h2 保留为 sr-only：既维持标题层级，也保住 aria-labelledby 锚点。
// INVARIANT: title 必须与该页导航项的 label 一致（nav-config.tsx 是 SSoT）。
export function PageHeader({
  title,
  purpose,
  action,
}: {
  title: string;
  purpose: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
      <h2 className="sr-only">{title}</h2>
      <p className="min-w-0 max-w-2xl text-sm leading-relaxed text-[var(--ad-text-muted)]">{purpose}</p>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
