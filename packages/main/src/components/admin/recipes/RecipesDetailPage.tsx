"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { DetailPage, DetailSection } from "@/components/admin/ui/DetailPage";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { FormSection, Field, INPUT_CLASS, TEXTAREA_CLASS } from "@/components/admin/ui/FormPage";
import { DangerButton, GhostButton, PrimaryButton } from "@/components/admin/ui/buttons";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { EngineeringDetails } from "@/components/admin/generation/EngineeringDetails";
import {
  MODES,
  RECIPES_LIST,
  USE_CASES,
  recipeDraftPayload,
  recipeStateLabelKey,
  type Recipe,
  type RecipeDraft,
} from "./recipes-api";

// SPEC: 提示词配方详情页 —— 查看 + 就地编辑（仅 draft）+ 发布/回滚（spec §7 详情页）。
// INTENT: 无单条 GET，复用列表接口按 id 过滤。PATCH 无 reason 字段且后端审计不记 reason
// （recipePatchSchema 契约），Save 直接 PATCH——不弹 ConfirmDialog 采集一个去不了后端的
// reason。发布/回滚的后端确实收 reason，保留 ConfirmDialog。
type Mode = "view" | "edit";
type PendingAction = "publish" | "rollback" | null;

function draftFromRow(row: Recipe): RecipeDraft {
  const modes: readonly string[] = MODES;
  const useCases: readonly string[] = USE_CASES;
  return {
    recipeKey: row.recipeKey,
    label: row.label,
    mode: (modes.includes(row.mode) ? row.mode : MODES[0]) as RecipeDraft["mode"],
    useCase: (useCases.includes(row.useCase) ? row.useCase : USE_CASES[0]) as RecipeDraft["useCase"],
    body: row.body,
    negativeBase: row.negativeBase ?? "",
  };
}

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

export function RecipesDetailPage({ id }: { id: string }) {
  const { t, value } = useAdminI18n();
  const [rows, setRows] = useState<Recipe[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("view");
  const [draft, setDraft] = useState<RecipeDraft | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ items: Recipe[] }>(RECIPES_LIST);
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

  const row = useMemo(() => rows.find((item) => item.id === id), [rows, id]);
  const canEdit = row?.status === "draft";

  function startEdit(current: Recipe) {
    setDraft(draftFromRow(current));
    setMode("edit");
  }

  function cancelEdit() {
    setDraft(null);
    setMode("view");
  }

  function updateDraft<K extends keyof RecipeDraft>(key: K, next: RecipeDraft[K]) {
    setDraft((prev) => (prev ? { ...prev, [key]: next } : prev));
  }

  // Save 直接 PATCH：后端 PATCH 契约无 reason，可写门槛已由 status==="draft" 把住；
  // 失败就地显示在页面 error 条，不关编辑态。
  async function save() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      await apiWrite(`${RECIPES_LIST}/${id}`, "PATCH", recipeDraftPayload(draft));
      await reload();
      setMode("view");
      setDraft(null);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t("Request failed"));
    } finally {
      setSaving(false);
    }
  }

  const confirmSpec: ConfirmSpec | null = useMemo(() => {
    if (!row || !pending) return null;
    if (pending === "publish") {
      return {
        title: t("Publish recipe"),
        submitLabel: t("Publish"),
        onSubmit: async (reason) => {
          await apiWrite(`${RECIPES_LIST}/${id}/publish`, "POST", {
            reason,
            confirmation: id,
            dryRunSummary: { source: "admin_console" },
          });
          await reload();
        },
      };
    }
    return {
      title: t("Rollback recipe"),
      destructive: { expectedName: row.label || id },
      submitLabel: t("Rollback"),
      onSubmit: async (reason) => {
        await apiWrite(`${RECIPES_LIST}/${id}/rollback`, "POST", { reason, confirmation: id });
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
          <Link href="/admin/generation/recipes">
            <PrimaryButton>{t("Back to prompt recipes")}</PrimaryButton>
          </Link>
        }
        hint={error ?? undefined}
        title={t("Recipe not found.")}
      />
    );
  }

  const editButton = canEdit ? (
    <GhostButton onClick={() => startEdit(row)}>{t("Edit profile")}</GhostButton>
  ) : (
    <GhostButton disabled title={t("Only draft recipes can be edited.")}>
      {t("Edit profile")}
    </GhostButton>
  );

  const actions =
    mode === "edit" ? (
      <>
        <GhostButton disabled={saving} onClick={cancelEdit}>{t("Cancel")}</GhostButton>
        <PrimaryButton disabled={saving} onClick={() => void save()}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {t("Save changes")}
        </PrimaryButton>
      </>
    ) : (
      <>
        {editButton}
        {row.status === "draft" ? (
          <PrimaryButton onClick={() => setPending("publish")}>{t("Publish")}</PrimaryButton>
        ) : null}
        {row.status === "active" ? (
          <DangerButton onClick={() => setPending("rollback")}>{t("Rollback")}</DangerButton>
        ) : null}
      </>
    );

  return (
    <DetailPage
      actions={actions}
      backHref="/admin/generation/recipes"
      backLabel={t("Back to prompt recipes")}
      status={row.status}
      statusLabel={t(recipeStateLabelKey(row))}
      title={row.label}
    >
      {error ? <p className="text-sm text-[var(--ad-red-text)]">{error}</p> : null}

      {mode === "edit" && draft ? (
        <>
          <FormSection title={t("Basic info")}>
            <Field label={t("Recipe Key")}>
              <input
                className={INPUT_CLASS}
                onChange={(event) => updateDraft("recipeKey", event.target.value)}
                value={draft.recipeKey}
              />
            </Field>
            <Field label={t("Label")}>
              <input
                className={INPUT_CLASS}
                onChange={(event) => updateDraft("label", event.target.value)}
                value={draft.label}
              />
            </Field>
            <Field label={t("Mode")}>
              <select
                className={INPUT_CLASS}
                onChange={(event) => updateDraft("mode", event.target.value as RecipeDraft["mode"])}
                value={draft.mode}
              >
                {MODES.map((m) => (
                  <option key={m} value={m}>
                    {value(m)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("Use Case")}>
              <select
                className={INPUT_CLASS}
                onChange={(event) => updateDraft("useCase", event.target.value as RecipeDraft["useCase"])}
                value={draft.useCase}
              >
                {USE_CASES.map((useCase) => (
                  <option key={useCase} value={useCase}>
                    {value(useCase)}
                  </option>
                ))}
              </select>
            </Field>
          </FormSection>
          <FormSection title={t("Body")}>
            <Field full label={t("Body")}>
              <textarea
                className={`${TEXTAREA_CLASS} font-mono`}
                onChange={(event) => updateDraft("body", event.target.value)}
                value={draft.body}
              />
            </Field>
            <Field full label={t("Negative Base")}>
              <textarea
                className={`${TEXTAREA_CLASS} font-mono`}
                onChange={(event) => updateDraft("negativeBase", event.target.value)}
                value={draft.negativeBase}
              />
            </Field>
          </FormSection>
        </>
      ) : (
        <>
          <DetailSection title={t("Basic info")}>
            <InfoGrid
              items={[
                { label: t("Recipe Key"), value: row.recipeKey },
                { label: t("Mode"), value: value(row.mode) },
                { label: t("Use Case"), value: value(row.useCase) },
                { label: t("Version"), value: `v${row.version}` },
              ]}
            />
          </DetailSection>

          <DetailSection title={t("Body")}>
            <p className="whitespace-pre-wrap font-mono text-sm text-[var(--ad-text)]">{row.body}</p>
          </DetailSection>

          <DetailSection title={t("Negative Base")}>
            <p className="whitespace-pre-wrap font-mono text-sm text-[var(--ad-text)]">
              {row.negativeBase || "—"}
            </p>
          </DetailSection>

          <EngineeringDetails summary={t("Recipe details")}>
            <div className="space-y-1">
              <div>{t("Recipe ID")}: {row.id}</div>
              <div>{t("Version")}: v{row.version}</div>
            </div>
            <pre className="mt-2 whitespace-pre-wrap">{JSON.stringify(row, null, 2)}</pre>
          </EngineeringDetails>
        </>
      )}

      {confirmSpec ? <ConfirmDialog onClose={() => setPending(null)} spec={confirmSpec} /> : null}
    </DetailPage>
  );
}
