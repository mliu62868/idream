"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { AdminV2RequestError, apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { DetailPage, DetailSection } from "@/components/admin/ui/DetailPage";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { FormSection, Field, INPUT_CLASS, TEXTAREA_CLASS } from "@/components/admin/ui/FormPage";
import { DangerButton, GhostButton, PrimaryButton } from "@/components/admin/ui/buttons";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { PermissionNotice } from "@/components/admin/ui/PermissionNotice";
import { useUnsavedChanges } from "@/components/admin/ui/useUnsavedChanges";
import { EngineeringDetails } from "@/components/admin/generation/EngineeringDetails";
import { LoadingWorkspace } from "@/features/operations/WorkspaceUi";
import { useWorkspaceRefresh } from "@/features/workspace-refresh";
import { InfoGrid, WriteFeedbackBanner, requestErrorMessage, useWriteFeedback } from "@/components/admin/section-kit";
import {
  PRESET_TYPES,
  PRESET_VISIBILITY,
  PRESETS_LIST,
  presetPayload,
  type PresetDraft,
  type PresetRow,
} from "./presets-api";

// SPEC: 生成预设详情页 —— 查看 + 就地编辑 + 归档/恢复（spec §7 详情页）。
// INTENT: 使用单条权威 GET 读取详情；编辑态字段与新建页同构。
// INVARIANTS: generationPresetPatchRequestSchema 无 reason 字段；Save/Restore 都直连 apiWrite(PATCH)，
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

export function PresetsDetailPage({ canWrite, id }: { canWrite: boolean; id: string }) {
  const { t, value } = useAdminI18n();
  const [rows, setRows] = useState<PresetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [mode, setMode] = useState<Mode>("view");
  const [draft, setDraft] = useState<PresetDraft | null>(null);
  const [editBaseline, setEditBaseline] = useState<PresetDraft | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);
  const [saving, setSaving] = useState(false);
  const [awaitingReadback, setAwaitingReadback] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const { feedback, reportSuccess, clearFeedback } = useWriteFeedback();
  const { guard } = useUnsavedChanges(Boolean(draft && !awaitingReadback && JSON.stringify(draft) !== JSON.stringify(editBaseline)));

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotFound(false);
    try {
      const data = await apiGet<{ preset: PresetRow }>(`${PRESETS_LIST}/${encodeURIComponent(id)}`);
      setRows([data.preset]);
      return data.preset;
    } catch (loadError) {
      setNotFound(loadError instanceof AdminV2RequestError && loadError.status === 404);
      setError(requestErrorMessage(loadError, t));
      return null;
    } finally {
      setLoading(false);
    }
  }, [id, t]);

  useWorkspaceRefresh(reload);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void reload();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [reload]);

  const row = useMemo(() => rows.find((item) => item.id === id), [rows, id]);
  const editing = canWrite && mode === "edit";

  function startEdit(current: PresetRow) {
    if (!canWrite || awaitingReadback) return;
    const nextDraft = draftFromRow(current);
    setDraft(nextDraft);
    setEditBaseline(nextDraft);
    setMode("edit");
  }

  function cancelEdit() {
    if (saving || awaitingReadback) return;
    setDraft(null);
    setMode("view");
  }

  function updateDraft<K extends keyof PresetDraft>(key: K, next: PresetDraft[K]) {
    setDraft((prev) => (prev ? { ...prev, [key]: next } : prev));
  }

  // Save 直接 PATCH：后端 PATCH 契约无 reason；controlsJson 非法就地在同一条 error 里显示，
  // 编辑态（draft）保留，不清空。
  async function save() {
    if (!canWrite || saving || awaitingReadback || !draft) return;
    setSaving(true);
    setError(null);
    try {
      const payload = presetPayload(draft);
      await apiWrite(`${PRESETS_LIST}/${id}`, "PATCH", payload);
      // Preserve the submitted copy until the authority read catches up.
      setAwaitingReadback(true);
      const saved = await reload();
      if (!saved) return;
      setAwaitingReadback(false);
      setMode("view");
      setDraft(null);
      reportSuccess(t("Saved. {label} now shows the edited values.", { label: saved.label }));
    } catch (saveError) {
      setError(requestErrorMessage(saveError, t));
    } finally {
      setSaving(false);
    }
  }

  async function retryReadback() {
    if (!(await reload())) return;
    setAwaitingReadback(false);
    setMode("view");
    setDraft(null);
    reportSuccess(t("Latest details loaded."));
  }

  // Restore 同样直接 PATCH，无对话框——archived→active 不是破坏性操作。
  async function restore() {
    if (!canWrite || restoring || awaitingReadback) return;
    setRestoring(true);
    setError(null);
    try {
      await apiWrite(`${PRESETS_LIST}/${id}`, "PATCH", { status: "active" });
      setAwaitingReadback(true);
      if (!(await reload())) return;
      setAwaitingReadback(false);
      reportSuccess(t("Restored. This preset is selectable again."));
    } catch (restoreError) {
      setError(requestErrorMessage(restoreError, t));
    } finally {
      setRestoring(false);
    }
  }

  const confirmSpec: ConfirmSpec | null = useMemo(() => {
    if (!canWrite || awaitingReadback || !row || pending !== "archive") return null;
    return {
      title: t("Archive preset"),
      destructive: { expectedName: row.label },
      requireReason: false,
      submitLabel: t("Archive preset"),
      onSubmit: async () => {
        await apiWrite(`${PRESETS_LIST}/${id}`, "PATCH", { status: "archived" });
        setAwaitingReadback(true);
        if (!(await reload())) return;
        setAwaitingReadback(false);
        reportSuccess(t("Archived. {label} is no longer offered to users.", { label: row.label }));
      },
    };
  }, [canWrite, awaitingReadback, pending, row, id, t, reload, reportSuccess]);

  if (loading && !row) {
    return <>{guard}<LoadingWorkspace label="Loading…" /></>;
  }

  if (!row) {
    return (
      <>{guard}<EmptyState
        action={
          <div className="flex flex-wrap justify-center gap-2">
            {!notFound ? <PrimaryButton onClick={() => void reload()}>{t("Retry")}</PrimaryButton> : null}
            <Link href="/admin/generation/presets">
              <GhostButton>{t("Back to presets")}</GhostButton>
            </Link>
          </div>
        }
        hint={error ?? undefined}
        title={t(notFound ? "Preset not found." : "Could not load preset.")}
      /></>
    );
  }

  const actions =
    !canWrite ? <PermissionNotice permission="generation.config.write" /> : editing ? (
      <>
        <GhostButton disabled={saving || awaitingReadback} onClick={cancelEdit}>{t("Cancel")}</GhostButton>
        <PrimaryButton disabled={saving || awaitingReadback} onClick={() => void save()}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {t("Save changes")}
        </PrimaryButton>
      </>
    ) : (
      <>
        <GhostButton disabled={awaitingReadback} onClick={() => startEdit(row)}>{t("Edit preset")}</GhostButton>
        {row.status === "archived" ? (
          <PrimaryButton disabled={restoring || awaitingReadback} onClick={() => void restore()}>
            {restoring ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t("Restore")}
          </PrimaryButton>
        ) : (
          <DangerButton disabled={awaitingReadback} onClick={() => setPending("archive")}>{t("Archive preset")}</DangerButton>
        )}
      </>
    );

  return (
    <>{guard}
    <DetailPage
      actions={actions}
      backHref="/admin/generation/presets"
      backLabel={t("Back to presets")}
      status={row.status}
      title={row.label}
    >
      <WriteFeedbackBanner feedback={feedback} onDismiss={clearFeedback} />
      {awaitingReadback ? <p role="status" className="text-sm text-[var(--ad-yellow-text)]">{t("Changes were saved, but the latest details could not be loaded. Retry before making another change.")}</p> : null}
      {error ? <p role="alert" className="text-sm text-[var(--ad-red-text)]">{error}</p> : null}
      {awaitingReadback ? <GhostButton onClick={() => void retryReadback()}>{t("Retry")}</GhostButton> : null}

      {editing && draft ? (
        <fieldset disabled={saving || awaitingReadback}>
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
        </fieldset>
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
    </>
  );
}
