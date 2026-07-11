"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { FilterBar } from "@/components/admin/ui/FilterBar";
import { CardGrid } from "@/components/admin/ui/CardGrid";
import { StatusPill } from "@/components/admin/ui/StatusPill";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { AssetImage } from "@/components/admin/ui/AssetImage";
import { ASSET_PURPOSES, ASSET_STATUSES, assetsListPath, type ContentAsset } from "./assets-api";

// SPEC: 图片库列表页 —— 状态/用途走服务端查询参数拼接（沿用 旧图片库视图 原有筛选方式，不改
// 成客户端过滤——资产量可观，服务端筛更省），标签/描述/id 关键词走客户端二次过滤（新增，复用运营
// 已经在维护的检索元数据，满足 FilterBar 必填 search 的同时不折损任何既有能力）。图片网格
// （AssetImage + 状态 pill + purpose 一行），点卡进详情页。
// INTENT: 浏览页只浏览；审核动作（通过/保存/拒绝/归档）搬到详情页——旧图片库视图 原本把这些
// 动作和标签/描述编辑框直接摆在每张卡片上，现在随点卡进详情统一处理（capability 仍在，只是换了
// 落脚点；与 Starters/Recipes/Presets 的 list=浏览、detail=编辑 分工一致）。
export function AssetsListPage() {
  const { t, value } = useAdminI18n();
  const [rows, setRows] = useState<ContentAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("all");
  const [purpose, setPurpose] = useState("all");
  const [search, setSearch] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ items: ContentAsset[] }>(assetsListPath({ status, purpose }));
      setRows(data.items);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("Request failed"));
    } finally {
      setLoading(false);
    }
  }, [purpose, status, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void reload();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [reload]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((asset) => {
      const haystack = [asset.id, asset.description ?? "", ...asset.tags].join(" ").toLowerCase();
      return haystack.includes(term);
    });
  }, [rows, search]);

  return (
    <div>
      <PageHeader purpose={t("Browse and curate generated image assets.")} title={t("Image Library")} />
      <FilterBar
        onSearch={setSearch}
        search={search}
        searchPlaceholder={t("Search by tag, description, or asset ID")}
        selects={[
          {
            name: t("Status"),
            value: status,
            onChange: setStatus,
            options: [
              { value: "all", label: t("All") },
              ...ASSET_STATUSES.map((item) => ({ value: item, label: value(item) })),
            ],
          },
          {
            name: t("Purpose"),
            value: purpose,
            onChange: setPurpose,
            options: [
              { value: "all", label: t("All") },
              ...ASSET_PURPOSES.map((item) => ({ value: item, label: value(item) })),
            ],
          },
        ]}
      />
      {error ? <p className="mb-4 text-sm text-[var(--ad-red-text)]">{error}</p> : null}
      {loading ? (
        <p className="text-sm text-[var(--ad-text-muted)]">{t("Loading…")}</p>
      ) : filtered.length === 0 ? (
        <EmptyState title={t("No platform assets match these filters.")} />
      ) : (
        <CardGrid>
          {filtered.map((asset) => (
            <AssetCard asset={asset} key={asset.id} />
          ))}
        </CardGrid>
      )}
    </div>
  );
}

function AssetCard({ asset }: { asset: ContentAsset }) {
  const { value } = useAdminI18n();
  return (
    <Link
      className="group overflow-hidden rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] transition-shadow hover:shadow-[var(--ad-shadow-hover)]"
      href={`/admin/content/assets/${asset.id}`}
    >
      <AssetImage asset={asset} />
      <div className="space-y-1.5 p-4">
        <StatusPill status={asset.platformStatus} />
        <p className="truncate text-xs text-[var(--ad-text-muted)]">
          {asset.purpose ? value(asset.purpose) : "—"}
        </p>
      </div>
    </Link>
  );
}
