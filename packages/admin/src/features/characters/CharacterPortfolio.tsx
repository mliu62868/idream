"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import Link from "next/link";
import { ADMIN_COMMAND_TARGET_READ_PERMISSIONS, type AdminPageInfo, type CharacterLifecycle, type AdminPermissionKey, type CharacterPortfolioItem, type DataQualityIssue } from "@idream/shared/admin";
import { LayoutGrid, List, Plus, Search } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAdminFormat } from "@/components/admin/ui/format";
import { Pagination } from "@/components/admin/ui/Pagination";
import {
  WorkspaceButton,
  fieldClass,
} from "@/features/operations/WorkspaceUi";
import { AdminV2RequestError } from "@/lib/admin-v2-api";
import { adminV2Operation, adminV2OperationAllowed } from "@/lib/admin-v2-operation";
import { useAuthorityResource, usePollingTask, type PollingTask } from "@/lib/authority-resource";
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
  withCharacterRoster,
  type CharacterPortfolioSort,
  type CharacterPortfolioSource,
  type CharacterPortfolioUrlState,
  type CharacterPortfolioWorkQueue,
} from "./portfolio-query";
import { permissionDenied } from "./character-permission-denied";
import { CharacterListEmptyState } from "./CharacterListEmptyState";
import { UnpreparedCharacters } from "./UnpreparedCharacters";
import { CharacterBulkBar } from "./CharacterBulkBar";
import { CharacterFeaturedToggle, FeaturedAuthorityProvider } from "@/features/content-merchandising/CharacterFeaturedToggle";
import { CharacterPerformanceBoard } from "./CharacterPerformanceBoard";
import { CharacterPortfolioCard, characterPortfolioState, characterReleasePackLabel } from "./CharacterPortfolioCard";
import { CharacterBatchImport } from "./CharacterBatchImport";
import { characterCommandFailureMessage, readCharacterCommandStatus, requestCharacterServingCommand } from "./release-command";
import { characterPrimaryActionCopy } from "./character-primary-action-copy";

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
  if (props.mode !== "performance") return <CharacterRoster key={props.actorId} {...props} />;
  const board = (
    <CharacterPerformanceBoard
      canOpenProject={props.canOpenProjects}
      canRead={props.canRead}
      permissions={props.permissions}
      renderRowExtras={props.permissions?.has("content.read")
        ? (item) => item.serving.state === "live" ? (
            <CharacterFeaturedToggle
              canWrite={props.permissions?.has("content.featured.write") ?? false}
              characterId={item.characterId}
              compact
            />
          ) : null
        : undefined}
    />
  );
  // INVARIANT: 读精选需要 content.read；没有就不发必定被拒的请求。
  return props.permissions?.has("content.read")
    ? <FeaturedAuthorityProvider>{board}</FeaturedAuthorityProvider>
    : board;
}

// SPEC: 视图按钮的顺序和文案。计数来自服务端，翻页不影响。
const ROSTER_VIEWS = [
  ["all", "All"],
  ["draft", "Draft"],
  ["live", "Live"],
  ["paused", "Paused"],
  // INTENT: serving=retired 有两种含义：归档草稿（可恢复）与已退役（永久）。分成两个视图。
  ["archived", "Archived drafts"],
  ["retired", "Retired"],
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
type RosterView = (typeof ROSTER_VIEWS)[number][0];
type QueueView = (typeof WORK_QUEUE_VIEWS)[number][0];

const LIFECYCLE_BY_VIEW: Partial<Record<RosterView, CharacterLifecycle>> = {
  draft: "draft",
  live: "live",
  paused: "paused",
  archived: "archived",
  retired: "retired",
};

type PendingServingCommand = {
  commandId: string;
  characterId: string;
  name: string;
  expectedState: "paused" | "live";
};

function RosterServingCommandStatus({ command, canReadCommand, onSettled }: {
  command: PendingServingCommand;
  canReadCommand: boolean;
  onSettled: (command: PendingServingCommand, error: string | null) => void;
}) {
  const { t } = useAdminI18n();
  const failedReads = useRef(0);
  const poll = useCallback<PollingTask>(async (context) => {
    let error: string | null = null;
    try {
      if (canReadCommand) {
        const result = await adminV2Operation("GET /api/v2/admin/commands/:commandId", {
          path: { commandId: command.commandId },
        });
        failedReads.current = 0;
        const reading = readCharacterCommandStatus(result);
        if (reading.state === "failed") error = characterCommandFailureMessage(reading.failure);
        else if (reading.state === "running") return 1500;
      } else {
        // The portfolio grant can confirm the serving state even without command-detail access.
        const result = await adminV2Operation("GET /api/v2/admin/characters/portfolio", {
          query: new URLSearchParams({ search: command.characterId, includePerformance: "false" }),
        });
        failedReads.current = 0;
        const item = result.items.find((row) => row.characterId === command.characterId);
        if (item?.journey.hasActiveCommand) return 1500;
        if (item?.serving.state !== command.expectedState) error = "Could not confirm the requested serving state.";
      }
    } catch (cause) {
      if (context.cancelled) return null;
      const transient = !(cause instanceof AdminV2RequestError) || cause.outcome === "unknown";
      if (transient && ++failedReads.current < 3) return 3000;
      error = cause instanceof Error ? cause.message : "Could not confirm the requested serving state.";
    }
    if (!context.cancelled) onSettled(command, error);
    return null;
  }, [canReadCommand, command, onSettled]);
  usePollingTask(poll, 700);
  return <p className="mt-3 text-sm text-[var(--ad-text-muted)]" role="status">{command.name} · {t("Accepted")}</p>;
}

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
  const [lifecycle, setLifecycle] = useState<CharacterLifecycle | "">("");
  const [attention, setAttention] = useState(false);
  const [workQueue, setWorkQueue] = useState<CharacterPortfolioWorkQueue | "">(
    "",
  );
  const [source, setSource] = useState<CharacterPortfolioSource | "">("");
  const [sort, setSort] = useState<CharacterPortfolioSort>(CHARACTER_PORTFOLIO_DEFAULT_SORT);
  const [layout, setLayout] = useState<"cards" | "table">("cards");
  const [quickBusyId, setQuickBusyId] = useState<string | null>(null);
  const [quickCommands, setQuickCommands] = useState<readonly PendingServingCommand[]>([]);
  const [quickErrors, setQuickErrors] = useState<readonly { characterId: string; name: string; message: string }[]>([]);
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
  }, {
    // Active commands survive navigation. Keep the visible row in sync after a remount or a status read failure.
    pollWhile: ({ data, consecutiveFailures }) => data?.items.some((item) =>
      item.journey.hasActiveCommand && !quickCommands.some((command) => command.characterId === item.characterId)
    ) ? (consecutiveFailures ? 8000 : 4000) : null,
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
      setLifecycle(next.lifecycle ?? "");
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

  useEffect(() => {
    if (search === applied.search) return;
    const timer = window.setTimeout(() => {
      applyQuery({ ...applied, search, cursor: undefined }, "replace", [], true);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [applied, applyQuery, search]);

  function apply(nextCursor?: string, nextCursorStack?: readonly string[]) {
    applyQuery(
      {
        search,
        lifecycle: lifecycle || undefined,
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

  const rosterView = ROSTER_VIEWS.find(([view]) => (LIFECYCLE_BY_VIEW[view] ?? "") === lifecycle)?.[0] ?? "all";
  const queueView = attention ? "attention" : workQueue;
  const viewCounts = portfolio.data?.facets?.viewCounts;
  const rosterQuery = characterPortfolioQuery({ ...applied, cursor: undefined });

  function changeRosterView(next: RosterView) {
    applyQuery({ ...applied, cursor: undefined, lifecycle: LIFECYCLE_BY_VIEW[next] }, "push", [], true);
  }

  function toggleQueue(next: QueueView) {
    const selectedQueue = queueView === next ? undefined : next;
    applyQuery({
      ...applied,
      cursor: undefined,
      attention: selectedQueue === "attention" || undefined,
      workQueue: selectedQueue === "attention" ? undefined : selectedQueue,
    }, "push", [], true);
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
  function settleBulkAction(completedIds: ReadonlySet<string>) {
    if (completedIds.size > 0) {
      setSelection((current) => new Map([...current].filter(([id]) => !completedIds.has(id))));
    }
    void refresh();
  }
  const canBulk = Boolean(permissions) && actorId !== "";
  const canQuickToggleServing = Boolean(
    permissions && adminV2OperationAllowed("POST /api/v2/admin/characters/:id/commands/pause", permissions),
  );
  const canReadServingCommand = Boolean(
    permissions?.has(ADMIN_COMMAND_TARGET_READ_PERMISSIONS.character_serving) &&
    adminV2OperationAllowed("GET /api/v2/admin/commands/:commandId", permissions),
  );
  const settleQuickCommand = useCallback(async (command: PendingServingCommand, message: string | null) => {
    // Refresh the current filters even when this character has moved off the page.
    await refresh();
    setQuickCommands((current) => current.filter((entry) => entry.commandId !== command.commandId));
    if (message) setQuickErrors((current) => [...current, { characterId: command.characterId, name: command.name, message }]);
  }, [refresh]);
  const quickBusy = (characterId: string) =>
    quickBusyId !== null || quickCommands.some((command) => command.characterId === characterId);
  async function quickToggleRowServing(item: CharacterPortfolioItem) {
    if (quickBusy(item.characterId) || !canQuickToggleServing || item.journey.hasActiveCommand) return;
    if (item.serving.state !== "live" && item.serving.state !== "paused") return;
    const action = item.serving.state === "paused" ? "resume" : "pause";
    setQuickBusyId(item.characterId);
    setQuickErrors((current) => current.filter((entry) => entry.characterId !== item.characterId));
    try {
      const { commandId } = await requestCharacterServingCommand({
        characterId: item.characterId,
        action,
        entityVersion: item.serving.version,
        servingState: item.serving.state,
      });
      setQuickCommands((current) => [...current, {
        commandId, characterId: item.characterId, name: item.name,
        expectedState: action === "pause" ? "paused" : "live",
      }]);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Serving action failed";
      setQuickErrors((current) => [...current, { characterId: item.characterId, name: item.name, message }]);
    } finally {
      setQuickBusyId(null);
    }
  }
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
      className="grid w-full gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:items-center"
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
      <WorkspaceButton className="whitespace-nowrap" type="submit">{t("Search")}</WorkspaceButton>
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
          <div className="flex shrink-0 flex-wrap gap-2">
            <CharacterBatchImport onImported={() => void refresh()} />
            <Link
              className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-md bg-[var(--ad-ink)] px-5 text-sm font-semibold text-[var(--ad-surface)] hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)]"
              href="/admin/characters/new"
            >
              <Plus aria-hidden="true" className="h-4 w-4" />
              {t("Create Character")}
            </Link>
          </div>
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
        <div aria-label={t("Work queues")} className="mt-3 flex flex-wrap items-center gap-2" role="group">
          <span className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Work queues")}</span>
          {WORK_QUEUE_VIEWS.filter(([value]) => {
            const primary = value === "attention" || value === "ready_to_publish" || value === "pending_changes" || value === "recent_generation_failed";
            const count = viewCounts?.[value];
            return primary || queueView === value || (count !== undefined && count > 0);
          }).map(([value, label]) => {
            const count = viewCounts?.[value];
            return (
              <button
                aria-pressed={queueView === value}
                className={cn(
                  "min-h-9 rounded-full border px-3 text-xs font-medium",
                  queueView === value
                    ? "border-[var(--ad-ink)] bg-[var(--ad-ink)] text-[var(--ad-surface)]"
                    : count
                      ? "border-[var(--ad-border)] text-[var(--ad-ink)] hover:bg-black/[0.03]"
                      : "border-[var(--ad-border)] text-[var(--ad-text-muted)] hover:bg-black/[0.03]",
                )}
                key={value}
                onClick={() => toggleQueue(value)}
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
          <div
            aria-label={t("Layout view")}
            className={cn("inline-flex rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)]", !(canBulk && items.length > 0) && "ml-auto")}
            role="group"
          >
            <button
              aria-label={t("Card view")}
              aria-pressed={layout === "cards"}
              className={cn(
                "grid min-h-9 min-w-9 place-items-center border-r border-[var(--ad-border)]",
                layout === "cards" ? "bg-[var(--ad-ink)] text-[var(--ad-surface)]" : "text-[var(--ad-text-muted)] hover:text-[var(--ad-ink)]",
              )}
              onClick={() => setLayout("cards")}
              type="button"
            >
              <LayoutGrid aria-hidden="true" className="h-4 w-4" />
            </button>
            <button
              aria-label={t("Table view")}
              aria-pressed={layout === "table"}
              className={cn(
                "grid min-h-9 min-w-9 place-items-center",
                layout === "table" ? "bg-[var(--ad-ink)] text-[var(--ad-surface)]" : "text-[var(--ad-text-muted)] hover:text-[var(--ad-ink)]",
              )}
              onClick={() => setLayout("table")}
              type="button"
            >
              <List aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>
        </div>
      {canBulk && permissions ? (
        <CharacterBulkBar
          actorId={actorId}
          onClear={() => setSelection(new Map())}
          onSettled={settleBulkAction}
          permissions={permissions}
          selected={selectedItems}
          visibleSelectionCount={items.filter((item) => selection.has(item.characterId)).length}
        />
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
      {quickCommands.map((command) => (
        <RosterServingCommandStatus key={command.commandId} command={command} canReadCommand={canReadServingCommand} onSettled={settleQuickCommand} />
      ))}
      {quickErrors.map((entry) => (
        <p key={entry.characterId} className="mt-4 rounded-lg bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]" role="alert">
          {entry.name} · {t(entry.message)}
        </p>
      ))}
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
            {layout === "table" ? (
              <div className="overflow-x-auto rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-[var(--ad-border)] bg-[var(--ad-surface-subtle)] text-xs font-semibold text-[var(--ad-text-muted)]">
                      {canBulk ? <th className="w-10 px-3 py-2.5"><span className="sr-only">{t("Select")}</span></th> : null}
                      <th className="px-3 py-2.5">{t("Name")}</th>
                      <th className="px-3 py-2.5">{t("Status")}</th>
                      <th className="px-3 py-2.5">{t("Image pack")}</th>
                      <th className="px-3 py-2.5">{t("Next step")}</th>
                      <th className="px-3 py-2.5 text-right">{t("Actions")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--ad-border)]">
                    {items.map((item) => {
                      const state = characterPortfolioState(item);
                      const actionCopy = characterPrimaryActionCopy[item.journey.primaryAction.code];
                      const characterHref = withCharacterRoster(`/admin/characters/${encodeURIComponent(item.characterId)}`, rosterQuery);
                      const isLiveOrPaused = item.serving.state === "live" || item.serving.state === "paused";
                      return (
                        <tr className="hover:bg-black/[0.015]" key={item.characterId}>
                          {canBulk ? (
                            <td className="px-3 py-2.5">
                              <input
                                aria-label={t("Select {name}", { name: item.name })}
                                checked={selection.has(item.characterId)}
                                className="h-4 w-4"
                                onChange={() => toggleSelected(item)}
                                type="checkbox"
                              />
                            </td>
                          ) : null}
                          <td className="px-3 py-2.5 font-semibold">
                            {canOpenProjects ? (
                              <Link className="hover:underline" href={characterHref}>{item.name}</Link>
                            ) : item.name}
                          </td>
                          <td className="px-3 py-2.5">
                            <span className={cn("inline-flex rounded-md px-2 py-0.5 text-xs font-semibold", state.badge)}>
                              {t(state.label)}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-xs text-[var(--ad-text-muted)]">
                            {t("Draft {completed}/{total}", {
                              completed: item.journey.assetPack.draft.completed,
                              total: item.journey.assetPack.draft.total,
                            })}
                            {" · "}
                            {t(characterReleasePackLabel(item.serving.state), {
                              completed: item.journey.assetPack.live.completed,
                              total: item.journey.assetPack.live.total,
                            })}
                          </td>
                          <td className="px-3 py-2.5 text-xs">
                            {item.journey.primaryAction.canReadTarget ? (
                              <Link className="font-semibold underline underline-offset-4" href={withCharacterRoster(item.journey.primaryAction.deepLink, rosterQuery)}>
                                {t(actionCopy.label)}
                              </Link>
                            ) : (
                              <span>{t(actionCopy.label)}</span>
                            )}
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            <div className="inline-flex items-center gap-2">
                              {canQuickToggleServing && isLiveOrPaused ? (
                                <button
                                  className="min-h-8 rounded-md border border-[var(--ad-border)] px-2.5 text-xs font-semibold hover:bg-black/[0.03] disabled:opacity-40"
                                  disabled={quickBusy(item.characterId) || item.journey.hasActiveCommand}
                                  onClick={() => void quickToggleRowServing(item)}
                                  type="button"
                                >
                                  {t(item.serving.state === "paused" ? "Resume" : "Pause")}
                                </button>
                              ) : null}
                              {canOpenProjects ? (
                                <Link className="text-xs font-semibold underline underline-offset-4" href={characterHref}>
                                  {t("Open")}
                                </Link>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {items.map((item, index) => (
                  <CharacterPortfolioCard
                    canOpenAssets={canOpenAssets}
                    canOpenProject={canOpenProjects}
                    eager={index < 8}
                    item={item}
                    key={item.characterId}
                    onQuickToggleServing={canQuickToggleServing ? () => void quickToggleRowServing(item) : undefined}
                    onToggleSelected={canBulk ? () => toggleSelected(item) : undefined}
                    quickBusy={quickBusy(item.characterId)}
                    rosterQuery={rosterQuery}
                    selected={selection.has(item.characterId)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
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
