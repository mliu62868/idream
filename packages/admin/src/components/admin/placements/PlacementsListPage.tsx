"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
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
import { ALL_STATUSES, placementsListPath, type Placement } from "./placements-api";

// SPEC: 铺位列表页 —— 缩略图 + slot/目标/状态表格；关键词搜索 + 状态筛选（spec §7 列表页）。
// INTENT: 浏览页只浏览；创建在 /new，发布/暂停/归档在详情页。
export function PlacementsListPage() {
  const { t, value } = useAdminI18n();
  const [rows, setRows] = useState<Placement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [cursor, setCursor] = useState<string | undefined>();
  const [pageInfo, setPageInfo] = useState({ endCursor: null as string | null, hasNextPage: false });
  const [ready, setReady] = useState(false);

  const reload = useCallback(async (nextCursor?: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ items: Placement[]; pageInfo: { endCursor: string | null; hasNextPage: boolean } }>(placementsListPath({ search, status, cursor: nextCursor }));
      setRows(data.items);
      setCursor(nextCursor);
      setPageInfo(data.pageInfo);
      const params = new URLSearchParams();
      if (search.trim()) params.set("search", search.trim());
      if (status !== "all") params.set("status", status);
      if (nextCursor) params.set("cursor", nextCursor);
      window.history.replaceState(null, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("Request failed"));
    } finally {
      setLoading(false);
    }
  }, [search, status, t]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const timer = window.setTimeout(() => {
      setSearch(params.get("search") ?? "");
      setStatus(params.get("status") ?? "all");
      setCursor(params.get("cursor") ?? undefined);
      setReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => void reload(cursor), search.trim() ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [cursor, ready, reload, search]);

  const newAction = (
    <Link href="/admin/content/placements/new">
      <PrimaryButton>
        <Plus className="h-4 w-4" /> {t("New placement")}
      </PrimaryButton>
    </Link>
  );

  const tableRows: DataTableRow[] = rows.map((row) => ({
    id: row.id,
    href: `/admin/content/placements/${row.id}`,
    cells: [
      <AssetImage asset={row.asset} compact key="thumb" />,
      value(row.slot),
      `${value(row.targetType)} · ${row.targetId}`,
      <StatusPill key="status" status={row.status} />,
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
        onSearch={(value) => { setSearch(value); setCursor(undefined); }}
        search={search}
        searchPlaceholder={t("Search by slot, target, or asset ID")}
        selects={[
          {
            name: t("Status"),
            value: status,
            onChange: (value) => { setStatus(value); setCursor(undefined); },
            options: [
              { value: "all", label: t("All") },
              ...ALL_STATUSES.map((item) => ({ value: item, label: value(item) })),
            ],
          },
        ]}
      />
      {error ? <p className="mb-4 text-sm text-[var(--ad-red-text)]">{error}</p> : null}
      {loading ? (
        <p className="text-sm text-[var(--ad-text-muted)]">{t("Loading…")}</p>
      ) : (
        <DataTable
          empty={
            <EmptyState
              action={newAction}
              hint={t("Create the first placement to get started.")}
              title={t("No placements yet.")}
            />
          }
          headers={[t("Asset"), t("Slot"), t("Target"), t("Status")]}
          rows={tableRows}
        />
      )}
      <div className="mt-4 flex justify-end"><button className="min-h-10 rounded-md border border-[var(--ad-border)] px-4 text-sm font-semibold disabled:opacity-50" disabled={loading || !pageInfo.hasNextPage || !pageInfo.endCursor} onClick={() => setCursor(pageInfo.endCursor ?? undefined)} type="button">Next page</button></div>
    </div>
  );
}
