"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
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
  const [cursor, setCursor] = useState<string | undefined>();
  const [pageInfo, setPageInfo] = useState({ endCursor: null as string | null, hasNextPage: false });
  const [ready, setReady] = useState(false);

  const reload = useCallback(async (nextCursor?: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: "25" });
      if (search.trim()) params.set("search", search.trim());
      if (scope !== "all") params.set("scope", scope);
      if (status !== "all") params.set("status", status);
      if (nextCursor) params.set("cursor", nextCursor);
      const data = await apiGet<{ items: Starter[]; pageInfo: { endCursor: string | null; hasNextPage: boolean } }>(`${STARTERS_LIST}?${params}`);
      setRows(data.items);
      setCursor(nextCursor);
      setPageInfo(data.pageInfo);
      window.history.replaceState(null, "", `${window.location.pathname}?${params}`);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("Request failed"));
    } finally {
      setLoading(false);
    }
  }, [scope, search, status, t]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const timer = window.setTimeout(() => {
      setSearch(params.get("search") ?? "");
      setScope(params.get("scope") ?? "all");
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
        onSearch={(value) => { setSearch(value); setCursor(undefined); }}
        search={search}
        searchPlaceholder={t("Search by name")}
        selects={[
          { name: t("Scope"), value: scope, onChange: (value) => { setScope(value); setCursor(undefined); },
            options: [allOption, ...SCOPES.map((s) => ({ value: s, label: value(s) }))] },
          { name: t("Status"), value: status, onChange: (value) => { setStatus(value); setCursor(undefined); },
            options: [allOption,
              { value: "active", label: t("Published") },
              { value: "disabled", label: t("Inactive") }] },
        ]}
      />
      {error ? <p className="mb-4 text-sm text-[var(--ad-red-text)]">{error}</p> : null}
      {loading ? (
        <p className="text-sm text-[var(--ad-text-muted)]">{t("Loading…")}</p>
      ) : rows.length === 0 ? (
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
          {rows.map((row) => (
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
      <div className="mt-4 flex justify-end"><button className="min-h-10 rounded-md border border-[var(--ad-border)] px-4 text-sm font-semibold disabled:opacity-50" disabled={loading || !pageInfo.hasNextPage || !pageInfo.endCursor} onClick={() => setCursor(pageInfo.endCursor ?? undefined)} type="button">Next page</button></div>
    </div>
  );
}
