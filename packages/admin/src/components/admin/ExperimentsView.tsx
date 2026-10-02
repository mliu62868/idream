"use client";

// SPEC: 受管实验工作台 —— 建草稿 / 启停 / 拉质量与提升度报告，外加只读的 flag 监控。
// INTENT: 启停是线上状态变更，必须先确认、且理由由运营手写。审计里留一条机器编的
//         "start from Admin experiment workspace" 等于没有理由——事后没人知道为什么停的。
// INVARIANT: 启停走 ConfirmDialog（reason ≥3 + 打对实验 key）；expectedStateVersion 取自当前行，
//            并发改动由后端 409 拦下。

import { useEffect, useRef, useState } from "react";
import { Loader2, Play, RefreshCcw, Square } from "lucide-react";
import type { ExperimentAnalysisResponse, ExperimentDefinition } from "@idream/shared/admin";
import { apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { StatusPill } from "@/components/admin/ui/StatusPill";
import { WriteFeedbackBanner, listPageFromParams, previousListPage, requestErrorMessage, syncListUrl, useWriteFeedback } from "@/components/admin/section-kit";
import { FilterBar } from "@/components/admin/ui/FilterBar";
import { emptyPageInfo, Pagination, type PageInfo } from "@/components/admin/ui/Pagination";
import { useUrlFilters } from "@/components/admin/ui/useUrlFilters";
import { createLatestRequestGate } from "@/lib/latest-request";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";

type ManagedExperiment = ExperimentDefinition;
type Analysis = ExperimentAnalysisResponse;
type FlagRow = { key: string; enabled: boolean; rolloutPercent: number };
type LifecycleCommand = "start" | "stop";
type ExperimentQuery = { search: string; status: string; cursor: string; limit: number };
const defaultQuery: ExperimentQuery = { search: "", status: "", cursor: "", limit: 25 };
const pageSizes = [10, 25, 50, 100] as const;
const statuses = ["draft", "running", "stopped"] as const;
const communityRankingKey = "community.character-ranking.v1";
const listKeys = { cursor: "experimentCursor", page: "experimentPage", limit: "experimentLimit" };

function queryFromUrl(params: URLSearchParams): ExperimentQuery {
  const limit = Number(params.get("experimentLimit"));
  const status = params.get("experimentStatus") ?? "";
  return {
    search: params.get("experimentSearch") ?? "",
    status: statuses.some(value => value === status) ? status : "",
    cursor: params.get("experimentCursor") ?? "",
    limit: pageSizes.some(value => value === limit) ? limit : defaultQuery.limit,
  };
}

function listPath(query: ExperimentQuery) {
  const params = new URLSearchParams({ limit: String(query.limit) });
  for (const key of ["search", "status", "cursor"] as const) if (query[key]) params.set(key, query[key]);
  return `/api/v2/admin/experiments?${params}`;
}

function queryUrl(query: ExperimentQuery, location: { pathname: string; search: string }) {
  const params = new URLSearchParams(location.search);
  for (const [key, value] of Object.entries(query)) {
    const name = `experiment${key[0].toUpperCase()}${key.slice(1)}`;
    if (value && !(key === "limit" && value === defaultQuery.limit)) params.set(name, String(value));
    else params.delete(name);
  }
  if (!query.cursor) params.delete(listKeys.page);
  return `${location.pathname}${params.size ? `?${params}` : ""}`;
}

function randomToken() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

export function ExperimentsView() {
  const { t, value } = useAdminI18n();
  const [experiments, setExperiments] = useState<ManagedExperiment[]>([]);
  const [flags, setFlags] = useState<FlagRow[]>([]);
  const [analysis, setAnalysis] = useState<Record<string, Analysis>>({});
  const [key, setKey] = useState("");
  const [hypothesis, setHypothesis] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  // INVARIANT: 存异常对象 —— AuthorityRequestError 要靠 cause 才能按错误码出人话，
  // 只有 message 时运营读到的仍是 authority 的英文原文。
  const [error, setError] = useState<unknown>(null);
  const [monitoringUnavailable, setMonitoringUnavailable] = useState(false);
  const [pending, setPending] = useState<{ row: ManagedExperiment; command: LifecycleCommand } | null>(null);
  const [pageInfo, setPageInfo] = useState<PageInfo>(emptyPageInfo);
  const [page, setPage] = useState(1);
  const [hasPageHistory, setHasPageHistory] = useState(false);
  const [requestGate] = useState(createLatestRequestGate);
  // INVARIANT: 丢响应后重试同一表单必须保持 payload，apiWrite 才能复用幂等键。
  // 成功响应或离开表单结束这次创建意图，下一份草稿才生成新的分流 salt。
  const draftSalt = useRef<string | null>(null);
  const { feedback, reportSuccess, reportFailure, clearFeedback } = useWriteFeedback();

  async function load(next: ExperimentQuery) {
    const request = requestGate.begin();
    setLoading(true);
    setError(null);
    // Rows and forward cursors belong to the read that produced them. A failed
    // replacement must not leave them actionable under the new URL filters.
    setExperiments([]);
    setPageInfo(emptyPageInfo);
    try {
      const managed = await apiGet<{ items: ManagedExperiment[]; pageInfo: PageInfo }>(listPath(next));
      if (!request.isCurrent()) return;
      setExperiments(managed.items);
      setPageInfo(managed.pageInfo ?? emptyPageInfo);
      try {
        const monitoring = await apiGet<{ items: FlagRow[] }>("/api/v2/admin/analytics/flag-monitoring");
        if (!request.isCurrent()) return;
        setFlags(monitoring.items);
        setMonitoringUnavailable(false);
      } catch {
        if (!request.isCurrent()) return;
        setFlags([]);
        setMonitoringUnavailable(true);
      }
    } catch (reason) {
      if (request.isCurrent()) setError(reason);
    } finally {
      if (request.isCurrent()) setLoading(false);
    }
  }

  const { apply, draft, query, reload, setDraft, urlFor } = useUrlFilters({
    initial: defaultQuery,
    parse: queryFromUrl,
    toUrl: queryUrl,
    load: (next, params) => {
      setPage(next.cursor ? listPageFromParams(params, listKeys.page) : 1);
      setHasPageHistory(previousListPage(listKeys).hasHistory);
      void load(next);
    },
  });

  useEffect(() => {
    window.addEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, reload);
    return () => {
      requestGate.invalidate();
      window.removeEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, reload);
    };
  }, [reload, requestGate]);

  function applyQuery(next: ExperimentQuery, nextPage = 1) {
    const params = new URLSearchParams(urlFor(next).split("?")[1] ?? "");
    syncListUrl(params, nextPage, listKeys);
    apply(next, "replace");
  }

  async function createDraft(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("create");
    setError(null);
    try {
      const isCommunityRanking = key === communityRankingKey;
      draftSalt.current ??= `${randomToken()}-${randomToken()}`;
      await apiWrite("/api/v2/admin/experiments", "POST", {
        key,
        hypothesis,
        eligibility: isCommunityRanking ? { surface: "community.leaderboard" } : {},
        variants: isCommunityRanking
          ? [{ key: "control", allocationBps: 5_000 }, { key: "relationship_first", allocationBps: 5_000 }]
          : [{ key: "control", allocationBps: 5_000 }, { key: "treatment", allocationBps: 5_000 }],
        salt: draftSalt.current,
        metrics: { primary: "relationship.qce_activation.v1", controlVariant: "control", minimumMaturePerArm: 100, guardrails: [{ metricKey: "guardrail.support_contact_rate.v1", maxAbsoluteRegression: 0.02 }] },
      });
      const createdKey = key;
      draftSalt.current = null;
      setKey("");
      setHypothesis("");
      await load(query);
      reportSuccess(t(isCommunityRanking
        ? "Draft {key} created. It is not assigning traffic until you start it."
        : "Draft {key} created. Engineering integration is required before this key can receive product traffic.", { key: createdKey }));
    } catch (reason) {
      reportFailure(requestErrorMessage(reason, t));
    } finally {
      setBusy(null);
    }
  }

  // SPEC: 启停的 reason 由运营手写并进审计；确认框同时要求把实验 key 打对，防止在长列表里点错行。
  // INVARIANT: 后果进 consequence（标题下常驻红条 + DangerButton），运营在敲确认串之前就读到，
  //   而不是事后从审计日志里发现。stop 那句的「不能重启」是核对过后端的：management.ts:158 里
  //   start 只接受 draft，stopped 没有回到 running 的路径——所以 reversible: false。
  const lifecycleSpec: ConfirmSpec | null = pending
    ? {
        title: pending.command === "start" ? t("Start experiment") : t("Stop experiment"),
        consequence: {
          effect: pending.command === "start"
            ? pending.row.key === communityRankingKey
              ? t("Real users start being assigned to {key} v{version} immediately. You can stop it later, but subjects already exposed stay exposed. Your reason goes to the audit log.", { key: pending.row.key, version: pending.row.version })
              : t("Starting {key} v{version} makes the definition available to assignment clients. No product surface is connected to this key; product traffic and exposures require engineering integration. Your reason goes to the audit log.", { key: pending.row.key, version: pending.row.version })
            : t("Assignment ends for everyone immediately and {key} v{version} cannot be restarted — running this test again needs a new version. Your reason goes to the audit log.", { key: pending.row.key, version: pending.row.version }),
          reversible: pending.command === "start",
        },
        destructive: { expectedName: pending.row.key, inputLabel: t("Type the experiment key to confirm") },
        submitLabel: pending.command === "start" ? t("Start") : t("Stop"),
        onSubmit: async (reason) => {
          const { row, command } = pending;
          await apiWrite(
            `/api/v2/admin/experiments/${row.id}/commands/${command}`,
            "POST",
            { expectedStateVersion: row.stateVersion, reason },
          );
          await load(query);
          reportSuccess(
            command === "start"
              ? t(row.key === communityRankingKey
                ? "{key} v{version} is running."
                : "{key} v{version} is running. Engineering integration is still required for product traffic.", { key: row.key, version: row.version })
              : t("{key} v{version} is stopped.", { key: row.key, version: row.version }),
          );
        },
      }
    : null;

  async function loadAnalysis(id: string) {
    setBusy(`analysis-${id}`);
    setError(null);
    try {
      const result = await apiGet<Analysis>(`/api/v2/admin/experiments/${id}/analysis`);
      setAnalysis((current) => ({ ...current, [id]: result }));
    } catch (reason) {
      reportFailure(requestErrorMessage(reason, t));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div><h2 className="text-base font-semibold">{t("Managed experiment workspace")}</h2><p className="text-xs text-[var(--ad-text-muted)]">{t("Immutable definitions · stable assignment · observed exposure · fail-closed decisions")}</p></div>
        <button className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-[var(--ad-border)] px-3 text-sm disabled:opacity-50" disabled={loading} onClick={reload} type="button">{loading ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <RefreshCcw aria-hidden className="h-4 w-4" />}{t("Refresh")}</button>
      </header>
      <WriteFeedbackBanner feedback={feedback} onDismiss={clearFeedback} />
      {error ? <AuthorityRequestError cause={error} message={requestErrorMessage(error, t)} requestKind="read" onRetry={reload} /> : null}

      <form className="grid gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 md:grid-cols-[1fr_2fr_auto]" onSubmit={(event) => void createDraft(event)}>
        <p className="text-xs text-[var(--ad-text-muted)] md:col-span-3">{t("Product traffic is connected only for community.character-ranking.v1. Other keys require engineering integration.")}</p>
        <p className="text-xs text-[var(--ad-text-muted)] md:col-span-3">{t("Primary metric: QCE activation within 7 days. New drafts use 50/50 allocation and a +2 pp support-contact guardrail.")}</p>
        <label className="grid gap-1 text-xs"><span>{t("Experiment key")}</span><input className="min-h-11 rounded-md border border-[var(--ad-border)] bg-transparent px-3" disabled={busy === "create"} onChange={(event) => setKey(event.target.value)} pattern="[a-z0-9][a-z0-9._\-]*" placeholder={communityRankingKey} required value={key} /></label>
        <label className="grid gap-1 text-xs"><span>{t("Hypothesis")}</span><input className="min-h-11 rounded-md border border-[var(--ad-border)] bg-transparent px-3" disabled={busy === "create"} minLength={10} onChange={(event) => setHypothesis(event.target.value)} placeholder={t("What should change, for whom, and which metric should move")} required value={hypothesis} /></label>
        <button className="min-h-11 self-end rounded-md bg-[var(--ad-ink)] px-4 text-sm text-white disabled:opacity-50" disabled={busy === "create"} type="submit">{busy === "create" ? t("Creating…") : t("Create draft")}</button>
      </form>

      <section aria-labelledby="managed-experiments-heading" className="space-y-3">
        <h3 className="text-sm font-semibold" id="managed-experiments-heading">{t("Experiment definitions")}</h3>
        <FilterBar
          busy={loading}
          collapsible
          search={draft.search}
          onSearch={search => setDraft({ search })}
          searchPlaceholder={t("experiment key or hypothesis")}
          onApply={() => applyQuery({ ...draft, search: draft.search.trim(), cursor: "" })}
          onReset={() => applyQuery(defaultQuery)}
          selects={[{ name: t("Status"), value: draft.status, onChange: status => setDraft({ status }), options: [
            { value: "", label: t("All states") },
            ...statuses.map(status => ({ value: status, label: value(status) })),
          ] }]}
          chips={[
            ...(query.search ? [{ key: "search", label: t("Search"), value: query.search, onClear: () => applyQuery({ ...query, search: "", cursor: "" }) }] : []),
            ...(query.status ? [{ key: "status", label: t("Status"), value: value(query.status), onClear: () => applyQuery({ ...query, status: "", cursor: "" }) }] : []),
          ]}
        />
        {!loading && !error && experiments.length === 0 ? <p className="rounded-lg border border-dashed border-[var(--ad-border)] p-6 text-sm text-[var(--ad-text-muted)]">{t("No managed experiments yet. Create an immutable draft to begin.")}</p> : null}
        <div className="grid gap-3">
          {experiments.map((row) => {
            const result = analysis[row.id];
            return <article className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4" key={row.id}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><h4 className="font-mono text-sm">{row.key} · v{row.version}</h4><p className="mt-1 text-sm">{row.hypothesis}</p><p className="mt-1 flex items-center gap-2 text-xs text-[var(--ad-text-muted)]"><StatusPill status={row.status} />{t("· state v")}{row.stateVersion}</p></div><div className="flex flex-wrap gap-2">
                {row.status === "draft" ? <button className="inline-flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm" disabled={busy === row.id} onClick={() => setPending({ row, command: "start" })} type="button"><Play aria-hidden className="h-4 w-4" />{t("Start")}</button> : null}
                {row.status === "running" ? <button className="inline-flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm" disabled={busy === row.id} onClick={() => setPending({ row, command: "stop" })} type="button"><Square aria-hidden className="h-4 w-4" />{t("Stop")}</button> : null}
                <button className="min-h-11 rounded-md border px-3 text-sm" disabled={busy === `analysis-${row.id}`} onClick={() => void loadAnalysis(row.id)} type="button">{t("Quality & lift")}</button>
              </div></div>
              <p className="mt-2 text-xs text-[var(--ad-text-muted)]">{t(row.key === communityRankingKey
                ? "Product surface: Community leaderboard"
                : "Engineering integration required. This definition does not change product traffic.")}</p>
              {result ? <AnalysisReport result={result} /> : null}
            </article>;
          })}
        </div>
        <Pagination
          page={page}
          pageSize={query.limit}
          pageSizeOptions={pageSizes}
          rowCount={experiments.length}
          hasNext={pageInfo.hasNextPage && Boolean(pageInfo.endCursor)}
          hasPrevious={Boolean(query.cursor)}
          previousLabel={query.cursor && !hasPageHistory ? t("Back to first page") : undefined}
          loading={loading}
          onNext={() => { if (pageInfo.endCursor) applyQuery({ ...query, cursor: pageInfo.endCursor }, page + 1); }}
          onPrevious={() => {
            const previous = previousListPage(listKeys);
            applyQuery({ ...query, cursor: previous.cursor ?? "" }, previous.page);
          }}
          onPageSizeChange={limit => applyQuery({ ...query, limit, cursor: "" })}
        />
      </section>

      <section aria-labelledby="flag-monitoring-heading" className="rounded-lg border border-[var(--ad-yellow-text)]/25 bg-[var(--ad-yellow-bg)] p-4">
        <h3 className="text-sm font-semibold" id="flag-monitoring-heading">{t("Flag Monitoring")} ({flags.length})</h3><p className="mt-1 text-xs">{t("Directional only · no assignment or exposure records")}</p><p className="mt-2 text-xs">{t("Feature flags remain rollout monitoring and never inherit managed experiment lift.")}</p>{monitoringUnavailable ? <p className="mt-2 text-xs" role="status">{t("Flag monitoring is unavailable for this permission set; managed experiments are still shown.")}</p> : null}
        <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{flags.map((flag) => <li className="rounded-md border border-current/20 p-3 text-xs" key={flag.key}><span className="font-mono">{flag.key}</span><br />{flag.enabled ? t("enabled") : t("disabled")} · {flag.rolloutPercent}%</li>)}</ul>
      </section>

      {lifecycleSpec ? <ConfirmDialog onClose={() => setPending(null)} spec={lifecycleSpec} /> : null}
    </div>
  );
}

// SPEC: 报告是给运营读的整句，不是十几个 t() 片段加标点粘出来的——语序在中文里会散架。
function AnalysisReport({ result }: { result: Analysis }) {
  const { t, value } = useAdminI18n();
  const percent = (ratio: number | null) => (ratio === null ? "—" : `${(ratio * 100).toFixed(1)}`);
  return (
    <div className="mt-4 space-y-2 rounded-md bg-[var(--ad-surface-subtle)] p-3 text-xs" role="status">
      <p>
        {t("Quality {quality} · maturity {maturity} · guardrails {guardrails} · significance {significance}", {
          quality: value(result.qualityState),
          maturity: value(result.maturity),
          guardrails: value(result.guardrailState),
          significance: value(result.significance),
        })}
      </p>
      <ul className="space-y-1">
        {result.guardrails.map((guardrail) => (
          <li key={guardrail.metricKey}>
            {t("{metric} is {state}; observed regression {observed} pp against a {max} pp limit.", {
              metric: guardrail.metricKey,
              state: value(guardrail.state),
              observed: percent(guardrail.observedRegression),
              max: (guardrail.maxAbsoluteRegression * 100).toFixed(1),
            })}
          </li>
        ))}
      </ul>
      {result.decisionUse === "eligible" ? (
        <ul className="space-y-1">
          {result.arms.map((arm) => (
            <li key={arm.variant}>
              {t("{variant}: {subjects} mature subjects, rate {rate}%, lift {lift} pp vs control, p={p}.", {
                variant: arm.variant,
                subjects: arm.matureSubjects,
                rate: percent(arm.rate),
                lift: percent(arm.absoluteLiftVsControl),
                p: arm.pValueVsControl?.toFixed(4) ?? "—",
              })}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[var(--ad-yellow-text)]">
          {t("Lift is withheld from decisions until every arm has at least {minimum} mature production exposures and all guardrails pass.", {
            minimum: result.minimumMaturePerArm,
          })}
        </p>
      )}
    </div>
  );
}
