"use client";

// SPEC: 公告/banner 后台面板（ADMIN_CONSOLE_PLAN §3）。新建 / 启停 / 删除，写后 refetch。
// INTENT: 自取数，写入口跟随实际权限。启停/删除经 inline typed confirmation。
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Pencil, Plus, RefreshCcw, Search, Trash2 } from "lucide-react";
import type { AdminPageInfo } from "@idream/shared/admin";
import { apiGet, apiWrite } from "@/components/admin/api";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import { Field } from "@/components/admin/ui/FormPage";
import { useAdminI18n } from "@/components/admin/i18n";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { DataTable, type DataTableRow } from "@/components/admin/ui/DataTable";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { useAdminFormat } from "@/components/admin/ui/format";
import { announcementWindowOrdered, isoToLocalInput, localInputToIso } from "@/features/announcements-schedule";
import { Pagination } from "@/components/admin/ui/Pagination";
import { StatusPill } from "@/components/admin/ui/StatusPill";
import { PermissionNotice } from "@/components/admin/ui/PermissionNotice";
import { useUnsavedChanges } from "@/components/admin/ui/useUnsavedChanges";
import { createLatestRequestGate } from "@/lib/latest-request";
import { authorityRequestFailed, authorityRequestStarted, authorityRequestSucceeded, createAuthorityState } from "@/lib/authority-state";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import {
  WriteFeedbackBanner,
  listPageFromParams,
  previousListPage,
  requestErrorMessage,
  syncListUrl,
  useWriteFeedback,
} from "@/components/admin/section-kit";
import {
  announcementListPath,
  announcementQueryFromSearch,
  announcementWorkspaceUrl,
  type AnnouncementQuery,
} from "./announcements-query";

const PAGE_SIZE = 25;
const listKeys = { cursor: "announcementCursor", page: "page" };

type Announcement = {
  id: string;
  version: number;
  title: string;
  body: string;
  level: "info" | "promo" | "warning";
  active: boolean;
  serving: boolean;
  startsAt: string | null;
  endsAt: string | null;
  href: string | null;
  createdAt: string;
};

type AnnouncementActionDraft = {
  kind: "toggle" | "delete";
  item: Announcement;
  reason: string;
  confirmation: string;
};

const inputClass =
  "rounded-md h-10 w-full min-w-0 border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]";

export function AnnouncementsView({ canWrite }: { canWrite: boolean }) {
  const { t, value: valueLabel } = useAdminI18n();
  const format = useAdminFormat();
  const [list, setList] = useState(() => createAuthorityState<{ items: Announcement[]; pageInfo: AdminPageInfo }>());
  const [error, setError] = useState<{ message: string; cause: unknown } | null>(null);
  const [actionDraft, setActionDraft] = useState<AnnouncementActionDraft | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [formBusy, setFormBusy] = useState(false);
  const [formDirty, setFormDirty] = useState(false);
  const [editing, setEditing] = useState<Announcement | null>(null);
  const { feedback, reportSuccess, clearFeedback } = useWriteFeedback();
  const [query, setQuery] = useState<AnnouncementQuery>({ announcementSearch: "", announcementLevel: "", announcementActive: "", announcementCursor: "" });
  const [page, setPage] = useState(1);
  const [hasPageHistory, setHasPageHistory] = useState(false);
  const requestGate = useRef(createLatestRequestGate());
  const { confirmDiscard, guard } = useUnsavedChanges(Boolean(
    formDirty || (actionDraft && (actionDraft.reason || actionDraft.confirmation)),
  ));

  const load = useCallback(async (params = new URLSearchParams(window.location.search)) => {
    const request = requestGate.current.begin();
    const restored = announcementQueryFromSearch(params.toString());
    const queryKey = announcementListPath(restored);
    setList((current) => authorityRequestStarted(current, queryKey));
    setError(null);
    try {
      setQuery(restored);
      setPage(syncListUrl(params, listPageFromParams(params), listKeys));
      setHasPageHistory(previousListPage(listKeys).hasHistory);
      const data = await apiGet<{ items: Announcement[]; pageInfo: AdminPageInfo }>(queryKey);
      if (!request.isCurrent()) return;
      setList(authorityRequestSucceeded(queryKey, data));
    } catch (err) {
      if (!request.isCurrent()) return;
      setList((current) => authorityRequestFailed(current, queryKey, requestErrorMessage(err, t), err));
    }
  }, [t]);

  useEffect(() => {
    const gate = requestGate.current;
    const timer = window.setTimeout(() => void load(), 0);
    const onPopState = () => void load(new URLSearchParams(window.location.search));
    window.addEventListener("popstate", onPopState);
    window.addEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, onPopState);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, onPopState);
      gate.invalidate();
    };
  }, [load]);

  const items = list.data?.items ?? [];
  const loading = list.loading;
  const pageInfo = list.data?.pageInfo ?? { endCursor: null, hasNextPage: false };

  // INVARIANT: page 只进地址栏，不进 announcementListPath —— 游标分页的请求里没有页码这个概念，
  // 但没有它，后退回上一页时页码就只能靠猜。
  function navigate(updates: Record<string, string | null>, nextPage: number) {
    const next = announcementWorkspaceUrl(
      window.location.pathname,
      window.location.search,
      { ...updates, page: nextPage > 1 ? String(nextPage) : null },
      nextPage === 1,
    );
    syncListUrl(new URLSearchParams(next.split("?")[1] ?? ""), nextPage, listKeys);
    void load(new URLSearchParams(window.location.search));
  }

  function startAction(kind: AnnouncementActionDraft["kind"], item: Announcement) {
    if (!canWrite || formBusy || actionBusy) return;
    setError(null);
    clearFeedback();
    setActionDraft({ kind, item, reason: "", confirmation: "" });
  }

  async function submitAction() {
    if (!canWrite || actionBusy || !actionDraft || !canConfirmAnnouncementAction(actionDraft)) return;
    setActionBusy(true);
    try {
      if (actionDraft.kind === "toggle") {
        await apiWrite(`/api/v2/admin/announcements/${actionDraft.item.id}`, "PATCH", {
          entityVersion: actionDraft.item.version,
          active: !actionDraft.item.active,
          reason: actionDraft.reason.trim(),
          confirmation: actionDraft.confirmation.trim(),
        });
      } else {
        await adminV2Operation("DELETE /api/v2/admin/announcements/:id", {
          path: { id: actionDraft.item.id },
          body: {
            entityVersion: actionDraft.item.version,
            reason: actionDraft.reason.trim(),
            confirmation: actionDraft.confirmation.trim(),
          },
        });
      }
      const { kind, item } = actionDraft;
      setActionDraft(null);
      await load();
      reportSuccess(
        kind === "delete"
          ? t("Deleted “{title}”. It no longer shows anywhere on the site.", { title: item.title })
          : item.active
            ? t("Deactivated “{title}”. It is hidden from the site now.", { title: item.title })
            // INVARIANT: 激活不等于就在展示 —— 窗口没到或已过时照样什么都不显示。
            : item.startsAt || item.endsAt
              ? t("Activated “{title}”. It shows only inside its scheduled window.", { title: item.title })
              : t("Activated “{title}”. It is visible site-wide now.", { title: item.title }),
      );
    } catch (err) {
      setError({ message: requestErrorMessage(err, t), cause: err });
    } finally {
      setActionBusy(false);
    }
  }

  const filtered = Boolean(query.announcementSearch || query.announcementLevel || query.announcementActive);
  const tableRows: DataTableRow[] = items.map((item) => ({
    id: item.id,
    cells: [
      <div key="title">
        <p>{item.title}</p>
        {!canWrite ? <>
          <p className="mt-1 whitespace-pre-wrap text-xs text-[var(--ad-text-muted)]">{item.body}</p>
          {item.href ? <code className="mt-1 block break-all text-xs">{item.href}</code> : null}
        </> : null}
      </div>,
      <span className="text-[var(--ad-text-muted)]" key="level">{valueLabel(item.level)}</span>,
      // SPEC: 这一列回答的是「站上现在有没有在显示」，不是「有没有勾启用」。
      // INTENT: 启用只是三个条件之一，另两个是时间窗。一条窗口已过的公告过去在这里写着
      //         「启用」，而站上什么都没有——判据由服务端的 serving 给出，和公开端点同一个函数。
      <StatusPill
        key="active"
        label={item.serving ? t("Showing") : item.active ? t("Active, outside its window") : t("Inactive")}
        status={item.serving ? "active" : item.active ? "pending" : "disabled"}
      />,
      <span className="text-xs text-[var(--ad-text-muted)]" key="window">{announcementWindowLabel(item, t, format)}</span>,
      canWrite ? <div className="flex justify-end gap-2" key="actions">
        <button
          aria-label={t("Edit announcement")}
          className="rounded-md inline-flex h-8 items-center gap-1 border border-[var(--ad-border)] px-2 text-xs"
          disabled={actionBusy || formBusy || editing?.id === item.id}
          onClick={() => {
            // A refreshed row version must not be paired with this form's old input.
            if (formBusy || editing?.id === item.id) return;
            confirmDiscard(() => {
              clearFeedback();
              setEditing(item);
            });
          }}
          type="button"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          className="rounded-md inline-flex h-8 items-center gap-1 border border-[var(--ad-border)] px-2 text-xs"
          disabled={actionBusy || formBusy}
          onClick={() => startAction("toggle", item)}
          type="button"
        >
          {item.active ? t("Deactivate") : t("Activate")}
        </button>
        <button
          aria-label={t("Delete announcement")}
          className="rounded-md inline-flex h-8 items-center gap-1 border border-[var(--ad-red-text)]/20 px-2 text-xs text-[var(--ad-red-text)]"
          disabled={actionBusy || formBusy}
          onClick={() => startAction("delete", item)}
          type="button"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div> : <span className="text-xs text-[var(--ad-text-muted)]" key="actions">{t("Read only")}</span>,
    ],
  }));

  return (
    <div className="space-y-5">
      {guard}
      <form className="grid items-end gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 md:grid-cols-4" onSubmit={(event) => {
        event.preventDefault();
        navigate({ announcementSearch: query.announcementSearch, announcementLevel: query.announcementLevel, announcementActive: query.announcementActive }, 1);
      }}>
        <Field label={t("Search announcements")}><input aria-label={t("Search announcements")} className={inputClass} onChange={(event) => setQuery({ ...query, announcementSearch: event.target.value })} placeholder={t("Search")} type="search" value={query.announcementSearch} /></Field>
        <Field label={t("Announcement level")}>
          <select className={inputClass} onChange={(event) => setQuery({ ...query, announcementLevel: event.target.value })} value={query.announcementLevel}>
            <option value="">{t("All levels")}</option><option value="info">{t("info")}</option><option value="promo">{t("promo")}</option><option value="warning">{t("warning")}</option>
          </select>
        </Field>
        <Field label={t("Status")}>
          <select className={inputClass} onChange={(event) => setQuery({ ...query, announcementActive: event.target.value })} value={query.announcementActive}>
            <option value="">{t("All states")}</option><option value="true">{t("Active")}</option><option value="false">{t("Inactive")}</option>
          </select>
        </Field>
        <button className="inline-flex h-10 items-center justify-center gap-2 bg-[var(--ad-ink)] px-3 text-sm font-semibold text-white" type="submit"><Search className="h-4 w-4" />{t("Apply")}</button>
      </form>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t("Announcements")}</h2>
        <button
          className="rounded-md inline-flex h-9 items-center gap-2 border border-[var(--ad-border)] px-3 text-sm disabled:opacity-50"
          disabled={loading}
          onClick={() => void load()}
          type="button"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
          {t("Refresh")}
        </button>
      </div>
      <WriteFeedbackBanner feedback={feedback} onDismiss={clearFeedback} />
      {list.error ? <AuthorityRequestError cause={list.cause} message={list.error} requestKind="read" snapshotAt={list.refreshedAt} onRetry={() => void load()} /> : null}
      {error ? <AuthorityRequestError cause={error.cause} message={error.message} onRetry={() => void load()} /> : null}

      <AnnouncementForm
        busy={formBusy}
        canWrite={canWrite}
        editing={editing}
        key={editing?.id ?? "create"}
        onBusyChange={setFormBusy}
        onDirtyChange={setFormDirty}
        onCancel={() => { if (!formBusy) setEditing(null); }}
        onSaved={(message) => {
          setEditing(null);
          reportSuccess(message);
        }}
        reload={load}
      />

      {canWrite && actionDraft ? (
        <section className="rounded-lg border border-[var(--ad-yellow-text)]/20 bg-[var(--ad-yellow-bg)] p-3">
          <p className="text-xs font-semibold text-[var(--ad-yellow-text)]">
            {actionDraft.kind === "delete"
              ? t("Confirm announcement delete")
              : actionDraft.item.active
                ? t("Confirm announcement deactivation")
                : t("Confirm announcement activation")}{" "}
            <span className="font-mono">{actionDraft.item.id}</span>
          </p>
          <p className="mt-1 text-xs text-[var(--ad-text-muted)]">{actionDraft.item.title}</p>
          <fieldset className="mt-3 grid gap-3 md:grid-cols-[1fr_260px_auto_auto]" disabled={actionBusy}>
            <Field label={t("Reason (≥3)")}>
              <input
                aria-label={t("Announcement action reason")}
                className={inputClass}
                onChange={(event) => setActionDraft({ ...actionDraft, reason: event.target.value })}
                placeholder={t("Reason (≥3)")}
                value={actionDraft.reason}
              />
            </Field>
            <input
              aria-label={t("Announcement action confirmation")}
              className={`${inputClass} font-mono`}
              onChange={(event) => setActionDraft({ ...actionDraft, confirmation: event.target.value })}
              placeholder={actionDraft.item.id}
              value={actionDraft.confirmation}
            />
            <button
              className="rounded-md inline-flex h-10 items-center justify-center border border-[var(--ad-border)] px-3 text-sm"
              disabled={actionBusy}
              onClick={() => setActionDraft(null)}
              type="button"
            >
              {t("Cancel")}
            </button>
            <button
              className="inline-flex h-10 items-center justify-center bg-[var(--ad-yellow-bg)] px-3 text-sm font-semibold text-[var(--ad-yellow-text)] disabled:opacity-50"
              disabled={actionBusy || !canConfirmAnnouncementAction(actionDraft)}
              onClick={() => void submitAction()}
              type="button"
            >
              {actionBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {actionDraft.kind === "delete" ? t("Confirm delete") : t("Confirm update")}
            </button>
          </fieldset>
        </section>
      ) : null}

      {(error || list.error) && items.length === 0 ? null : (
        <DataTable
          caption="Announcements"
          empty={
            <EmptyState
              hint={filtered
                ? t("The authority searched every announcement. Clear the filters to see them all.")
                : canWrite ? t("Create one above to broadcast it site-wide.") : undefined}
              kind={filtered ? "filtered" : "empty"}
              onClearFilters={filtered ? () => navigate({ announcementSearch: null, announcementLevel: null, announcementActive: null }, 1) : undefined}
              title={filtered ? t("No announcements match these filters.") : t("No announcements.")}
            />
          }
          headers={[t("Title"), t("level"), t("Active"), t("Schedule"), { label: t("Actions"), align: "right" }]}
          loading={loading}
          rows={tableRows}
          skeletonRows={PAGE_SIZE}
        />
      )}
      <Pagination
        hasNext={Boolean(pageInfo.hasNextPage && pageInfo.endCursor)}
        hasPrevious={Boolean(query.announcementCursor)}
        previousLabel={query.announcementCursor && !hasPageHistory ? t("Back to first page") : undefined}
        loading={loading}
        onNext={() => navigate({ announcementCursor: pageInfo.endCursor }, page + 1)}
        onPrevious={() => {
          const previous = previousListPage(listKeys);
          navigate({ announcementCursor: previous.cursor ?? null }, previous.page);
        }}
        page={page}
        pageSize={PAGE_SIZE}
        rowCount={items.length}
        totalCount={pageInfo.totalCount ?? null}
      />
    </div>
  );
}

function canConfirmAnnouncementAction(draft: AnnouncementActionDraft) {
  const confirmation = draft.confirmation.trim();
  return draft.reason.trim().length >= 3 && confirmation === draft.item.id;
}

// SPEC: 只说窗口本身，不重复「在不在展示」——那一列已经回答过了。
// INTENT: 两端都为空是最常见的情况（恒显），此时写「始终展示」比留一个破折号有用：
//         运营一眼就知道这条不会自己消失。
function announcementWindowLabel(
  item: { startsAt: string | null; endsAt: string | null },
  t: (key: string, values?: Record<string, string>) => string,
  format: { dateTime: (value: unknown) => string },
) {
  if (!item.startsAt && !item.endsAt) return t("Always on");
  if (item.startsAt && item.endsAt) {
    return t("{from} → {to}", { from: format.dateTime(item.startsAt), to: format.dateTime(item.endsAt) });
  }
  return item.startsAt
    ? t("From {from}", { from: format.dateTime(item.startsAt) })
    : t("Until {to}", { to: format.dateTime(item.endsAt) });
}

// SPEC: 新建与编辑共用一张表单；editing 非空时回填已有值并走 PATCH（确认串是公告 id）。
// INTENT: 服务端 PATCH 一直支持改标题 / 正文 / 级别 / 链接 / 时间窗，后台却只发 active，
//         写错一个字只能删了重建。启停仍走行内的启用 / 停用，不在这张表单里。
function AnnouncementForm({
  busy,
  canWrite,
  editing,
  onBusyChange,
  onDirtyChange,
  onSaved,
  onCancel,
  reload,
}: {
  busy: boolean;
  canWrite: boolean;
  editing: Announcement | null;
  onBusyChange: (busy: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: (message: string) => void;
  onCancel: () => void;
  reload: () => void;
}) {
  const { t, value: valueLabel } = useAdminI18n();
  const [title, setTitle] = useState(editing?.title ?? "");
  const [body, setBody] = useState(editing?.body ?? "");
  const [href, setHref] = useState(editing?.href ?? "");
  const [level, setLevel] = useState<"info" | "promo" | "warning">(editing?.level ?? "info");
  const [active, setActive] = useState(true);
  // SPEC: 时间窗一直存在于契约、存储、公开过滤器和更新服务里，只有后台没有入口。
  // INTENT: 没有入口就没人能排期公告（发版公告、活动开始/结束都要它），而且上面那列
  //         「在展示 / 已启用但不在窗口内」也永远只能显示前者——补上入口这两件事才同时成立。
  const [startsAt, setStartsAt] = useState(isoToLocalInput(editing?.startsAt ?? null));
  const [endsAt, setEndsAt] = useState(isoToLocalInput(editing?.endsAt ?? null));
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const trimmedTitle = title.trim();
  const expectedConfirmation = editing ? editing.id : trimmedTitle;
  const dirty = title !== (editing?.title ?? "") || body !== (editing?.body ?? "") ||
    href !== (editing?.href ?? "") || level !== (editing?.level ?? "info") || !active ||
    startsAt !== isoToLocalInput(editing?.startsAt ?? null) || endsAt !== isoToLocalInput(editing?.endsAt ?? null) ||
    Boolean(reason || confirmation);
  // The parent owns navigation and target changes; this keyed form owns input.
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  async function submit() {
    if (!canWrite || busy) return;
    onBusyChange(true);
    setErr(null);
    try {
      if (editing) {
        await apiWrite(`/api/v2/admin/announcements/${editing.id}`, "PATCH", {
          entityVersion: editing.version,
          title: trimmedTitle,
          body: body.trim(),
          href: href.trim() || null,
          level,
          startsAt: localInputToIso(startsAt),
          endsAt: localInputToIso(endsAt),
          reason: reason.trim(),
          confirmation: confirmation.trim(),
        });
        reload();
        onSaved(t("Saved “{title}”.", { title: trimmedTitle }));
        return;
      }
      await apiWrite("/api/v2/admin/announcements", "POST", {
        title: title.trim(),
        body: body.trim(),
        href: href.trim() || null,
        level,
        active,
        // datetime-local 没有时区，按本机时区转成契约要的带偏移 ISO 串。
        startsAt: localInputToIso(startsAt),
        endsAt: localInputToIso(endsAt),
        reason: reason.trim(),
        confirmation: confirmation.trim(),
      });
      setTitle("");
      setBody("");
      setHref("");
      setLevel("info");
      setActive(true);
      setStartsAt("");
      setEndsAt("");
      setReason("");
      setConfirmation("");
      reload();
      onSaved(
        !active
          ? t("Created “{title}”. Activate it when you want it on the site.", { title: trimmedTitle })
          : startsAt || endsAt
            ? t("Created “{title}”. It shows only inside its scheduled window.", { title: trimmedTitle })
            : t("Created “{title}”. It is live site-wide now.", { title: trimmedTitle }),
      );
    } catch (error) {
      setErr(requestErrorMessage(error, t));
    } finally {
      onBusyChange(false);
    }
  }

  // SPEC: 按钮为什么不能点，逐条说出来。
  // INTENT: 这个表单有五个前置条件（标题、正文、原因≥3、确认文本要和标题一字不差、时间窗顺序），
  //         过去只把按钮置灰 —— 运营看不出是差原因还是确认文本敲错了，只能一个个试。
  const missing: string[] = [];
  if (trimmedTitle.length === 0) missing.push("a title");
  if (body.trim().length === 0) missing.push("body text");
  if (reason.trim().length < 3) missing.push("a reason of at least 3 characters");
  if (editing && confirmation.trim() !== editing.id) {
    missing.push("the announcement ID typed to confirm");
  } else if (!editing && trimmedTitle.length > 0 && confirmation.trim() !== trimmedTitle) {
    missing.push("the title typed again to confirm");
  }
  // 窗口反了就别发出去 —— 权威不校验先后，这条会被存下来然后永远不显示。
  if (!announcementWindowOrdered(startsAt, endsAt)) missing.push("an end time after the start time");
  const canCreate = !busy && missing.length === 0;

  if (!canWrite) return <PermissionNotice permission="growth.promo.write" />;

  return (
    <details open={editing ? true : undefined} className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <summary className="cursor-pointer text-sm font-semibold"><h2 className="inline">
        {editing ? t("Edit announcement") : t("Create announcement")}
        {editing ? <span className="ml-2 font-mono text-xs font-normal text-[var(--ad-text-muted)]">{editing.id}</span> : null}
      </h2></summary>
      <p className="mt-1 text-xs text-[var(--ad-text-muted)]">{t("An in-product banner — this is the site-wide broadcast channel. Active means visible to everyone.")}</p>
      {/* The parent also freezes target changes while this write owns the form. */}
      <fieldset className="mt-3 grid items-end gap-3 md:grid-cols-2" disabled={busy}>
        <Field label={t("Title")}>
          <input className={inputClass} onChange={(e) => setTitle(e.target.value)} placeholder={t("Title")} value={title} />
        </Field>
        <Field label={t("Body")}>
          <input className={inputClass} onChange={(e) => setBody(e.target.value)} placeholder={t("Body")} value={body} />
        </Field>
        <Field label={t("Link URL (optional)")}>
          <input
            aria-label={t("Link URL (optional)")}
            className={inputClass}
            onChange={(e) => setHref(e.target.value)}
            placeholder={t("Link URL (optional)")}
            value={href}
          />
        </Field>
        <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">
          {t("Starts at (optional)")}
          <input className={inputClass} onChange={(e) => setStartsAt(e.target.value)} type="datetime-local" value={startsAt} />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">
          {t("Ends at (optional)")}
          <input className={inputClass} onChange={(e) => setEndsAt(e.target.value)} type="datetime-local" value={endsAt} />
        </label>
        <Field label={t("Announcement level")}><select
          className={`${inputClass} appearance-none`}
          onChange={(e) => setLevel(e.target.value as "info" | "promo" | "warning")}
          value={level}
        >
          <option value="info">{valueLabel("info")}</option>
          <option value="promo">{valueLabel("promo")}</option>
          <option value="warning">{valueLabel("warning")}</option>
        </select></Field>
        {editing ? null : (
          <label className="flex items-center gap-2 text-sm text-[var(--ad-text-muted)]">
            <input checked={active} onChange={(e) => setActive(e.target.checked)} type="checkbox" />
            {t("Active immediately")}
          </label>
        )}
        <Field label={t("Reason (≥3)")}>
          <input
            className={inputClass}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("Reason (≥3)")}
            value={reason}
          />
        </Field>
        <Field label={t("Confirmation")}>
          <input
            aria-label={t("Announcement create confirmation")}
            className={editing ? `${inputClass} font-mono` : inputClass}
            onChange={(e) => setConfirmation(e.target.value)}
            placeholder={editing ? expectedConfirmation : t("Type title to confirm")}
            value={confirmation}
          />
        </Field>
        {editing ? (
          <button
            className="rounded-md inline-flex h-10 items-center justify-center border border-[var(--ad-border)] px-3 text-sm"
            disabled={busy}
            onClick={onCancel}
            type="button"
          >
            {t("Cancel")}
          </button>
        ) : null}
        <button
          aria-describedby={missing.length > 0 ? "announcement-create-missing" : undefined}
          className="inline-flex h-10 items-center justify-center gap-2 bg-[var(--ad-ink)] px-3 text-sm font-semibold text-white disabled:opacity-50"
          disabled={!canCreate}
          onClick={() => void submit()}
          type="button"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : editing ? <Pencil className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          {editing ? t("Save changes") : t("Create")}
        </button>
      </fieldset>
      {expectedConfirmation ? <p className="mt-3 break-all text-xs text-[var(--ad-text-muted)]">{t("Confirmation target: {target}", { target: expectedConfirmation })}</p> : null}
      {missing.length > 0 ? (
        <div className="mt-2 text-xs text-[var(--ad-text-muted)]" id="announcement-create-missing">
          {editing ? t("Still needed before you can save it:") : t("Still needed before you can create it:")}
          <ul className="mt-1 list-disc pl-5">
            {missing.map((requirement) => <li key={requirement}>{t(requirement)}</li>)}
          </ul>
        </div>
      ) : null}
      {err ? <p role="alert" className="mt-2 text-xs text-[var(--ad-red-text)]">{err}</p> : null}
    </details>
  );
}
