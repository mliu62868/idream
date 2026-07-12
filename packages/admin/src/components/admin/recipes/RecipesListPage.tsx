"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
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
  const [cursor, setCursor] = useState<string | undefined>();
  const [pageInfo, setPageInfo] = useState({ endCursor: null as string | null, hasNextPage: false });
  const [ready, setReady] = useState(false);

  const reload = useCallback(async (nextCursor?: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: "25" });
      if (search.trim()) params.set("search", search.trim());
      if (status !== "all") params.set("status", status);
      if (nextCursor) params.set("cursor", nextCursor);
      const data = await apiGet<{ items: Recipe[]; pageInfo: { endCursor: string | null; hasNextPage: boolean } }>(`${RECIPES_LIST}?${params}`);
      setRows(data.items);
      setCursor(nextCursor);
      setPageInfo(data.pageInfo);
      window.history.replaceState(null, "", `${window.location.pathname}?${params}`);
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
    <Link href="/admin/generation/recipes/new">
      <PrimaryButton>
        <Plus className="h-4 w-4" /> {t("New prompt recipe")}
      </PrimaryButton>
    </Link>
  );

  const tableRows: DataTableRow[] = rows.map((row) => ({
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
        onSearch={(value) => { setSearch(value); setCursor(undefined); }}
        search={search}
        searchPlaceholder={t("Search by name")}
        selects={[
          {
            name: t("Status"),
            value: status,
            onChange: (value) => { setStatus(value); setCursor(undefined); },
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
      <div className="mt-4 flex justify-end"><button className="min-h-10 rounded-md border border-[var(--ad-border)] px-4 text-sm font-semibold disabled:opacity-50" disabled={loading || !pageInfo.hasNextPage || !pageInfo.endCursor} onClick={() => setCursor(pageInfo.endCursor ?? undefined)} type="button">Next page</button></div>
    </div>
  );
}
