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
import { PRESET_TYPES, PRESETS_LIST, type PresetRow } from "./presets-api";

// SPEC: 内置生成预设列表页 —— 标签/类型/分类/可见性/状态表格；搜索标签 + 类型筛选（spec §7 列表页）。
// INTENT: 浏览页只浏览；创建在 /new，详情在 /<id>。
export function PresetsListPage() {
  const { t, value } = useAdminI18n();
  const [rows, setRows] = useState<PresetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [type, setType] = useState("all");

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ items: PresetRow[] }>(PRESETS_LIST);
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

  const filtered = useMemo(
    () =>
      rows.filter((row) => {
        return (
          (search.trim() === "" || row.label.toLowerCase().includes(search.trim().toLowerCase())) &&
          (type === "all" || row.type === type)
        );
      }),
    [rows, search, type],
  );

  const newAction = (
    <Link href="/admin/generation/presets/new">
      <PrimaryButton>
        <Plus className="h-4 w-4" /> {t("New preset")}
      </PrimaryButton>
    </Link>
  );

  const tableRows: DataTableRow[] = filtered.map((row) => ({
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
        onSearch={setSearch}
        search={search}
        searchPlaceholder={t("Search by name")}
        selects={[
          {
            name: t("Type"),
            value: type,
            onChange: setType,
            options: [
              { value: "all", label: t("All") },
              ...PRESET_TYPES.map((presetType) => ({ value: presetType, label: value(presetType) })),
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
              hint={t("Create the first preset to get started.")}
              title={t("No built-in presets are seeded yet.")}
            />
          }
          headers={[t("Label"), t("Type"), t("Category"), t("Visibility"), t("Status")]}
          rows={tableRows}
        />
      )}
    </div>
  );
}
