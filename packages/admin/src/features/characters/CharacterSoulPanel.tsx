"use client";

import {
  characterDraftPersonaSchema,
  type CharacterDraftPersona,
  type CharacterWorkspaceDetail,
} from "@idream/shared/admin";
import { compileCharacterSoul } from "@idream/shared/chat/persona";
import { useRef, useState } from "react";
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
  // SPEC: 新建 Soul 版本会成为角色人格的权威快照，确认走 ConfirmDialog（它自己收 reason ≥3）。
  // INTENT: 原先只有一个 reason 输入框加一个按钮 —— 与同一工作台里"改个标签都要走对话框"
  //         的门槛完全倒置。
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
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
  const draftPreview = compileSoulDraftPreview(persona);

  const createVersion = async (reason: string) => {
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
        commit: () => adminV2Operation(
          "POST /api/v2/admin/characters/:id/soul/versions",
          {
            path: { id: data.character.id },
            idempotencyKey,
            ifMatch: data.project.version,
            body: {
              entityVersion: data.project.version,
              expectedContentVersionId: data.soul.current.contentVersionId,
              persona,
              reason,
            },
          },
        ),
      });
      mutationKey.current = null;
    } catch (cause) {
      setError(
        cause instanceof AdminV2RequestError && cause.status === 409
          ? t("A newer Soul or Character draft exists. Reload before creating another version.")
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
            <h3 className="mt-1 text-lg font-semibold">{t("Character Soul version")} {data.soul.current.version}</h3>
          </div>
          <span className={data.soul.valid && data.soul.current.diagnostics.length === 0
            ? "text-sm font-semibold text-[var(--ad-green-text)]"
            : "text-sm font-semibold text-[var(--ad-yellow-text)]"}>
            {data.soul.valid && data.soul.current.diagnostics.length === 0
              ? t("Release ready")
              : t("Review diagnostics")}
          </span>
        </div>
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
        <h3 className="text-lg font-semibold">{t("Soul editor")}</h3>
        <p className="mt-1 text-sm text-[var(--ad-text-muted)]">{t("Keep the basics clear. Put anything else in Markdown. Creating a version is explicit, and existing sessions keep their pinned bytes.")}</p>
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <Field label={t("Name")} value={persona.name} onChange={(value) => setPersona({ name: value })} />
          <Field label={t("Age")} max={120} min={18} type="number" value={String(persona.age)} onChange={(value) => setPersona({ age: Number(value) })} />
          <label className="text-sm font-medium">
            {t("Gender")}
            <select className={`${fieldClass} mt-2`} onChange={(event) => setPersona({ gender: event.target.value as CharacterDraftPersona["gender"] })} value={persona.gender}>
              <option value="female">{t("Female")}</option>
              <option value="male">{t("Male")}</option>
              <option value="trans">{t("Trans")}</option>
            </select>
          </label>
          <Field label={t("Character promise")} value={persona.characterPromise} onChange={(value) => setPersona({ characterPromise: value })} />
          <Area label={t("Opening message")} value={persona.firstMessage} onChange={(value) => setPersona({ firstMessage: value })} />
          <div className="lg:col-span-2">
            <Area label={t("Additional details · Markdown (optional)")} value={persona.detailsMarkdown} onChange={(value) => setPersona({ detailsMarkdown: value })} />
          </div>
        </div>
        {error ? <p className="mt-3 text-sm text-[var(--ad-red-text)]" role="alert">{error}</p> : null}
        <div className="mt-5">
          <WorkspaceButton disabled={!canWrite || busy} onClick={() => setConfirmOpen(true)} tone="primary">
            {busy ? t("Creating version…") : t("Create Soul version")}
          </WorkspaceButton>
        </div>
      </section>

      <details className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-5">
        <summary className="cursor-pointer text-sm font-semibold">{t("Technical details")}</summary>
        <p className="mt-3 text-xs text-[var(--ad-text-muted)]">{t("schema")} {data.soul.current.schemaVersion ?? t("Soul invalid")} · {data.soul.current.compilerVersion ?? t("not compiled")} · {data.soul.current.estimatedTokens ?? "—"} {t("tokens")}</p>
        <p className="mt-2 break-all font-mono text-xs text-[var(--ad-text-muted)]">{data.soul.current.fingerprint ?? t("No valid fingerprint")}</p>
        <div className="mt-4 grid gap-5 xl:grid-cols-2">
          <ReadOnlyArtifact title={t("Generated SOUL.md")} unavailableLabel={t("Unavailable until the Soul compiles.")} value={draftPreview?.markdown ?? ""} />
          <ReadOnlyArtifact title={t("Compiled system prompt")} unavailableLabel={t("Unavailable until the Soul compiles.")} value={draftPreview?.systemPrompt ?? ""} />
        </div>
      </details>
      {confirmOpen ? (
        <ConfirmDialog
          onClose={() => setConfirmOpen(false)}
          spec={{
            title: t("Create Soul version"),
            summary: (
              <div className="space-y-2">
                <p>
                  {t(
                    "This becomes the authoritative persona for new chat. Version {version} is kept as history and is not deleted.",
                    { version: data.soul.current.version },
                  )}
                </p>
                <p>
                  {t(
                    "It does not publish a Release. Live chat keeps the released Soul until a Release ships this version.",
                  )}
                </p>
              </div>
            ),
            reasonLabel: t("Reason"),
            submitLabel: t("Create Soul version"),
            onSubmit: async (reason) => {
              await createVersion(reason);
              setConfirmOpen(false);
            },
          }}
        />
      ) : null}
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

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function Field({ label, value, onChange, type = "text", min, max }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "number";
  min?: number;
  max?: number;
}) {
  return <label className="text-sm font-medium">{label}<input className={`${fieldClass} mt-2`} max={max} min={min} onChange={(event) => onChange(event.target.value)} type={type} value={value} /></label>;
}

function Area({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="text-sm font-medium">{label}<textarea className={`${textAreaClass} mt-2 min-h-24`} onChange={(event) => onChange(event.target.value)} value={value} /></label>;
}

function ReadOnlyArtifact({ title, unavailableLabel, value }: { title: string; unavailableLabel: string; value: string | null }) {
  return (
    <details className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
      <summary className="cursor-pointer p-4 font-semibold">{title}</summary>
      <pre className="max-h-[36rem] overflow-auto whitespace-pre-wrap border-t border-[var(--ad-border)] p-4 text-xs leading-6">{value ?? unavailableLabel}</pre>
    </details>
  );
}
