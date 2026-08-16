"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import {
  globalAdminSearchResponseSchema,
  type GlobalAdminSearchResponse,
} from "@idream/shared/admin";
import type { AdminPermissionKey } from "@idream/shared/admin/permissions";
import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { CornerDownLeft, Loader2, Search } from "lucide-react";
import { adminV2Request } from "@/lib/admin-v2-api";
import { matchAdminDestinations, type AdminDestination } from "./admin-destinations";

type SearchResult = GlobalAdminSearchResponse["items"][number];

// SPEC: 上下键要在「跳转到」和「搜索结果」两组之间连续走，所以候选拍平成一个数组；
//       高亮走的是这个数组，而不是某一组。
type PaletteOption =
  | { kind: "destination"; key: string; href: string; destination: AdminDestination }
  | { kind: "record"; key: string; href: string; record: SearchResult };

export type GlobalAdminSearchAuthorityState = {
  availability: "idle" | "available" | "unavailable";
  items: readonly SearchResult[];
  lastGoodQuery: string | null;
};

export const INITIAL_GLOBAL_ADMIN_SEARCH_STATE: GlobalAdminSearchAuthorityState =
  {
    availability: "idle",
    items: [],
    lastGoodQuery: null,
  };

export function globalAdminSearchSucceeded(
  state: GlobalAdminSearchAuthorityState,
  query: string,
  items: readonly SearchResult[],
): GlobalAdminSearchAuthorityState {
  return {
    ...state,
    availability: "available",
    items,
    lastGoodQuery: query,
  };
}

export function globalAdminSearchFailed(
  state: GlobalAdminSearchAuthorityState,
): GlobalAdminSearchAuthorityState {
  return {
    ...state,
    availability: "unavailable",
  };
}

export function globalAdminSearchUnavailableMessage(
  state: GlobalAdminSearchAuthorityState,
) {
  if (state.items.length > 0 && state.lastGoodQuery) {
    return `Search unavailable. Showing last successful results for "${state.lastGoodQuery}".`;
  }
  if (state.lastGoodQuery) {
    return `Search unavailable. The last successful search for "${state.lastGoodQuery}" returned no results.`;
  }
  return "Search unavailable. No cached results are available.";
}

// SPEC: 这批实体记录是否属于当前输入。
// INTENT: 导航候选是本地同步的、每次击键立刻出；实体候选要等 200ms 防抖 + 一次网络往返。
//         两者同框之后，如果不判归属，上一次查询的记录会跟着新输入一起显示。
//         降级是唯一的例外——横幅已经写明"显示上次成功的结果"，那是有意为之的旧数据。
export function globalAdminSearchRecordsForQuery(
  state: GlobalAdminSearchAuthorityState,
  query: string,
): readonly SearchResult[] {
  if (state.availability === "unavailable") return state.items;
  return state.lastGoodQuery === query.trim() ? state.items : [];
}

export function GlobalAdminSearch({
  permissions,
}: {
  permissions: ReadonlySet<AdminPermissionKey>;
}) {
  const { t } = useAdminI18n();
  const listboxId = useId();
  const requestId = useRef(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [authority, setAuthority] = useState<GlobalAdminSearchAuthorityState>(
    INITIAL_GLOBAL_ADMIN_SEARCH_STATE,
  );
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  // SPEC: 高亮记的是候选的 key，不是下标。
  // INTENT: 候选集会在输入之后二次变化（实体结果晚到），记下标的话高亮会跟着漂；
  //         记 key 就只有"这一条不在了"才需要回退到第一条，运营已经选中的那条不会被挪走。
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const destinations = useMemo(
    () => matchAdminDestinations(query, permissions),
    [permissions, query],
  );
  const records = globalAdminSearchRecordsForQuery(authority, query);
  const options = useMemo<PaletteOption[]>(
    () => [
      ...destinations.map((destination) => ({
        kind: "destination" as const,
        key: `destination:${destination.id}`,
        href: destination.href,
        destination,
      })),
      ...records.map((record) => ({
        kind: "record" as const,
        key: `record:${record.kind}:${record.id}`,
        href: record.href,
        record,
      })),
    ],
    [destinations, records],
  );
  // 选中的那条还在就保持不动；不在了（或还没选过）就落到第一条，Enter 永远有目标。
  const highlighted = options.findIndex((option) => option.key === activeKey);
  const activeIndex = highlighted >= 0 ? highlighted : (options.length > 0 ? 0 : -1);

  const moveHighlight = useCallback((delta: number) => {
    setActiveKey((current) => {
      if (options.length === 0) return null;
      const from = options.findIndex((option) => option.key === current);
      const next = ((from >= 0 ? from : 0) + delta + options.length) % options.length;
      return options[next].key;
    });
  }, [options]);

  useEffect(() => {
    if (query.trim().length < 2) return;
    const currentRequest = ++requestId.current;
    const requestedQuery = query.trim();
    const timer = window.setTimeout(() => {
      setLoading(true);
      void adminV2Request(
        `/api/v2/admin/search?q=${encodeURIComponent(requestedQuery)}&limit=8`,
        { schema: globalAdminSearchResponseSchema },
      )
        .then((response) => {
          if (requestId.current !== currentRequest) return;
          setAuthority((state) =>
            globalAdminSearchSucceeded(
              state,
              response.query,
              response.items,
            ),
          );
          setOpen(true);
        })
        .catch(() => {
          if (requestId.current === currentRequest) {
            setAuthority(globalAdminSearchFailed);
            setOpen(true);
          }
        })
        .finally(() => {
          if (requestId.current === currentRequest) setLoading(false);
        });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    function closeOutside(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);

  // SPEC: ⌘K / Ctrl+K 从后台任何位置聚焦全局搜索。
  // INTENT: 后台此前没有任何键盘入口——搜索是运营最高频的动作，却必须先把手从键盘挪到鼠标。
  //         两个修饰键都收：提示只写得下一个（写 ⌘K），但不该因此把非 mac 的运营挡在外面。
  useEffect(() => {
    function focusSearch(event: globalThis.KeyboardEvent) {
      if (event.key !== "k" || event.altKey || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    document.addEventListener("keydown", focusSearch);
    return () => document.removeEventListener("keydown", focusSearch);
  }, []);

  const dismiss = useCallback(({ blur }: { blur: boolean }) => {
    requestId.current += 1;
    setQuery("");
    setOpen(false);
    setActiveKey(null);
    setAuthority((state) => ({ ...state, availability: "idle" }));
    setLoading(false);
    if (blur) inputRef.current?.blur();
  }, []);

  return (
    <div className="relative" ref={rootRef}>
      <div className="flex h-9 min-w-0 items-center gap-2 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 focus-within:border-[var(--ad-ink)] focus-within:ring-2 focus-within:ring-[var(--ad-ink)]/10 lg:w-[320px]">
        {loading ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--ad-text-muted)]" /> : <Search className="h-4 w-4 shrink-0 text-[var(--ad-text-muted)]" />}
        <input
          aria-activedescendant={activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-expanded={open}
          aria-keyshortcuts="Meta+K Control+K"
          aria-label={t("Global admin search")}
          className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--ad-text-muted)]"
          onChange={(event) => {
            const next = event.target.value;
            requestId.current += 1;
            setQuery(next);
            // 导航候选是同步算出来的，输入非空就立刻可以展示——不等实体请求的防抖。
            setOpen(next.trim().length > 0);
            setAuthority((state) => ({
              ...state,
              availability: "idle",
            }));
            setLoading(false);
          }}
          onFocus={() => {
            if (query.trim().length > 0) setOpen(true);
          }}
          onKeyDown={(event) => {
            // Esc 清空并交还焦点——运营用 ⌘K 进来之后需要一个对称的出口。
            if (event.key === "Escape") {
              dismiss({ blur: true });
              return;
            }
            if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); moveHighlight(1); }
            if (event.key === "ArrowUp") { event.preventDefault(); setOpen(true); moveHighlight(-1); }
            // 跳转沿用仓库既有惯例（DataTable / CreativeRunWorkspace 都是 location.assign）。
            if (event.key === "Enter" && options[activeIndex]) {
              event.preventDefault();
              window.location.assign(options[activeIndex].href);
            }
          }}
          placeholder={t("Jump to a page or search records…")}
          ref={inputRef}
          role="combobox"
          value={query}
        />
        <kbd
          aria-hidden="true"
          className="pointer-events-none hidden shrink-0 rounded border border-[var(--ad-border)] px-1.5 text-[10px] font-medium text-[var(--ad-text-muted)] lg:inline"
        >
          ⌘K
        </kbd>
      </div>
      {open ? (
        <div className="absolute right-0 z-50 mt-2 w-[min(92vw,520px)] overflow-hidden rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] shadow-xl">
          {authority.availability === "unavailable" ? (
            <div
              className="m-2 rounded-md bg-[var(--ad-red-bg)] px-3 py-2 text-xs text-[var(--ad-red-text)]"
              role="alert"
            >
              {globalAdminSearchUnavailableMessage(authority)}
            </div>
          ) : null}
          {/* role=listbox > role=group > role=option：上下键跨组连续走，两组各自带标题。 */}
          <div aria-label={t("Global search results")} className="max-h-[min(60vh,440px)] overflow-y-auto p-1" id={listboxId} role="listbox">
            {destinations.length > 0 ? (
              <div aria-label={t("Go to")} role="group">
                <PaletteGroupHeading>{t("Go to")}</PaletteGroupHeading>
                {destinations.map((destination, index) => {
                  const Icon = destination.icon;
                  return (
                    <PaletteOptionRow
                      active={activeIndex === index}
                      href={destination.href}
                      id={`${listboxId}-${index}`}
                      key={destination.id}
                      onActivate={() => dismiss({ blur: false })}
                      onHover={() => setActiveKey(`destination:${destination.id}`)}
                    >
                      <span className="flex min-w-0 items-center gap-2.5">
                        <Icon className="h-4 w-4 shrink-0 text-[var(--ad-text-muted)]" />
                        <strong className="truncate text-sm font-medium">{t(destination.label)}</strong>
                        <span className="ml-auto shrink-0 text-[11px] text-[var(--ad-text-muted)]">{t(destination.group)}</span>
                        {activeIndex === index ? <CornerDownLeft aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-[var(--ad-text-muted)]" /> : null}
                      </span>
                    </PaletteOptionRow>
                  );
                })}
              </div>
            ) : null}
            {records.length > 0 ? (
              <div aria-label={t("Search results")} role="group">
                <PaletteGroupHeading>{t("Search results")}</PaletteGroupHeading>
                {records.map((item, recordIndex) => {
                  const index = destinations.length + recordIndex;
                  return (
                    <PaletteOptionRow
                      active={activeIndex === index}
                      href={item.href}
                      id={`${listboxId}-${index}`}
                      key={`${item.kind}:${item.id}`}
                      onActivate={() => dismiss({ blur: false })}
                      onHover={() => setActiveKey(`record:${item.kind}:${item.id}`)}
                    >
                      <span className="grid gap-1">
                        <span className="flex items-center justify-between gap-3"><strong className="truncate text-sm">{item.title}</strong><span className="rounded-full bg-black/[0.05] px-2 py-0.5 text-[10px] uppercase text-[var(--ad-text-muted)]">{t(item.kind.replaceAll("_", " "))}</span></span>
                        <span className="truncate text-xs text-[var(--ad-text-muted)]">{item.subtitle} · {item.status}</span>
                      </span>
                    </PaletteOptionRow>
                  );
                })}
              </div>
            ) : null}
            {!loading &&
            options.length === 0 &&
            authority.availability === "available" ? (
              <p className="px-3 py-5 text-center text-sm text-[var(--ad-text-muted)]">
                {t("No permitted records match this search.")}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PaletteGroupHeading({ children }: { children: ReactNode }) {
  return (
    <p aria-hidden="true" className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-normal text-[var(--ad-text-muted)]">
      {children}
    </p>
  );
}

function PaletteOptionRow({
  active,
  children,
  href,
  id,
  onActivate,
  onHover,
}: {
  active: boolean;
  children: ReactNode;
  href: string;
  id: string;
  onActivate: () => void;
  onHover: () => void;
}) {
  return (
    <div aria-selected={active} id={id} role="option">
      <Link
        className={`block rounded-md px-3 py-2.5 ${active ? "bg-black/[0.06]" : "hover:bg-black/[0.04]"}`}
        href={href}
        onClick={onActivate}
        onMouseEnter={onHover}
      >
        {children}
      </Link>
    </div>
  );
}
