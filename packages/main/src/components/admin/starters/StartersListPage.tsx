"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { apiGet } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { FilterBar } from "@/components/admin/ui/FilterBar";
import { CardGrid, EntityCard } from "@/components/admin/ui/CardGrid";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { PrimaryButton } from "@/components/admin/ui/buttons";
import { SCOPES, STARTERS_LIST, type Starter } from "./starters-api";

// SPEC: 角色模板列表页 —— 搜索/筛选 + 卡片网格（无图 monogram、范围·排序·标签数、上/下线状态）。
// INTENT: 浏览页只浏览；创建在 /new，详情在 /<id>（spec §7 列表页）。
export function StartersListPage() {
  const { t, value } = useAdminI18n();
  const [rows, setRows] = useState<Starter[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState("all");
  const [status, setStatus] = useState("all");

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ items: Starter[] }>(STARTERS_LIST);
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
        const rowStatus = row.isActive ? "active" : "disabled";
        return (
          (search.trim() === "" || row.name.toLowerCase().includes(search.trim().toLowerCase())) &&
          (scope === "all" || row.scope === scope) &&
          (status === "all" || rowStatus === status)
        );
      }),
    [rows, search, scope, status],
  );

  const allOption = { value: "all", label: t("All") };
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
        onSearch={setSearch}
        search={search}
        searchPlaceholder={t("Search by name")}
        selects={[
          { name: t("Scope"), value: scope, onChange: setScope,
            options: [allOption, ...SCOPES.map((s) => ({ value: s, label: value(s) }))] },
          { name: t("Status"), value: status, onChange: setStatus,
            options: [allOption,
              { value: "active", label: t("Published") },
              { value: "disabled", label: t("Inactive") }] },
        ]}
      />
      {error ? <p className="mb-4 text-sm text-[var(--ad-red-text)]">{error}</p> : null}
      {loading ? (
        <p className="text-sm text-[var(--ad-text-muted)]">{t("Loading…")}</p>
      ) : filtered.length === 0 ? (
        <EmptyState
          action={
            <Link href="/admin/content/templates/new">
              <PrimaryButton>
                <Plus className="h-4 w-4" /> {t("New starter template")}
              </PrimaryButton>
            </Link>
          }
          hint={t("Create the first starter template to get started.")}
          title={t("No starter templates yet.")}
        />
      ) : (
        <CardGrid>
          {filtered.map((row) => (
            <EntityCard
              href={`/admin/content/templates/${row.id}`}
              key={row.id}
              meta={
                <span>
                  {value(row.scope)} · {t("Sort order")} {row.sortOrder} ·{" "}
                  {t("{count} tags", { count: row.tags.length })}
                </span>
              }
              status={row.isActive ? "active" : "disabled"}
              statusLabel={row.isActive ? t("Published") : t("Inactive")}
              title={row.name}
            />
          ))}
        </CardGrid>
      )}
    </div>
  );
}
