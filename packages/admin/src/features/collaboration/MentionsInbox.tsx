"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { AtSign } from "lucide-react";
import type { CollaborationTargetType } from "@idream/shared/admin";
import { useAdminI18n } from "@/components/admin/i18n";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { useAdminFormat } from "@/components/admin/ui/format";
import { WorkspaceButton } from "@/features/operations/WorkspaceUi";
import { adminV2Operation, type AdminV2OperationResponse } from "@/lib/admin-v2-operation";

type Mentions = AdminV2OperationResponse<"GET /api/v2/admin/collaboration/mentions">;

const targetPaths: Record<CollaborationTargetType, string> = {
  case: "/admin/cases",
  incident: "/admin/ops/incidents",
  creative_run: "/admin/creative/runs",
};

export function mentionTargetHref(targetType: CollaborationTargetType, targetId: string) {
  return `${targetPaths[targetType]}/${encodeURIComponent(targetId)}`;
}

export function MentionsInbox() {
  const { t } = useAdminI18n();
  const format = useAdminFormat();
  const [data, setData] = useState<Mentions | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const requestId = useRef(0);
  const retryCursor = useRef<string | undefined>(undefined);
  const panel = useRef<HTMLDetailsElement>(null);

  async function load(cursor?: string) {
    const current = ++requestId.current;
    retryCursor.current = cursor;
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ limit: "25" });
      if (cursor) query.set("cursor", cursor);
      const response = await adminV2Operation("GET /api/v2/admin/collaboration/mentions", { query });
      if (current === requestId.current) {
        setData((previous) => ({ ...response, items: cursor ? [...(previous?.items ?? []), ...response.items] : response.items }));
      }
    } catch (cause) {
      if (current === requestId.current) setError(cause);
    } finally {
      if (current === requestId.current) setLoading(false);
    }
  }

  return <details className="relative shrink-0" ref={panel} onToggle={(event) => {
    if (event.currentTarget.open) void load();
  }} onKeyDown={(event) => {
    if (event.key === "Escape" && panel.current) {
      panel.current.open = false;
      panel.current.querySelector("summary")?.focus();
    }
  }}>
    <summary className="grid h-9 w-9 cursor-pointer list-none place-items-center rounded-md border border-[var(--ad-border)] hover:bg-black/[0.04]" aria-label={t("Mentions inbox")} title={t("Mentions inbox")}><AtSign className="h-4 w-4" /></summary>
    <section aria-label={t("Mentions inbox")} className="absolute right-0 z-30 mt-2 max-h-[70vh] w-[min(24rem,calc(100vw-2rem))] overflow-auto rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 shadow-lg">
      <div className="flex items-center justify-between gap-3"><h2 className="font-semibold">{t("Mentions inbox")}</h2><WorkspaceButton disabled={loading} onClick={() => void load()}>{t("Refresh")}</WorkspaceButton></div>
      <p className="mt-2 text-xs text-[var(--ad-text-muted)]">{t("People can mention you in comments, handoffs, and checklists.")}</p>
      {error ? <AuthorityRequestError cause={error} message="Mentions could not be loaded" onRetry={() => void load(retryCursor.current)} /> : null}
      {loading ? <p className="mt-3 text-sm" role="status">{t("Loading mentions…")}</p> : null}
      {data?.items.length === 0 && !loading && !error ? <p className="mt-3 text-sm">{t("No mentions on this page.")}</p> : null}
      <ol className="mt-3 space-y-3">{data?.items.map((activity) => <li className="border-t border-[var(--ad-border)] pt-3" key={activity.id}>
        <div className="flex flex-wrap justify-between gap-1 text-xs text-[var(--ad-text-muted)]"><span>{activity.actorId}</span><time dateTime={activity.createdAt}>{format.dateTime(activity.createdAt)}</time></div>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm">{activity.body}</p>
        <Link className="mt-2 inline-block text-sm font-semibold underline" href={mentionTargetHref(activity.targetType, activity.targetId)} onClick={() => { if (panel.current) panel.current.open = false; }}>{t("Open mentioned record")}</Link>
      </li>)}</ol>
      {data?.pageInfo.hasNextPage && data.pageInfo.endCursor ? <div className="mt-3"><WorkspaceButton disabled={loading} onClick={() => void load(data.pageInfo.endCursor ?? undefined)}>{t("Older mentions")}</WorkspaceButton></div> : null}
    </section>
  </details>;
}
