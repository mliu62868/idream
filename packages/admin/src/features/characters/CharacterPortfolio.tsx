"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import Link from "next/link";
import { characterPortfolioWorkQueueSchema, type AdminPageInfo, type AdminPermissionKey, type CharacterPortfolioItem, type DataQualityIssue } from "@idream/shared/admin";
import { Plus, Search } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAdminFormat } from "@/components/admin/ui/format";
import { Pagination } from "@/components/admin/ui/Pagination";
import {
  WorkspaceButton,
  fieldClass,
} from "@/features/operations/WorkspaceUi";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import { useAuthorityResource } from "@/lib/authority-resource";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import { cn } from "@/lib/utils";
import {
  CHARACTER_PORTFOLIO_DEFAULT_SORT,
  CHARACTER_PORTFOLIO_PAGE_SIZE,
  CHARACTER_PORTFOLIO_SORT_LABELS,
  CHARACTER_PORTFOLIO_SORTS,
  characterPortfolioEmptyView,
  characterPortfolioQuery,
  characterPortfolioRequestParams,
  parseCharacterPortfolioUrl,
  type CharacterPortfolioSort,
  type CharacterPortfolioSource,
  type CharacterPortfolioUrlState,
  type CharacterPortfolioWorkQueue,
} from "./portfolio-query";
import { permissionDenied } from "./character-permission-denied";
import { CharacterListEmptyState } from "./CharacterListEmptyState";
import { UnpreparedCharacters } from "./UnpreparedCharacters";
import { CharacterBulkBar } from "./CharacterBulkBar";
import { CharacterPerformanceBoard } from "./CharacterPerformanceBoard";
import { CharacterPortfolioCard } from "./CharacterPortfolioCard";

// INTENT: 稳定引用，避免"投影还没到"时每次渲染都换一个新的空值。
const EMPTY_PORTFOLIO_ITEMS: readonly CharacterPortfolioItem[] = [];
const EMPTY_PORTFOLIO_DATA_QUALITY: readonly DataQualityIssue[] = [];
const EMPTY_PORTFOLIO_PAGE_INFO: AdminPageInfo = {
  endCursor: null,
  hasNextPage: false,
};

// SPEC: 走过的游标存在 history entry 上，不只存在组件 state 里。
// INTENT: 刷新和「后退」都会重建组件，只靠 state 就把栈清空 —— 地址栏还带着第 4 页的游标，
//         分页条却报「第 1 页 · 第 1–25 条」。history.state 跟着这条 history entry 走，
//         刷新和前进后退都还在；真的放不下它时（别人分享过来的链接），宁可回到第一页，
//         也不显示一个猜出来的页码。
type PortfolioHistoryState = { cursorStack?: readonly string[] };

function restoredCursorStack(): readonly string[] {
  const state = window.history.state as PortfolioHistoryState | null;
  return Array.isArray(state?.cursorStack) ? state.cursorStack : [];
}

type CharacterPortfolioProps = {
  actorId?: string;
  canReadUnprepared?: boolean;
  canOpenAssets: boolean;
  canCreate: boolean;
  canOpenProjects: boolean;
  canRead: boolean;
  mode: "studio" | "performance";
  permissions?: ReadonlySet<AdminPermissionKey>;
};

// SPEC: 表现页是比较页，不是又一份按更新时间排的角色列表；两个页面只共用数据接口。
export function CharacterPortfolio(props: CharacterPortfolioProps) {
  return props.mode === "performance" ? (
    <CharacterPerformanceBoard
      canOpenProject={props.canOpenProjects}
      canRead={props.canRead}
      permissions={props.permissions}
    />
  ) : (
    <CharacterRoster {...props} />
  );
}

// SPEC: 视图按钮的顺序和文案。计数来自服务端，翻页不影响。
const ROSTER_VIEWS = [
  ["all", "All"],
  ["draft", "Draft"],
  ["live", "Live"],
  ["paused", "Paused"],
  ["archived", "Archived"],
] as const;
const WORK_QUEUE_VIEWS = [
  ["attention", "Needs attention"],
  ["publish_blocked", "Publish blocked"],
  ["recent_generation_failed", "Generation failed"],
  ["pending_changes", "Unpublished changes"],
  ["candidate_unpublished", "Candidate not published"],
  ["ready_to_publish", "Ready to publish"],
  ["live_asset_pack_incomplete", "Incomplete packs"],
] as const;
type RosterView = (typeof ROSTER_VIEWS)[number][0] | (typeof WORK_QUEUE_VIEWS)[number][0];

const SERVING_STATE_BY_VIEW: Partial<Record<RosterView, string>> = {
  draft: "inactive",
  live: "live",
  paused: "paused",
  archived: "retired",
};
const WORK_QUEUES: readonly string[] = characterPortfolioWorkQueueSchema.options;

function CharacterRoster({
  actorId = "",
  canReadUnprepared = false,
  canOpenAssets,
  canCreate,
  canOpenProjects,
  canRead,
  permissions,
}: CharacterPortfolioProps) {
  const { t } = useAdminI18n();
  const format = useAdminFormat();
  const [search, setSearch] = useState("");
  const [servingState, setServingState] = useState("");
  const [attention, setAttention] = useState(false);
  const [workQueue, setWorkQueue] = useState<CharacterPortfolioWorkQueue | "">(
    "",
  );
  const [source, setSource] = useState<CharacterPortfolioSource | "">("");
  const [sort, setSort] = useState<CharacterPortfolioSort>(CHARACTER_PORTFOLIO_DEFAULT_SORT);
  // SPEC: 选中绑定具体角色 ID。翻页和筛选都不改变已选集合。
  const [selection, setSelection] = useState<ReadonlyMap<string, CharacterPortfolioItem>>(new Map());
  // SPEC: 已生效的查询与筛选表单草稿分开保存。
  // INTENT: 上面六个 state 直接绑在输入框上，改一个下拉不该触发取数——只有 Apply /
  //         翻页 / 地址栏恢复才更新 applied，也就是 useAuthorityResource 的 query key。
  const [applied, setApplied] = useState<CharacterPortfolioUrlState>(
    () => ({ search: "" }),
  );
  // SPEC: 走过的游标，用来还原"上一页"和当前页码。
  // INTENT: keyset 分页没有 offset，也没有 total——不自己记一份就只能一直往前翻。
  //         任何改查询的动作都清空它（applyQuery 默认参数），否则页码会挂在旧结果上。
  const [cursorStack, setCursorStack] = useState<readonly string[]>([]);
  // SPEC: 地址栏是列表状态的权威；当前 state 对应的 URL 查询记在这里。
  // INTENT: Next 16 同路径只改 query 不重挂载（侧栏点「Characters」就是这样），只在挂载时读
  //         一次地址栏，URL 清空了筛选和分页却还生效。改由 useSearchParams 驱动恢复；
  //         自己 push/replace 写出去的 URL 与这里相同，回流时跳过，免得冲掉搜索框草稿。
  const locationQuery = useSearchParams()?.toString() ?? "";
  const stateQuery = useRef<string | null>(null);
  const portfolioRequestQuery = characterPortfolioRequestParams(applied);
  portfolioRequestQuery.set("includePerformance", "false");
  const portfolioRequestKey = portfolioRequestQuery.toString();

  const portfolio = useAuthorityResource({
    key: portfolioRequestKey,
    enabled: canRead,
    load: useCallback(async () => {
      try {
        return await adminV2Operation("GET /api/v2/admin/characters/portfolio", {
          query: portfolioRequestKey,
        });
      } catch (reason) {
        // INTENT: 一句能读懂的兜底；抛出去让 resource 统一收成 error。
        throw reason instanceof Error ? reason : new Error("Characters could not be loaded");
      }
    }, [portfolioRequestKey]),
  });
  const { refresh } = portfolio;
  useEffect(() => {
    if (!canRead) return;
    const reload = () => { void refresh(); };
    window.addEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, reload);
    return () => window.removeEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, reload);
  }, [canRead, refresh]);
  const items = portfolio.data?.items ?? EMPTY_PORTFOLIO_ITEMS;
  const pageInfo = portfolio.data?.pageInfo ?? EMPTY_PORTFOLIO_PAGE_INFO;
  const asOf = portfolio.data?.asOf ?? null;
  // SPEC: 权威随每页一起下发的可信度声明，跟着数据一起显示。
  // INTENT: 这个响应恒定带一条「毛利在拿到收款权威之前无效」，出现孤儿 Character Project 时
  //         再加一条 severity=error 的「cutover 被阻塞，需人工核对」——此前前端只解构了
  //         items/pageInfo/asOf，两条都被丢掉，运营在这页做下架和资源分配决定时看不到它们。
  const dataQuality = portfolio.data?.dataQuality ?? EMPTY_PORTFOLIO_DATA_QUALITY;
  // 只有与当前任务无关的毛利提示折叠；数据缺失和发布阻塞继续常驻。
  const backgroundQuality = dataQuality.filter((note) => note.code === "character_margin_payment_authority_unavailable" && note.severity !== "error");
  const visibleQuality = dataQuality.filter((note) => !backgroundQuality.includes(note));
  const freshness = portfolio.data?.freshness ?? null;
  const loading = portfolio.loading;
  const error = portfolio.error;

  const applyQuery = useCallback(
    (
      next: CharacterPortfolioUrlState,
      historyMode: "none" | "push" | "replace",
      nextCursorStack: readonly string[] = [],
      preserveSearchDraft = false,
    ) => {
      if (!preserveSearchDraft) setSearch(next.search);
      setServingState(next.servingState ?? "");
      setAttention(next.attention ?? false);
      setWorkQueue(next.workQueue ?? "");
      setSource(next.source ?? "");
      setSort(next.sort ?? CHARACTER_PORTFOLIO_DEFAULT_SORT);
      setApplied(next);
      setCursorStack(nextCursorStack);
      stateQuery.current = characterPortfolioQuery(next);
      if (historyMode !== "none") {
        const locationQuery = stateQuery.current;
        window.history[historyMode === "push" ? "pushState" : "replaceState"](
          { cursorStack: nextCursorStack } satisfies PortfolioHistoryState,
          "",
          `${window.location.pathname}${locationQuery ? `?${locationQuery}` : ""}`,
        );
      }
    },
    [],
  );

  useEffect(() => {
    if (locationQuery === stateQuery.current) return;
    const stack = restoredCursorStack();
    const next = parseCharacterPortfolioUrl(window.location.search);
    // INTENT: 挂载时同步恢复即可——resource 的首轮取数排在 setTimeout(…, 0) 里，
    //         这一句先落地，那一轮就直接带着地址栏里的查询发出去，不会先打一发空查询。
    //         挂载时顺手把地址栏规范化；之后（前进后退、侧栏链接）只跟随，不改写。
    applyQuery(
      stack.length === 0 ? { ...next, cursor: undefined } : next,
      stateQuery.current === null ? "replace" : "none",
      stack,
    );
  }, [applyQuery, locationQuery]);

  function apply(nextCursor?: string, nextCursorStack?: readonly string[]) {
    applyQuery(
      {
        search,
        servingState: servingState || undefined,
        attention: attention || undefined,
        workQueue: workQueue || undefined,
        source: source || undefined,
        sort,
        cursor: nextCursor,
      },
      "push",
      nextCursorStack,
    );
  }

  // INTENT: 排序不进"表单草稿"—— 换排序键会让当前游标失去意义（keyset 分页的游标是排序键
  //         的位置），所以它立即生效并回到第一页，而不是等运营再点一次 Search。
  //         和翻页一样只带已生效的查询：搜索框里没提交的草稿既不跟着生效，也不被清掉。
  function changeSort(next: CharacterPortfolioSort) {
    applyQuery({ ...applied, cursor: undefined, sort: next }, "push", [], true);
  }

  function goToPage(direction: "next" | "previous") {
    // A cursor belongs to the applied query. Typing alone never submits a search.
    if (direction === "next") {
      applyQuery({ ...applied, cursor: pageInfo.endCursor ?? undefined }, "push", [
        ...cursorStack,
        applied.cursor ?? "",
      ], true);
      return;
    }
    const previous = cursorStack.slice(0, -1);
    applyQuery({ ...applied, cursor: cursorStack.at(-1) || undefined }, "push", previous, true);
  }

  const rosterView: RosterView = attention
    ? "attention"
    : workQueue
      ? workQueue
      : servingState === "live"
        ? "live"
        : servingState === "inactive"
          ? "draft"
          : servingState === "paused"
            ? "paused"
            : servingState === "retired"
              ? "archived"
              : "all";
  const viewCounts = portfolio.data?.facets?.viewCounts;

  // SPEC: 视图仍写回同一个 portfolio 查询；工作清单是服务端筛选，不是当前页的客户端过滤。
  // INTENT: 运营先回答「我现在要看哪批角色」，再进入单个角色处理素材或上线动作。
  function changeRosterView(next: RosterView) {
    const nextAttention = next === "attention";
    const nextWorkQueue = WORK_QUEUES.includes(next)
      ? (next as CharacterPortfolioWorkQueue)
      : undefined;
    const nextServingState = SERVING_STATE_BY_VIEW[next];
    setAttention(nextAttention);
    setWorkQueue(nextWorkQueue ?? "");
    setServingState(nextServingState ?? "");
    applyQuery(
      {
        search: applied.search,
        servingState: nextServingState,
        attention: nextAttention || undefined,
        workQueue: nextWorkQueue,
        source: applied.source,
        sort,
      },
      "push",
      [],
      true,
    );
  }
  function changeSource(next: CharacterPortfolioSource | "") {
    applyQuery({ ...applied, cursor: undefined, source: next || undefined }, "push", [], true);
  }
  const toggleSelected = (item: CharacterPortfolioItem) =>
    setSelection((current) => {
      const next = new Map(current);
      if (!next.delete(item.characterId)) next.set(item.characterId, item);
      return next;
    });
  // 选中时存的快照可能已过期；当前页有新数据就用新的，版本号和 Journey 都跟着更新。
  const selectedItems = [...selection.values()].map(
    (item) => items.find((row) => row.characterId === item.characterId) ?? item,
  );
  const canBulk = Boolean(permissions) && actorId !== "";
  const pageAllSelected = items.length > 0 && items.every((item) => selection.has(item.characterId));
  const togglePage = () =>
    setSelection((current) => {
      const next = new Map(current);
      for (const item of items) {
        if (pageAllSelected) next.delete(item.characterId);
        else next.set(item.characterId, item);
      }
      return next;
    });
  const filterForm = (
    <form
      aria-label={t("Search and filter characters")}
      className="grid w-full gap-2 sm:grid-cols-[minmax(14rem,1fr)_auto_auto_auto] sm:items-center"
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
    >
      <label className="relative min-w-0 flex-1">
        <span className="sr-only">{t("Search characters")}</span>
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ad-text-muted)]"
        />
        <input
          aria-label={t("Search characters")}
          className={`${fieldClass} pl-9`}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("Search name, description, or character ID")}
          value={search}
        />
      </label>
      <WorkspaceButton type="submit">{t("Search")}</WorkspaceButton>
      <label className="shrink-0 text-xs font-semibold text-[var(--ad-text-muted)]">
        <span className="sr-only">{t("Source")}</span>
        <select
          aria-label={t("Filter by source")}
          className={fieldClass}
          onChange={(event) => changeSource(event.target.value as CharacterPortfolioSource | "")}
          value={source}
        >
          <option value="">{t("All sources")}</option>
          <option value="official">{t("Official")}</option>
          <option value="user">{t("User-created")}</option>
        </select>
      </label>
      <label className="shrink-0 text-xs font-semibold text-[var(--ad-text-muted)]">
        <span className="sr-only">{t("Sort")}</span>
        <select
          aria-label={t("Sort characters")}
          className={fieldClass}
          onChange={(event) => changeSort(event.target.value as CharacterPortfolioSort)}
          value={sort}
        >
          {CHARACTER_PORTFOLIO_SORTS.map((value) => (
            <option key={value} value={value}>
              {t(CHARACTER_PORTFOLIO_SORT_LABELS[value])}
            </option>
          ))}
        </select>
      </label>
    </form>
  );

  if (!canRead)
    return permissionDenied("character.project.read");
  return (
    <section aria-labelledby="character-list-title">
      <div className="flex flex-col gap-5 border-b border-[var(--ad-border)] pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-3xl font-semibold tracking-[-0.025em]" id="character-list-title">
            {t("Characters")}
          </h2>
          <p className="mt-2 text-sm text-[var(--ad-text-muted)]">
            {t("Manage Character settings, assets, and live operations")}
          </p>
        </div>
        {canCreate ? (
          <Link
            className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-md bg-[var(--ad-ink)] px-5 text-sm font-semibold text-[var(--ad-surface)] hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)]"
            href="/admin/characters/new"
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
            {t("Create Character")}
          </Link>
        ) : null}
      </div>
      {canReadUnprepared ? <UnpreparedCharacters /> : null}
        <div className="mt-4 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div
            aria-label={t("Character operations filters")}
            className="inline-flex w-full shrink-0 overflow-x-auto rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] sm:w-auto xl:w-max"
            role="group"
          >
            {ROSTER_VIEWS.map(([value, label]) => (
              <button
                aria-pressed={rosterView === value}
                className={cn(
                  "min-h-10 shrink-0 border-r border-[var(--ad-border)] px-4 text-sm font-medium last:border-r-0",
                  rosterView === value
                    ? "bg-[var(--ad-ink)] text-[var(--ad-surface)]"
                    : "text-[var(--ad-text-muted)] hover:bg-black/[0.03] hover:text-[var(--ad-ink)]",
                )}
                key={value}
                onClick={() => changeRosterView(value)}
                type="button"
              >
                {t(label)}
                {viewCounts ? <span className="ml-1.5 text-xs opacity-70">{viewCounts[value]}</span> : null}
              </button>
            ))}
          </div>
          <div className="w-full xl:max-w-[46rem]">{filterForm}</div>
        </div>
        <div aria-label={t("Today's work queues")} className="mt-3 flex flex-wrap items-center gap-2" role="group">
          {WORK_QUEUE_VIEWS.map(([value, label]) => {
            const count = viewCounts?.[value];
            return (
              <button
                aria-pressed={rosterView === value}
                className={cn(
                  "min-h-9 rounded-full border px-3 text-xs font-medium",
                  rosterView === value
                    ? "border-[var(--ad-ink)] bg-[var(--ad-ink)] text-[var(--ad-surface)]"
                    : count
                      ? "border-[var(--ad-border)] text-[var(--ad-ink)] hover:bg-black/[0.03]"
                      : "border-[var(--ad-border)] text-[var(--ad-text-muted)] hover:bg-black/[0.03]",
                )}
                key={value}
                onClick={() => changeRosterView(value)}
                type="button"
              >
                {t(label)}
                {count === undefined ? null : <span className="ml-1.5 font-semibold">{count}</span>}
              </button>
            );
          })}
          {canBulk && items.length > 0 ? (
            <label className="ml-auto inline-flex items-center gap-2 text-xs text-[var(--ad-text-muted)]">
              <input checked={pageAllSelected} className="h-4 w-4" onChange={togglePage} type="checkbox" />
              {t("Select this page")}
            </label>
          ) : null}
        </div>
      {error ? (
        <div
          className="mt-5 rounded-lg bg-[var(--ad-red-bg)] p-4 text-sm text-[var(--ad-red-text)]"
          role="alert"
        >
          {error}{" "}
          <button
            className="ml-2 underline"
            onClick={() => void portfolio.refresh()}
            type="button"
          >
            {t("Retry")}
          </button>
        </div>
      ) : null}
      {visibleQuality.length > 0 ? (
        <ul aria-label={t("Data quality")} className="mt-5 grid gap-2">
          {visibleQuality.map((note) => (
            <li
              className={cn(
                "rounded-lg p-4 text-sm",
                note.severity === "error"
                  ? "bg-[var(--ad-red-bg)] text-[var(--ad-red-text)]"
                  : "bg-[var(--ad-yellow-bg)] text-[var(--ad-yellow-text)]",
              )}
              key={note.code}
              role={note.severity === "error" ? "alert" : undefined}
            >
              {t(note.message)}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-6">
        {loading && items.length === 0 ? (
          <div role="status" aria-label={t("Loading characters")} className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 8 }, (_, index) => (
              <div aria-hidden="true" className="overflow-hidden rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]" key={index}>
                <div className="aspect-[6/5] animate-pulse bg-[var(--ad-surface-subtle)]" />
                <div className="space-y-3 p-4"><div className="h-5 w-2/3 animate-pulse rounded bg-[var(--ad-surface-subtle)]" /><div className="h-4 w-1/2 animate-pulse rounded bg-[var(--ad-surface-subtle)]" /></div>
                <div className="h-12 border-t border-[var(--ad-border)]" />
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          error ? null : (
            <CharacterListEmptyState
              onClear={() => applyQuery({ search: "" }, "push")}
              view={characterPortfolioEmptyView(applied)}
            />
          )
        ) : (
          <>
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {items.map((item, index) => (
                <CharacterPortfolioCard
                  canOpenAssets={canOpenAssets}
                  canOpenProject={canOpenProjects}
                  eager={index < 8}
                  item={item}
                  key={item.characterId}
                  onToggleSelected={canBulk ? () => toggleSelected(item) : undefined}
                  selected={selection.has(item.characterId)}
                />
              ))}
            </div>
          </>
        )}
      </div>
      {canBulk && permissions ? (
        <CharacterBulkBar
          actorId={actorId}
          onClear={() => setSelection(new Map())}
          onSettled={() => void refresh()}
          permissions={permissions}
          selected={selectedItems}
        />
      ) : null}
      {backgroundQuality.length > 0 ? <details className="mt-4 text-xs text-[var(--ad-text-muted)]">
        <summary className="cursor-pointer">{t("Data quality")}</summary>
        {backgroundQuality.map((note) => <p className="mt-2" key={note.code}>{t(note.message)}</p>)}
      </details> : null}
      <div className="mt-4">
        <Pagination
          detail={
            asOf
              // 权威说这一页降级了（例如有孤儿 Character Project 行被排除），就别说"数据新鲜"。
              ? freshness === "degraded"
                ? t("Degraded as of {time}", { time: format.dateTime(asOf) })
                : t("Fresh as of {time}", { time: format.dateTime(asOf) })
              : t("Not loaded yet")
          }
          hasNext={Boolean(pageInfo.hasNextPage && pageInfo.endCursor)}
          // 「上一页」走本地走过的游标栈，不是 pageInfo.hasPreviousPage —— portfolio 的反向
          // 游标可能缺席，而缺席只说明这个 operation 还是单向的，不代表运营在第一页。
          hasPrevious={cursorStack.length > 0}
          loading={loading}
          onNext={() => goToPage("next")}
          onPrevious={() => goToPage("previous")}
          page={cursorStack.length + 1}
          pageSize={CHARACTER_PORTFOLIO_PAGE_SIZE}
          rowCount={items.length}
          totalCount={pageInfo.totalCount ?? null}
        />
      </div>
    </section>
  );
}
