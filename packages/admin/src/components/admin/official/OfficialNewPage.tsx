"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Loader2, Save, Sparkles } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import {
  FormPage,
  FormSection,
  Field,
  FormFooter,
  INPUT_CLASS,
  TEXTAREA_CLASS,
} from "@/components/admin/ui/FormPage";
import { GhostButton, PrimaryButton } from "@/components/admin/ui/buttons";
import { cn } from "@/lib/utils";
import {
  GENDERS,
  OFFICIAL_LIST,
  STYLES,
  officialPayload,
  textField,
  type OfficialDraft,
} from "./official-api";

const DRAFT_STORAGE_KEY = "idream.admin.official-character-draft.v2";

const EMPTY_DRAFT: OfficialDraft = {
  name: "",
  age: "24",
  gender: "female",
  style: "realistic",
  description: "",
  tags: "",
  creativeBrief: "",
  archetype: "",
  relationship: "",
  personality: "",
  speakingStyle: "",
  backstory: "",
  firstMessage: "",
  exampleDialogue: "",
  appearanceNotes: "",
  visualBrief: "",
  reason: "Create official character draft",
};

type StarterOption = {
  id: string;
  name: string;
  summary: string | null;
  gender: string | null;
  style: string | null;
  appearance: unknown;
  advancedDetails: unknown;
  tags: unknown;
};

type AssistResult = {
  description: string;
  nameIdeas: string[];
  advancedDetails: {
    personality: string;
    speakingStyle: string;
    firstMessage: string;
    visualBrief: string;
  };
};

const STEPS = [
  { label: "Brief", description: "Position the character" },
  { label: "Persona", description: "Shape voice and relationship" },
  { label: "Visual direction", description: "Define a consistent look" },
  { label: "Review", description: "Save the private draft" },
] as const;

function stringTags(value: unknown): string {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").join(", ")
    : "";
}

function restoredDraft(): OfficialDraft {
  try {
    const raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return EMPTY_DRAFT;
    const stored = JSON.parse(raw) as Partial<OfficialDraft>;
    return { ...EMPTY_DRAFT, ...stored, reason: EMPTY_DRAFT.reason };
  } catch {
    return EMPTY_DRAFT;
  }
}

export function OfficialNewPage() {
  const { t, value } = useAdminI18n();
  const [draft, setDraft] = useState<OfficialDraft>(EMPTY_DRAFT);
  const [step, setStep] = useState(0);
  const [seed, setSeed] = useState("");
  const [nameIdeas, setNameIdeas] = useState<string[]>([]);
  const [starters, setStarters] = useState<StarterOption[]>([]);
  const [selectedStarterId, setSelectedStarterId] = useState("");
  const [assisting, setAssisting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function patch(partial: Partial<OfficialDraft>) {
    setDraft((current) => ({ ...current, ...partial }));
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDraft(restoredDraft());
      setReady(true);
      void apiGet<{ items: StarterOption[] }>("/api/v1/admin/content/templates?limit=200")
        .then((data) => setStarters(data.items))
        .catch(() => setStarters([]));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!ready) return;
    window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
  }, [draft, ready]);

  function applyStarter(id: string) {
    setSelectedStarterId(id);
    const starter = starters.find((item) => item.id === id);
    if (!starter) return;
    patch({
      name: starter.name,
      description: starter.summary ?? "",
      gender: GENDERS.includes(starter.gender as (typeof GENDERS)[number])
        ? (starter.gender as OfficialDraft["gender"])
        : draft.gender,
      style: STYLES.includes(starter.style as (typeof STYLES)[number])
        ? (starter.style as OfficialDraft["style"])
        : draft.style,
      tags: stringTags(starter.tags),
      creativeBrief: textField(starter.advancedDetails, "creativeBrief"),
      archetype: textField(starter.advancedDetails, "archetype"),
      relationship: textField(starter.advancedDetails, "relationship"),
      personality: textField(starter.advancedDetails, "personality"),
      speakingStyle: textField(starter.advancedDetails, "speakingStyle"),
      firstMessage: textField(starter.advancedDetails, "firstMessage"),
      exampleDialogue: textField(starter.advancedDetails, "exampleDialogue"),
      appearanceNotes: textField(starter.appearance, "notes"),
      visualBrief:
        textField(starter.appearance, "visualBrief") ||
        textField(starter.advancedDetails, "visualBrief"),
    });
    setNotice("Starter applied. Every field remains editable.");
  }

  async function assist() {
    if (seed.trim().length === 0) return;
    setAssisting(true);
    setError(null);
    setNotice(null);
    try {
      const data = await apiWrite<AssistResult>(
        "/api/v1/admin/content/character-assist",
        "POST",
        { seed: seed.trim(), gender: draft.gender, style: draft.style },
      );
      const traits = data.advancedDetails.personality
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);
      const existing = draft.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);
      patch({
        creativeBrief: seed.trim(),
        description: data.description,
        personality: data.advancedDetails.personality,
        speakingStyle: data.advancedDetails.speakingStyle,
        firstMessage: data.advancedDetails.firstMessage,
        visualBrief: data.advancedDetails.visualBrief,
        tags: [...new Set([...existing, ...traits])].slice(0, 12).join(", "),
      });
      setNameIdeas(data.nameIdeas);
      setNotice("Creative foundation generated. Review each section before saving.");
    } catch (assistError) {
      setError(assistError instanceof Error ? assistError.message : t("Request failed"));
    } finally {
      setAssisting(false);
    }
  }

  const reviewChecks = useMemo(
    () => [
      { label: "Name", complete: draft.name.trim().length > 0 },
      { label: "Character description", complete: draft.description.trim().length > 0 },
      { label: "Personality", complete: draft.personality.trim().length > 0 },
      { label: "First message", complete: draft.firstMessage.trim().length > 0 },
      { label: "Visual direction", complete: draft.visualBrief.trim().length > 0 },
      { label: "Tags", complete: draft.tags.trim().length > 0 },
    ],
    [draft],
  );
  const canSave = !creating && reviewChecks[0].complete && reviewChecks[1].complete;

  async function create() {
    if (!canSave) return;
    setCreating(true);
    setError(null);
    try {
      const created = await apiWrite<{ item?: { id?: string }; character?: { id?: string } }>(
        OFFICIAL_LIST,
        "POST",
        officialPayload({ ...draft, reason: EMPTY_DRAFT.reason }),
        { "idempotency-key": crypto.randomUUID() },
      );
      window.localStorage.removeItem(DRAFT_STORAGE_KEY);
      const newId = created.item?.id ?? created.character?.id;
      window.location.href = newId ? `/admin/content/official/${newId}` : "/admin/content/official";
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : t("Request failed"));
      setCreating(false);
    }
  }

  return (
    <FormPage
      backHref="/admin/content/official"
      backLabel={t("Back to official characters")}
      title={t("Create a character project")}
    >
      <div className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-[var(--ad-ink)]">{t("Private draft")}</p>
            <p className="mt-1 text-xs text-[var(--ad-text-muted)]">

              {t("Nothing is published until you finish the character, create artwork, preview it, and choose Publish.")}
            </p>
          </div>
          <span className="rounded-md bg-black/[0.05] px-2.5 py-1 text-xs font-medium text-[var(--ad-text-muted)]">

            {t("Autosaved in this browser")}
          </span>
        </div>
      </div>

      <nav aria-label={t("Character creation steps")} className="grid gap-px overflow-hidden rounded-lg border border-[var(--ad-border)] bg-[var(--ad-border)] sm:grid-cols-4">
        {STEPS.map((item, index) => (
          <button
            aria-current={step === index ? "step" : undefined}
            className={cn(
              "min-h-16 bg-[var(--ad-surface)] px-4 py-3 text-left transition-colors hover:bg-black/[0.03] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]",
              step === index && "bg-black/[0.04]",
            )}
            key={item.label}
            onClick={() => setStep(index)}
            type="button"
          >
            <span className="block text-[11px] tabular-nums text-[var(--ad-text-muted)]">0{index + 1}</span>
            <span className="mt-1 block text-sm font-semibold text-[var(--ad-ink)]">{item.label}</span>
            <span className="mt-0.5 block text-xs text-[var(--ad-text-muted)]">{item.description}</span>
          </button>
        ))}
      </nav>

      {notice ? <p aria-live="polite" className="text-sm text-[var(--ad-green-text)]">{notice}</p> : null}

      {step === 0 ? (
        <>
          <FormSection hint="Use a saved starter or begin with a one-line creative premise." title={t("Starting point")}>
            <Field full label="Start from a character starter">
              <select className={INPUT_CLASS} onChange={(event) => applyStarter(event.target.value)} value={selectedStarterId}>
                <option value="">{t("Blank character")}</option>
                {starters.map((starter) => <option key={starter.id} value={starter.id}>{starter.name}</option>)}
              </select>
            </Field>
            <Field full label="Creative premise">
              <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                <textarea
                  className={cn(TEXTAREA_CLASS, "min-h-20")}
                  onChange={(event) => setSeed(event.target.value)}
                  placeholder={t("Example: A composed night-shift doctor with a dry sense of humor and a hidden soft side.")}
                  value={seed}
                />
                <GhostButton disabled={assisting || seed.trim().length < 3} onClick={() => void assist()}>
                  {assisting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}

                  {t("Generate foundation")}
                </GhostButton>
              </div>
            </Field>
            {nameIdeas.length > 0 ? (
              <Field full label="Name ideas">
                <div className="flex flex-wrap gap-2">
                  {nameIdeas.map((name) => (
                    <button
                      className="rounded-md border border-[var(--ad-border)] px-3 py-2 text-sm hover:border-[var(--ad-ink)]"
                      key={name}
                      onClick={() => patch({ name })}
                      type="button"
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </Field>
            ) : null}
          </FormSection>
          <FormSection title={t("Core brief")}>
            <Field label={t("Name (≥1)")}>
              <input className={INPUT_CLASS} onChange={(event) => patch({ name: event.target.value })} value={draft.name} />
            </Field>
            <Field label={t("Age")}>
              <input className={INPUT_CLASS} min={18} onChange={(event) => patch({ age: event.target.value })} type="number" value={draft.age} />
            </Field>
            <Field label={t("Gender")}>
              <select className={INPUT_CLASS} onChange={(event) => patch({ gender: event.target.value as OfficialDraft["gender"] })} value={draft.gender}>
                {GENDERS.map((gender) => <option key={gender} value={gender}>{value(gender)}</option>)}
              </select>
            </Field>
            <Field label={t("Style")}>
              <select className={INPUT_CLASS} onChange={(event) => patch({ style: event.target.value as OfficialDraft["style"] })} value={draft.style}>
                {STYLES.map((style) => <option key={style} value={style}>{value(style)}</option>)}
              </select>
            </Field>
            <Field full label="Creative brief">
              <textarea className={TEXTAREA_CLASS} onChange={(event) => patch({ creativeBrief: event.target.value })} value={draft.creativeBrief} />
            </Field>
            <Field label="Archetype">
              <input className={INPUT_CLASS} onChange={(event) => patch({ archetype: event.target.value })} placeholder={t("Mentor, rival, confidante…")} value={draft.archetype} />
            </Field>
            <Field label="Relationship to the user">
              <input className={INPUT_CLASS} onChange={(event) => patch({ relationship: event.target.value })} placeholder={t("How they know each other")} value={draft.relationship} />
            </Field>
          </FormSection>
        </>
      ) : null}

      {step === 1 ? (
        <>
          <FormSection title={t("Persona foundation")}>
            <Field full label={t("Description")}>
              <textarea className={TEXTAREA_CLASS} onChange={(event) => patch({ description: event.target.value })} value={draft.description} />
            </Field>
            <Field full label="Personality">
              <textarea className={TEXTAREA_CLASS} onChange={(event) => patch({ personality: event.target.value })} value={draft.personality} />
            </Field>
            <Field full label="Speaking style">
              <textarea className={TEXTAREA_CLASS} onChange={(event) => patch({ speakingStyle: event.target.value })} value={draft.speakingStyle} />
            </Field>
            <Field full label="Backstory">
              <textarea className={TEXTAREA_CLASS} onChange={(event) => patch({ backstory: event.target.value })} value={draft.backstory} />
            </Field>
          </FormSection>
          <FormSection title={t("First conversation")}>
            <Field full label="First message">
              <textarea className={TEXTAREA_CLASS} onChange={(event) => patch({ firstMessage: event.target.value })} value={draft.firstMessage} />
            </Field>
            <Field full label="Example dialogue">
              <textarea className={cn(TEXTAREA_CLASS, "min-h-32")} onChange={(event) => patch({ exampleDialogue: event.target.value })} placeholder={t("User: …\\nCharacter: …")} value={draft.exampleDialogue} />
            </Field>
            <Field full label={t("Tags (comma-separated, ≤12)")}>
              <input className={INPUT_CLASS} onChange={(event) => patch({ tags: event.target.value })} value={draft.tags} />
            </Field>
          </FormSection>
        </>
      ) : null}

      {step === 2 ? (
        <>
          <FormSection hint="Describe what must remain recognizable across every generated image." title={t("Visual identity brief")}>
            <Field full label="Appearance anchors">
              <textarea
                className={cn(TEXTAREA_CLASS, "min-h-32")}
                onChange={(event) => patch({ appearanceNotes: event.target.value })}
                placeholder={t("Face shape, eyes, hair, body silhouette, signature detail…")}
                value={draft.appearanceNotes}
              />
            </Field>
            <Field full label="Art direction">
              <textarea
                className={cn(TEXTAREA_CLASS, "min-h-32")}
                onChange={(event) => patch({ visualBrief: event.target.value })}
                placeholder={t("Wardrobe, palette, lighting, camera language, recurring settings…")}
                value={draft.visualBrief}
              />
            </Field>
          </FormSection>
          <div className="rounded-lg border border-[var(--ad-border)] bg-black/[0.025] p-5">
            <p className="text-sm font-semibold text-[var(--ad-ink)]">{t("Artwork comes next")}</p>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-[var(--ad-text-muted)]">

              {t("Saving creates a private character project. The next workspace lets you lock the visual identity, generate multiple creative directions, review cover / hero / chat images, and preview the character before publishing.")}
            </p>
          </div>
        </>
      ) : null}

      {step === 3 ? (
        <>
          <div className="grid gap-4 lg:grid-cols-[1fr_0.8fr]">
            <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-6">
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ad-text-muted)]">{t("Character summary")}</p>
              <h3 className="mt-3 text-2xl font-semibold tracking-tight text-[var(--ad-ink)]">{draft.name || "Untitled character"}</h3>
              <p className="mt-2 text-sm text-[var(--ad-text-muted)]">{value(draft.style)} · {value(draft.gender)} · {draft.age}</p>
              <p className="mt-5 whitespace-pre-wrap text-sm leading-relaxed text-[var(--ad-text)]">{draft.description || "Add a description before saving."}</p>
              {draft.firstMessage ? (
                <div className="mt-5 rounded-lg bg-black/[0.035] p-4">
                  <p className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("First message preview")}</p>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-[var(--ad-text)]">{draft.firstMessage}</p>
                </div>
              ) : null}
            </section>
            <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-6">
              <p className="text-sm font-semibold text-[var(--ad-ink)]">{t("Draft readiness")}</p>
              <div className="mt-4 space-y-3">
                {reviewChecks.map((check) => (
                  <div className="flex items-center justify-between gap-3" key={check.label}>
                    <span className="text-sm text-[var(--ad-text)]">{check.label}</span>
                    <span className={cn("inline-flex items-center gap-1 text-xs font-medium", check.complete ? "text-[var(--ad-green-text)]" : "text-[var(--ad-text-muted)]")}>
                      {check.complete ? <Check className="h-3.5 w-3.5" /> : null}
                      {check.complete ? t("Ready") : t("Needs work")}
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-5 text-xs leading-relaxed text-[var(--ad-text-muted)]">

                {t("Only name and description are required to save. Publishing remains unavailable until the visual and artwork checks are complete.")}
              </p>
            </section>
          </div>
        </>
      ) : null}

      <FormFooter error={error}>
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <GhostButton disabled={step === 0 || creating} onClick={() => setStep((current) => Math.max(0, current - 1))}>
            <ChevronLeft className="h-4 w-4" />  {t("Back")}
          </GhostButton>
          <div className="flex items-center gap-3">
            <span className="text-xs tabular-nums text-[var(--ad-text-muted)]">{t("Step")} {step + 1}  {t("of")} {STEPS.length}</span>
            {step < STEPS.length - 1 ? (
              <PrimaryButton onClick={() => setStep((current) => Math.min(STEPS.length - 1, current + 1))}>

                {t("Continue")} <ChevronRight className="h-4 w-4" />
              </PrimaryButton>
            ) : (
              <PrimaryButton disabled={!canSave} onClick={() => void create()}>
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}

                {t("Save private draft")}
              </PrimaryButton>
            )}
          </div>
        </div>
      </FormFooter>
    </FormPage>
  );
}
