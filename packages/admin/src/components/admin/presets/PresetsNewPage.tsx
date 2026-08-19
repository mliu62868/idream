"use client";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { requestErrorMessage } from "@/components/admin/section-kit";
import { FormPage, FormSection, Field, FormFooter, INPUT_CLASS, TEXTAREA_CLASS } from "@/components/admin/ui/FormPage";
import { PrimaryButton } from "@/components/admin/ui/buttons";
import {
  PRESET_TYPES,
  PRESET_VISIBILITY,
  PRESETS_LIST,
  defaultPresetDraft,
  presetPayload,
  type PresetDraft,
} from "./presets-api";

// SPEC: 全屏新建页 —— 基本信息 + controls JSON → 提交（spec §7 新建页）。
// INVARIANTS: presetPayload 无 reason 字段（后端 presetAdminSchema 不要求）——不设 reason 输入；
// controlsJson 非法 JSON 在提交时抛错，就地显示，不清空表单。
export function PresetsNewPage() {
  const { t, value } = useAdminI18n();
  const [draft, setDraft] = useState<PresetDraft>(defaultPresetDraft);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function patch(partial: Partial<PresetDraft>) {
    setDraft((current) => ({ ...current, ...partial }));
  }

  const canSubmit = !creating && draft.label.trim().length > 0;

  async function create() {
    setCreating(true);
    setError(null);
    try {
      const payload = presetPayload(draft);
      const created = await apiWrite<{ preset?: { id?: string } }>(PRESETS_LIST, "POST", payload, { "idempotency-key": crypto.randomUUID() });
      const newId = created.preset?.id;
      window.location.href = newId ? `/admin/generation/presets/${newId}` : "/admin/generation/presets";
    } catch (createError) {
      setError(requestErrorMessage(createError, t));
      setCreating(false);
    }
  }

  return (
    <FormPage backHref="/admin/generation/presets" backLabel={t("Back to presets")} title={t("New preset")}>
      <FormSection title={t("Basic info")}>
        <Field label={t("Type")}>
          <select
            className={INPUT_CLASS}
            onChange={(e) => patch({ type: e.target.value as PresetDraft["type"] })}
            value={draft.type}
          >
            {PRESET_TYPES.map((presetType) => (
              <option key={presetType} value={presetType}>
                {value(presetType)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("Label")}>
          <input className={INPUT_CLASS} onChange={(e) => patch({ label: e.target.value })} value={draft.label} />
        </Field>
        <Field label={t("Category")}>
          <input className={INPUT_CLASS} onChange={(e) => patch({ category: e.target.value })} value={draft.category} />
        </Field>
        <Field label={t("Visibility")}>
          <select
            className={INPUT_CLASS}
            onChange={(e) => patch({ visibility: e.target.value as PresetDraft["visibility"] })}
            value={draft.visibility}
          >
            {PRESET_VISIBILITY.map((visibility) => (
              <option key={visibility} value={visibility}>
                {value(visibility)}
              </option>
            ))}
          </select>
        </Field>
        <Field full label={t("Controls (JSON)")}>
          <textarea
            className={`${TEXTAREA_CLASS} font-mono`}
            onChange={(e) => patch({ controlsJson: e.target.value })}
            value={draft.controlsJson}
          />
        </Field>
      </FormSection>
      <FormFooter error={error}>
        <PrimaryButton disabled={!canSubmit} onClick={() => void create()}>
          {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {t("Create preset")}
        </PrimaryButton>
      </FormFooter>
    </FormPage>
  );
}
