"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  BarChart3,
  Check,
  Eye,
  History,
  ImageIcon,
  MessageCircle,
  Sparkles,
  UserRound,
} from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { CharacterPregenPanel } from "@/components/admin/CharacterPregenPanel";
import { useAdminI18n } from "@/components/admin/i18n";
import { DetailPage, DetailSection } from "@/components/admin/ui/DetailPage";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { FormSection, Field, INPUT_CLASS, TEXTAREA_CLASS } from "@/components/admin/ui/FormPage";
import { DangerButton, GhostButton, PrimaryButton } from "@/components/admin/ui/buttons";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { VisualPassportPanel } from "@/components/admin/VisualPassportPanel";
import { EngineeringDetails } from "@/components/admin/generation/EngineeringDetails";
import { cn } from "@/lib/utils";
import {
  characterReadiness,
  characterThumbnails,
  GENDERS,
  OFFICIAL_LIST,
  STYLES,
  officialPayload,
  textField,
  type OfficialDraft,
  type OfficialRow,
  type ThumbAsset,
  visualSourceImage,
} from "./official-api";

type Mode = "view" | "edit";
type PendingAction = "save" | "approve" | "archive" | null;
type WorkspaceTab = "overview" | "persona" | "visual" | "assets" | "preview" | "performance" | "history";

const TABS: Array<{ id: WorkspaceTab; label: string; icon: typeof UserRound }> = [
  { id: "overview", label: "Overview", icon: UserRound },
  { id: "persona", label: "Persona", icon: MessageCircle },
  { id: "visual", label: "Visual identity", icon: Sparkles },
  { id: "assets", label: "Assets", icon: ImageIcon },
  { id: "preview", label: "Preview", icon: Eye },
  { id: "performance", label: "Performance", icon: BarChart3 },
  { id: "history", label: "History", icon: History },
];

function draftFromRow(row: OfficialRow): OfficialDraft {
  const genders: readonly string[] = GENDERS;
  const styles: readonly string[] = STYLES;
  return {
    name: row.name,
    age: String(row.age),
    gender: (genders.includes(row.gender) ? row.gender : GENDERS[0]) as OfficialDraft["gender"],
    style: (styles.includes(row.style) ? row.style : STYLES[0]) as OfficialDraft["style"],
    description: row.description,
    tags: row.tags.join(", "),
    creativeBrief: textField(row.advancedDetails, "creativeBrief"),
    archetype: textField(row.advancedDetails, "archetype"),
    relationship: textField(row.advancedDetails, "relationship"),
    personality: textField(row.advancedDetails, "personality"),
    speakingStyle: textField(row.advancedDetails, "speakingStyle"),
    backstory: textField(row.advancedDetails, "backstory"),
    firstMessage: textField(row.advancedDetails, "firstMessage"),
    exampleDialogue: textField(row.advancedDetails, "exampleDialogue"),
    appearanceNotes: textField(row.appearance, "notes"),
    visualBrief:
      textField(row.appearance, "visualBrief") || textField(row.advancedDetails, "visualBrief"),
    reason: "",
  };
}

function InfoGrid({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3">
      {items.map((item) => (
        <div key={item.label}>
          <dt className="text-xs text-[var(--ad-text-muted)]">{item.label}</dt>
          <dd className="mt-1 text-sm text-[var(--ad-ink)]">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function TextBlock({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-semibold text-[var(--ad-text-muted)]">{label}</p>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-[var(--ad-text)]">{value || "Not written yet."}</p>
    </div>
  );
}

export function OfficialDetailPage({ id }: { id: string }) {
  const { locale, t, value } = useAdminI18n();
  const [rows, setRows] = useState<OfficialRow[]>([]);
  const [thumbs, setThumbs] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("view");
  const [tab, setTab] = useState<WorkspaceTab>("overview");
  const [draft, setDraft] = useState<OfficialDraft | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ items: OfficialRow[] }>(
        `${OFFICIAL_LIST}?search=${encodeURIComponent(id)}&limit=1`,
      );
      setRows(data.items);
      try {
        const assets = await apiGet<{ items: ThumbAsset[] }>(
          "/api/v1/admin/content/assets?status=approved&limit=100",
        );
        setThumbs(characterThumbnails(assets.items));
      } catch {
        setThumbs(new Map());
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("Request failed"));
    } finally {
      setLoading(false);
    }
  }, [id, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(timer);
  }, [reload]);

  const row = useMemo(() => rows.find((item) => item.id === id), [rows, id]);
  const thumbnail = row ? thumbs.get(row.id) ?? visualSourceImage(row) ?? undefined : undefined;
  const readiness = row ? characterReadiness(row, Boolean(row.imageAssetId)) : null;

  function startEdit(current: OfficialRow) {
    setDraft(draftFromRow(current));
    setMode("edit");
  }

  function cancelEdit() {
    setDraft(null);
    setMode("view");
  }

  function updateDraft<K extends keyof OfficialDraft>(key: K, next: OfficialDraft[K]) {
    setDraft((current) => (current ? { ...current, [key]: next } : current));
  }

  const confirmSpec: ConfirmSpec | null = useMemo(() => {
    if (!row || !pending) return null;
    if (pending === "save") {
      if (!draft) return null;
      return {
        title: t("Save changes"),
        summary: "This updates the character project but does not publish it.",
        submitLabel: t("Save changes"),
        onSubmit: async (reason) => {
          await apiWrite(`${OFFICIAL_LIST}/${id}`, "PATCH", officialPayload({ ...draft, reason }));
          await reload();
          setMode("view");
          setDraft(null);
        },
      };
    }
    if (pending === "approve") {
      return {
        title: t("Publish character"),
        summary: "This makes the character visible to users. Confirm that the persona, visual identity, artwork, and preview are ready.",
        submitLabel: t("Publish"),
        onSubmit: async (reason) => {
          await apiWrite(`${OFFICIAL_LIST}/${id}/state`, "POST", { status: "approved", reason });
          await reload();
        },
      };
    }
    return {
      title: t("Unpublish character"),
      destructive: { expectedName: row.name },
      submitLabel: t("Unpublish"),
      onSubmit: async (reason) => {
        await apiWrite(`${OFFICIAL_LIST}/${id}/state`, "POST", { status: "archived", reason });
        await reload();
      },
    };
  }, [draft, id, pending, reload, row, t]);

  if (loading) {
    return <div className="h-72 animate-pulse rounded-lg bg-black/[0.04]" aria-label="Loading character workspace" />;
  }

  if (!row) {
    return (
      <EmptyState
        action={<Link href="/admin/content/official"><PrimaryButton>{t("Back to official characters")}</PrimaryButton></Link>}
        hint={error ?? undefined}
        title={t("Character not found.")}
      />
    );
  }

  const publishReady = readiness?.score === 100;
  const actions = mode === "edit" ? (
    <>
      <GhostButton onClick={cancelEdit}>{t("Cancel")}</GhostButton>
      <PrimaryButton onClick={() => setPending("save")}>{t("Save changes")}</PrimaryButton>
    </>
  ) : (
    <>
      <GhostButton onClick={() => startEdit(row)}>{t("Edit profile")}</GhostButton>
      {row.status === "approved" ? (
        <DangerButton onClick={() => setPending("archive")}>{t("Unpublish")}</DangerButton>
      ) : (
        <PrimaryButton
          disabled={!publishReady}
          onClick={() => setPending("approve")}
          title={publishReady ? undefined : `Complete before publishing: ${readiness?.missing.join(", ")}`}
        >
          {publishReady ? t("Publish") : "Complete release checks"}
        </PrimaryButton>
      )}
    </>
  );

  return (
    <DetailPage
      actions={actions}
      backHref="/admin/content/official"
      backLabel={t("Back to official characters")}
      status={row.status}
      statusLabel={value(row.status)}
      title={row.name}
    >
      {error ? <p role="alert" className="text-sm text-[var(--ad-red-text)]">{error}</p> : null}

      {mode === "edit" && draft ? (
        <CharacterEditForm draft={draft} onChange={updateDraft} valueLabel={value} />
      ) : (
        <>
          <section className="overflow-hidden rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
            <div className="grid md:grid-cols-[180px_1fr]">
              <div className="grid min-h-48 place-items-center bg-black/[0.035] text-5xl font-semibold text-[var(--ad-text-muted)]">
                {thumbnail ? (
                  // eslint-disable-next-line @next/next/no-img-element -- admin blob URLs are not compatible with next/image optimization
                  <img alt={row.name} className="h-full w-full object-cover" src={thumbnail} />
                ) : row.name.slice(0, 1).toUpperCase()}
              </div>
              <div className="p-6">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="max-w-2xl">
                    <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ad-text-muted)]">Character project</p>
                    <p className="mt-3 text-sm leading-relaxed text-[var(--ad-text)]">{row.description}</p>
                    <div className="mt-4 flex flex-wrap gap-1.5">
                      {row.tags.map((tag) => <span className="rounded-md bg-black/[0.05] px-2 py-1 text-xs text-[var(--ad-text-muted)]" key={tag}>{tag}</span>)}
                    </div>
                  </div>
                  <div className="min-w-44 rounded-lg bg-black/[0.03] p-4">
                    <div className="flex items-end justify-between gap-3">
                      <span className="text-xs text-[var(--ad-text-muted)]">Release readiness</span>
                      <strong className="text-xl tabular-nums text-[var(--ad-ink)]">{readiness?.score}%</strong>
                    </div>
                    <progress aria-label={`${readiness?.score}% release ready`} className="mt-3 h-1.5 w-full accent-[var(--ad-ink)]" max={100} value={readiness?.score ?? 0} />
                    <p className="mt-3 text-xs leading-relaxed text-[var(--ad-text-muted)]">
                      {readiness?.missing[0] ? `Next: ${readiness.missing[0]}` : "All release checks are complete."}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <nav aria-label="Character workspace" className="flex gap-1 overflow-x-auto border-b border-[var(--ad-border)]">
            {TABS.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  aria-current={tab === item.id ? "page" : undefined}
                  className={cn(
                    "inline-flex h-11 shrink-0 items-center gap-2 border-b-2 border-transparent px-3 text-sm text-[var(--ad-text-muted)] hover:text-[var(--ad-ink)] focus-visible:outline focus-visible:outline-2",
                    tab === item.id && "border-[var(--ad-ink)] font-semibold text-[var(--ad-ink)]",
                  )}
                  key={item.id}
                  onClick={() => setTab(item.id)}
                  type="button"
                >
                  <Icon className="h-4 w-4" /> {item.label}
                </button>
              );
            })}
          </nav>

          {tab === "overview" ? (
            <div className="grid gap-6 lg:grid-cols-[1fr_0.8fr]">
              <DetailSection title={t("Profile")}>
                <InfoGrid items={[
                  { label: t("Gender"), value: value(row.gender) },
                  { label: t("Style"), value: value(row.style) },
                  { label: t("Age"), value: row.age },
                  { label: t("Visibility"), value: value(row.visibility) },
                  { label: t("Created"), value: new Date(row.createdAt).toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US") },
                  { label: "Last updated", value: new Date(row.updatedAt).toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US") },
                ]} />
              </DetailSection>
              <DetailSection title="Release checklist">
                <div className="space-y-3">
                  {["Core profile", "Persona", "Visual direction", "Visual identity", "Reference images", "Published artwork"].map((label) => {
                    const complete = !readiness?.missing.includes(label);
                    return (
                      <div className="flex items-center justify-between gap-3" key={label}>
                        <span className="text-sm text-[var(--ad-text)]">{label}</span>
                        <span className={cn("inline-flex items-center gap-1 text-xs", complete ? "text-[var(--ad-green-text)]" : "text-[var(--ad-text-muted)]")}>
                          {complete ? <Check className="h-3.5 w-3.5" /> : null}{complete ? "Ready" : "Needs work"}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </DetailSection>
            </div>
          ) : null}

          {tab === "persona" ? (
            <div className="grid gap-6 md:grid-cols-2">
              <DetailSection title="Character foundation">
                <div className="space-y-6">
                  <TextBlock label="Creative brief" value={textField(row.advancedDetails, "creativeBrief")} />
                  <TextBlock label="Archetype" value={textField(row.advancedDetails, "archetype")} />
                  <TextBlock label="Relationship" value={textField(row.advancedDetails, "relationship")} />
                  <TextBlock label="Personality" value={textField(row.advancedDetails, "personality")} />
                  <TextBlock label="Speaking style" value={textField(row.advancedDetails, "speakingStyle")} />
                  <TextBlock label="Backstory" value={textField(row.advancedDetails, "backstory")} />
                </div>
              </DetailSection>
              <DetailSection title="Conversation design">
                <div className="space-y-6">
                  <TextBlock label="First message" value={textField(row.advancedDetails, "firstMessage")} />
                  <TextBlock label="Example dialogue" value={textField(row.advancedDetails, "exampleDialogue")} />
                </div>
              </DetailSection>
            </div>
          ) : null}

          {tab === "visual" ? <VisualPassportPanel characterId={row.id} /> : null}

          {tab === "assets" ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
                <div>
                  <p className="text-sm font-semibold text-[var(--ad-ink)]">Creative production studio</p>
                  <p className="mt-1 text-xs text-[var(--ad-text-muted)]">Explore multiple image directions with this character already selected.</p>
                </div>
                <Link href={{ pathname: "/admin/content/production", query: { characterId: row.id } }}>
                  <PrimaryButton>Open studio</PrimaryButton>
                </Link>
              </div>
              <CharacterPregenPanel characterId={row.id} />
            </>
          ) : null}

          {tab === "preview" ? (
            <div className="grid gap-6 lg:grid-cols-[0.8fr_1.2fr]">
              <section className="overflow-hidden rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
                <div className="aspect-[4/5] bg-black/[0.04]">
                  {thumbnail ? (
                    // eslint-disable-next-line @next/next/no-img-element -- admin blob URLs are not compatible with next/image optimization
                    <img alt={`${row.name} card preview`} className="h-full w-full object-cover" src={thumbnail} />
                  ) : <div className="grid h-full place-items-center text-6xl font-semibold text-[var(--ad-text-muted)]">{row.name.slice(0, 1).toUpperCase()}</div>}
                </div>
                <div className="p-5"><h3 className="text-lg font-semibold text-[var(--ad-ink)]">{row.name}</h3><p className="mt-2 line-clamp-3 text-sm leading-relaxed text-[var(--ad-text-muted)]">{row.description}</p></div>
              </section>
              <DetailSection title="First conversation preview">
                <div className="rounded-lg bg-black/[0.035] p-5">
                  <p className="text-xs font-semibold text-[var(--ad-text-muted)]">{row.name}</p>
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-[var(--ad-text)]">{textField(row.advancedDetails, "firstMessage") || "Add a first message in Persona before publishing."}</p>
                </div>
                <p className="mt-4 text-xs leading-relaxed text-[var(--ad-text-muted)]">This preview checks the role card and opening message. Use the public preview before final release to verify the full page and chat behavior.</p>
              </DetailSection>
            </div>
          ) : null}

          {tab === "performance" ? (
            <DetailSection title={t("Stats")}>
              <InfoGrid items={[
                { label: t("Chats"), value: row.stats?.chatsCount.toLocaleString() ?? "—" },
                { label: t("Likes"), value: row.stats?.likesCount.toLocaleString() ?? "—" },
                { label: t("Views"), value: row.stats?.viewsCount.toLocaleString() ?? "—" },
              ]} />
              <p className="mt-5 text-xs text-[var(--ad-text-muted)]">Counts are lifetime totals. Trend and conversion views can be added when time-series analytics are available.</p>
            </DetailSection>
          ) : null}

          {tab === "history" ? (
            <DetailSection title="Project history">
              <InfoGrid items={[
                { label: "Created", value: new Date(row.createdAt).toLocaleString() },
                { label: "Last updated", value: new Date(row.updatedAt).toLocaleString() },
                { label: "Visual identity version", value: row.visualProfile ? `v${row.visualProfile.version}` : "Not created" },
                { label: "Current lifecycle state", value: value(row.status) },
              ]} />
              <EngineeringDetails summary={t("Engineering details")}>
                <div>character.id = {row.id}</div>
                <pre className="mt-2 whitespace-pre-wrap">{JSON.stringify(row.visualProfile, null, 2)}</pre>
              </EngineeringDetails>
            </DetailSection>
          ) : null}
        </>
      )}

      {confirmSpec ? <ConfirmDialog onClose={() => setPending(null)} spec={confirmSpec} /> : null}
    </DetailPage>
  );
}

function CharacterEditForm({
  draft,
  onChange,
  valueLabel,
}: {
  draft: OfficialDraft;
  onChange: <K extends keyof OfficialDraft>(key: K, next: OfficialDraft[K]) => void;
  valueLabel: (value: string) => string;
}) {
  return (
    <>
      <FormSection title="Core brief">
        <Field label="Name"><input className={INPUT_CLASS} onChange={(event) => onChange("name", event.target.value)} value={draft.name} /></Field>
        <Field label="Age"><input className={INPUT_CLASS} min={18} onChange={(event) => onChange("age", event.target.value)} type="number" value={draft.age} /></Field>
        <Field label="Gender"><select className={INPUT_CLASS} onChange={(event) => onChange("gender", event.target.value as OfficialDraft["gender"])} value={draft.gender}>{GENDERS.map((item) => <option key={item} value={item}>{valueLabel(item)}</option>)}</select></Field>
        <Field label="Style"><select className={INPUT_CLASS} onChange={(event) => onChange("style", event.target.value as OfficialDraft["style"])} value={draft.style}>{STYLES.map((item) => <option key={item} value={item}>{valueLabel(item)}</option>)}</select></Field>
        <Field full label="Creative brief"><textarea className={TEXTAREA_CLASS} onChange={(event) => onChange("creativeBrief", event.target.value)} value={draft.creativeBrief} /></Field>
        <Field label="Archetype"><input className={INPUT_CLASS} onChange={(event) => onChange("archetype", event.target.value)} value={draft.archetype} /></Field>
        <Field label="Relationship"><input className={INPUT_CLASS} onChange={(event) => onChange("relationship", event.target.value)} value={draft.relationship} /></Field>
      </FormSection>
      <FormSection title="Persona">
        <Field full label="Description"><textarea className={TEXTAREA_CLASS} onChange={(event) => onChange("description", event.target.value)} value={draft.description} /></Field>
        <Field full label="Personality"><textarea className={TEXTAREA_CLASS} onChange={(event) => onChange("personality", event.target.value)} value={draft.personality} /></Field>
        <Field full label="Speaking style"><textarea className={TEXTAREA_CLASS} onChange={(event) => onChange("speakingStyle", event.target.value)} value={draft.speakingStyle} /></Field>
        <Field full label="Backstory"><textarea className={TEXTAREA_CLASS} onChange={(event) => onChange("backstory", event.target.value)} value={draft.backstory} /></Field>
        <Field full label="First message"><textarea className={TEXTAREA_CLASS} onChange={(event) => onChange("firstMessage", event.target.value)} value={draft.firstMessage} /></Field>
        <Field full label="Example dialogue"><textarea className={TEXTAREA_CLASS} onChange={(event) => onChange("exampleDialogue", event.target.value)} value={draft.exampleDialogue} /></Field>
        <Field full label="Tags"><input className={INPUT_CLASS} onChange={(event) => onChange("tags", event.target.value)} value={draft.tags} /></Field>
      </FormSection>
      <FormSection title="Visual direction">
        <Field full label="Appearance anchors"><textarea className={TEXTAREA_CLASS} onChange={(event) => onChange("appearanceNotes", event.target.value)} value={draft.appearanceNotes} /></Field>
        <Field full label="Art direction"><textarea className={TEXTAREA_CLASS} onChange={(event) => onChange("visualBrief", event.target.value)} value={draft.visualBrief} /></Field>
      </FormSection>
    </>
  );
}
