"use client";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { useAdminI18n } from "@/components/admin/i18n";

// SPEC: 全后台游标分页的响应形状。
// INTENT: 这个类型在 features 下被逐字重复声明了 8 次；配套的「下一页」按钮手写了 9 遍。
//         两者都收在这个原语里 —— 类型从这里 import，按钮用 <Pagination>。
export type PageInfo = { endCursor: string | null; hasNextPage: boolean };

export const emptyPageInfo: PageInfo = { endCursor: null, hasNextPage: false };

export type PaginationPosition = {
  /** 1-based page the operator is looking at. */
  page: number;
  pageSize: number;
  /** Rows actually returned for this page — the upper bound when the total is unknown. */
  rowCount: number;
  /** Server-side match count; null when the endpoint only knows "there is more". */
  totalCount?: number | null;
};

// SPEC: 「第 N 条–第 M 条 / 共 X 条」与「第 N / M 页」的算法在这里，单独可测。
// INVARIANT: totalCount 为 null 时不编造总页数 —— 游标分页的后端确实不知道。
export function paginationSummary({ page, pageSize, rowCount, totalCount = null }: PaginationPosition) {
  const from = rowCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = (page - 1) * pageSize + rowCount;
  const pageCount = totalCount === null ? null : Math.max(1, Math.ceil(totalCount / pageSize));
  return { from, to, pageCount };
}

// SPEC: 列表尾部统一分页条 —— 总数、第 N/M 页、每页条数、上一页 / 下一页。
// INTENT: 之前每页各写一条尾巴，大多只有一个「Next page」按钮：运营看不到自己在第几页，
//         也回不去上一页（95 条 / 每页 25 条，翻到第 4 页就只能重来）。
export function Pagination({
  page,
  pageSize,
  rowCount,
  totalCount = null,
  pageSizeOptions = [10, 25, 50, 100],
  onPageSizeChange,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  loading = false,
  detail,
}: PaginationPosition & {
  pageSizeOptions?: readonly number[];
  onPageSizeChange?: (pageSize: number) => void;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  loading?: boolean;
  /** Page-specific provenance line (data scope, freshness…). */
  detail?: ReactNode;
}) {
  const { t } = useAdminI18n();
  const { from, to, pageCount } = paginationSummary({ page, pageSize, rowCount, totalCount });
  const buttonClass = "inline-flex min-h-9 items-center gap-1 rounded-md border border-[var(--ad-border)] px-3 text-sm font-semibold disabled:opacity-40";

  return (
    // SPEC: 稳定的测试锚点 —— 「不编造总数」这类断言必须指向分页条本身。
    // INTENT: 少了它，测试只能对整页文本做子串匹配，于是页头的「as of 1:47 AM」里那个
    //         "of 1" 就会把断言打红 —— 一天里有三分之一的钟点会中招。
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] px-4 py-3"
      data-testid="admin-pagination"
    >
      <div className="min-w-0 space-y-1">
        <p className="text-xs text-[var(--ad-text-muted)]">
          {totalCount === null
            ? t("Showing {count} rows", { count: rowCount })
            : t("Showing {from}–{to} of {total}", { from, to, total: totalCount })}
        </p>
        {detail ? <p className="text-xs text-[var(--ad-text-muted)]">{detail}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {loading ? <Loader2 aria-hidden className="h-4 w-4 animate-spin text-[var(--ad-text-muted)]" /> : null}
        {onPageSizeChange ? (
          <label className="flex items-center gap-1.5 text-xs text-[var(--ad-text-muted)]">
            {t("Rows per page")}
            <select
              className="h-9 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-2 text-sm text-[var(--ad-text)] outline-none"
              disabled={loading}
              onChange={(event) => onPageSizeChange(Number(event.target.value))}
              value={pageSize}
            >
              {pageSizeOptions.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
        ) : null}
        <span className="text-xs tabular-nums text-[var(--ad-text-muted)]">
          {pageCount === null ? t("Page {page}", { page }) : t("Page {page} of {pageCount}", { page, pageCount })}
        </span>
        <button className={buttonClass} disabled={loading || !hasPrevious} onClick={onPrevious} type="button">
          <ChevronLeft className="h-4 w-4" />{t("Previous page")}
        </button>
        <button className={buttonClass} disabled={loading || !hasNext} onClick={onNext} type="button">
          {t("Next page")}<ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
