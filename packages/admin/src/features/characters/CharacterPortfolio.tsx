"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import Link from "next/link";
import type { AdminPageInfo, CharacterPortfolioItem } from "@idream/shared/admin";
import { Plus, Search } from "lucide-react";
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
  CHARACTER_PORTFOLIO_SORT_LABELS,
  CHARACTER_PORTFOLIO_SORTS,
  characterPortfolioEmptyView,
  characterPortfolioQuery,
  parseCharacterPortfolioUrl,
  type CharacterPortfolioSort,
  type CharacterPortfolioUrlState,
  type CharacterPortfolioWorkQueue,
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
  const [servingState, setServingState] = useState("");
  const [readiness, setReadiness] = useState("");
  const [attention, setAttention] = useState(false);
  const [workQueue, setWorkQueue] = useState<CharacterPortfolioWorkQueue | "">(
    "",
  );
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
      setServingState(next.servingState ?? "");
      setReadiness(next.readiness ?? "");
      setAttention(next.attention ?? false);
      setWorkQueue(next.workQueue ?? "");
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
        servingState: servingState || undefined,
        readiness: readiness || undefined,
        attention: attention || undefined,
        workQueue: workQueue || undefined,
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
        servingState: servingState || undefined,
        readiness: readiness || undefined,
        attention: attention || undefined,
        workQueue: workQueue || undefined,
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

  const rosterView = attention
    ? "attention"
    : workQueue === "live_asset_pack_incomplete"
      ? "image_pack"
    : servingState === "live"
      ? "live"
      : servingState === "inactive"
        ? "draft"
        : "all";

  // SPEC: 视图仍写回同一个 portfolio 查询；Image packs 是服务端工作清单，不是当前页的客户端过滤。
  // INTENT: 运营先回答「我现在要看哪批角色」，再进入单个角色处理素材或上线动作。
  function changeRosterView(
    next: "all" | "draft" | "live" | "attention" | "image_pack",
  ) {
    const nextAttention = next === "attention";
    const nextWorkQueue =
      next === "image_pack" ? "live_asset_pack_incomplete" : undefined;
    const nextServingState = next === "draft" ? "inactive" : next === "live" ? "live" : undefined;
    setAttention(nextAttention);
    setWorkQueue(nextWorkQueue ?? "");
    setServingState(nextServingState ?? "");
    setReadiness("");
    applyQuery(
      {
        search,
        servingState: nextServingState,
        attention: nextAttention || undefined,
        workQueue: nextWorkQueue,
        sort,
      },
      "push",
    );
  }
  const filterForm = (
    <form
      aria-label={t("Search and filter characters")}
      className="grid w-full gap-2 sm:grid-cols-[minmax(14rem,1fr)_auto_auto] sm:items-center"
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
      <div className="flex flex-col gap-5 border-b border-[var(--ad-border)] pb-6 sm:flex-row sm:items-start sm:justify-between">
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
                "Compare release-attributed value and maturity.",
              )}
            </p>
          </div>
        ) : (
          <div>
            <h2 className="text-3xl font-semibold tracking-[-0.025em]" id="character-list-title">
              {t("Characters")}
            </h2>
            <p className="mt-2 text-sm text-[var(--ad-text-muted)]">
              {t("Manage Character settings, assets, and live operations")}
            </p>
          </div>
        )}
        {!performanceMode ? (
          canCreate ? (
              <Link
                className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-md bg-[var(--ad-ink)] px-5 text-sm font-semibold text-[var(--ad-surface)] hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)]"
                href="/admin/characters/new"
              >
                <Plus aria-hidden="true" className="h-4 w-4" />
                {t("Create Character")}
              </Link>
            ) : null
        ) : null}
      </div>
      {performanceMode ? (
        <div className="mt-4 flex flex-col justify-end gap-2 lg:flex-row">
          <div className="w-full lg:max-w-[42rem]">{filterForm}</div>
          <button
            aria-pressed={attention}
            className={cn(
              "min-h-11 shrink-0 rounded-md border px-4 text-sm font-semibold",
              attention
                ? "border-[var(--ad-ink)] bg-[var(--ad-ink)] text-[var(--ad-surface)]"
                : "border-[var(--ad-border)] bg-[var(--ad-surface)] text-[var(--ad-ink)]",
            )}
            onClick={() => changeRosterView(attention ? "all" : "attention")}
            type="button"
          >
            {t("Needs attention")}
          </button>
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div
            aria-label={t("Character operations filters")}
            className="inline-flex w-full shrink-0 overflow-x-auto rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] sm:w-auto xl:w-max"
            role="group"
          >
            {([
              ["all", "All"],
              ["draft", "Draft"],
              ["live", "Live"],
              ["image_pack", "Incomplete packs"],
              ["attention", "Needs attention"],
            ] as const).map(([value, label]) => (
              <button
                aria-pressed={rosterView === value}
                className={cn(
                  "min-h-10 shrink-0 border-r border-[var(--ad-border)] px-5 text-sm font-medium last:border-r-0",
                  rosterView === value
                    ? "bg-[var(--ad-ink)] text-[var(--ad-surface)]"
                    : "text-[var(--ad-text-muted)] hover:bg-black/[0.03] hover:text-[var(--ad-ink)]",
                )}
                key={value}
                onClick={() => changeRosterView(value)}
                type="button"
              >
                {t(label)}
              </button>
            ))}
          </div>
          <div className="w-full xl:max-w-[42rem]">{filterForm}</div>
        </div>
      )}
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
      <div className="mt-6">
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
              onClear={() => applyQuery({ search: "" }, "push")}
              view={characterPortfolioEmptyView({
                search,
                servingState: servingState || undefined,
                readiness: readiness || undefined,
                attention: attention || undefined,
                workQueue: workQueue || undefined,
              })}
            />
          )
        ) : (
          <>
            <div
              className={
                performanceMode
                  ? "grid gap-3"
                  : "grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
              }
            >
              {items.map((item, index) => (
                <CharacterPortfolioCard
                  canOpenAssets={canOpenAssets}
                  canOpenProject={canOpenProjects}
                  eager={index < (performanceMode ? 1 : 8)}
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
