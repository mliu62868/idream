"use client";

// SPEC: 角色审核队列面板 —— 自取数列出待审（pending）角色提交，逐行 Approve/Reject。
// INTENT: 决策弹窗收集 reviewReason(可选) + reason(必填) + confirmation(submissionId)，复用 safety.review.* 权限。
// INVARIANTS: 仅展示后端返回的 pending 项；决策成功后刷新队列；confirmation 必须等于 submissionId 才允许提交。
import { useCallback, useEffect, useMemo, useState } from "react";
import { Bookmark, Check, Filter, Loader2, Trash2, X } from "lucide-react";
import { apiDelete, apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
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

type ReportFilter = "all" | "reported" | "clean";

type SavedReviewQueueFilters = {
  query: string;
  reportFilter: ReportFilter;
};

type SavedView = {
  id: string;
  scope: string;
  label: string;
  filters: unknown;
  createdAt: string;
  updatedAt: string;
};

const REVIEW_QUEUE_SAVED_VIEW_SCOPE = "moderation.review_queue";
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
  const [savedViewError, setSavedViewError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ items: ReviewItem[] }>("/api/v1/admin/content/review-queue");
      setItems(data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSavedViews = useCallback(async () => {
    setSavedViewsLoading(true);
    setSavedViewError(null);
    try {
      const data = await apiGet<{ items: SavedView[] }>(
        `/api/v1/admin/saved-views?scope=${encodeURIComponent(REVIEW_QUEUE_SAVED_VIEW_SCOPE)}`,
      );
      setSavedViews(data.items);
    } catch (err) {
      setSavedViewError(err instanceof Error ? err.message : "Saved views failed");
    } finally {
      setSavedViewsLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
      void loadSavedViews();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load, loadSavedViews]);

  const visibleItems = useMemo(
    () => items.filter((item) => matchesReviewFilters(item, filters)),
    [filters, items],
  );
  const activeFilterCount =
    (filters.query.trim() ? 1 : 0) + (filters.reportFilter === "all" ? 0 : 1);
  const queueCount = activeFilterCount > 0 ? `${visibleItems.length}/${items.length}` : String(items.length);

  async function saveCurrentView() {
    const label = savedViewLabel.trim();
    if (!label || savingView) return;
    setSavingView(true);
    setSavedViewError(null);
    try {
      await apiWrite<{ view: SavedView }>("/api/v1/admin/saved-views", "POST", {
        scope: REVIEW_QUEUE_SAVED_VIEW_SCOPE,
        label,
        filters: normalizeFilters(filters),
      });
      setSavedViewLabel("");
      await loadSavedViews();
    } catch (err) {
      setSavedViewError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSavingView(false);
    }
  }

  async function deleteSavedView(view: SavedView) {
    setSavedViewError(null);
    try {
      await apiDelete<{ deleted: true }>(`/api/v1/admin/saved-views/${view.id}`);
      setSavedViews((current) => current.filter((item) => item.id !== view.id));
    } catch (err) {
      setSavedViewError(err instanceof Error ? err.message : "Delete failed");
    }
  }

  function applySavedView(view: SavedView) {
    setSavedViewError(null);
    setFilters(savedFiltersFromUnknown(view.filters));
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-[var(--ad-text-muted)]">
        角色人审队列：仅展示 status=pending 的提交。Approve 将角色置为 approved，Reject 置为 rejected，均需理由并审计。
      </p>

      {error ? <p className="text-xs text-[var(--ad-red-text)]">{error}</p> : null}

      <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Search")}</span>
            <input
              aria-label={t("Search review queue")}
              className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm text-[var(--ad-text)] outline-none focus:border-[var(--ad-ink)]"
              name="review-queue-search"
              onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
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
                  onClick={() => setFilters((current) => ({ ...current, reportFilter: option.value }))}
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
                onChange={(event) => setSavedViewLabel(event.target.value)}
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
                onClick={() => void deleteSavedView(view)}
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
              onClick={() => setFilters(DEFAULT_FILTERS)}
              type="button"
            >
              {t("Reset filters")}
            </button>
          ) : null}
        </div>
        {savedViewError ? <p className="mt-2 text-xs text-[var(--ad-red-text)]">{savedViewError}</p> : null}
      </section>

      <section className="rounded-lg overflow-hidden border border-[var(--ad-border)] bg-[var(--ad-surface)]">
        <div className="flex h-11 items-center justify-between border-b border-[var(--ad-border)] px-4">
          <h2 className="text-sm font-semibold">{t("Pending submissions")}</h2>
          <span className="text-xs text-[var(--ad-text-muted)]">{queueCount}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] border-collapse text-left text-sm">
            <thead className="bg-black/[0.03] text-[11px] uppercase text-[var(--ad-text-muted)]">
              <tr>
                {["name", "gender", "style", "description", "reports", "submittedAt"].map((column) => (
                  <th key={column} className="border-b border-[var(--ad-border)] px-3 py-2 font-semibold">
                    {t(column)}
                  </th>
                ))}
                <th className="border-b border-[var(--ad-border)] px-3 py-2 font-semibold">{t("Actions")}</th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((item) => (
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
                  <td className="px-3 py-2 align-top">
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
              {visibleItems.length === 0 ? (
                <tr>
                  <td className="px-3 py-10 text-center" colSpan={7}>
                    {loading ? (
                      <span className="text-sm text-[var(--ad-text-muted)]">{t("Loading…")}</span>
                    ) : activeFilterCount > 0 ? (
                      <div>
                        <p className="text-sm font-semibold text-[var(--ad-ink)]">{t("No submissions match filters")}</p>
                        <button className="mt-2 text-xs text-[var(--ad-text-muted)] underline underline-offset-4" onClick={() => setFilters(DEFAULT_FILTERS)} type="button">{t("Reset filters")}</button>
                      </div>
                    ) : (
                      <div>
                        <p className="text-sm font-semibold text-[var(--ad-ink)]">Review queue is clear</p>
                        <p className="mt-1 text-xs text-[var(--ad-text-muted)]">New pending character submissions will appear here with their report context and decision actions.</p>
                      </div>
                    )}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {pending ? (
        <DecisionDialog
          pending={pending}
          onClose={() => setPending(null)}
          onDone={async () => {
            setPending(null);
            await load();
          }}
        />
      ) : null}
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
  onDone: () => Promise<void>;
}) {
  const { t, value: valueLabel } = useAdminI18n();
  const { item, decision } = pending;
  const [reviewReason, setReviewReason] = useState("");
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = reason.trim().length >= 3 && confirmation === item.submissionId && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await apiWrite(
        `/api/v1/admin/content/review-queue/${item.submissionId}/decision`,
        "POST",
        {
          decision,
          reviewReason: reviewReason.trim() || undefined,
          reason: reason.trim(),
          confirmation,
        },
      );
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Decision failed");
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="rounded-lg w-full max-w-md border border-[var(--ad-border)] bg-[var(--ad-surface)] p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 className="text-sm font-semibold">
          {decision === "approve" ? t("Approve") : t("Reject")} {item.character.name}
        </h3>
        <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
          确认提交后角色将被置为 {decision === "approve" ? valueLabel("approved") : valueLabel("rejected")}。
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
          {error ? <p className="text-xs text-[var(--ad-red-text)]">{error}</p> : null}
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
    </div>
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

function normalizeFilters(filters: SavedReviewQueueFilters): SavedReviewQueueFilters {
  return {
    query: filters.query.trim(),
    reportFilter: filters.reportFilter,
  };
}

function savedFiltersFromUnknown(value: unknown): SavedReviewQueueFilters {
  if (typeof value !== "object" || value === null) return DEFAULT_FILTERS;
  const record = value as Record<string, unknown>;
  const query = typeof record.query === "string" ? record.query : "";
  const reportFilter = isReportFilter(record.reportFilter) ? record.reportFilter : "all";
  return { query, reportFilter };
}

function isReportFilter(value: unknown): value is ReportFilter {
  return value === "all" || value === "reported" || value === "clean";
}

function matchesReviewFilters(item: ReviewItem, filters: SavedReviewQueueFilters) {
  if (filters.reportFilter === "reported" && item.reportCount === 0) return false;
  if (filters.reportFilter === "clean" && item.reportCount > 0) return false;

  const query = filters.query.trim().toLowerCase();
  if (!query) return true;
  const haystack = [
    item.submissionId,
    item.character.id,
    item.character.name,
    item.character.description,
    item.character.gender,
    item.character.style,
    item.character.visibility,
    item.character.status,
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}
