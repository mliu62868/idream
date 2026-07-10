"use client";
import Link from "next/link";
import type { ReactNode } from "react";

export type DataTableRow = { id: string; cells: ReactNode[]; href?: string };

// SPEC: 编辑部风表格：无竖线、仅底边分隔、宽松行高；有 href 的行整行可点进详情。
export function DataTable({
  headers,
  rows,
  empty,
}: {
  headers: string[];
  rows: DataTableRow[];
  empty?: ReactNode;
}) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr className="border-b border-[var(--ad-border)] text-xs uppercase tracking-[0.05em] text-[var(--ad-text-muted)]">
            {headers.map((header) => (
              <th className="px-4 py-3 font-medium" key={header}>
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              className="border-b border-[var(--ad-border)] transition-colors last:border-b-0 hover:bg-black/[0.02]"
              key={row.id}
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
