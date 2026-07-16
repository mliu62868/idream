"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { apiGet } from "@/components/admin/api";
import { adminDateLocale, useAdminI18n } from "@/components/admin/i18n";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { FilterBar } from "@/components/admin/ui/FilterBar";
import { DataTable, type DataTableRow } from "@/components/admin/ui/DataTable";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { PrimaryButton } from "@/components/admin/ui/buttons";
import { StatusPill } from "@/components/admin/ui/StatusPill";
import {
  authorityRequestFailed,
  authorityRequestStarted,
  authorityRequestSucceeded,
  createAuthorityState,
} from "@/lib/authority-state";
import { createLatestRequestGate } from "@/lib/latest-request";
import { RECIPES_LIST, recipeStateLabelKey, type Recipe } from "./recipes-api";

const STATUSES = ["draft", "active", "archived"] as const;
type RecipesResponse = { items: Recipe[]; pageInfo: { endCursor: string | null; hasNextPage: boolean } };

// SPEC: 提示词配方列表页 —— 名称/版本/状态/更新时间表格；搜索名称 + 状态筛选（spec §7 列表页）。
// INTENT: 浏览页只浏览；创建在 /new，详情在 /<id>。
export function RecipesListPage() {
  const { locale, t } = useAdminI18n();
  const [authority, setAuthority] = useState(() => createAuthorityState<RecipesResponse>());
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [cursor, setCursor] = useState<string | undefined>();
  const [ready, setReady] = useState(false);
  const requestGate = useRef(createLatestRequestGate());

  const reload = useCallback(async (nextCursor?: string) => {
    const queryKey = recipesQueryKey(search, status, nextCursor);
    const params = new URLSearchParams(queryKey);
    const request = requestGate.current.begin();
    setAuthority((current) => authorityRequestStarted(current, queryKey));
    try {
      const data = await apiGet<RecipesResponse>(`${RECIPES_LIST}?${params}`);
      if (!request.isCurrent()) return;
      setAuthority(authorityRequestSucceeded(queryKey, data));
      setCursor(nextCursor);
      window.history.replaceState(null, "", `${window.location.pathname}?${params}`);
    } catch (loadError) {
      if (!request.isCurrent()) return;
      setAuthority((current) => authorityRequestFailed(
        current,
        queryKey,
        loadError instanceof Error ? loadError.message : t("Request failed"),
      ));
    }
  }, [search, status, t]);

  useEffect(() => {
    const gate = requestGate.current;
    const params = new URLSearchParams(window.location.search);
    const timer = window.setTimeout(() => {
      setSearch(params.get("search") ?? "");
      setStatus(params.get("status") ?? "all");
      setCursor(params.get("cursor") ?? undefined);
      setReady(true);
    }, 0);
    return () => {
      gate.invalidate();
      window.clearTimeout(timer);
    };
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

  const rows = authority.data?.items ?? [];
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
        onSearch={(nextSearch) => {
          requestGate.current.invalidate();
          setSearch(nextSearch);
          setCursor(undefined);
          setAuthority((current) => authorityRequestStarted(
            current,
            recipesQueryKey(nextSearch, status),
          ));
        }}
        search={search}
        searchPlaceholder={t("Search by name")}
        selects={[
          {
            name: t("Status"),
            value: status,
            onChange: (nextStatus) => {
              requestGate.current.invalidate();
              setStatus(nextStatus);
              setCursor(undefined);
              setAuthority((current) => authorityRequestStarted(
                current,
                recipesQueryKey(search, nextStatus),
              ));
            },
            options: [
              { value: "all", label: t("All") },
              ...STATUSES.map((s) => ({ value: s, label: t(recipeStateLabelKey({ status: s })) })),
            ],
          },
        ]}
      />
      {authority.error ? <AuthorityRequestError message={authority.error} onRetry={() => void reload(cursor)} /> : null}
      {authority.loading && authority.data === null ? (
        <p className="text-sm text-[var(--ad-text-muted)]">{t("Loading…")}</p>
      ) : authority.data ? (
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
      ) : null}
      <div className="mt-4 flex justify-end"><button className="min-h-10 rounded-md border border-[var(--ad-border)] px-4 text-sm font-semibold disabled:opacity-50" disabled={authority.loading || !authority.data?.pageInfo.hasNextPage || !authority.data.pageInfo.endCursor} onClick={() => {
        const nextCursor = authority.data?.pageInfo.endCursor ?? undefined;
        requestGate.current.invalidate();
        setCursor(nextCursor);
        setAuthority((current) => authorityRequestStarted(
          current,
          recipesQueryKey(search, status, nextCursor),
        ));
      }} type="button">Next page</button></div>
    </div>
  );
}

function recipesQueryKey(search: string, status: string, cursor?: string) {
  const params = new URLSearchParams({ limit: "25" });
  if (search.trim()) params.set("search", search.trim());
  if (status !== "all") params.set("status", status);
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}
