"use client";
import { Search } from "lucide-react";

export type FilterSelect = {
  name: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
};

// SPEC: 列表页统一筛选条 —— 搜索框 + 若干下拉。全部受控，父组件本地过滤或改查询参数。
export function FilterBar({
  search,
  onSearch,
  searchPlaceholder,
  selects = [],
}: {
  search: string;
  onSearch: (value: string) => void;
  searchPlaceholder: string;
  selects?: FilterSelect[];
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <div className="flex h-9 min-w-[220px] items-center gap-2 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3">
        <Search className="h-4 w-4 shrink-0 text-[var(--ad-text-muted)]" />
        <input
          aria-label={searchPlaceholder}
          className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--ad-text-muted)]"
          onChange={(event) => onSearch(event.target.value)}
          placeholder={searchPlaceholder}
          value={search}
        />
      </div>
      {selects.map((select) => (
        <select
          aria-label={select.name}
          className="h-9 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-2 text-sm text-[var(--ad-text)] outline-none"
          key={select.name}
          onChange={(event) => select.onChange(event.target.value)}
          value={select.value}
        >
          {select.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ))}
    </div>
  );
}
