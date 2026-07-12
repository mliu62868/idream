"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { DetailPage, DetailSection } from "@/components/admin/ui/DetailPage";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { FormSection, Field, INPUT_CLASS, TEXTAREA_CLASS } from "@/components/admin/ui/FormPage";
import { DangerButton, GhostButton, PrimaryButton } from "@/components/admin/ui/buttons";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { EngineeringDetails } from "@/components/admin/generation/EngineeringDetails";
import {
  PRESET_TYPES,
  PRESET_VISIBILITY,
  PRESETS_LIST,
  presetPayload,
  type PresetDraft,
  type PresetRow,
} from "./presets-api";

// SPEC: 生成预设详情页 —— 查看 + 就地编辑 + 归档/恢复（spec §7 详情页）。
// INTENT: 无单条 GET，复用列表接口按 id 过滤；编辑态字段与新建页同构。
// INVARIANTS: presetAdminSchema（PATCH 亦无 reason 字段）——Save/Restore 都直连 apiWrite(PATCH)，
// 不弹 ConfirmDialog 采集一个去不了后端的 reason；失败就地显示在页面 error 条，编辑态不丢（Save）。
// 归档是破坏性操作，保留 ConfirmDialog 的名称确认，但 requireReason:false——同一条规则的另一半。
type Mode = "view" | "edit";
type PendingAction = "archive" | null;

function draftFromRow(row: PresetRow): PresetDraft {
  const types: readonly string[] = PRESET_TYPES;
  const visibilities: readonly string[] = PRESET_VISIBILITY;
  return {
    type: (types.includes(row.type) ? row.type : PRESET_TYPES[0]) as PresetDraft["type"],
    category: row.category ?? "",
    label: row.label,
    controlsJson: JSON.stringify(row.controls ?? {}, null, 2),
    visibility: (visibilities.includes(row.visibility)
      ? row.visibility
      : PRESET_VISIBILITY[0]) as PresetDraft["visibility"],
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

export function PresetsDetailPage({ id }: { id: string }) {
  const { t, value } = useAdminI18n();
  const [rows, setRows] = useState<PresetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("view");
  const [draft, setDraft] = useState<PresetDraft | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);
  const [saving, setSaving] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ preset: PresetRow }>(`${PRESETS_LIST}/${encodeURIComponent(id)}`);
      setRows([data.preset]);
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

  function startEdit(current: PresetRow) {
    setDraft(draftFromRow(current));
    setMode("edit");
  }

  function cancelEdit() {
    setDraft(null);
    setMode("view");
  }

  function updateDraft<K extends keyof PresetDraft>(key: K, next: PresetDraft[K]) {
    setDraft((prev) => (prev ? { ...prev, [key]: next } : prev));
  }

  // Save 直接 PATCH：后端 PATCH 契约无 reason；controlsJson 非法就地在同一条 error 里显示，
  // 编辑态（draft）保留，不清空。
  async function save() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const payload = presetPayload(draft);
      await apiWrite(`${PRESETS_LIST}/${id}`, "PATCH", payload);
      await reload();
      setMode("view");
      setDraft(null);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t("Request failed"));
    } finally {
      setSaving(false);
    }
  }

  // Restore 同样直接 PATCH，无对话框——archived→active 不是破坏性操作。
  async function restore() {
    setRestoring(true);
    setError(null);
    try {
      await apiWrite(`${PRESETS_LIST}/${id}`, "PATCH", { status: "active" });
      await reload();
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : t("Request failed"));
    } finally {
      setRestoring(false);
    }
  }

  const confirmSpec: ConfirmSpec | null = useMemo(() => {
    if (!row || pending !== "archive") return null;
    return {
      title: t("Archive preset"),
      destructive: { expectedName: row.label },
      requireReason: false,
      submitLabel: t("Archive preset"),
      onSubmit: async () => {
        await apiWrite(`${PRESETS_LIST}/${id}`, "PATCH", { status: "archived" });
        await reload();
      },
    };
  }, [pending, row, id, t, reload]);

  if (loading) {
    return <p className="text-sm text-[var(--ad-text-muted)]">{t("Loading…")}</p>;
  }

  if (!row) {
    return (
      <EmptyState
        action={
          <Link href="/admin/generation/presets">
            <PrimaryButton>{t("Back to presets")}</PrimaryButton>
          </Link>
        }
        hint={error ?? undefined}
        title={t("Preset not found.")}
      />
    );
  }

  const actions =
    mode === "edit" ? (
      <>
        <GhostButton disabled={saving} onClick={cancelEdit}>{t("Cancel")}</GhostButton>
        <PrimaryButton disabled={saving} onClick={() => void save()}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {t("Save changes")}
        </PrimaryButton>
      </>
    ) : (
      <>
        <GhostButton onClick={() => startEdit(row)}>{t("Edit profile")}</GhostButton>
        {row.status === "archived" ? (
          <PrimaryButton disabled={restoring} onClick={() => void restore()}>
            {restoring ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t("Restore")}
          </PrimaryButton>
        ) : (
          <DangerButton onClick={() => setPending("archive")}>{t("Archive preset")}</DangerButton>
        )}
      </>
    );

  return (
    <DetailPage
      actions={actions}
      backHref="/admin/generation/presets"
      backLabel={t("Back to presets")}
      status={row.status}
      title={row.label}
    >
      {error ? <p role="alert" className="text-sm text-[var(--ad-red-text)]">{error}</p> : null}

      {mode === "edit" && draft ? (
        <FormSection title={t("Basic info")}>
          <Field label={t("Type")}>
            <select
              className={INPUT_CLASS}
              onChange={(event) => updateDraft("type", event.target.value as PresetDraft["type"])}
              value={draft.type}
            >
              {PRESET_TYPES.map((presetType) => (
                <option key={presetType} value={presetType}>
                  {value(presetType)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("Label")}>
            <input
              className={INPUT_CLASS}
              onChange={(event) => updateDraft("label", event.target.value)}
              value={draft.label}
            />
          </Field>
          <Field label={t("Category")}>
            <input
              className={INPUT_CLASS}
              onChange={(event) => updateDraft("category", event.target.value)}
              value={draft.category}
            />
          </Field>
          <Field label={t("Visibility")}>
            <select
              className={INPUT_CLASS}
              onChange={(event) => updateDraft("visibility", event.target.value as PresetDraft["visibility"])}
              value={draft.visibility}
            >
              {PRESET_VISIBILITY.map((visibility) => (
                <option key={visibility} value={visibility}>
                  {value(visibility)}
                </option>
              ))}
            </select>
          </Field>
          <Field full label={t("Controls (JSON)")}>
            <textarea
              className={`${TEXTAREA_CLASS} font-mono`}
              onChange={(event) => updateDraft("controlsJson", event.target.value)}
              value={draft.controlsJson}
            />
          </Field>
        </FormSection>
      ) : (
        <>
          <DetailSection title={t("Basic info")}>
            <InfoGrid
              items={[
                { label: t("Type"), value: value(row.type) },
                { label: t("Category"), value: row.category || "—" },
                { label: t("Visibility"), value: value(row.visibility) },
              ]}
            />
          </DetailSection>

          <EngineeringDetails summary={t("Preset details")}>
            <div className="space-y-1">
              <div>{t("Preset ID")}: {row.id}</div>
              <div>{t("Preset type")}: {value(row.type)}</div>
            </div>
            <pre className="mt-2 whitespace-pre-wrap">{JSON.stringify(row.controls, null, 2)}</pre>
          </EngineeringDetails>
        </>
      )}

      {confirmSpec ? <ConfirmDialog onClose={() => setPending(null)} spec={confirmSpec} /> : null}
    </DetailPage>
  );
}
