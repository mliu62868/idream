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
  assetAuthorityDependencyView,
  assetPatchPayload,
  draftFromAsset,
  type AssetDraft,
  type ContentAsset,
} from "./assets-api";
import { MediaAssetAuthorityNotice } from "./MediaAssetAuthority";

// Image Library manages searchable metadata and safe archival only. Immutable
// approve/reject decisions belong to Creative Runs; every active production,
// Character, Release, and Campaign dependency must be repaired before archival.
type PendingAction = "save" | "archive" | null;

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
  const [refreshWarning, setRefreshWarning] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);
  const [draft, setDraft] = useState<AssetDraft>({ tags: "", description: "" });
  const [draftAssetId, setDraftAssetId] = useState<string | null>(null);

  const reload = useCallback(async (propagateError = false) => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ asset: ContentAsset }>(`${ASSETS_LIST}/${encodeURIComponent(id)}`);
      setRows([data.asset]);
      setRefreshWarning(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("Request failed"));
      if (propagateError) throw loadError;
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
    if (pending === "save") {
      return {
        title: t("Save"),
        submitLabel: t("Save"),
        onSubmit: async (reason) => {
          await apiWrite(`${ASSETS_LIST}/${id}`, "PATCH", assetPatchPayload({ id, draft, reason }));
          try {
            await reload(true);
          } catch (refreshError) {
            setError(null);
            setRefreshWarning(
              refreshError instanceof Error
                ? `${t("Asset changes were committed, but the latest projection could not be refreshed:")} ${refreshError.message}. ${t("Use Refresh before another write.")}`
                : t("Asset changes were committed, but the latest projection could not be refreshed. Use Refresh before another write."),
            );
          }
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
        try {
          await reload(true);
          } catch (refreshError) {
            setError(null);
            setRefreshWarning(
              refreshError instanceof Error
              ? `${t("Asset archival was committed, but the latest projection could not be refreshed:")} ${refreshError.message}. ${t("Use Refresh before another write.")}`
              : t("Asset archival was committed, but the latest projection could not be refreshed. Use Refresh before another write."),
            );
        }
      },
    };
  }, [pending, row, id, draft, shortId, t, reload]);

  if (loading) {
    return <p className="text-sm text-[var(--ad-text-muted)]">{t("Loading…")}</p>;
  }

  if (!row) {
    if (error) {
      return (
        <div className="rounded-lg bg-[var(--ad-red-bg)] p-4 text-sm text-[var(--ad-red-text)]" role="alert">
          {error}{" "}
          <button className="font-semibold underline" onClick={() => void reload()} type="button">
            {t("Retry")}
          </button>
        </div>
      );
    }
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

  const authorityDependencies = row.authorityDependencies ?? [];
  const hasActiveAuthority = authorityDependencies.length > 0;
  const actions = canReview || refreshWarning ? (
    <>
      {refreshWarning ? <GhostButton onClick={() => void reload()}>{t("Refresh")}</GhostButton> : null}
      {canReview ? <GhostButton disabled={Boolean(refreshWarning)} onClick={() => setPending("save")}>{t("Save")}</GhostButton> : null}
      {canReview ? <DangerButton disabled={hasActiveAuthority || Boolean(refreshWarning)} onClick={() => setPending("archive")}>{t("Archive")}</DangerButton> : null}
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
      {refreshWarning ? <p role="status" className="rounded-lg bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)]">{refreshWarning}</p> : null}

      <MediaAssetAuthorityNotice asset={row} />
      <AssetImage asset={row} />

      <DetailSection title={t("Authority & usage")}>
        {row.sourceBatch ? (
          <div className="rounded-lg bg-[var(--ad-blue-bg)] p-3 text-sm text-[var(--ad-blue-text)]">
            {t("Review decisions are recorded in the immutable Creative Run history.")}{" "}
            <Link className="font-semibold underline" href={`/admin/creative/runs/${row.sourceBatch.id}`}>
              {t("Open Creative Run review")}
            </Link>
          </div>
        ) : null}
        {authorityDependencies.length > 0 ? (
          <div className="mt-3 grid gap-2">
            {authorityDependencies.map((dependency) => {
              const dependencyView = assetAuthorityDependencyView(dependency);
              return (
                <div className="flex flex-col gap-2 rounded-lg border border-[var(--ad-border)] p-3 text-sm sm:flex-row sm:items-center sm:justify-between" key={dependencyView.key}>
                  <div>
                    <strong>{t(dependencyView.title)}</strong>
                    <p className="mt-1 text-xs text-[var(--ad-text-muted)]">{dependencyView.detail}</p>
                  </div>
                  <Link className="text-sm font-semibold underline" href={dependency.repairPath}>{t("Open authority")}</Link>
                </div>
              );
            })}
            <p className="text-xs text-[var(--ad-text-muted)]">{t("Replace, roll back, or withdraw these usages before archiving the asset.")}</p>
          </div>
        ) : (
          <p className="text-sm text-[var(--ad-text-muted)]">{t("This asset is not referenced by an active production, Character, Release, or Campaign authority.")}</p>
        )}
      </DetailSection>

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
