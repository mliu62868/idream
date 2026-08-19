"use client";
import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAdminI18n } from "@/components/admin/i18n";

// SPEC: 表格里的 ID 单元格 —— 截断显示 + title 看全 + 一键复制。
// INTENT: 运营在 jobs / audit 里看到的是 `cmsr2c2t…`，既看不全也拿不走；要么手抄，要么开详情
//         再选中复制。ID 是他们粘进工单和 SQL 的东西，复制必须是一次点击。
export function CopyableId({ value, head = 8 }: { value: string; head?: number }) {
  const { t } = useAdminI18n();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  if (!value) return <span className="text-[var(--ad-text-muted)]">—</span>;

  function copy() {
    // 非安全上下文（http 的内网地址）没有 clipboard API，此时不假装复制成功。
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1_500);
    });
  }

  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <code className="font-mono text-xs text-[var(--ad-text)]" title={value}>
        {value.length > head ? `${value.slice(0, head)}…` : value}
      </code>
      <button
        aria-label={copied ? t("Copied") : t("Copy {value}", { value })}
        className="grid h-6 w-6 shrink-0 place-items-center rounded text-[var(--ad-text-muted)] hover:bg-black/[0.05] hover:text-[var(--ad-ink)]"
        onClick={copy}
        type="button"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-[var(--ad-green-text)]" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </span>
  );
}
