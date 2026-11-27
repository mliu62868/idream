"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import type { CharacterProjectDraft } from "@idream/shared/admin";
import { CHARACTER_STYLES, GENDERS } from "@idream/shared/catalog";
import { Check, Loader2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { AdminV2RequestError } from "@/lib/admin-v2-api";
import { fieldClass, textAreaClass } from "@/features/operations/WorkspaceUi";
import { operatorErrorCopy } from "@/components/admin/ui/request-error-copy";
import { RequestErrorDetails } from "@/components/admin/ui/RequestErrorDetails";

type Draft = CharacterProjectDraft;

export type SaveState =
  | "Not saved"
  | "Saved locally"
  | "In memory only"
  | "Saving"
  | "Saved"
  | "Conflict"
  | "Failed to save";

// INVARIANT: 目录增删一个值，这两张表就编译不过；选项文案不能退回裸枚举值。
const GENDER_LABELS: Record<(typeof GENDERS)[number], string> = { female: "Female", male: "Male", trans: "Trans" };
const STYLE_LABELS: Record<(typeof CHARACTER_STYLES)[number], string> = {
  realistic: "Realistic",
  anime: "Anime",
  hybrid: "Hybrid",
  other: "Other",
};

export function SaveIndicator({ state }: { state: SaveState }) {
  const { t } = useAdminI18n();
  return (
    <span
      className="inline-flex min-h-8 items-center gap-2 rounded-md bg-black/[0.04] px-3 text-xs font-semibold"
      role="status"
    >
      {state === "Saving" ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : state === "Saved" ? (
        <Check className="h-3.5 w-3.5" />
      ) : null}
      {t(state === "Saved" ? "Saved to server" : state)}
    </span>
  );
}

export function CharacterCreateError({ error, draftNotResumable }: { error: string | AdminV2RequestError; draftNotResumable: boolean }) {
  const { t } = useAdminI18n();
  if (typeof error === "string") return t(error);
  const copy = operatorErrorCopy(error);
  return <>
    <p className="font-semibold">{t(draftNotResumable ? "This character has no resumable creation draft." : copy.headline)}</p>
    <p className="mt-1">{t(draftNotResumable ? "Open the character settings to continue editing it." : copy.nextStep, copy.nextStepValues)}</p>
    <RequestErrorDetails technical={copy.technical} />
  </>;
}

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2">{children}</div>;
}

function Field({
  error,
  label,
  name,
  value,
  onChange,
  placeholder,
  required = true,
  type = "text",
}: {
  error?: string;
  label: string;
  name: string;
  value: string | number;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  type?: "text" | "number" | "datetime-local";
}) {
  // INTENT: 表单 label 此前直接渲染字面量，绕过了 i18n —— 中文模式下整张创建表单的字段名仍是英文，
  // 而这些 key 在 zh 词表里本来就有。
  const { t } = useAdminI18n();
  const inputId = `character-create-${name.replaceAll(".", "-")}`;
  const errorId = `${inputId}-error`;
  return (
    <div className="text-xs font-semibold text-[var(--ad-text-muted)]">
      <label htmlFor={inputId}>{t(label)}</label>
      <input
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? true : undefined}
        className={`${fieldClass} mt-1`}
        id={inputId}
        max={type === "number" ? 120 : undefined}
        min={type === "number" ? 18 : undefined}
        name={name}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        required={required}
        type={type}
        value={value}
      />
      {error ? (
        <span
          className="mt-1 block text-xs font-medium text-[var(--ad-red-text)]"
          id={errorId}
        >
          {t(error)}
        </span>
      ) : null}
    </div>
  );
}

function Area({
  error,
  hint,
  label,
  name,
  value,
  onChange,
  placeholder,
  required = true,
}: {
  error?: string;
  hint?: string;
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
}) {
  const { t } = useAdminI18n();
  const inputId = `character-create-${name.replaceAll(".", "-")}`;
  const errorId = `${inputId}-error`;
  return (
    <div className="text-xs font-semibold text-[var(--ad-text-muted)]">
      <label htmlFor={inputId}>{t(label)}</label>
      {hint ? <span className="mt-0.5 block font-normal">{t(hint)}</span> : null}
      <textarea
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? true : undefined}
        className={`${textAreaClass} mt-1`}
        id={inputId}
        name={name}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        required={required}
        value={value}
      />
      {error ? (
        <span
          className="mt-1 block text-xs font-medium text-[var(--ad-red-text)]"
          id={errorId}
        >
          {t(error)}
        </span>
      ) : null}
    </div>
  );
}

type StepProps = {
  draft: Draft;
  errors: Record<string, string>;
  update: <K extends keyof Draft>(section: K, updateSection: (current: Draft[K]) => Draft[K]) => void;
};

// SPEC: 基本信息与开场白必填；其余角色细节只是一段可选 Markdown。
export function PersonaStep({ draft, errors, update }: StepProps) {
  const { t } = useAdminI18n();
  const set = <K extends keyof Draft["persona"]>(
    field: K,
    value: Draft["persona"][K],
  ) => update("persona", (current) => ({ ...current, [field]: value }));
  return (
    <div className="space-y-4">
      <Grid>
        <Field
          error={errors.name}
          label="Name"
          name="persona.name"
          onChange={(value) => set("name", value)}
          placeholder={t("Mara")}
          value={draft.persona.name}
        />
        <Field
          error={errors.age}
          label="Age (18+)"
          name="persona.age"
          onChange={(value) => set("age", Number(value))}
          type="number"
          value={draft.persona.age}
        />
        <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
          {t("Gender")}
          <select
            className={`${fieldClass} mt-1`}
            onChange={(event) =>
              set("gender", event.target.value as Draft["persona"]["gender"])
            }
            value={draft.persona.gender}
          >
            {GENDERS.map((gender) => <option key={gender} value={gender}>{t(GENDER_LABELS[gender])}</option>)}
          </select>
        </label>
      </Grid>
      <Grid>
        <Area
          error={errors.characterPromise}
          label="Short description"
          name="persona.characterPromise"
          onChange={(value) => set("characterPromise", value)}
          placeholder={t("A precise, warm place to put the day down")}
          value={draft.persona.characterPromise}
        />
        <Area
          error={errors.firstMessage}
          label="Opening message"
          name="persona.firstMessage"
          onChange={(value) => set("firstMessage", value)}
          placeholder={t("You made it. What do you need to put down tonight?")}
          value={draft.persona.firstMessage}
        />
      </Grid>
      <Area
        error={errors.detailsMarkdown}
        label="Additional details · Markdown (optional)"
        name="persona.detailsMarkdown"
        onChange={(value) => set("detailsMarkdown", value)}
        placeholder={t(
          "Write personality, voice, backstory, boundaries, examples, or any other useful context in your own structure.",
        )}
        required={false}
        value={draft.persona.detailsMarkdown}
      />
      <p className="text-xs leading-5 text-[var(--ad-text-muted)]">
        {t(
          "The basics are rendered into SOUL.md automatically. Additional details are appended as Markdown without another schema.",
        )}
      </p>
    </div>
  );
}

export function VisualStep({ draft, errors, update }: StepProps) {
  const { t } = useAdminI18n();
  // Editing must retain the trailing space/newline needed to type the next word/trait.
  const [stableTraitsText, setStableTraitsText] = useState(() => draft.visualDirection.stableTraits.join("\n"));
  const set = <K extends keyof Draft["visualDirection"]>(
    field: K,
    value: Draft["visualDirection"][K],
  ) => update("visualDirection", (current) => ({ ...current, [field]: value }));
  return (
    <Grid>
      <Area
        error={errors.identityAnchor}
        hint="Who they look like at a glance. Every generated image starts from this."
        label="Look in one line"
        name="visualDirection.identityAnchor"
        onChange={(value) => set("identityAnchor", value)}
        placeholder={t("e.g. A composed late-night radio host in her thirties")}
        value={draft.visualDirection.identityAnchor}
      />
      <Area
        error={errors.stableTraits}
        hint="What must stay the same in every image, so the character stays recognizable."
        label="Features that never change (one per line)"
        name="visualDirection.stableTraits"
        onChange={(value) => {
          setStableTraitsText(value);
          set("stableTraits", lines(value));
        }}
        placeholder={t("e.g. Dark wavy hair\nWarm brown eyes\nSmall scar on the left brow")}
        value={stableTraitsText}
      />
      <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
        {t("Visual style")}
        <select
          className={`${fieldClass} mt-1`}
          onChange={(event) =>
            set(
              "style",
              event.target.value as Draft["visualDirection"]["style"],
            )
          }
          value={draft.visualDirection.style}
        >
          {CHARACTER_STYLES.map((style) => <option key={style} value={style}>{t(STYLE_LABELS[style])}</option>)}
        </select>
      </label>
      <Area
        error={errors.referenceDirection}
        hint="Light, framing and mood of the first portrait."
        label="Image mood and framing"
        name="visualDirection.referenceDirection"
        onChange={(value) => set("referenceDirection", value)}
        placeholder={t(
          "e.g. Warm low light, close-up portrait, intimate and quiet",
        )}
        value={draft.visualDirection.referenceDirection}
      />
    </Grid>
  );
}

function lines(value: string) {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}
