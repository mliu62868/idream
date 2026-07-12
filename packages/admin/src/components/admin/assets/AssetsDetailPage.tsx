"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { DetailPage, DetailSection } from "@/components/admin/ui/DetailPage";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { FormSection, Field, INPUT_CLASS, TEXTAREA_CLASS } from "@/components/admin/ui/FormPage";
import { DangerButton, GhostButton, PrimaryButton } from "@/components/admin/ui/buttons";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { AssetImage } from "@/components/admin/ui/AssetImage";
import { EngineeringDetails } from "@/components/admin/generation/EngineeringDetails";
import {
  ASSETS_LIST,
  assetPatchPayload,
  draftFromAsset,
  type AssetDraft,
  type ContentAsset,
} from "./assets-api";

// SPEC: 图片库详情页 —— 大图 + 元数据（用途/目标/尺寸/标签描述）+ 生产溯源（生成任务/批次）+
// 审核动作（通过/保存/拒绝/归档），spec §7 详情页的图片库变体。
// INTENT: 无单条 GET，复用列表接口按 id 过滤（与其余三件套架构一致；后端其实有单条 GET，但为
// 一致性仍走 list+find）。标签/描述没有独立编辑态——原样保留 旧图片库视图 "随时可改、四个
// 动作都读当前输入框内容" 的交互，不强加 Starters/Recipes 那套 view/edit 模式切换（这里只有两个
// 自由文本字段，加一层模式切换纯属多余）。
// INVARIANTS: assetPatchSchema（content-ops.ts:90-97）要求 reason（≥3 字符）且
// confirmation===完整 id——四个写动作全部原样搬运 旧图片库视图 的 PATCH body 构造
// （patchAsset:540 / saveAssetMetadata:561），全部走 ConfirmDialog 采集 reason。拒绝/归档是
// 破坏性操作，要求输入短 id 确认——资产没有名字，用 id 前 8 位代替（T16 例外，ConfirmDialog
// 的 summary 说明这一点）。
type PendingAction = "approve" | "save" | "reject" | "archive" | null;

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

export function AssetsDetailPage({ canReview, id }: { canReview: boolean; id: string }) {
  const { t, value } = useAdminI18n();
  const [rows, setRows] = useState<ContentAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);
  const [draft, setDraft] = useState<AssetDraft>({ tags: "", description: "" });
  const [draftAssetId, setDraftAssetId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ asset: ContentAsset }>(`${ASSETS_LIST}/${encodeURIComponent(id)}`);
      setRows([data.asset]);
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

  // 拿到这个资产（首次加载，或 id 变化切到另一个资产）时把草稿同步成服务端当前值；渲染期间
  // 条件 setState 是 React 官方推荐的"依据 prop/加载值调整 state"写法，不用 effect（effect 里
  // 同步 setState 会触发级联渲染，构建期 react-hooks/set-state-in-effect 规则会拦）。之后同一个
  // 资产的后续 reload()（四个审核动作提交后都会触发）不会覆盖草稿——避免打断正在输入的内容。
  if (row && row.id !== draftAssetId) {
    setDraftAssetId(row.id);
    setDraft(draftFromAsset(row));
  }

  const shortId = id.slice(0, 8);

  const confirmSpec: ConfirmSpec | null = useMemo(() => {
    if (!row || !pending) return null;
    const shortIdSummary = t("Assets have no name — type the first 8 characters of the ID to confirm.");
    if (pending === "approve") {
      return {
        title: t("Approve"),
        submitLabel: t("Approve"),
        onSubmit: async (reason) => {
          await apiWrite(`${ASSETS_LIST}/${id}`, "PATCH", assetPatchPayload({ id, draft, reason, status: "approved" }));
          await reload();
        },
      };
    }
    if (pending === "save") {
      return {
        title: t("Save"),
        submitLabel: t("Save"),
        onSubmit: async (reason) => {
          await apiWrite(`${ASSETS_LIST}/${id}`, "PATCH", assetPatchPayload({ id, draft, reason }));
          await reload();
        },
      };
    }
    if (pending === "reject") {
      return {
        title: t("Reject"),
        summary: shortIdSummary,
        destructive: { expectedName: shortId },
        submitLabel: t("Reject"),
        onSubmit: async (reason) => {
          await apiWrite(`${ASSETS_LIST}/${id}`, "PATCH", assetPatchPayload({ id, draft, reason, status: "rejected" }));
          await reload();
        },
      };
    }
    return {
      title: t("Archive"),
      summary: shortIdSummary,
      destructive: { expectedName: shortId },
      submitLabel: t("Archive"),
      onSubmit: async (reason) => {
        await apiWrite(`${ASSETS_LIST}/${id}`, "PATCH", assetPatchPayload({ id, draft, reason, status: "archived" }));
        await reload();
      },
    };
  }, [pending, row, id, draft, shortId, t, reload]);

  if (loading) {
    return <p className="text-sm text-[var(--ad-text-muted)]">{t("Loading…")}</p>;
  }

  if (!row) {
    return (
      <EmptyState
        action={
          <Link href="/admin/content/assets">
            <PrimaryButton>{t("Back to image library")}</PrimaryButton>
          </Link>
        }
        hint={error ?? undefined}
        title={t("Asset not found.")}
      />
    );
  }

  const actions = canReview ? (
    <>
      <GhostButton onClick={() => setPending("save")}>{t("Save")}</GhostButton>
      <PrimaryButton onClick={() => setPending("approve")}>{t("Approve")}</PrimaryButton>
      <DangerButton onClick={() => setPending("reject")}>{t("Reject")}</DangerButton>
      <DangerButton onClick={() => setPending("archive")}>{t("Archive")}</DangerButton>
    </>
  ) : null;

  return (
    <DetailPage
      actions={actions}
      backHref="/admin/content/assets"
      backLabel={t("Back to image library")}
      status={row.platformStatus}
      title={shortId}
    >
      {error ? <p role="alert" className="text-sm text-[var(--ad-red-text)]">{error}</p> : null}

      <AssetImage asset={row} />

      <DetailSection title={t("Basic info")}>
        <InfoGrid
          items={[
            { label: t("Purpose"), value: row.purpose ? value(row.purpose) : "—" },
            { label: t("Target type"), value: row.targetType ? value(row.targetType) : "—" },
            { label: t("Target ID"), value: row.targetId ?? "—" },
            { label: t("Size"), value: `${row.width ?? "—"} × ${row.height ?? "—"}` },
          ]}
        />
      </DetailSection>

      <FormSection
        hint={t("Tags and descriptions make assets searchable for chat reuse.")}
        title={t("Description & tags")}
      >
        <Field full label={t("Tags")}>
          <input
            className={INPUT_CLASS}
            onChange={(event) => setDraft({ ...draft, tags: event.target.value })}
            value={draft.tags}
          />
        </Field>
        <Field full label={t("Description")}>
          <textarea
            className={TEXTAREA_CLASS}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            value={draft.description}
          />
        </Field>
      </FormSection>

      <DetailSection title={t("Source")}>
        <InfoGrid
          items={[
            { label: t("Generation job"), value: row.sourceJob ? value(row.sourceJob.status) : "—" },
            { label: t("Profile"), value: row.sourceJob?.profileId ?? "—" },
            { label: t("Batch"), value: row.sourceBatch?.title ?? "—" },
          ]}
        />
      </DetailSection>

      <EngineeringDetails summary={t("Asset details")}>
        <div>{t("Media asset")}: {row.id}</div>
        <pre className="mt-2 whitespace-pre-wrap">{JSON.stringify(row.sourceJob, null, 2)}</pre>
      </EngineeringDetails>

      {confirmSpec ? <ConfirmDialog onClose={() => setPending(null)} spec={confirmSpec} /> : null}
    </DetailPage>
  );
}
