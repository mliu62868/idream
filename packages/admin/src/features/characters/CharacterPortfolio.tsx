"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import Link from "next/link";
import type { AdminPageInfo, CharacterPortfolioItem } from "@idream/shared/admin";
import { Plus, Search, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAdminFormat } from "@/components/admin/ui/format";
import { Pagination } from "@/components/admin/ui/Pagination";
import {
  LoadingWorkspace,
  WorkspaceButton,
  fieldClass,
} from "@/features/operations/WorkspaceUi";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import { useAuthorityResource } from "@/lib/authority-resource";
import { cn } from "@/lib/utils";
import {
  CHARACTER_PORTFOLIO_DEFAULT_SORT,
  CHARACTER_PORTFOLIO_PAGE_SIZE,
  CHARACTER_PORTFOLIO_PHASES,
  CHARACTER_PORTFOLIO_READINESS_STATES,
  CHARACTER_PORTFOLIO_SERVING_STATES,
  CHARACTER_PORTFOLIO_SORT_LABELS,
  CHARACTER_PORTFOLIO_SORTS,
  characterPortfolioQuery,
  parseCharacterPortfolioUrl,
  type CharacterPortfolioSort,
  type CharacterPortfolioUrlState,
} from "./portfolio-query";
import { permissionDenied } from "./character-permission-denied";
import { CharacterListEmptyState } from "./CharacterListEmptyState";
import { CharacterPortfolioCard } from "./CharacterPortfolioCard";

// INTENT: 稳定引用，避免"投影还没到"时每次渲染都换一个新的空值。
const EMPTY_PORTFOLIO_ITEMS: readonly CharacterPortfolioItem[] = [];
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

export function CharacterPortfolio({
  canOpenAssets,
  canCreate,
  canOpenProjects,
  canRead,
  mode,
}: {
  canOpenAssets: boolean;
  canCreate: boolean;
  canOpenProjects: boolean;
  canRead: boolean;
  mode: "studio" | "performance";
}) {
  const { t } = useAdminI18n();
  const format = useAdminFormat();
  const performanceMode = mode === "performance";
  const [search, setSearch] = useState("");
  const [phase, setPhase] = useState("");
  const [servingState, setServingState] = useState("");
  const [readiness, setReadiness] = useState("");
  const [attention, setAttention] = useState(false);
  const [sort, setSort] = useState<CharacterPortfolioSort>(CHARACTER_PORTFOLIO_DEFAULT_SORT);
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

  const portfolio = useAuthorityResource({
    key: characterPortfolioQuery(applied, true),
    enabled: canRead,
    load: useCallback(async () => {
      try {
        return await adminV2Operation("GET /api/v2/admin/characters/portfolio", {
          query: characterPortfolioQuery(applied, true),
        });
      } catch (reason) {
        // INTENT: 两种模式各有一句能读懂的兜底；抛出去让 resource 统一收成 error。
        throw reason instanceof Error ? reason : new Error(
          performanceMode
            ? "Character portfolio could not be loaded"
            : "Characters could not be loaded",
        );
      }
    }, [applied, performanceMode]),
  });
  const items = portfolio.data?.items ?? EMPTY_PORTFOLIO_ITEMS;
  const pageInfo = portfolio.data?.pageInfo ?? EMPTY_PORTFOLIO_PAGE_INFO;
  const asOf = portfolio.data?.asOf ?? null;
  const loading = portfolio.loading;
  const error = portfolio.error;

  const applyQuery = useCallback(
    (
      next: CharacterPortfolioUrlState,
      historyMode: "none" | "push" | "replace",
      nextCursorStack: readonly string[] = [],
    ) => {
      setSearch(next.search);
      setPhase(next.phase ?? "");
      setServingState(next.servingState ?? "");
      setReadiness(next.readiness ?? "");
      setAttention(next.attention ?? false);
      setSort(next.sort ?? CHARACTER_PORTFOLIO_DEFAULT_SORT);
      setApplied(next);
      setCursorStack(nextCursorStack);
      if (historyMode !== "none") {
        const locationQuery = characterPortfolioQuery(next);
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
    const restore = (historyMode: "none" | "replace") => {
      const stack = restoredCursorStack();
      const next = parseCharacterPortfolioUrl(window.location.search);
      applyQuery(stack.length === 0 ? { ...next, cursor: undefined } : next, historyMode, stack);
    };
    // INTENT: 挂载时同步恢复即可——resource 的首轮取数排在 setTimeout(…, 0) 里，
    //         这一句先落地，那一轮就直接带着地址栏里的查询发出去，不会先打一发空查询。
    restore("replace");
    const onPopState = () => restore("none");
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [applyQuery]);

  function apply(nextCursor?: string, nextCursorStack?: readonly string[]) {
    applyQuery(
      {
        search,
        phase: phase || undefined,
        servingState: servingState || undefined,
        readiness: readiness || undefined,
        attention: attention || undefined,
        sort,
        cursor: nextCursor,
      },
      "push",
      nextCursorStack,
    );
  }

  // INTENT: 排序不进"表单草稿"—— 换排序键会让当前游标失去意义（keyset 分页的游标是排序键
  //         的位置），所以它立即生效并回到第一页，而不是等运营再点一次 Search。
  function changeSort(next: CharacterPortfolioSort) {
    setSort(next);
    applyQuery(
      {
        search,
        phase: phase || undefined,
        servingState: servingState || undefined,
        readiness: readiness || undefined,
        attention: attention || undefined,
        sort: next,
      },
      "push",
    );
  }

  function goToPage(direction: "next" | "previous") {
    if (direction === "next") {
      apply(pageInfo.endCursor ?? undefined, [
        ...cursorStack,
        applied.cursor ?? "",
      ]);
      return;
    }
    const previous = cursorStack.slice(0, -1);
    apply(cursorStack.at(-1) || undefined, previous);
  }

  const activeStatusFilterCount = [phase, servingState, readiness].filter(
    Boolean,
  ).length;

  // INTENT: 「需要处理」是发现入口，不是第四个下拉——藏进 More filters 折叠等于没人会用。
  function toggleAttention() {
    const next = !attention;
    applyQuery(
      {
        search,
        phase: phase || undefined,
        servingState: servingState || undefined,
        readiness: readiness || undefined,
        attention: next || undefined,
        sort,
      },
      "push",
    );
  }

  function clearStatusFilters() {
    applyQuery({ search, attention: attention || undefined, sort }, "push");
  }

  const statusFilterControls = (
    <div className="grid gap-3 p-3 sm:grid-cols-3">
      <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
        {t("Character stage")}
        <select
          aria-label={t("Filter by character stage")}
          className={`${fieldClass} mt-1`}
          onChange={(event) => setPhase(event.target.value)}
          value={phase}
        >
          <option value="">{t("All phases")}</option>
          {CHARACTER_PORTFOLIO_PHASES.map((value) => (
            <option key={value} value={value}>
              {t(value.replaceAll("_", " "))}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
        {t("Serving state")}
        <select
          aria-label={t("Filter by serving state")}
          className={`${fieldClass} mt-1`}
          onChange={(event) => setServingState(event.target.value)}
          value={servingState}
        >
          <option value="">{t("All serving states")}</option>
          {CHARACTER_PORTFOLIO_SERVING_STATES.map((value) => (
            <option key={value} value={value}>
              {t(value.replaceAll("_", " "))}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
        {t("Readiness")}
        <select
          aria-label={t("Filter by readiness")}
          className={`${fieldClass} mt-1`}
          onChange={(event) => setReadiness(event.target.value)}
          value={readiness}
        >
          <option value="">{t("All readiness")}</option>
          {CHARACTER_PORTFOLIO_READINESS_STATES.map((value) => (
            <option key={value} value={value}>
              {t(value.replaceAll("_", " "))}
            </option>
          ))}
        </select>
      </label>
      {activeStatusFilterCount > 0 ? (
        <button
          className="min-h-11 text-left text-xs font-semibold underline sm:col-span-3"
          onClick={clearStatusFilters}
          type="button"
        >
          {t("Clear status filters")}
        </button>
      ) : null}
    </div>
  );
  const filterForm = (
    <form
      aria-label={t("Search and filter characters")}
      className="relative z-20 flex w-full flex-col gap-2 sm:flex-row sm:items-center"
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
          placeholder={t("Search name or character ID")}
          value={search}
        />
      </label>
      <WorkspaceButton type="submit">{t("Search")}</WorkspaceButton>
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
      {/* INTENT: 「需要处理」两种模式都要给。之前只在 performance 模式渲染，
          studio 的运营只能手敲 ?attention=true —— URL 解析和空态一直都支持它。 */}
      <button
        aria-pressed={attention}
        className={cn(
          "min-h-11 shrink-0 rounded-lg border px-3 text-sm font-semibold",
          attention
            ? "border-[var(--ad-ink)] bg-[var(--ad-ink)] text-white"
            : "border-[var(--ad-border)] text-[var(--ad-ink)]",
        )}
        onClick={toggleAttention}
        type="button"
      >
        {t("Needs attention")}
      </button>
      <details className="group shrink-0 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-sm font-semibold">
          <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
          <span>{t("Filters")}</span>
          {activeStatusFilterCount > 0 ? (
            <span>({activeStatusFilterCount})</span>
          ) : null}
        </summary>
        <div className="absolute right-0 top-full mt-1 w-[min(680px,calc(100vw-2rem))] rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] shadow-[var(--ad-shadow-hover)]">
          {statusFilterControls}
        </div>
      </details>
    </form>
  );

  if (!canRead)
    return permissionDenied(
      mode === "performance"
        ? "character.performance.read"
        : "character.project.read",
    );
  return (
    <section aria-labelledby="character-list-title">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        {performanceMode ? (
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ad-text-muted)]">
              {t("Growth")}
            </p>
            <h2
              className="mt-1 text-2xl font-semibold"
              id="character-list-title"
            >
              {t("Character Performance")}
            </h2>
            <p className="mt-2 max-w-2xl text-sm text-[var(--ad-text-muted)]">
              {t(
                "Compare release-attributed value, maturity, and portfolio decisions without expanding Project authority.",
              )}
            </p>
          </div>
        ) : (
          <h2 className="sr-only" id="character-list-title">
            {t("Characters")}
          </h2>
        )}
        {!performanceMode ? (
          <div className="ml-auto flex w-full max-w-3xl flex-col gap-2 sm:flex-row sm:items-start">
            <div className="min-w-0 flex-1">{filterForm}</div>
            {canCreate ? (
              <Link
                className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-[var(--ad-surface)] hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)]"
                href="/admin/characters/new"
              >
                <Plus aria-hidden="true" className="h-4 w-4" />
                {t("Create Character")}
              </Link>
            ) : null}
          </div>
        ) : null}
      </div>
      {performanceMode ? (
        <div className="mt-4 flex justify-end">{filterForm}</div>
      ) : null}
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
      <div className="mt-4">
        {loading && items.length === 0 ? (
          <LoadingWorkspace
            label={
              performanceMode
                ? "Loading release-attributed portfolio"
                : "Loading characters"
            }
          />
        ) : items.length === 0 ? (
          error ? null : (
            <CharacterListEmptyState
              attentionOnly={attention}
              filtered={Boolean(
                search || phase || servingState || readiness || attention,
              )}
              onClear={() => applyQuery({ search: "" }, "push")}
            />
          )
        ) : (
          <>
            <div
              className={
                performanceMode
                  ? "grid gap-3"
                  : "grid gap-x-7 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
              }
            >
              {items.map((item, index) => (
                <CharacterPortfolioCard
                  canOpenAssets={canOpenAssets}
                  canOpenProject={canOpenProjects}
                  eager={index < (performanceMode ? 1 : 4)}
                  item={item}
                  key={item.characterId}
                  mode={mode}
                />
              ))}
            </div>
          </>
        )}
      </div>
      <div className="mt-4">
        <Pagination
          detail={
            asOf
              ? t("Fresh as of {time}", { time: format.dateTime(asOf) })
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
