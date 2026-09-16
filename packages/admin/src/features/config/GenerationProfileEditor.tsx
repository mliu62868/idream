"use client";

import { useState } from "react";
import { generationModelProfileCreateRequestSchema, generationModelProfilePatchRequestSchema } from "@idream/shared/admin";
import { useAdminI18n } from "@/components/admin/i18n";
import { AdminV2RequestError } from "@/lib/admin-v2-api";
import { apiWrite } from "@/components/admin/api";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { fieldClass, textAreaClass, WorkspaceButton } from "@/features/operations/WorkspaceUi";

type Profile = Record<string, unknown>;
const defaults = { profileKey: "", label: "", mode: "image", runner: "comfyui", pipelineModel: "", workflowKey: "", sourceModelPath: "", convertedModelPath: "", modelFormat: "safetensors", defaultWidth: 768, defaultHeight: 1024, allowedOrientations: ["1:1", "2:3", "3:2"], steps: 28, sampler: "euler", scheduler: "model_default", cfgScale: 1, costMultiplier: 1, requiredEntitlement: "", maxCount: 4, concurrencyLimit: 1, rolloutPercent: 0 };
const textFields = [
  ["profileKey", "Profile key"], ["label", "Label"], ["runner", "Runner"], ["pipelineModel", "Pipeline model"], ["workflowKey", "Workflow key"], ["sourceModelPath", "Source model path"], ["convertedModelPath", "Converted model path"], ["sampler", "Sampler"], ["scheduler", "Scheduler"], ["requiredEntitlement", "Required entitlement"],
] as const;
const numberFields = [
  ["defaultWidth", "Default width", 128, 4096, 1], ["defaultHeight", "Default height", 128, 4096, 1], ["steps", "Steps", 1, 150, 1], ["cfgScale", "CFG scale", 1, 30, 0.1], ["costMultiplier", "Cost multiplier", 0.1, 20, 0.1], ["maxCount", "Maximum count", 1, 8, 1], ["concurrencyLimit", "Concurrency limit", 1, 100, 1], ["rolloutPercent", "Rollout percent", 0, 100, 1],
] as const;

export function GenerationProfileEditor({ source, editing, onSaved, onCancel }: { source: Profile | null; editing: boolean; onSaved: (id: string) => void; onCancel: () => void }) {
  const { t, value: enumLabel } = useAdminI18n();
  const [draft, setDraft] = useState<Profile>(() => Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, source?.[key] ?? value])));
  const [orientations, setOrientations] = useState((Array.isArray(source?.allowedOrientations) ? source.allowedOrientations : defaults.allowedOrientations).join(", "));
  const [runnerConfig, setRunnerConfig] = useState(JSON.stringify(source?.runnerConfig ?? {}, null, 2));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const change = (key: string, value: unknown) => setDraft(current => ({ ...current, [key]: value }));
  async function save() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const values = { ...draft, allowedOrientations: orientations.split(",").map(value => value.trim()).filter(Boolean), runnerConfig: JSON.parse(runnerConfig), ...Object.fromEntries(["workflowKey", "sourceModelPath", "convertedModelPath", "requiredEntitlement"].map(key => [key, String(draft[key] ?? "").trim() || null])) };
      // INTENT: editing only changes configuration. Never copy publish/validation evidence into a new version.
      const parsed = editing ? generationModelProfilePatchRequestSchema.safeParse(values) : generationModelProfileCreateRequestSchema.safeParse({ ...values, enabled: false });
      if (!parsed.success) throw new AdminV2RequestError("Profile draft validation failed", 400, "bad_request", { issues: parsed.error.issues });
      const body = parsed.data;
      const response = await apiWrite<{ profile: Profile }>(editing ? `/api/v2/admin/generation/model-profiles/${source?.id}` : "/api/v2/admin/generation/model-profiles", editing ? "PATCH" : "POST", body);
      onSaved(String(response.profile.id));
    } catch (cause) {
      setError(cause instanceof SyntaxError ? new AdminV2RequestError("Runner configuration must be valid JSON", 400, "bad_request", { issues: [{ path: ["runnerConfig"], message: cause.message }] }) : cause);
    }
    finally { setBusy(false); }
  }
  return <form className="space-y-4 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4" onSubmit={event => { event.preventDefault(); void save(); }}>
    <h2 className="font-semibold">{t(editing ? "Edit profile draft" : "Create profile draft")}</h2>
    <p className="text-sm text-[var(--ad-text-muted)]">{t("Saving a draft does not change live traffic. Check configuration and collect fresh review evidence before publishing.")}</p>
    {error ? <AuthorityRequestError cause={error} message={error instanceof Error ? error.message : "Profile draft save failed"} onRetry={() => void save()} /> : null}
    <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {textFields.map(([key, label]) => <label key={key} className="text-sm">{t(label)}<input className={fieldClass} value={String(draft[key] ?? "")} onChange={event => change(key, event.target.value)} /></label>)}
      <label className="text-sm">{t("Profile mode")}<select className={fieldClass} value={String(draft.mode)} onChange={event => change("mode", event.target.value)}>{["image", "video"].map(value => <option key={value} value={value}>{enumLabel(value)}</option>)}</select></label>
      <label className="text-sm">{t("Model format")}<select className={fieldClass} value={String(draft.modelFormat)} onChange={event => change("modelFormat", event.target.value)}>{["safetensors", "gguf", "diffusers", "external"].map(value => <option key={value}>{value}</option>)}</select></label>
      {numberFields.map(([key, label, min, max, step]) => <label key={key} className="text-sm">{t(label)}<input className={fieldClass} required type="number" min={min} max={max} step={step} value={String(draft[key] ?? "")} onChange={event => change(key, event.target.value === "" ? "" : Number(event.target.value))} /></label>)}
      <label className="text-sm">{t("Allowed orientations (comma separated)")}<input className={fieldClass} required value={orientations} onChange={event => setOrientations(event.target.value)} /></label>
      <label className="text-sm sm:col-span-2">{t("Runner configuration JSON")}<textarea className={textAreaClass} value={runnerConfig} onChange={event => setRunnerConfig(event.target.value)} /></label>
    </fieldset>
    <div className="flex gap-2"><WorkspaceButton tone="primary" type="submit" disabled={busy}>{t(busy ? "Saving…" : "Save draft")}</WorkspaceButton><WorkspaceButton disabled={busy} onClick={onCancel}>{t("Cancel")}</WorkspaceButton></div>
  </form>;
}
