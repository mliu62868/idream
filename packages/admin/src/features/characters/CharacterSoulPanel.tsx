"use client";

import {
  characterDraftPersonaSchema,
  characterDraftVisualDirectionSchema,
  type CharacterDraftPersona,
  type CharacterDraftVisualDirection,
  type CharacterWorkspaceDetail,
} from "@idream/shared/admin";
import { compileCharacterSoul } from "@idream/shared/chat/persona";
import Link from "next/link";
import { useEffect, useState } from "react";
import { clearSoulDraft, readSoulDraft, writeSoulDraft, type SoulDraft, type SoulVisualForm } from "./soul-drafts";
import { characterCreateStepFieldErrors } from "./CharacterCreateWizard";
import type { RunCommittedCharacterMutation } from "./character-workspace-permissions";
import { ConfirmDialog } from "@/components/admin/ui/ConfirmDialog";
import { AdminV2RequestError } from "@/lib/admin-v2-api";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import {
  LoadingWorkspace,
  WorkspaceButton,
  fieldClass,
  textAreaClass,
} from "@/features/operations/WorkspaceUi";
import { useAdminI18n } from "@/components/admin/i18n";

export function CharacterSoulPanel(props: Parameters<typeof SoulEditor>[0]) {
  return <SoulEditor key={`${props.actorId}:${props.data.character.id}`} {...props} />;
}

// SPEC: one form holds everything that defines the Character: persona, opening and
// appearance. One Save writes it as a new draft version; publishing stays in Release.
// INTENT: saving a draft is reversible and invisible to customers, so it asks for
// neither a reason nor a confirmation. The appearance written at creation feeds every
// image prompt and had no other place to be corrected.
function SoulEditor({
  data,
  actorId,
  canWrite,
  runCommittedMutation,
}: {
  data: CharacterWorkspaceDetail;
  actorId: string;
  canWrite: boolean;
  runCommittedMutation: RunCommittedCharacterMutation;
}) {
  const { t } = useAdminI18n();
  const storageKey = `idream.admin.soul-draft:${actorId}:${data.character.id}`;
  const [draft, setDraft] = useState<SoulDraft | null>(null);
  const persona = draft?.persona ?? soulDraftFromWorkspace(data);
  const baseVisual = visualFormFromWorkspace(data);
  const visual = draft?.visual ?? baseVisual;
  const baseVersion = draft?.projectVersion ?? data.project.version;
  const baseContentId = draft?.contentVersionId ?? data.soul.current.contentVersionId;
  const [discardOpen, setDiscardOpen] = useState(false);
  const stale = baseVersion !== data.project.version || baseContentId !== data.soul.current.contentVersionId;
  const dirty = draft !== null;
  const [busy, setBusy] = useState(false);
  const [validationAttempted, setValidationAttempted] = useState(false);
  const [error, setError] = useState<string | null>(() =>
    persona ? null : t("Character Soul could not be loaded"),
  );

  // Restore after hydration only once per editor identity; an edit made meanwhile wins.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const restored = readSoulDraft(storageKey);
      setDraft((current) => current ?? restored.draft);
      if (restored.error) setError(t(restored.error));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [storageKey, t]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function discardDraft() {
    const persisted = clearSoulDraft(storageKey);
    setDraft(null);
    setValidationAttempted(false);
    setError(persisted ? null : t("Draft cleared for this tab. Browser storage is unavailable."));
  }

  if (!persona) {
    return error ? (
      <p className="rounded-lg bg-[var(--ad-red-bg)] p-4 text-sm text-[var(--ad-red-text)]" role="alert">
        {error}
      </p>
    ) : (
      <LoadingWorkspace label={t("Loading immutable Character Soul authority")} />
    );
  }

  const keepDraft = (next: SoulDraft) => {
    setDraft(next);
    if (!writeSoulDraft(storageKey, next)) {
      setError(t("Draft kept until this tab reloads. Browser storage is unavailable."));
    }
  };
  const setPersona = (patch: Partial<CharacterDraftPersona>) =>
    keepDraft({ persona: { ...persona, ...patch }, visual, projectVersion: baseVersion, contentVersionId: baseContentId });
  const setVisual = (patch: Partial<SoulVisualForm>) =>
    keepDraft({ persona, visual: { ...visual, ...patch }, projectVersion: baseVersion, contentVersionId: baseContentId });
  const draftPreview = compileSoulDraftPreview(persona);
  const visualDirection = visualDirectionFromForm(visual);
  // Appearance is only sent when edited, so a legacy Character without a visual
  // direction can still save persona changes.
  const visualChanged = JSON.stringify(visualDirection) !== JSON.stringify(visualDirectionFromForm(baseVisual));
  const errors: Record<string, string> = {
    ...characterCreateStepFieldErrors({ persona, visualDirection }, 0),
    ...(visualChanged ? characterCreateStepFieldErrors({ persona, visualDirection }, 1) : {}),
  };
  const fieldErrors = validationAttempted ? errors : {};

  const save = async () => {
    setValidationAttempted(true);
    if (Object.keys(errors).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      await runCommittedMutation({
        action: t("Save character"),
        commit: async () => {
          const result = await adminV2Operation(
            "POST /api/v2/admin/characters/:id/soul/versions",
            {
              path: { id: data.character.id },
              ifMatch: baseVersion,
              body: {
                entityVersion: baseVersion,
                expectedContentVersionId: baseContentId,
                persona,
                ...(visualChanged ? { visualDirection } : {}),
              },
            },
          );
          // 清理先于权威刷新，避免新面板恢复刚提交的旧草稿。
          if (!clearSoulDraft(storageKey)) setError(t("Saved. Local draft could not be cleared."));
          setDraft(null);
          return result;
        },
      });
    } catch (cause) {
      setError(
        cause instanceof AdminV2RequestError && cause.status === 409
          ? t("Someone saved a newer version. Reload before saving again.")
          : cause instanceof Error
            ? cause.message
            : t("Changes could not be saved"),
      );
    } finally {
      setBusy(false);
    }
  };

  const releaseHref = `/admin/characters/${encodeURIComponent(data.character.id)}?tab=release`;
  const unpublishedNotice = data.preview.live === null
    ? t("This Character has not been published yet.")
    : data.preview.changedFields.length > 0
      ? t("Saved changes are not live yet. Customers still see the published version.")
      : null;

  return (
    <div className="space-y-5">
      {dirty ? <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-[var(--ad-yellow-bg)] px-4 py-2 text-sm text-[var(--ad-yellow-text)]" role="status">
        <span>{t(stale ? "Draft is based on an older version. Copy or discard it." : "Unsaved draft · kept in this tab")}</span>
        <button className="min-h-9 underline" disabled={busy} onClick={() => setDiscardOpen(true)} type="button">{t("Discard draft")}</button>
      </div> : unpublishedNotice ? <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-[var(--ad-blue-bg)] px-4 py-2 text-sm text-[var(--ad-blue-text)]" role="status">
        <span>{unpublishedNotice}</span>
        <Link className="min-h-9 content-center font-semibold underline" href={releaseHref}>{t("Go to Release")}</Link>
      </div> : null}

      {data.soul.current.diagnostics.length > 0 ? (
        <section className="rounded-lg border border-[var(--ad-yellow-text)] bg-[var(--ad-yellow-bg)] p-4">
          <h3 className="font-semibold text-[var(--ad-yellow-text)]">{t("Compiler diagnostics")}</h3>
          <ul className="mt-2 space-y-2 text-sm text-[var(--ad-yellow-text)]">
            {data.soul.current.diagnostics.map((item) => (
              <li key={`${item.code}:${item.path.join(".")}`}>
                <code>{item.path.join(".") || "soul"}</code> — {item.message}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <fieldset disabled={!canWrite || busy} className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-5">
        <h3 className="text-lg font-semibold">{t("Persona")}</h3>
        <div className="mt-4 grid gap-5 lg:grid-cols-2">
          <Field error={fieldErrors.name} label={t("Name")} value={persona.name} onChange={(value) => setPersona({ name: value })} />
          <Field error={fieldErrors.age} label={t("Age")} max={120} min={18} type="number" value={String(persona.age)} onChange={(value) => setPersona({ age: Number(value) })} />
          <label className="text-sm font-medium">
            {t("Gender")}
            <select className={`${fieldClass} mt-2`} onChange={(event) => setPersona({ gender: event.target.value as CharacterDraftPersona["gender"] })} value={persona.gender}>
              <option value="female">{t("Female")}</option>
              <option value="male">{t("Male")}</option>
              <option value="trans">{t("Trans")}</option>
            </select>
          </label>
          <Field error={fieldErrors.characterPromise} label={t("Short description")} value={persona.characterPromise} onChange={(value) => setPersona({ characterPromise: value })} />
          <div className="lg:col-span-2">
            <Area error={fieldErrors.firstMessage} label={t("Opening message")} value={persona.firstMessage} onChange={(value) => setPersona({ firstMessage: value })} />
          </div>
          <div className="lg:col-span-2">
            <Area label={t("Additional details · Markdown (optional)")} value={persona.detailsMarkdown} onChange={(value) => setPersona({ detailsMarkdown: value })} />
          </div>
        </div>

        <h3 className="mt-8 text-lg font-semibold">{t("Appearance")}</h3>
        <p className="mt-1 text-sm text-[var(--ad-text-muted)]">{t("Every new image of this Character is generated from this description.")}</p>
        <div className="mt-4 grid gap-5 lg:grid-cols-2">
          <Area error={fieldErrors.identityAnchor} label={t("Identity anchor")} value={visual.identityAnchor} onChange={(value) => setVisual({ identityAnchor: value })} />
          <Area error={fieldErrors.stableTraits} label={t("Stable traits (one per line)")} value={visual.stableTraits} onChange={(value) => setVisual({ stableTraits: value })} />
          <label className="text-sm font-medium">
            {t("Visual style")}
            <select className={`${fieldClass} mt-2`} onChange={(event) => setVisual({ style: event.target.value as SoulVisualForm["style"] })} value={visual.style}>
              <option value="realistic">{t("Realistic")}</option>
              <option value="anime">{t("Anime")}</option>
              <option value="hybrid">{t("Hybrid")}</option>
              <option value="other">{t("Other")}</option>
            </select>
          </label>
          <Area error={fieldErrors.referenceDirection} label={t("Reference direction")} value={visual.referenceDirection} onChange={(value) => setVisual({ referenceDirection: value })} />
        </div>

        {Object.keys(fieldErrors).length > 0 ? <p className="mt-4 text-sm text-[var(--ad-red-text)]" role="alert">{t("Fix the highlighted fields to save.")}</p> : null}
        {error ? <p className="mt-4 text-sm text-[var(--ad-red-text)]" role="alert">{error}</p> : null}
        <div className="mt-5">
          <WorkspaceButton disabled={!canWrite || busy || stale || !dirty} onClick={() => void save()} tone="primary">
            {busy ? t("Saving…") : t("Save")}
          </WorkspaceButton>
        </div>
      </fieldset>

      <details className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-5">
        <summary className="cursor-pointer text-sm font-semibold">{t("Technical details")}</summary>
        <p className="mt-3 text-xs text-[var(--ad-text-muted)]">{t("Character Soul version")} {data.soul.current.version} · {t("schema")} {data.soul.current.schemaVersion ?? t("Soul invalid")} · {data.soul.current.compilerVersion ?? t("not compiled")} · {data.soul.current.estimatedTokens ?? "—"} {t("tokens")}</p>
        <p className="mt-2 break-all font-mono text-xs text-[var(--ad-text-muted)]">{data.soul.current.fingerprint ?? t("No valid fingerprint")}</p>
        <div className="mt-4 grid gap-5 xl:grid-cols-2">
          <ReadOnlyArtifact title={t("Generated SOUL.md")} unavailableLabel={t("Unavailable until the Soul compiles.")} value={draftPreview?.markdown ?? ""} />
          <ReadOnlyArtifact title={t("Compiled system prompt")} unavailableLabel={t("Unavailable until the Soul compiles.")} value={draftPreview?.systemPrompt ?? ""} />
        </div>
      </details>
      {discardOpen ? <ConfirmDialog onClose={() => setDiscardOpen(false)} spec={{
        title: t("Discard draft?"), requireReason: false, submitLabel: t("Discard draft"),
        onSubmit: async () => { discardDraft(); setDiscardOpen(false); },
      }} /> : null}
    </div>
  );
}

export function compileSoulDraftPreview(persona: CharacterDraftPersona) {
  const compiled = compileCharacterSoul({
    name: persona.name,
    age: persona.age,
    gender: persona.gender,
    characterPromise: persona.characterPromise,
    detailsMarkdown: persona.detailsMarkdown,
  });
  if (!compiled.ok) return null;
  return {
    markdown: compiled.renderedMarkdown,
    systemPrompt: compiled.snapshot.compiled.systemPrompt,
  };
}

export function soulDraftFromWorkspace(data: CharacterWorkspaceDetail): CharacterDraftPersona | null {
  const soul = asRecord(data.soul.current.soul);
  if (Object.keys(soul).length === 0) return null;
  const opening = data.preview.draft.opening;
  const parsed = characterDraftPersonaSchema.safeParse({
    name: soul.name,
    age: soul.age,
    gender: soul.gender,
    characterPromise: soul.characterPromise,
    detailsMarkdown: typeof soul.detailsMarkdown === "string" ? soul.detailsMarkdown : "",
    firstMessage: typeof opening.firstMessage === "string" ? opening.firstMessage : "",
  });
  return parsed.success ? parsed.data : null;
}

const visualStyles = characterDraftVisualDirectionSchema.shape.style.options;

function isVisualStyle(value: unknown): value is SoulVisualForm["style"] {
  return visualStyles.includes(value as SoulVisualForm["style"]);
}

// Legacy appearances predate the visual direction; missing keys start empty and style
// falls back to the live Character's style.
export function visualFormFromWorkspace(data: CharacterWorkspaceDetail): SoulVisualForm {
  const appearance = data.preview.draft.appearance;
  return {
    identityAnchor: typeof appearance.identityAnchor === "string" ? appearance.identityAnchor : "",
    stableTraits: Array.isArray(appearance.stableTraits)
      ? appearance.stableTraits.filter((trait): trait is string => typeof trait === "string").join("\n")
      : "",
    style: [appearance.style, data.character.style].find(isVisualStyle) ?? "realistic",
    referenceDirection: typeof appearance.referenceDirection === "string" ? appearance.referenceDirection : "",
  };
}

export function visualDirectionFromForm(form: SoulVisualForm): CharacterDraftVisualDirection {
  return {
    identityAnchor: form.identityAnchor.trim(),
    stableTraits: form.stableTraits.split("\n").map((trait) => trait.trim()).filter(Boolean),
    style: form.style,
    referenceDirection: form.referenceDirection.trim(),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function FieldError({ error }: { error?: string }) {
  const { t } = useAdminI18n();
  return error ? <span className="mt-1 block text-xs font-medium text-[var(--ad-red-text)]">{t(error)}</span> : null;
}

function Field({ error, label, value, onChange, type = "text", min, max }: {
  error?: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "number";
  min?: number;
  max?: number;
}) {
  return <label className="text-sm font-medium">{label}<input aria-invalid={error ? true : undefined} className={`${fieldClass} mt-2`} max={max} min={min} onChange={(event) => onChange(event.target.value)} type={type} value={value} /><FieldError error={error} /></label>;
}

function Area({ error, label, value, onChange }: { error?: string; label: string; value: string; onChange: (value: string) => void }) {
  return <label className="text-sm font-medium">{label}<textarea aria-invalid={error ? true : undefined} className={`${textAreaClass} mt-2 min-h-24`} onChange={(event) => onChange(event.target.value)} value={value} /><FieldError error={error} /></label>;
}

function ReadOnlyArtifact({ title, unavailableLabel, value }: { title: string; unavailableLabel: string; value: string | null }) {
  return (
    <details className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
      <summary className="cursor-pointer p-4 font-semibold">{title}</summary>
      <pre className="max-h-[36rem] overflow-auto whitespace-pre-wrap border-t border-[var(--ad-border)] p-4 text-xs leading-6">{value ?? unavailableLabel}</pre>
    </details>
  );
}
