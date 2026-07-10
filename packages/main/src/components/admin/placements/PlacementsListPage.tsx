"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { ALL_STATUSES, PLACEMENTS_LIST, type Placement } from "./placements-api";

// SPEC: 铺位列表页 —— 缩略图 + slot/目标/状态表格；关键词搜索 + 状态筛选（spec §7 列表页）。
// INTENT: 浏览页只浏览；创建在 /new，发布/暂停/归档在详情页。
export function PlacementsListPage() {
  const { t, value } = useAdminI18n();
  const [rows, setRows] = useState<Placement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ items: Placement[] }>(PLACEMENTS_LIST);
      setRows(data.items);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("Request failed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void reload();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [reload]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((row) => {
      const haystack = `${row.slot} ${row.targetType} ${row.targetId} ${row.mediaAssetId}`.toLowerCase();
      return (term === "" || haystack.includes(term)) && (status === "all" || row.status === status);
    });
  }, [rows, search, status]);

  const newAction = (
    <Link href="/admin/content/placements/new">
      <PrimaryButton>
        <Plus className="h-4 w-4" /> {t("New placement")}
      </PrimaryButton>
    </Link>
  );

  const tableRows: DataTableRow[] = filtered.map((row) => ({
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
        onSearch={setSearch}
        search={search}
        searchPlaceholder={t("Search by slot, target, or asset ID")}
        selects={[
          {
            name: t("Status"),
            value: status,
            onChange: setStatus,
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
    </div>
  );
}
