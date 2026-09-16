"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { affiliateApplicationListResponseSchema, type AffiliateApplicationAdmin } from "@idream/shared/admin";
import { useAdminI18n } from "@/components/admin/i18n";
import { GhostButton } from "@/components/admin/ui/buttons";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { DataTable } from "@/components/admin/ui/DataTable";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { Pagination } from "@/components/admin/ui/Pagination";
import { adminV2Request } from "@/lib/admin-v2-api";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";

const statuses = { pending: "Pending", approved: "Approved", rejected: "Rejected" } as const;

export function AffiliateApplicationsView({ canWrite }: { canWrite: boolean }) {
  const { t } = useAdminI18n();
  const [status, setStatus] = useState<keyof typeof statuses | "all">("pending");
  const [search, setSearch] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [trail, setTrail] = useState<string[]>([]);
  const [data, setData] = useState<{ items: AffiliateApplicationAdmin[]; pageInfo: { endCursor: string | null; hasNextPage: boolean } } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirmation, setConfirmation] = useState<ConfirmSpec | null>(null);
  const [notice, setNotice] = useState("");
  const activeRequest = useRef<AbortController | null>(null);
  const cursor = trail.at(-1) ?? "";
  const load = useCallback(async () => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ status, limit: "25" });
      if (search) query.set("search", search);
      if (cursor) query.set("cursor", cursor);
      const result = await adminV2Request(`/api/v2/admin/affiliate/applications?${query}`, {
        schema: affiliateApplicationListResponseSchema, signal: controller.signal,
      });
      if (!controller.signal.aborted) setData(result);
    } catch (cause) {
      if (!controller.signal.aborted) { setData(null); setError(cause); }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [cursor, search, status]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    const refresh = () => { void load(); };
    window.addEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, refresh);
    return () => {
      activeRequest.current?.abort();
      window.clearTimeout(timer);
      window.removeEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, refresh);
    };
  }, [load]);

  function decide(item: AffiliateApplicationAdmin, nextStatus: "approved" | "rejected") {
    setNotice("");
    setConfirmation({
      title: nextStatus === "approved" ? "Approve affiliate application" : "Reject affiliate application",
      summary: <div className="space-y-2"><p>{item.userId} · {item.id}</p><p>{t("Terms version")}: {item.termsVersion}</p><p>{item.channels.join(", ")}</p><p>{t("The review reason is visible to the applicant. Approval enables attribution; it does not authorize commission or payment.")}</p></div>,
      destructive: { expectedName: item.id, inputLabel: "Type the application ID to confirm" },
      submitLabel: nextStatus === "approved" ? "Approve" : "Reject",
      onSubmit: async (reason) => {
        await adminV2Operation("POST /api/v2/admin/affiliate/applications/:id/decision", {
          path: { id: item.id },
          body: { status: nextStatus, expectedUpdatedAt: item.updatedAt, reason, confirmation: item.id },
        });
        setNotice(t("Affiliate application reviewed"));
        await load();
      },
    });
  }

  return <section className="space-y-4">
    <h2 className="text-lg font-semibold">{t("Affiliate applications")}</h2>
    <p className="text-sm text-[var(--ad-text-muted)]">{t("Review the submitted terms version and promotion channels before deciding. Only pending applications can be reviewed; rejected applicants may reapply.")}</p>
    <form className="flex flex-wrap gap-3" onSubmit={(event) => {
      event.preventDefault();
      if (search === searchDraft.trim() && !cursor) { void load(); return; }
      setSearch(searchDraft.trim()); setTrail([]); setData(null);
    }}>
      <input aria-label={t("Search application or user ID")} className="rounded border border-[var(--ad-border)] bg-transparent px-3 py-2" value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} />
      <select aria-label={t("Application status")} className="rounded border border-[var(--ad-border)] bg-transparent px-3 py-2" value={status} onChange={(event) => { setStatus(event.target.value as typeof status); setTrail([]); setData(null); }}>
        <option value="all">{t("All")}</option>
        {Object.entries(statuses).map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}
      </select>
      <GhostButton type="submit">{t("Search")}</GhostButton>
      <GhostButton disabled={loading} onClick={() => void load()}>{t("Refresh")}</GhostButton>
    </form>
    {notice && <p role="status">{notice}</p>}
    {error !== null && <AuthorityRequestError cause={error} message={t("Affiliate applications could not load")} onRetry={() => void load()} />}
    {loading && <p role="status">{t("Loading…")}</p>}
    {data && !loading && <>
      <DataTable caption={t("Affiliate applications")} headers={[t("Application"), t("Terms version"), t("Promotion channels"), t("Status"), t("Actions")]} rows={data.items.map((item) => ({
        id: item.id,
        cells: [<div key="id"><p className="font-mono text-xs">{item.id}</p><p>{item.userId}</p></div>, item.termsVersion, item.channels.join(", "),
          <div key="state"><p>{t(statuses[item.status])}</p>{item.reviewNote && <p className="mt-1 max-w-md whitespace-pre-wrap text-sm">{item.reviewNote}</p>}{item.reviewedAt && <time className="text-xs" dateTime={item.reviewedAt}>{item.reviewedAt}</time>}</div>,
          item.status === "pending" ? <div key="actions" className="flex gap-2"><GhostButton disabled={!canWrite} onClick={() => decide(item, "approved")}>{t("Approve")}</GhostButton><GhostButton disabled={!canWrite} onClick={() => decide(item, "rejected")}>{t("Reject")}</GhostButton></div> : t("Reviewed")],
      }))} />
      {!data.items.length && <p>{t("No matching affiliate applications")}</p>}
      {!canWrite && <p className="text-sm">{t("Affiliate review requires growth.promo.write permission.")}</p>}
      <Pagination page={trail.length + 1} pageSize={25} rowCount={data.items.length} hasPrevious={trail.length > 0} hasNext={data.pageInfo.hasNextPage} onPrevious={() => setTrail((current) => current.slice(0, -1))} onNext={() => { if (data.pageInfo.endCursor) setTrail((current) => [...current, data.pageInfo.endCursor!]); }} />
    </>}
    {confirmation && <ConfirmDialog spec={confirmation} onClose={() => setConfirmation(null)} />}
  </section>;
}
