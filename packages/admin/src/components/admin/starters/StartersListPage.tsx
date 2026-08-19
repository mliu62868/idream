"use client";
import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { apiGet } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { FilterBar } from "@/components/admin/ui/FilterBar";
import { CardGrid, EntityCard } from "@/components/admin/ui/CardGrid";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { Pagination } from "@/components/admin/ui/Pagination";
import { PrimaryButton } from "@/components/admin/ui/buttons";
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
  canGoPrevious,
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
export function StartersListPage() {
  const { t, value } = useAdminI18n();
  const [authority, setAuthority] = useState(() => createAuthorityState<StartersResponse>());
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState("all");
  const [status, setStatus] = useState("all");
  const [cursor, setCursor] = useState<string | undefined>();
  const [page, setPage] = useState(1);
  const [ready, setReady] = useState(false);
  const requestGate = useRef(createLatestRequestGate());

  const reload = useCallback(async (nextCursor: string | undefined, nextPage: number) => {
    const queryKey = startersQueryKey(search, scope, status, nextCursor);
    const params = new URLSearchParams(queryKey);
    const request = requestGate.current.begin();
    setAuthority((current) => authorityRequestStarted(current, queryKey));
    try {
      const data = await apiGet<StartersResponse>(`${STARTERS_LIST}?${params}`);
      if (!request.isCurrent()) return;
      setAuthority(authorityRequestSucceeded(queryKey, data));
      setCursor(nextCursor);
      syncListUrl(params, nextPage);
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
    setPage(listPageFromParams(params));
    setReady(true);
  }, []), requestGate);

  useDebouncedReload({ cursor, page, ready, reload, search });

  // 换搜索词/筛选就回到第一页 —— 第 4 页的游标配上新条件是一段没有意义的偏移。
  const restart = useCallback((apply: () => void) => {
    requestGate.current.invalidate();
    apply();
    setCursor(undefined);
    setPage(1);
  }, []);

  const allOption = { value: "all", label: t("All") };
  const rows = authority.data?.items ?? [];
  const pageInfo = authority.data?.pageInfo;
  const filtered = search.trim().length > 0 || scope !== "all" || status !== "all";
  return (
    <div>
      <PageHeader
        action={
          <Link href="/admin/content/templates/new">
            <PrimaryButton>
              <Plus className="h-4 w-4" /> {t("New starter template")}
            </PrimaryButton>
          </Link>
        }
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
      {authority.error ? <AuthorityRequestError cause={authority.cause} message={authority.error} onRetry={() => void reload(cursor, page)} snapshotAt={authority.data ? authority.refreshedAt : null} /> : null}
      {authority.loading && authority.data === null ? (
        <LoadingWorkspace label="Loading starter templates…" />
      ) : authority.data && rows.length === 0 ? (
        <EmptyState
          action={filtered ? undefined : (
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
        <CardGrid>
          {rows.map((row) => (
            <EntityCard
              href={`/admin/content/templates/${row.id}`}
              key={row.id}
              meta={t("{scope} · sort {order} · {count} tags", {
                scope: value(row.scope),
                order: row.sortOrder,
                count: row.tags.length,
              })}
              status={row.isActive ? "active" : "disabled"}
              statusLabel={row.isActive ? t("Published") : t("Inactive")}
              title={row.name}
            />
          ))}
        </CardGrid>
      ) : null}
      <div className="mt-4">
        <Pagination
          hasNext={Boolean(pageInfo?.hasNextPage && pageInfo.endCursor)}
          // 这个 operation 的查询契约没有 `before` —— 置灰，不假装已经在第一页（section-kit 有全部理由）。
          hasPrevious={pageInfo ? canGoPrevious(pageInfo, false) : false}
          loading={authority.loading}
          onNext={() => {
            const nextCursor = pageInfo?.endCursor ?? undefined;
            requestGate.current.invalidate();
            setCursor(nextCursor);
            setPage(page + 1);
            setAuthority((current) => authorityRequestStarted(
              current,
              startersQueryKey(search, scope, status, nextCursor),
            ));
          }}
          onPrevious={() => undefined}
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
