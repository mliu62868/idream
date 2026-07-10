"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { apiGet } from "@/components/admin/api";
import { adminDateLocale, useAdminI18n } from "@/components/admin/i18n";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { FilterBar } from "@/components/admin/ui/FilterBar";
import { DataTable, type DataTableRow } from "@/components/admin/ui/DataTable";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { PrimaryButton } from "@/components/admin/ui/buttons";
import { StatusPill } from "@/components/admin/ui/StatusPill";
import { RECIPES_LIST, recipeStateLabelKey, type Recipe } from "./recipes-api";

const STATUSES = ["draft", "active", "archived"] as const;

// SPEC: 提示词配方列表页 —— 名称/版本/状态/更新时间表格；搜索名称 + 状态筛选（spec §7 列表页）。
// INTENT: 浏览页只浏览；创建在 /new，详情在 /<id>。
export function RecipesListPage() {
  const { locale, t } = useAdminI18n();
  const [rows, setRows] = useState<Recipe[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ items: Recipe[] }>(RECIPES_LIST);
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
          (status === "all" || row.status === status)
        );
      }),
    [rows, search, status],
  );

  const newAction = (
    <Link href="/admin/generation/recipes/new">
      <PrimaryButton>
        <Plus className="h-4 w-4" /> {t("New prompt recipe")}
      </PrimaryButton>
    </Link>
  );

  const tableRows: DataTableRow[] = filtered.map((row) => ({
    id: row.id,
    href: `/admin/generation/recipes/${row.id}`,
    cells: [
      row.label,
      `v${row.version}`,
      <StatusPill key="status" label={t(recipeStateLabelKey(row))} status={row.status} />,
      new Date(row.updatedAt).toLocaleDateString(adminDateLocale(locale)),
    ],
  }));

  return (
    <div>
      <PageHeader
        action={newAction}
        purpose={t("Manage prompt recipes for image generation.")}
        title={t("Prompt Recipes")}
      />
      <FilterBar
        onSearch={setSearch}
        search={search}
        searchPlaceholder={t("Search by name")}
        selects={[
          {
            name: t("Status"),
            value: status,
            onChange: setStatus,
            options: [
              { value: "all", label: t("All") },
              ...STATUSES.map((s) => ({ value: s, label: t(recipeStateLabelKey({ status: s })) })),
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
              hint={t("Create the first prompt recipe to get started.")}
              title={t("No prompt recipes yet.")}
            />
          }
          headers={[t("Name"), t("Version"), t("Status"), t("Updated")]}
          rows={tableRows}
        />
      )}
    </div>
  );
}
