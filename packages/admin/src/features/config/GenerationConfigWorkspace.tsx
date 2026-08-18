"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Flag, Loader2, Play, RotateCcw, UploadCloud, X } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { DataTable, type DataTableRow } from "@/components/admin/ui/DataTable";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { useAdminFormat, text } from "@/components/admin/ui/format";
import { emptyPageInfo, Pagination, type PageInfo } from "@/components/admin/ui/Pagination";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { PermissionNotice } from "@/components/admin/ui/PermissionNotice";
import { useToast } from "@/components/admin/ui/Toast";
import { createLatestRequestGate } from "@/lib/latest-request";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import {
  defaultGenerationConfigQuery,
  featureFlagsPath,
  GENERATION_CONFIG_PAGE_SIZE,
  generationConfigQueryFromSearch,
  generationConfigWorkspaceUrl,
  generationProfilesPath,
  isGenerationConfigQueryFiltered,
  type GenerationConfigQuery,
} from "./query";

type RecordRow = Record<string, unknown>;
type ListResponse = { items: RecordRow[]; pageInfo?: PageInfo };
type AuthorityState<T> = { data: T | null; error: string | null; cause: unknown; loading: boolean; refreshedAt: string | null };
type Permissions = { manageProfiles: boolean; manageFlags: boolean };
type ReviewDraft = { sampleCount: string; passCount: string; reviewUrl: string };
// SPEC: 一次测试出一张。同一个值既发给后端，也印在确认框的成本说明里。
const TEST_IMAGE_OUTPUT_COUNT = 1;
const emptyAuthorityState = <T,>(): AuthorityState<T> => ({ data: null, error: null, cause: undefined, loading: true, refreshedAt: null });
/** 两张表各自翻页，但一次 navigate 会把两边都重新拉一遍，所以轨迹要一起带着走。 */
type ConfigTrails = { profiles: string[]; flags: string[] };
const emptyTrails: ConfigTrails = { profiles: [], flags: [] };
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
  const format = useAdminFormat();
  const { toast } = useToast();
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
  // 游标分页没有页码，只有「上一页用的是哪个游标」。这条轨迹就是 Pagination 的第 N 页。
  const [trails, setTrails] = useState<ConfigTrails>(emptyTrails);
  const requestGates = useRef({ profiles: createLatestRequestGate(), flags: createLatestRequestGate(), jobs: createLatestRequestGate() });
  const initialQuery = useRef(query);

  const loadProfiles = useCallback(async (next: GenerationConfigQuery) => {
    const request = requestGates.current.profiles.begin();
    setProfiles((current) => ({ ...current, error: null, loading: true }));
    try {
      const data = await apiGet<ListResponse>(generationProfilesPath(next));
      if (request.isCurrent()) setProfiles({ data, error: null, cause: undefined, loading: false, refreshedAt: new Date().toISOString() });
    } catch (cause) {
      if (request.isCurrent()) setProfiles((current) => ({ ...current, error: errorMessage(cause, "Profile authority request failed"), cause, loading: false }));
    }
  }, []);

  const loadFlags = useCallback(async (next: GenerationConfigQuery) => {
    const request = requestGates.current.flags.begin();
    setFlags((current) => ({ ...current, error: null, loading: true }));
    try {
      const data = await apiGet<ListResponse>(featureFlagsPath(next));
      if (request.isCurrent()) setFlags({ data, error: null, cause: undefined, loading: false, refreshedAt: new Date().toISOString() });
    } catch (cause) {
      if (request.isCurrent()) setFlags((current) => ({ ...current, error: errorMessage(cause, "Feature-flag authority request failed"), cause, loading: false }));
    }
  }, []);

  const loadJobs = useCallback(async () => {
    const request = requestGates.current.jobs.begin();
    setRecentJobs((current) => ({ ...current, error: null, loading: true }));
    try {
      const data = await apiGet<ListResponse>("/api/v2/admin/jobs?mode=image&limit=12");
      if (request.isCurrent()) setRecentJobs({ data, error: null, cause: undefined, loading: false, refreshedAt: new Date().toISOString() });
    } catch (cause) {
      if (request.isCurrent()) setRecentJobs((current) => ({ ...current, error: errorMessage(cause, "Recent-job authority request failed"), cause, loading: false }));
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
      // 回退到的那一页是哪一页，历史条目里没记；不知道就说不知道，把「上一页」置灰。
      setTrails(emptyTrails);
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

  // SPEC: 任何改变结果集的动作都回到第一页 —— 所以 trails 默认清空，只有翻页自己传轨迹。
  function navigate(next: GenerationConfigQuery, mode: "push" | "replace" = "push", nextTrails: ConfigTrails = emptyTrails) {
    const url = generationConfigWorkspaceUrl(window.location.pathname, window.location.search, next);
    window.history[mode === "push" ? "pushState" : "replaceState"](null, "", url);
    setQuery(next);
    setDraft(next);
    setTrails(nextTrails);
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

  // SPEC: 出测试图要过确认框，并在框里写清楚这一下到底花掉什么。
  // INTENT: 它以前是一个点了就跑的按钮，而它跑的是**真实**生成——占 provider 一次排队和一次
  //         GPU 出图，和客户的活儿抢同一条队。后端 costDreamcoins: 0，所以不扣梦币；
  //         这两件事都要说，只说一半都会让运营做错判断。
  // INVARIANT: 成本说明里的张数必须跟真正发出去的 outputCount 一致，别写死。
  function confirmTestImage() {
    if (!permissions.manageProfiles || !selectedId) return;
    const profileId = selectedId;
    const idempotencyKey = crypto.randomUUID();
    setConfirmation({
      title: t("Generate test image on {id}", { id: profileId }),
      consequence: {
        effect: t("This runs a real generation: {count} image on {runner}, queued behind customer work. It debits no Dreamcoins, and the queued job cannot be recalled once dispatched.", {
          count: TEST_IMAGE_OUTPUT_COUNT,
          runner: text(selectedProfile?.runner) || "—",
        }),
        reversible: false,
      },
      destructive: { expectedName: profileId, inputLabel: "Confirmation" },
      reasonLabel: "Reason",
      submitLabel: t("Queue test image"),
      onSubmit: async (reason) => {
        setTestBusy(true);
        try {
          const response = await apiWrite<{ job: RecordRow }>(`/api/v2/admin/generation/model-profiles/${profileId}/commands/test-job`, "POST", {
            prompt: testPrompt.trim() || undefined,
            orientation: firstOrientation(selectedProfile),
            outputCount: TEST_IMAGE_OUTPUT_COUNT,
            reason,
            confirmation: profileId,
          }, { "idempotency-key": idempotencyKey });
          // INTENT: 排队成功是 info 不是 success —— 图还没出来，运营要等下面的 recent jobs。
          toast({ tone: "info", title: t("Test image queued as {id}", { id: text(response.job.id) || t("an unnamed job") }) });
          await loadJobs();
        } finally {
          setTestBusy(false);
        }
      },
    });
  }

  const filtered = isGenerationConfigQueryFiltered(query);
  const initiallyLoading = !profiles.data && !flags.data && !recentJobs.data && (profiles.loading || flags.loading || recentJobs.loading);
  return (
    <section aria-labelledby="generation-config-title" className="space-y-5">
      <div id="generation-config-title"><PageHeader purpose={t("Test generation profiles, publish proven versions, and roll feature flags through audited control-plane commands.")} title={t("Profiles & Rollout")} /></div>
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
        <Select booleanOptions label="Flag state" onChange={(flagEnabled) => setDraft((current) => ({ ...current, flagEnabled }))} options={["", "true", "false"]} value={draft.flagEnabled} />
        <div className="flex items-end gap-2"><button className="min-h-11 rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white" type="submit">{t("Apply")}</button>{filtered ? <button aria-label={t("Clear generation config filters")} className="grid min-h-11 min-w-11 place-items-center rounded-md border border-[var(--ad-border)]" onClick={() => navigate({ ...defaultGenerationConfigQuery, tab: query.tab })} type="button"><X className="h-4 w-4" /></button> : null}</div>
      </form>

      <AuthorityError onRetry={() => void loadProfiles(query)} state={profiles} />
      <AuthorityError onRetry={() => void loadFlags(query)} state={flags} />
      <AuthorityError onRetry={() => void loadJobs()} state={recentJobs} />
      {initiallyLoading ? <Loading /> : query.tab === "profiles" ? (
        <>
          {!permissions.manageProfiles ? <p className="text-xs"><PermissionNotice permission="generation.config.write" /></p> : null}
          {profiles.data ? profileRows.length === 0 ? <EmptyState hint={filtered ? "The complete profile authority query returned no matches." : "No built-in generation profiles are seeded yet."} title={filtered ? "No generation profiles match these filters." : "No built-in generation profiles are seeded yet."} /> : (
            <div className="grid gap-4 lg:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.6fr)]">
              <div className="space-y-2 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3">{profileRows.map((profile) => {
                const id = text(profile.id);
                return <button aria-current={id === selectedId ? "true" : undefined} className={`w-full rounded-md border px-3 py-3 text-left ${id === selectedId ? "border-[var(--ad-ink)] bg-black/5" : "border-[var(--ad-border)]"}`} key={id} onClick={() => setSelectedProfileId(id)} type="button"><span className="block font-semibold">{text(profile.label) || text(profile.profileKey) || id}</span><span className="mt-1 block text-xs text-[var(--ad-text-muted)]">{format.display(profile.status)} · v{format.display(profile.version)} · {format.display(profile.mode)}</span></button>;
              })}</div>
              {selectedProfile ? <ProfileDetail canWrite={permissions.manageProfiles} jobs={recentJobs.data?.items ?? []} onConfirm={confirmWrite} onTest={confirmTestImage} profile={selectedProfile} review={review} setReview={setReview} setTestPrompt={setTestPrompt} testBusy={testBusy} testPrompt={testPrompt} /> : null}
            </div>
          ) : null}
          {profiles.data ? <ListPagination cursor={query.profileCursor} loading={profiles.loading} onNavigate={(profileCursor, trail) => navigate({ ...query, profileCursor }, "push", { ...trails, profiles: trail })} pageInfo={profiles.data.pageInfo ?? emptyPageInfo} rowCount={profileRows.length} trail={trails.profiles} /> : null}
        </>
      ) : (
        <>
          {!permissions.manageFlags ? <p className="text-xs"><PermissionNotice permission="config.feature_flag.write" /></p> : null}
          {flags.data ? flagRows.length === 0 ? <EmptyState hint={filtered ? "The complete flag authority query returned no matches." : "No feature flags exist in the authority."} title={filtered ? "No feature flags match these filters" : "No feature flags exist yet"} /> : <FlagsTable canWrite={permissions.manageFlags} confirmWrite={confirmWrite} rows={flagRows} /> : null}
          {flags.data ? <ListPagination cursor={query.flagCursor} loading={flags.loading} onNavigate={(flagCursor, trail) => navigate({ ...query, flagCursor }, "push", { ...trails, flags: trail })} pageInfo={flags.data.pageInfo ?? emptyPageInfo} rowCount={flagRows.length} trail={trails.flags} /> : null}
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
  const format = useAdminFormat();
  const id = text(profile.id);
  const status = text(profile.status);
  const mode = text(profile.mode);
  const relatedJobs = jobs.filter((job) => [text(profile.profileKey), id].includes(text(job.profileId)));
  const sampleCount = integer(review.sampleCount);
  const passCount = integer(review.passCount);
  const reviewReady = mode !== "image" || (sampleCount !== null && passCount !== null && sampleCount >= 20 && passCount <= sampleCount && passCount / sampleCount >= 0.8);
  return <section className="space-y-4 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
    <div><h2 className="text-lg font-semibold">{text(profile.label) || text(profile.profileKey) || id}</h2><p className="mt-1 text-sm text-[var(--ad-text-muted)]">{format.display(status)} · v{format.display(profile.version)} · {format.display(profile.runner)} · {format.display(profile.pipelineModel)}</p></div>
    {canWrite ? <div className="flex flex-wrap gap-2">
      {status === "draft" ? <Action icon={<Activity className="h-4 w-4" />} label="Configuration check" onClick={() => onConfirm({ title: t("Check profile configuration {id}", { id }), completed: t("Configuration check finished for {id}", { id }), endpoint: `/api/v2/admin/generation/model-profiles/${id}/commands/dry-run`, method: "POST", expected: id, consequence: { effect: t("The profile is validated against the runtime. Nothing customer-facing changes."), reversible: true }, payload: (reason) => ({ reason }) })} /> : null}
      {mode === "image" && status !== "archived" ? <Action disabled={testBusy} icon={testBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} label="Generate test image" onClick={onTest} /> : null}
      {status === "draft" ? <Action disabled={!reviewReady} icon={<UploadCloud className="h-4 w-4" />} label="Publish" onClick={() => onConfirm({ title: t("Publish profile {id}", { id }), completed: t("Profile {id} published", { id }), endpoint: `/api/v2/admin/generation/model-profiles/${id}/commands/publish`, method: "POST", expected: id, consequence: { effect: t("Every new customer generation runs on this profile from now on, and the previous active version is archived. A rollback restores it; images already produced are not regenerated."), reversible: true }, payload: (reason) => ({ reason, ...(mode === "image" ? { dryRunSummary: { reviewSource: "admin_console_manual_consistency_review", reviewStatus: "manual_passed", consistencySampleCount: sampleCount, consistencyPassCount: passCount, consistencyRate: sampleCount && passCount !== null ? passCount / sampleCount : 0, reviewUrl: review.reviewUrl.trim() || undefined } } : {}) }) })} /> : null}
      {status === "active" ? <Action icon={<RotateCcw className="h-4 w-4" />} label="Rollback" onClick={() => onConfirm({ title: t("Rollback profile {id}", { id }), completed: t("Profile {id} rolled back", { id }), endpoint: `/api/v2/admin/generation/model-profiles/${id}/commands/rollback`, method: "POST", expected: id, consequence: { effect: t("Customer generations go back to the previously active profile version from now on."), reversible: true }, payload: (reason) => ({ reason }) })} /> : null}
      {status === "active" && Boolean(profile.enabled) ? <Action icon={<X className="h-4 w-4" />} label="Disable" onClick={() => onConfirm({ title: t("Disable profile {id}", { id }), completed: t("Profile {id} disabled", { id }), endpoint: `/api/v2/admin/generation/model-profiles/${id}`, method: "PATCH", expected: id, consequence: { effect: t("Generations stop routing to this profile immediately. Re-enabling it is a second edit on this same profile."), reversible: true }, payload: (reason) => ({ reason, enabled: false }) })} /> : null}
    </div> : null}
    {mode === "image" && status !== "archived" ? <div className="grid gap-3 rounded-md border border-[var(--ad-border)] p-3 md:grid-cols-2"><Field label="Test image prompt" onChange={setTestPrompt} value={testPrompt} /><p className="self-end text-xs text-[var(--ad-text-muted)]">{relatedJobs.length}  {t("recent profile test job")}{relatedJobs.length === 1 ? "" : "s"}</p></div> : null}
    {mode === "image" && status === "draft" ? <div className="grid gap-3 rounded-md border border-[var(--ad-border)] p-3 md:grid-cols-3"><Field label="Consistency samples (≥20)" onChange={(sampleCount) => setReview({ ...review, sampleCount })} value={review.sampleCount} /><Field label="Consistency passes (≥80%)" onChange={(passCount) => setReview({ ...review, passCount })} value={review.passCount} /><Field label="Review evidence URL" onChange={(reviewUrl) => setReview({ ...review, reviewUrl })} value={review.reviewUrl} /></div> : null}
    {/* INTENT: Publish 在一致性复核没达标时是灰的，而灰按钮不会说自己为什么灰——
        运营只能猜是权限不够还是数字不对。把还差什么直接写出来。 */}
    {canWrite && status === "draft" && !reviewReady ? <p className="text-xs text-[var(--ad-text-muted)]" role="status">{publishBlockedReason(sampleCount, passCount, t)}</p> : null}
    <details className="rounded-md border border-[var(--ad-border)] p-3"><summary className="cursor-pointer text-sm font-semibold">{t("Engineering details")}</summary><pre className="mt-3 overflow-x-auto text-xs text-[var(--ad-text-muted)]">{JSON.stringify(profile, null, 2)}</pre></details>
  </section>;
}

function FlagsTable({ canWrite, confirmWrite, rows }: { canWrite: boolean; confirmWrite: (input: ConfigCommand) => void; rows: RecordRow[] }) {
  const { t } = useAdminI18n();
  const format = useAdminFormat();
  const tableRows: DataTableRow[] = rows.map((row, index) => {
    const key = text(row.key);
    const enabled = Boolean(row.enabled);
    const expected = `${key}:${enabled ? "disabled" : "enabled"}`;
    return {
      id: key || `flag-${index}`,
      cells: [
        <code className="text-xs" key="key">{key || "—"}</code>,
        format.display(enabled),
        format.display(row.rolloutPercent),
        format.display(row.version),
        format.display(row.hardPolicy),
        canWrite ? <Action icon={<Flag className="h-4 w-4" />} key="action" label={enabled ? "Disable" : "Enable"} onClick={() => confirmWrite({ title: enabled ? t("Disable feature flag {key}", { key }) : t("Enable feature flag {key}", { key }), completed: enabled ? t("Feature flag {key} disabled", { key }) : t("Feature flag {key} enabled", { key }), endpoint: `/api/v2/admin/feature-flags/${key}`, method: "PATCH", expected, consequence: { effect: t("The flag flips for live traffic on the next request. Flipping it back is one more click on this same row."), reversible: true }, payload: (reason) => ({ enabled: !enabled, reason }) })} /> : t("Read only"),
      ],
    };
  });
  return <DataTable caption="Feature flags" headers={["Key", "Enabled", "Rollout", "Version", "Hard policy", "Actions"]} minimumWidthClassName="min-w-[760px]" rows={tableRows} stickyLastColumn />;
}

/**
 * SPEC: 说清楚 Publish 还差什么，按发布闸自己的顺序：先要样本数，再要通过率。
 * INVARIANT: 判据必须和 reviewReady 用同一组数字，否则会出现「提示说达标了但按钮还是灰的」。
 */
export function publishBlockedReason(
  sampleCount: number | null,
  passCount: number | null,
  t: (key: string, values?: Record<string, string | number>) => string,
) {
  if (sampleCount === null || sampleCount < 20) {
    return t("Publishing needs a consistency review of at least 20 samples.");
  }
  if (passCount === null || passCount > sampleCount) {
    return t("Enter how many of the {count} samples passed.", { count: sampleCount });
  }
  if (passCount / sampleCount < 0.8) {
    return t("{passed} of {count} samples passed. Publishing needs at least 80%.", {
      count: sampleCount,
      passed: passCount,
    });
  }
  return "";
}

function Freshness<T>({ label, state }: { label: string; state: AuthorityState<T> }) {
  const { t } = useAdminI18n(); const format = useAdminFormat(); const name = t(label); const time = state.refreshedAt ? format.time(state.refreshedAt) : t("unknown"); if (state.loading && state.data) return <span>{name}{t(": refreshing · as of")} {time}</span>; if (state.error && state.data) return <span>{name}{t(": stale · last good")} {time}</span>; if (state.error) return <span>{name}{t(": unavailable")}</span>; if (state.data) return <span>{name}{t(": as of")} {time}</span>; return <span>{name}{t(": loading…")}</span>; }
function AuthorityError<T>({ onRetry, state }: { onRetry: () => void; state: AuthorityState<T> }) {
  return state.error ? <AuthorityRequestError cause={state.cause} message={state.error} onRetry={onRetry} snapshotAt={state.data ? state.refreshedAt : null} /> : null; }
function Loading() {
  const { t } = useAdminI18n(); return <div aria-label={t("Loading profiles…")} className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4" role="status"><span className="inline-flex items-center gap-2 text-sm text-[var(--ad-text-muted)]"><Loader2 className="h-4 w-4 animate-spin" />{t("Loading profiles…")}</span></div>; }
function Tab({ active, count, label, meta, onClick }: { active: boolean; count: number; label: string; meta: string; onClick: () => void }) { const { t } = useAdminI18n(); return <button aria-current={active ? "page" : undefined} className={`px-4 py-3 text-left ${active ? "bg-[var(--ad-ink)] text-white" : "bg-[var(--ad-surface)]"}`} onClick={onClick} type="button"><span className="flex justify-between font-semibold"><span>{t(label)}</span><span>{count}</span></span><span className="mt-1 block text-xs opacity-70">{t(meta)}</span></button>; }
function Field({ label, onChange, search = false, value }: { label: string; onChange: (value: string) => void; search?: boolean; value: string }) { const { t } = useAdminI18n(); return <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t(label)}<input className="min-h-11 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm" onChange={(event) => onChange(event.target.value)} role={search ? "searchbox" : undefined} value={value} /></label>; }
// SPEC: 选项文案走 enumLabel —— 枚举值与 StatusBadge 共用同一份译文（zhValues）。
// INTENT: booleanOptions 是给"开关状态"这类布尔筛选留的口子。它的取值是查询串里的 "true"/"false"，
//         不是领域枚举；把这两个词塞进全局 zhValues，别处任何一个 true 都会跟着被译成"已启用"。
function Select({ booleanOptions = false, label, onChange, options, value }: { booleanOptions?: boolean; label: string; onChange: (value: string) => void; options: string[]; value: string }) { const { t, value: enumLabel } = useAdminI18n(); return <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t(label)}<select className="min-h-11 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm" onChange={(event) => onChange(event.target.value)} value={value}>{options.map((option) => <option key={option || "all"} value={option}>{option ? (booleanOptions ? t(option === "true" ? "Enabled" : "Disabled") : enumLabel(option)) : t("All")}</option>)}</select></label>; }
function Action({ disabled = false, icon, label, onClick }: { disabled?: boolean; icon: ReactNode; label: string; onClick: () => void }) { const { t } = useAdminI18n(); return <button className="inline-flex min-h-9 items-center gap-2 rounded-md border border-[var(--ad-border)] px-3 text-sm disabled:opacity-40" disabled={disabled} onClick={onClick} type="button">{icon}{t(label)}</button>; }
// SPEC: 配置档案和功能开关两张表的分页条形状完全一样，只有游标属于哪一张不同。
function ListPagination({ cursor, loading, onNavigate, pageInfo, rowCount, trail }: {
  cursor: string;
  loading: boolean;
  onNavigate: (cursor: string, trail: string[]) => void;
  pageInfo: PageInfo;
  rowCount: number;
  trail: string[];
}) {
  return (
    <Pagination
      hasNext={Boolean(pageInfo.hasNextPage && pageInfo.endCursor)}
      hasPrevious={trail.length > 0}
      loading={loading}
      onNext={() => {
        if (!pageInfo.endCursor) return;
        onNavigate(pageInfo.endCursor, [...trail, cursor]);
      }}
      onPrevious={() => onNavigate(trail.at(-1) ?? "", trail.slice(0, -1))}
      page={trail.length + 1}
      pageSize={GENERATION_CONFIG_PAGE_SIZE}
      rowCount={rowCount}
    />
  );
}
function currentQuery() { return typeof window === "undefined" ? defaultGenerationConfigQuery : generationConfigQueryFromSearch(window.location.search); }
function integer(value: string) { const parsed = Number(value); return Number.isInteger(parsed) && parsed >= 0 ? parsed : null; }
function firstOrientation(profile: RecordRow | null) { const values = profile && Array.isArray(profile.allowedOrientations) ? profile.allowedOrientations.filter((value): value is string => typeof value === "string") : []; return values[0] ?? "1:1"; }
function errorMessage(cause: unknown, fallback: string) { return cause instanceof Error ? cause.message : fallback; }
