"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, ImageIcon, Plus } from "lucide-react";
import { apiGet } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { FilterBar } from "@/components/admin/ui/FilterBar";
import { GhostButton, PrimaryButton } from "@/components/admin/ui/buttons";
import { StatusPill } from "@/components/admin/ui/StatusPill";
import type { WorkspaceHistoryMode } from "@/lib/admin-v2-api";
import { cn } from "@/lib/utils";
import {
  characterReadiness,
  characterThumbnails,
  GENDERS,
  OFFICIAL_LIST,
  STYLES,
  visualReferenceCount,
  type OfficialRow,
  type ThumbAsset,
  visualSourceImage,
} from "./official-api";
import {
  buildOfficialListApiQuery,
  defaultOfficialListQuery,
  observeOfficialListUrl,
  parseOfficialListQuery,
  type OfficialListQuery,
  writeOfficialListUrl,
} from "./query";
import { OfficialListEmptyState } from "./OfficialListEmptyState";

type ListResponse = {
  items: OfficialRow[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(
    new Date(value),
  );
}

function nextAction(row: OfficialRow, readiness: ReturnType<typeof characterReadiness>): string {
  if (row.status === "archived") return "Review and restore";
  const next = readiness.missing[0];
  if (next === "Core profile") return "Complete profile";
  if (next === "Persona") return "Write persona";
  if (next === "Visual direction") return "Add visual brief";
  if (next === "Visual identity") return "Lock identity";
  if (next === "Reference images") return "Add references";
  if (next === "Published artwork") return "Create artwork";
  if (row.status === "draft") return "Review for release";
  return "Open workspace";
}

export function OfficialListPage() {
  const { t, value } = useAdminI18n();
  const [rows, setRows] = useState<OfficialRow[]>([]);
  const [thumbs, setThumbs] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [listQuery, setListQuery] = useState<OfficialListQuery>(defaultOfficialListQuery);
  const [queryReady, setQueryReady] = useState(false);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const { gender, page, search, status, style } = listQuery;
  const filtered = Boolean(
    search.trim() || gender !== "all" || style !== "all" || status !== "all" || page > 1,
  );

  const query = useMemo(() => buildOfficialListApiQuery(listQuery).toString(), [listQuery]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [data, assets] = await Promise.all([
        apiGet<ListResponse>(`${OFFICIAL_LIST}?${query}`),
        apiGet<{ items: ThumbAsset[] }>("/api/v1/admin/content/assets?status=approved&limit=100"),
      ]);
      setRows(data.items);
      setTotal(data.total);
      setTotalPages(data.totalPages);
      setThumbs(characterThumbnails(assets.items));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("Request failed"));
    } finally {
      setLoading(false);
    }
  }, [query, t]);

  useEffect(() => {
    const read = () => parseOfficialListQuery(new URLSearchParams(window.location.search));
    const restore = (next: OfficialListQuery) => {
      setListQuery(next);
      setQueryReady(true);
    };
    restore(read());
    return observeOfficialListUrl(window, restore);
  }, []);

  useEffect(() => {
    if (!queryReady) return;
    const timer = window.setTimeout(() => void reload(), search.trim() ? 220 : 0);
    return () => window.clearTimeout(timer);
  }, [queryReady, reload, search]);

  function navigate(next: OfficialListQuery, mode: WorkspaceHistoryMode) {
    setListQuery(next);
    writeOfficialListUrl(next, mode);
  }

  function updateFilter(patch: Partial<OfficialListQuery>, mode: WorkspaceHistoryMode) {
    navigate({ ...listQuery, ...patch, page: 1 }, mode);
  }

  const allOption = { value: "all", label: t("All") };

  return (
    <div>
      <PageHeader
        action={
          <Link href="/admin/content/official/new">
            <PrimaryButton>
              <Plus className="h-4 w-4" />  {t("New character project")}
            </PrimaryButton>
          </Link>
        }
        purpose="Run official characters from private draft through visual production, preview, and publishing."
        title={t("Official Characters")}
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <FilterBar
          onSearch={(value) => updateFilter({ search: value }, "replace")}
          search={search}
          searchPlaceholder="Search name or character ID"
          selects={[
            { name: t("Gender"), value: gender, onChange: (next) => updateFilter({ gender: next as OfficialListQuery["gender"] }, "push"), options: [allOption, ...GENDERS.map((item) => ({ value: item, label: value(item) }))] },
            { name: t("Style"), value: style, onChange: (next) => updateFilter({ style: next as OfficialListQuery["style"] }, "push"), options: [allOption, ...STYLES.map((item) => ({ value: item, label: value(item) }))] },
            { name: t("Status"), value: status, onChange: (next) => updateFilter({ status: next as OfficialListQuery["status"] }, "push"), options: [allOption, { value: "draft", label: "Draft" }, { value: "approved", label: value("approved") }, { value: "archived", label: value("archived") }] },
          ]}
        />
        <p className="text-xs tabular-nums text-[var(--ad-text-muted)]">{total}  {t("characters")}</p>
      </div>

      {error ? <p role="alert" className="mb-4 text-sm text-[var(--ad-red-text)]">{error}</p> : null}

      {loading ? (
        <div aria-label={t("Loading characters")} className="space-y-2">
          {[0, 1, 2, 3, 4].map((item) => <div className="h-16 animate-pulse rounded-lg bg-black/[0.04]" key={item} />)}
        </div>
      ) : rows.length === 0 ? (
        <OfficialListEmptyState
          filtered={filtered}
          onClear={() => navigate(defaultOfficialListQuery, "push")}
        />
      ) : (
        <section className="overflow-hidden rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] border-collapse text-left">
              <caption className="sr-only">{t("Official characters")}</caption>
              <thead className="bg-black/[0.025] text-[11px] uppercase tracking-wide text-[var(--ad-text-muted)]">
                <tr>
                  <th scope="col" className="border-b border-[var(--ad-border)] px-4 py-3 font-semibold">{t("Character")}</th>
                  <th scope="col" className="border-b border-[var(--ad-border)] px-3 py-3 font-semibold">{t("Stage")}</th>
                  <th scope="col" className="border-b border-[var(--ad-border)] px-3 py-3 font-semibold">{t("Readiness")}</th>
                  <th scope="col" className="border-b border-[var(--ad-border)] px-3 py-3 font-semibold">{t("Visuals")}</th>
                  <th scope="col" className="border-b border-[var(--ad-border)] px-3 py-3 font-semibold">{t("Performance")}</th>
                  <th scope="col" className="border-b border-[var(--ad-border)] px-3 py-3 font-semibold">{t("Updated")}</th>
                  <th scope="col" className="border-b border-[var(--ad-border)] px-4 py-3 text-right font-semibold">{t("Next step")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const thumbnail = thumbs.get(row.id) ?? visualSourceImage(row) ?? undefined;
                  const readiness = characterReadiness(row, Boolean(row.imageAssetId));
                  return (
                    <tr className="border-b border-[var(--ad-border)] last:border-0 hover:bg-black/[0.018]" key={row.id}>
                      <td className="px-4 py-3">
                        <div className="flex min-w-0 items-center gap-3">
                          <div className="grid h-12 w-10 shrink-0 place-items-center overflow-hidden rounded-md bg-black/[0.04] text-sm font-semibold text-[var(--ad-text-muted)]">
                            {thumbnail ? (
                              // eslint-disable-next-line @next/next/no-img-element -- admin blob URLs are not compatible with next/image optimization
                              <img alt={row.name} className="h-full w-full object-cover" loading="lazy" src={thumbnail} />
                            ) : row.name.slice(0, 1).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <Link className="block max-w-[280px] truncate text-sm font-semibold text-[var(--ad-ink)] hover:underline" href={`/admin/content/official/${row.id}`} title={row.name}>
                              {row.name}
                            </Link>
                            <p className="mt-1 text-xs text-[var(--ad-text-muted)]">{value(row.style)} · {row.age} · {value(row.gender)}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3"><StatusPill status={row.status} /></td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2">
                          <progress
                            aria-label={t("{score}% ready", { score: readiness.score })}
                            className={cn("h-1.5 w-20 overflow-hidden rounded-full accent-[var(--ad-ink)]", readiness.score >= 80 && "accent-[var(--ad-green-text)]")}
                            max={100}
                            value={readiness.score}
                          />
                          <span className="text-xs tabular-nums text-[var(--ad-text)]">{readiness.score}%</span>
                        </div>
                        <p className="mt-1 max-w-[180px] truncate text-[11px] text-[var(--ad-text-muted)]" title={readiness.missing.join(", ")}>{readiness.missing[0] ? t("Next: {item}", { item: t(readiness.missing[0]) }) : t("Ready for release")}</p>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2 text-xs text-[var(--ad-text)]"><ImageIcon className="h-3.5 w-3.5 text-[var(--ad-text-muted)]" /> {visualReferenceCount(row)}  {t("references")}</div>
                        <p className="mt-1 text-[11px] text-[var(--ad-text-muted)]">{t("Identity v")}{row.visualProfile?.version ?? "—"}</p>
                      </td>
                      <td className="px-3 py-3 text-xs tabular-nums text-[var(--ad-text)]">
                        <span>{row.stats?.chatsCount.toLocaleString() ?? "—"}  {t("chats")}</span>
                        <span className="ml-2 text-[var(--ad-text-muted)]">{row.stats?.likesCount.toLocaleString() ?? "—"}  {t("likes")}</span>
                      </td>
                      <td className="px-3 py-3 text-xs text-[var(--ad-text-muted)]">{formatDate(row.updatedAt)}</td>
                      <td className="px-4 py-3 text-right">
                        <Link className="inline-flex h-8 items-center rounded-md border border-[var(--ad-border)] px-3 text-xs font-medium text-[var(--ad-text)] hover:border-[var(--ad-ink)]" href={`/admin/content/official/${row.id}`}>
                          {nextAction(row, readiness)}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {totalPages > 1 ? (
        <div className="mt-4 flex items-center justify-between gap-3">
          <p className="text-xs tabular-nums text-[var(--ad-text-muted)]">{t("Page")} {page}  {t("of")} {totalPages}</p>
          <div className="flex gap-2">
            <GhostButton disabled={page <= 1 || loading} onClick={() => navigate({ ...listQuery, page: Math.max(1, page - 1) }, "push")}><ChevronLeft className="h-4 w-4" />  {t("Previous")}</GhostButton>
            <GhostButton disabled={page >= totalPages || loading} onClick={() => navigate({ ...listQuery, page: Math.min(totalPages, page + 1) }, "push")}>{t("Next")} <ChevronRight className="h-4 w-4" /></GhostButton>
          </div>
        </div>
      ) : null}
    </div>
  );
}
