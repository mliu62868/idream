"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useAdminI18n } from "@/components/admin/i18n";

export type DataTableAlign = "left" | "center" | "right";

export type DataTableColumn = {
  label: string;
  onSort?: () => void;
  sortDirection?: "ascending" | "descending" | "none";
  align?: DataTableAlign;
  /** CSS width hint, e.g. "12rem" — stops ID and date columns from stealing space from prose. */
  width?: string;
  /** Clamp the cell to `width` (default 14rem) instead of widening the whole table. */
  truncate?: boolean;
};
export type DataTableHeader = string | DataTableColumn;

export type DataTableRow = { id: string; cells: ReactNode[]; href?: string };

// SPEC: 多选由调用方持有 —— 表格只负责勾选框与操作条，选中集合与批量动作的语义在页面里。
export type DataTableSelection = {
  selected: readonly string[];
  onChange: (selected: string[]) => void;
  /** Bulk controls shown in the selection bar; they read the page's own `selected` state. */
  actions?: ReactNode;
};

export type DataTableDensity = "comfortable" | "compact";

const CELL_PADDING: Record<DataTableDensity, string> = {
  comfortable: "px-4 py-3",
  compact: "px-3 py-1.5",
};
const ALIGNMENT: Record<DataTableAlign, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right tabular-nums",
};
const STICKY_CELL =
  "sticky right-0 border-l border-[var(--ad-border)] bg-[var(--ad-surface)] shadow-[-8px_0_12px_-12px_rgba(0,0,0,0.35)]";

// SPEC: 编辑部风表格：无竖线、仅底边分隔；有 href 的行整行可点进详情。
// SPEC: 加载 / 空 / 出错三态内建 —— 调用方只传状态，不再每页手写一遍骨架和灰字。
export function DataTable({
  headers,
  rows,
  empty,
  caption = "Data table",
  minimumWidthClassName = "min-w-[640px]",
  stickyLastColumn = false,
  stickyHeader = false,
  density = "comfortable",
  loading = false,
  skeletonRows = 5,
  error = null,
  onRetry,
  selection,
}: {
  headers: DataTableHeader[];
  rows: DataTableRow[];
  empty?: ReactNode;
  caption?: string;
  minimumWidthClassName?: string;
  /** Keeps row actions reachable while wide operational tables scroll. */
  stickyLastColumn?: boolean;
  /** Caps the table height so column names survive a long vertical scroll. */
  stickyHeader?: boolean;
  /** Compact is for scanning a hundred rows; comfortable is for reading a dozen. */
  density?: DataTableDensity;
  loading?: boolean;
  /** Skeleton row count — pass the page size so the table does not resize when data lands. */
  skeletonRows?: number;
  error?: string | null;
  onRetry?: () => void;
  selection?: DataTableSelection;
}) {
  const { t } = useAdminI18n();
  const translatedCaption = t(caption);
  const columns = headers.map((header) => (typeof header === "string" ? { label: header } : header));
  const padding = CELL_PADDING[density];

  // SPEC: 出错时先说出错，而不是把零行说成"没有数据"。还有旧数据就把横幅压在表格上方。
  const errorBanner = error ? (
    <div className="rounded-lg border border-[var(--ad-red-text)]/20 bg-[var(--ad-red-bg)] px-4 py-3 text-sm text-[var(--ad-red-text)]" role="alert">
      {error}
      {onRetry ? (
        <button className="ml-3 min-h-8 rounded border border-current px-2 text-xs font-semibold" onClick={onRetry} type="button">
          {t("Retry")}
        </button>
      ) : null}
    </div>
  ) : null;
  if (error && rows.length === 0) return errorBanner;
  if (!loading && rows.length === 0 && empty) return <>{empty}</>;

  const selectableIds = rows.map((row) => row.id);
  const selectedOnPage = selection ? selectableIds.filter((id) => selection.selected.includes(id)) : [];
  const allSelected = selection !== undefined && selectableIds.length > 0 && selectedOnPage.length === selectableIds.length;

  function toggleRow(id: string, checked: boolean) {
    if (!selection) return;
    const next = checked
      ? [...selection.selected, id]
      : selection.selected.filter((selected) => selected !== id);
    selection.onChange(next);
  }

  function toggleAll(checked: boolean) {
    if (!selection) return;
    const others = selection.selected.filter((id) => !selectableIds.includes(id));
    selection.onChange(checked ? [...others, ...selectableIds] : others);
  }

  function bodyCells(row: DataTableRow) {
    return [
      selection ? (
        <td className={`${padding} w-10 align-middle`} key="__select">
          <input
            aria-label={t("Select row {id}", { id: row.id })}
            checked={selection.selected.includes(row.id)}
            className="h-4 w-4 accent-[var(--ad-ink)]"
            onChange={(event) => toggleRow(row.id, event.target.checked)}
            type="checkbox"
          />
        </td>
      ) : null,
      ...row.cells.map((cell, index) => {
        const column = columns[index];
        const isSticky = stickyLastColumn && index === row.cells.length - 1;
        return (
          <td
            className={`${padding} align-middle ${ALIGNMENT[column?.align ?? "left"]} ${isSticky ? `z-[1] ${STICKY_CELL}` : ""}`}
            key={index}
          >
            {renderCell(cell, column, row, index)}
          </td>
        );
      }),
    ];
  }

  return (
    <div className="space-y-2">
      {errorBanner}
      {selection && selection.selected.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--ad-ink)] bg-[var(--ad-ink)] px-4 py-2 text-sm text-white">
          <span className="font-semibold">{t("{count} selected", { count: selection.selected.length })}</span>
          {selection.actions}
          <button
            className="ml-auto min-h-8 rounded-md border border-white/40 px-3 text-xs font-semibold"
            onClick={() => selection.onChange([])}
            type="button"
          >
            {t("Clear selection")}
          </button>
        </div>
      ) : null}
      <div
        aria-busy={loading || undefined}
        aria-label={t("{caption} scrollable table", { caption: translatedCaption })}
        className={`overflow-x-auto rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] ${stickyHeader ? "max-h-[70vh] overflow-y-auto" : ""}`}
        role="region"
        tabIndex={0}
      >
        {loading ? <p className="sr-only" role="status">{t("Loading {caption}…", { caption: translatedCaption })}</p> : null}
        <table className={`w-full ${minimumWidthClassName} text-left text-sm`}>
          <caption className="sr-only">{translatedCaption}</caption>
          <thead className={stickyHeader ? "sticky top-0 z-[2] bg-[var(--ad-surface)]" : ""}>
            <tr className="border-b border-[var(--ad-border)] text-xs uppercase tracking-[0.05em] text-[var(--ad-text-muted)]">
              {selection ? (
                <th className={`${padding} w-10`} scope="col">
                  <input
                    aria-label={t("Select all rows on this page")}
                    checked={allSelected}
                    className="h-4 w-4 accent-[var(--ad-ink)]"
                    onChange={(event) => toggleAll(event.target.checked)}
                    type="checkbox"
                  />
                </th>
              ) : null}
              {columns.map((column, index) => {
                const isSticky = stickyLastColumn && index === columns.length - 1;
                return (
                  <th
                    aria-sort={column.sortDirection && column.sortDirection !== "none" ? column.sortDirection : undefined}
                    className={`${padding} font-medium ${ALIGNMENT[column.align ?? "left"]} ${isSticky ? `z-[3] ${STICKY_CELL}` : ""}`}
                    key={column.label}
                    scope="col"
                    style={column.width ? { width: column.width } : undefined}
                  >
                    {column.onSort ? (
                      <button className="min-h-8 rounded px-1 text-left hover:text-[var(--ad-ink)] focus-visible:outline focus-visible:outline-2" onClick={column.onSort} type="button">{t(column.label)}</button>
                    ) : t(column.label)}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 ? (
              <SkeletonRows
                columnCount={columns.length + (selection ? 1 : 0)}
                padding={padding}
                rowCount={skeletonRows}
              />
            ) : (
              rows.map((row) => (
                row.href ? (
                  <LinkedRow className="cursor-pointer border-b border-[var(--ad-border)] transition-colors last:border-b-0 hover:bg-black/[0.02]" href={row.href} key={row.id}>
                    {bodyCells(row)}
                  </LinkedRow>
                ) : (
                  <tr className="border-b border-[var(--ad-border)] transition-colors last:border-b-0" key={row.id}>
                    {bodyCells(row)}
                  </tr>
                )
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function renderCell(cell: ReactNode, column: DataTableColumn | undefined, row: DataTableRow, index: number) {
  const clamped = column?.truncate
    ? <span className="block truncate" style={{ maxWidth: column.width ?? "14rem" }} title={typeof cell === "string" ? cell : undefined}>{cell}</span>
    : cell;
  if (!row.href || index !== 0) return clamped;
  return <Link className="block font-medium text-[var(--ad-ink)]" href={row.href}>{clamped}</Link>;
}

// SPEC: 整行点击 / Enter / Space 进详情，走 App Router 客户端导航。
// INTENT: 原来是 window.location.assign —— 整页重载，SPA 状态丢光，外壳重渲染再闪一次。
// INVARIANT: router 只在有 href 的行里取。没有链接的表格因此不需要 App Router 上下文，
//            静态渲染（RSC / 单测的 renderToStaticMarkup）照样能渲染。
function LinkedRow({ href, className, children }: { href: string; className: string; children: ReactNode }) {
  const router = useRouter();

  // 行内的链接、按钮、勾选框有自己的语义，不能被整行导航吞掉。
  function navigate(target: EventTarget | null) {
    if ((target as HTMLElement | null)?.closest("a,button,input,select,textarea,label")) return false;
    router.push(href);
    return true;
  }

  return (
    <tr
      className={className}
      onClick={(event) => { navigate(event.target); }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if (navigate(event.target)) event.preventDefault();
      }}
      tabIndex={0}
    >
      {children}
    </tr>
  );
}

// SPEC: 加载态是与真实行等高、行数等于页大小的骨架，不是一句 "Loading…"。
// INTENT: 数据落地时表格不跳高度，运营的视线不用重新找第一行。
function SkeletonRows({ columnCount, padding, rowCount }: { columnCount: number; padding: string; rowCount: number }) {
  return (
    <>
      {Array.from({ length: Math.max(1, rowCount) }, (_, row) => (
        <tr className="border-b border-[var(--ad-border)] last:border-b-0" key={row}>
          {Array.from({ length: columnCount }, (_, cell) => (
            <td className={padding} key={cell}>
              <span className="block h-4 animate-pulse rounded bg-black/[0.06]" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
