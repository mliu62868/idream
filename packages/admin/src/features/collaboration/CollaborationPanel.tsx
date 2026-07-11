"use client";

import {
  collaborationActivityListResponseSchema,
  collaborationActivitySchema,
  collaborationWatchResponseSchema,
  type CollaborationActivityListResponse,
  type CollaborationTargetType,
} from "@idream/shared/admin";
import { Bell, BellOff, MessageCircle, RefreshCcw, Send } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AdminV2RequestError, adminV2Request } from "@/lib/admin-v2-api";
import { WorkspaceButton, fieldClass, textAreaClass } from "@/features/operations/WorkspaceUi";

type Activity = ReturnType<typeof collaborationActivitySchema.parse>;

type ActivityList = CollaborationActivityListResponse;

type ActivityKind = "comment" | "handoff" | "checklist";

const kindLabels: Record<ActivityKind, string> = {
  comment: "Comment",
  handoff: "Handoff",
  checklist: "Checklist update",
};

export function CollaborationPanel({
  targetType,
  targetId,
  canWrite,
}: {
  targetType: CollaborationTargetType;
  targetId: string;
  canWrite: boolean;
}) {
  const [items, setItems] = useState<Activity[]>([]);
  const [watching, setWatching] = useState(false);
  const [pageInfo, setPageInfo] = useState<ActivityList["pageInfo"]>({ hasNextPage: false, endCursor: null });
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [accessRestricted, setAccessRestricted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [kind, setKind] = useState<ActivityKind>("comment");
  const [body, setBody] = useState("");
  const [mentions, setMentions] = useState("");
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async (cursor?: string) => {
    const currentRequest = ++requestId.current;
    if (cursor) setLoadingOlder(true);
    else setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ limit: "25" });
      if (cursor) query.set("cursor", cursor);
      const response = await adminV2Request<ActivityList>(
        `/api/v2/admin/collaboration/${targetType}/${encodeURIComponent(targetId)}/activity?${query}`,
        { schema: collaborationActivityListResponseSchema },
      );
      if (currentRequest !== requestId.current) return;
      setItems((current) => cursor ? [...current, ...response.items] : [...response.items]);
      setWatching(response.watching);
      setPageInfo(response.pageInfo);
      setAccessRestricted(false);
    } catch (cause) {
      if (currentRequest !== requestId.current) return;
      if (cause instanceof AdminV2RequestError && cause.status === 403) {
        setAccessRestricted(true);
        setItems([]);
      } else {
        setError(message(cause, "Collaboration activity could not be loaded"));
      }
    } finally {
      if (currentRequest === requestId.current) {
        setLoading(false);
        setLoadingOlder(false);
      }
    }
  }, [targetId, targetType]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const toggleWatch = async () => {
    const next = !watching;
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const response = await adminV2Request<{ watching: boolean }>(
        `/api/v2/admin/collaboration/${targetType}/${encodeURIComponent(targetId)}/watch`,
        {
          method: "PUT",
          idempotencyKey: crypto.randomUUID(),
          body: { watching: next },
          schema: collaborationWatchResponseSchema,
        },
      );
      setWatching(response.watching);
      setNotice(response.watching ? "You are watching this record." : "Watch removed.");
      await load();
    } catch (cause) {
      setError(message(cause, "Watch preference could not be saved"));
    } finally {
      setSubmitting(false);
    }
  };

  const submit = async () => {
    const normalizedBody = body.trim();
    if (!normalizedBody) return;
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      await adminV2Request(
        `/api/v2/admin/collaboration/${targetType}/${encodeURIComponent(targetId)}/activity`,
        {
          method: "POST",
          idempotencyKey: crypto.randomUUID(),
          body: {
            kind,
            body: normalizedBody,
            mentionedIds: parseMentionIds(mentions),
            metadata: {},
          },
        },
      );
      setBody("");
      setMentions("");
      setNotice(`${kindLabels[kind]} added to the activity timeline.`);
      await load();
      bodyRef.current?.focus();
    } catch (cause) {
      setError(message(cause, "Activity could not be added"));
    } finally {
      setSubmitting(false);
    }
  };

  if (accessRestricted) {
    return (
      <section aria-labelledby={`collaboration-${targetType}-${targetId}`} className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface-subtle)] p-4">
        <h3 className="text-sm font-semibold" id={`collaboration-${targetType}-${targetId}`}>Collaboration</h3>
        <p className="mt-2 text-sm text-[var(--ad-text-muted)]" role="status">Activity is unavailable for this scoped record.</p>
      </section>
    );
  }

  return (
    <section aria-labelledby={`collaboration-${targetType}-${targetId}`} className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold" id={`collaboration-${targetType}-${targetId}`}><MessageCircle className="h-4 w-4" />Collaboration</h3>
          <p className="mt-1 text-xs text-[var(--ad-text-muted)]">Comments, mentions, handoffs, and checklist evidence remain attached to this record.</p>
        </div>
        <WorkspaceButton disabled={loading || submitting} onClick={() => void toggleWatch()}>
          {watching ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
          {watching ? "Stop watching" : "Watch"}
        </WorkspaceButton>
      </div>

      <div aria-atomic="true" aria-live="polite" className="mt-3 min-h-5 text-xs">
        {error ? <p className="text-[var(--ad-red-text)]" role="alert">{error} <button className="underline" onClick={() => void load()} type="button">Retry</button></p> : null}
        {notice ? <p className="text-[var(--ad-green-text)]" role="status">{notice}</p> : null}
      </div>

      {canWrite ? (
        <form className="mt-3 grid gap-3 rounded-lg bg-[var(--ad-surface-subtle)] p-3" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
            <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">Activity type<select className={fieldClass} onChange={(event) => setKind(event.target.value as ActivityKind)} value={kind}>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">Mention actor IDs<input className={fieldClass} onChange={(event) => setMentions(event.target.value)} placeholder="user-id-1, user-id-2" value={mentions} /></label>
          </div>
          <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{kindLabels[kind]}<textarea className={textAreaClass} maxLength={4_000} onChange={(event) => setBody(event.target.value)} ref={bodyRef} required value={body} /></label>
          <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-[var(--ad-text-muted)]">{body.length}/4000</span><WorkspaceButton disabled={submitting || body.trim().length === 0} tone="primary" type="submit"><Send className="h-4 w-4" />Add activity</WorkspaceButton></div>
        </form>
      ) : <p className="mt-3 rounded-md bg-[var(--ad-surface-subtle)] p-3 text-sm text-[var(--ad-text-muted)]">Read access only. Activity creation requires the target&apos;s write permission.</p>}

      <div className="mt-4">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--ad-text-muted)]">Activity timeline</h4>
        {loading && items.length === 0 ? <p className="mt-3 text-sm text-[var(--ad-text-muted)]" role="status">Loading collaboration activity…</p> : items.length === 0 ? <p className="mt-3 rounded-md bg-[var(--ad-surface-subtle)] p-3 text-sm text-[var(--ad-text-muted)]">No activity yet. The first comment or handoff will appear here.</p> : (
          <ol className="mt-3 space-y-3">
            {items.map((activity) => <li className="border-l-2 border-[var(--ad-border)] pl-3" key={activity.id}><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-semibold">{activity.kind.replaceAll("_", " ")} · <span className="font-mono">{activity.actorId}</span></span><time className="text-xs text-[var(--ad-text-muted)]" dateTime={activity.createdAt}>{new Date(activity.createdAt).toLocaleString()}</time></div>{activity.body ? <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{activity.body}</p> : null}{activity.mentionedIds.length > 0 ? <p className="mt-1 break-words text-xs text-[var(--ad-text-muted)]">Mentions: {activity.mentionedIds.map((id) => `@${id}`).join(", ")}</p> : null}</li>)}
          </ol>
        )}
        {pageInfo.hasNextPage && pageInfo.endCursor ? <div className="mt-3"><WorkspaceButton disabled={loadingOlder} onClick={() => void load(pageInfo.endCursor ?? undefined)}><RefreshCcw className="h-4 w-4" />{loadingOlder ? "Loading…" : "Load older activity"}</WorkspaceButton></div> : null}
      </div>
    </section>
  );
}

export function parseMentionIds(value: string) {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))].slice(0, 50);
}

function message(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}
