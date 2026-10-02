"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { AdminV2RequestError, apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { DetailPage, DetailSection } from "@/components/admin/ui/DetailPage";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { FormSection, Field, INPUT_CLASS, TEXTAREA_CLASS } from "@/components/admin/ui/FormPage";
import { DangerButton, GhostButton, PrimaryButton } from "@/components/admin/ui/buttons";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { PermissionNotice } from "@/components/admin/ui/PermissionNotice";
import { useUnsavedChanges } from "@/components/admin/ui/useUnsavedChanges";
import { EngineeringDetails } from "@/components/admin/generation/EngineeringDetails";
import { LoadingWorkspace } from "@/features/operations/WorkspaceUi";
import { InfoGrid, WriteFeedbackBanner, requestErrorMessage, useWriteFeedback } from "@/components/admin/section-kit";
import {
  MODES,
  RECIPES_LIST,
  USE_CASES,
  recipeDraftPayload,
  recipeStateLabelKey,
  type Recipe,
  type RecipeDraft,
} from "./recipes-api";
import { RecipeValidationSection } from "./RecipeValidationSection";

// SPEC: 提示词配方详情页 —— 查看 + 就地编辑（仅 draft）+ 发布/回滚（spec §7 详情页）。
// INTENT: GET 读取精确配方。PATCH 无 reason 字段，Save 直接 PATCH；样本、核验、
// 发布和回滚要求运营理由。发布只接受后端绑定当前输入的真实样本证据。
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

export function RecipesDetailPage({ canWrite, id }: { canWrite: boolean; id: string }) {
  const { t, value } = useAdminI18n();
  const [rows, setRows] = useState<Recipe[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [mode, setMode] = useState<Mode>("view");
  const [draft, setDraft] = useState<RecipeDraft | null>(null);
  const [editBaseline, setEditBaseline] = useState<RecipeDraft | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);
  const [saving, setSaving] = useState(false);
  const [awaitingReadback, setAwaitingReadback] = useState(false);
  const [publishReady, setPublishReady] = useState(false);
  const { feedback, reportSuccess, clearFeedback } = useWriteFeedback();
  const { guard } = useUnsavedChanges(Boolean(draft && !awaitingReadback && JSON.stringify(draft) !== JSON.stringify(editBaseline)));

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotFound(false);
    setPublishReady(false);
    try {
      const data = await apiGet<{ recipe: Recipe }>(`${RECIPES_LIST}/${encodeURIComponent(id)}`);
      setRows([data.recipe]);
      return data.recipe;
    } catch (loadError) {
      setNotFound(loadError instanceof AdminV2RequestError && loadError.status === 404);
      setError(requestErrorMessage(loadError, t));
      return null;
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
  const canEdit = canWrite && !awaitingReadback && row?.status === "draft";
  const editing = canWrite && mode === "edit";

  function startEdit(current: Recipe) {
    if (!canWrite || awaitingReadback) return;
    const nextDraft = draftFromRow(current);
    setDraft(nextDraft);
    setEditBaseline(nextDraft);
    setMode("edit");
  }

  function cancelEdit() {
    if (saving || awaitingReadback) return;
    setDraft(null);
    setMode("view");
  }

  function updateDraft<K extends keyof RecipeDraft>(key: K, next: RecipeDraft[K]) {
    setDraft((prev) => (prev ? { ...prev, [key]: next } : prev));
  }

  // Save 直接 PATCH：后端 PATCH 契约无 reason，可写门槛已由 status==="draft" 把住；
  // 失败就地显示在页面 error 条，不关编辑态。
  async function save() {
    if (!canWrite || saving || awaitingReadback || !draft) return;
    setSaving(true);
    setError(null);
    try {
      await apiWrite(`${RECIPES_LIST}/${id}`, "PATCH", recipeDraftPayload(draft));
      // A confirmed write must never be resent because its readback failed.
      setAwaitingReadback(true);
      const saved = await reload();
      if (!saved) return;
      setAwaitingReadback(false);
      setMode("view");
      setDraft(null);
      reportSuccess(t(saved.status === "draft" ? "Draft saved. {label} stays a draft until you publish it." : "Latest details loaded.", { label: saved.label }));
    } catch (saveError) {
      setError(requestErrorMessage(saveError, t));
    } finally {
      setSaving(false);
    }
  }

  async function retryReadback() {
    if (!(await reload())) return;
    setAwaitingReadback(false);
    setMode("view");
    setDraft(null);
    reportSuccess(t("Latest details loaded."));
  }

  const confirmSpec: ConfirmSpec | null = useMemo(() => {
    if (!canWrite || awaitingReadback || !row || !pending) return null;
    if (pending === "publish") {
      return {
        title: t("Publish recipe"),
        submitLabel: t("Publish"),
        onSubmit: async (reason) => {
          await apiWrite(`${RECIPES_LIST}/${id}/commands/publish`, "POST", {
            reason,
            confirmation: id,
          });
          setAwaitingReadback(true);
          if (!(await reload())) return;
          setAwaitingReadback(false);
          reportSuccess(t(row.mode === "negative"
            ? "{label} is published. Its body supplements matching image recipes for new requests; accepted jobs keep their saved prompts."
            : (row.useCase === "character" || row.useCase === "freeplay")
            ? "{label} is published. New default requests for this media type and use case select it; pinned requests keep their recipe version."
            : "{label} is published and available to generation workflows that select this recipe.", { label: row.label }));
        },
      };
    }
    return {
      title: t("Rollback recipe"),
      destructive: { expectedName: row.label || id },
      submitLabel: t("Rollback"),
      onSubmit: async (reason) => {
        await apiWrite(`${RECIPES_LIST}/${id}/commands/rollback`, "POST", { reason, confirmation: id });
        setAwaitingReadback(true);
        if (!(await reload())) return;
        setAwaitingReadback(false);
        reportSuccess(t("{label} is rolled back and no longer serves generation requests.", { label: row.label }));
      },
    };
  }, [canWrite, awaitingReadback, pending, row, id, t, reload, reportSuccess]);

  if (loading) {
    return <>{guard}<LoadingWorkspace label="Loading…" /></>;
  }

  if (!row) {
    return (
      <>{guard}<EmptyState
        action={
          <div className="flex flex-wrap justify-center gap-2">
            {!notFound ? <PrimaryButton onClick={() => void reload()}>{t("Retry")}</PrimaryButton> : null}
            <Link href="/admin/generation/recipes">
              <GhostButton>{t("Back to prompt recipes")}</GhostButton>
            </Link>
          </div>
        }
        hint={error ?? undefined}
        title={t(notFound ? "Recipe not found." : "Could not load recipe.")}
      /></>
    );
  }

  const editButton = canEdit ? (
    <GhostButton onClick={() => startEdit(row)}>{t("Edit recipe")}</GhostButton>
  ) : (
    <GhostButton disabled title={t("Only draft recipes can be edited.")}>
      {t("Edit recipe")}
    </GhostButton>
  );

  const actions =
    !canWrite ? <PermissionNotice permission="generation.config.write" /> : editing ? (
      <>
        <GhostButton disabled={saving || awaitingReadback} onClick={cancelEdit}>{t("Cancel")}</GhostButton>
        <PrimaryButton disabled={saving || awaitingReadback} onClick={() => void save()}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {t("Save changes")}
        </PrimaryButton>
      </>
    ) : (
      <>
        {editButton}
        {row.status === "draft" ? (
          <PrimaryButton disabled={awaitingReadback || !publishReady} onClick={() => setPending("publish")} title={!publishReady ? t("Run and verify the saved sample matrix before publishing.") : undefined}>{t("Publish")}</PrimaryButton>
        ) : null}
        {row.status === "active" ? (
          <DangerButton disabled={awaitingReadback} onClick={() => setPending("rollback")}>{t("Rollback")}</DangerButton>
        ) : null}
      </>
    );

  return (
    <>{guard}
    <DetailPage
      actions={actions}
      backHref="/admin/generation/recipes"
      backLabel={t("Back to prompt recipes")}
      status={row.status}
      statusLabel={t(recipeStateLabelKey(row))}
      title={row.label}
    >
      <WriteFeedbackBanner feedback={feedback} onDismiss={clearFeedback} />
      {awaitingReadback ? <p role="status" className="text-sm text-[var(--ad-yellow-text)]">{t("Changes were saved, but the latest details could not be loaded. Retry before making another change.")}</p> : null}
      {error ? <p role="alert" className="text-sm text-[var(--ad-red-text)]">{error}</p> : null}
      {awaitingReadback ? <GhostButton onClick={() => void retryReadback()}>{t("Retry")}</GhostButton> : null}

      {editing && draft ? (
        <fieldset className="space-y-6" disabled={saving || awaitingReadback}>
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
            <p className="text-sm text-[var(--ad-text-muted)]">{t(draft.mode === "negative"
              ? "The latest active negative recipe adds its body to the base negative prompt of image recipes with the same use case."
              : "Standard image/video recipe bodies describe the template for operators. Their negative base is used in image prompts; enhancement recipes send the body itself.")}</p>
            <Field full label={t("Body")}>
              <textarea
                className={`${TEXTAREA_CLASS} font-mono`}
                onChange={(event) => updateDraft("body", event.target.value)}
                value={draft.body}
              />
            </Field>
            {draft.mode !== "negative" ? <Field full label={t("Negative Base")}>
              <textarea
                className={`${TEXTAREA_CLASS} font-mono`}
                onChange={(event) => updateDraft("negativeBase", event.target.value)}
                value={draft.negativeBase}
              />
            </Field> : null}
          </FormSection>
        </fieldset>
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
            <p className="text-sm text-[var(--ad-text-muted)]">{t(row.mode === "negative"
              ? "The latest active negative recipe adds its body to the base negative prompt of image recipes with the same use case."
              : "Standard image/video recipe bodies describe the template for operators. Their negative base is used in image prompts; enhancement recipes send the body itself.")}</p>
            <p className="whitespace-pre-wrap font-mono text-sm text-[var(--ad-text)]">{row.body}</p>
          </DetailSection>

          {row.mode !== "negative" ? <DetailSection title={t("Negative Base")}>
            <p className="whitespace-pre-wrap font-mono text-sm text-[var(--ad-text)]">
              {row.negativeBase || "—"}
            </p>
          </DetailSection> : null}

          <EngineeringDetails summary={t("Recipe details")}>
            <div className="space-y-1">
              <div>{t("Recipe ID")}: {row.id}</div>
              <div>{t("Version")}: v{row.version}</div>
            </div>
            <pre className="mt-2 whitespace-pre-wrap">{JSON.stringify(row, null, 2)}</pre>
          </EngineeringDetails>
        </>
      )}

      {!editing ? <RecipeValidationSection canWrite={canWrite && !awaitingReadback} key={`${row.id}:${row.updatedAt}`} recipe={row} onReady={setPublishReady} onChanged={async () => { await reload(); }} /> : null}

      {confirmSpec ? <ConfirmDialog onClose={() => setPending(null)} spec={confirmSpec} /> : null}
    </DetailPage>
    </>
  );
}
