"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Flag, Loader2, Play, RefreshCcw, RotateCcw, UploadCloud, X } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { useFailureToast, useToast } from "@/components/admin/ui/Toast";
import { createLatestRequestGate } from "@/lib/latest-request";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import {
  defaultGenerationConfigQuery,
  featureFlagsPath,
  generationConfigQueryFromSearch,
  generationConfigWorkspaceUrl,
  generationProfilesPath,
  isGenerationConfigQueryFiltered,
  type GenerationConfigQuery,
} from "./query";

type RecordRow = Record<string, unknown>;
type PageInfo = { endCursor: string | null; hasNextPage: boolean };
type ListResponse = { items: RecordRow[]; pageInfo?: PageInfo };
type AuthorityState<T> = { data: T | null; error: string | null; loading: boolean; refreshedAt: string | null };
type Permissions = { manageProfiles: boolean; manageFlags: boolean };
type ReviewDraft = { sampleCount: string; passCount: string; reviewUrl: string };
const emptyPageInfo: PageInfo = { endCursor: null, hasNextPage: false };
const emptyAuthorityState = <T,>(): AuthorityState<T> => ({ data: null, error: null, loading: true, refreshedAt: null });
type ConfigCommand = {
  title: string;
  /** 成功后 toast 的正文，调用处已经翻译好。 */
  completed: string;
  endpoint: string;
  method: "POST" | "PATCH";
  expected: string;
  consequence: { effect: string; reversible: boolean };
  payload: (reason: string) => Record<string, unknown>;
};

export function GenerationConfigWorkspace({ permissions }: { permissions: Permissions }) {
  const { t } = useAdminI18n();
  const { toast } = useToast();
  const failureToast = useFailureToast();
  const [query, setQuery] = useState<GenerationConfigQuery>(() => currentQuery());
  const [draft, setDraft] = useState<GenerationConfigQuery>(() => currentQuery());
  const [profiles, setProfiles] = useState<AuthorityState<ListResponse>>(emptyAuthorityState);
  const [flags, setFlags] = useState<AuthorityState<ListResponse>>(emptyAuthorityState);
  const [recentJobs, setRecentJobs] = useState<AuthorityState<ListResponse>>(emptyAuthorityState);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [testPrompt, setTestPrompt] = useState("cinematic portrait, natural skin texture, soft studio lighting");
  const [review, setReview] = useState<ReviewDraft>({ sampleCount: "", passCount: "", reviewUrl: "" });
  const [confirmation, setConfirmation] = useState<ConfirmSpec | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const requestGates = useRef({ profiles: createLatestRequestGate(), flags: createLatestRequestGate(), jobs: createLatestRequestGate() });
  const initialQuery = useRef(query);

  const loadProfiles = useCallback(async (next: GenerationConfigQuery) => {
    const request = requestGates.current.profiles.begin();
    setProfiles((current) => ({ ...current, error: null, loading: true }));
    try {
      const data = await apiGet<ListResponse>(generationProfilesPath(next));
      if (request.isCurrent()) setProfiles({ data, error: null, loading: false, refreshedAt: new Date().toISOString() });
    } catch (cause) {
      if (request.isCurrent()) setProfiles((current) => ({ ...current, error: errorMessage(cause, "Profile authority request failed"), loading: false }));
    }
  }, []);

  const loadFlags = useCallback(async (next: GenerationConfigQuery) => {
    const request = requestGates.current.flags.begin();
    setFlags((current) => ({ ...current, error: null, loading: true }));
    try {
      const data = await apiGet<ListResponse>(featureFlagsPath(next));
      if (request.isCurrent()) setFlags({ data, error: null, loading: false, refreshedAt: new Date().toISOString() });
    } catch (cause) {
      if (request.isCurrent()) setFlags((current) => ({ ...current, error: errorMessage(cause, "Feature-flag authority request failed"), loading: false }));
    }
  }, []);

  const loadJobs = useCallback(async () => {
    const request = requestGates.current.jobs.begin();
    setRecentJobs((current) => ({ ...current, error: null, loading: true }));
    try {
      const data = await apiGet<ListResponse>("/api/v2/admin/jobs?mode=image&limit=12");
      if (request.isCurrent()) setRecentJobs({ data, error: null, loading: false, refreshedAt: new Date().toISOString() });
    } catch (cause) {
      if (request.isCurrent()) setRecentJobs((current) => ({ ...current, error: errorMessage(cause, "Recent-job authority request failed"), loading: false }));
    }
  }, []);

  const load = useCallback((next: GenerationConfigQuery) => {
    void loadProfiles(next);
    void loadFlags(next);
    void loadJobs();
  }, [loadFlags, loadJobs, loadProfiles]);

  useEffect(() => {
    const gates = requestGates.current;
    load(initialQuery.current);
    const restore = () => {
      const restored = currentQuery();
      setQuery(restored);
      setDraft(restored);
      load(restored);
    };
    window.addEventListener("popstate", restore);
    window.addEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, restore);
    return () => {
      gates.profiles.invalidate();
      gates.flags.invalidate();
      gates.jobs.invalidate();
      window.removeEventListener("popstate", restore);
      window.removeEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, restore);
    };
  }, [load]);

  function navigate(next: GenerationConfigQuery, mode: "push" | "replace" = "push") {
    const url = generationConfigWorkspaceUrl(window.location.pathname, window.location.search, next);
    window.history[mode === "push" ? "pushState" : "replaceState"](null, "", url);
    setQuery(next);
    setDraft(next);
    load(next);
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate({ ...draft, profileCursor: "", flagCursor: "" });
  }

  const profileRows = useMemo(() => profiles.data?.items ?? [], [profiles.data]);
  const flagRows = flags.data?.items ?? [];
  const selectedProfile = useMemo(() => profileRows.find((row) => text(row.id) === selectedProfileId) ?? profileRows[0] ?? null, [profileRows, selectedProfileId]);
  const selectedId = text(selectedProfile?.id);

  function confirmWrite(input: ConfigCommand) {
    const idempotencyKey = crypto.randomUUID();
    setConfirmation({
      title: input.title,
      destructive: { expectedName: input.expected, inputLabel: "Confirmation" },
      consequence: input.consequence,
      reasonLabel: "Reason",
      submitLabel: "Confirm",
      onSubmit: async (reason) => {
        await apiWrite(input.endpoint, input.method, { ...input.payload(reason), confirmation: input.expected }, { "idempotency-key": idempotencyKey });
        toast({ tone: "success", title: input.completed });
        load(query);
      },
    });
  }

  async function createTestImage() {
    if (!permissions.manageProfiles || !selectedId) return;
    setTestBusy(true);
    try {
      const response = await apiWrite<{ job: RecordRow }>(`/api/v2/admin/generation/model-profiles/${selectedId}/commands/test-job`, "POST", {
        prompt: testPrompt.trim() || undefined,
        orientation: firstOrientation(selectedProfile),
        outputCount: 1,
        reason: "Admin image test from Generation Config",
        confirmation: selectedId,
      }, { "idempotency-key": crypto.randomUUID() });
      // INTENT: 排队成功是 info 不是 success —— 图还没出来，运营要等下面的 recent jobs。
      toast({ tone: "info", title: t("Test image queued as {id}", { id: text(response.job.id) || t("an unnamed job") }) });
      await loadJobs();
    } catch (cause) {
      // 这里以前把失败塞进绿色的成功横幅里。
      failureToast(cause);
    } finally {
      setTestBusy(false);
    }
  }

  const filtered = isGenerationConfigQueryFiltered(query);
  const initiallyLoading = !profiles.data && !flags.data && !recentJobs.data && (profiles.loading || flags.loading || recentJobs.loading);
  return (
    <section aria-labelledby="generation-config-title" className="space-y-5">
      <div id="generation-config-title"><PageHeader purpose="Test generation profiles, publish proven versions, and roll feature flags through audited control-plane commands." title={t("Profiles & Rollout")} /></div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--ad-text-muted)]" role="status">
        <Freshness label="Profiles" state={profiles} />
        <Freshness label="Feature flags" state={flags} />
        <Freshness label="Recent jobs" state={recentJobs} />
      </div>

      <div className="grid gap-px overflow-hidden rounded-lg border border-[var(--ad-border)] bg-black/5 md:grid-cols-2">
        <Tab active={query.tab === "profiles"} count={profileRows.length} label="Profiles" meta="Test and publish" onClick={() => navigate({ ...query, tab: "profiles" })} />
        <Tab active={query.tab === "settings"} count={flagRows.length} label="Settings" meta="Feature flags" onClick={() => navigate({ ...query, tab: "settings" })} />
      </div>

      <form className="grid gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 md:grid-cols-2 xl:grid-cols-[minmax(240px,1fr)_170px_190px_170px_auto]" onSubmit={apply}>
        <Field label="Search" onChange={(search) => setDraft((current) => ({ ...current, search }))} search value={draft.search} />
        <Select label="Profile mode" onChange={(profileMode) => setDraft((current) => ({ ...current, profileMode }))} options={["", "image", "video"]} value={draft.profileMode} />
        <Select label="Profile status" onChange={(profileStatus) => setDraft((current) => ({ ...current, profileStatus }))} options={["", "draft", "active", "archived"]} value={draft.profileStatus} />
        <Select label="Flag state" onChange={(flagEnabled) => setDraft((current) => ({ ...current, flagEnabled }))} options={["", "true", "false"]} value={draft.flagEnabled} />
        <div className="flex items-end gap-2"><button className="min-h-11 rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white" type="submit">{t("Apply")}</button>{filtered ? <button aria-label={t("Clear generation config filters")} className="grid min-h-11 min-w-11 place-items-center rounded-md border border-[var(--ad-border)]" onClick={() => navigate({ ...defaultGenerationConfigQuery, tab: query.tab })} type="button"><X className="h-4 w-4" /></button> : null}</div>
      </form>

      <AuthorityError label="profiles" onRetry={() => void loadProfiles(query)} state={profiles} />
      <AuthorityError label="feature flags" onRetry={() => void loadFlags(query)} state={flags} />
      <AuthorityError label="recent jobs" onRetry={() => void loadJobs()} state={recentJobs} />
      {initiallyLoading ? <Loading /> : query.tab === "profiles" ? (
        <>
          {!permissions.manageProfiles ? <p className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Read only · generation.config.write is not granted")}</p> : null}
          {profiles.data ? profileRows.length === 0 ? <EmptyState hint={filtered ? "The complete profile authority query returned no matches." : "No built-in generation profiles are seeded yet."} title={filtered ? "No generation profiles match these filters." : "No built-in generation profiles are seeded yet."} /> : (
            <div className="grid gap-4 lg:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.6fr)]">
              <div className="space-y-2 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3">{profileRows.map((profile) => {
                const id = text(profile.id);
                return <button aria-current={id === selectedId ? "true" : undefined} className={`w-full rounded-md border px-3 py-3 text-left ${id === selectedId ? "border-[var(--ad-ink)] bg-black/5" : "border-[var(--ad-border)]"}`} key={id} onClick={() => setSelectedProfileId(id)} type="button"><span className="block font-semibold">{text(profile.label) || text(profile.profileKey) || id}</span><span className="mt-1 block text-xs text-[var(--ad-text-muted)]">{display(profile.status)} · v{display(profile.version)} · {display(profile.mode)}</span></button>;
              })}</div>
              {selectedProfile ? <ProfileDetail canWrite={permissions.manageProfiles} jobs={recentJobs.data?.items ?? []} onConfirm={confirmWrite} onTest={() => void createTestImage()} profile={selectedProfile} review={review} setReview={setReview} setTestPrompt={setTestPrompt} testBusy={testBusy} testPrompt={testPrompt} /> : null}
            </div>
          ) : null}
          <NextPage label="Next profile page" loading={profiles.loading} onClick={() => navigate({ ...query, profileCursor: profiles.data?.pageInfo?.endCursor ?? "" })} pageInfo={profiles.data?.pageInfo ?? emptyPageInfo} />
        </>
      ) : (
        <>
          {!permissions.manageFlags ? <p className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Read only · config.feature_flag.write is not granted")}</p> : null}
          {flags.data ? flagRows.length === 0 ? <EmptyState hint={filtered ? "The complete flag authority query returned no matches." : "No feature flags exist in the authority."} title={filtered ? "No feature flags match these filters" : "No feature flags exist yet"} /> : <FlagsTable canWrite={permissions.manageFlags} confirmWrite={confirmWrite} rows={flagRows} /> : null}
          <NextPage label="Next feature-flag page" loading={flags.loading} onClick={() => navigate({ ...query, flagCursor: flags.data?.pageInfo?.endCursor ?? "" })} pageInfo={flags.data?.pageInfo ?? emptyPageInfo} />
        </>
      )}
      {confirmation ? <ConfirmDialog onClose={() => setConfirmation(null)} spec={confirmation} /> : null}
    </section>
  );
}

function ProfileDetail({ canWrite, jobs, onConfirm, onTest, profile, review, setReview, setTestPrompt, testBusy, testPrompt }: {
  canWrite: boolean;
  jobs: RecordRow[];
  onConfirm: (input: ConfigCommand) => void;
  onTest: () => void;
  profile: RecordRow;
  review: ReviewDraft;
  setReview: (review: ReviewDraft) => void;
  setTestPrompt: (value: string) => void;
  testBusy: boolean;
  testPrompt: string;
}) {
  const { t } = useAdminI18n();
  const id = text(profile.id);
  const status = text(profile.status);
  const mode = text(profile.mode);
  const relatedJobs = jobs.filter((job) => [text(profile.profileKey), id].includes(text(job.profileId)));
  const sampleCount = integer(review.sampleCount);
  const passCount = integer(review.passCount);
  const reviewReady = mode !== "image" || (sampleCount !== null && passCount !== null && sampleCount >= 20 && passCount <= sampleCount && passCount / sampleCount >= 0.8);
  return <section className="space-y-4 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
    <div><h2 className="text-lg font-semibold">{text(profile.label) || text(profile.profileKey) || id}</h2><p className="mt-1 text-sm text-[var(--ad-text-muted)]">{display(status)} · v{display(profile.version)} · {display(profile.runner)} · {display(profile.pipelineModel)}</p></div>
    {canWrite ? <div className="flex flex-wrap gap-2">
      {status === "draft" ? <Action icon={<Activity className="h-4 w-4" />} label="Configuration check" onClick={() => onConfirm({ title: `Check profile configuration ${id}`, completed: t("Configuration check finished for {id}", { id }), endpoint: `/api/v2/admin/generation/model-profiles/${id}/commands/dry-run`, method: "POST", expected: id, consequence: { effect: t("The profile is validated against the runtime. Nothing customer-facing changes."), reversible: true }, payload: (reason) => ({ reason }) })} /> : null}
      {mode === "image" && status !== "archived" ? <Action disabled={testBusy} icon={testBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} label="Generate test image" onClick={onTest} /> : null}
      {status === "draft" ? <Action disabled={!reviewReady} icon={<UploadCloud className="h-4 w-4" />} label="Publish" onClick={() => onConfirm({ title: `Publish profile ${id}`, completed: t("Profile {id} published", { id }), endpoint: `/api/v2/admin/generation/model-profiles/${id}/commands/publish`, method: "POST", expected: id, consequence: { effect: t("Every new customer generation runs on this profile from now on, and the previous active version is archived. A rollback restores it; images already produced are not regenerated."), reversible: true }, payload: (reason) => ({ reason, ...(mode === "image" ? { dryRunSummary: { reviewSource: "admin_console_manual_consistency_review", reviewStatus: "manual_passed", consistencySampleCount: sampleCount, consistencyPassCount: passCount, consistencyRate: sampleCount && passCount !== null ? passCount / sampleCount : 0, reviewUrl: review.reviewUrl.trim() || undefined } } : {}) }) })} /> : null}
      {status === "active" ? <Action icon={<RotateCcw className="h-4 w-4" />} label="Rollback" onClick={() => onConfirm({ title: `Rollback profile ${id}`, completed: t("Profile {id} rolled back", { id }), endpoint: `/api/v2/admin/generation/model-profiles/${id}/commands/rollback`, method: "POST", expected: id, consequence: { effect: t("Customer generations go back to the previously active profile version from now on."), reversible: true }, payload: (reason) => ({ reason }) })} /> : null}
      {status === "active" && Boolean(profile.enabled) ? <Action icon={<X className="h-4 w-4" />} label="Disable" onClick={() => onConfirm({ title: `Disable profile ${id}`, completed: t("Profile {id} disabled", { id }), endpoint: `/api/v2/admin/generation/model-profiles/${id}`, method: "PATCH", expected: id, consequence: { effect: t("Generations stop routing to this profile immediately. Re-enabling it is a second edit on this same profile."), reversible: true }, payload: (reason) => ({ reason, enabled: false }) })} /> : null}
    </div> : null}
    {mode === "image" && status !== "archived" ? <div className="grid gap-3 rounded-md border border-[var(--ad-border)] p-3 md:grid-cols-2"><Field label="Test image prompt" onChange={setTestPrompt} value={testPrompt} /><p className="self-end text-xs text-[var(--ad-text-muted)]">{relatedJobs.length}  {t("recent profile test job")}{relatedJobs.length === 1 ? "" : "s"}</p></div> : null}
    {mode === "image" && status === "draft" ? <div className="grid gap-3 rounded-md border border-[var(--ad-border)] p-3 md:grid-cols-3"><Field label="Consistency samples (≥20)" onChange={(sampleCount) => setReview({ ...review, sampleCount })} value={review.sampleCount} /><Field label="Consistency passes (≥80%)" onChange={(passCount) => setReview({ ...review, passCount })} value={review.passCount} /><Field label="Review evidence URL" onChange={(reviewUrl) => setReview({ ...review, reviewUrl })} value={review.reviewUrl} /></div> : null}
    <details className="rounded-md border border-[var(--ad-border)] p-3"><summary className="cursor-pointer text-sm font-semibold">{t("Engineering details")}</summary><pre className="mt-3 overflow-x-auto text-xs text-[var(--ad-text-muted)]">{JSON.stringify(profile, null, 2)}</pre></details>
  </section>;
}

function FlagsTable({ canWrite, confirmWrite, rows }: { canWrite: boolean; confirmWrite: (input: ConfigCommand) => void; rows: RecordRow[] }) {
  const { t } = useAdminI18n();
  return <div aria-label={t("Feature Flags scrollable table")} className="overflow-x-auto rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]" role="region" tabIndex={0}><table className="w-full min-w-[760px] text-left text-sm"><caption className="sr-only">{t("Feature Flags")}</caption><thead><tr className="border-b border-[var(--ad-border)] text-xs uppercase text-[var(--ad-text-muted)]">{["Key", "Enabled", "Rollout", "Version", "Hard policy", "Actions"].map((header) => <th className="px-4 py-3 font-medium" key={header} scope="col">{header}</th>)}</tr></thead><tbody>{rows.map((row) => {
    const key = text(row.key);
    const enabled = Boolean(row.enabled);
    const expected = `${key}:${enabled ? "disabled" : "enabled"}`;
    return <tr className="border-b border-[var(--ad-border)] last:border-0" key={key}><td className="px-4 py-3 font-mono text-xs">{key}</td><td className="px-4 py-3">{String(enabled)}</td><td className="px-4 py-3">{display(row.rolloutPercent)}</td><td className="px-4 py-3">{display(row.version)}</td><td className="px-4 py-3">{display(row.hardPolicy)}</td><td className="px-4 py-3">{canWrite ? <Action icon={<Flag className="h-4 w-4" />} label={enabled ? "Disable" : "Enable"} onClick={() => confirmWrite({ title: `${enabled ? "Disable" : "Enable"} ${key}`, completed: enabled ? t("Feature flag {key} disabled", { key }) : t("Feature flag {key} enabled", { key }), endpoint: `/api/v2/admin/feature-flags/${key}`, method: "PATCH", expected, consequence: { effect: t("The flag flips for live traffic on the next request. Flipping it back is one more click on this same row."), reversible: true }, payload: (reason) => ({ enabled: !enabled, reason }) })} /> : t("Read only")}</td></tr>;
  })}</tbody></table></div>;
}

function Freshness<T>({ label, state }: { label: string; state: AuthorityState<T> }) {
  const { t } = useAdminI18n(); const time = state.refreshedAt ? new Date(state.refreshedAt).toLocaleTimeString() : "unknown"; if (state.loading && state.data) return <span>{label}{t(": refreshing · as of")} {time}</span>; if (state.error && state.data) return <span>{label}{t(": stale · last good")} {time}</span>; if (state.error) return <span>{label}{t(": unavailable")}</span>; if (state.data) return <span>{label}{t(": as of")} {time}</span>; return <span>{label}{t(": loading…")}</span>; }
function AuthorityError<T>({ label, onRetry, state }: { label: string; onRetry: () => void; state: AuthorityState<T> }) {
  const { t } = useAdminI18n(); return state.error ? <div className="rounded-md bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]" role="alert">{label}  {t("authority refresh failed:")} {state.error}<button className="ml-3 min-h-8 rounded border border-current px-2 font-semibold" onClick={onRetry} type="button">{t("Retry")} {label}</button>{state.data ? <span className="ml-2">{t("The last good snapshot remains visible.")}</span> : null}</div> : null; }
function Loading() {
  const { t } = useAdminI18n(); return <div aria-label={t("Loading profiles…")} className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4" role="status"><span className="inline-flex items-center gap-2 text-sm text-[var(--ad-text-muted)]"><Loader2 className="h-4 w-4 animate-spin" />{t("Loading profiles…")}</span></div>; }
function Tab({ active, count, label, meta, onClick }: { active: boolean; count: number; label: string; meta: string; onClick: () => void }) { return <button aria-current={active ? "page" : undefined} className={`px-4 py-3 text-left ${active ? "bg-[var(--ad-ink)] text-white" : "bg-[var(--ad-surface)]"}`} onClick={onClick} type="button"><span className="flex justify-between font-semibold"><span>{label}</span><span>{count}</span></span><span className="mt-1 block text-xs opacity-70">{meta}</span></button>; }
function Field({ label, onChange, search = false, value }: { label: string; onChange: (value: string) => void; search?: boolean; value: string }) { return <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{label}<input className="min-h-11 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm" onChange={(event) => onChange(event.target.value)} role={search ? "searchbox" : undefined} value={value} /></label>; }
function Select({ label, onChange, options, value }: { label: string; onChange: (value: string) => void; options: string[]; value: string }) { return <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{label}<select className="min-h-11 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm" onChange={(event) => onChange(event.target.value)} value={value}>{options.map((option) => <option key={option || "all"} value={option}>{option || "All"}</option>)}</select></label>; }
function Action({ disabled = false, icon, label, onClick }: { disabled?: boolean; icon: ReactNode; label: string; onClick: () => void }) { return <button className="inline-flex min-h-9 items-center gap-2 rounded-md border border-[var(--ad-border)] px-3 text-sm disabled:opacity-40" disabled={disabled} onClick={onClick} type="button">{icon}{label}</button>; }
function NextPage({ label, loading, onClick, pageInfo }: { label: string; loading: boolean; onClick: () => void; pageInfo: PageInfo }) { return pageInfo.hasNextPage && pageInfo.endCursor ? <button className="inline-flex min-h-11 items-center gap-2 rounded-md border border-[var(--ad-border)] px-4 text-sm font-semibold" disabled={loading} onClick={onClick} type="button"><RefreshCcw className="h-4 w-4" />{label}</button> : null; }
function currentQuery() { return typeof window === "undefined" ? defaultGenerationConfigQuery : generationConfigQueryFromSearch(window.location.search); }
function text(value: unknown) { return typeof value === "string" ? value : ""; }
function display(value: unknown) { return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "—"; }
function integer(value: string) { const parsed = Number(value); return Number.isInteger(parsed) && parsed >= 0 ? parsed : null; }
function firstOrientation(profile: RecordRow | null) { const values = profile && Array.isArray(profile.allowedOrientations) ? profile.allowedOrientations.filter((value): value is string => typeof value === "string") : []; return values[0] ?? "1:1"; }
function errorMessage(cause: unknown, fallback: string) { return cause instanceof Error ? cause.message : fallback; }
