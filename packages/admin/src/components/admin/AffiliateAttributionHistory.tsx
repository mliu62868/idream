"use client";

import { useEffect, useRef, useState } from "react";
import { affiliateAttributionAdminHistorySchema } from "@idream/shared/admin";
import { affiliateAttributionReasonDescriptions, affiliateAttributionStateLabels } from "@idream/shared/contracts";
import { adminV2Request } from "@/lib/admin-v2-api";
import { useAdminI18n } from "./i18n";
import { GhostButton } from "./ui/buttons";
import { AuthorityRequestError } from "./ui/AuthorityRequestError";
import { Pagination } from "./ui/Pagination";

export function AffiliateAttributionHistory({ applicationId, onClose }: { applicationId: string; onClose: () => void }) {
  const { t } = useAdminI18n();
  const [data, setData] = useState<ReturnType<typeof affiliateAttributionAdminHistorySchema.parse> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [dateError, setDateError] = useState<string | null>(null);
  const [dates, setDates] = useState<{ from?: string; to?: string }>({});
  const [from, setFrom] = useState(""), [to, setTo] = useState("");
  const [trail, setTrail] = useState<string[]>([]), [attempt, setAttempt] = useState(0);
  const active = useRef<AbortController | null>(null), cursor = trail.at(-1);
  useEffect(() => {
    const controller = new AbortController(); active.current = controller;
    const query = new URLSearchParams({ limit: "20", ...dates, ...(cursor ? { cursor } : {}) });
    void adminV2Request(`/api/v2/admin/affiliate/applications/${encodeURIComponent(applicationId)}/attribution?${query}`, { schema: affiliateAttributionAdminHistorySchema, signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setData(value); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause); });
    return () => { controller.abort(); };
  }, [applicationId, dates, cursor, attempt]);
  return <section className="space-y-3 rounded-xl border border-[var(--ad-border)] p-4" aria-label={t("Affiliate attribution evidence")}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{t("Affiliate attribution evidence")} · <span className="font-mono text-xs">{applicationId}</span></h3><GhostButton onClick={onClose}>{t("Close")}</GhostButton></div>
    <p className="text-sm text-[var(--ad-text-muted)]">{t("Observed signups and current account checks are distinct. These states do not authorize commission or payment.")}</p>
    <form className="flex flex-wrap items-end gap-3 text-sm" onSubmit={event => {
      event.preventDefault();
      if (from && to && from > to) { setDateError(t("Start date must not follow end date")); return; }
      active.current?.abort(); setDates({ ...(from ? { from } : {}), ...(to ? { to } : {}) }); setTrail([]); setData(null); setError(null); setDateError(null);
    }}>
      <label>{t("Visits from (UTC)")}<input className="mt-1 block rounded border border-[var(--ad-border)] bg-transparent px-2 py-1" type="date" value={from} onChange={event => setFrom(event.target.value)} /></label>
      <label>{t("Through (UTC)")}<input className="mt-1 block rounded border border-[var(--ad-border)] bg-transparent px-2 py-1" type="date" value={to} onChange={event => setTo(event.target.value)} /></label>
      <GhostButton type="submit">{t("Apply dates")}</GhostButton>
      <GhostButton onClick={() => { active.current?.abort(); setData(null); setError(null); setAttempt(value => value + 1); }}>{t("Refresh")}</GhostButton>
    </form>
    {dateError ? <p role="alert" className="text-sm text-[var(--ad-red-text)]">{dateError}</p> : null}
    {error !== null ? <AuthorityRequestError requestKind="read" cause={error} message={t("Affiliate evidence could not load")} onRetry={() => { setError(null); setAttempt(value => value + 1); }} /> : !data ? <p role="status">{t("Loading…")}</p> : <>
      <p className="text-sm">{data.totalVisits} {t("deduplicated visits")} · {data.totalSignups} {t("observed signups")} · {data.currentRule.version} / {data.currentRule.windowDays} {t("days")}</p>
      {!data.items.length ? <p>{t("No visits in this date range")}</p> : <ul className="space-y-2">{data.items.map(item => <li key={item.id} className="rounded-lg border border-[var(--ad-border)] p-3 text-sm">
        <p className="font-medium">{t(affiliateAttributionStateLabels[item.state])}</p><p>{t(affiliateAttributionReasonDescriptions[item.reason])}</p>
        <p className="break-all text-xs">{t("Visit")}: {item.id} · {item.createdAt} · {item.landingPath}</p>
        <p className="break-all text-xs">{t("Signup account")}: {item.convertedUserId ?? t("Not recorded")} · {item.convertedAt ?? t("No signup observed")}</p>
        <p className="text-xs">{t("Rule")}: {item.attributionVersion ?? t("Historical version not recorded")} · {item.attributionWindowDays} {t("days")} · {t("Window ends")}: {item.expiresAt}</p>
        <p className="text-xs">{t("Terms version")}: {item.termsVersion ?? t("Historical version not recorded")}</p>
      </li>)}</ul>}
      <Pagination page={trail.length + 1} pageSize={20} rowCount={data.items.length} hasPrevious={trail.length > 0} hasNext={data.pageInfo.hasNextPage}
        onPrevious={() => { active.current?.abort(); setTrail(value => value.slice(0, -1)); setData(null); setError(null); }}
        onNext={() => { if (data.pageInfo.endCursor) { active.current?.abort(); setTrail(value => [...value, data.pageInfo.endCursor!]); setData(null); setError(null); } }} />
      <p className="text-xs text-[var(--ad-text-muted)]">{t("Visit snapshot")}: {data.asOf}</p>
    </>}
  </section>;
}
