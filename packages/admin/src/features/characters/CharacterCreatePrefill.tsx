"use client";

// SPEC: 创建向导第一步顶部的预填入口（一句话灵感 / 模板）与第 3 步的可选标签。
// INTENT: 都是可跳过的助手：失败就地提示，不动草稿，也不阻止继续创建。
import { Loader2, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CharacterProjectDraft, ContentTemplate } from "@idream/shared/admin";
import { apiGet } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { operatorErrorCopy } from "@/components/admin/ui/request-error-copy";
import { RequestErrorDetails } from "@/components/admin/ui/RequestErrorDetails";
import { WorkspaceButton, fieldClass } from "@/features/operations/WorkspaceUi";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import {
  assistSuggestion,
  templateSuggestion,
  type CharacterDraftFillResult,
  type CharacterDraftSuggestion,
} from "./character-create-prefill";
import { MAX_CHARACTER_TAGS } from "./CharacterTagsPanel";

type Notice = { source: string; filled: string[]; kept: string[]; partial: boolean };

export function CharacterCreatePrefill({
  gender,
  style,
  initialTemplateId,
  onApply,
  onInitialTemplateConsumed,
}: {
  gender: CharacterProjectDraft["persona"]["gender"];
  style: CharacterProjectDraft["visualDirection"]["style"];
  initialTemplateId: string | null;
  onApply: (suggestion: CharacterDraftSuggestion) => CharacterDraftFillResult;
  onInitialTemplateConsumed: () => void;
}) {
  const { t } = useAdminI18n();
  const [seed, setSeed] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{ message: string; cause?: unknown } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [templates, setTemplates] = useState<ContentTemplate[] | null>(null);
  const [templatesError, setTemplatesError] = useState(false);
  const initialConsumed = useRef(false);
  const applyRef = useRef(onApply);
  const consumedRef = useRef(onInitialTemplateConsumed);
  useEffect(() => {
    applyRef.current = onApply;
    consumedRef.current = onInitialTemplateConsumed;
  });

  function report(source: string, result: CharacterDraftFillResult, partial = false) {
    setNotice({ source, filled: result.filled, kept: result.kept, partial });
  }

  useEffect(() => {
    if (!initialTemplateId || initialConsumed.current) return;
    initialConsumed.current = true;
    let current = true;
    void adminV2Operation("GET /api/v2/admin/characters/creation-templates", {})
      .then((page) => {
        if (!current) return;
        setTemplates([...page.items]);
        const template = page.items.find((item) => item.id === initialTemplateId);
        if (!template) {
          setFailure({ message: "That template is not available. You can still fill this in yourself." });
          return;
        }
        setNotice({ source: template.name, ...applyRef.current(templateSuggestion(template)), partial: false });
      })
      .catch((cause: unknown) => {
        if (current) setFailure({ message: "The template could not be loaded. You can still fill this in yourself.", cause });
      })
      .finally(() => consumedRef.current());
    return () => { current = false; };
  }, [initialTemplateId]);

  async function generate() {
    const text = seed.trim();
    if (text.length < 3 || pending) return;
    setPending(true);
    setFailure(null);
    setNotice(null);
    try {
      const result = await adminV2Operation("POST /api/v2/admin/content/character-assist", {
        body: {
          seed: text,
          gender,
          style,
          includeNameIdeas: true,
          includeVisualDirection: true,
        },
      });
      report(t("your idea"), onApply(assistSuggestion(result)), result.failedStages.length > 0);
    } catch (cause) {
      setFailure({ message: "AI could not draft this right now. Nothing here changed; try again or fill it in yourself.", cause });
    } finally {
      setPending(false);
    }
  }

  async function loadTemplates() {
    if (templates) return;
    setTemplatesError(false);
    try {
      const page = await adminV2Operation("GET /api/v2/admin/characters/creation-templates", {});
      setTemplates([...page.items]);
    } catch {
      setTemplatesError(true);
    }
  }

  function pickTemplate(id: string) {
    const template = templates?.find((item) => item.id === id);
    if (!template) return;
    setFailure(null);
    report(template.name, onApply(templateSuggestion(template)));
  }

  return (
    <div className="mb-5 rounded-lg border border-[var(--ad-border)] bg-black/[0.02] p-3" data-testid="character-create-prefill">
      <label className="text-xs font-semibold text-[var(--ad-text-muted)]" htmlFor="character-create-idea">
        {t("Start from one line (optional)")}
      </label>
      <div className="mt-1 flex flex-col gap-2 sm:flex-row">
        <input
          className={fieldClass}
          id="character-create-idea"
          maxLength={400}
          onChange={(event) => setSeed(event.target.value)}
          placeholder={t("A 30-year-old night-shift nurse who is dry, tired and secretly romantic")}
          value={seed}
        />
        <WorkspaceButton className="shrink-0 whitespace-nowrap" disabled={pending || seed.trim().length < 3} onClick={() => void generate()} tone="primary">
          {pending ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : <Sparkles aria-hidden="true" className="h-4 w-4" />}
          {t(pending ? "Drafting…" : "Fill with AI")}
        </WorkspaceButton>
      </div>
      <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
        {t("AI only fills fields that are still empty. Everything stays editable and nothing is saved until you create the character.")}
      </p>
      <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">
        {t("Or start from a template (optional)")}
        <select
          className={`${fieldClass} mt-1`}
          defaultValue=""
          onChange={(event) => {
            pickTemplate(event.target.value);
            event.target.value = "";
          }}
          onFocus={() => void loadTemplates()}
          onMouseDown={() => void loadTemplates()}
        >
          <option value="">{t(templates ? "Choose a template" : "Loading templates…")}</option>
          {templates?.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
        </select>
      </label>
      {templatesError ? <p className="mt-1 text-xs text-[var(--ad-text-muted)]" role="status">{t("Templates could not be loaded. You can continue without one.")}</p> : null}
      {failure ? (
        <div className="mt-3 rounded-md bg-[var(--ad-red-bg)] p-2 text-sm text-[var(--ad-red-text)]" role="alert">
          <p>{t(failure.message)}</p>
          {failure.cause ? <RequestErrorDetails technical={operatorErrorCopy(failure.cause).technical} /> : null}
        </div>
      ) : null}
      {notice ? (
        <div className="mt-3 rounded-md bg-[var(--ad-green-bg)] p-2 text-sm text-[var(--ad-green-text)]" role="status">
          <p>
            {notice.filled.length > 0
              ? t("Filled from {source}: {fields}.", { source: notice.source, fields: notice.filled.map((field) => t(field)).join(" · ") })
              : t("{source} had nothing new for the empty fields.", { source: notice.source })}
          </p>
          {notice.kept.length > 0 ? <p className="mt-1">{t("Kept what you already wrote: {fields}.", { fields: notice.kept.map((field) => t(field)).join(" · ") })}</p> : null}
          {notice.partial ? <p className="mt-1">{t("AI could not draft every field. Fill in the rest or try again.")}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

type TagOption = { id: string; label: string };

export function CharacterCreateTagPicker({
  selected,
  onChange,
}: {
  selected: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const { t } = useAdminI18n();
  const [tags, setTags] = useState<TagOption[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    void apiGet<{ items: TagOption[] }>("/api/v2/admin/content/tags")
      .then((data) => { if (current) setTags(data.items); })
      .catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, []);
  // Tags are optional: an unavailable vocabulary must never stand in the way of creating.
  if (failed || (tags && tags.length === 0)) return null;
  return (
    <section className="rounded-lg border border-[var(--ad-border)] p-3" data-testid="character-create-tags">
      <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ad-text-muted)]">{t("Tags (optional)")}</h3>
      {!tags ? <p className="mt-2 text-xs text-[var(--ad-text-muted)]">{t("Loading tags")}</p> : (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {tags.map((tag) => {
            const active = selected.includes(tag.id);
            return (
              <button
                aria-pressed={active}
                className={`min-h-9 rounded-full border px-3 text-xs font-medium ${active ? "border-[var(--ad-ink)] bg-black/[0.06]" : "border-[var(--ad-border)] text-[var(--ad-text-muted)]"}`}
                disabled={!active && selected.length >= MAX_CHARACTER_TAGS}
                key={tag.id}
                onClick={() => onChange(active ? selected.filter((id) => id !== tag.id) : [...selected, tag.id])}
                type="button"
              >
                {tag.label}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
