"use client";

import Link from "next/link";
import {
  characterPortfolioResponseSchema,
  characterWorkspaceDetailSchema,
  type CharacterPortfolioItem,
  type CharacterWorkspaceDetail,
} from "@idream/shared/admin";
import { ArrowLeft, Clock3, RefreshCcw, Rocket, RotateCcw, Save, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { AdminSubview } from "@/components/admin/nav-config";
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
  publishRelease: boolean;
  reviewRelease: boolean;
};

type ProjectDraft = Pick<CharacterWorkspaceDetail["project"],
  "phase" | "ownerId" | "audience" | "companionNeed" | "hypothesis" | "differentiation" |
  "targetPlacementKeys" | "successCriteria" | "plannedLaunchAt">;

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
  const [search, setSearch] = useState(() => typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("search") ?? "");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!permissions.read) return;
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ limit: "50", sort: "project_id_asc" });
      if (search.trim()) query.set("search", search.trim());
      setWorkspaceUrl(query);
      const data = await adminV2Request(`/api/v2/admin/characters/portfolio?${query}`, { schema: characterPortfolioResponseSchema });
      setItems([...data.items]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Character portfolio could not be loaded");
    } finally {
      setLoading(false);
    }
  }, [permissions.read, search]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), search.trim() ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [load, search]);

  if (!permissions.read) return permissionDenied("character.project.read");
  return (
    <section aria-labelledby="character-portfolio-title">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ad-text-muted)]">Character Studio</p>
          <h1 className="mt-1 text-2xl font-semibold" id="character-portfolio-title">Portfolio & Projects</h1>
          <p className="mt-2 max-w-2xl text-sm text-[var(--ad-text-muted)]">Decide what to promote, improve, pause, or retire from release-attributed evidence.</p>
        </div>
        <label className="text-xs font-semibold text-[var(--ad-text-muted)]">Search authority
          <input aria-label="Search characters" className={`${fieldClass} mt-1 sm:w-72`} onChange={(event) => setSearch(event.target.value)} placeholder="Name, character or project ID" value={search} />
        </label>
      </div>
      {error ? <div className="mt-5 rounded-lg bg-[var(--ad-red-bg)] p-4 text-sm text-[var(--ad-red-text)]" role="alert">{error} <button className="ml-2 underline" onClick={() => void load()} type="button">Retry</button></div> : null}
      <div className="mt-6">
        {loading ? <LoadingWorkspace label="Loading release-attributed portfolio" /> : items.length === 0 ? <EmptyWorkspace filtered={Boolean(search)} onClear={() => setSearch("")} /> : <div className="grid gap-3">{items.map((item) => <PortfolioCard item={item} key={item.characterId} />)}</div>}
      </div>
    </section>
  );
}

function ProjectEditor({ data, permissions, onReload }: { data: CharacterWorkspaceDetail; permissions: Permissions; onReload: () => Promise<void> }) {
  const initial = useMemo<ProjectDraft>(() => ({
    phase: data.project.phase,
    ownerId: data.project.ownerId,
    audience: data.project.audience,
    companionNeed: data.project.companionNeed,
    hypothesis: data.project.hypothesis,
    differentiation: data.project.differentiation,
    targetPlacementKeys: [...data.project.targetPlacementKeys],
    successCriteria: [...data.project.successCriteria],
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
        <label className="text-xs font-semibold text-[var(--ad-text-muted)]">Phase<select className={`${fieldClass} mt-1`} onChange={(event) => set("phase", event.target.value as ProjectDraft["phase"])} value={draft.phase}>{["idea", "planned", "producing", "qa", "launch_ready", "live_management", "retired"].map((phase) => <option key={phase}>{phase}</option>)}</select></label>
        <label className="text-xs font-semibold text-[var(--ad-text-muted)]">Owner ID<input className={`${fieldClass} mt-1`} onChange={(event) => set("ownerId", event.target.value || null)} value={draft.ownerId ?? ""} /></label>
        <label className="text-xs font-semibold text-[var(--ad-text-muted)] sm:col-span-2">Audience<textarea className={`${textAreaClass} mt-1`} onChange={(event) => set("audience", event.target.value)} value={draft.audience} /></label>
        <label className="text-xs font-semibold text-[var(--ad-text-muted)] sm:col-span-2">Companion need<textarea className={`${textAreaClass} mt-1`} onChange={(event) => set("companionNeed", event.target.value)} value={draft.companionNeed} /></label>
        <label className="text-xs font-semibold text-[var(--ad-text-muted)] sm:col-span-2">Hypothesis<textarea className={`${textAreaClass} mt-1`} onChange={(event) => set("hypothesis", event.target.value)} value={draft.hypothesis} /></label>
        <label className="text-xs font-semibold text-[var(--ad-text-muted)] sm:col-span-2">Differentiation<textarea className={`${textAreaClass} mt-1`} onChange={(event) => set("differentiation", event.target.value)} value={draft.differentiation} /></label>
        <label className="text-xs font-semibold text-[var(--ad-text-muted)]">Target placements<input className={`${fieldClass} mt-1`} onChange={(event) => set("targetPlacementKeys", event.target.value.split(",").map((item) => item.trim()).filter(Boolean))} value={draft.targetPlacementKeys.join(", ")} /></label>
        <label className="text-xs font-semibold text-[var(--ad-text-muted)]">Planned launch<input className={`${fieldClass} mt-1`} onChange={(event) => set("plannedLaunchAt", event.target.value ? new Date(event.target.value).toISOString() : null)} type="datetime-local" value={draft.plannedLaunchAt?.slice(0, 16) ?? ""} /></label>
        <label className="text-xs font-semibold text-[var(--ad-text-muted)] sm:col-span-2">Success criteria<textarea className={`${textAreaClass} mt-1`} onChange={(event) => set("successCriteria", event.target.value.split("\n").map((item) => item.trim()).filter(Boolean))} value={draft.successCriteria.join("\n")} /></label>
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

function PreviewDiff({ data }: { data: CharacterWorkspaceDetail }) {
  const snapshots = [data.preview.live, data.preview.draft].filter((item): item is NonNullable<typeof item> => Boolean(item));
  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2" aria-label="Changed fields">{data.preview.changedFields.map((field) => <StatusBadge key={field} tone="warn" value={`${field} changed`} />)}</div>
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
          Use character:release:action, for example {candidate ? `${data.character.id}:${candidate.release.id}:publish` : "when a candidate exists"}.
        </p>
        {error ? <p className="mt-3 text-xs text-[var(--ad-red-text)]" role="alert">{error}</p> : null}
        <div className="mt-4 grid gap-2">
          <WorkspaceButton disabled={!permissions.publishRelease || !candidate || Boolean(busy)} onClick={() => candidate && void command("publish", candidate.release.id, candidate.release.version)} tone="primary">
            <Rocket className="h-4 w-4" /> Publish candidate
          </WorkspaceButton>
          <WorkspaceButton disabled={!permissions.publishRelease || !candidate || !scheduledAt || Boolean(busy)} onClick={() => candidate && void command("schedule", candidate.release.id, candidate.release.version)}>
            <Clock3 className="h-4 w-4" /> Schedule
          </WorkspaceButton>
          <WorkspaceButton disabled={!permissions.publishRelease || !rollbackSource || Boolean(busy)} onClick={() => rollbackSource && void command("rollback", rollbackSource.release.id, data.serving?.version ?? 0)} tone="danger">
            <RotateCcw className="h-4 w-4" /> Roll back to selected snapshot
          </WorkspaceButton>
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

function PerformancePanel({ data }: { data: CharacterWorkspaceDetail }) {
  return <div className="grid gap-4 lg:grid-cols-2">{data.performance.length === 0 ? <EmptyWorkspace filtered={false} onClear={() => undefined} /> : data.performance.map((metric) => <article className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4" key={`${metric.window}-${metric.placementId ?? "all"}`}><div className="flex items-center justify-between"><h3 className="font-semibold">{metric.window} · {metric.placementId ?? "all placements"}</h3><StatusBadge value={metric.maturity} /></div><dl className="mt-4 grid grid-cols-2 gap-4 text-sm"><div><dt className="text-xs text-[var(--ad-text-muted)]">QCE</dt><dd className="mt-1 font-semibold">{percent(metric.qceRate)}</dd></div><div><dt className="text-xs text-[var(--ad-text-muted)]">Same-character D7</dt><dd className="mt-1 font-semibold">{percent(metric.sameCharacterD7)}</dd></div><div><dt className="text-xs text-[var(--ad-text-muted)]">Sample</dt><dd className="mt-1 font-semibold">{metric.sampleSize}</dd></div><div><dt className="text-xs text-[var(--ad-text-muted)]">Margin</dt><dd className="mt-1 font-semibold">{metric.contributionMargin.valueMicros === null ? "Unavailable" : metric.contributionMargin.valueMicros.toLocaleString()}</dd></div></dl><p className="mt-4 text-xs text-[var(--ad-text-muted)]">{metric.qualityState} · {metric.coverageState} · release {metric.characterReleaseId}</p></article>)}</div>;
}

function CharacterDetail({ id, permissions }: { id: string; permissions: Permissions }) {
  const [data, setData] = useState<CharacterWorkspaceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(() => typeof window === "undefined" ? "project" : (new URLSearchParams(window.location.search).get("tab") as Tab) || "project");
  const load = useCallback(async () => { setLoading(true); setError(null); try { setData(await adminV2Request(`/api/v2/admin/characters/${id}`, { schema: characterWorkspaceDetailSchema })); } catch (cause) { setError(cause instanceof Error ? cause.message : "Character workspace could not be loaded"); } finally { setLoading(false); } }, [id]);
  useEffect(() => {
    if (!permissions.read) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load, permissions.read]);
  if (!permissions.read) return permissionDenied("character.project.read");
  if (loading) return <LoadingWorkspace label="Loading Character Project, Release and Monitor evidence" />;
  if (!data) return <section className="rounded-xl bg-[var(--ad-red-bg)] p-5" role="alert">{error ?? "Character not found"} <button className="ml-2 underline" onClick={() => void load()} type="button">Retry</button></section>;
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, current: number) => { if (!event.key.startsWith("Arrow")) return; event.preventDefault(); const next = (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length; setTab(tabs[next]); document.getElementById(`character-tab-${tabs[next]}`)?.focus(); };
  return <section aria-labelledby="character-workspace-title"><Link className="inline-flex min-h-11 items-center gap-2 text-sm text-[var(--ad-text-muted)] hover:text-[var(--ad-ink)]" href="/admin/characters"><ArrowLeft className="h-4 w-4" /> Portfolio</Link><div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-xs uppercase tracking-[0.16em] text-[var(--ad-text-muted)]">Character Project · {data.project.id}</p><h1 className="mt-1 text-2xl font-semibold" id="character-workspace-title">{data.character.name}</h1><div className="mt-2 flex flex-wrap gap-2"><StatusBadge value={data.project.phase} /><StatusBadge value={data.serving?.state ?? "inactive"} /><StatusBadge value={data.character.visibility} /></div></div><p className="text-xs text-[var(--ad-text-muted)]">Project v{data.project.version} · Serving v{data.serving?.version ?? 0}</p></div>{error ? <p className="mt-4" role="alert">{error}</p> : null}<div className="mt-6 flex gap-1 overflow-x-auto border-b border-[var(--ad-border)]" role="tablist" aria-label="Character workspace">{tabs.map((item, index) => <button aria-controls={`character-panel-${item}`} aria-selected={tab === item} className={cn("min-h-11 shrink-0 border-b-2 px-3 text-sm capitalize focus-visible:outline focus-visible:outline-2", tab === item ? "border-[var(--ad-ink)] font-semibold text-[var(--ad-ink)]" : "border-transparent text-[var(--ad-text-muted)]")} id={`character-tab-${item}`} key={item} onClick={() => { setTab(item); const query = new URLSearchParams({ tab: item }); setWorkspaceUrl(query); }} onKeyDown={(event) => onTabKey(event, index)} role="tab" tabIndex={tab === item ? 0 : -1} type="button">{item}</button>)}</div><div className="mt-5" id={`character-panel-${tab}`} role="tabpanel" aria-labelledby={`character-tab-${tab}`}>{tab === "project" ? <ProjectEditor data={data} key={data.project.version} onReload={load} permissions={permissions} /> : tab === "preview" ? <PreviewDiff data={data} /> : tab === "release" ? <ReleasePanel data={data} permissions={permissions} reload={load} /> : tab === "monitor" ? <MonitorPanel data={data} permissions={permissions} reload={load} /> : <PerformancePanel data={data} />}</div></section>;
}

export function CharacterWorkspace({ view, permissions }: { view: AdminSubview; permissions: Permissions }) {
  return view.kind === "detail" ? <CharacterDetail id={view.id} permissions={permissions} /> : <CharacterPortfolio permissions={permissions} />;
}
