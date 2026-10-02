"use client";
import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { apiGet } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { FilterBar } from "@/components/admin/ui/FilterBar";
import { DataTable, type DataTableRow } from "@/components/admin/ui/DataTable";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { PrimaryButton } from "@/components/admin/ui/buttons";
import { StatusPill } from "@/components/admin/ui/StatusPill";
import { AssetImage } from "@/components/admin/ui/AssetImage";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { Pagination } from "@/components/admin/ui/Pagination";
import type { AdminPageInfo } from "@idream/shared/admin";
import {
  previousListPage,
  listPageFromParams,
  requestErrorMessage,
  syncListUrl,
  useDebouncedReload,
  useUrlBootstrap,
} from "@/components/admin/section-kit";
import { createLatestRequestGate } from "@/lib/latest-request";
import { ALL_STATUSES, placementsListPath, type Placement } from "./placements-api";

const PAGE_SIZE = 25;
const EMPTY_PAGE_INFO: AdminPageInfo = { endCursor: null, hasNextPage: false };

// SPEC: 铺位列表页 —— 缩略图 + slot/目标/状态表格；关键词搜索 + 状态筛选（spec §7 列表页）。
// INTENT: 浏览页只浏览；创建在 /new，发布/暂停/归档在详情页。
export function PlacementsListPage({ canPublish }: { canPublish: boolean }) {
  const { t, value } = useAdminI18n();
  const [rows, setRows] = useState<Placement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; cause: unknown } | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [cursor, setCursor] = useState<string | undefined>();
  const [page, setPage] = useState(1);
  const [pageInfo, setPageInfo] = useState<AdminPageInfo>(EMPTY_PAGE_INFO);
  const [urlRevision, setUrlRevision] = useState(0);
  // INVARIANT: 慢响应不能覆盖新一轮筛选的结果——本页此前没有闸，是五个列表页里唯一漏掉的。
  const requestGate = useRef(createLatestRequestGate());

  const reload = useCallback(async (nextCursor: string | undefined, nextPage: number) => {
    const request = requestGate.current.begin();
    setLoading(true);
    setError(null);
    setRows([]);
    setPageInfo(EMPTY_PAGE_INFO);
    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    if (status !== "all") params.set("status", status);
    if (nextCursor) params.set("cursor", nextCursor);
    setPage(syncListUrl(params, nextPage));
    try {
      const data = await apiGet<{ items: Placement[]; pageInfo: AdminPageInfo }>(placementsListPath({ search, status, cursor: nextCursor }));
      if (!request.isCurrent()) return;
      setRows(data.items);
      setCursor(nextCursor);
      setPageInfo(data.pageInfo);
    } catch (loadError) {
      if (!request.isCurrent()) return;
      setError({ message: requestErrorMessage(loadError, t), cause: loadError });
    } finally {
      if (request.isCurrent()) setLoading(false);
    }
  }, [search, status, t]);

  useUrlBootstrap(useCallback((params: URLSearchParams) => {
    setRows([]);
    setPageInfo(EMPTY_PAGE_INFO);
    setLoading(true);
    setError(null);
    setSearch(params.get("search") ?? "");
    setStatus(params.get("status") ?? "all");
    setCursor(params.get("cursor") ?? undefined);
    setPage(params.get("cursor") ? listPageFromParams(params) : 1);
    setUrlRevision((revision) => revision + 1);
  }, []), requestGate);

  useDebouncedReload({ cursor, page, urlRevision, reload, search });

  // 换搜索词/筛选就回到第一页 —— 第 4 页的游标配上新条件是一段没有意义的偏移。
  const restart = useCallback((apply: () => void) => {
    requestGate.current.invalidate();
    setRows([]);
    setPageInfo(EMPTY_PAGE_INFO);
    setLoading(true);
    setError(null);
    apply();
    setCursor(undefined);
    setPage(1);
  }, []);

  function changePage(nextCursor: string | undefined, nextPage: number) {
    requestGate.current.invalidate();
    setRows([]);
    setPageInfo(EMPTY_PAGE_INFO);
    setLoading(true);
    setError(null);
    setCursor(nextCursor);
    setPage(nextPage);
  }

  const newAction = canPublish ? (
    <Link href="/admin/content/placements/new">
      <PrimaryButton>
        <Plus className="h-4 w-4" /> {t("New placement")}
      </PrimaryButton>
    </Link>
  ) : null;

  const filtered = search.trim().length > 0 || status !== "all";
  const tableRows: DataTableRow[] = rows.map((row) => ({
    id: row.id,
    cells: [
      <AssetImage asset={row.asset} compact key="thumb" />,
      <Link className="font-semibold underline underline-offset-4" href={`/admin/content/placements/${row.id}`} key="slot">{value(row.slot)}</Link>,
      `${value(row.targetType)} · ${row.targetId}`,
      <StatusPill key="status" status={row.status} />,
      <StatusPill key="verification" status={row.verificationState} />,
    ],
  }));

  return (
    <div>
      <PageHeader
        action={newAction}
        purpose={t("Manage where approved images are surfaced across the platform.")}
        title={t("Placements")}
      />
      <FilterBar
        onSearch={(nextSearch) => restart(() => setSearch(nextSearch))}
        search={search}
        searchPlaceholder={t("Search by slot, target, or asset ID")}
        selects={[
          {
            name: t("Status"),
            value: status,
            onChange: (nextStatus) => restart(() => setStatus(nextStatus)),
            options: [
              { value: "all", label: t("All") },
              ...ALL_STATUSES.map((item) => ({ value: item, label: value(item) })),
            ],
          },
        ]}
      />
      {error ? <AuthorityRequestError cause={error.cause} message={error.message} requestKind="read" onRetry={() => void reload(cursor, page)} snapshotAt={null} /> : null}
      {error && rows.length === 0 ? null : (
        <DataTable
          caption="Placements"
          empty={
            <EmptyState
              action={filtered ? undefined : newAction}
              hint={filtered
                ? t("The authority searched every placement. Clear the filters to see them all.")
                : t("Create the first placement to get started.")}
              kind={filtered ? "filtered" : "empty"}
              onClearFilters={filtered ? () => restart(() => { setSearch(""); setStatus("all"); }) : undefined}
              title={filtered ? t("No placements match these filters.") : t("No placements yet.")}
            />
          }
          headers={[t("Asset"), t("Slot"), t("Target"), t("Status"), t("Verification")]}
          loading={loading}
          rows={tableRows}
          skeletonRows={PAGE_SIZE}
        />
      )}
      <div className="mt-4">
        <Pagination
          hasNext={Boolean(pageInfo.hasNextPage && pageInfo.endCursor)}
          hasPrevious={Boolean(cursor)}
          previousLabel={cursor && !previousListPage().hasHistory ? t("Back to first page") : undefined}
          loading={loading}
          onNext={() => changePage(pageInfo.endCursor ?? undefined, page + 1)}
          onPrevious={() => { const previous = previousListPage(); changePage(previous.cursor, previous.page); }}
          page={page}
          pageSize={PAGE_SIZE}
          rowCount={rows.length}
          totalCount={pageInfo.totalCount ?? null}
        />
      </div>
    </div>
  );
}
