"use client";

import Link from "next/link";
import Image from "next/image";
import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { GenerationRecipePreview } from "@idream/shared/admin";
import { apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { DetailSection } from "@/components/admin/ui/DetailPage";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { Field, INPUT_CLASS, TEXTAREA_CLASS } from "@/components/admin/ui/FormPage";
import { GhostButton, PrimaryButton } from "@/components/admin/ui/buttons";
import { EngineeringDetails } from "@/components/admin/generation/EngineeringDetails";
import { WriteFeedbackBanner, requestErrorMessage, useWriteFeedback } from "@/components/admin/section-kit";
import { createLatestRequestGate } from "@/lib/latest-request";
import { RECIPES_LIST, type Recipe } from "./recipes-api";

type Profile = { id: string; label: string; mode: string; status: string; allowedOrientations: string[] };
type Sample = Record<string, unknown>;
const validationLabels = {
  not_run: "Not validated", running: "Samples running", ready: "Ready to verify", passed: "Validated", failed: "Validation failed", stale: "Validation expired",
} as const;

export function RecipeValidationSection({ canWrite, recipe, profileId, onProfileChange, onReady, onChanged }: { canWrite: boolean; recipe: Recipe; profileId: string; onProfileChange: Dispatch<SetStateAction<string>>; onReady: (ready: boolean) => void; onChanged: () => Promise<void> }) {
  const { t, value } = useAdminI18n();
  const initialSamples = Array.isArray(recipe.sampleMatrix) ? recipe.sampleMatrix.filter((row): row is Sample => row !== null && typeof row === "object" && !Array.isArray(row)) : [];
  const [samples, setSamples] = useState<Sample[]>(initialSamples);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [preview, setPreview] = useState<GenerationRecipePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"test-matrix" | "verify" | null>(null);
  const [gate] = useState(createLatestRequestGate);
  const { feedback, reportSuccess, clearFeedback } = useWriteFeedback();
  const dirty = canWrite && JSON.stringify(samples) !== JSON.stringify(initialSamples);
  const displayedSamples = canWrite ? samples : initialSamples;
  const profile = profiles.find(row => row.id === profileId);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void apiGet<{ items: Profile[] }>("/api/v2/admin/generation/model-profiles").then(data => {
        if (!active) return;
        const items = (data.items ?? []).filter(row => row.mode === (recipe.mode === "video" ? "video" : "image") && row.status !== "archived");
        setProfiles(items);
        setProfilesLoaded(true);
        const previous = recipe.dryRunSummary?.profileId;
        // Preserve the operator's selection across the saved-matrix remount. Never substitute a missing profile silently.
        onProfileChange(current => current || (typeof previous === "string" ? previous : "") || items.find(row => row.status === "active")?.id || items[0]?.id || "");
      }).catch(reason => { if (active) setError(requestErrorMessage(reason, t)); });
    }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [onProfileChange, recipe.mode, recipe.dryRunSummary, t]);

  const refresh = useCallback(async () => {
    if (!profile) return;
    const request = gate.begin();
    setBusy(true);
    setError(null);
    onReady(false);
    try {
      const data = await apiGet<GenerationRecipePreview>(`${RECIPES_LIST}/${encodeURIComponent(recipe.id)}/preview?profileId=${encodeURIComponent(profileId)}`);
      if (!request.isCurrent()) return;
      setPreview(data);
      onReady(data.validation.status === "passed");
    } catch (reason) {
      if (request.isCurrent()) setError(requestErrorMessage(reason, t));
    } finally {
      if (request.isCurrent()) setBusy(false);
    }
  }, [gate, onReady, profile, profileId, recipe.id, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => { window.clearTimeout(timer); gate.invalidate(); };
  }, [refresh, gate]);

  function changeSample(index: number, field: string, next: string) {
    onReady(false);
    setSamples(current => current.map((sample, position) => position === index ? { ...sample, [field]: next } : sample));
  }

  async function saveMatrix() {
    if (!canWrite) return;
    setBusy(true);
    setError(null);
    try {
      await apiWrite(`${RECIPES_LIST}/${recipe.id}`, "PATCH", { sampleMatrix: samples });
      await onChanged();
    } catch (reason) { setError(requestErrorMessage(reason, t)); }
    finally { setBusy(false); }
  }

  const confirmation: ConfirmSpec | null = canWrite && pending && preview && profile ? {
    title: pending === "test-matrix" ? t("Run sample matrix") : t("Verify results"),
    submitLabel: pending === "test-matrix" ? t("Run sample matrix") : t("Verify results"),
    ...(pending === "test-matrix" ? { consequence: {
      effect: t("This queues {count} real generation samples on {profile}. It debits no Dreamcoins; dispatched jobs cannot be recalled.", { count: preview.samples.length, profile: profile.label }), reversible: false,
    } } : {}),
    onSubmit: async reason => {
      await apiWrite(`${RECIPES_LIST}/${recipe.id}/commands/${pending}`, "POST", {
        reason, confirmation: recipe.id, fingerprint: preview.fingerprint,
        ...(pending === "test-matrix" ? { profileId } : {}),
      });
      await refresh();
      reportSuccess(t(pending === "test-matrix" ? "Sample jobs queued. Refresh their results after generation finishes." : "All saved samples have verified generated outputs and library delivery."));
    },
  } : null;

  return <DetailSection title={t("Sample validation")}>
    <p className="text-sm text-[var(--ad-text-muted)]">{t("Save sample scenes, preview their compiled prompts, run the matrix, then verify generated outputs before publishing.")}</p>
    <WriteFeedbackBanner feedback={feedback} onDismiss={clearFeedback} />
    {error ? <p role="alert" className="text-sm text-[var(--ad-red-text)]">{error}</p> : null}
    <Field label={t("Test profile")}><select className={INPUT_CLASS} disabled={busy} value={profileId} onChange={event => { onReady(false); setPreview(null); onProfileChange(event.target.value); }}>
      {profilesLoaded && profileId && !profile ? <option value={profileId}>{t("Selected test profile is unavailable")}</option> : null}
      {!profiles.length ? <option value="">{t("No test profile is available")}</option> : null}
      {profiles.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}
    </select></Field>
    {profilesLoaded && profileId && !profile ? <p role="alert" className="text-sm text-[var(--ad-red-text)]">{t("Selected test profile is unavailable. Choose an available profile before running samples.")}</p> : null}
    {displayedSamples.map((sample, index) => <div key={index} className="grid gap-3 rounded-lg border border-[var(--ad-border)] p-3 sm:grid-cols-[1fr_10rem_auto]">
      <Field label={t("Sample scene {number}", { number: index + 1 })}><textarea className={TEXTAREA_CLASS} disabled={busy || !canWrite || recipe.status !== "draft"} value={typeof sample.prompt === "string" ? sample.prompt : ""} onChange={event => changeSample(index, "prompt", event.target.value)} /></Field>
      <Field label={t("Orientation")}><select className={INPUT_CLASS} disabled={busy || !canWrite || recipe.status !== "draft"} value={typeof sample.orientation === "string" ? sample.orientation : profile?.allowedOrientations[0] ?? "1:1"} onChange={event => changeSample(index, "orientation", event.target.value)}>
        {[...new Set([typeof sample.orientation === "string" ? sample.orientation : "1:1", ...(profile?.allowedOrientations ?? [])])].map(orientation => <option key={orientation} value={orientation}>{orientation}</option>)}
      </select></Field>
      {canWrite && recipe.status === "draft" ? <GhostButton disabled={busy} onClick={() => { onReady(false); setSamples(current => current.filter((_, position) => position !== index)); }}>{t("Remove")}</GhostButton> : null}
      {recipe.mode === "video" || (recipe.mode !== "negative" && recipe.useCase === "enhance") ? <Field full label={t("Source image asset ID")}><input className={INPUT_CLASS} disabled={busy || !canWrite || recipe.status !== "draft"} value={typeof sample.sourceImageAssetId === "string" ? sample.sourceImageAssetId : ""} onChange={event => changeSample(index, "sourceImageAssetId", event.target.value)} /></Field> : null}
    </div>)}
    {canWrite && recipe.status === "draft" ? <div className="flex flex-wrap gap-2">
      <GhostButton disabled={busy || samples.length >= 40} onClick={() => { onReady(false); setSamples(current => [...current, { prompt: "", orientation: profile?.allowedOrientations[0] ?? "1:1" }]); }}>{t("Add sample scene")}</GhostButton>
      {dirty ? <><PrimaryButton disabled={busy} onClick={() => void saveMatrix()}>{t("Save sample matrix")}</PrimaryButton><GhostButton disabled={busy} onClick={() => { setSamples(initialSamples); onReady(preview?.validation.status === "passed"); }}>{t("Cancel")}</GhostButton></> : null}
    </div> : null}
    <p className="text-xs text-[var(--ad-text-muted)]">{t("Previews compile saved inputs. They do not call a provider or prove generation success.")}</p>
    {preview ? <>
      <p className="text-sm" role="status">{t(validationLabels[preview.validation.status])}</p>
      {[...preview.issues, ...preview.samples.flatMap(sample => sample.issues), ...preview.validation.issues].map((issue, index) => <p key={index} className="text-sm text-[var(--ad-text-muted)]">{t(issue)}</p>)}
      {preview.samples.map(sample => <EngineeringDetails key={sample.index} summary={t("Compiled sample {number}", { number: sample.index + 1 })}><p className="whitespace-pre-wrap">{sample.prompt}</p><p className="mt-2 whitespace-pre-wrap">{sample.negativePrompt || "—"}</p></EngineeringDetails>)}
      {preview.validation.jobs.map(job => <div className="space-y-2" key={job.id}><Link className="text-sm underline" href={`/admin/ops/jobs?job=${encodeURIComponent(job.id)}`}>{t("Sample {number}: {status}", { number: job.sampleIndex + 1, status: value(job.status) })}</Link>{job.assetUrls.map(url => recipe.mode === "video" ? <video key={url} className="max-h-64 rounded-lg" controls src={url} /> : <Image key={url} unoptimized width={256} height={256} alt={t("Generated sample {number}", { number: job.sampleIndex + 1 })} className="h-auto max-h-64 w-auto rounded-lg" src={url} />)}</div>)}
    </> : null}
    <div className="flex flex-wrap gap-2">
      <GhostButton disabled={busy || !profile || dirty} onClick={() => void refresh()}>{t("Refresh results")}</GhostButton>
      {canWrite && recipe.status === "draft" ? <><PrimaryButton disabled={busy || !profile || dirty || !preview?.samples.length || Boolean(preview.issues.length || preview.samples.some(sample => sample.issues.length)) || preview.validation.status === "running"} onClick={() => setPending("test-matrix")}>{t("Run sample matrix")}</PrimaryButton><PrimaryButton disabled={busy || !profile || dirty || preview?.validation.status !== "ready"} onClick={() => setPending("verify")}>{t("Verify results")}</PrimaryButton></> : null}
    </div>
    {confirmation ? <ConfirmDialog spec={confirmation} onClose={() => setPending(null)} /> : null}
  </DetailSection>;
}
