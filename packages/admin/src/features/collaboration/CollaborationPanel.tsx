"use client";

import { adminDateLocale, useAdminI18n } from "@/components/admin/i18n";
import {
  collaborationActivityListResponseSchema,
  collaborationActivityMutationSchema,
  collaborationActivitySchema,
  collaborationWatchResponseSchema,
  type CollaborationActivityListResponse,
  type CollaborationActivityMutation,
  type CollaborationTargetType,
} from "@idream/shared/admin";
import { Bell, BellOff, MessageCircle, RefreshCcw, Send } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

// INVARIANT: 成功文案必须是静态 key —— `t(\`${kindLabels[kind]} added…\`)` 那种拼接键
// 在字典里查不到，中文界面会原样露出英文。
export const kindNotices: Record<ActivityKind, string> = {
  comment: "Comment added to the activity timeline.",
  handoff: "Handoff added to the activity timeline.",
  checklist: "Checklist update added to the activity timeline.",
};

export function CollaborationPanel({
  targetType,
  targetId,
  targetVersion,
  canWrite,
  onAuthorityChange,
}: {
  targetType: CollaborationTargetType;
  targetId: string;
  targetVersion: number;
  canWrite: boolean;
  // SPEC: handoff 会在服务端改掉这条记录的 ownerId 并 +1 version（collaboration/service.ts）。
  // INTENT: 交接完父级必须重新拉记录，否则详情页还挂着旧负责人，而且后续写操作会拿陈旧的
  // entityVersion 去撞 409 —— 交接看着成功了，接手的人却什么都改不动。
  onAuthorityChange?: () => void;
}) {
  const { locale, t } = useAdminI18n();
  const [items, setItems] = useState<Activity[]>([]);
  const [watching, setWatching] = useState(false);
  const [watcherIds, setWatcherIds] = useState<readonly string[]>([]);
  const [actorNames, setActorNames] = useState<Readonly<Record<string, string>>>({});
  const [pageInfo, setPageInfo] = useState<ActivityList["pageInfo"]>({ hasNextPage: false, endCursor: null });
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [accessRestricted, setAccessRestricted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // SPEC: 提及/交接的对象从本记录已知的人里选，不靠运营背 user ID。
  // INTENT: 关注者和时间线操作者就是这条记录上真实出现过的人，够覆盖绝大多数提及场景，
  // 且不需要新增人员检索接口。仍允许手输，避免把没出现过的人挡在外面。
  // SPEC: 有名字就显示名字，没有就显示原始 ID —— 不编造。
  const actorLabel = useCallback(
    (id: string) => actorNames[id] ?? id,
    [actorNames],
  );
  const knownActorIds = useMemo(
    () => [...new Set([...watcherIds, ...items.map((activity) => activity.actorId)])],
    [items, watcherIds],
  );
  const [kind, setKind] = useState<ActivityKind>("comment");
  const [body, setBody] = useState("");
  const [mentions, setMentions] = useState("");
  const [attachmentIds, setAttachmentIds] = useState("");
  const [handoffActorId, setHandoffActorId] = useState("");
  const [checklist, setChecklist] = useState("");
  const [authorityReceipt, setAuthorityReceipt] = useState({ targetId, sourceVersion: targetVersion, version: targetVersion });
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
      setActorNames((current) => ({
        ...(cursor ? current : {}),
        ...Object.fromEntries(response.actors.map((entry) => [entry.id, entry.displayName])),
      }));
      setWatching(response.watching);
      setWatcherIds(response.watcherIds);
      setPageInfo(response.pageInfo);
      setAccessRestricted(false);
    } catch (cause) {
      if (currentRequest !== requestId.current) return;
      if (cause instanceof AdminV2RequestError && cause.status === 403) {
        setAccessRestricted(true);
        setItems([]);
      } else {
        setError(message(cause, t("Collaboration activity could not be loaded")));
      }
    } finally {
      if (currentRequest === requestId.current) {
        setLoading(false);
        setLoadingOlder(false);
      }
    }
  }, [t, targetId, targetType]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const authorityVersion = authorityReceipt.targetId === targetId && authorityReceipt.sourceVersion === targetVersion
    ? authorityReceipt.version
    : targetVersion;

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
      setNotice(response.watching ? t("You are watching this record.") : t("Watch removed."));
      await load();
    } catch (cause) {
      setError(message(cause, t("Watch preference could not be saved")));
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
      const checklistItems = parseChecklist(checklist);
      const response = await adminV2Request<CollaborationActivityMutation>(
        `/api/v2/admin/collaboration/${targetType}/${encodeURIComponent(targetId)}/activity`,
        {
          method: "POST",
          idempotencyKey: crypto.randomUUID(),
          body: {
            kind,
            ...(kind === "handoff" ? { expectedVersion: authorityVersion } : {}),
            body: normalizedBody,
            mentionedIds: parseMentionIds(mentions),
            metadata: {
              attachments: parseAttachmentIds(attachmentIds),
              ...(kind === "handoff" ? { handoffToActorId: handoffActorId.trim() } : {}),
              checklistItems: kind === "checklist" ? checklistItems : [],
            },
          },
          schema: collaborationActivityMutationSchema,
        },
      );
      if (response.authority) {
        setAuthorityReceipt({ targetId, sourceVersion: targetVersion, version: response.authority.version });
      }
      setBody("");
      setMentions("");
      setAttachmentIds("");
      setHandoffActorId("");
      setChecklist("");
      setNotice(kind === "handoff"
        ? t("Ownership transferred and recorded in the activity timeline.")
        : t(kindNotices[kind]));
      await load();
      if (kind === "handoff") onAuthorityChange?.();
      bodyRef.current?.focus();
    } catch (cause) {
      setError(message(cause, t("Activity could not be added")));
    } finally {
      setSubmitting(false);
    }
  };

  if (accessRestricted) {
    return (
      <section aria-labelledby={`collaboration-${targetType}-${targetId}`} className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface-subtle)] p-4">
        <h3 className="text-sm font-semibold" id={`collaboration-${targetType}-${targetId}`}>{t("Collaboration")}</h3>
        <p className="mt-2 text-sm text-[var(--ad-text-muted)]" role="status">{t("Activity is unavailable for this scoped record.")}</p>
      </section>
    );
  }

  return (
    <section aria-labelledby={`collaboration-${targetType}-${targetId}`} className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold" id={`collaboration-${targetType}-${targetId}`}><MessageCircle className="h-4 w-4" />{t("Collaboration")}</h3>
          <p className="mt-1 text-xs text-[var(--ad-text-muted)]">{t("Comments, mentions, handoffs, and checklist evidence remain attached to this record.")}</p>
        </div>
        <WorkspaceButton disabled={loading || submitting} onClick={() => void toggleWatch()}>
          {watching ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
          {watching ? t("Stop watching") : t("Watch")}
        </WorkspaceButton>
      </div>
      <p className="mt-2 break-words text-xs text-[var(--ad-text-muted)]">
        {watcherIds.length === 0 ? t("No watchers") : t("{count} watchers: {ids}", { count: watcherIds.length, ids: watcherIds.map(actorLabel).join(", ") })}
      </p>

      {/* 接缝：本面板唯一的反馈出口，ui/Toast.tsx 合并后换成 useToast() / useFailureToast()。 */}
      <div aria-atomic="true" aria-live="polite" className="mt-3 min-h-5 text-xs">
        {error ? <p className="text-[var(--ad-red-text)]" role="alert">{error} <button className="underline" onClick={() => void load()} type="button">{t("Retry")}</button></p> : null}
        {notice ? <p className="text-[var(--ad-green-text)]" role="status">{notice}</p> : null}
      </div>

      {canWrite ? (
        <form className="mt-3 grid gap-3 rounded-lg bg-[var(--ad-surface-subtle)] p-3" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <datalist id="collaboration-actor-ids">
            {knownActorIds.map((id) => <option key={id} label={actorLabel(id)} value={id} />)}
          </datalist>
          <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
            <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Activity type")}<select className={fieldClass} onChange={(event) => setKind(event.target.value as ActivityKind)} value={kind}>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></label>
            <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Mention actor IDs")}<input className={fieldClass} list="collaboration-actor-ids" onChange={(event) => setMentions(event.target.value)} placeholder={t("user-id-1, user-id-2")} value={mentions} /></label>
          </div>
          {kind === "handoff" ? <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Handoff actor ID")}<input className={fieldClass} list="collaboration-actor-ids" onChange={(event) => setHandoffActorId(event.target.value)} required value={handoffActorId} /></label> : null}
          {kind === "checklist" ? <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Checklist items, one per line")}<textarea className={textAreaClass} onChange={(event) => setChecklist(event.target.value)} placeholder={t("[x] Provider disabled [ ] Verify recovery")} required value={checklist} /></label> : null}
          <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Attachment evidence IDs")}<input className={fieldClass} onChange={(event) => setAttachmentIds(event.target.value)} placeholder={t("asset-id-1, asset-id-2")} value={attachmentIds} /></label>
          <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t(kindLabels[kind])}<textarea className={textAreaClass} maxLength={4_000} onChange={(event) => setBody(event.target.value)} ref={bodyRef} required value={body} /></label>
          <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-[var(--ad-text-muted)]">{body.length}/4000</span><WorkspaceButton disabled={submitting || body.trim().length === 0} tone="primary" type="submit"><Send className="h-4 w-4" />{t("Add activity")}</WorkspaceButton></div>
        </form>
      ) : <p className="mt-3 rounded-md bg-[var(--ad-surface-subtle)] p-3 text-sm text-[var(--ad-text-muted)]">{t("Read access only. Activity creation requires the target's write permission.")}</p>}

      <div className="mt-4">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--ad-text-muted)]">{t("Activity timeline")}</h4>
        {loading && items.length === 0 ? <p className="mt-3 text-sm text-[var(--ad-text-muted)]" role="status">{t("Loading collaboration activity…")}</p> : items.length === 0 ? <p className="mt-3 rounded-md bg-[var(--ad-surface-subtle)] p-3 text-sm text-[var(--ad-text-muted)]">{t("No activity yet. The first comment or handoff will appear here.")}</p> : (
          <ol className="mt-3 space-y-3">
            {items.map((activity) => <li className="border-l-2 border-[var(--ad-border)] pl-3" key={activity.id}><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-semibold">{t(activity.kind.replaceAll("_", " "))} · <span title={activity.actorId}>{actorLabel(activity.actorId)}</span></span><time className="text-xs text-[var(--ad-text-muted)]" dateTime={activity.createdAt}>{new Date(activity.createdAt).toLocaleString(adminDateLocale(locale))}</time></div>{activity.body ? <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{activity.body}</p> : null}{activity.mentionedIds.length > 0 ? <p className="mt-1 break-words text-xs text-[var(--ad-text-muted)]">{t("Mentions:")} {activity.mentionedIds.map((id) => `@${actorLabel(id)}`).join(", ")}</p> : null}{activity.metadata.handoffToActorId ? <p className="mt-1 text-xs">{t("Handoff to:")} <span title={activity.metadata.handoffToActorId}>{actorLabel(activity.metadata.handoffToActorId)}</span></p> : null}{activity.metadata.checklistItems.length > 0 ? <ul className="mt-2 space-y-1 text-xs">{activity.metadata.checklistItems.map((item) => <li key={item.id}>{item.completed ? "✓" : "○"} {item.label}{item.ownerId ? ` — ${actorLabel(item.ownerId)}` : ""}</li>)}</ul> : null}{activity.metadata.attachments.length > 0 ? <p className="mt-2 break-words text-xs text-[var(--ad-text-muted)]">{t("Evidence:")} {activity.metadata.attachments.map((item) => item.label).join(", ")}</p> : null}</li>)}
          </ol>
        )}
        {pageInfo.hasNextPage && pageInfo.endCursor ? <div className="mt-3"><WorkspaceButton disabled={loadingOlder} onClick={() => void load(pageInfo.endCursor ?? undefined)}><RefreshCcw className="h-4 w-4" />{loadingOlder ? t("Loading…") : t("Load older activity")}</WorkspaceButton></div> : null}
      </div>
    </section>
  );
}

export function parseMentionIds(value: string) {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))].slice(0, 50);
}

export function parseAttachmentIds(value: string) {
  return parseMentionIds(value).slice(0, 20).map((id) => ({ id, label: id }));
}

export function parseChecklist(value: string) {
  return value.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 100).map((line, index) => ({
    id: `item-${index + 1}`,
    completed: /^\[[xX]\]\s*/.test(line),
    label: line.replace(/^\[[xX ]\]\s*/, "").trim(),
  })).filter((item) => item.label.length > 0);
}

// 接缝：ui/request-error-copy.ts 合并后改走统一的 AppErrorCode → 人话映射。
function message(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}
