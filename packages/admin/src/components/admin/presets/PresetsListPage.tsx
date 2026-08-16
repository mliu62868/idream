"use client";
import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { apiGet } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
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
import { useDebouncedReload, useUrlBootstrap } from "@/components/admin/section-kit";
import { PRESET_TYPES, PRESETS_LIST, type PresetRow } from "./presets-api";

type PresetsResponse = { items: PresetRow[]; pageInfo: { endCursor: string | null; hasNextPage: boolean } };

// SPEC: 内置生成预设列表页 —— 标签/类型/分类/可见性/状态表格；搜索标签 + 类型筛选（spec §7 列表页）。
// INTENT: 浏览页只浏览；创建在 /new，详情在 /<id>。
export function PresetsListPage() {
  const { t, value } = useAdminI18n();
  const [authority, setAuthority] = useState(() => createAuthorityState<PresetsResponse>());
  const [search, setSearch] = useState("");
  const [type, setType] = useState("all");
  const [cursor, setCursor] = useState<string | undefined>();
  const [ready, setReady] = useState(false);
  const requestGate = useRef(createLatestRequestGate());

  const reload = useCallback(async (nextCursor?: string) => {
    const queryKey = presetsQueryKey(search, type, nextCursor);
    const params = new URLSearchParams(queryKey);
    const request = requestGate.current.begin();
    setAuthority((current) => authorityRequestStarted(current, queryKey));
    try {
      const data = await apiGet<PresetsResponse>(`${PRESETS_LIST}?${params}`);
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
  }, [search, t, type]);

  useUrlBootstrap(useCallback((params: URLSearchParams) => {
    setSearch(params.get("search") ?? "");
    setType(params.get("type") ?? "all");
    setCursor(params.get("cursor") ?? undefined);
    setReady(true);
  }, []), requestGate.current);

  useDebouncedReload({ cursor, ready, reload, search });

  const newAction = (
    <Link href="/admin/generation/presets/new">
      <PrimaryButton>
        <Plus className="h-4 w-4" /> {t("New preset")}
      </PrimaryButton>
    </Link>
  );

  const rows = authority.data?.items ?? [];
  const tableRows: DataTableRow[] = rows.map((row) => ({
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
        onSearch={(nextSearch) => {
          requestGate.current.invalidate();
          setSearch(nextSearch);
          setCursor(undefined);
          setAuthority((current) => authorityRequestStarted(
            current,
            presetsQueryKey(nextSearch, type),
          ));
        }}
        search={search}
        searchPlaceholder={t("Search by name")}
        selects={[
          {
            name: t("Type"),
            value: type,
            onChange: (nextType) => {
              requestGate.current.invalidate();
              setType(nextType);
              setCursor(undefined);
              setAuthority((current) => authorityRequestStarted(
                current,
                presetsQueryKey(search, nextType),
              ));
            },
            options: [
              { value: "all", label: t("All") },
              ...PRESET_TYPES.map((presetType) => ({ value: presetType, label: value(presetType) })),
            ],
          },
        ]}
      />
      {authority.error ? <AuthorityRequestError message={authority.error} onRetry={() => void reload(cursor)} snapshotAt={authority.data ? authority.refreshedAt : null} /> : null}
      {authority.loading && authority.data === null ? (
        <p className="text-sm text-[var(--ad-text-muted)]">{t("Loading…")}</p>
      ) : authority.data ? (
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
      ) : null}
      <div className="mt-4 flex justify-end"><button className="min-h-10 rounded-md border border-[var(--ad-border)] px-4 text-sm font-semibold disabled:opacity-50" disabled={authority.loading || !authority.data?.pageInfo.hasNextPage || !authority.data.pageInfo.endCursor} onClick={() => {
        const nextCursor = authority.data?.pageInfo.endCursor ?? undefined;
        requestGate.current.invalidate();
        setCursor(nextCursor);
        setAuthority((current) => authorityRequestStarted(
          current,
          presetsQueryKey(search, type, nextCursor),
        ));
      }} type="button">{t("Next page")}</button></div>
    </div>
  );
}

function presetsQueryKey(search: string, type: string, cursor?: string) {
  const params = new URLSearchParams({ limit: "25" });
  if (search.trim()) params.set("search", search.trim());
  if (type !== "all") params.set("type", type);
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}
