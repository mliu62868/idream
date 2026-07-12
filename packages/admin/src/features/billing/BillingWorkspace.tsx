"use client";

import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { BadgeDollarSign, Loader2, RefreshCcw, X } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { DataTable, type DataTableRow } from "@/components/admin/ui/DataTable";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { createLatestRequestGate } from "@/lib/latest-request";
import {
  billingAdjustmentConfirmation,
  billingLedgerPath,
  billingQueryFromSearch,
  billingSubscriptionsPath,
  billingWorkspaceUrl,
  defaultBillingQuery,
  isBillingQueryFiltered,
  type BillingQuery,
} from "./query";

type BillingRecord = Record<string, unknown>;
type BillingPageInfo = { endCursor: string | null; hasNextPage: boolean };
type BillingListResponse = { items: BillingRecord[]; pageInfo?: BillingPageInfo };
type BillingReconciliation = {
  window: { from: string; to: string };
  activeSubscriptions: number;
  byReason: BillingRecord[];
  totals: { net: number; entries: number };
};
type BillingSnapshot = {
  ledger: BillingListResponse;
  subscriptions: BillingListResponse;
  reconciliation: BillingReconciliation;
};
type AdjustmentDraft = { userId: string; delta: string };

const emptyPageInfo: BillingPageInfo = { endCursor: null, hasNextPage: false };
const emptyAdjustment: AdjustmentDraft = { userId: "", delta: "" };

export function BillingWorkspace({ canAdjust }: { canAdjust: boolean }) {
  const [query, setQuery] = useState<BillingQuery>(() => currentQuery());
  const [queryDraft, setQueryDraft] = useState<BillingQuery>(() => currentQuery());
  const [snapshot, setSnapshot] = useState<BillingSnapshot | null>(null);
  const [adjustment, setAdjustment] = useState<AdjustmentDraft>(emptyAdjustment);
  const [confirmation, setConfirmation] = useState<ConfirmSpec | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const requestGate = useRef(createLatestRequestGate());
  const initialQuery = useRef(query);

  const load = useCallback(async (next: BillingQuery) => {
    const request = requestGate.current.begin();
    setLoading(true);
    setError(null);
    try {
      const [ledger, subscriptions, reconciliation] = await Promise.all([
        apiGet<BillingListResponse>(billingLedgerPath(next)),
        apiGet<BillingListResponse>(billingSubscriptionsPath(next)),
        apiGet<BillingReconciliation>("/api/v1/admin/billing/reconciliation"),
      ]);
      if (!request.isCurrent()) return;
      setSnapshot({ ledger, subscriptions, reconciliation });
      setRefreshedAt(new Date().toISOString());
    } catch (cause) {
      if (request.isCurrent()) {
        setError(cause instanceof Error ? cause.message : "Billing authority request failed");
      }
    } finally {
      if (request.isCurrent()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const gate = requestGate.current;
    void load(initialQuery.current);
    const restore = () => {
      const restored = currentQuery();
      setQuery(restored);
      setQueryDraft(restored);
      void load(restored);
    };
    window.addEventListener("popstate", restore);
    return () => {
      gate.invalidate();
      window.removeEventListener("popstate", restore);
    };
  }, [load]);

  function navigate(next: BillingQuery, mode: "push" | "replace" = "push") {
    const url = billingWorkspaceUrl(window.location.pathname, window.location.search, {
      billingSearch: next.search || null,
      ledgerReason: next.ledgerReason || null,
      subscriptionStatus: next.subscriptionStatus || null,
      ledgerCursor: next.ledgerCursor || null,
      subscriptionCursor: next.subscriptionCursor || null,
    });
    window.history[mode === "push" ? "pushState" : "replaceState"](null, "", url);
    setQuery(next);
    setQueryDraft(next);
    void load(next);
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate({ ...queryDraft, ledgerCursor: "", subscriptionCursor: "" });
  }

  function clearFilters() {
    navigate(defaultBillingQuery);
  }

  function requestAdjustment() {
    if (!canAdjust) return;
    const userId = adjustment.userId.trim();
    const delta = Number(adjustment.delta);
    if (!userId || !Number.isFinite(delta) || delta === 0) return;
    const confirmationTarget = billingAdjustmentConfirmation(userId, delta);
    const idempotencyKey = crypto.randomUUID();
    setConfirmation({
      title: `Adjust ledger ${userId}`,
      summary: <span>User {userId} · signed delta {delta}</span>,
      destructive: { expectedName: confirmationTarget, inputLabel: "Confirmation" },
      reasonLabel: "Reason",
      submitLabel: "Confirm",
      onSubmit: async (reason) => {
        await apiWrite(
          "/api/v1/admin/billing/adjustments",
          "POST",
          { userId, delta, reason, confirmation: confirmationTarget },
          { "idempotency-key": idempotencyKey },
        );
        setAdjustment(emptyAdjustment);
        setNotice(`Adjust ledger ${userId} completed.`);
        const next = { ...query, ledgerCursor: "" };
        navigate(next, "replace");
      },
    });
  }

  const filtered = isBillingQueryFiltered(query);
  const ledger = snapshot?.ledger.items ?? [];
  const subscriptions = snapshot?.subscriptions.items ?? [];
  const reconciliation = snapshot?.reconciliation;
  return (
    <section aria-labelledby="billing-workspace-title" className="space-y-5">
      <div id="billing-workspace-title">
        <PageHeader
          purpose="Reconcile subscription and Dreamcoin authority, then make tightly audited ledger corrections."
          title="Billing & Ledger"
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--ad-text-muted)]" role="status">
        <span>
          Legacy compatibility authority · freshness watermark unavailable
          {refreshedAt ? <> · refreshed <time dateTime={refreshedAt}>{new Date(refreshedAt).toLocaleTimeString()}</time></> : null}
        </span>
        {!canAdjust ? <strong>Read only · billing.ledger.adjust is not granted</strong> : null}
      </div>

      <form className="grid gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 md:grid-cols-2 xl:grid-cols-[minmax(260px,1fr)_200px_220px_auto]" onSubmit={apply}>
        <Field label="Search billing authority" onChange={(search) => setQueryDraft((current) => ({ ...current, search }))} placeholder="user, email, subscription, or source" value={queryDraft.search} />
        <Select label="Ledger reason" onChange={(ledgerReason) => setQueryDraft((current) => ({ ...current, ledgerReason }))} options={["", "signup_bonus", "subscription_grant", "generation_spend", "refund", "redeem", "referral", "admin_adjust"]} value={queryDraft.ledgerReason} />
        <Select label="Subscription status" onChange={(subscriptionStatus) => setQueryDraft((current) => ({ ...current, subscriptionStatus }))} options={["", "checkout_created", "checkout_completed", "active", "past_due", "canceled", "expired"]} value={queryDraft.subscriptionStatus} />
        <div className="flex items-end gap-2">
          <button className="min-h-11 rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white" type="submit">Apply</button>
          {filtered ? <button aria-label="Clear billing filters" className="grid min-h-11 min-w-11 place-items-center rounded-md border border-[var(--ad-border)]" onClick={clearFilters} type="button"><X className="h-4 w-4" /></button> : null}
        </div>
      </form>

      {canAdjust ? (
        <section aria-labelledby="billing-adjustment-title" className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h3 className="font-semibold" id="billing-adjustment-title">Adjust Ledger</h3><p className="mt-1 text-xs text-[var(--ad-text-muted)]">Every signed delta requires a reason, target confirmation, unique idempotency key, and server-side audit.</p></div>
            <button className="inline-flex min-h-11 items-center gap-2 rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white disabled:opacity-50" disabled={!canAdjustLedger(adjustment)} onClick={requestAdjustment} type="button"><BadgeDollarSign className="h-4 w-4" />Adjust</button>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <Field label="Adjustment user ID" onChange={(userId) => setAdjustment((current) => ({ ...current, userId }))} value={adjustment.userId} />
            <Field label="Adjustment delta" onChange={(delta) => setAdjustment((current) => ({ ...current, delta }))} value={adjustment.delta} />
          </div>
        </section>
      ) : null}

      {notice ? <p className="rounded-md bg-[var(--ad-green-bg)] p-3 text-sm text-[var(--ad-green-text)]" data-testid="admin-action-status" role="status">{notice}</p> : null}
      {error ? <div className="rounded-md bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]" role="alert">{error}<button className="ml-3 min-h-8 rounded border border-current px-2 font-semibold" onClick={() => void load(query)} type="button">Retry</button></div> : null}
      {loading && snapshot === null ? <BillingLoading /> : reconciliation ? (
        <>
          <div className="grid gap-px overflow-hidden rounded-lg border border-[var(--ad-border)] bg-black/[0.05] md:grid-cols-3">
            <Metric label="Net coins (window)" meta={`${reconciliation.totals.entries} ledger entries`} value={String(reconciliation.totals.net)} />
            <Metric label="Active subscriptions" meta="status = active" value={String(reconciliation.activeSubscriptions)} />
            <Metric label="Window" meta={date(reconciliation.window.to)} value={`${date(reconciliation.window.from)} →`} />
          </div>
          <DataTable caption="Reconciliation by reason" headers={["Reason", "Total delta", "Count"]} rows={tableRows(reconciliation.byReason, ["reason", "totalDelta", "count"], "reconciliation")} />
          <DataTable caption="Subscriptions" empty={<BillingEmpty filtered={Boolean(query.search || query.subscriptionStatus)} kind="subscriptions" onClear={clearFilters} />} headers={["ID", "User", "Email", "Plan", "Period", "Provider", "Status", "Period end", "Cancel at end"]} rows={tableRows(subscriptions, ["id", "userId", "userEmail", "plan", "billingPeriod", "provider", "status", "currentPeriodEnd", "cancelAtPeriodEnd"], "subscription")} />
          <NextPageButton label="Next subscription page" loading={loading} onClick={() => navigate({ ...query, subscriptionCursor: snapshot.subscriptions.pageInfo?.endCursor ?? "" })} pageInfo={snapshot.subscriptions.pageInfo ?? emptyPageInfo} />
          <DataTable caption="Ledger" empty={<BillingEmpty filtered={Boolean(query.search || query.ledgerReason)} kind="ledger entries" onClear={clearFilters} />} headers={["ID", "User", "Email", "Delta", "Balance after", "Reason", "Source", "Created"]} rows={tableRows(ledger, ["id", "userId", "userEmail", "delta", "balanceAfter", "reason", "sourceId", "createdAt"], "ledger")} />
          <NextPageButton label="Next ledger page" loading={loading} onClick={() => navigate({ ...query, ledgerCursor: snapshot.ledger.pageInfo?.endCursor ?? "" })} pageInfo={snapshot.ledger.pageInfo ?? emptyPageInfo} />
        </>
      ) : null}
      {confirmation ? <ConfirmDialog onClose={() => setConfirmation(null)} spec={confirmation} /> : null}
    </section>
  );
}

function BillingLoading() {
  return <div aria-label="Loading billing authority" className="space-y-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4" role="status"><span className="inline-flex items-center gap-2 text-sm text-[var(--ad-text-muted)]"><Loader2 className="h-4 w-4 animate-spin" />Loading billing authority</span>{[0, 1, 2].map((row) => <span aria-hidden="true" className="block h-12 animate-pulse rounded bg-black/5" key={row} />)}</div>;
}

function BillingEmpty({ filtered, kind, onClear }: { filtered: boolean; kind: string; onClear: () => void }) {
  const title = filtered
    ? kind === "ledger entries"
      ? "No ledger entries match these filters"
      : "No subscriptions match these filters"
    : kind === "ledger entries"
      ? "No ledger entries exist yet"
      : "No subscriptions exist yet";
  return <EmptyState action={filtered ? <button className="min-h-11 rounded-md border border-[var(--ad-border)] px-4 text-sm font-semibold" onClick={onClear} type="button">Clear filters</button> : undefined} hint={filtered ? `The complete authority query returned no ${kind}.` : `No ${kind} exist in the authority yet.`} title={title} />;
}

function NextPageButton({ label, loading, onClick, pageInfo }: { label: string; loading: boolean; onClick: () => void; pageInfo: BillingPageInfo }) {
  if (!pageInfo.hasNextPage || !pageInfo.endCursor) return null;
  return <button className="inline-flex min-h-11 items-center gap-2 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-4 text-sm font-semibold" disabled={loading} onClick={onClick} type="button"><RefreshCcw className="h-4 w-4" />{label}</button>;
}

function Metric({ label, meta, value }: { label: string; meta: string; value: string }) {
  return <div className="bg-[var(--ad-surface)] p-4"><p className="text-xs font-semibold uppercase tracking-[0.05em] text-[var(--ad-text-muted)]">{label}</p><p className="mt-2 text-2xl font-semibold">{value}</p><p className="mt-1 text-xs text-[var(--ad-text-muted)]">{meta}</p></div>;
}

function Field({ label, onChange, placeholder, value }: { label: string; onChange: (value: string) => void; placeholder?: string; value: string }) {
  return <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{label}<input className="min-h-11 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2" onChange={(event) => onChange(event.target.value)} placeholder={placeholder} value={value} /></label>;
}

function Select({ label, onChange, options, value }: { label: string; onChange: (value: string) => void; options: readonly string[]; value: string }) {
  return <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{label}<select className="min-h-11 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm" onChange={(event) => onChange(event.target.value)} value={value}>{options.map((option) => <option key={option || "all"} value={option}>{option || "All"}</option>)}</select></label>;
}

function tableRows(rows: BillingRecord[], keys: readonly string[], prefix: string): DataTableRow[] {
  return rows.map((row, index) => ({
    id: text(row.id) || `${prefix}-${index}`,
    cells: keys.map((key) => display(row[key])),
  }));
}

function canAdjustLedger(draft: AdjustmentDraft) {
  const delta = Number(draft.delta);
  return Boolean(draft.userId.trim() && Number.isFinite(delta) && delta !== 0);
}

function currentQuery() {
  return typeof window === "undefined" ? defaultBillingQuery : billingQueryFromSearch(window.location.search);
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function display(value: unknown): ReactNode {
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number" || typeof value === "string") return String(value);
  return "—";
}

function date(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}
