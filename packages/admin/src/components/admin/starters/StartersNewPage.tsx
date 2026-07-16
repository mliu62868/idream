"use client";
import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { FormPage, FormSection, Field, FormFooter, INPUT_CLASS, TEXTAREA_CLASS } from "@/components/admin/ui/FormPage";
import { GhostButton, PrimaryButton } from "@/components/admin/ui/buttons";
import { SCOPES, STARTER_GENDERS, STARTER_STYLES, STARTERS_LIST, starterPayload, tagsFromText, type StarterDraft } from "./starters-api";

const EMPTY_DRAFT: StarterDraft = {
  name: "", summary: "", gender: "", style: "",
  scope: "built_in", tags: "", sortOrder: "0",
  creativeBrief: "", archetype: "", relationship: "", personality: "",
  speakingStyle: "", firstMessage: "", exampleDialogue: "",
  appearanceNotes: "", visualBrief: "", reason: "Create starter template draft",
};

// SPEC: 全屏新建页 —— 基本信息→分类→摘要与标签→提交；AI 辅助一句话灵感填充。
// INVARIANTS: 校验就地提示；成功跳详情页。
export function StartersNewPage() {
  const { t, value } = useAdminI18n();
  const [draft, setDraft] = useState<StarterDraft>(EMPTY_DRAFT);
  const [seed, setSeed] = useState("");
  const [assisting, setAssisting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [assistError, setAssistError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  function patch(partial: Partial<StarterDraft>) {
    setDraft((current) => ({ ...current, ...partial }));
  }

  // AI 辅助：一句话 seed → 填充 summary（截断 200）+ 把性格特质并入 tags（原样搬运旧单页视图逻辑）。
  async function assist() {
    if (seed.trim().length === 0) return;
    setAssisting(true);
    setAssistError(null);
    try {
      const data = await apiWrite<{
        description: string;
        advancedDetails: { personality: string; speakingStyle: string; firstMessage: string; visualBrief: string };
      }>(
        "/api/v1/admin/content/character-assist", "POST", { seed: seed.trim() },
      );
      const summary = data.description.slice(0, 200);
      const traits = tagsFromText(data.advancedDetails?.personality ?? "");
      const existing = tagsFromText(draft.tags);
      patch({
        summary,
        creativeBrief: seed.trim(),
        personality: data.advancedDetails.personality,
        speakingStyle: data.advancedDetails.speakingStyle,
        firstMessage: data.advancedDetails.firstMessage,
        visualBrief: data.advancedDetails.visualBrief,
        tags: [...new Set([...existing, ...traits])].slice(0, 12).join(", "),
      });
    } catch (assistError) {
      setAssistError(assistError instanceof Error ? assistError.message : t("Request failed"));
    } finally {
      setAssisting(false);
    }
  }

  const canSubmit = !creating && draft.name.trim().length >= 1;

  async function create() {
    setCreating(true);
    setCreateError(null);
    try {
      const created = await apiWrite<{ template?: { id?: string } }>(
        STARTERS_LIST, "POST", starterPayload({ ...draft, reason: EMPTY_DRAFT.reason }),
      );
      const newId = created.template?.id;
      window.location.href = newId
        ? `/admin/content/templates/${newId}`
        : "/admin/content/templates";
    } catch (createError) {
      setCreateError(createError instanceof Error ? createError.message : t("Request failed"));
      setCreating(false);
    }
  }

  return (
    <FormPage
      backHref="/admin/content/templates"
      backLabel={t("Back to starter templates")}
      title={t("New starter template")}
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
        {assistError ? (
          <p className="text-sm text-[var(--ad-red-text)]" role="alert">
            {assistError}
          </p>
        ) : null}
      </FormSection>
      <FormSection title={t("Basic info")}>
        <Field label={t("Name (≥1)")}>
          <input className={INPUT_CLASS} onChange={(e) => patch({ name: e.target.value })} value={draft.name} />
        </Field>
        <Field label={t("Sort order")}>
          <input className={INPUT_CLASS} onChange={(e) => patch({ sortOrder: e.target.value })} type="number" value={draft.sortOrder} />
        </Field>
        <Field label={t("Scope")}>
          <select className={INPUT_CLASS} onChange={(e) => patch({ scope: e.target.value as StarterDraft["scope"] })} value={draft.scope}>
            {SCOPES.map((s) => (<option key={s} value={s}>{value(s)}</option>))}
          </select>
        </Field>
      </FormSection>
      <FormSection title={t("Category")}>
        <Field label={t("Gender")}>
          <select className={INPUT_CLASS} onChange={(e) => patch({ gender: e.target.value })} value={draft.gender}>
            {STARTER_GENDERS.map((item) => <option key={item || "any"} value={item}>{item ? value(item) : "Any gender"}</option>)}
          </select>
        </Field>
        <Field label={t("Style")}>
          <select className={INPUT_CLASS} onChange={(e) => patch({ style: e.target.value })} value={draft.style}>
            {STARTER_STYLES.map((item) => <option key={item || "any"} value={item}>{item ? value(item) : "Any style"}</option>)}
          </select>
        </Field>
      </FormSection>
      <FormSection title={t("Description & tags")}>
        <Field full label={t("Summary (≤200)")}>
          <textarea className={TEXTAREA_CLASS} onChange={(e) => patch({ summary: e.target.value })} value={draft.summary} />
        </Field>
        <Field full label={t("Tags (comma-separated, ≤12)")}>
          <input className={INPUT_CLASS} onChange={(e) => patch({ tags: e.target.value })} value={draft.tags} />
        </Field>
      </FormSection>
      <FormSection title="Reusable persona">
        <Field full label="Creative brief">
          <textarea className={TEXTAREA_CLASS} onChange={(e) => patch({ creativeBrief: e.target.value })} value={draft.creativeBrief} />
        </Field>
        <Field label="Archetype">
          <input className={INPUT_CLASS} onChange={(e) => patch({ archetype: e.target.value })} value={draft.archetype} />
        </Field>
        <Field label="Relationship">
          <input className={INPUT_CLASS} onChange={(e) => patch({ relationship: e.target.value })} value={draft.relationship} />
        </Field>
        <Field full label="Personality">
          <textarea className={TEXTAREA_CLASS} onChange={(e) => patch({ personality: e.target.value })} value={draft.personality} />
        </Field>
        <Field full label="Speaking style">
          <textarea className={TEXTAREA_CLASS} onChange={(e) => patch({ speakingStyle: e.target.value })} value={draft.speakingStyle} />
        </Field>
        <Field full label="First message">
          <textarea className={TEXTAREA_CLASS} onChange={(e) => patch({ firstMessage: e.target.value })} value={draft.firstMessage} />
        </Field>
        <Field full label="Example dialogue">
          <textarea className={TEXTAREA_CLASS} onChange={(e) => patch({ exampleDialogue: e.target.value })} value={draft.exampleDialogue} />
        </Field>
      </FormSection>
      <FormSection title="Reusable visual direction">
        <Field full label="Appearance anchors">
          <textarea className={TEXTAREA_CLASS} onChange={(e) => patch({ appearanceNotes: e.target.value })} value={draft.appearanceNotes} />
        </Field>
        <Field full label="Art direction">
          <textarea className={TEXTAREA_CLASS} onChange={(e) => patch({ visualBrief: e.target.value })} value={draft.visualBrief} />
        </Field>
      </FormSection>
      <FormFooter error={createError}>
        <PrimaryButton disabled={!canSubmit} onClick={() => void create()}>
          {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Save template draft
        </PrimaryButton>
      </FormFooter>
    </FormPage>
  );
}
