"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { useAdminI18n } from "@/components/admin/i18n";

export type DataTableRow = { id: string; cells: ReactNode[]; href?: string };
export type DataTableHeader = string | {
  label: string;
  onSort?: () => void;
  sortDirection?: "ascending" | "descending" | "none";
};

// SPEC: 编辑部风表格：无竖线、仅底边分隔、宽松行高；有 href 的行整行可点进详情。
export function DataTable({
  headers,
  rows,
  empty,
  caption = "Data table",
  minimumWidthClassName = "min-w-[640px]",
}: {
  headers: DataTableHeader[];
  rows: DataTableRow[];
  empty?: ReactNode;
  caption?: string;
  minimumWidthClassName?: string;
}) {
  const { t } = useAdminI18n();
  const translatedCaption = t(caption);
  if (rows.length === 0 && empty) return <>{empty}</>;
  return (
    <div aria-label={t("{caption} scrollable table", { caption: translatedCaption })} className="overflow-x-auto rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]" role="region" tabIndex={0}>
      <table className={`w-full ${minimumWidthClassName} text-left text-sm`}>
        <caption className="sr-only">{translatedCaption}</caption>
        <thead>
          <tr className="border-b border-[var(--ad-border)] text-xs uppercase tracking-[0.05em] text-[var(--ad-text-muted)]">
            {headers.map((header) => {
              const definition = typeof header === "string" ? { label: header } : header;
              const translatedLabel = t(definition.label);
              return (
              <th
                aria-sort={definition.sortDirection && definition.sortDirection !== "none" ? definition.sortDirection : undefined}
                className="px-4 py-3 font-medium"
                key={definition.label}
                scope="col"
              >
                {definition.onSort ? (
                  <button className="min-h-8 rounded px-1 text-left hover:text-[var(--ad-ink)] focus-visible:outline focus-visible:outline-2" onClick={definition.onSort} type="button">{translatedLabel}</button>
                ) : translatedLabel}
              </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              className={
                row.href
                  ? "cursor-pointer border-b border-[var(--ad-border)] transition-colors last:border-b-0 hover:bg-black/[0.02]"
                  : "border-b border-[var(--ad-border)] transition-colors last:border-b-0"
              }
              key={row.id}
              onClick={row.href ? (event) => {
                if ((event.target as HTMLElement).closest("a,button,input,select,textarea")) return;
                window.location.assign(row.href as string);
              } : undefined}
              onKeyDown={row.href ? (event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                if ((event.target as HTMLElement).closest("a,button,input,select,textarea")) return;
                event.preventDefault();
                window.location.assign(row.href as string);
              } : undefined}
              tabIndex={row.href ? 0 : undefined}
            >
              {row.cells.map((cell, index) => (
                <td className="px-4 py-3 align-middle" key={index}>
                  {row.href && index === 0 ? (
                    <Link className="block font-medium text-[var(--ad-ink)]" href={row.href}>
                      {cell}
                    </Link>
                  ) : (
                    cell
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
