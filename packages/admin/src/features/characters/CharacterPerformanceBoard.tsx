"use client";

import Link from "next/link";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type {
  AdminPermissionKey,
  CharacterPortfolioItem,
  CharacterPortfolioQuery,
  DataQualityIssue,
} from "@idream/shared/admin";
import { useAdminI18n } from "@/components/admin/i18n";
import { useAdminFormat } from "@/components/admin/ui/format";
import { Pagination } from "@/components/admin/ui/Pagination";
import { StatusBadge, WorkspaceButton, fieldClass } from "@/features/operations/WorkspaceUi";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import { adminV2Operation, adminV2OperationAllowed } from "@/lib/admin-v2-operation";
import { useAuthorityResource } from "@/lib/authority-resource";
import { cn } from "@/lib/utils";
import { submitServingCommand } from "./character-bulk-operations";
import { permissionDenied } from "./character-permission-denied";
import {
  CHARACTER_RECOMMENDATION_LABELS,
  CHARACTER_RECOMMENDATION_SENTENCES,
} from "./character-recommendation-copy";
import { percent } from "./character-workspace-format";
import { CharacterOperationsSummaryPanel } from "./CharacterOperationsSummaryPanel";
import { releaseComparisonLabel } from "./PerformancePanel";

const PAGE_SIZE = 25;
const EMPTY_ITEMS: readonly CharacterPortfolioItem[] = [];
const EMPTY_QUALITY: readonly DataQualityIssue[] = [];

type BoardWindow = "7d" | "28d";
type SortField = "impressions" | "chat_starts" | "qce_rate" | "same_character_d7";
type BoardSort = `${SortField}_${"asc" | "desc"}` & CharacterPortfolioQuery["sort"];
type BoardScope = "operating" | "live" | "paused";

const SORT_COLUMNS: ReadonlyArray<readonly [SortField, string]> = [
  ["impressions", "Exposure"],
  ["chat_starts", "Chat starts"],
  ["qce_rate", "QCE"],
  ["same_character_d7", "Same-character D7"],
];

export function characterPerformanceBoardQuery(state: {
  readonly window: BoardWindow;
  readonly sort: BoardSort;
  readonly scope: BoardScope;
  readonly search: string;
  readonly cursor?: string;
}) {
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    includePerformance: "true",
    aggregateOnly: "true",
    performanceWindow: state.window,
    sort: state.sort,
  });
  if (state.scope === "operating") params.set("operating", "true");
  else params.set("servingState", state.scope);
  if (state.search.trim()) params.set("search", state.search.trim());
  if (state.cursor) params.set("cursor", state.cursor);
  return params.toString();
}

// SPEC: 行内漏斗的显示规则：没有证据时说「数据不足」，绝不写 0 或 0%。
export function characterPerformanceRow(item: CharacterPortfolioItem, window: BoardWindow) {
  const summary = item.performance.find(
    (metric) => metric.window === window && metric.placementId === null,
  ) ?? null;
  const usable = summary !== null && summary.qualityState !== "no_data" && summary.qualityState !== "invalid";
  return {
    summary,
    usable,
    comparison: item.changeMarkers.find((marker) => marker.window === window && marker.comparable) ?? null,
    href: item.recommendation?.targetTab
      ? `/admin/characters/${encodeURIComponent(item.characterId)}?tab=${item.recommendation.targetTab}`
      : "/admin/ops/incidents",
  };
}

function FunnelCell({ count, rate, usable }: { count?: number; rate?: number | null; usable: boolean }) {
  const { t } = useAdminI18n();
  const format = useAdminFormat();
  if (!usable) return <td className="px-3 py-2 text-xs text-[var(--ad-text-muted)]">{t("Insufficient data")}</td>;
  return (
    <td className="whitespace-nowrap px-3 py-2">
      {count === undefined ? null : <span className="block font-semibold">{format.count(count)}</span>}
      {rate === undefined ? null : (
        <span className={count === undefined ? "block font-semibold" : "block text-xs text-[var(--ad-text-muted)]"}>
          {rate === null ? t("Insufficient data") : percent(rate)}
        </span>
      )}
    </td>
  );
}

export function CharacterPerformanceBoard({
  canOpenProject,
  canRead,
  permissions,
  renderRowExtras,
}: {
  canOpenProject: boolean;
  canRead: boolean;
  permissions?: ReadonlySet<AdminPermissionKey>;
  /** Mount point for per-row actions owned elsewhere, such as adding to a featured list. */
  renderRowExtras?: (item: CharacterPortfolioItem) => ReactNode;
}) {
  const { t } = useAdminI18n();
  const format = useAdminFormat();
  const [window, setWindow] = useState<BoardWindow>("28d");
  const [sort, setSort] = useState<BoardSort>("qce_rate_desc");
  const [scope, setScope] = useState<BoardScope>("operating");
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();
  const [cursorStack, setCursorStack] = useState<readonly (string | undefined)[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, string>>>({});
  const canManageAvailability = permissions
    ? adminV2OperationAllowed("POST /api/v2/admin/characters/:id/commands/pause", permissions)
    : false;
  const key = characterPerformanceBoardQuery({ window, sort, scope, search, cursor });
  const resource = useAuthorityResource({
    key,
    enabled: canRead,
    load: useCallback(
      () => adminV2Operation("GET /api/v2/admin/characters/portfolio", { query: key }),
      [key],
    ),
  });
  const { refresh } = resource;
  useEffect(() => {
    if (!canRead) return;
    const reload = () => { void refresh(); };
    globalThis.addEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, reload);
    return () => globalThis.removeEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, reload);
  }, [canRead, refresh]);
  const items = resource.data?.items ?? EMPTY_ITEMS;
  const pageInfo = resource.data?.pageInfo;
  const quality = resource.data?.dataQuality ?? EMPTY_QUALITY;
  const platformDecline = items.some((item) => item.recommendation?.reasonCode === "platform_wide_decline");

  const resetPaging = () => {
    setCursor(undefined);
    setCursorStack([]);
  };
  const toggleSort = (field: SortField) => {
    setSort((current) => (current === `${field}_desc` ? `${field}_asc` : `${field}_desc`) as BoardSort);
    resetPaging();
  };
  const toggleAvailability = async (item: CharacterPortfolioItem) => {
    setBusyId(item.characterId);
    setRowErrors((current) => {
      const next = { ...current };
      delete next[item.characterId];
      return next;
    });
    try {
      await submitServingCommand({
        characterId: item.characterId,
        action: item.serving.state === "paused" ? "resume" : "pause",
        entityVersion: item.serving.version,
      });
    } catch (cause) {
      setRowErrors((current) => ({
        ...current,
        [item.characterId]: cause instanceof Error ? cause.message : "This action failed.",
      }));
    } finally {
      setBusyId(null);
      void refresh();
    }
  };

  if (!canRead) return permissionDenied("character.performance.read");
  return (
    <section aria-labelledby="character-list-title">
      <div className="border-b border-[var(--ad-border)] pb-6">
        <h2 className="mt-1 text-2xl font-semibold" id="character-list-title">{t("Character Performance")}</h2>
        <p className="mt-2 max-w-2xl text-sm text-[var(--ad-text-muted)]">
          {t("Compare live and paused characters on one funnel. Recommendations are only suggestions and never run by themselves.")}
        </p>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div aria-label={t("Performance window")} className="inline-flex rounded-md border border-[var(--ad-border)]" role="group">
          {(["7d", "28d"] as const).map((value) => (
            <button
              aria-pressed={window === value}
              className={cn(
                "min-h-10 px-4 text-sm font-medium",
                window === value ? "bg-[var(--ad-ink)] text-[var(--ad-surface)]" : "text-[var(--ad-text-muted)]",
              )}
              key={value}
              onClick={() => { setWindow(value); resetPaging(); }}
              type="button"
            >
              {value}
            </button>
          ))}
        </div>
        <label>
          <span className="sr-only">{t("Serving scope")}</span>
          <select
            aria-label={t("Serving scope")}
            className={fieldClass}
            onChange={(event) => { setScope(event.target.value as BoardScope); resetPaging(); }}
            value={scope}
          >
            <option value="operating">{t("Live and paused")}</option>
            <option value="live">{t("Live")}</option>
            <option value="paused">{t("Paused")}</option>
          </select>
        </label>
        <form
          aria-label={t("Search and filter characters")}
          className="flex min-w-60 flex-1 gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(searchDraft);
            resetPaging();
          }}
        >
          <input
            aria-label={t("Search characters")}
            className={fieldClass}
            onChange={(event) => setSearchDraft(event.target.value)}
            placeholder={t("Search name, description, or character ID")}
            value={searchDraft}
          />
          <WorkspaceButton type="submit">{t("Search")}</WorkspaceButton>
        </form>
      </div>
      {resource.error ? (
        <div className="mt-5 rounded-lg bg-[var(--ad-red-bg)] p-4 text-sm text-[var(--ad-red-text)]" role="alert">
          {resource.error}{" "}
          <button className="ml-2 underline" onClick={() => void refresh()} type="button">{t("Retry")}</button>
        </div>
      ) : null}
      {platformDecline ? (
        <p className="mt-4 rounded-lg bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)]" role="status">
          {t("Most characters fell in the same period. This may be a platform issue.")}{" "}
          <Link className="font-semibold underline" href="/admin/ops/incidents">{t("Open Incidents")}</Link>
        </p>
      ) : null}
      {quality.length > 0 ? (
        <ul aria-label={t("Data quality")} className="mt-4 grid gap-2">
          {quality.map((note) => (
            <li
              className={cn(
                "rounded-lg p-3 text-sm",
                note.severity === "error"
                  ? "bg-[var(--ad-red-bg)] text-[var(--ad-red-text)]"
                  : "bg-[var(--ad-yellow-bg)] text-[var(--ad-yellow-text)]",
              )}
              key={note.code}
            >
              {t(note.message)}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-5 overflow-x-auto rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
        {resource.loading && items.length === 0 ? (
          <div aria-label={t("Loading release-attributed portfolio")} className="p-6 text-sm text-[var(--ad-text-muted)]" role="status">
            {t("Loading release-attributed portfolio")}
          </div>
        ) : items.length === 0 ? (
          resource.error ? null : (
            <p className="p-6 text-sm text-[var(--ad-text-muted)]">{t("No live or paused characters match.")}</p>
          )
        ) : (
          <table className="w-full min-w-[60rem] text-left text-sm">
            <thead className="border-b border-[var(--ad-border)] text-xs text-[var(--ad-text-muted)]">
              <tr>
                <th className="px-3 py-2 font-medium" scope="col">{t("Character")}</th>
                {SORT_COLUMNS.slice(0, 1).map(([field, label]) => (
                  <SortHeader field={field} key={field} label={label} onToggle={toggleSort} sort={sort} />
                ))}
                <th className="px-3 py-2 font-medium" scope="col">{t("Detail views")}</th>
                {SORT_COLUMNS.slice(1).map(([field, label]) => (
                  <SortHeader field={field} key={field} label={label} onToggle={toggleSort} sort={sort} />
                ))}
                <th className="px-3 py-2 font-medium" scope="col">{t("Margin")}</th>
                <th className="px-3 py-2 font-medium" scope="col">{t("vs previous Release")}</th>
                <th className="px-3 py-2 font-medium" scope="col">{t("Suggestion")}</th>
                <th className="px-3 py-2 font-medium" scope="col"><span className="sr-only">{t("Actions")}</span></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const row = characterPerformanceRow(item, window);
                const { summary, usable } = row;
                const release = item.currentRelease;
                return (
                  <tr className="border-b border-[var(--ad-border)] align-top last:border-b-0" key={item.characterId}>
                    <th className="px-3 py-2 font-normal" scope="row">
                      {canOpenProject ? (
                        <Link className="font-semibold hover:underline" href={`/admin/characters/${encodeURIComponent(item.characterId)}?tab=monitor`}>
                          {item.name}
                        </Link>
                      ) : <span className="font-semibold">{item.name}</span>}
                      <span className="mt-1 flex flex-wrap items-center gap-1">
                        <StatusBadge value={item.serving.state} />
                        {summary?.qualityState === "directional" ? <StatusBadge tone="neutral" value="Directional" /> : null}
                        {summary?.qualityState === "invalid" ? <StatusBadge value="invalid" /> : null}
                      </span>
                      {release ? (
                        <span className="mt-1 block text-xs text-[var(--ad-text-muted)]" title={release.id}>
                          {t("Serving Release from {date}", { date: format.date(release.publishedAt ?? release.createdAt) })}
                        </span>
                      ) : null}
                    </th>
                    <FunnelCell count={summary?.eligibleImpressions} usable={usable} />
                    <FunnelCell count={summary?.detailViews} rate={summary?.detailCtr} usable={usable} />
                    <FunnelCell count={summary?.firstSuccessfulExchanges} rate={summary?.chatStartRate} usable={usable} />
                    <FunnelCell count={summary?.qceCount} rate={summary?.qceRate} usable={usable} />
                    <FunnelCell rate={summary?.sameCharacterD7} usable={usable} />
                    <td className="px-3 py-2 text-xs text-[var(--ad-text-muted)]">
                      {summary?.contributionMargin.valueMicros == null
                        ? t("Unavailable")
                        : format.count(summary.contributionMargin.valueMicros)}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {row.comparison ? (
                        <>
                          {releaseComparisonLabel(row.comparison)}
                          {row.comparison.comparisonQuality === "directional" ? (
                            <span className="block text-[var(--ad-text-muted)]">{t("Directional")}</span>
                          ) : null}
                        </>
                      ) : (
                        <span className="text-[var(--ad-text-muted)]">{t("Insufficient data")}</span>
                      )}
                    </td>
                    <td className="max-w-72 px-3 py-2 text-xs">
                      {item.recommendation ? (
                        <>
                          <strong className="block text-sm">{t(CHARACTER_RECOMMENDATION_LABELS[item.recommendation.recommendation])}</strong>
                          <span className="text-[var(--ad-text-muted)]">{t(CHARACTER_RECOMMENDATION_SENTENCES[item.recommendation.reasonCode])}</span>
                          {item.recommendation.recommendation !== "insufficient_data" && canOpenProject ? (
                            <Link className="mt-1 block font-semibold underline-offset-4 hover:underline" href={row.href}>
                              {t("Open")}
                            </Link>
                          ) : null}
                        </>
                      ) : <span className="text-[var(--ad-text-muted)]">{t("Insufficient data")}</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <div className="flex flex-col items-start gap-1">
                        {canManageAvailability ? (
                          <WorkspaceButton
                            disabled={busyId !== null}
                            onClick={() => void toggleAvailability(item)}
                          >
                            {t(item.serving.state === "paused" ? "Resume" : "Pause")}
                          </WorkspaceButton>
                        ) : null}
                        {renderRowExtras?.(item)}
                        {rowErrors[item.characterId] ? (
                          <span className="text-xs text-[var(--ad-red-text)]" role="alert">{t(rowErrors[item.characterId])}</span>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <div className="mt-4">
        <Pagination
          detail={resource.data?.asOf ? t("Fresh as of {time}", { time: format.dateTime(resource.data.asOf) }) : t("Not loaded yet")}
          hasNext={Boolean(pageInfo?.hasNextPage && pageInfo.endCursor)}
          hasPrevious={cursorStack.length > 0}
          loading={resource.loading}
          onNext={() => {
            setCursorStack((stack) => [...stack, cursor]);
            setCursor(pageInfo?.endCursor ?? undefined);
          }}
          onPrevious={() => {
            setCursor(cursorStack.at(-1));
            setCursorStack((stack) => stack.slice(0, -1));
          }}
          page={cursorStack.length + 1}
          pageSize={PAGE_SIZE}
          rowCount={items.length}
          totalCount={pageInfo?.totalCount ?? null}
        />
      </div>
      <CharacterOperationsSummaryPanel canRead={canRead} />
    </section>
  );
}

function SortHeader({
  field,
  label,
  onToggle,
  sort,
}: {
  field: SortField;
  label: string;
  onToggle: (field: SortField) => void;
  sort: BoardSort;
}) {
  const { t } = useAdminI18n();
  const active = sort.startsWith(`${field}_`);
  const descending = sort === `${field}_desc`;
  return (
    <th aria-sort={active ? (descending ? "descending" : "ascending") : "none"} className="px-3 py-2 font-medium" scope="col">
      <button className={cn("inline-flex items-center gap-1 hover:underline", active && "font-semibold text-[var(--ad-ink)]")} onClick={() => onToggle(field)} type="button">
        {t(label)}
        {active ? (descending ? <ArrowDown aria-hidden="true" className="h-3 w-3" /> : <ArrowUp aria-hidden="true" className="h-3 w-3" />) : null}
      </button>
    </th>
  );
}

