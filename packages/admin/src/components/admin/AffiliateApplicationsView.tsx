"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type AffiliateApplicationAdmin } from "@idream/shared/admin";
import { useAdminI18n } from "@/components/admin/i18n";
import { GhostButton } from "@/components/admin/ui/buttons";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { DataTable } from "@/components/admin/ui/DataTable";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { Pagination } from "@/components/admin/ui/Pagination";
import { FilterBar } from "@/components/admin/ui/FilterBar";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import { AffiliateAttributionHistory } from "./AffiliateAttributionHistory";
import { affiliateQueryParams, parseAffiliateQuery, type AffiliateQuery } from "./affiliate-query";

const statuses = { pending: "Pending", approved: "Approved", rejected: "Rejected" } as const;

export function AffiliateApplicationsView({ canWrite }: { canWrite: boolean }) {
  const { t } = useAdminI18n();
  const [status, setStatus] = useState<keyof typeof statuses | "all">("pending");
  const [search, setSearch] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [trail, setTrail] = useState<string[]>([]);
  const [cursor, setCursor] = useState("");
  const [ready, setReady] = useState(false);
  const [restoreRevision, setRestoreRevision] = useState(0);
  const [data, setData] = useState<{ items: AffiliateApplicationAdmin[]; pageInfo: { endCursor: string | null; hasNextPage: boolean } } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirmation, setConfirmation] = useState<ConfirmSpec | null>(null);
  const [notice, setNotice] = useState("");
  const [attributionId, setAttributionId] = useState<string | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const navigation = useRef(0);
  useEffect(() => {
    const restore = () => {
      navigation.current += 1;
      activeRequest.current?.abort();
      const restored = parseAffiliateQuery(new URLSearchParams(window.location.search));
      setStatus(restored.status); setSearch(restored.search); setSearchDraft(restored.search);
      setCursor(restored.cursor); setAttributionId(restored.applicationId); setData(null); setConfirmation(null);
      const savedTrail: unknown = window.history.state?.affiliateTrail;
      setTrail(Array.isArray(savedTrail) && savedTrail.every(item => typeof item === "string") && window.history.state?.affiliateCursor === restored.cursor ? savedTrail : []);
      setReady(true);
      setRestoreRevision(value => value + 1);
    };
    restore();
    window.addEventListener("popstate", restore);
    return () => {
      navigation.current += 1;
      window.removeEventListener("popstate", restore);
    };
  }, []);

  function navigate(update: Partial<AffiliateQuery>, nextTrail = trail) {
    navigation.current += 1;
    setConfirmation(null);
    const next = { status, search, cursor, applicationId: attributionId, ...update };
    const params = affiliateQueryParams(new URLSearchParams(window.location.search), next);
    window.history.pushState({ ...window.history.state, affiliateTrail: nextTrail, affiliateCursor: next.cursor }, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`);
    setStatus(next.status); setSearch(next.search); setSearchDraft(next.search); setCursor(next.cursor); setTrail(nextTrail); setAttributionId(next.applicationId);
    if (next.status !== status || next.search !== search || next.cursor !== cursor) { activeRequest.current?.abort(); setData(null); }
  }
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
      const result = await adminV2Operation("GET /api/v2/admin/affiliate/applications", {
        query, signal: controller.signal,
      });
      if (!controller.signal.aborted) setData(result);
    } catch (cause) {
      if (!controller.signal.aborted) { setData(null); setError(cause); }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [cursor, search, status]);

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => { void load(); }, 0);
    const refresh = () => { void load(); };
    window.addEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, refresh);
    return () => {
      activeRequest.current?.abort();
      window.clearTimeout(timer);
      window.removeEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, refresh);
    };
  }, [load, ready, restoreRevision]);

  function decide(item: AffiliateApplicationAdmin, nextStatus: "approved" | "rejected") {
    if (!canWrite) return;
    const origin = navigation.current;
    setNotice("");
    setConfirmation({
      title: nextStatus === "approved" ? "Approve affiliate application" : "Reject affiliate application",
      summary: <div className="space-y-2"><p>{item.userId} · {item.id}</p><p>{t("Terms version")}: {item.termsVersion}</p><p>{item.channels.join(", ")}</p><p>{t("The review reason is visible to the applicant. Approval enables attribution; it does not authorize commission or payment.")}</p></div>,
      destructive: { expectedName: item.id, inputLabel: "Type the application ID to confirm" },
      submitLabel: nextStatus === "approved" ? "Approve" : "Reject",
      onSubmit: async (reason) => {
        if (navigation.current !== origin) return;
        await adminV2Operation("POST /api/v2/admin/affiliate/applications/:id/decision", {
          path: { id: item.id },
          body: { status: nextStatus, expectedUpdatedAt: item.updatedAt, reason, confirmation: item.id },
        });
        // Navigation starts a new visit, even if it eventually returns to the
        // same URL. A late receipt must not reload or close that visit's UI.
        if (navigation.current !== origin) return;
        setNotice(t("Affiliate application reviewed"));
        await load();
      },
    });
  }

  return <section className="space-y-4">
    <h2 className="text-lg font-semibold">{t("Affiliate applications")}</h2>
    <p className="text-sm text-[var(--ad-text-muted)]">{t("Review the submitted terms version and promotion channels before deciding. Only pending applications can be reviewed; rejected applicants may reapply.")}</p>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (search === searchDraft.trim() && !cursor) { void load(); return; }
      navigate({ search: searchDraft.trim(), cursor: "" }, []);
    }}>
      <FilterBar search={searchDraft} onSearch={setSearchDraft} searchPlaceholder={t("Search application or user ID")} selects={[{
        name: t("Application status"), value: status,
        onChange: (next) => { if (next === "all" || next === "pending" || next === "approved" || next === "rejected") navigate({ status: next, cursor: "" }, []); },
        options: [{ value: "all", label: t("All") }, ...Object.entries(statuses).map(([value, label]) => ({ value, label: t(label) }))],
      }]}>
        <GhostButton type="submit">{t("Search")}</GhostButton>
        <GhostButton disabled={loading} onClick={() => void load()}>{t("Refresh")}</GhostButton>
      </FilterBar>
    </form>
    {notice && <p role="status">{notice}</p>}
    {error !== null && <AuthorityRequestError requestKind="read" cause={error} message={t("Affiliate applications could not load")} onRetry={() => void load()} />}
    {loading && <p role="status">{t("Loading…")}</p>}
    {data && !loading && <>
      <DataTable caption={t("Affiliate applications")} empty={<EmptyState title={t("No matching affiliate applications")} />} headers={[t("Application"), t("Terms version"), t("Promotion channels"), t("Status"), t("Actions")]} rows={data.items.map((item) => ({
        id: item.id,
        cells: [<div key="id"><p className="font-mono text-xs">{item.id}</p><p>{item.userId}</p></div>, item.termsVersion, item.channels.join(", "),
          <div key="state"><p>{t(statuses[item.status])}</p>{item.reviewNote && <p className="mt-1 max-w-md whitespace-pre-wrap text-sm">{item.reviewNote}</p>}{item.reviewedAt && <time className="text-xs" dateTime={item.reviewedAt}>{item.reviewedAt}</time>}</div>,
          <div key="actions" className="flex flex-wrap gap-2"><GhostButton onClick={() => navigate({ applicationId: item.id })}>{t("View attribution")}</GhostButton>{item.status === "pending" ? <><GhostButton disabled={!canWrite} onClick={() => decide(item, "approved")}>{t("Approve")}</GhostButton><GhostButton disabled={!canWrite} onClick={() => decide(item, "rejected")}>{t("Reject")}</GhostButton></> : <span>{t("Reviewed")}</span>}</div>],
      }))} />
      {!canWrite && <p className="text-sm">{t("Affiliate review requires growth.promo.write permission.")}</p>}
      <Pagination page={!cursor ? 1 : trail[0] === "" ? trail.length + 1 : null} pageSize={25} rowCount={data.items.length} hasPrevious={Boolean(cursor)} hasNext={data.pageInfo.hasNextPage} previousLabel={cursor && !trail.length ? t("Back to first page") : undefined} onPrevious={() => navigate({ cursor: trail.at(-1) ?? "" }, trail.slice(0, -1))} onNext={() => { if (data.pageInfo.endCursor) navigate({ cursor: data.pageInfo.endCursor }, [...trail, cursor]); }} />
    </>}
    {attributionId ? <AffiliateAttributionHistory key={attributionId} applicationId={attributionId} onClose={() => navigate({ applicationId: null })} /> : null}
    {confirmation && <ConfirmDialog spec={confirmation} onClose={() => setConfirmation(current => current === confirmation ? null : current)} />}
  </section>;
}
