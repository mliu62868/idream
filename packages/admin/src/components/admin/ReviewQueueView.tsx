"use client";

// SPEC: 角色审核队列面板 —— 自取数列出待审（pending）角色提交，逐行 Approve/Reject。
// INTENT: 决策弹窗收集 reviewReason(可选) + reason(必填) + confirmation(submissionId)，复用 safety.review.* 权限。
// INVARIANTS: 仅展示后端返回的 pending 项；决策成功后刷新队列；confirmation 必须等于 submissionId 才允许提交。
import { type KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bookmark, Check, Filter, Loader2, Trash2, X } from "lucide-react";
import {
  savedViewDeleteSchema,
  savedViewListResponseSchema,
  savedViewMutationResponseSchema,
  type SavedView,
  type SavedViewQueryState,
} from "@idream/shared/admin";
import { apiGet, apiWrite } from "@/components/admin/api";
import { adminV2Request } from "@/lib/admin-v2-api";
import { useAdminI18n } from "@/components/admin/i18n";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { WriteFeedbackBanner, requestErrorMessage, useWriteFeedback } from "@/components/admin/section-kit";
import { cn } from "@/lib/utils";

type ReviewCharacter = {
  id: string;
  name: string;
  gender: string;
  style: string;
  visibility: string;
  status: string;
  description: string;
  createdAt: string;
};

type ReviewItem = {
  submissionId: string;
  submittedAt: string;
  character: ReviewCharacter;
  reportCount: number;
};

type Decision = "approve" | "reject";

type PendingDecision = {
  item: ReviewItem;
  decision: Decision;
};

type ReviewDecisionResult = {
  submission: { status: string };
  publication: {
    state: "publication_prep";
    projectId: string;
    revisionId: string;
    servingState: string;
    deepLink: string;
    created: boolean;
  } | null;
};

export function reviewDecisionSuccess(result: ReviewDecisionResult) {
  if (result.submission.status === "approved" && result.publication) {
    return {
      message: "Approved. Awaiting publication: complete assets, QA, and Release before the character goes live.",
      href: result.publication.deepLink,
    };
  }
  return {
    message: result.submission.status === "approved"
      ? "Approved. This decision did not publish the character."
      : "Review decision recorded.",
    href: null,
  };
}

type ReportFilter = "all" | "reported" | "clean";

type SavedReviewQueueFilters = {
  query: string;
  reportFilter: ReportFilter;
};

const REVIEW_QUEUE_SAVED_VIEW_SCOPE = "moderation_review_queue";
const DEFAULT_FILTERS: SavedReviewQueueFilters = { query: "", reportFilter: "all" };
const REPORT_FILTER_OPTIONS: Array<{ value: ReportFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "reported", label: "Reported" },
  { value: "clean", label: "Clean" },
];

export function ReviewQueueView() {
  const { t, value: valueLabel } = useAdminI18n();
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingDecision | null>(null);
  const [filters, setFilters] = useState<SavedReviewQueueFilters>(DEFAULT_FILTERS);
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [savedViewsLoading, setSavedViewsLoading] = useState(true);
  const [savedViewLabel, setSavedViewLabel] = useState("");
  const [savingView, setSavingView] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>();
  const [pageInfo, setPageInfo] = useState({ endCursor: null as string | null, hasNextPage: false });
  const [ready, setReady] = useState(false);
  const [deletingView, setDeletingView] = useState<SavedView | null>(null);
  const [decisionLink, setDecisionLink] = useState<string | null>(null);
  const { feedback, reportSuccess, reportFailure, clearFeedback } = useWriteFeedback();
  const savedViewCreateKey = useRef<string | null>(null);

  const load = useCallback(async (nextCursor?: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: "25" });
      if (filters.query.trim()) params.set("search", filters.query.trim());
      if (filters.reportFilter !== "all") params.set("reportFilter", filters.reportFilter);
      if (nextCursor) params.set("cursor", nextCursor);
      const data = await apiGet<{ items: ReviewItem[]; pageInfo: { endCursor: string | null; hasNextPage: boolean } }>(`/api/v2/admin/content/review-queue?${params}`);
      setItems(data.items);
      setCursor(nextCursor);
      setPageInfo(data.pageInfo);
      window.history.replaceState(null, "", `${window.location.pathname}?${params}`);
    } catch (err) {
      setError(requestErrorMessage(err, t));
    } finally {
      setLoading(false);
    }
  }, [filters.query, filters.reportFilter, t]);

  const loadSavedViews = useCallback(async () => {
    setSavedViewsLoading(true);
    try {
      const data = await adminV2Request(
        `/api/v2/admin/saved-views?scope=${REVIEW_QUEUE_SAVED_VIEW_SCOPE}`,
        { schema: savedViewListResponseSchema },
      );
      setSavedViews([...data.items]);
    } catch (err) {
      reportFailure(requestErrorMessage(err, t));
    } finally {
      setSavedViewsLoading(false);
    }
  }, [reportFailure, t]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const timer = window.setTimeout(() => {
      setFilters({ query: params.get("search") ?? "", reportFilter: isReportFilter(params.get("reportFilter")) ? params.get("reportFilter") as ReportFilter : "all" });
      setCursor(params.get("cursor") ?? undefined);
      setReady(true);
      void loadSavedViews();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadSavedViews]);

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => void load(cursor), filters.query.trim() ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [cursor, filters.query, load, ready]);
  const activeFilterCount =
    (filters.query.trim() ? 1 : 0) + (filters.reportFilter === "all" ? 0 : 1);
  const queueCount = String(items.length);

  async function saveCurrentView() {
    const label = savedViewLabel.trim();
    if (!label || savingView) return;
    setSavingView(true);
    clearFeedback();
    try {
      savedViewCreateKey.current ??= crypto.randomUUID();
      await adminV2Request("/api/v2/admin/saved-views", {
        method: "POST",
        idempotencyKey: savedViewCreateKey.current,
        body: {
          scope: REVIEW_QUEUE_SAVED_VIEW_SCOPE,
          label,
          queryState: savedQueryState(filters),
        },
        schema: savedViewMutationResponseSchema,
      });
      savedViewCreateKey.current = null;
      setSavedViewLabel("");
      await loadSavedViews();
      reportSuccess(t("Saved view {label} saved.", { label }));
    } catch (err) {
      reportFailure(requestErrorMessage(err, t));
    } finally {
      setSavingView(false);
    }
  }

  // SPEC: 删除保存的视图必须先确认——这是本页唯一的破坏性写操作，且服务端不做软删除。
  // INTENT: DELETE 契约（collaboration.ts savedViewDeleteSchema）不收 reason，所以
  // requireReason:false——不让运营填一个会被丢弃的原因。双击防护由 ConfirmDialog 的 busy 守卫兜住。
  // SEAM(consequence): 上游 ConfirmDialog 已加 consequence 字段（不可撤销动作常驻红条 +
  //   DangerButton），本分支的 ConfirmSpec 还没有它。合并时把下面这句从 summary 移到
  //   consequence 即可，文案不用改：
  //   "Deleting is permanent — there is no undo. Pending submissions and past decisions are untouched."
  const deleteViewSpec: ConfirmSpec | null = deletingView
    ? {
        title: t("Delete saved view {label}", { label: deletingView.label }),
        summary: t("Deleting is permanent — there is no undo. Pending submissions and past decisions are untouched."),
        destructive: { expectedName: deletingView.label },
        requireReason: false,
        submitLabel: t("Delete"),
        onSubmit: async () => {
          const view = deletingView;
          await adminV2Request(`/api/v2/admin/saved-views/${encodeURIComponent(view.id)}`, {
            method: "DELETE",
            ifMatch: view.version,
            schema: savedViewDeleteSchema,
          });
          setSavedViews((current) => current.filter((item) => item.id !== view.id));
          reportSuccess(t("Saved view {label} deleted.", { label: view.label }));
        },
      }
    : null;

  function applySavedView(view: SavedView) {
    clearFeedback();
    setFilters(savedFiltersFromQueryState(view.queryState));
    setCursor(undefined);
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-[var(--ad-text-muted)]">
        {t("Human review queue for pending character submissions only. Approve moves the character to approved and into publication prep; it only goes public after Release. Reject moves it to rejected. Both require a reason and are audited.")}
      </p>

      <WriteFeedbackBanner feedback={feedback} onDismiss={clearFeedback} />
      {feedback?.tone === "success" && decisionLink ? (
        <p className="text-xs">
          <a className="font-semibold underline underline-offset-4" href={decisionLink}>{t("Open Character Asset Studio")}</a>
        </p>
      ) : null}

      {error ? <p role="alert" className="text-xs text-[var(--ad-red-text)]">{error}</p> : null}

      <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Search")}</span>
            <input
              aria-label={t("Search review queue")}
              className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm text-[var(--ad-text)] outline-none focus:border-[var(--ad-ink)]"
              name="review-queue-search"
              onChange={(event) => { setFilters((current) => ({ ...current, query: event.target.value })); setCursor(undefined); }}
              placeholder={t("Name, description, or ID")}
              value={filters.query}
            />
          </label>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Report filter")}</span>
            <div
              aria-label={t("Report filter")}
              className="rounded-md inline-flex h-10 border border-[var(--ad-border)]"
              role="group"
            >
              {REPORT_FILTER_OPTIONS.map((option) => (
                <button
                  className={cn(
                    "min-w-20 border-r border-[var(--ad-border)] px-3 text-xs text-[var(--ad-text-muted)] last:border-r-0 hover:text-[var(--ad-ink)]",
                    filters.reportFilter === option.value && "bg-[var(--ad-ink)] text-white hover:text-white",
                  )}
                  key={option.value}
                  onClick={() => { setFilters((current) => ({ ...current, reportFilter: option.value })); setCursor(undefined); }}
                  type="button"
                >
                  {t(option.label)}
                </button>
              ))}
            </div>
          </div>
          <form
            className="flex min-w-0 flex-col gap-1 sm:min-w-[300px]"
            onSubmit={(event) => {
              event.preventDefault();
              void saveCurrentView();
            }}
          >
            <span className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Saved view")}</span>
            <div className="flex gap-2">
              <input
                aria-label={t("Saved view label")}
                className="rounded-md h-10 min-w-0 flex-1 border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm text-[var(--ad-text)] outline-none focus:border-[var(--ad-ink)]"
                name="review-queue-saved-view-label"
                onChange={(event) => {
                  setSavedViewLabel(event.target.value);
                  savedViewCreateKey.current = null;
                }}
                placeholder={t("Saved view label")}
                value={savedViewLabel}
              />
              <button
                className="inline-flex h-10 shrink-0 items-center gap-2 bg-[var(--ad-ink)] px-3 text-sm font-semibold text-white disabled:opacity-50"
                disabled={!savedViewLabel.trim() || savingView}
                type="submit"
              >
                {savingView ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bookmark className="h-4 w-4" />}
                {t("Save view")}
              </button>
            </div>
          </form>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-2 text-xs font-semibold text-[var(--ad-text-muted)]">
            <Filter className="h-4 w-4" />
            {t("Saved views")}
          </span>
          {savedViews.map((view) => (
            <span className="rounded-md inline-flex h-8 items-center border border-[var(--ad-border)]" key={view.id}>
              <button
                className="h-full px-3 text-xs text-[var(--ad-text)] hover:bg-black/[0.04]"
                onClick={() => applySavedView(view)}
                type="button"
              >
                {view.label}
              </button>
              <button
                aria-label={t("Delete saved view {label}", { label: view.label })}
                className="flex h-full w-8 items-center justify-center border-l border-[var(--ad-border)] text-[var(--ad-text-muted)] hover:text-[var(--ad-ink)]"
                onClick={() => setDeletingView(view)}
                title={t("Delete saved view {label}", { label: view.label })}
                type="button"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
          {savedViewsLoading ? (
            <span className="text-xs text-[var(--ad-text-muted)]">{t("Loading…")}</span>
          ) : null}
          {!savedViewsLoading && savedViews.length === 0 ? (
            <span className="text-xs text-[var(--ad-text-muted)]">{t("No saved views.")}</span>
          ) : null}
          {activeFilterCount > 0 ? (
            <button
              className="rounded-lg h-8 border border-[var(--ad-border)] px-3 text-xs text-[var(--ad-text)] hover:border-[var(--ad-ink)]"
              onClick={() => { setFilters(DEFAULT_FILTERS); setCursor(undefined); }}
              type="button"
            >
              {t("Reset filters")}
            </button>
          ) : null}
        </div>
      </section>

      <section className="rounded-lg overflow-hidden border border-[var(--ad-border)] bg-[var(--ad-surface)]">
        <div className="flex h-11 items-center justify-between border-b border-[var(--ad-border)] px-4">
          <h2 className="text-sm font-semibold">{t("Pending submissions")}</h2>
          <span className="text-xs text-[var(--ad-text-muted)]">{queueCount}</span>
        </div>
        <div
          aria-label={t("{caption} scrollable table", { caption: t("Pending character submissions") })}
          className="overflow-x-auto"
          role="region"
          tabIndex={0}
        >
          <table className="w-full min-w-[860px] border-collapse text-left text-sm">
            <caption className="sr-only">{t("Pending character submissions")}</caption>
            <thead className="bg-black/[0.03] text-[11px] uppercase text-[var(--ad-text-muted)]">
              <tr>
                {["Name", "Gender", "Style", "Description", "Reports", "submittedAt"].map((column) => (
                  <th key={column} className="border-b border-[var(--ad-border)] px-3 py-2 font-semibold" scope="col">
                    {t(column)}
                  </th>
                ))}
                <th className="sticky right-0 z-10 border-b border-l border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 py-2 font-semibold" scope="col">{t("Actions")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.submissionId} className="border-b border-[var(--ad-border)] last:border-0">
                  <td className="px-3 py-2 align-top text-[var(--ad-text)]">{item.character.name}</td>
                  <td className="px-3 py-2 align-top text-[var(--ad-text)]">{valueLabel(item.character.gender)}</td>
                  <td className="px-3 py-2 align-top text-[var(--ad-text)]">{valueLabel(item.character.style)}</td>
                  <td className="max-w-[260px] px-3 py-2 align-top text-[var(--ad-text)]">
                    {truncate(item.character.description, 120)}
                  </td>
                  <td className="px-3 py-2 align-top text-[var(--ad-text)]">
                    <span className={cn(item.reportCount > 0 && "text-[var(--ad-yellow-text)]")}>{item.reportCount}</span>
                  </td>
                  <td className="px-3 py-2 align-top text-[var(--ad-text-muted)]">{formatDate(item.submittedAt)}</td>
                  <td className="sticky right-0 z-10 border-l border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 py-2 align-top">
                    <div className="flex gap-1">
                      <button
                        className="rounded-md inline-flex h-8 items-center gap-1 border border-[var(--ad-border)] px-2 text-xs text-[var(--ad-text)] hover:border-[var(--ad-ink)]"
                        onClick={() => setPending({ item, decision: "approve" })}
                        title={t("Approve")}
                        type="button"
                      >
                        <Check className="h-4 w-4" />
                        {t("Approve")}
                      </button>
                      <button
                        className="rounded-md inline-flex h-8 items-center gap-1 border border-[var(--ad-border)] px-2 text-xs text-[var(--ad-text)] hover:border-[var(--ad-ink)]"
                        onClick={() => setPending({ item, decision: "reject" })}
                        title={t("Reject")}
                        type="button"
                      >
                        <X className="h-4 w-4" />
                        {t("Reject")}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {items.length === 0 && !error ? (
                <tr>
                  <td className="px-3 py-10 text-center" colSpan={7}>
                    {loading ? (
                      <span className="text-sm text-[var(--ad-text-muted)]">{t("Loading…")}</span>
                    ) : activeFilterCount > 0 ? (
                      <div>
                        <p className="text-sm font-semibold text-[var(--ad-ink)]">{t("No submissions match filters")}</p>
                        <button className="mt-2 text-xs text-[var(--ad-text-muted)] underline underline-offset-4" onClick={() => { setFilters(DEFAULT_FILTERS); setCursor(undefined); }} type="button">{t("Reset filters")}</button>
                      </div>
                    ) : (
                      <div>
                        <p className="text-sm font-semibold text-[var(--ad-ink)]">{t("Review queue is clear")}</p>
                        <p className="mt-1 text-xs text-[var(--ad-text-muted)]">{t("New pending character submissions will appear here with their report context and decision actions.")}</p>
                      </div>
                    )}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
      <div className="flex justify-end"><button className="min-h-10 rounded-md border border-[var(--ad-border)] px-4 text-sm font-semibold disabled:opacity-50" disabled={loading || !pageInfo.hasNextPage || !pageInfo.endCursor} onClick={() => setCursor(pageInfo.endCursor ?? undefined)} type="button">{t("Next page")}</button></div>

      {pending ? (
        <DecisionDialog
          pending={pending}
          onClose={() => setPending(null)}
          onDone={async (result) => {
            const outcome = reviewDecisionSuccess(result);
            setDecisionLink(outcome.href);
            reportSuccess(t(outcome.message));
            setPending(null);
            await load(cursor);
          }}
        />
      ) : null}

      {deleteViewSpec ? <ConfirmDialog onClose={() => setDeletingView(null)} spec={deleteViewSpec} /> : null}
    </div>
  );
}

function DecisionDialog({
  pending,
  onClose,
  onDone,
}: {
  pending: PendingDecision;
  onClose: () => void;
  onDone: (result: ReviewDecisionResult) => Promise<void>;
}) {
  const { t, value: valueLabel } = useAdminI18n();
  const { item, decision } = pending;
  const [reviewReason, setReviewReason] = useState("");
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const idempotencyKey = useRef<string | null>(null);
  const titleId = useId();

  const canSubmit = reason.trim().length >= 3 && confirmation === item.submissionId && !busy;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const background = document.getElementById("admin-shell-background");
    const skipLink = document.getElementById("admin-skip-link");
    background?.setAttribute("aria-hidden", "true");
    skipLink?.setAttribute("aria-hidden", "true");
    if (background instanceof HTMLElement) background.inert = true;
    if (skipLink instanceof HTMLElement) skipLink.inert = true;
    const timer = window.setTimeout(() => dialogRef.current?.querySelector<HTMLElement>("textarea, input, button")?.focus(), 0);
    return () => {
      window.clearTimeout(timer);
      background?.removeAttribute("aria-hidden");
      skipLink?.removeAttribute("aria-hidden");
      if (background instanceof HTMLElement) background.inert = false;
      if (skipLink instanceof HTMLElement) skipLink.inert = false;
      previousFocus?.focus();
    };
  }, []);

  function onDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
    ) ?? [])];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const requestKey = idempotencyKey.current ?? crypto.randomUUID();
    idempotencyKey.current = requestKey;
    try {
      const result = await apiWrite<ReviewDecisionResult>(
        `/api/v2/admin/content/review-queue/${item.submissionId}/decision`,
        "POST",
        {
          decision,
          reviewReason: reviewReason.trim() || undefined,
          reason: reason.trim(),
          confirmation,
        },
        { "idempotency-key": requestKey },
      );
      await onDone(result);
    } catch (err) {
      setError(requestErrorMessage(err, t));
      setBusy(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className="rounded-lg w-full max-w-md border border-[var(--ad-border)] bg-[var(--ad-surface)] p-5"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onDialogKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <h3 className="text-sm font-semibold" id={titleId}>
          {decision === "approve" ? t("Approve") : t("Reject")} {item.character.name}
        </h3>
        <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
          {t("On submit this character becomes {status}.", {
            status: valueLabel(decision === "approve" ? "approved" : "rejected"),
          })}
          {decision === "approve"
            ? ` ${t("Approval only starts publication prep — Asset, QA and Release must still complete before it goes live.")}`
            : null}
        </p>
        <div className="mt-4 space-y-3">
          <textarea
            className="rounded-md min-h-16 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--ad-ink)]"
            name="review-note"
            onChange={(event) => setReviewReason(event.target.value)}
            placeholder={t("Review note (optional, shown to creator)")}
            value={reviewReason}
          />
          <input
            className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
            name="audit-reason"
            onChange={(event) => setReason(event.target.value)}
            placeholder={t("Audit reason (≥3)")}
            value={reason}
          />
          <input
            className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 font-mono text-sm outline-none focus:border-[var(--ad-ink)]"
            name="approval-confirmation"
            onChange={(event) => setConfirmation(event.target.value)}
            placeholder={t("Type {token} to confirm", { token: item.submissionId })}
            value={confirmation}
          />
          {error ? <p role="alert" className="text-xs text-[var(--ad-red-text)]">{error}</p> : null}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            className="rounded-md inline-flex h-10 items-center border border-[var(--ad-border)] px-3 text-sm text-[var(--ad-text)]"
            onClick={onClose}
            type="button"
          >
            {t("Cancel")}
          </button>
          <button
            className="inline-flex h-10 items-center gap-2 bg-[var(--ad-ink)] px-3 text-sm font-semibold text-white disabled:opacity-50"
            disabled={!canSubmit}
            onClick={() => void submit()}
            type="button"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t("Confirm")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function truncate(value: string, max: number) {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function savedQueryState(filters: SavedReviewQueueFilters): SavedViewQueryState {
  return {
    search: filters.query.trim(),
    filters: { reportFilter: filters.reportFilter },
    sort: { field: "created_at", direction: "asc" },
    pageSize: 25,
  };
}

function savedFiltersFromQueryState(state: SavedViewQueryState): SavedReviewQueueFilters {
  return {
    query: state.search,
    reportFilter: isReportFilter(state.filters.reportFilter) ? state.filters.reportFilter : "all",
  };
}

function isReportFilter(value: unknown): value is ReportFilter {
  return value === "all" || value === "reported" || value === "clean";
}
