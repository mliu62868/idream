"use client";

import { useEffect, useRef, useState } from "react";
import { useAdminI18n } from "@/components/admin/i18n";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { useAdminFormat } from "@/components/admin/ui/format";
import { WorkspaceButton } from "@/features/operations/WorkspaceUi";
import { adminV2Operation, type AdminV2OperationResponse } from "@/lib/admin-v2-operation";

type Report = AdminV2OperationResponse<"GET /api/v2/admin/metrics/reconciliation">;
const checkLabels: Record<string, string> = {
  server_outcome_completeness: "Server outcome completeness",
  duplicate_effect: "Duplicate effects",
  impossible_state: "Impossible states",
  fixture_internal_leakage: "Internal fixture leakage",
  authoritative_join_coverage: "Authoritative join coverage",
  event_lag_p95: "Event lag p95",
  eligible_fact_presence: "Eligible source facts",
};

export function MetricReconciliation() {
  const { t, value } = useAdminI18n();
  const format = useAdminFormat();
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current += 1; }, []);

  async function load() {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const result = await adminV2Operation("GET /api/v2/admin/metrics/reconciliation", {});
      if (current === generation.current) setData(result);
    } catch (cause) {
      if (current === generation.current) setError(cause);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }

  return <details className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4" onToggle={(event) => {
    if (event.currentTarget.open) void load();
  }}>
    <summary className="cursor-pointer text-sm font-semibold">{t("Metric reconciliation and backfill evidence")}</summary>
    <div className="mt-4 space-y-4">
      <p className="text-sm text-[var(--ad-text-muted)]">{t("Read-only source checks and the latest 20 backfill runs. A completed backfill does not certify metrics.")}</p>
      <WorkspaceButton disabled={loading} onClick={() => void load()}>{t("Refresh")}</WorkspaceButton>
      {loading ? <p role="status">{t("Loading…")}</p> : null}
      {error ? <AuthorityRequestError cause={error} message="Metric reconciliation could not be loaded" snapshotAt={data?.asOf} onRetry={() => void load()} /> : null}
      {data ? <>
        <p className="text-xs text-[var(--ad-text-muted)]">{t("asOf")} <time dateTime={data.asOf}>{format.dateTime(data.asOf)}</time> · {value(data.quality.qualityState)} · {t("Scanned facts")}: {data.quality.scannedFactCount}</p>
        <div className="overflow-x-auto"><table className="w-full text-left text-sm">
          <caption className="text-left font-semibold">{t("Source fact checks")}</caption>
          <thead><tr>{["Check", "Status", "Observed", "Threshold"].map((label) => <th className="p-2" key={label}>{t(label)}</th>)}</tr></thead>
          <tbody>{data.quality.checks.map((check) => <tr key={check.key} className="border-t border-[var(--ad-border)]">
            <th className="p-2 font-normal" scope="row">{t(checkLabels[check.key] ?? check.key)}</th><td className="p-2">{value(check.status)}</td><td className="p-2">{check.observed ?? "—"}</td><td className="p-2">{check.threshold}</td>
          </tr>)}</tbody>
        </table></div>
        {data.recentBackfills.length === 0 ? <p className="text-sm">{t("No backfill runs have been recorded.")}</p> : <div className="overflow-x-auto"><table className="w-full text-left text-sm">
          <caption className="text-left font-semibold">{t("Latest backfill runs")}</caption>
          <thead><tr>{["Run / source", "Status / mode", "Scanned / applied / skipped / mismatches", "Coverage", "Started / completed"].map((label) => <th className="p-2" key={label}>{t(label)}</th>)}</tr></thead>
          <tbody>{data.recentBackfills.map((run) => <tr key={run.runId} className="border-t border-[var(--ad-border)] align-top">
            <th className="break-all p-2 font-normal" scope="row">{run.runId}<br />{run.source}{run.cursor ? <p>{t("Cursor")}: {run.cursor}</p> : null}{run.validFrom ? <p>{t("Valid from")}: {format.dateTime(run.validFrom)}</p> : null}</th>
            <td className="p-2">{value(run.status)}<br />{t(run.dryRun ? "Dry run" : "Applied run")}</td>
            <td className="p-2">{run.scannedCount} / {run.appliedCount} / {run.skippedCount} / {run.mismatchCount}</td>
            <td className="p-2">{run.coverage === null ? "—" : `${(run.coverage * 100).toFixed(1)}%`}</td>
            <td className="p-2">{format.dateTime(run.startedAt)}<br />{run.completedAt ? format.dateTime(run.completedAt) : "—"}</td>
          </tr>)}</tbody>
        </table></div>}
      </> : null}
    </div>
  </details>;
}
