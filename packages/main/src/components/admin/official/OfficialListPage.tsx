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
import {
  characterThumbnails, GENDERS, OFFICIAL_LIST, STYLES,
  visualReferenceCount, type OfficialRow, type ThumbAsset,
} from "./official-api";

// SPEC: 官方角色列表页 —— 搜索/筛选 + 卡片网格（头像、名字、风格·年龄、参考图数、状态）。
// INTENT: 浏览页只浏览；创建在 /new，详情在 /<id>（spec §7 列表页）。
export function OfficialListPage() {
  const { t, value } = useAdminI18n();
  const [rows, setRows] = useState<OfficialRow[]>([]);
  const [thumbs, setThumbs] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [gender, setGender] = useState("all");
  const [style, setStyle] = useState("all");
  const [status, setStatus] = useState("all");

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ items: OfficialRow[] }>(OFFICIAL_LIST);
      setRows(data.items);
      // 缩略图尽力而为：拿一页已审核资产做 characterId → 图 的映射，失败不阻塞列表。
      try {
        const assets = await apiGet<{ items: ThumbAsset[] }>(
          "/api/v1/admin/content/assets?status=approved&limit=100",
        );
        setThumbs(characterThumbnails(assets.items));
      } catch {
        setThumbs(new Map());
      }
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
      rows.filter(
        (row) =>
          (search.trim() === "" || row.name.toLowerCase().includes(search.trim().toLowerCase())) &&
          (gender === "all" || row.gender === gender) &&
          (style === "all" || row.style === style) &&
          (status === "all" || row.status === status),
      ),
    [rows, search, gender, style, status],
  );

  const allOption = { value: "all", label: t("All") };
  return (
    <div>
      <PageHeader
        action={
          <Link href="/admin/content/official/new">
            <PrimaryButton>
              <Plus className="h-4 w-4" /> {t("New official character")}
            </PrimaryButton>
          </Link>
        }
        purpose={t("Manage official character profiles and publishing.")}
        title={t("Official Characters")}
      />
      <FilterBar
        onSearch={setSearch}
        search={search}
        searchPlaceholder={t("Search by name")}
        selects={[
          { name: t("Gender"), value: gender, onChange: setGender,
            options: [allOption, ...GENDERS.map((g) => ({ value: g, label: value(g) }))] },
          { name: t("Style"), value: style, onChange: setStyle,
            options: [allOption, ...STYLES.map((s) => ({ value: s, label: value(s) }))] },
          { name: t("Status"), value: status, onChange: setStatus,
            options: [allOption,
              { value: "approved", label: value("approved") },
              { value: "draft", label: value("draft") },
              { value: "archived", label: value("archived") }] },
        ]}
      />
      {error ? <p className="mb-4 text-sm text-[var(--ad-red-text)]">{error}</p> : null}
      {loading ? (
        <p className="text-sm text-[var(--ad-text-muted)]">{t("Loading…")}</p>
      ) : filtered.length === 0 ? (
        <EmptyState
          action={
            <Link href="/admin/content/official/new">
              <PrimaryButton>
                <Plus className="h-4 w-4" /> {t("New official character")}
              </PrimaryButton>
            </Link>
          }
          hint={t("Create the first official character to get started.")}
          title={t("No official characters yet.")}
        />
      ) : (
        <CardGrid>
          {filtered.map((row) => (
            <EntityCard
              href={`/admin/content/official/${row.id}`}
              image={thumbs.get(row.id)}
              key={row.id}
              meta={
                <span>
                  {value(row.style)} · {row.age} · {visualReferenceCount(row)} {t("reference images")}
                </span>
              }
              status={row.status}
              title={row.name}
            />
          ))}
        </CardGrid>
      )}
    </div>
  );
}
