"use client";

import { useEffect, useState } from "react";
import { Loader2, Play, RefreshCcw, Square } from "lucide-react";
import type { ExperimentAnalysisResponse, ExperimentDefinition } from "@idream/shared/admin";
import { apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";

type ManagedExperiment = ExperimentDefinition;
type Analysis = ExperimentAnalysisResponse;
type FlagRow = { key: string; enabled: boolean; rolloutPercent: number };

function idempotencyKey() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

export function ExperimentsView() {
  const { t } = useAdminI18n();
  const [experiments, setExperiments] = useState<ManagedExperiment[]>([]);
  const [flags, setFlags] = useState<FlagRow[]>([]);
  const [analysis, setAnalysis] = useState<Record<string, Analysis>>({});
  const [key, setKey] = useState("community.character-ranking.v1");
  const [hypothesis, setHypothesis] = useState("Relationship-first Community ranking increases qualified conversations");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [monitoringNote, setMonitoringNote] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const managed = await apiGet<{ items: ManagedExperiment[] }>("/api/v2/admin/experiments?limit=100");
      setExperiments(managed.items);
      try {
        const monitoring = await apiGet<{ items: FlagRow[] }>("/api/v1/admin/experiments");
        setFlags(monitoring.items);
        setMonitoringNote(null);
      } catch {
        setFlags([]);
        setMonitoringNote("Flag monitoring is unavailable for this permission set; managed experiments remain authoritative.");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, []);

  async function createDraft(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("create"); setError(null);
    try {
      const isCommunityRanking = key === "community.character-ranking.v1";
      await apiWrite("/api/v2/admin/experiments", "POST", {
        key,
        hypothesis,
        eligibility: isCommunityRanking ? { surface: "community.leaderboard" } : {},
        variants: isCommunityRanking
          ? [{ key: "control", allocationBps: 5_000 }, { key: "relationship_first", allocationBps: 5_000 }]
          : [{ key: "control", allocationBps: 5_000 }, { key: "treatment", allocationBps: 5_000 }],
        salt: `${idempotencyKey()}-${idempotencyKey()}`,
        metrics: { primary: "relationship.qce_activation.v1", controlVariant: "control", minimumMaturePerArm: 100, guardrails: [{ metricKey: "guardrail.support_contact_rate.v1", maxAbsoluteRegression: 0.02 }] },
      }, { "idempotency-key": idempotencyKey() });
      setKey("community.character-ranking.v1");
      setHypothesis("Relationship-first Community ranking increases qualified conversations");
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Create failed"); }
    finally { setBusy(null); }
  }

  async function transition(row: ManagedExperiment, command: "start" | "stop") {
    setBusy(row.id); setError(null);
    try {
      await apiWrite(`/api/v2/admin/experiments/${row.id}/commands/${command}`, "POST", { expectedStateVersion: row.stateVersion, reason: `${command} from Admin experiment workspace` }, { "idempotency-key": idempotencyKey() });
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : `${command} failed`); }
    finally { setBusy(null); }
  }

  async function loadAnalysis(id: string) {
    setBusy(`analysis-${id}`); setError(null);
    try {
      const result = await apiGet<Analysis>(`/api/v2/admin/experiments/${id}/analysis`);
      setAnalysis((current) => ({ ...current, [id]: result }));
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Analysis failed"); }
    finally { setBusy(null); }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div><h2 className="text-base font-semibold">{t("Managed experiment workspace")}</h2><p className="text-xs text-[var(--ad-text-muted)]">{t("Immutable definitions · stable assignment · observed exposure · fail-closed decisions")}</p></div>
        <button className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-[var(--ad-border)] px-3 text-sm disabled:opacity-50" disabled={loading} onClick={() => void load()} type="button">{loading ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <RefreshCcw aria-hidden className="h-4 w-4" />}{t("Refresh")}</button>
      </header>
      {error ? <p className="rounded-md bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]" role="alert" tabIndex={-1}>{error}</p> : null}

      <form className="grid gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 md:grid-cols-[1fr_2fr_auto]" onSubmit={(event) => void createDraft(event)}>
        <label className="grid gap-1 text-xs"><span>{t("Experiment key")}</span><input className="min-h-11 rounded-md border border-[var(--ad-border)] bg-transparent px-3" onChange={(event) => setKey(event.target.value)} pattern="[a-z0-9][a-z0-9._\-]*" required value={key} /></label>
        <label className="grid gap-1 text-xs"><span>{t("Hypothesis")}</span><input className="min-h-11 rounded-md border border-[var(--ad-border)] bg-transparent px-3" minLength={10} onChange={(event) => setHypothesis(event.target.value)} required value={hypothesis} /></label>
        <button className="min-h-11 self-end rounded-md bg-[var(--ad-accent)] px-4 text-sm text-white disabled:opacity-50" disabled={busy === "create"} type="submit">{busy === "create" ? t("Creating…") : t("Create draft")}</button>
      </form>

      <section aria-labelledby="managed-experiments-heading" className="space-y-3">
        <h3 className="text-sm font-semibold" id="managed-experiments-heading">{t("Experiment definitions")} ({experiments.length})</h3>
        {!loading && experiments.length === 0 ? <p className="rounded-lg border border-dashed border-[var(--ad-border)] p-6 text-sm text-[var(--ad-text-muted)]">{t("No managed experiments yet. Create an immutable draft to begin.")}</p> : null}
        <div className="grid gap-3">
          {experiments.map((row) => {
            const result = analysis[row.id];
            return <article className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4" key={row.id}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><h4 className="font-mono text-sm">{row.key} · v{row.version}</h4><p className="mt-1 text-sm">{row.hypothesis}</p><p className="mt-1 text-xs text-[var(--ad-text-muted)]">{row.status} · state v{row.stateVersion}</p></div><div className="flex flex-wrap gap-2">
                {row.status === "draft" ? <button className="inline-flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm" disabled={busy === row.id} onClick={() => void transition(row, "start")} type="button"><Play aria-hidden className="h-4 w-4" />{t("Start")}</button> : null}
                {row.status === "running" ? <button className="inline-flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm" disabled={busy === row.id} onClick={() => void transition(row, "stop")} type="button"><Square aria-hidden className="h-4 w-4" />{t("Stop")}</button> : null}
                <button className="min-h-11 rounded-md border px-3 text-sm" disabled={busy === `analysis-${row.id}`} onClick={() => void loadAnalysis(row.id)} type="button">{t("Quality & lift")}</button>
              </div></div>
              {result ? <div className="mt-4 rounded-md bg-[var(--ad-surface-muted)] p-3 text-xs" role="status"><p>Quality: {result.qualityState} · maturity: {result.maturity} · guardrails: {result.guardrailState} · significance: {result.significance}</p><ul className="mt-2 space-y-1">{result.guardrails.map((guardrail) => <li key={guardrail.metricKey}>{guardrail.metricKey}: {guardrail.state} · regression {guardrail.observedRegression === null ? "—" : `${(guardrail.observedRegression * 100).toFixed(1)}pp`} / max {(guardrail.maxAbsoluteRegression * 100).toFixed(1)}pp</li>)}</ul>{result.decisionUse === "eligible" ? <ul className="mt-2 space-y-1">{result.arms.map((arm) => <li key={arm.variant}>{arm.variant}: n={arm.matureSubjects}, rate={arm.rate === null ? "—" : `${(arm.rate * 100).toFixed(1)}%`}, lift={arm.absoluteLiftVsControl === null ? "—" : `${(arm.absoluteLiftVsControl * 100).toFixed(1)}pp`}, p={arm.pValueVsControl?.toFixed(4) ?? "—"}</li>)}</ul> : <p className="mt-2 text-[var(--ad-yellow-text)]">Lift hidden from decision use until every arm has ≥{result.minimumMaturePerArm} mature production exposures and guardrails pass.</p>}</div> : null}
            </article>;
          })}
        </div>
      </section>

      <section aria-labelledby="flag-monitoring-heading" className="rounded-lg border border-[var(--ad-yellow-text)]/25 bg-[var(--ad-yellow-bg)] p-4">
        <h3 className="text-sm font-semibold" id="flag-monitoring-heading">{t("Flag Monitoring")} ({flags.length})</h3><p className="mt-1 text-xs">{t("Directional only · no assignment or exposure records")}</p><p className="mt-2 text-xs">{t("Feature flags remain rollout monitoring and never inherit managed experiment lift.")}</p>{monitoringNote ? <p className="mt-2 text-xs" role="status">{t(monitoringNote)}</p> : null}
        <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{flags.map((flag) => <li className="rounded-md border border-current/20 p-3 text-xs" key={flag.key}><span className="font-mono">{flag.key}</span><br />{flag.enabled ? t("enabled") : t("disabled")} · {flag.rolloutPercent}%</li>)}</ul>
      </section>
    </div>
  );
}
