"use client";

import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BadgeDollarSign,
  Loader2,
  ReceiptText,
  RefreshCcw,
  X,
} from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { DataTable, type DataTableRow } from "@/components/admin/ui/DataTable";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { createLatestRequestGate } from "@/lib/latest-request";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import {
  billingAdjustmentConfirmation,
  billingLedgerPath,
  billingQueryFromSearch,
  billingRefundAcknowledgementConfirmation,
  billingSubscriptionsPath,
  billingWorkspaceUrl,
  defaultBillingQuery,
  isBillingQueryFiltered,
  isRefundAcknowledgementCandidate,
  parseLedgerAdjustmentDelta,
  type BillingQuery,
} from "./query";

type BillingRecord = Record<string, unknown>;
type BillingPageInfo = { endCursor: string | null; hasNextPage: boolean };
type BillingDataScope = {
  kind: "customer";
  includedDataClasses: string[];
  excludedDataClasses: string[];
};
type BillingListResponse = {
  dataScope: BillingDataScope;
  items: BillingRecord[];
  pageInfo?: BillingPageInfo;
};
type BillingReconciliation = {
  dataScope: BillingDataScope;
  window: { from: string; to: string };
  activeSubscriptions: number;
  checkoutExceptions: BillingRecord[];
  byReason: BillingRecord[];
  totals: { net: number; entries: number };
};
type AdjustmentDraft = { userId: string; delta: string };
type AuthorityState<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  refreshedAt: string | null;
};

const emptyPageInfo: BillingPageInfo = { endCursor: null, hasNextPage: false };
const emptyAdjustment: AdjustmentDraft = { userId: "", delta: "" };
const emptyAuthorityState = <T,>(): AuthorityState<T> => ({
  data: null,
  error: null,
  loading: true,
  refreshedAt: null,
});

export function BillingWorkspace({
  canAdjust,
  canReconcile,
}: {
  canAdjust: boolean;
  canReconcile: boolean;
}) {
  const [query, setQuery] = useState<BillingQuery>(() => currentQuery());
  const [queryDraft, setQueryDraft] = useState<BillingQuery>(() => currentQuery());
  const [ledgerState, setLedgerState] = useState<AuthorityState<BillingListResponse>>(emptyAuthorityState);
  const [subscriptionState, setSubscriptionState] = useState<AuthorityState<BillingListResponse>>(emptyAuthorityState);
  const [reconciliationState, setReconciliationState] = useState<AuthorityState<BillingReconciliation>>(emptyAuthorityState);
  const [adjustment, setAdjustment] = useState<AdjustmentDraft>(emptyAdjustment);
  const [refundReference, setRefundReference] = useState("");
  const [confirmation, setConfirmation] = useState<ConfirmSpec | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestGates = useRef({
    ledger: createLatestRequestGate(),
    subscriptions: createLatestRequestGate(),
    reconciliation: createLatestRequestGate(),
  });
  const initialQuery = useRef(query);

  const loadLedger = useCallback(async (next: BillingQuery) => {
    const request = requestGates.current.ledger.begin();
    setLedgerState((current) => ({ ...current, error: null, loading: true }));
    try {
      const data = await apiGet<BillingListResponse>(billingLedgerPath(next));
      if (!request.isCurrent()) return;
      setLedgerState({ data, error: null, loading: false, refreshedAt: new Date().toISOString() });
    } catch (cause) {
      if (request.isCurrent()) {
        setLedgerState((current) => ({
          ...current,
          error: cause instanceof Error ? cause.message : "Ledger authority request failed",
          loading: false,
        }));
      }
    }
  }, []);

  const loadSubscriptions = useCallback(async (next: BillingQuery) => {
    const request = requestGates.current.subscriptions.begin();
    setSubscriptionState((current) => ({ ...current, error: null, loading: true }));
    try {
      const data = await apiGet<BillingListResponse>(billingSubscriptionsPath(next));
      if (!request.isCurrent()) return;
      setSubscriptionState({ data, error: null, loading: false, refreshedAt: new Date().toISOString() });
    } catch (cause) {
      if (request.isCurrent()) {
        setSubscriptionState((current) => ({
          ...current,
          error: cause instanceof Error ? cause.message : "Subscription authority request failed",
          loading: false,
        }));
      }
    }
  }, []);

  const loadReconciliation = useCallback(async () => {
    const request = requestGates.current.reconciliation.begin();
    setReconciliationState((current) => ({ ...current, error: null, loading: true }));
    try {
      const data = await apiGet<BillingReconciliation>("/api/v1/admin/billing/reconciliation");
      if (!request.isCurrent()) return;
      setReconciliationState({ data, error: null, loading: false, refreshedAt: new Date().toISOString() });
    } catch (cause) {
      if (request.isCurrent()) {
        setReconciliationState((current) => ({
          ...current,
          error: cause instanceof Error ? cause.message : "Reconciliation authority request failed",
          loading: false,
        }));
      }
    }
  }, []);

  const load = useCallback((next: BillingQuery) => {
    void loadLedger(next);
    void loadSubscriptions(next);
    void loadReconciliation();
  }, [loadLedger, loadReconciliation, loadSubscriptions]);

  useEffect(() => {
    const gates = requestGates.current;
    load(initialQuery.current);
    const restore = () => {
      const restored = currentQuery();
      setQuery(restored);
      setQueryDraft(restored);
      load(restored);
    };
    const refresh = () => {
      const refreshed = currentQuery();
      setQuery(refreshed);
      setQueryDraft(refreshed);
      load(refreshed);
    };
    window.addEventListener("popstate", restore);
    window.addEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, refresh);
    return () => {
      gates.ledger.invalidate();
      gates.subscriptions.invalidate();
      gates.reconciliation.invalidate();
      window.removeEventListener("popstate", restore);
      window.removeEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, refresh);
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
    load(next);
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
    const delta = parseLedgerAdjustmentDelta(adjustment.delta);
    if (!userId || delta === null) return;
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

  function requestRefundAcknowledgement(checkout: BillingRecord) {
    if (!canReconcile || !isRefundAcknowledgementCandidate(checkout)) return;
    const checkoutId = text(checkout.id);
    const providerInvoiceId = text(checkout.providerSessionId);
    const authorityReference = refundReference.trim();
    if (!checkoutId || !providerInvoiceId || !authorityReference) return;
    const confirmationTarget =
      billingRefundAcknowledgementConfirmation(checkoutId);
    const idempotencyKey = crypto.randomUUID();
    setConfirmation({
      title: `Acknowledge provider refund for ${checkoutId}`,
      summary: (
        <span>
          Invoice {providerInvoiceId}. This records an already-completed
          provider refund and closes the late-settlement exception; it does not
          issue a refund.
        </span>
      ),
      destructive: {
        expectedName: confirmationTarget,
        inputLabel: "Checkout refund acknowledgement",
      },
      reasonLabel: "Reconciliation reason",
      submitLabel: "Acknowledge refund",
      onSubmit: async (reason) => {
        await apiWrite(
          `/api/v1/admin/billing/reconciliation/${encodeURIComponent(checkoutId)}/resolve`,
          "POST",
          {
            resolution: "refund_acknowledged",
            providerReference: authorityReference,
            reason,
            confirmation: confirmationTarget,
          },
          { "idempotency-key": idempotencyKey },
        );
        setRefundReference("");
        setNotice(`Checkout ${checkoutId} refund acknowledgement recorded.`);
        await loadReconciliation();
      },
    });
  }

  const filtered = isBillingQueryFiltered(query);
  const ledger = ledgerState.data?.items ?? [];
  const subscriptions = subscriptionState.data?.items ?? [];
  const reconciliation = reconciliationState.data;
  const hasRefundCandidates =
    reconciliation?.checkoutExceptions.some(isRefundAcknowledgementCandidate) ??
    false;
  const reconciliationRows: DataTableRow[] =
    reconciliation?.checkoutExceptions.map((row, index) => ({
      id: text(row.id) || `checkout-exception-${index}`,
      cells: [
        ...[
          "id",
          "userId",
          "userEmail",
          "plan",
          "billingPeriod",
          "provider",
          "providerSessionId",
          "providerInvoiceStatus",
          "providerInvoiceAdditionalStatus",
          "status",
          "failureCode",
          "providerLookupMissCount",
          "providerAttemptedAt",
          "providerLastLookupAt",
          "updatedAt",
        ].map((key) => display(row[key])),
        ...(canReconcile
          ? [
              isRefundAcknowledgementCandidate(row) ? (
                <button
                  className="inline-flex min-h-9 items-center gap-2 rounded-md border border-[var(--ad-border)] px-3 text-xs font-semibold disabled:opacity-50"
                  disabled={!refundReference.trim()}
                  key="refund-acknowledgement"
                  onClick={() => requestRefundAcknowledgement(row)}
                  type="button"
                >
                  <ReceiptText className="h-4 w-4" />
                  Acknowledge refund
                </button>
              ) : (
                "—"
              ),
            ]
          : []),
      ],
    })) ?? [];
  const loading = ledgerState.loading || subscriptionState.loading || reconciliationState.loading;
  const initiallyLoading = !ledgerState.data && !subscriptionState.data && !reconciliationState.data && loading;
  return (
    <section aria-labelledby="billing-workspace-title" className="space-y-5">
      <div id="billing-workspace-title">
        <PageHeader
          purpose="Reconcile subscription and Dreamcoin authority, then make tightly audited ledger corrections."
          title="Billing & Ledger"
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--ad-text-muted)]" role="status">
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          <span>Customer business records · dataClass=customer only · source freshness watermark unavailable</span>
          <AuthorityFreshness label="Ledger" state={ledgerState} />
          <AuthorityFreshness label="Subscriptions" state={subscriptionState} />
          <AuthorityFreshness label="Reconciliation" state={reconciliationState} />
        </div>
        <div className="flex flex-wrap gap-2">
          {!canAdjust ? <strong>Ledger read only · billing.ledger.adjust is not granted</strong> : null}
          {!canReconcile ? <strong>Reconciliation read only · billing.checkout.reconcile is not granted</strong> : null}
        </div>
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

      {canReconcile && hasRefundCandidates ? (
        <section
          aria-labelledby="billing-reconciliation-resolution-title"
          className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"
        >
          <h3
            className="font-semibold"
            id="billing-reconciliation-resolution-title"
          >
            Late-settlement resolution
          </h3>
          <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
            Enter the provider refund transaction or case reference, then
            acknowledge only after the external refund is complete.
          </p>
          <div className="mt-4 max-w-xl">
            <Field
              label="Provider refund reference"
              onChange={setRefundReference}
              placeholder="Refund transaction or provider case ID"
              value={refundReference}
            />
          </div>
        </section>
      ) : null}

      {notice ? <p className="rounded-md bg-[var(--ad-green-bg)] p-3 text-sm text-[var(--ad-green-text)]" data-testid="admin-action-status" role="status">{notice}</p> : null}
      <AuthorityError label="ledger" onRetry={() => void loadLedger(query)} state={ledgerState} />
      <AuthorityError label="subscriptions" onRetry={() => void loadSubscriptions(query)} state={subscriptionState} />
      <AuthorityError label="reconciliation" onRetry={() => void loadReconciliation()} state={reconciliationState} />
      {initiallyLoading ? <BillingLoading /> : (
        <>
          {reconciliation ? <>
          <div className="grid gap-px overflow-hidden rounded-lg border border-[var(--ad-border)] bg-black/[0.05] md:grid-cols-4">
            <Metric label="Net coins (window)" meta={`${reconciliation.totals.entries} ledger entries`} value={String(reconciliation.totals.net)} />
            <Metric label="Active subscriptions" meta="status = active" value={String(reconciliation.activeSubscriptions)} />
            <Metric label="Checkout exceptions" meta="provider reconciliation queue" value={String(reconciliation.checkoutExceptions.length)} />
            <Metric label="Window" meta={date(reconciliation.window.to)} value={`${date(reconciliation.window.from)} →`} />
          </div>
          <DataTable caption="Reconciliation by reason" headers={["Reason", "Total delta", "Count"]} rows={tableRows(reconciliation.byReason, ["reason", "totalDelta", "count"], "reconciliation")} />
          <DataTable
            caption="Checkout reconciliation exceptions"
            empty={<EmptyState hint="No checkout intents currently require provider reconciliation." title="Checkout reconciliation is clear" />}
            headers={[
              "ID",
              "User",
              "Email",
              "Plan",
              "Period",
              "Provider",
              "Invoice",
              "Provider status",
              "Provider detail",
              "Local status",
              "Failure",
              "Misses",
              "Attempted",
              "Last lookup",
              "Updated",
              ...(canReconcile ? ["Action"] : []),
            ]}
            rows={reconciliationRows}
          />
          </> : null}
          {subscriptionState.data ? <>
          <DataTable caption="Customer subscriptions" empty={<BillingEmpty filtered={Boolean(query.search || query.subscriptionStatus)} kind="subscriptions" onClear={clearFilters} />} headers={["ID", "User", "Email", "Plan", "Period", "Provider", "Status", "Period end", "Cancel at end"]} rows={tableRows(subscriptions, ["id", "userId", "userEmail", "plan", "billingPeriod", "provider", "status", "currentPeriodEnd", "cancelAtPeriodEnd"], "subscription")} />
          <NextPageButton label="Next subscription page" loading={subscriptionState.loading} onClick={() => navigate({ ...query, subscriptionCursor: subscriptionState.data?.pageInfo?.endCursor ?? "" })} pageInfo={subscriptionState.data.pageInfo ?? emptyPageInfo} />
          </> : null}
          {ledgerState.data ? <>
          <DataTable caption="Customer ledger" empty={<BillingEmpty filtered={Boolean(query.search || query.ledgerReason)} kind="ledger entries" onClear={clearFilters} />} headers={["ID", "User", "Email", "Delta", "Balance after", "Reason", "Source", "Created"]} rows={tableRows(ledger, ["id", "userId", "userEmail", "delta", "balanceAfter", "reason", "sourceId", "createdAt"], "ledger")} />
          <NextPageButton label="Next ledger page" loading={ledgerState.loading} onClick={() => navigate({ ...query, ledgerCursor: ledgerState.data?.pageInfo?.endCursor ?? "" })} pageInfo={ledgerState.data.pageInfo ?? emptyPageInfo} />
          </> : null}
        </>
      )}
      {confirmation ? <ConfirmDialog onClose={() => setConfirmation(null)} spec={confirmation} /> : null}
    </section>
  );
}

function BillingLoading() {
  return <div aria-label="Loading billing authority" className="space-y-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4" role="status"><span className="inline-flex items-center gap-2 text-sm text-[var(--ad-text-muted)]"><Loader2 className="h-4 w-4 animate-spin" />Loading billing authority</span>{[0, 1, 2].map((row) => <span aria-hidden="true" className="block h-12 animate-pulse rounded bg-black/5" key={row} />)}</div>;
}

function AuthorityFreshness<T>({ label, state }: { label: string; state: AuthorityState<T> }) {
  if (state.loading && state.data) {
    return <span>{label}: refreshing · showing snapshot from <time dateTime={state.refreshedAt ?? undefined}>{freshnessTime(state.refreshedAt)}</time></span>;
  }
  if (state.error && state.data) {
    return <span>{label}: stale · last good <time dateTime={state.refreshedAt ?? undefined}>{freshnessTime(state.refreshedAt)}</time></span>;
  }
  if (state.error) return <span>{label}: unavailable</span>;
  if (state.data) return <span>{label}: current client snapshot · <time dateTime={state.refreshedAt ?? undefined}>{freshnessTime(state.refreshedAt)}</time></span>;
  return <span>{label}: refreshing · no snapshot yet</span>;
}

function AuthorityError<T>({
  label,
  onRetry,
  state,
}: {
  label: string;
  onRetry: () => void;
  state: AuthorityState<T>;
}) {
  if (!state.error) return null;
  return (
    <div className="rounded-md bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]" role="alert">
      {label} authority refresh failed: {state.error}
      <button className="ml-3 min-h-8 rounded border border-current px-2 font-semibold" onClick={onRetry} type="button">Retry {label}</button>
      {state.data ? <span className="ml-2">The last good snapshot remains visible.</span> : null}
    </div>
  );
}

function freshnessTime(value: string | null) {
  return value ? new Date(value).toLocaleTimeString() : "unknown";
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
  return Boolean(draft.userId.trim() && parseLedgerAdjustmentDelta(draft.delta) !== null);
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
