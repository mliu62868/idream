"use client";
// SPEC: 运维「读为主」视图——表格展示 rows；失败行由调用方用 FailureReason 渲染 render() 出人话。
//       调用方 MAY 在某列 render() 里放安全的单行 triage 动作（如 requeue/discard 按钮）；
//       primitive 自身不做任何写操作，写动作的语义与后端调用完全由调用方持有。
// INVARIANTS: primitive 无写副作用；表格外层 overflow-x-auto，窄屏横滚不挤压。
import { type ReactNode, useId } from "react";
import { useAdminI18n } from "@/components/admin/i18n";

export type OpsColumn = {
  key: string;
  label: string;
  render?: (row: Record<string, unknown>) => ReactNode;
};

export function ReadonlyOpsView({
  title,
  columns,
  rows,
  empty,
}: {
  title: string;
  columns: OpsColumn[];
  rows: Record<string, unknown>[];
  empty?: ReactNode;
}) {
  const { t } = useAdminI18n();
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="space-y-3">
      <h2 className="text-sm font-semibold" id={titleId}>
        {t(title)} ({rows.length})
      </h2>
      <div aria-label={`${t(title)} scrollable table`} className="rounded-lg overflow-x-auto border border-[var(--ad-border)]" role="region" tabIndex={0}>
        <table className="w-full text-left text-sm">
          <caption className="sr-only">{t(title)} authoritative results</caption>
          <thead className="border-b border-[var(--ad-border)] text-xs text-[var(--ad-text-muted)]">
            <tr>
              {columns.map((c) => (
                <th key={c.key} className="whitespace-nowrap px-3 py-2 font-medium" scope="col">
                  {t(c.label)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-6 text-center text-xs text-[var(--ad-text-muted)]">
                  {empty ?? t("Empty")}
                </td>
              </tr>
            ) : (
              rows.map((row, index) => (
                <tr key={index} className="border-b border-[var(--ad-border)] align-top">
                  {columns.map((c) => (
                    <td key={c.key} className={c.render ? "px-3 py-2" : "whitespace-nowrap px-3 py-2"}>
                      {c.render ? c.render(row) : String(row[c.key] ?? "—")}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
