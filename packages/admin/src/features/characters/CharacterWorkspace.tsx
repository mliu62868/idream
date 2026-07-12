"use client";

import Link from "next/link";
import {
  characterPortfolioResponseSchema,
  characterWorkspaceDetailSchema,
  type CharacterPortfolioItem,
  type CharacterQaCheckInput,
  type CharacterWorkspaceDetail,
} from "@idream/shared/admin";
import { ArrowLeft, Clock3, RefreshCcw, Rocket, RotateCcw, Save, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { AdminSubview } from "@/components/admin/nav-config";
import { CharacterCreateWizard } from "@/features/characters/CharacterCreateWizard";
import { CollaborationPanel } from "@/features/collaboration/CollaborationPanel";
import {
  EmptyWorkspace,
  LoadingWorkspace,
  StatusBadge,
  WorkspaceButton,
  fieldClass,
  textAreaClass,
} from "@/features/operations/WorkspaceUi";
import { AdminV2RequestError, adminV2Request, setWorkspaceUrl } from "@/lib/admin-v2-api";
import { cn } from "@/lib/utils";

type Permissions = {
  read: boolean;
  writeProject: boolean;
  proposeRelease: boolean;
  publishRelease: boolean;
  reviewRelease: boolean;
};

type ProjectDraft = Pick<CharacterWorkspaceDetail["project"],
  "ownerId" | "audience" | "companionNeed" | "hypothesis" | "differentiation" |
  "targetPlacementKeys" | "successCriteria" | "productionPackage" | "qaPlan" | "plannedLaunchAt">;

const tabs = ["project", "preview", "release", "monitor", "portfolio"] as const;
type Tab = typeof tabs[number];

function percent(value: number | null) {
  return value === null ? "Unavailable" : `${(value * 100).toFixed(1)}%`;
}

function permissionDenied(label: string) {
  return (
    <section aria-labelledby="permission-title" className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-8">
      <ShieldAlert className="h-6 w-6 text-[var(--ad-text-muted)]" />
      <h2 className="mt-4 text-lg font-semibold" id="permission-title">No permission</h2>
      <p className="mt-2 text-sm text-[var(--ad-text-muted)]">Your effective grants do not include {label}. Ask an administrator for the matching scoped permission.</p>
    </section>
  );
}

function PortfolioCard({ item }: { item: CharacterPortfolioItem }) {
  const performance = item.performance.find((metric) => metric.window === "28d" && metric.placementId === null)
    ?? item.performance.find((metric) => metric.window === "28d")
    ?? null;
  return (
    <Link
      className="group grid gap-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 transition-colors hover:border-[var(--ad-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)] sm:grid-cols-[64px_1fr_auto]"
      href={`/admin/characters/${item.characterId}`}
    >
      <div className="grid h-16 w-16 place-items-center rounded-lg bg-black/[0.04] text-xl font-semibold text-[var(--ad-text-muted)]">
        {item.name.slice(0, 1).toUpperCase()}
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate font-semibold text-[var(--ad-ink)]">{item.name}</h3>
          <StatusBadge value={item.serving.state} />
          <StatusBadge value={item.readiness} />
        </div>
        <p className="mt-2 text-sm text-[var(--ad-text-muted)]">{item.project.audience} · {item.project.phase.replaceAll("_", " ")}</p>
        <p className="mt-2 text-xs text-[var(--ad-text-muted)]">
          28d QCE {performance ? percent(performance.qceRate) : "Unavailable"} · D7 {performance ? percent(performance.sameCharacterD7) : "Unavailable"} · {performance?.maturity ?? "insufficient_data"}
        </p>
      </div>
      <div className="self-center text-right text-xs text-[var(--ad-text-muted)]">
        {item.latestDecision?.decision ?? "No decision"}<br />
        <span className="mt-1 inline-block group-hover:text-[var(--ad-ink)]">Open workspace →</span>
      </div>
    </Link>
  );
}

function CharacterPortfolio({ permissions }: { permissions: Permissions }) {
  const [items, setItems] = useState<CharacterPortfolioItem[]>([]);
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();
  const [pageInfo, setPageInfo] = useState<{ endCursor: string | null; hasNextPage: boolean }>({ endCursor: null, hasNextPage: false });
  const [asOf, setAsOf] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (next: { search: string; cursor?: string }, historyMode: "none" | "push" | "replace") => {
    if (!permissions.read) return;
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ limit: "25", sort: "project_id_asc" });
      if (next.search.trim()) query.set("search", next.search.trim());
      if (next.cursor) query.set("cursor", next.cursor);
      if (historyMode !== "none") {
        window.history[historyMode === "push" ? "pushState" : "replaceState"](null, "", `${window.location.pathname}?${query}`);
      }
      const data = await adminV2Request(`/api/v2/admin/characters/portfolio?${query}`, { schema: characterPortfolioResponseSchema });
      setItems([...data.items]);
      setPageInfo(data.pageInfo);
      setAsOf(data.asOf);
    } catch (reason) {
      setItems([]);
      setPageInfo({ endCursor: null, hasNextPage: false });
      setError(reason instanceof Error ? reason.message : "Character portfolio could not be loaded");
    } finally {
      setLoading(false);
    }
  }, [permissions.read]);

  useEffect(() => {
    const restore = (historyMode: "none" | "replace") => {
      const params = new URLSearchParams(window.location.search);
      const next = { search: params.get("search") ?? "", cursor: params.get("cursor") ?? undefined };
      setSearch(next.search);
      setCursor(next.cursor);
      void load(next, historyMode);
    };
    const timer = window.setTimeout(() => restore("replace"), 0);
    const onPopState = () => restore("none");
    window.addEventListener("popstate", onPopState);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("popstate", onPopState);
    };
  }, [load]);

  function apply(nextCursor?: string) {
    setCursor(nextCursor);
    void load({ search, cursor: nextCursor }, "push");
  }

  if (!permissions.read) return permissionDenied("character.project.read");
  return (
    <section aria-labelledby="character-portfolio-title">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ad-text-muted)]">Character Studio</p><h2 className="mt-1 text-2xl font-semibold" id="character-portfolio-title">Portfolio & Projects</h2><p className="mt-2 max-w-2xl text-sm text-[var(--ad-text-muted)]">Decide what to promote, improve, pause, or retire from release-attributed evidence.</p></div>
        <form className="flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); apply(); }}><label className="text-xs font-semibold text-[var(--ad-text-muted)]">Search authority<input aria-label="Search characters" className={`${fieldClass} mt-1 sm:w-72`} onChange={(event) => setSearch(event.target.value)} placeholder="Name, character or project ID" value={search} /></label><WorkspaceButton tone="primary" type="submit">Apply</WorkspaceButton></form>
      </div>
      {error ? <div className="mt-5 rounded-lg bg-[var(--ad-red-bg)] p-4 text-sm text-[var(--ad-red-text)]" role="alert">{error} <button className="ml-2 underline" onClick={() => void load({ search, cursor }, "none")} type="button">Retry</button></div> : null}
      <div className="mt-6">{loading ? <LoadingWorkspace label="Loading release-attributed portfolio" /> : items.length === 0 ? <EmptyWorkspace filtered={Boolean(search)} onClear={() => { setSearch(""); setCursor(undefined); void load({ search: "" }, "push"); }} /> : <div className="grid gap-3">{items.map((item) => <PortfolioCard item={item} key={item.characterId} />)}</div>}</div>
      <div className="mt-4 flex items-center justify-between gap-3"><p className="text-xs text-[var(--ad-text-muted)]">{asOf ? `Fresh as of ${new Date(asOf).toLocaleString()}` : "No successful query yet"}</p><WorkspaceButton disabled={loading || !pageInfo.hasNextPage || !pageInfo.endCursor} onClick={() => apply(pageInfo.endCursor ?? undefined)}>Next page</WorkspaceButton></div>
    </section>
  );
}

function ProjectEditor({ data, permissions, onReload }: { data: CharacterWorkspaceDetail; permissions: Permissions; onReload: () => Promise<void> }) {
  const initial = useMemo<ProjectDraft>(() => ({
    ownerId: data.project.ownerId,
    audience: data.project.audience,
    companionNeed: data.project.companionNeed,
    hypothesis: data.project.hypothesis,
    differentiation: data.project.differentiation,
    targetPlacementKeys: [...data.project.targetPlacementKeys],
    successCriteria: [...data.project.successCriteria],
    productionPackage: data.project.productionPackage,
    qaPlan: data.project.qaPlan,
    plannedLaunchAt: data.project.plannedLaunchAt,
  }), [data]);
  const [draft, setDraft] = useState(initial);
  const [state, setState] = useState<"Saved" | "Saving" | "Conflict" | "Failed to save">("Saved");
  const [message, setMessage] = useState<string | null>(null);
  const savedKey = useRef(JSON.stringify(initial));

  useEffect(() => {
    const key = JSON.stringify(draft);
    if (!permissions.writeProject || key === savedKey.current) return;
    setState("Saving");
    const timer = window.setTimeout(async () => {
      try {
        await adminV2Request(`/api/v2/admin/characters/${data.character.id}/project`, {
          method: "PATCH",
          ifMatch: data.project.version,
          body: { ...draft, entityVersion: data.project.version, reason: "Autosave Character Project changes" },
        });
        savedKey.current = key;
        setState("Saved");
        setMessage(null);
        await onReload();
      } catch (reason) {
        if (reason instanceof AdminV2RequestError && reason.status === 409) {
          setState("Conflict");
          setMessage("A newer server revision exists. Review your local text, then reload the authority before reapplying it.");
        } else {
          setState("Failed to save");
          setMessage(reason instanceof Error ? reason.message : "Project autosave failed");
        }
      }
    }, 650);
    return () => window.clearTimeout(timer);
  }, [data.character.id, data.project.version, draft, onReload, permissions.writeProject]);

  const set = <K extends keyof ProjectDraft>(key: K, value: ProjectDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const disabled = !permissions.writeProject;
  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_320px]">
      <fieldset className="grid gap-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 sm:grid-cols-2" disabled={disabled}>
        <legend className="px-2 text-sm font-semibold">Strategy and release intent</legend>
        <label className="text-xs font-semibold text-[var(--ad-text-muted)]">Owner ID<input className={`${fieldClass} mt-1`} onChange={(event) => set("ownerId", event.target.value || null)} value={draft.ownerId ?? ""} /></label>
        <label className="text-xs font-semibold text-[var(--ad-text-muted)] sm:col-span-2">Audience<textarea className={`${textAreaClass} mt-1`} onChange={(event) => set("audience", event.target.value)} value={draft.audience} /></label>
        <label className="text-xs font-semibold text-[var(--ad-text-muted)] sm:col-span-2">Companion need<textarea className={`${textAreaClass} mt-1`} onChange={(event) => set("companionNeed", event.target.value)} value={draft.companionNeed} /></label>
        <label className="text-xs font-semibold text-[var(--ad-text-muted)] sm:col-span-2">Hypothesis<textarea className={`${textAreaClass} mt-1`} onChange={(event) => set("hypothesis", event.target.value)} value={draft.hypothesis} /></label>
        <label className="text-xs font-semibold text-[var(--ad-text-muted)] sm:col-span-2">Differentiation<textarea className={`${textAreaClass} mt-1`} onChange={(event) => set("differentiation", event.target.value)} value={draft.differentiation} /></label>
        <label className="text-xs font-semibold text-[var(--ad-text-muted)]">Target placements<input className={`${fieldClass} mt-1`} onChange={(event) => set("targetPlacementKeys", event.target.value.split(",").map((item) => item.trim()).filter(Boolean))} value={draft.targetPlacementKeys.join(", ")} /></label>
        <label className="text-xs font-semibold text-[var(--ad-text-muted)]">Planned launch<input className={`${fieldClass} mt-1`} onChange={(event) => set("plannedLaunchAt", event.target.value ? new Date(event.target.value).toISOString() : null)} type="datetime-local" value={draft.plannedLaunchAt?.slice(0, 16) ?? ""} /></label>
        <label className="text-xs font-semibold text-[var(--ad-text-muted)] sm:col-span-2">Success criteria<textarea className={`${textAreaClass} mt-1`} onChange={(event) => set("successCriteria", event.target.value.split("\n").map((item) => item.trim()).filter(Boolean))} value={draft.successCriteria.join("\n")} /></label>
        <label className="text-xs font-semibold text-[var(--ad-text-muted)] sm:col-span-2">Production package<textarea className={`${textAreaClass} mt-1`} onChange={(event) => set("productionPackage", event.target.value)} value={draft.productionPackage} /></label>
        <label className="text-xs font-semibold text-[var(--ad-text-muted)] sm:col-span-2">QA plan<textarea className={`${textAreaClass} mt-1`} onChange={(event) => set("qaPlan", event.target.value)} value={draft.qaPlan} /></label>
      </fieldset>
      <aside className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ad-text-muted)]">Server draft</p>
        <div className="mt-4 flex items-center gap-2" role="status"><Save className="h-4 w-4" /><strong>{disabled ? "Read only" : state}</strong></div>
        <p className="mt-2 text-xs text-[var(--ad-text-muted)]">Project revision {data.project.version}. Autosave uses If-Match; conflicts never overwrite a newer revision.</p>
        {message ? <p className="mt-4 rounded-md bg-[var(--ad-yellow-bg)] p-3 text-xs text-[var(--ad-yellow-text)]" role={state === "Failed to save" ? "alert" : "status"}>{message}</p> : null}
        {state === "Conflict" ? <div className="mt-3"><WorkspaceButton onClick={() => void onReload()}><RefreshCcw className="h-4 w-4" /> Load server revision</WorkspaceButton></div> : null}
      </aside>
      <div className="xl:col-span-2">
        <CollaborationPanel canWrite={permissions.writeProject} targetId={data.project.id} targetType="character_project" />
      </div>
    </div>
  );
}

const qaCheckKeys: readonly CharacterQaCheckInput["key"][] = [
  "explore_feed_card_desktop",
  "explore_feed_card_mobile",
  "character_detail_desktop",
  "character_detail_mobile",
  "opening_message",
  "five_turn_conversation",
  "chat_image",
];

function PreviewDiff({ data, permissions, reload }: { data: CharacterWorkspaceDetail; permissions: Permissions; reload: () => Promise<void> }) {
  const snapshots = [data.preview.live, data.preview.draft].filter((item): item is NonNullable<typeof item> => Boolean(item));
  const [checks, setChecks] = useState<CharacterQaCheckInput[]>(() => qaCheckKeys.map((key) => ({
    key,
    result: "failed",
    evidenceRef: "",
    comment: "Not yet verified",
    fixDeepLink: `/admin/characters/${data.character.id}?tab=preview`,
  })));
  const [reason, setReason] = useState("Record renderer and conversation QA evidence");
  const [busy, setBusy] = useState(false);
  const [qaError, setQaError] = useState<string | null>(null);
  const updateCheck = (key: CharacterQaCheckInput["key"], patch: Partial<CharacterQaCheckInput>) => {
    setChecks((current) => current.map((check) => check.key === key ? { ...check, ...patch } : check));
  };
  const recordQa = async () => {
    setBusy(true);
    setQaError(null);
    try {
      await adminV2Request(`/api/v2/admin/characters/${data.character.id}/qa-runs`, {
        method: "POST",
        body: { entityVersion: data.project.version, checks, reason },
      });
      await reload();
    } catch (cause) {
      setQaError(cause instanceof Error ? cause.message : "Could not record QA evidence");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2" aria-label="Changed fields">{data.preview.changedFields.map((field) => <StatusBadge key={field} tone="warn" value={`${field} changed`} />)}</div>
      <section aria-labelledby="real-renderer-preview-title">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div><h2 className="font-semibold" id="real-renderer-preview-title">Real user-surface renderer</h2><p className="mt-1 text-xs text-[var(--ad-text-muted)]">Short-lived signed snapshots render in main without mutating Serving, chats, or assets.</p></div>
          <StatusBadge value="read only" />
        </div>
        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          {snapshots.map((snapshot) => <article className="overflow-hidden rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)]" key={`renderer-${snapshot.label}`}>
            <div className="flex items-center justify-between border-b border-[var(--ad-border)] px-4 py-3"><strong className="text-xs uppercase tracking-wide">{snapshot.label}</strong><span className="text-xs text-[var(--ad-text-muted)]">Desktop + responsive mobile layout</span></div>
            {snapshot.renderUrl ? <iframe className="h-[760px] w-full bg-[rgb(13,13,13)]" loading="lazy" sandbox="allow-scripts allow-same-origin" src={snapshot.renderUrl} title={`${snapshot.label} real frontend renderer`} /> : <div className="p-6 text-sm text-[var(--ad-text-muted)]">Renderer unavailable until an immutable ContentVersion exists.</div>}
          </article>)}
        </div>
      </section>
      <h2 className="mb-4 mt-8 font-semibold">Snapshot evidence</h2>
      <div className="grid gap-4 lg:grid-cols-2">
        {snapshots.map((snapshot) => <article className={cn("overflow-hidden rounded-xl border bg-[var(--ad-surface)]", snapshot.label === "Draft Preview" ? "border-[var(--ad-yellow-text)]" : "border-[var(--ad-border)]")} key={snapshot.label}>
          <div className="border-b border-[var(--ad-border)] px-4 py-3 text-xs font-semibold uppercase tracking-wide">{snapshot.label}</div>
          <div className="grid sm:grid-cols-[160px_1fr]">
            <div className="aspect-[4/5] bg-black/[0.04]">{snapshot.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- operator blob URLs are not compatible with Next image optimization
              <img alt={`${snapshot.name} ${snapshot.label}`} className="h-full w-full object-cover" src={snapshot.imageUrl} />
            ) : <div className="grid h-full place-items-center text-4xl text-[var(--ad-text-muted)]">{snapshot.name.slice(0, 1)}</div>}</div>
            <div className="p-4"><h3 className="text-lg font-semibold">{snapshot.name}</h3><p className="mt-2 text-sm leading-6 text-[var(--ad-text-muted)]">{snapshot.description}</p><h4 className="mt-5 text-xs font-semibold uppercase tracking-wide">Opening</h4><p className="mt-2 text-sm">{String(snapshot.opening.firstMessage ?? "Unavailable")}</p><details className="mt-5 text-xs"><summary className="cursor-pointer font-semibold">Immutable evidence</summary><pre className="mt-2 overflow-auto whitespace-pre-wrap rounded bg-black/[0.04] p-3">{JSON.stringify({ releaseId: snapshot.releaseId, contentVersionId: snapshot.contentVersionId, persona: snapshot.persona, appearance: snapshot.appearance }, null, 2)}</pre></details></div>
          </div>
        </article>)}
      </div>
      <section aria-labelledby="character-qa-title" className="mt-8 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h2 className="font-semibold" id="character-qa-title">Immutable QA evidence</h2><p className="mt-1 text-xs text-[var(--ad-text-muted)]">Every required surface carries a result, evidence, comment, owner and fix path.</p></div>
          <StatusBadge value={`${data.qaRuns.length} runs`} />
        </div>
        <div className="mt-4 grid gap-3">
          {checks.map((check) => <fieldset className="grid gap-2 rounded-lg border border-[var(--ad-border)] p-3 sm:grid-cols-[190px_120px_1fr]" disabled={!permissions.reviewRelease || busy} key={check.key}>
            <legend className="sr-only">{check.key}</legend>
            <div className="text-xs font-semibold">{check.key.replaceAll("_", " ")}</div>
            <select aria-label={`${check.key} result`} className={fieldClass} onChange={(event) => updateCheck(check.key, { result: event.target.value as CharacterQaCheckInput["result"] })} value={check.result}><option value="failed">Failed</option><option value="passed">Passed</option></select>
            <input aria-label={`${check.key} evidence reference`} className={fieldClass} onChange={(event) => updateCheck(check.key, { evidenceRef: event.target.value })} placeholder="Evidence URL or durable reference" value={check.evidenceRef} />
            <textarea aria-label={`${check.key} comment`} className={`${textAreaClass} sm:col-span-3`} onChange={(event) => updateCheck(check.key, { comment: event.target.value })} value={check.comment} />
          </fieldset>)}
        </div>
        <label className="mt-4 block text-xs font-semibold text-[var(--ad-text-muted)]">QA reason<input className={`${fieldClass} mt-1`} onChange={(event) => setReason(event.target.value)} value={reason} /></label>
        {qaError ? <p className="mt-3 text-sm text-[var(--ad-red-text)]" role="alert">{qaError}</p> : null}
        <div className="mt-4"><WorkspaceButton disabled={!permissions.reviewRelease || busy || checks.some((check) => !check.evidenceRef.trim() || check.comment.trim().length < 3)} onClick={() => void recordQa()} tone="primary">Record immutable QA Run</WorkspaceButton></div>
        <div className="mt-5 grid gap-2">
          {data.qaRuns.map((run) => <article className="rounded-lg bg-black/[0.04] p-3 text-xs" key={run.id}><div className="flex flex-wrap items-center gap-2"><StatusBadge value={run.status} /><strong>{run.id}</strong><span className="text-[var(--ad-text-muted)]">owner {run.ownerId} · ContentVersion {run.characterContentVersionId}</span></div><p className="mt-2 break-all text-[var(--ad-text-muted)]">Evidence hash {run.evidenceHash}</p></article>)}
        </div>
      </section>
    </div>
  );
}

function ReleasePanel({ data, permissions, reload }: { data: CharacterWorkspaceDetail; permissions: Permissions; reload: () => Promise<void> }) {
  const candidate = data.releases.find(({ release }) => !["published", "superseded", "withdrawn"].includes(release.status));
  const current = data.releases.find(({ release }) => release.id === data.serving?.currentReleaseId);
  const rollbackSources = data.releases.filter(({ release }) =>
    release.id !== current?.release.id && release.status === "superseded",
  );
  const [reason, setReason] = useState("Operator verified release evidence");
  const [selectedQaRunId, setSelectedQaRunId] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [selectedRollbackSourceId, setSelectedRollbackSourceId] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const command = async (kind: "publish" | "schedule" | "rollback", releaseId: string, version: number) => {
    const expectedConfirmation = `${data.character.id}:${releaseId}:${kind}`;
    if (confirmation.trim() !== expectedConfirmation) {
      setError(`Type ${expectedConfirmation} to confirm this high-risk action.`);
      return;
    }
    setBusy(kind);
    setError(null);
    try {
      await adminV2Request(`/api/v2/admin/characters/${data.character.id}/releases/${releaseId}/commands/${kind}`, {
        method: "POST",
        idempotencyKey: crypto.randomUUID(),
        body: {
          entityVersion: version,
          reason: { code: `operator_${kind}`, summary: reason },
          confirmation: confirmation.trim(),
          ...(kind === "schedule" ? { scheduledAt: new Date(scheduledAt).toISOString() } : {}),
        },
      });
      setConfirmation("");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not ${kind} release`);
    } finally {
      setBusy(null);
    }
  };
  const rollbackSourceId = rollbackSources.some(({ release }) => release.id === selectedRollbackSourceId)
    ? selectedRollbackSourceId
    : rollbackSources[0]?.release.id ?? "";
  const rollbackSource = rollbackSources.find(({ release }) => release.id === rollbackSourceId);
  const eligibleQaRuns = data.qaRuns.filter((run) => run.status === "passed");
  const qaRunId = eligibleQaRuns.some((run) => run.id === selectedQaRunId)
    ? selectedQaRunId
    : eligibleQaRuns[0]?.id ?? "";
  const propose = async () => {
    setBusy("propose");
    setError(null);
    try {
      await adminV2Request(`/api/v2/admin/characters/${data.character.id}/releases`, {
        method: "POST",
        body: {
          entityVersion: data.project.version,
          qaRunId,
          reason,
          confirmation: confirmation.trim(),
        },
      });
      setConfirmation("");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not propose Release");
    } finally {
      setBusy(null);
    }
  };
  const review = async (decision: "approved" | "changes_requested") => {
    if (!candidate) return;
    setBusy(decision);
    setError(null);
    try {
      await adminV2Request(`/api/v2/admin/characters/${data.character.id}/releases/${candidate.release.id}/review`, {
        method: "POST",
        body: {
          entityVersion: candidate.release.version,
          decision,
          reason,
          confirmation: confirmation.trim(),
        },
      });
      setConfirmation("");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not review Release");
    } finally {
      setBusy(null);
    }
  };
  const validate = async () => {
    if (!candidate) return;
    setBusy("validate");
    setError(null);
    try {
      await adminV2Request(`/api/v2/admin/characters/${data.character.id}/releases/${candidate.release.id}/validation`, {
        method: "POST",
        body: {
          entityVersion: candidate.release.version,
          confirmation: confirmation.trim(),
        },
      });
      setConfirmation("");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not validate Release");
    } finally {
      setBusy(null);
    }
  };
  const servingCommand = async (action: "pause" | "resume" | "retire") => {
    if (!data.serving) return;
    setBusy(action); setError(null);
    try {
      await adminV2Request(`/api/v2/admin/characters/${data.character.id}/commands/${action}`, {
        method: "POST",
        idempotencyKey: crypto.randomUUID(),
        body: { entityVersion: data.serving.version, reason: { code: `operator_${action}`, summary: reason }, confirmation: confirmation.trim() },
      });
      setConfirmation(""); await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : `Could not ${action} Character`); }
    finally { setBusy(null); }
  };
  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_340px]">
      <div className="space-y-3">
        {data.releases.length === 0
          ? <EmptyWorkspace filtered={false} onClear={() => undefined} />
          : data.releases.map(({ release, checks }) => (
            <article className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4" key={release.id}>
              <div className="flex flex-wrap items-center gap-2">
                <strong className="font-mono text-xs">{release.id}</strong>
                <StatusBadge value={release.status} />
                <StatusBadge value={release.readiness} />
                {release.id === data.serving?.currentReleaseId ? <StatusBadge tone="good" value="serving now" /> : null}
              </div>
              <p className="mt-3 text-xs text-[var(--ad-text-muted)]">
                Snapshot {release.snapshotHash.slice(0, 16)} · release v{release.version} · content {release.characterContentVersionId}
              </p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {checks.map((check) => (
                  <div className="flex items-center justify-between rounded bg-black/[0.03] px-3 py-2 text-xs" key={check.checkKey}>
                    <span>{check.checkKey}</span>
                    <StatusBadge value={check.result} />
                  </div>
                ))}
              </div>
            </article>
          ))}
      </div>
      <aside className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
        <h3 className="font-semibold">Release action</h3>
        <label className="mt-4 block text-xs font-semibold text-[var(--ad-text-muted)]">
          Reason
          <textarea className={`${textAreaClass} mt-1`} onChange={(event) => setReason(event.target.value)} value={reason} />
        </label>
        <label className="mt-4 block text-xs font-semibold text-[var(--ad-text-muted)]">
          Schedule at
          <input className={`${fieldClass} mt-1`} onChange={(event) => setScheduledAt(event.target.value)} type="datetime-local" value={scheduledAt} />
        </label>
        {!candidate ? (
          <label className="mt-4 block text-xs font-semibold text-[var(--ad-text-muted)]">
            Passed QA Run
            <select className={`${fieldClass} mt-1`} onChange={(event) => setSelectedQaRunId(event.target.value)} value={qaRunId}>
              <option value="">No passed QA Run</option>
              {eligibleQaRuns.map((run) => <option key={run.id} value={run.id}>{run.id} · {run.characterContentVersionId}</option>)}
            </select>
          </label>
        ) : null}
        <label className="mt-4 block text-xs font-semibold text-[var(--ad-text-muted)]">
          Historical rollback source
          <select className={`${fieldClass} mt-1`} onChange={(event) => setSelectedRollbackSourceId(event.target.value)} value={rollbackSourceId}>
            <option value="">No superseded release available</option>
            {rollbackSources.map(({ release }) => <option key={release.id} value={release.id}>{release.id}</option>)}
          </select>
        </label>
        <label className="mt-4 block text-xs font-semibold text-[var(--ad-text-muted)]">
          Exact confirmation
          <input className={`${fieldClass} mt-1`} onChange={(event) => setConfirmation(event.target.value)} value={confirmation} />
        </label>
        <p className="mt-2 text-xs text-[var(--ad-text-muted)]">
          Use the exact target, for example {candidate ? `${data.character.id}:${candidate.release.id}:${candidate.release.status === "in_review" ? "approved" : "publish"}` : `${data.character.id}:propose-release`}.
        </p>
        {error ? <p className="mt-3 text-xs text-[var(--ad-red-text)]" role="alert">{error}</p> : null}
        <div className="mt-4 grid gap-2">
          {!candidate ? <WorkspaceButton disabled={!permissions.proposeRelease || !qaRunId || confirmation !== `${data.character.id}:propose-release` || Boolean(busy)} onClick={() => void propose()}><Rocket className="h-4 w-4" /> Propose immutable Release</WorkspaceButton> : null}
          {candidate?.release.status === "in_review" ? <><WorkspaceButton disabled={!permissions.reviewRelease || confirmation !== `${data.character.id}:${candidate.release.id}:approved` || Boolean(busy)} onClick={() => void review("approved")} tone="primary">Approve candidate</WorkspaceButton><WorkspaceButton disabled={!permissions.reviewRelease || confirmation !== `${data.character.id}:${candidate.release.id}:changes_requested` || Boolean(busy)} onClick={() => void review("changes_requested")}>Request changes</WorkspaceButton></> : null}
          <WorkspaceButton disabled={!permissions.publishRelease || !candidate || candidate.release.status !== "approved" || confirmation !== `${data.character.id}:${candidate.release.id}:validate` || Boolean(busy)} onClick={() => void validate()}>
            Validate pinned snapshot
          </WorkspaceButton>
          <WorkspaceButton disabled={!permissions.publishRelease || !candidate || candidate.release.status !== "approved" || candidate.release.readiness !== "ready" || Boolean(busy)} onClick={() => candidate && void command("publish", candidate.release.id, candidate.release.version)} tone="primary">
            <Rocket className="h-4 w-4" /> Publish candidate
          </WorkspaceButton>
          <WorkspaceButton disabled={!permissions.publishRelease || !candidate || candidate.release.status !== "approved" || candidate.release.readiness !== "ready" || !scheduledAt || Boolean(busy)} onClick={() => candidate && void command("schedule", candidate.release.id, candidate.release.version)}>
            <Clock3 className="h-4 w-4" /> Schedule
          </WorkspaceButton>
          <WorkspaceButton disabled={!permissions.publishRelease || !rollbackSource || Boolean(busy)} onClick={() => rollbackSource && void command("rollback", rollbackSource.release.id, data.serving?.version ?? 0)} tone="danger">
            <RotateCcw className="h-4 w-4" /> Roll back to selected snapshot
          </WorkspaceButton>
          {data.serving?.state === "live" ? <><WorkspaceButton disabled={!permissions.publishRelease || confirmation !== `${data.character.id}:pause` || Boolean(busy)} onClick={() => void servingCommand("pause")}>Pause serving</WorkspaceButton><WorkspaceButton disabled={!permissions.publishRelease || confirmation !== `${data.character.id}:retire` || Boolean(busy)} onClick={() => void servingCommand("retire")} tone="danger">Retire Character</WorkspaceButton></> : null}
          {data.serving?.state === "paused" ? <WorkspaceButton disabled={!permissions.publishRelease || confirmation !== `${data.character.id}:resume` || Boolean(busy)} onClick={() => void servingCommand("resume")}>Resume serving</WorkspaceButton> : null}
        </div>
        {!permissions.publishRelease ? <p className="mt-3 text-xs text-[var(--ad-text-muted)]">Read-only: character.release.publish is not granted.</p> : null}
      </aside>
    </div>
  );
}

function MonitorPanel({ data, permissions, reload }: { data: CharacterWorkspaceDetail; permissions: Permissions; reload: () => Promise<void> }) {
  const current = data.releases.find(({ release }) => release.id === data.serving?.currentReleaseId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = async (window: "24h" | "72h") => {
    if (!current) return; setBusy(true); setError(null);
    try { await adminV2Request(`/api/v2/admin/characters/${data.character.id}/releases/${current.release.id}/monitors/${window}/refresh`, { method: "POST", body: { entityVersion: current.release.version } }); await reload(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Monitor refresh failed"); }
    finally { setBusy(false); }
  };
  if (!current) return <EmptyWorkspace filtered={false} onClear={() => undefined} />;
  return <div><div className="mb-4 flex flex-wrap gap-2"><WorkspaceButton disabled={busy || !permissions.reviewRelease} onClick={() => void refresh("24h")}><RefreshCcw className="h-4 w-4" /> Refresh 24h</WorkspaceButton><WorkspaceButton disabled={busy || !permissions.reviewRelease} onClick={() => void refresh("72h")}><RefreshCcw className="h-4 w-4" /> Refresh 72h</WorkspaceButton></div>{!permissions.reviewRelease ? <p className="mb-4 text-xs text-[var(--ad-text-muted)]">Read-only: character.release.review is not granted.</p> : null}{error ? <p className="mb-4 text-sm text-[var(--ad-red-text)]" role="alert">{error}</p> : null}<div className="grid gap-4 lg:grid-cols-2">{(["24h", "72h"] as const).map((window) => { const monitor = current.monitors.find((item) => item.window === window); return <article className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4" key={window}><div className="flex items-center justify-between"><h3 className="font-semibold">{window} guardrail</h3><StatusBadge value={monitor?.status ?? "pending"} /></div>{monitor ? <><dl className="mt-4 grid grid-cols-2 gap-3 text-xs">{Object.entries(monitor.observed).map(([key, value]) => <div key={key}><dt className="text-[var(--ad-text-muted)]">{key}</dt><dd className="mt-1 font-semibold">{String(value ?? "Unavailable")}</dd></div>)}</dl><p className="mt-4 text-xs text-[var(--ad-text-muted)]">Recommendation: {String(monitor.verification.recommendation ?? "continue_monitoring")}</p></> : <p className="mt-4 text-sm text-[var(--ad-text-muted)]">No observation yet. Refresh once the release is published.</p>}</article>; })}</div></div>;
}

function PerformancePanel({ data, permissions, reload }: { data: CharacterWorkspaceDetail; permissions: Permissions; reload: () => Promise<void> }) {
  const releaseId = data.serving?.currentReleaseId ?? data.releases[0]?.release.id ?? "";
  const [decision, setDecision] = useState<"Promote" | "Maintain" | "Improve" | "Pause" | "Retire">("Maintain");
  const [question, setQuestion] = useState("What should we do with this Character based on current release evidence?");
  const [evidenceRefs, setEvidenceRefs] = useState("");
  const [evidenceLevel, setEvidenceLevel] = useState<"observational" | "attribution" | "causal">("observational");
  const [confidence, setConfidence] = useState("");
  const [successCriteria, setSuccessCriteria] = useState("Review the selected action at the next portfolio window");
  const [guardrails, setGuardrails] = useState("Do not regress qualified conversation or Same-character D7");
  const [reviewAt, setReviewAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recordDecision = async () => {
    setBusy(true); setError(null);
    try {
      await adminV2Request(`/api/v2/admin/characters/${data.character.id}/portfolio-decisions`, {
        method: "POST",
        body: {
          releaseId,
          decision,
          question,
          evidenceRefs: evidenceRefs.split(",").map((value) => value.trim()).filter(Boolean),
          evidenceLevel,
          confidence: confidence ? Number(confidence) : null,
          successCriteria: successCriteria.split("\n").map((value) => value.trim()).filter(Boolean),
          guardrails: guardrails.split("\n").map((value) => value.trim()).filter(Boolean),
          reviewAt: reviewAt ? new Date(reviewAt).toISOString() : null,
        },
      });
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not record portfolio decision");
    } finally {
      setBusy(false);
    }
  };
  const latest = data.portfolio.latestDecision;
  return <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
    <div>
      <div className="grid gap-4 lg:grid-cols-2">{data.performance.length === 0 ? <EmptyWorkspace filtered={false} onClear={() => undefined} /> : data.performance.map((metric) => <article className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4" key={`${metric.window}-${metric.placementId ?? "all"}`}><div className="flex items-center justify-between"><h3 className="font-semibold">{metric.window} · {metric.placementId ?? "all placements"}</h3><StatusBadge value={metric.maturity} /></div><dl className="mt-4 grid grid-cols-2 gap-4 text-sm"><div><dt className="text-xs text-[var(--ad-text-muted)]">QCE</dt><dd className="mt-1 font-semibold">{percent(metric.qceRate)}</dd></div><div><dt className="text-xs text-[var(--ad-text-muted)]">Same-character D7</dt><dd className="mt-1 font-semibold">{percent(metric.sameCharacterD7)}</dd></div><div><dt className="text-xs text-[var(--ad-text-muted)]">Sample</dt><dd className="mt-1 font-semibold">{metric.sampleSize}</dd></div><div><dt className="text-xs text-[var(--ad-text-muted)]">Margin</dt><dd className="mt-1 font-semibold">{metric.contributionMargin.valueMicros === null ? "Unavailable" : metric.contributionMargin.valueMicros.toLocaleString()}</dd></div></dl><p className="mt-4 text-xs text-[var(--ad-text-muted)]">{metric.qualityState} · {metric.coverageState} · release {metric.characterReleaseId}</p></article>)}</div>
      <section className="mt-5 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4" aria-labelledby="latest-portfolio-decision-title"><h3 className="font-semibold" id="latest-portfolio-decision-title">Latest Decision Record</h3>{latest ? <div className="mt-3 text-sm"><div className="flex flex-wrap gap-2"><StatusBadge value={latest.decision} /><StatusBadge value={latest.evidenceLevel} /></div><p className="mt-3">{latest.question}</p><p className="mt-2 text-xs text-[var(--ad-text-muted)]">Owner {latest.ownerId} · review {latest.reviewAt ?? "not scheduled"} · confidence {latest.confidence ?? "unavailable"}</p></div> : <p className="mt-3 text-sm text-[var(--ad-text-muted)]">No portfolio decision has been recorded.</p>}</section>
    </div>
    <aside className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <h3 className="font-semibold">Record portfolio decision</h3>
      <label className="mt-4 block text-xs font-semibold text-[var(--ad-text-muted)]">Action<select className={`${fieldClass} mt-1`} onChange={(event) => setDecision(event.target.value as typeof decision)} value={decision}>{["Promote", "Maintain", "Improve", "Pause", "Retire"].map((value) => <option key={value}>{value}</option>)}</select></label>
      <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">Decision question<textarea className={`${textAreaClass} mt-1`} onChange={(event) => setQuestion(event.target.value)} value={question} /></label>
      <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">Evidence references<input className={`${fieldClass} mt-1`} onChange={(event) => setEvidenceRefs(event.target.value)} placeholder="metric:, release:, qa: (comma separated)" value={evidenceRefs} /></label>
      <div className="mt-3 grid grid-cols-2 gap-2"><label className="text-xs font-semibold text-[var(--ad-text-muted)]">Evidence level<select className={`${fieldClass} mt-1`} onChange={(event) => setEvidenceLevel(event.target.value as typeof evidenceLevel)} value={evidenceLevel}><option value="observational">Observational</option><option value="attribution">Attribution</option><option value="causal">Causal</option></select></label><label className="text-xs font-semibold text-[var(--ad-text-muted)]">Confidence<input className={`${fieldClass} mt-1`} max="1" min="0" onChange={(event) => setConfidence(event.target.value)} step="0.01" type="number" value={confidence} /></label></div>
      <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">Success criteria<textarea className={`${textAreaClass} mt-1`} onChange={(event) => setSuccessCriteria(event.target.value)} value={successCriteria} /></label>
      <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">Guardrails<textarea className={`${textAreaClass} mt-1`} onChange={(event) => setGuardrails(event.target.value)} value={guardrails} /></label>
      <label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">Review at<input className={`${fieldClass} mt-1`} onChange={(event) => setReviewAt(event.target.value)} type="datetime-local" value={reviewAt} /></label>
      {error ? <p className="mt-3 text-xs text-[var(--ad-red-text)]" role="alert">{error}</p> : null}
      <div className="mt-4"><WorkspaceButton disabled={!permissions.writeProject || busy || !releaseId || question.trim().length < 3 || !evidenceRefs.trim() || !successCriteria.trim()} onClick={() => void recordDecision()} tone="primary">Record Decision</WorkspaceButton></div>
    </aside>
  </div>;
}

function CharacterDetail({ id, permissions }: { id: string; permissions: Permissions }) {
  const [data, setData] = useState<CharacterWorkspaceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(() => {
    if (typeof window === "undefined") return "project";
    const requested = new URLSearchParams(window.location.search).get("tab");
    return tabs.includes(requested as Tab) ? requested as Tab : "project";
  });
  const load = useCallback(async () => { setLoading(true); setError(null); try { setData(await adminV2Request(`/api/v2/admin/characters/${id}`, { schema: characterWorkspaceDetailSchema })); } catch (cause) { setError(cause instanceof Error ? cause.message : "Character workspace could not be loaded"); } finally { setLoading(false); } }, [id]);
  useEffect(() => {
    if (!permissions.read) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load, permissions.read]);
  if (!permissions.read) return permissionDenied("character.project.read");
  if (loading) return <LoadingWorkspace label="Loading Character Project, Release and Monitor evidence" />;
  if (!data) return <section className="rounded-xl bg-[var(--ad-red-bg)] p-5" role="alert">{error ?? "Character not found"} <button className="ml-2 underline" onClick={() => void load()} type="button">Retry</button></section>;
  const selectTab = (next: Tab) => {
    setTab(next);
    setWorkspaceUrl(new URLSearchParams({ tab: next }));
  };
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, current: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    const next = tabs[nextIndex];
    selectTab(next);
    document.getElementById(`character-tab-${next}`)?.focus();
  };
  const workspaceName = data.preview.draft?.name ?? data.preview.live?.name ?? data.character.name;
  return <section aria-labelledby="character-workspace-title"><Link className="inline-flex min-h-11 items-center gap-2 text-sm text-[var(--ad-text-muted)] hover:text-[var(--ad-ink)]" href="/admin/characters"><ArrowLeft className="h-4 w-4" /> Portfolio</Link><div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-xs uppercase tracking-[0.16em] text-[var(--ad-text-muted)]">Character Project · {data.project.id}</p><h2 className="mt-1 text-2xl font-semibold" id="character-workspace-title">{workspaceName}</h2><div className="mt-2 flex flex-wrap gap-2"><StatusBadge value={data.project.phase} /><StatusBadge value={data.serving?.state ?? "inactive"} /><StatusBadge value={data.character.visibility} /></div></div><p className="text-xs text-[var(--ad-text-muted)]">Project v{data.project.version} · Serving v{data.serving?.version ?? 0}</p></div>{error ? <p className="mt-4" role="alert">{error}</p> : null}<div className="mt-6 flex gap-1 overflow-x-auto border-b border-[var(--ad-border)]" role="tablist" aria-label="Character workspace">{tabs.map((item, index) => <button aria-controls={`character-panel-${item}`} aria-selected={tab === item} className={cn("min-h-11 shrink-0 border-b-2 px-3 text-sm capitalize focus-visible:outline focus-visible:outline-2", tab === item ? "border-[var(--ad-ink)] font-semibold text-[var(--ad-ink)]" : "border-transparent text-[var(--ad-text-muted)]")} id={`character-tab-${item}`} key={item} onClick={() => { setTab(item); const query = new URLSearchParams({ tab: item }); setWorkspaceUrl(query); }} onKeyDown={(event) => onTabKey(event, index)} role="tab" tabIndex={tab === item ? 0 : -1} type="button">{item}</button>)}</div><div className="mt-5" id={`character-panel-${tab}`} role="tabpanel" aria-labelledby={`character-tab-${tab}`}>{tab === "project" ? <ProjectEditor data={data} key={data.project.version} onReload={load} permissions={permissions} /> : tab === "preview" ? <PreviewDiff data={data} permissions={permissions} reload={load} /> : tab === "release" ? <ReleasePanel data={data} permissions={permissions} reload={load} /> : tab === "monitor" ? <MonitorPanel data={data} permissions={permissions} reload={load} /> : <PerformancePanel data={data} permissions={permissions} reload={load} />}</div></section>;
}

export function CharacterWorkspace({ view, permissions }: { view: AdminSubview; permissions: Permissions }) {
  if (view.kind === "new") return <CharacterCreateWizard canCreate={permissions.writeProject} />;
  return view.kind === "detail" ? <CharacterDetail id={view.id} permissions={permissions} /> : <CharacterPortfolio permissions={permissions} />;
}
