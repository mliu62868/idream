"use client";

import { useCallback, useState } from "react";
import type { CharacterPerformanceReconciliation as Reconciliation } from "@idream/shared/admin";
import { useAdminI18n } from "@/components/admin/i18n";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { WorkspaceButton } from "@/features/operations/WorkspaceUi";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import { useAuthorityResource } from "@/lib/authority-resource";

const COUNTS = [
  ["scannedFunnelRows", "Funnel rows checked"],
  ["impossibleFunnelRows", "Contradictory funnel rows"],
  ["missingReleaseRows", "Funnel rows without a release"],
  ["nonExactFunnelRows", "Funnel rows with incomplete attribution"],
  ["relevantCostAuthorities", "Eligible cost source facts"],
  ["projectedCostAuthorities", "Projected cost facts"],
  ["missingVariableCostFacts", "Missing variable cost facts"],
  ["unauditedEconomicsFacts", "Unaudited economics facts"],
  ["partialEconomicsFacts", "Economics facts with incomplete coverage"],
] as const satisfies readonly (readonly [keyof Reconciliation, string])[];

// 此接口扫描全局事实，不接受角色筛选；按需读取，避免伪装成某个角色的诊断。
export function CharacterPerformanceReconciliation() {
  const { t } = useAdminI18n();
  const [expanded, setExpanded] = useState(false);
  const report = useAuthorityResource({
    key: "characters/performance/reconciliation",
    enabled: expanded,
    load: useCallback(() => adminV2Operation(
      "GET /api/v2/admin/characters/performance/reconciliation", {},
    ), []),
  });
  return (
    <section className="rounded-lg border border-[var(--ad-border)] p-4">
      <WorkspaceButton aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {t("Character performance fact reconciliation")}
      </WorkspaceButton>
      {expanded ? <div className="mt-3 space-y-3">
        <p className="text-sm text-[var(--ad-text-muted)]">{t("Global facts across all characters and dates; independent of portfolio filters.")}</p>
        <WorkspaceButton disabled={report.loading} onClick={() => void report.refresh()}>{t("Refresh")}</WorkspaceButton>
        {report.error ? <AuthorityRequestError cause={report.cause} message={report.error} onRetry={() => void report.refresh()} snapshotAt={report.data ? report.refreshedAt : null} /> : null}
        {report.loading ? <p role="status">{t("Loading…")}</p> : null}
        {report.data ? <CharacterPerformanceReconciliationResult data={report.data} /> : null}
      </div> : null}
    </section>
  );
}

export function CharacterPerformanceReconciliationResult({ data }: { data: Reconciliation }) {
  const { t } = useAdminI18n();
  return <div className="space-y-3">
    <p role={data.qualityState === "invalid" ? "alert" : "status"} className="text-sm">
      {t(data.qualityState === "invalid"
        ? "Character facts are inconsistent; do not use these numbers for decisions."
        : "Character facts are directional only; this is not a financial sign-off.")}
    </p>
    {data.scannedFunnelRows === 0 ? <p className="text-sm">{t("No funnel facts are available to verify.")}</p> : null}
    <dl className="grid gap-3 sm:grid-cols-3">
      {COUNTS.map(([key, label]) => <div key={key}>
        <dt className="text-xs text-[var(--ad-text-muted)]">{t(label)}</dt>
        <dd className="font-semibold tabular-nums">{data[key]}</dd>
      </div>)}
    </dl>
    <p className="text-sm text-[var(--ad-text-muted)]">{t("Cash revenue, refunds and credits are not reconciled by this report. Contribution margin remains unavailable for decisions.")}</p>
  </div>;
}
