"use client";

import { adminDateLocale, useAdminI18n } from "@/components/admin/i18n";
import Link from "next/link";
import type { CharacterPortfolioItem } from "@idream/shared/admin";
import { Plus, Search, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  LoadingWorkspace,
  WorkspaceButton,
  fieldClass,
} from "@/features/operations/WorkspaceUi";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import { useAuthorityResource } from "@/lib/authority-resource";
import { cn } from "@/lib/utils";
import {
  CHARACTER_PORTFOLIO_PHASES,
  CHARACTER_PORTFOLIO_READINESS_STATES,
  CHARACTER_PORTFOLIO_SERVING_STATES,
  characterPortfolioQuery,
  parseCharacterPortfolioUrl,
  type CharacterPortfolioUrlState,
} from "./portfolio-query";
import { permissionDenied } from "./character-permission-denied";
import { CharacterListEmptyState } from "./CharacterListEmptyState";
import { CharacterPortfolioCard } from "./CharacterPortfolioCard";

// INTENT: 稳定引用，避免"投影还没到"时每次渲染都换一个新的空值。
const EMPTY_PORTFOLIO_ITEMS: readonly CharacterPortfolioItem[] = [];
const EMPTY_PORTFOLIO_PAGE_INFO = {
  endCursor: null,
  hasNextPage: false,
} as const;

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
  const { locale, t } = useAdminI18n();
  const performanceMode = mode === "performance";
  const [search, setSearch] = useState("");
  const [phase, setPhase] = useState("");
  const [servingState, setServingState] = useState("");
  const [readiness, setReadiness] = useState("");
  const [attention, setAttention] = useState(false);
  // SPEC: 已生效的查询与筛选表单草稿分开保存。
  // INTENT: 上面六个 state 直接绑在输入框上，改一个下拉不该触发取数——只有 Apply /
  //         翻页 / 地址栏恢复才更新 applied，也就是 useAuthorityResource 的 query key。
  const [applied, setApplied] = useState<CharacterPortfolioUrlState>(
    () => ({ search: "" }),
  );

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
    ) => {
      setSearch(next.search);
      setPhase(next.phase ?? "");
      setServingState(next.servingState ?? "");
      setReadiness(next.readiness ?? "");
      setAttention(next.attention ?? false);
      setApplied(next);
      if (historyMode !== "none") {
        const locationQuery = characterPortfolioQuery(next);
        window.history[historyMode === "push" ? "pushState" : "replaceState"](
          null,
          "",
          `${window.location.pathname}${locationQuery ? `?${locationQuery}` : ""}`,
        );
      }
    },
    [],
  );

  useEffect(() => {
    const restore = (historyMode: "none" | "replace") => {
      applyQuery(parseCharacterPortfolioUrl(window.location.search), historyMode);
    };
    // INTENT: 挂载时同步恢复即可——resource 的首轮取数排在 setTimeout(…, 0) 里，
    //         这一句先落地，那一轮就直接带着地址栏里的查询发出去，不会先打一发空查询。
    restore("replace");
    const onPopState = () => restore("none");
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [applyQuery]);

  function apply(nextCursor?: string) {
    applyQuery(
      {
        search,
        phase: phase || undefined,
        servingState: servingState || undefined,
        readiness: readiness || undefined,
        attention: attention || undefined,
        cursor: nextCursor,
      },
      "push",
    );
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
      },
      "push",
    );
  }

  function clearStatusFilters() {
    applyQuery({ search, attention: attention || undefined }, "push");
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
      {performanceMode ? (
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
      ) : null}
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
            {!performanceMode ? (
              <p className="mb-5 text-sm text-[var(--ad-text-muted)]">
                {t("{count} characters", { count: items.length })}
              </p>
            ) : null}
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
      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-xs text-[var(--ad-text-muted)]">
          {asOf
            ? t("Fresh as of {time}", {
                time: new Date(asOf).toLocaleString(adminDateLocale(locale)),
              })
            : t("Not loaded yet")}
        </p>
        <WorkspaceButton
          disabled={loading || !pageInfo.hasNextPage || !pageInfo.endCursor}
          onClick={() => apply(pageInfo.endCursor ?? undefined)}
        >
          {t("Next page")}
        </WorkspaceButton>
      </div>
    </section>
  );
}
