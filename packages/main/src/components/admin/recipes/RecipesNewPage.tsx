"use client";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { FormPage, FormSection, Field, FormFooter, INPUT_CLASS, TEXTAREA_CLASS } from "@/components/admin/ui/FormPage";
import { PrimaryButton } from "@/components/admin/ui/buttons";
import {
  MODES,
  RECIPES_LIST,
  USE_CASES,
  defaultRecipeDraft,
  recipeDraftPayload,
  type RecipeDraft,
} from "./recipes-api";

// SPEC: 全屏新建页 —— 基本信息→正文→提交（spec §7 新建页）。
// INVARIANTS: recipeDraftPayload 无 reason 字段（后端 recipeSchema 不要求）——不设 reason 输入。
export function RecipesNewPage() {
  const { t, value } = useAdminI18n();
  const [draft, setDraft] = useState<RecipeDraft>(defaultRecipeDraft);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function patch(partial: Partial<RecipeDraft>) {
    setDraft((current) => ({ ...current, ...partial }));
  }

  const canSubmit =
    !creating && draft.recipeKey.trim().length > 0 && draft.label.trim().length > 0 && draft.body.trim().length > 0;

  async function create() {
    setCreating(true);
    setError(null);
    try {
      const created = await apiWrite<{ template?: { id?: string } }>(
        RECIPES_LIST,
        "POST",
        recipeDraftPayload(draft),
      );
      const newId = created.template?.id;
      window.location.href = newId ? `/admin/generation/recipes/${newId}` : "/admin/generation/recipes";
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : t("Request failed"));
      setCreating(false);
    }
  }

  return (
    <FormPage backHref="/admin/generation/recipes" backLabel={t("Back to prompt recipes")} title={t("New prompt recipe")}>
      <FormSection title={t("Basic info")}>
        <Field label={t("Recipe Key")}>
          <input className={INPUT_CLASS} onChange={(e) => patch({ recipeKey: e.target.value })} value={draft.recipeKey} />
        </Field>
        <Field label={t("Label")}>
          <input className={INPUT_CLASS} onChange={(e) => patch({ label: e.target.value })} value={draft.label} />
        </Field>
        <Field label={t("Mode")}>
          <select className={INPUT_CLASS} onChange={(e) => patch({ mode: e.target.value as RecipeDraft["mode"] })} value={draft.mode}>
            {MODES.map((m) => (<option key={m} value={m}>{value(m)}</option>))}
          </select>
        </Field>
        <Field label={t("Use Case")}>
          <select className={INPUT_CLASS} onChange={(e) => patch({ useCase: e.target.value as RecipeDraft["useCase"] })} value={draft.useCase}>
            {USE_CASES.map((useCase) => (<option key={useCase} value={useCase}>{value(useCase)}</option>))}
          </select>
        </Field>
      </FormSection>
      <FormSection title={t("Body")}>
        <Field full label={t("Body")}>
          <textarea className={`${TEXTAREA_CLASS} font-mono`} onChange={(e) => patch({ body: e.target.value })} value={draft.body} />
        </Field>
        <Field full label={t("Negative Base")}>
          <textarea className={`${TEXTAREA_CLASS} font-mono`} onChange={(e) => patch({ negativeBase: e.target.value })} value={draft.negativeBase} />
        </Field>
      </FormSection>
      <FormFooter error={error}>
        <PrimaryButton disabled={!canSubmit} onClick={() => void create()}>
          {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {t("Create Draft")}
        </PrimaryButton>
      </FormFooter>
    </FormPage>
  );
}
