"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { productFeedbackListResponseSchema, type ProductFeedback } from "@idream/shared/admin";
import { useAdminI18n } from "@/components/admin/i18n";
import { GhostButton } from "@/components/admin/ui/buttons";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { DataTable } from "@/components/admin/ui/DataTable";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { Pagination } from "@/components/admin/ui/Pagination";
import { adminV2Request } from "@/lib/admin-v2-api";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";

const statusLabels = { under_review: "Under review", planned: "Planned", shipped: "Shipped" } as const;
type FeedbackStatus = keyof typeof statusLabels;
type FeedbackPage = { items: ProductFeedback[]; pageInfo: { endCursor: string | null; hasNextPage: boolean } };

export function FeedbackQueue({ canWrite }: { canWrite: boolean }) {
  const { t, value } = useAdminI18n();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<FeedbackStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [trail, setTrail] = useState<string[]>([]);
  const [data, setData] = useState<FeedbackPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirmation, setConfirmation] = useState<ConfirmSpec | null>(null);
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
      const result = await adminV2Request(`/api/v2/admin/support/feedback?${query}`, {
        schema: productFeedbackListResponseSchema, signal: controller.signal,
      });
      if (!controller.signal.aborted) setData(result);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [cursor, search, status]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => { void load(); }, 0);
    const refresh = () => { void load(); };
    window.addEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, refresh);
    return () => {
      activeRequest.current?.abort();
      window.clearTimeout(timer);
      window.removeEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, refresh);
    };
  }, [load, open]);

  function updateStatus(item: ProductFeedback, nextStatus: FeedbackStatus) {
    setConfirmation({
      title: "Update product feedback",
      summary: `${item.title} → ${t(statusLabels[nextStatus])}`,
      submitLabel: "Save feedback status",
      onSubmit: async (reason) => {
        await adminV2Operation("PATCH /api/v2/admin/support/feedback/:id", {
          path: { id: item.id },
          body: { status: nextStatus, expectedUpdatedAt: item.updatedAt, reason },
        });
        await load();
      },
    });
  }

  return (
    <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <GhostButton aria-expanded={open} onClick={() => setOpen((current) => !current)}>{t("Product feedback")}</GhostButton>
      {open && <div className="mt-4 space-y-4">
        <p className="text-sm text-[var(--ad-text-muted)]">{t("Review customer ideas and bugs. Status changes appear in Help Desk; reasons stay in the audit log.")}</p>
        <form className="flex flex-wrap gap-3" onSubmit={(event) => {
          event.preventDefault();
          if (search === searchDraft.trim() && !cursor) { void load(); return; }
          setSearch(searchDraft.trim()); setTrail([]); setData(null);
        }}>
          <input aria-label={t("Search product feedback")} className="rounded border border-[var(--ad-border)] bg-transparent px-3 py-2" value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} />
          <select aria-label={t("Feedback status filter")} className="rounded border border-[var(--ad-border)] bg-transparent px-3 py-2" value={status} onChange={(event) => { setStatus(event.target.value as FeedbackStatus | "all"); setTrail([]); setData(null); }}>
            <option value="all">{t("All")}</option>
            {Object.entries(statusLabels).map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}
          </select>
          <GhostButton type="submit">{t("Search")}</GhostButton>
          <GhostButton disabled={loading} onClick={() => void load()}>{t("Refresh")}</GhostButton>
        </form>
        {error !== null && <AuthorityRequestError cause={error} message={t("Product feedback could not load")} onRetry={() => void load()} />}
        {loading && <p role="status">{t("Loading product feedback…")}</p>}
        {data && !loading && <>
          <DataTable caption={t("Product feedback")} headers={[t("Title"), t("Category"), t("Votes"), t("Status")]} rows={data.items.map((item) => ({
            id: item.id,
            cells: [<div key="copy"><p className="font-semibold">{item.title}</p><p className="mt-1 max-w-xl whitespace-pre-wrap text-sm text-[var(--ad-text-muted)]">{item.description}</p></div>, value(item.category), String(item.voteCount),
              <select key="status" aria-label={t("Feedback status for {title}", { title: item.title })} disabled={!canWrite} value={item.status} onChange={(event) => updateStatus(item, event.target.value as FeedbackStatus)} className="rounded border border-[var(--ad-border)] bg-transparent px-3 py-2 disabled:opacity-50">
                {Object.entries(statusLabels).map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}
              </select>],
          }))} />
          <Pagination page={trail.length + 1} pageSize={25} rowCount={data.items.length} hasPrevious={trail.length > 0} hasNext={data.pageInfo.hasNextPage} onPrevious={() => setTrail((current) => current.slice(0, -1))} onNext={() => { if (data.pageInfo.endCursor) setTrail((current) => [...current, data.pageInfo.endCursor!]); }} />
        </>}
      </div>}
      {confirmation && <ConfirmDialog spec={confirmation} onClose={() => setConfirmation(null)} />}
    </section>
  );
}
