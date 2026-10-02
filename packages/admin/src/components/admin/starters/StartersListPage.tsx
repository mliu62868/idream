"use client";
import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { apiGet } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { FilterBar } from "@/components/admin/ui/FilterBar";
import { StatusPill } from "@/components/admin/ui/StatusPill";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { Pagination } from "@/components/admin/ui/Pagination";
import { PrimaryButton } from "@/components/admin/ui/buttons";
import { PermissionNotice } from "@/components/admin/ui/PermissionNotice";
import { LoadingWorkspace } from "@/features/operations/WorkspaceUi";
import type { AdminPageInfo } from "@idream/shared/admin";
import {
  authorityRequestFailed,
  authorityRequestStarted,
  authorityRequestSucceeded,
  createAuthorityState,
} from "@/lib/authority-state";
import { createLatestRequestGate } from "@/lib/latest-request";
import {
  previousListPage,
  listPageFromParams,
  requestErrorMessage,
  syncListUrl,
  useDebouncedReload,
  useUrlBootstrap,
} from "@/components/admin/section-kit";
import { SCOPES, STARTERS_LIST, type Starter } from "./starters-api";

type StartersResponse = { items: Starter[]; pageInfo: AdminPageInfo };

const PAGE_SIZE = 25;

// SPEC: 角色模板列表页 —— 搜索/筛选 + 卡片网格（无图 monogram、范围·排序·标签数、上/下线状态）。
// INTENT: 浏览页只浏览；创建在 /new，详情在 /<id>（spec §7 列表页）。
export function StartersListPage({ canWrite }: { canWrite: boolean }) {
  const { t, value } = useAdminI18n();
  const [authority, setAuthority] = useState(() => createAuthorityState<StartersResponse>());
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState("all");
  const [status, setStatus] = useState("all");
  const [cursor, setCursor] = useState<string | undefined>();
  const [page, setPage] = useState(1);
  const [urlRevision, setUrlRevision] = useState(0);
  const requestGate = useRef(createLatestRequestGate());

  const reload = useCallback(async (nextCursor: string | undefined, nextPage: number) => {
    const queryKey = startersQueryKey(search, scope, status, nextCursor);
    const params = new URLSearchParams(queryKey);
    const request = requestGate.current.begin();
    setAuthority((current) => authorityRequestStarted(current, queryKey));
    setPage(syncListUrl(params, nextPage));
    try {
      const data = await apiGet<StartersResponse>(`${STARTERS_LIST}?${params}`);
      if (!request.isCurrent()) return;
      setAuthority(authorityRequestSucceeded(queryKey, data));
      setCursor(nextCursor);
    } catch (loadError) {
      if (!request.isCurrent()) return;
      setAuthority((current) => authorityRequestFailed(
        current,
        queryKey,
        requestErrorMessage(loadError, t),
        loadError,
      ));
    }
  }, [scope, search, status, t]);

  useUrlBootstrap(useCallback((params: URLSearchParams) => {
    setSearch(params.get("search") ?? "");
    setScope(params.get("scope") ?? "all");
    setStatus(params.get("status") ?? "all");
    setCursor(params.get("cursor") ?? undefined);
    setPage(params.get("cursor") ? listPageFromParams(params) : 1);
    setAuthority((current) => authorityRequestStarted(current, startersQueryKey(params.get("search") ?? "", params.get("scope") ?? "all", params.get("status") ?? "all", params.get("cursor") ?? undefined)));
    setUrlRevision((revision) => revision + 1);
  }, []), requestGate);

  useDebouncedReload({ cursor, page, urlRevision, reload, search });

  // 换搜索词/筛选就回到第一页 —— 第 4 页的游标配上新条件是一段没有意义的偏移。
  const restart = useCallback((apply: () => void) => {
    requestGate.current.invalidate();
    apply();
    setCursor(undefined);
    setPage(1);
  }, []);

  function changePage(nextCursor: string | undefined, nextPage: number) {
    requestGate.current.invalidate();
    setCursor(nextCursor);
    setPage(nextPage);
    setAuthority((current) => authorityRequestStarted(current, startersQueryKey(search, scope, status, nextCursor)));
  }

  const allOption = { value: "all", label: t("All") };
  const rows = authority.data?.items ?? [];
  const pageInfo = authority.data?.pageInfo;
  const filtered = search.trim().length > 0 || scope !== "all" || status !== "all";
  return (
    <div>
      <PageHeader
        action={canWrite ? (
          <Link href="/admin/content/templates/new">
            <PrimaryButton>
              <Plus className="h-4 w-4" /> {t("New starter template")}
            </PrimaryButton>
          </Link>
        ) : (
          <PermissionNotice permission="content.template.write" />
        )}
        purpose={t("Manage starter templates for user character creation.")}
        title={t("Character Starters")}
      />
      <FilterBar
        onSearch={(nextSearch) => restart(() => {
          setSearch(nextSearch);
          setAuthority((current) => authorityRequestStarted(
            current,
            startersQueryKey(nextSearch, scope, status),
          ));
        })}
        search={search}
        searchPlaceholder={t("Search by name")}
        selects={[
          { name: t("Scope"), value: scope, onChange: (nextScope) => restart(() => {
            setScope(nextScope);
            setAuthority((current) => authorityRequestStarted(
              current,
              startersQueryKey(search, nextScope, status),
            ));
          }),
            options: [allOption, ...SCOPES.map((s) => ({ value: s, label: value(s) }))] },
          { name: t("Status"), value: status, onChange: (nextStatus) => restart(() => {
            setStatus(nextStatus);
            setAuthority((current) => authorityRequestStarted(
              current,
              startersQueryKey(search, scope, nextStatus),
            ));
          }),
            options: [allOption,
              { value: "active", label: t("Published") },
              { value: "disabled", label: t("Inactive") }] },
        ]}
      />
      {authority.error ? <AuthorityRequestError cause={authority.cause} message={authority.error} requestKind="read" onRetry={() => void reload(cursor, page)} snapshotAt={authority.data ? authority.refreshedAt : null} /> : null}
      {authority.loading && authority.data === null ? (
        <LoadingWorkspace label="Loading starter templates…" />
      ) : authority.data && rows.length === 0 ? (
        <EmptyState
          action={filtered || !canWrite ? undefined : (
            <Link href="/admin/content/templates/new">
              <PrimaryButton>
                <Plus className="h-4 w-4" /> {t("New starter template")}
              </PrimaryButton>
            </Link>
          )}
          hint={filtered
            ? t("The authority searched every starter template. Clear the filters to see them all.")
            : t("Create the first starter template to get started.")}
          kind={filtered ? "filtered" : "empty"}
          onClearFilters={filtered ? () => restart(() => {
            setSearch("");
            setScope("all");
            setStatus("all");
            setAuthority((current) => authorityRequestStarted(current, startersQueryKey("", "all", "all")));
          }) : undefined}
          title={filtered ? t("No starter templates match these filters.") : t("No starter templates yet.")}
        />
      ) : authority.data ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {rows.map((row) => (
            <Link
              className="flex min-w-0 items-start gap-4 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 transition-colors hover:border-[var(--ad-ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)]"
              href={`/admin/content/templates/${row.id}`}
              key={row.id}
            >
              <span aria-hidden className="grid h-12 w-12 shrink-0 place-items-center rounded-md bg-black/[0.04] text-lg font-semibold text-[var(--ad-text-muted)]">{row.name.slice(0, 1).toUpperCase()}</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h2 className="min-w-0 break-words text-sm font-semibold">{row.name}</h2>
                  <StatusPill status={row.isActive ? "active" : "disabled"} label={row.isActive ? t("Published") : t("Inactive")} />
                </div>
                <p className="mt-2 text-xs text-[var(--ad-text-muted)]">{t("{scope} · sort {order} · {count} tags", {
                scope: value(row.scope),
                order: row.sortOrder,
                count: row.tags.length,
                })}</p>
              </div>
            </Link>
          ))}
        </div>
      ) : null}
      <div className="mt-4">
        <Pagination
          hasNext={Boolean(pageInfo?.hasNextPage && pageInfo.endCursor)}
          hasPrevious={Boolean(cursor)}
          previousLabel={cursor && !previousListPage().hasHistory ? t("Back to first page") : undefined}
          loading={authority.loading}
          onNext={() => changePage(pageInfo?.endCursor ?? undefined, page + 1)}
          onPrevious={() => { const previous = previousListPage(); changePage(previous.cursor, previous.page); }}
          page={page}
          pageSize={PAGE_SIZE}
          rowCount={rows.length}
          totalCount={pageInfo?.totalCount ?? null}
        />
      </div>
    </div>
  );
}

function startersQueryKey(search: string, scope: string, status: string, cursor?: string) {
  const params = new URLSearchParams({ limit: "25" });
  if (search.trim()) params.set("search", search.trim());
  if (scope !== "all") params.set("scope", scope);
  if (status !== "all") params.set("status", status);
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}
