"use client";
import { ChevronDown, ChevronUp, Loader2, Search, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useAdminI18n } from "@/components/admin/i18n";

export type FilterSelect = {
  name: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
};

export type FilterInput = {
  name: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** id of a <datalist> passed through `children` (facet suggestions). */
  list?: string;
  /** Spans two grid columns — for the long free-text fields. */
  wide?: boolean;
};

// SPEC: 折叠后用「已生效筛选芯片」表达当前条件；每个芯片自带清除动作。
// INTENT: 芯片的清除语义（把哪个字段还原成什么、要不要重新查）只有页面知道，primitive 不猜。
export type FilterChip = { key: string; label: string; value: string; onClear: () => void };

const FIELD_CLASS =
  "h-9 w-full rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm text-[var(--ad-text)] outline-none placeholder:text-[var(--ad-text-muted)] focus:border-[var(--ad-ink)]";

// SPEC: 列表页统一筛选条 —— 搜索框常驻；次级字段按需展开。
// INTENT: jobs 的 8 字段面板常驻展开吃掉首屏 300px，运营要滚动才看得到第一行；
//         而 characters 用的是紧凑弹层。两套范式收敛成一套：搜索 + 「Filters」开合 + 芯片。
// INVARIANT: collapsible=false 时保持原来的单行布局 —— 只有一两个下拉的列表页折起来反而更慢。
export function FilterBar({
  search,
  onSearch,
  searchPlaceholder,
  selects = [],
  inputs = [],
  chips = [],
  collapsible = false,
  onApply,
  onReset,
  busy = false,
  children,
}: {
  search: string;
  onSearch: (value: string) => void;
  searchPlaceholder: string;
  selects?: FilterSelect[];
  inputs?: FilterInput[];
  chips?: FilterChip[];
  collapsible?: boolean;
  /** Present when the filters hit the server on submit rather than filtering loaded rows. */
  onApply?: () => void;
  onReset?: () => void;
  busy?: boolean;
  children?: ReactNode;
}) {
  const { t } = useAdminI18n();
  const [expanded, setExpanded] = useState(false);

  const searchBox = (
    <div className="flex h-9 min-w-[220px] flex-1 items-center gap-2 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3">
      <Search className="h-4 w-4 shrink-0 text-[var(--ad-text-muted)]" />
      <input
        aria-label={searchPlaceholder}
        className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--ad-text-muted)]"
        onChange={(event) => onSearch(event.target.value)}
        placeholder={searchPlaceholder}
        value={search}
      />
    </div>
  );

  const selectFields = selects.map((select) => (
    <select
      aria-label={select.name}
      className={collapsible ? FIELD_CLASS : "h-9 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-2 text-sm text-[var(--ad-text)] outline-none"}
      key={select.name}
      onChange={(event) => select.onChange(event.target.value)}
      value={select.value}
    >
      {select.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  ));

  if (!collapsible) {
    return <div className="mb-4 flex flex-wrap items-center gap-2">{searchBox}{selectFields}{children}</div>;
  }

  return (
    <form
      className="mb-4 space-y-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3"
      onSubmit={(event) => { event.preventDefault(); onApply?.(); }}
    >
      <div className="flex flex-wrap items-center gap-2">
        {searchBox}
        <button
          aria-expanded={expanded}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[var(--ad-border)] px-3 text-sm font-semibold"
          onClick={() => setExpanded((current) => !current)}
          type="button"
        >
          {t("Filters")}
          {chips.length > 0 ? <span className="rounded-full bg-[var(--ad-ink)] px-1.5 text-[11px] tabular-nums text-white">{chips.length}</span> : null}
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        <button className="inline-flex h-9 items-center rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white disabled:opacity-50" disabled={busy} type="submit">{t("Apply")}</button>
        {busy ? <Loader2 aria-hidden className="h-4 w-4 animate-spin text-[var(--ad-text-muted)]" /> : null}
      </div>

      {chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((chip) => (
            <span className="inline-flex items-center gap-1 rounded-full border border-[var(--ad-border)] bg-black/[0.03] py-0.5 pl-2.5 pr-1 text-xs" key={chip.key}>
              <span className="text-[var(--ad-text-muted)]">{chip.label}:</span>
              <span className="font-medium text-[var(--ad-ink)]">{chip.value}</span>
              <button
                aria-label={t("Clear filter {label}", { label: chip.label })}
                className="grid h-5 w-5 place-items-center rounded-full text-[var(--ad-text-muted)] hover:bg-black/[0.06] hover:text-[var(--ad-ink)]"
                onClick={chip.onClear}
                type="button"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          {onReset ? (
            <button className="ml-1 min-h-7 rounded-md px-2 text-xs font-semibold text-[var(--ad-text-muted)] underline-offset-2 hover:text-[var(--ad-ink)] hover:underline" onClick={onReset} type="button">
              {t("Reset all")}
            </button>
          ) : null}
        </div>
      ) : null}

      {expanded ? (
        <div className="grid gap-3 border-t border-[var(--ad-border)] pt-3 sm:grid-cols-2 xl:grid-cols-4">
          {inputs.map((input) => (
            <label className={`text-xs font-semibold text-[var(--ad-text-muted)] ${input.wide ? "sm:col-span-2" : ""}`} key={input.name}>
              {input.name}
              <input
                className={`${FIELD_CLASS} mt-1`}
                list={input.list}
                onChange={(event) => input.onChange(event.target.value)}
                placeholder={input.placeholder}
                value={input.value}
              />
            </label>
          ))}
          {selects.map((select, index) => (
            <label className="text-xs font-semibold text-[var(--ad-text-muted)]" key={select.name}>
              {select.name}
              <div className="mt-1">{selectFields[index]}</div>
            </label>
          ))}
          {children}
        </div>
      ) : null}
    </form>
  );
}
