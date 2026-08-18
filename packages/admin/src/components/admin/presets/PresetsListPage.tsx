"use client";
import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { apiGet } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { FilterBar } from "@/components/admin/ui/FilterBar";
import { DataTable, type DataTableRow } from "@/components/admin/ui/DataTable";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { Pagination } from "@/components/admin/ui/Pagination";
import { PrimaryButton } from "@/components/admin/ui/buttons";
import { StatusPill } from "@/components/admin/ui/StatusPill";
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
import { PRESET_TYPES, PRESETS_LIST, type PresetRow } from "./presets-api";

const PAGE_SIZE = 25;
type PresetsResponse = { items: PresetRow[]; pageInfo: AdminPageInfo };

// SPEC: 内置生成预设列表页 —— 标签/类型/分类/可见性/状态表格；搜索标签 + 类型筛选（spec §7 列表页）。
// INTENT: 浏览页只浏览；创建在 /new，详情在 /<id>。
export function PresetsListPage() {
  const { t, value } = useAdminI18n();
  const [authority, setAuthority] = useState(() => createAuthorityState<PresetsResponse>());
  const [search, setSearch] = useState("");
  const [type, setType] = useState("all");
  const [cursor, setCursor] = useState<string | undefined>();
  const [page, setPage] = useState(1);
  const [ready, setReady] = useState(false);
  const requestGate = useRef(createLatestRequestGate());

  const reload = useCallback(async (nextCursor: string | undefined, nextPage: number) => {
    const queryKey = presetsQueryKey(search, type, nextCursor);
    const params = new URLSearchParams(queryKey);
    const request = requestGate.current.begin();
    setAuthority((current) => authorityRequestStarted(current, queryKey));
    try {
      const data = await apiGet<PresetsResponse>(`${PRESETS_LIST}?${params}`);
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
  }, [search, t, type]);

  useUrlBootstrap(useCallback((params: URLSearchParams) => {
    setSearch(params.get("search") ?? "");
    setType(params.get("type") ?? "all");
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

  const newAction = (
    <Link href="/admin/generation/presets/new">
      <PrimaryButton>
        <Plus className="h-4 w-4" /> {t("New preset")}
      </PrimaryButton>
    </Link>
  );

  const rows = authority.data?.items ?? [];
  const pageInfo = authority.data?.pageInfo;
  const filtered = search.trim().length > 0 || type !== "all";
  const tableRows: DataTableRow[] = rows.map((row) => ({
    id: row.id,
    href: `/admin/generation/presets/${row.id}`,
    cells: [
      row.label,
      value(row.type),
      row.category || "—",
      value(row.visibility),
      <StatusPill key="status" status={row.status} />,
    ],
  }));

  return (
    <div>
      <PageHeader
        action={newAction}
        purpose={t("Manage built-in generation presets.")}
        title={t("Presets")}
      />
      <FilterBar
        onSearch={(nextSearch) => restart(() => {
          setSearch(nextSearch);
          setAuthority((current) => authorityRequestStarted(
            current,
            presetsQueryKey(nextSearch, type),
          ));
        })}
        search={search}
        searchPlaceholder={t("Search by name")}
        selects={[
          {
            name: t("Type"),
            value: type,
            onChange: (nextType) => restart(() => {
              setType(nextType);
              setAuthority((current) => authorityRequestStarted(
                current,
                presetsQueryKey(search, nextType),
              ));
            }),
            options: [
              { value: "all", label: t("All") },
              ...PRESET_TYPES.map((presetType) => ({ value: presetType, label: value(presetType) })),
            ],
          },
        ]}
      />
      {/* INVARIANT: 出错文案走 AuthorityRequestError（按错误码出人话 + 技术详情），不进 DataTable
          的 error —— 那条横幅只会把 authority 原文原样印出来。取不到数据时连表格都不渲染，
          零行不能被说成「还没有预设」。 */}
      {authority.error ? <AuthorityRequestError cause={authority.cause} message={authority.error} onRetry={() => void reload(cursor, page)} snapshotAt={authority.data ? authority.refreshedAt : null} /> : null}
      {authority.error && authority.data === null ? null : (
        <DataTable
          caption="Built-in presets"
          empty={
            <EmptyState
              action={filtered ? undefined : newAction}
              hint={filtered
                ? t("The authority searched every built-in preset. Clear the filters to see them all.")
                : t("Create the first preset to get started.")}
              kind={filtered ? "filtered" : "empty"}
              onClearFilters={filtered ? () => restart(() => {
                setSearch("");
                setType("all");
                setAuthority((current) => authorityRequestStarted(current, presetsQueryKey("", "all")));
              }) : undefined}
              title={filtered ? t("No built-in presets match these filters.") : t("No built-in presets are seeded yet.")}
            />
          }
          headers={[t("Label"), t("Type"), t("Category"), t("Visibility"), t("Status")]}
          loading={authority.loading}
          rows={tableRows}
          skeletonRows={PAGE_SIZE}
        />
      )}
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
              presetsQueryKey(search, type, nextCursor),
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

function presetsQueryKey(search: string, type: string, cursor?: string) {
  const params = new URLSearchParams({ limit: "25" });
  if (search.trim()) params.set("search", search.trim());
  if (type !== "all") params.set("type", type);
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}
