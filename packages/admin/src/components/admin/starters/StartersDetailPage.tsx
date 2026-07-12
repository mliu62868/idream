"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { DetailPage, DetailSection } from "@/components/admin/ui/DetailPage";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { FormSection, Field, INPUT_CLASS, TEXTAREA_CLASS } from "@/components/admin/ui/FormPage";
import { DangerButton, GhostButton, PrimaryButton } from "@/components/admin/ui/buttons";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { EngineeringDetails } from "@/components/admin/generation/EngineeringDetails";
import {
  SCOPES,
  STARTER_GENDERS,
  STARTER_STYLES,
  STARTERS_LIST,
  starterPayload,
  starterTextField,
  type Starter,
  type StarterDraft,
} from "./starters-api";

// SPEC: 角色模板详情页 —— 查看 + 就地编辑 + 上/下线（spec §7 详情页）。
// INTENT: 无单条 GET，复用列表接口按 id 过滤；编辑态字段与新建页同构。
type Mode = "view" | "edit";
type PendingAction = "save" | "activate" | "deactivate" | null;

function draftFromRow(row: Starter): StarterDraft {
  const scopes: readonly string[] = SCOPES;
  return {
    name: row.name,
    summary: row.summary ?? "",
    gender: row.gender ?? "",
    style: row.style ?? "",
    scope: (scopes.includes(row.scope) ? row.scope : SCOPES[0]) as StarterDraft["scope"],
    tags: row.tags.join(", "),
    sortOrder: String(row.sortOrder),
    creativeBrief: starterTextField(row.advancedDetails, "creativeBrief"),
    archetype: starterTextField(row.advancedDetails, "archetype"),
    relationship: starterTextField(row.advancedDetails, "relationship"),
    personality: starterTextField(row.advancedDetails, "personality"),
    speakingStyle: starterTextField(row.advancedDetails, "speakingStyle"),
    firstMessage: starterTextField(row.advancedDetails, "firstMessage"),
    exampleDialogue: starterTextField(row.advancedDetails, "exampleDialogue"),
    appearanceNotes: starterTextField(row.appearance, "notes"),
    visualBrief:
      starterTextField(row.appearance, "visualBrief") ||
      starterTextField(row.advancedDetails, "visualBrief"),
    reason: "",
  };
}

function InfoGrid({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
      {items.map((item) => (
        <div key={item.label}>
          <dt className="text-xs text-[var(--ad-text-muted)]">{item.label}</dt>
          <dd className="mt-0.5 text-sm text-[var(--ad-ink)]">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function StartersDetailPage({ id }: { id: string }) {
  const { t, value } = useAdminI18n();
  const [rows, setRows] = useState<Starter[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("view");
  const [draft, setDraft] = useState<StarterDraft | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ template: Starter }>(`${STARTERS_LIST}/${encodeURIComponent(id)}`);
      setRows([data.template]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("Request failed"));
    } finally {
      setLoading(false);
    }
  }, [id, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void reload();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [reload]);

  const row = useMemo(() => rows.find((item) => item.id === id), [rows, id]);

  function startEdit(current: Starter) {
    setDraft(draftFromRow(current));
    setMode("edit");
  }

  function cancelEdit() {
    setDraft(null);
    setMode("view");
  }

  function updateDraft<K extends keyof StarterDraft>(key: K, next: StarterDraft[K]) {
    setDraft((prev) => (prev ? { ...prev, [key]: next } : prev));
  }

  const confirmSpec: ConfirmSpec | null = useMemo(() => {
    if (!row || !pending) return null;
    if (pending === "save") {
      if (!draft) return null;
      return {
        title: t("Save changes"),
        submitLabel: t("Save changes"),
        onSubmit: async (reason) => {
          await apiWrite(`${STARTERS_LIST}/${id}`, "PATCH", starterPayload({ ...draft, reason }));
          await reload();
          setMode("view");
          setDraft(null);
        },
      };
    }
    if (pending === "activate") {
      return {
        title: t("Publish"),
        destructive: { expectedName: row.name },
        submitLabel: t("Publish"),
        onSubmit: async (reason) => {
          await apiWrite(`${STARTERS_LIST}/${id}/active`, "POST", { active: true, reason, confirmation: id });
          await reload();
        },
      };
    }
    return {
      title: t("Offline"),
      destructive: { expectedName: row.name },
      submitLabel: t("Offline"),
      onSubmit: async (reason) => {
        await apiWrite(`${STARTERS_LIST}/${id}/active`, "POST", { active: false, reason, confirmation: id });
        await reload();
      },
    };
  }, [pending, draft, row, id, t, reload]);

  if (loading) {
    return <p className="text-sm text-[var(--ad-text-muted)]">{t("Loading…")}</p>;
  }

  if (!row) {
    return (
      <EmptyState
        action={
          <Link href="/admin/content/templates">
            <PrimaryButton>{t("Back to starter templates")}</PrimaryButton>
          </Link>
        }
        hint={error ?? undefined}
        title={t("Character not found.")}
      />
    );
  }

  const actions =
    mode === "edit" ? (
      <>
        <GhostButton onClick={cancelEdit}>{t("Cancel")}</GhostButton>
        <PrimaryButton onClick={() => setPending("save")}>{t("Save changes")}</PrimaryButton>
      </>
    ) : (
      <>
        <GhostButton onClick={() => startEdit(row)}>{t("Edit profile")}</GhostButton>
        {row.isActive ? (
          <DangerButton onClick={() => setPending("deactivate")}>{t("Offline")}</DangerButton>
        ) : (
          <PrimaryButton onClick={() => setPending("activate")}>{t("Publish")}</PrimaryButton>
        )}
      </>
    );

  return (
    <DetailPage
      actions={actions}
      backHref="/admin/content/templates"
      backLabel={t("Back to starter templates")}
      status={row.isActive ? "active" : "disabled"}
      statusLabel={row.isActive ? t("Published") : t("Inactive")}
      title={row.name}
    >
      {error ? <p className="text-sm text-[var(--ad-red-text)]">{error}</p> : null}

      {mode === "edit" && draft ? (
        <>
          <FormSection title={t("Basic info")}>
            <Field label={t("Name (≥1)")}>
              <input
                className={INPUT_CLASS}
                onChange={(event) => updateDraft("name", event.target.value)}
                value={draft.name}
              />
            </Field>
            <Field label={t("Sort order")}>
              <input
                className={INPUT_CLASS}
                onChange={(event) => updateDraft("sortOrder", event.target.value)}
                type="number"
                value={draft.sortOrder}
              />
            </Field>
            <Field label={t("Scope")}>
              <select
                className={INPUT_CLASS}
                onChange={(event) => updateDraft("scope", event.target.value as StarterDraft["scope"])}
                value={draft.scope}
              >
                {SCOPES.map((scope) => (
                  <option key={scope} value={scope}>
                    {value(scope)}
                  </option>
                ))}
              </select>
            </Field>
          </FormSection>
          <FormSection title={t("Category")}>
            <Field label={t("Gender")}>
              <select
                className={INPUT_CLASS}
                onChange={(event) => updateDraft("gender", event.target.value)}
                value={draft.gender}
              >
                {STARTER_GENDERS.map((item) => <option key={item || "any"} value={item}>{item ? value(item) : "Any gender"}</option>)}
              </select>
            </Field>
            <Field label={t("Style")}>
              <select
                className={INPUT_CLASS}
                onChange={(event) => updateDraft("style", event.target.value)}
                value={draft.style}
              >
                {STARTER_STYLES.map((item) => <option key={item || "any"} value={item}>{item ? value(item) : "Any style"}</option>)}
              </select>
            </Field>
          </FormSection>
          <FormSection title={t("Description & tags")}>
            <Field full label={t("Summary (≤200)")}>
              <textarea
                className={TEXTAREA_CLASS}
                onChange={(event) => updateDraft("summary", event.target.value)}
                value={draft.summary}
              />
            </Field>
            <Field full label={t("Tags (comma-separated, ≤12)")}>
              <input
                className={INPUT_CLASS}
                onChange={(event) => updateDraft("tags", event.target.value)}
                value={draft.tags}
              />
            </Field>
          </FormSection>
          <FormSection title="Reusable persona">
            <Field full label="Creative brief"><textarea className={TEXTAREA_CLASS} onChange={(event) => updateDraft("creativeBrief", event.target.value)} value={draft.creativeBrief} /></Field>
            <Field label="Archetype"><input className={INPUT_CLASS} onChange={(event) => updateDraft("archetype", event.target.value)} value={draft.archetype} /></Field>
            <Field label="Relationship"><input className={INPUT_CLASS} onChange={(event) => updateDraft("relationship", event.target.value)} value={draft.relationship} /></Field>
            <Field full label="Personality"><textarea className={TEXTAREA_CLASS} onChange={(event) => updateDraft("personality", event.target.value)} value={draft.personality} /></Field>
            <Field full label="Speaking style"><textarea className={TEXTAREA_CLASS} onChange={(event) => updateDraft("speakingStyle", event.target.value)} value={draft.speakingStyle} /></Field>
            <Field full label="First message"><textarea className={TEXTAREA_CLASS} onChange={(event) => updateDraft("firstMessage", event.target.value)} value={draft.firstMessage} /></Field>
            <Field full label="Example dialogue"><textarea className={TEXTAREA_CLASS} onChange={(event) => updateDraft("exampleDialogue", event.target.value)} value={draft.exampleDialogue} /></Field>
          </FormSection>
          <FormSection title="Reusable visual direction">
            <Field full label="Appearance anchors"><textarea className={TEXTAREA_CLASS} onChange={(event) => updateDraft("appearanceNotes", event.target.value)} value={draft.appearanceNotes} /></Field>
            <Field full label="Art direction"><textarea className={TEXTAREA_CLASS} onChange={(event) => updateDraft("visualBrief", event.target.value)} value={draft.visualBrief} /></Field>
          </FormSection>
        </>
      ) : (
        <>
          <DetailSection title={t("Basic info")}>
            <InfoGrid
              items={[
                { label: t("Scope"), value: value(row.scope) },
                { label: t("Sort order"), value: row.sortOrder },
              ]}
            />
          </DetailSection>

          <DetailSection title={t("Category")}>
            <InfoGrid
              items={[
                { label: t("Gender"), value: row.gender || "—" },
                { label: t("Style"), value: row.style || "—" },
              ]}
            />
          </DetailSection>

          <DetailSection title={t("Description & tags")}>
            <p className="text-sm text-[var(--ad-text)]">{row.summary || "—"}</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {row.tags.length === 0 ? (
                <span className="text-sm text-[var(--ad-text-muted)]">—</span>
              ) : (
                row.tags.map((tag) => (
                  <span
                    className="inline-flex items-center rounded-full bg-black/[0.05] px-2.5 py-0.5 text-[11px] font-medium text-[var(--ad-text-muted)]"
                    key={tag}
                  >
                    {tag}
                  </span>
                ))
              )}
            </div>
          </DetailSection>

          <DetailSection title="Reusable character foundation">
            <div className="grid gap-5 md:grid-cols-2">
              <div><p className="text-xs text-[var(--ad-text-muted)]">Creative brief</p><p className="mt-1 whitespace-pre-wrap text-sm text-[var(--ad-text)]">{starterTextField(row.advancedDetails, "creativeBrief") || "—"}</p></div>
              <div><p className="text-xs text-[var(--ad-text-muted)]">Personality</p><p className="mt-1 whitespace-pre-wrap text-sm text-[var(--ad-text)]">{starterTextField(row.advancedDetails, "personality") || "—"}</p></div>
              <div><p className="text-xs text-[var(--ad-text-muted)]">First message</p><p className="mt-1 whitespace-pre-wrap text-sm text-[var(--ad-text)]">{starterTextField(row.advancedDetails, "firstMessage") || "—"}</p></div>
              <div><p className="text-xs text-[var(--ad-text-muted)]">Visual direction</p><p className="mt-1 whitespace-pre-wrap text-sm text-[var(--ad-text)]">{starterTextField(row.appearance, "visualBrief") || starterTextField(row.advancedDetails, "visualBrief") || "—"}</p></div>
            </div>
          </DetailSection>

          <EngineeringDetails summary={t("Engineering details")}>
            <div>starter.id = {row.id}</div>
            <div>scope = {row.scope}</div>
          </EngineeringDetails>
        </>
      )}

      {confirmSpec ? <ConfirmDialog onClose={() => setPending(null)} spec={confirmSpec} /> : null}
    </DetailPage>
  );
}
