"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { adminDateLocale, useAdminI18n } from "@/components/admin/i18n";
import { DetailPage, DetailSection } from "@/components/admin/ui/DetailPage";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { FormSection, Field, INPUT_CLASS, TEXTAREA_CLASS } from "@/components/admin/ui/FormPage";
import { DangerButton, GhostButton, PrimaryButton } from "@/components/admin/ui/buttons";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { VisualPassportPanel } from "@/components/admin/VisualPassportPanel";
import { EngineeringDetails } from "@/components/admin/generation/EngineeringDetails";
import {
  GENDERS,
  OFFICIAL_LIST,
  STYLES,
  officialPayload,
  type OfficialDraft,
  type OfficialRow,
} from "./official-api";

// SPEC: 官方角色详情页 —— 查看 + 就地编辑 + 上/下线（spec §7 详情页）。
// INTENT: 无单条 GET，复用列表接口按 id 过滤；编辑态字段与新建页同构（Task 12 复用此结构）。
type Mode = "view" | "edit";
type PendingAction = "save" | "approve" | "archive" | null;

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

export function OfficialDetailPage({ id }: { id: string }) {
  const { locale, t, value } = useAdminI18n();
  const [rows, setRows] = useState<OfficialRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("view");
  const [draft, setDraft] = useState<OfficialDraft | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ items: OfficialRow[] }>(OFFICIAL_LIST);
      setRows(data.items);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("Request failed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void reload();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [reload]);

  const row = useMemo(() => rows.find((item) => item.id === id), [rows, id]);

  function startEdit(current: OfficialRow) {
    setDraft(draftFromRow(current));
    setMode("edit");
  }

  function cancelEdit() {
    setDraft(null);
    setMode("view");
  }

  function updateDraft<K extends keyof OfficialDraft>(key: K, next: OfficialDraft[K]) {
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
  }, [pending, draft, row, id, t, reload]);

  if (loading) {
    return <p className="text-sm text-[var(--ad-text-muted)]">{t("Loading…")}</p>;
  }

  if (!row) {
    return (
      <EmptyState
        action={
          <Link href="/admin/content/official">
            <PrimaryButton>{t("Back to official characters")}</PrimaryButton>
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
        {row.status === "approved" ? (
          <DangerButton onClick={() => setPending("archive")}>{t("Unpublish")}</DangerButton>
        ) : (
          <PrimaryButton onClick={() => setPending("approve")}>{t("Publish")}</PrimaryButton>
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
      {error ? <p className="text-sm text-[var(--ad-red-text)]">{error}</p> : null}

      {mode === "edit" && draft ? (
        <>
          <FormSection title={t("Profile")}>
            <Field label={t("Name")}>
              <input
                className={INPUT_CLASS}
                onChange={(event) => updateDraft("name", event.target.value)}
                value={draft.name}
              />
            </Field>
            <Field label={t("Age")}>
              <input
                className={INPUT_CLASS}
                onChange={(event) => updateDraft("age", event.target.value)}
                type="number"
                value={draft.age}
              />
            </Field>
            <Field label={t("Gender")}>
              <select
                className={INPUT_CLASS}
                onChange={(event) => updateDraft("gender", event.target.value as OfficialDraft["gender"])}
                value={draft.gender}
              >
                {GENDERS.map((gender) => (
                  <option key={gender} value={gender}>
                    {value(gender)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("Style")}>
              <select
                className={INPUT_CLASS}
                onChange={(event) => updateDraft("style", event.target.value as OfficialDraft["style"])}
                value={draft.style}
              >
                {STYLES.map((style) => (
                  <option key={style} value={style}>
                    {value(style)}
                  </option>
                ))}
              </select>
            </Field>
          </FormSection>
          <FormSection title={t("Description & tags")}>
            <Field full label={t("Description")}>
              <textarea
                className={TEXTAREA_CLASS}
                onChange={(event) => updateDraft("description", event.target.value)}
                value={draft.description}
              />
            </Field>
            <Field full label={t("Tags (comma-sep)")}>
              <input
                className={INPUT_CLASS}
                onChange={(event) => updateDraft("tags", event.target.value)}
                value={draft.tags}
              />
            </Field>
          </FormSection>
        </>
      ) : (
        <>
          <DetailSection title={t("Profile")}>
            <InfoGrid
              items={[
                { label: t("Gender"), value: value(row.gender) },
                { label: t("Style"), value: value(row.style) },
                { label: t("Age"), value: row.age },
                { label: t("Visibility"), value: value(row.visibility) },
                {
                  label: t("Created"),
                  value: new Date(row.createdAt).toLocaleDateString(adminDateLocale(locale)),
                },
              ]}
            />
          </DetailSection>

          <DetailSection title={t("Description & tags")}>
            <p className="text-sm text-[var(--ad-text)]">{row.description || "—"}</p>
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

          <DetailSection title={t("Visual Identity")}>
            <VisualPassportPanel characterId={row.id} />
          </DetailSection>

          <DetailSection title={t("Stats")}>
            <InfoGrid
              items={[
                { label: t("Chats"), value: row.stats ? row.stats.chatsCount : "—" },
                { label: t("Likes"), value: row.stats ? row.stats.likesCount : "—" },
                { label: t("Views"), value: row.stats ? row.stats.viewsCount : "—" },
              ]}
            />
          </DetailSection>

          <DetailSection title={t("Image production")}>
            <Link href="/admin/content/production">
              <GhostButton>{t("Open image production")}</GhostButton>
            </Link>
          </DetailSection>

          <EngineeringDetails summary={`character.id = ${row.id}`}>
            <div>id: {row.id}</div>
            <pre className="mt-2 whitespace-pre-wrap">{JSON.stringify(row.visualProfile, null, 2)}</pre>
          </EngineeringDetails>
        </>
      )}

      {confirmSpec ? <ConfirmDialog onClose={() => setPending(null)} spec={confirmSpec} /> : null}
    </DetailPage>
  );
}
