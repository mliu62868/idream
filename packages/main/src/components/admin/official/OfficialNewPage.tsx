"use client";
import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { FormPage, FormSection, Field, FormFooter, INPUT_CLASS, TEXTAREA_CLASS } from "@/components/admin/ui/FormPage";
import { GhostButton, PrimaryButton } from "@/components/admin/ui/buttons";
import { GENDERS, OFFICIAL_LIST, STYLES, officialPayload, type OfficialDraft } from "./official-api";

const EMPTY_DRAFT: OfficialDraft = {
  name: "", age: "24", gender: "female", style: "realistic",
  description: "", tags: "", reason: "",
};

// SPEC: 全屏新建页 —— 基本信息→外貌与风格→描述与标签→提交；AI 辅助一句话灵感填充。
// INVARIANTS: 校验就地提示；age≥18 由后端强制，前端 min=18；成功跳详情页。
export function OfficialNewPage() {
  const { t, value } = useAdminI18n();
  const [draft, setDraft] = useState<OfficialDraft>(EMPTY_DRAFT);
  const [seed, setSeed] = useState("");
  const [assisting, setAssisting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function patch(partial: Partial<OfficialDraft>) {
    setDraft((current) => ({ ...current, ...partial }));
  }

  async function assist() {
    if (seed.trim().length === 0) return;
    setAssisting(true);
    setError(null);
    try {
      const data = await apiWrite<{ description: string; advancedDetails: { personality: string } }>(
        "/api/v1/admin/content/character-assist", "POST", { seed: seed.trim() },
      );
      const traits = data.advancedDetails.personality
        .split(",").map((tag) => tag.trim()).filter(Boolean);
      const existing = draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean);
      patch({
        description: data.description,
        tags: [...new Set([...existing, ...traits])].slice(0, 12).join(", "),
      });
    } catch (assistError) {
      setError(assistError instanceof Error ? assistError.message : t("Request failed"));
    } finally {
      setAssisting(false);
    }
  }

  const canSubmit =
    !creating &&
    draft.name.trim().length >= 1 &&
    draft.description.trim().length >= 1 &&
    draft.reason.trim().length >= 3;

  async function create() {
    setCreating(true);
    setError(null);
    try {
      const created = await apiWrite<{ item?: { id?: string }; character?: { id?: string } }>(
        OFFICIAL_LIST, "POST", officialPayload(draft),
      );
      const newId = created.item?.id ?? created.character?.id;
      window.location.href = newId
        ? `/admin/content/official/${newId}`
        : "/admin/content/official";
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : t("Request failed"));
      setCreating(false);
    }
  }

  return (
    <FormPage
      backHref="/admin/content/official"
      backLabel={t("Back to official characters")}
      title={t("New official character")}
    >
      <FormSection hint={t("One-line inspiration — AI fills description and tags.")} title={t("AI assist")}>
        <Field full label={t("Inspiration")}>
          <div className="flex gap-2">
            <input className={INPUT_CLASS} onChange={(e) => setSeed(e.target.value)} value={seed} />
            <GhostButton disabled={assisting || seed.trim().length === 0} onClick={() => void assist()}>
              {assisting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {t("Generate with AI")}
            </GhostButton>
          </div>
        </Field>
      </FormSection>
      <FormSection title={t("Basic info")}>
        <Field label={t("Name (≥1)")}>
          <input className={INPUT_CLASS} onChange={(e) => patch({ name: e.target.value })} value={draft.name} />
        </Field>
        <Field label={t("Age")}>
          <input className={INPUT_CLASS} min={18} onChange={(e) => patch({ age: e.target.value })} type="number" value={draft.age} />
        </Field>
      </FormSection>
      <FormSection title={t("Appearance & style")}>
        <Field label={t("Gender")}>
          <select className={INPUT_CLASS} onChange={(e) => patch({ gender: e.target.value as OfficialDraft["gender"] })} value={draft.gender}>
            {GENDERS.map((g) => (<option key={g} value={g}>{value(g)}</option>))}
          </select>
        </Field>
        <Field label={t("Style")}>
          <select className={INPUT_CLASS} onChange={(e) => patch({ style: e.target.value as OfficialDraft["style"] })} value={draft.style}>
            {STYLES.map((s) => (<option key={s} value={s}>{value(s)}</option>))}
          </select>
        </Field>
      </FormSection>
      <FormSection title={t("Description & tags")}>
        <Field full label={t("Description")}>
          <textarea className={TEXTAREA_CLASS} onChange={(e) => patch({ description: e.target.value })} value={draft.description} />
        </Field>
        <Field full label={t("Tags (comma-separated, ≤12)")}>
          <input className={INPUT_CLASS} onChange={(e) => patch({ tags: e.target.value })} value={draft.tags} />
        </Field>
      </FormSection>
      <FormFooter error={error}>
        <input
          aria-label={t("Reason (≥3)")}
          className={`${INPUT_CLASS} max-w-xs`}
          onChange={(e) => patch({ reason: e.target.value })}
          placeholder={t("Reason (≥3)")}
          value={draft.reason}
        />
        <PrimaryButton disabled={!canSubmit} onClick={() => void create()}>
          {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {t("Create character")}
        </PrimaryButton>
      </FormFooter>
    </FormPage>
  );
}
