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
import { useDebouncedReload, useUrlBootstrap } from "@/components/admin/section-kit";
import { createLatestRequestGate } from "@/lib/latest-request";
import { ALL_STATUSES, placementsListPath, type Placement } from "./placements-api";

// SPEC: 铺位列表页 —— 缩略图 + slot/目标/状态表格；关键词搜索 + 状态筛选（spec §7 列表页）。
// INTENT: 浏览页只浏览；创建在 /new，发布/暂停/归档在详情页。
export function PlacementsListPage({ canPublish }: { canPublish: boolean }) {
  const { t, value } = useAdminI18n();
  const [rows, setRows] = useState<Placement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [cursor, setCursor] = useState<string | undefined>();
  const [pageInfo, setPageInfo] = useState({ endCursor: null as string | null, hasNextPage: false });
  const [ready, setReady] = useState(false);
  // INVARIANT: 慢响应不能覆盖新一轮筛选的结果——本页此前没有闸，是五个列表页里唯一漏掉的。
  const requestGate = useRef(createLatestRequestGate());

  const reload = useCallback(async (nextCursor?: string) => {
    const request = requestGate.current.begin();
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ items: Placement[]; pageInfo: { endCursor: string | null; hasNextPage: boolean } }>(placementsListPath({ search, status, cursor: nextCursor }));
      if (!request.isCurrent()) return;
      setRows(data.items);
      setCursor(nextCursor);
      setPageInfo(data.pageInfo);
      const params = new URLSearchParams();
      if (search.trim()) params.set("search", search.trim());
      if (status !== "all") params.set("status", status);
      if (nextCursor) params.set("cursor", nextCursor);
      window.history.replaceState(null, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`);
    } catch (loadError) {
      if (!request.isCurrent()) return;
      setError(loadError instanceof Error ? loadError.message : t("Request failed"));
    } finally {
      if (request.isCurrent()) setLoading(false);
    }
  }, [search, status, t]);

  useUrlBootstrap(useCallback((params: URLSearchParams) => {
    setSearch(params.get("search") ?? "");
    setStatus(params.get("status") ?? "all");
    setCursor(params.get("cursor") ?? undefined);
    setReady(true);
  }, []), requestGate.current);

  useDebouncedReload({ cursor, ready, reload, search });

  const newAction = canPublish ? (
    <Link href="/admin/content/placements/new">
      <PrimaryButton>
        <Plus className="h-4 w-4" /> {t("New placement")}
      </PrimaryButton>
    </Link>
  ) : null;

  const tableRows: DataTableRow[] = rows.map((row) => ({
    id: row.id,
    href: `/admin/content/placements/${row.id}`,
    cells: [
      <AssetImage asset={row.asset} compact key="thumb" />,
      value(row.slot),
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
        onSearch={(nextSearch) => { requestGate.current.invalidate(); setSearch(nextSearch); setCursor(undefined); }}
        search={search}
        searchPlaceholder={t("Search by slot, target, or asset ID")}
        selects={[
          {
            name: t("Status"),
            value: status,
            onChange: (nextStatus) => { requestGate.current.invalidate(); setStatus(nextStatus); setCursor(undefined); },
            options: [
              { value: "all", label: t("All") },
              ...ALL_STATUSES.map((item) => ({ value: item, label: value(item) })),
            ],
          },
        ]}
      />
      {error ? <AuthorityRequestError message={error} onRetry={() => void reload(cursor)} snapshotAt={null} /> : null}
      {loading && rows.length === 0 ? (
        <p className="text-sm text-[var(--ad-text-muted)]">{t("Loading…")}</p>
      ) : rows.length === 0 && error ? null : (
        <DataTable
          empty={
            <EmptyState
              action={newAction}
              hint={t("Create the first placement to get started.")}
              title={t("No placements yet.")}
            />
          }
          headers={[t("Asset"), t("Slot"), t("Target"), t("Status"), t("Verification")]}
          rows={tableRows}
        />
      )}
      <div className="mt-4 flex justify-end"><button className="min-h-10 rounded-md border border-[var(--ad-border)] px-4 text-sm font-semibold disabled:opacity-50" disabled={loading || !pageInfo.hasNextPage || !pageInfo.endCursor} onClick={() => setCursor(pageInfo.endCursor ?? undefined)} type="button">{t("Next page")}</button></div>
    </div>
  );
}
