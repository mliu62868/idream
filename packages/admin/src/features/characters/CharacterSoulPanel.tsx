"use client";

import {
  characterDraftPersonaSchema,
  characterSoulVersionCreateResponseSchema,
  type CharacterDraftPersona,
  type CharacterWorkspaceDetail,
} from "@idream/shared/admin";
import { useRef, useState } from "react";
import { AdminV2RequestError, adminV2Request } from "@/lib/admin-v2-api";
import {
  LoadingWorkspace,
  WorkspaceButton,
  fieldClass,
  textAreaClass,
} from "@/features/operations/WorkspaceUi";
import { useAdminI18n } from "@/components/admin/i18n";

type RunCommittedMutation = <T>(input: {
  readonly action: string;
  readonly commit: () => Promise<T>;
  readonly afterRefresh?: () => void;
}) => Promise<{ readonly result: T; readonly refreshed: boolean }>;

export function CharacterSoulPanel({
  data,
  canWrite,
  runCommittedMutation,
}: {
  data: CharacterWorkspaceDetail;
  canWrite: boolean;
  runCommittedMutation: RunCommittedMutation;
}) {
  const { t } = useAdminI18n();
  const initialPersona = soulDraftFromWorkspace(data);
  const [persona, setPersonaDraft] = useState<CharacterDraftPersona | null>(initialPersona);
  const [reason, setReason] = useState(() => t("Create reviewed Character Soul version"));
  const [busy, setBusy] = useState(false);
  const [dialogueError, setDialogueError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(() =>
    initialPersona ? null : t("Character Soul could not be loaded"),
  );
  const mutationKey = useRef<{ readonly signature: string; readonly key: string } | null>(null);

  if (!persona) {
    return error ? (
      <p className="rounded-lg bg-[var(--ad-red-bg)] p-4 text-sm text-[var(--ad-red-text)]" role="alert">
        {error}
      </p>
    ) : (
      <LoadingWorkspace label={t("Loading immutable Character Soul authority")} />
    );
  }

  const setPersona = (patch: Partial<CharacterDraftPersona>) =>
    setPersonaDraft((current) => current
      ? { ...current, ...patch }
      : current);
  const setInteraction = (
    key: keyof NonNullable<typeof persona.interaction>,
    value: string,
  ) => setPersona({
    interaction: {
      initiative: "",
      curiosity: "",
      pacing: "",
      affection: "",
      conflict: "",
      repair: "",
      ...persona.interaction,
      [key]: value,
    },
  });

  const createVersion = async () => {
    setBusy(true);
    setError(null);
    try {
      const signature = JSON.stringify({
        contentVersionId: data.soul.current.contentVersionId,
        persona,
        reason,
      });
      const idempotencyKey = mutationKey.current?.signature === signature
        ? mutationKey.current.key
        : crypto.randomUUID();
      mutationKey.current = { signature, key: idempotencyKey };
      await runCommittedMutation({
        action: t("Create Character Soul version"),
        commit: () => adminV2Request(
          `/api/v2/admin/characters/${data.character.id}/soul/versions`,
          {
            method: "POST",
            idempotencyKey,
            ifMatch: data.project.version,
            body: {
              entityVersion: data.project.version,
              expectedContentVersionId: data.soul.current.contentVersionId,
              persona,
              reason,
            },
            schema: characterSoulVersionCreateResponseSchema,
          },
        ),
      });
      mutationKey.current = null;
    } catch (cause) {
      setError(
        cause instanceof AdminV2RequestError && cause.status === 409
          ? t("A newer Soul or Project version exists. Reload before creating another version.")
          : cause instanceof Error
            ? cause.message
            : t("Character Soul version could not be created"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ad-text-muted)]">{t("Immutable authority")}</p>
            <h3 className="mt-1 text-lg font-semibold">{t("Character Soul version")} {data.soul.current.version}</h3>
            <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
              {t("schema")} {data.soul.current.schemaVersion ?? t("Soul invalid")} · {data.soul.current.compilerVersion ?? t("not compiled")} · {data.soul.current.estimatedTokens ?? "—"} {t("tokens")}
            </p>
          </div>
          <span className={data.soul.valid && data.soul.current.diagnostics.length === 0
            ? "text-sm font-semibold text-[var(--ad-green-text)]"
            : "text-sm font-semibold text-[var(--ad-yellow-text)]"}>
            {data.soul.valid && data.soul.current.diagnostics.length === 0
              ? t("Release ready")
              : t("Review diagnostics")}
          </span>
        </div>
        <p className="mt-3 break-all font-mono text-xs text-[var(--ad-text-muted)]">
          {data.soul.current.fingerprint ?? t("No valid fingerprint")}
        </p>
        {data.soul.changedFields.length > 0 ? (
          <div className="mt-4">
            <p className="text-sm font-semibold">{t("Changed from Serving version")} {data.soul.previous?.version}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {data.soul.changedFields.map((field) => (
                <code className="rounded bg-[var(--ad-muted)] px-2 py-1 text-xs" key={field}>{field}</code>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      {data.soul.current.diagnostics.length > 0 ? (
        <section className="rounded-lg border border-[var(--ad-yellow-border)] bg-[var(--ad-yellow-bg)] p-4">
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

      <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-5">
        <h3 className="text-lg font-semibold">{t("Structured Soul editor")}</h3>
        <p className="mt-1 text-sm text-[var(--ad-text-muted)]">{t("Creating a version is explicit. Existing sessions keep their pinned bytes.")}</p>
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <Field label={t("Name")} value={persona.name} onChange={(value) => setPersona({ name: value })} />
          <Field label={t("Age")} type="number" value={String(persona.age)} onChange={(value) => setPersona({ age: Number(value) })} />
          <label className="text-sm font-medium">
            {t("Gender")}
            <select className={`${fieldClass} mt-2`} onChange={(event) => setPersona({ gender: event.target.value as CharacterDraftPersona["gender"] })} value={persona.gender}>
              <option value="female">{t("Female")}</option>
              <option value="male">{t("Male")}</option>
              <option value="trans">{t("Trans")}</option>
            </select>
          </label>
          <Field label={t("Relationship archetype")} value={persona.relationshipArchetype} onChange={(value) => setPersona({ relationshipArchetype: value })} />
          <Field label={t("Character promise")} value={persona.characterPromise} onChange={(value) => setPersona({ characterPromise: value })} />
          <Area label={t("Personality")} value={persona.personality} onChange={(value) => setPersona({ personality: value })} />
          <Area label={t("Backstory")} value={persona.backstory} onChange={(value) => setPersona({ backstory: value })} />
          <ListField label={t("Values")} lineSuffix={t("one per line")} value={persona.values} onChange={(value) => setPersona({ values: value })} />
          <ListField label={t("Wants")} lineSuffix={t("one per line")} value={persona.wants} onChange={(value) => setPersona({ wants: value })} />
          <ListField label={t("Fears")} lineSuffix={t("one per line")} value={persona.fears} onChange={(value) => setPersona({ fears: value })} />
          <ListField label={t("Contradictions")} lineSuffix={t("one per line")} value={persona.contradictions} onChange={(value) => setPersona({ contradictions: value })} />
          <Area label={t("Voice tone")} value={persona.tone} onChange={(value) => setPersona({ tone: value })} />
          <Area label={t("Cadence")} value={persona.cadence ?? ""} onChange={(value) => setPersona({ cadence: value })} />
          <ListField label={t("Vocabulary")} lineSuffix={t("one per line")} value={persona.vocabulary} onChange={(value) => setPersona({ vocabulary: value })} />
          <ListField label={t("Voice habits")} lineSuffix={t("one per line")} value={persona.voiceHabits} onChange={(value) => setPersona({ voiceHabits: value })} />
          <ListField label={t("Voice avoids")} lineSuffix={t("one per line")} value={persona.voiceAvoid} onChange={(value) => setPersona({ voiceAvoid: value })} />
          {(["initiative", "curiosity", "pacing", "affection", "conflict", "repair"] as const).map((key) => (
            <Area key={key} label={`${t("Interaction")} · ${t(key)}`} value={persona.interaction?.[key] ?? ""} onChange={(value) => setInteraction(key, value)} />
          ))}
          <ListField label={t("Canon facts")} lineSuffix={t("one per line")} value={persona.canon?.facts} onChange={(facts) => setPersona({ canon: { facts, unknowns: persona.canon?.unknowns ?? [] } })} />
          <ListField label={t("Canon unknowns")} lineSuffix={t("one per line")} value={persona.canon?.unknowns} onChange={(unknowns) => setPersona({ canon: { facts: persona.canon?.facts ?? [], unknowns } })} />
          <PositiveDialogueField
            label={t("Positive dialogue examples · JSON")}
            value={persona.positiveDialogue ?? []}
            onError={setDialogueError}
            onChange={(positiveDialogue) => setPersona({
              positiveDialogue,
              exampleDialogue: positiveDialogue.map((item) => item.assistant),
            })}
          />
          <Area
            label={t("Negative dialogue · assistant text :: reason · one per line")}
            value={(persona.negativeDialogue ?? []).map((item) => `${item.assistant} :: ${item.reason}`).join("\n")}
            onChange={(value) => setPersona({
              negativeDialogue: value.split("\n").map((line) => {
                const [assistant, ...reason] = line.split("::");
                return { assistant: assistant?.trim() ?? "", reason: reason.join("::").trim() };
              }).filter((item) => item.assistant && item.reason),
            })}
          />
          <Area label={t("Opening message")} value={persona.firstMessage} onChange={(value) => setPersona({ firstMessage: value })} />
        </div>
        <label className="mt-5 block text-sm font-medium">
          {t("Reason")}
          <input className={`${fieldClass} mt-2`} onChange={(event) => setReason(event.target.value)} value={reason} />
        </label>
        {dialogueError ? <p className="mt-3 text-sm text-[var(--ad-red-text)]" role="alert">{dialogueError}</p> : null}
        {error ? <p className="mt-3 text-sm text-[var(--ad-red-text)]" role="alert">{error}</p> : null}
        <div className="mt-5">
          <WorkspaceButton disabled={!canWrite || busy || Boolean(dialogueError) || reason.trim().length < 3} onClick={() => void createVersion()} tone="primary">
            {busy ? t("Creating version…") : t("Create Soul version")}
          </WorkspaceButton>
        </div>
      </section>

      <div className="grid gap-5 xl:grid-cols-2">
        <ReadOnlyArtifact title={t("Generated SOUL.md")} unavailableLabel={t("Unavailable until the Soul compiles.")} value={data.soul.current.markdown} />
        <ReadOnlyArtifact title={t("Compiled system prompt")} unavailableLabel={t("Unavailable until the Soul compiles.")} value={data.soul.current.systemPrompt} />
      </div>
    </div>
  );
}

export function soulDraftFromWorkspace(data: CharacterWorkspaceDetail): CharacterDraftPersona | null {
  const soul = data.soul.current.soul;
  if (!soul) return null;
  const identity = asRecord(soul.identity);
  const innerLife = asRecord(soul.innerLife);
  const voice = asRecord(soul.voice);
  const interaction = asRecord(soul.interaction);
  const canon = asRecord(soul.canon);
  const dialogue = asRecord(soul.dialogue);
  const opening = data.preview.draft.opening;
  const parsed = characterDraftPersonaSchema.safeParse({
    name: identity.name,
    age: identity.age,
    gender: identity.gender,
    relationshipArchetype: identity.relationshipArchetype,
    characterPromise: identity.characterPromise,
    personality: innerLife.personality ?? "",
    values: stringList(innerLife.values),
    wants: stringList(innerLife.wants),
    fears: stringList(innerLife.fears),
    contradictions: stringList(innerLife.contradictions),
    tone: voice.tone ?? "",
    cadence: typeof voice.cadence === "string" ? voice.cadence : "",
    vocabulary: stringList(voice.vocabulary),
    voiceHabits: stringList(voice.habits),
    voiceAvoid: stringList(voice.avoid),
    backstory: innerLife.backstory ?? "",
    firstMessage: typeof opening.firstMessage === "string" ? opening.firstMessage : "",
    exampleDialogue: Array.isArray(dialogue.positive)
      ? dialogue.positive.flatMap((value) => {
          const item = asRecord(value);
          return typeof item.assistant === "string" ? [item.assistant] : [];
        })
      : [],
    positiveDialogue: Array.isArray(dialogue.positive) ? dialogue.positive : [],
    interaction,
    canon: {
      facts: stringList(canon.facts),
      unknowns: stringList(canon.unknowns),
    },
    negativeDialogue: Array.isArray(dialogue.negative) ? dialogue.negative : [],
  });
  return parsed.success ? parsed.data : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function Field({ label, value, onChange, type = "text" }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "number";
}) {
  return <label className="text-sm font-medium">{label}<input className={`${fieldClass} mt-2`} onChange={(event) => onChange(event.target.value)} type={type} value={value} /></label>;
}

function Area({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="text-sm font-medium">{label}<textarea className={`${textAreaClass} mt-2 min-h-24`} onChange={(event) => onChange(event.target.value)} value={value} /></label>;
}

function PositiveDialogueField({ label, value, onChange, onError }: {
  label: string;
  value: NonNullable<CharacterDraftPersona["positiveDialogue"]>;
  onChange: (value: NonNullable<CharacterDraftPersona["positiveDialogue"]>) => void;
  onError: (value: string | null) => void;
}) {
  const [raw, setRaw] = useState(() => JSON.stringify(value, null, 2));
  const parse = (next: string) => {
    setRaw(next);
    try {
      const candidate = characterDraftPersonaSchema.shape.positiveDialogue.safeParse(JSON.parse(next));
      if (!candidate.success) {
        onError(candidate.error.issues[0]?.message ?? "Invalid positive dialogue");
        return;
      }
      onError(null);
      onChange(candidate.data ?? []);
    } catch {
      onError("Positive dialogue must be valid JSON");
    }
  };
  return (
    <label className="text-sm font-medium">
      {label}
      <textarea className={`${textAreaClass} mt-2 min-h-56 font-mono text-xs`} onChange={(event) => parse(event.target.value)} value={raw} />
    </label>
  );
}

function ListField({ label, lineSuffix, value = [], onChange }: { label: string; lineSuffix: string; value?: readonly string[]; onChange: (value: string[]) => void }) {
  return <Area label={`${label} · ${lineSuffix}`} value={value.join("\n")} onChange={(next) => onChange(next.split("\n").map((item) => item.trim()).filter(Boolean))} />;
}

function ReadOnlyArtifact({ title, unavailableLabel, value }: { title: string; unavailableLabel: string; value: string | null }) {
  return (
    <details className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]" open>
      <summary className="cursor-pointer p-4 font-semibold">{title}</summary>
      <pre className="max-h-[36rem] overflow-auto whitespace-pre-wrap border-t border-[var(--ad-border)] p-4 text-xs leading-6">{value ?? unavailableLabel}</pre>
    </details>
  );
}
