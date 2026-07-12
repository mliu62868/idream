"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { DetailPage, DetailSection } from "@/components/admin/ui/DetailPage";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { DangerButton, GhostButton, PrimaryButton } from "@/components/admin/ui/buttons";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { AssetImage } from "@/components/admin/ui/AssetImage";
import { EngineeringDetails } from "@/components/admin/generation/EngineeringDetails";
import {
  PATCH_ACTIONS,
  PLACEMENTS_BASE,
  placementPatchPayload,
  type Placement,
} from "./placements-api";

// SPEC: 铺位详情页 —— 字段 + 关联资产预览 + 发布/暂停/归档（spec §7 详情页）。
// INTENT: 无单条 GET，复用列表接口按 id 过滤（与其余三件套架构一致）；铺位没有可编辑字段
// （slot/targetType/targetId 由创建时定死），详情页只做状态流转，没有 view/edit 模式切换。
// INVARIANTS: placementPatchSchema（content-ops.ts:120-126）要求 reason（≥3 字符）—— 三个动作全部
// 走 ConfirmDialog 采集 reason；归档是破坏性操作（archived 后铺位不再生效），要求输入 slot 打对——
// 铺位没有名字，用 slot 代替（T16 图片库同款例外）。
type PendingAction = (typeof PATCH_ACTIONS)[number] | null;

function InfoGrid({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
      {items.map((item) => (
        <div key={item.label}>
          <dt className="text-xs text-[var(--ad-text-muted)]">{item.label}</dt>
          <dd className="mt-0.5 text-sm text-[var(--ad-ink)]">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function PlacementsDetailPage({ canPublish, id }: { canPublish: boolean; id: string }) {
  const { t, value } = useAdminI18n();
  const [rows, setRows] = useState<Placement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ placement: Placement }>(`${PLACEMENTS_BASE}/${encodeURIComponent(id)}`);
      setRows([data.placement]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("Request failed"));
    } finally {
      setLoading(false);
    }
  }, [id, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void reload();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [reload]);

  const row = useMemo(() => rows.find((item) => item.id === id), [rows, id]);

  const confirmSpec: ConfirmSpec | null = useMemo(() => {
    if (!row || !pending) return null;
    if (pending === "published") {
      return {
        title: t("Publish"),
        submitLabel: t("Publish"),
        onSubmit: async (reason) => {
          await apiWrite(`${PLACEMENTS_BASE}/${id}`, "PATCH", placementPatchPayload(id, "published", reason));
          await reload();
        },
      };
    }
    if (pending === "paused") {
      return {
        title: t("Pause"),
        submitLabel: t("Pause"),
        onSubmit: async (reason) => {
          await apiWrite(`${PLACEMENTS_BASE}/${id}`, "PATCH", placementPatchPayload(id, "paused", reason));
          await reload();
        },
      };
    }
    return {
      title: t("Archive"),
      destructive: { expectedName: row.slot },
      submitLabel: t("Archive"),
      onSubmit: async (reason) => {
        await apiWrite(`${PLACEMENTS_BASE}/${id}`, "PATCH", placementPatchPayload(id, "archived", reason));
        await reload();
      },
    };
  }, [pending, row, id, t, reload]);

  if (loading) {
    return <p className="text-sm text-[var(--ad-text-muted)]">{t("Loading…")}</p>;
  }

  if (!row) {
    return (
      <EmptyState
        action={
          <Link href="/admin/content/placements">
            <PrimaryButton>{t("Back to placements")}</PrimaryButton>
          </Link>
        }
        hint={error ?? undefined}
        title={t("Placement not found.")}
      />
    );
  }

  const actions = canPublish ? (
    <>
      <GhostButton onClick={() => setPending("paused")}>{t("Pause")}</GhostButton>
      <PrimaryButton onClick={() => setPending("published")}>{t("Publish")}</PrimaryButton>
      <DangerButton onClick={() => setPending("archived")}>{t("Archive")}</DangerButton>
    </>
  ) : null;

  return (
    <DetailPage
      actions={actions}
      backHref="/admin/content/placements"
      backLabel={t("Back to placements")}
      status={row.status}
      title={value(row.slot)}
    >
      {error ? <p className="text-sm text-[var(--ad-red-text)]">{error}</p> : null}

      <AssetImage asset={row.asset} />

      <DetailSection title={t("Basic info")}>
        <InfoGrid
          items={[
            { label: t("Slot"), value: value(row.slot) },
            { label: t("Target type"), value: value(row.targetType) },
            { label: t("Target ID"), value: row.targetId },
            { label: t("Published"), value: row.publishedAt ? new Date(row.publishedAt).toLocaleString() : "—" },
          ]}
        />
      </DetailSection>

      <EngineeringDetails summary={t("Placement details")}>
        <div>{t("Placement ID")}: {row.id}</div>
        <div>{t("Media asset")}: {row.mediaAssetId}</div>
      </EngineeringDetails>

      {confirmSpec ? <ConfirmDialog onClose={() => setPending(null)} spec={confirmSpec} /> : null}
    </DetailPage>
  );
}
