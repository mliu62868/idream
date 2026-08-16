"use client";

import { useAdminI18n } from "@/components/admin/i18n";
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
import {
  adminBillingSubscriptionListResponseSchema,
  adminSubscriptionRefundCommandResponseSchema,
  type AdminBillingSubscriptionListItem,
  type AdminBillingSubscriptionListResponse,
} from "@idream/shared/admin";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { DataTable, type DataTableRow } from "@/components/admin/ui/DataTable";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { PermissionNotice } from "@/components/admin/ui/PermissionNotice";
import { useToast } from "@/components/admin/ui/Toast";
import { createLatestRequestGate } from "@/lib/latest-request";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import { canonicalListEmptyTitle } from "@/features/compatibility-lists/empty-state";
import {
  billingAdjustmentConfirmation,
  billingLedgerPath,
  billingQueryFromSearch,
  billingRefundAcknowledgementConfirmation,
  billingSubscriptionRefundConfirmation,
  billingSubscriptionRefundReconcileConfirmation,
  billingSubscriptionsPath,
  billingWorkspaceUrl,
  defaultBillingQuery,
  isBillingQueryFiltered,
  isRefundAcknowledgementCandidate,
  isSubscriptionRefundable,
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
type BillingListResponse<T = BillingRecord> = {
  dataScope: BillingDataScope;
  items: T[];
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
  /** 原始异常——运营文案按错误码挑，光有 message 挑不出来。 */
  cause: unknown;
  loading: boolean;
  refreshedAt: string | null;
};

const emptyPageInfo: BillingPageInfo = { endCursor: null, hasNextPage: false };
const emptyAdjustment: AdjustmentDraft = { userId: "", delta: "" };
const emptyAuthorityState = <T,>(): AuthorityState<T> => ({
  data: null,
  error: null,
  cause: undefined,
  loading: true,
  refreshedAt: null,
});

export function BillingWorkspace({
  canAdjust,
  canReconcile,
  canRefund,
}: {
  canAdjust: boolean;
  canReconcile: boolean;
  canRefund: boolean;
}) {
  const { t, value: valueLabel } = useAdminI18n();
  const { toast } = useToast();
  // INVARIANT: server and first browser render use identical state. URL-owned
  // filters are restored after hydration so bookmarked operator views stay safe.
  const [query, setQuery] = useState<BillingQuery>(defaultBillingQuery);
  const [queryDraft, setQueryDraft] = useState<BillingQuery>(defaultBillingQuery);
  const [ledgerState, setLedgerState] = useState<AuthorityState<BillingListResponse>>(emptyAuthorityState);
  const [subscriptionState, setSubscriptionState] = useState<AuthorityState<AdminBillingSubscriptionListResponse>>(emptyAuthorityState);
  const [reconciliationState, setReconciliationState] = useState<AuthorityState<BillingReconciliation>>(emptyAuthorityState);
  const [adjustment, setAdjustment] = useState<AdjustmentDraft>(emptyAdjustment);
  const [refundReference, setRefundReference] = useState("");
  const [confirmation, setConfirmation] = useState<ConfirmSpec | null>(null);
  const requestGates = useRef({
    ledger: createLatestRequestGate(),
    subscriptions: createLatestRequestGate(),
    reconciliation: createLatestRequestGate(),
  });

  const loadLedger = useCallback(async (next: BillingQuery) => {
    const request = requestGates.current.ledger.begin();
    setLedgerState((current) => ({ ...current, error: null, loading: true }));
    try {
      const data = await apiGet<BillingListResponse>(billingLedgerPath(next));
      if (!request.isCurrent()) return;
      setLedgerState({ data, error: null, cause: undefined, loading: false, refreshedAt: new Date().toISOString() });
    } catch (cause) {
      if (request.isCurrent()) {
        setLedgerState((current) => ({
          ...current,
          error: cause instanceof Error ? cause.message : "Ledger authority request failed",
          cause,
          loading: false,
        }));
      }
    }
  }, []);

  const loadSubscriptions = useCallback(async (next: BillingQuery) => {
    const request = requestGates.current.subscriptions.begin();
    setSubscriptionState((current) => ({ ...current, error: null, loading: true }));
    try {
      const data = adminBillingSubscriptionListResponseSchema.parse(
        await apiGet<unknown>(billingSubscriptionsPath(next)),
      );
      if (!request.isCurrent()) return;
      setSubscriptionState({ data, error: null, cause: undefined, loading: false, refreshedAt: new Date().toISOString() });
    } catch (cause) {
      if (request.isCurrent()) {
        setSubscriptionState((current) => ({
          ...current,
          error: cause instanceof Error ? cause.message : "Subscription authority request failed",
          cause,
          loading: false,
        }));
      }
    }
  }, []);

  const loadReconciliation = useCallback(async () => {
    const request = requestGates.current.reconciliation.begin();
    setReconciliationState((current) => ({ ...current, error: null, loading: true }));
    try {
      const data = await apiGet<BillingReconciliation>("/api/v2/admin/billing/reconciliation");
      if (!request.isCurrent()) return;
      setReconciliationState({ data, error: null, cause: undefined, loading: false, refreshedAt: new Date().toISOString() });
    } catch (cause) {
      if (request.isCurrent()) {
        setReconciliationState((current) => ({
          ...current,
          error: cause instanceof Error ? cause.message : "Reconciliation authority request failed",
          cause,
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
    const timer = window.setTimeout(restore, 0);
    window.addEventListener("popstate", restore);
    window.addEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, refresh);
    return () => {
      window.clearTimeout(timer);
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
      title: t("Adjust ledger for {user}", { user: userId }),
      summary: <span>{t("User")} {userId}  {t("· signed delta")} {delta}</span>,
      destructive: { expectedName: confirmationTarget, inputLabel: "Confirmation" },
      // INTENT: 余额可以再发一笔反向调整改回来，所以标 reversible——但金额已经进了客户账，
      //         「可撤回」不等于「客户看不到」，effect 里把这点说清楚。
      consequence: {
        effect: t("The customer's balance changes immediately. Correcting it needs a second, opposite adjustment."),
        reversible: true,
      },
      reasonLabel: "Reason",
      submitLabel: "Confirm",
      onSubmit: async (reason) => {
        await apiWrite(
          "/api/v2/admin/billing/adjustments",
          "POST",
          { userId, delta, reason, confirmation: confirmationTarget },
          { "idempotency-key": idempotencyKey },
        );
        setAdjustment(emptyAdjustment);
        toast({ tone: "success", title: t("Ledger adjusted for {user}", { user: userId }) });
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
      title: t("Acknowledge provider refund for {id}", { id: checkoutId }),
      summary: (
        <span>

          {t("Invoice")} {providerInvoiceId}{t(". This records an already-completed provider refund and closes the late-settlement exception; it does not issue a refund.")}
        </span>
      ),
      destructive: {
        expectedName: confirmationTarget,
        inputLabel: "Checkout refund acknowledgement",
      },
      consequence: {
        effect: t("The late-settlement exception closes and leaves the reconciliation queue. There is no command to reopen it."),
        reversible: false,
      },
      reasonLabel: "Reconciliation reason",
      submitLabel: "Acknowledge refund",
      onSubmit: async (reason) => {
        await apiWrite(
          `/api/v2/admin/billing/reconciliation/${encodeURIComponent(checkoutId)}/resolve`,
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
        toast({
          tone: "success",
          title: t("Refund acknowledgement recorded for {id}", { id: checkoutId }),
        });
        await loadReconciliation();
      },
    });
  }

  function requestSubscriptionRefund(
    subscription: AdminBillingSubscriptionListItem,
  ) {
    if (!canRefund || !isSubscriptionRefundable(subscription)) return;
    const subscriptionId = subscription.id;
    const confirmationTarget =
      billingSubscriptionRefundConfirmation(subscriptionId);
    const amountCents = subscription.amountCents ?? 0;
    const includedDreamcoins = subscription.includedDreamcoins;
    const idempotencyKey = crypto.randomUUID();
    setConfirmation({
      title: t("Refund subscription {id}", { id: subscriptionId }),
      summary: (
        <span>
          {t("Issue the full provider refund of {amount}. Access is frozen immediately and the exact {count} Dreamcoin subscription grant is reversed; coins already spent remain consumed.", {
            amount: money(amountCents, subscription.currency ?? "usd"),
            count: includedDreamcoins.toLocaleString(),
          })}
        </span>
      ),
      destructive: {
        expectedName: confirmationTarget,
        inputLabel: t("Subscription refund confirmation"),
      },
      consequence: {
        effect: t("Money leaves the provider account and access is frozen at once. There is no un-refund command; restoring the customer means selling the subscription again."),
        reversible: false,
      },
      reasonLabel: t("Refund reason"),
      submitLabel: t("Issue full refund"),
      onSubmit: async (reason) => {
        const result = adminSubscriptionRefundCommandResponseSchema.parse(
          await apiWrite<unknown>(
            `/api/v2/admin/billing/subscriptions/${encodeURIComponent(subscriptionId)}/refund`,
            "POST",
            { reason, confirmation: confirmationTarget },
            { "idempotency-key": idempotencyKey },
          ),
        );
        toast({
          tone: "success",
          title: t("Subscription {id} refund is {state}.", {
            id: subscriptionId,
            state: result.refund.state,
          }),
        });
        load(query);
      },
    });
  }

  function requestSubscriptionRefundReconciliation(
    subscription: AdminBillingSubscriptionListItem,
  ) {
    if (!canRefund) return;
    const subscriptionId = subscription.id;
    if (!subscriptionId) return;
    const confirmationTarget =
      billingSubscriptionRefundReconcileConfirmation(subscriptionId);
    const idempotencyKey = crypto.randomUUID();
    setConfirmation({
      title: t("Reconcile refund {id}", { id: subscriptionId }),
      summary: (
        <span>
          {t("Read the provider Pull Payment and payout authority, then project its current state into subscription, entitlement, and Dreamcoin records.")}
        </span>
      ),
      destructive: {
        expectedName: confirmationTarget,
        inputLabel: t("Refund reconciliation confirmation"),
      },
      // INTENT: 对账是把 provider 的当前状态投影过来，可以重复跑，所以标可撤回。
      consequence: {
        effect: t("Local subscription, entitlement, and Dreamcoin records are overwritten with the provider's current state. Running it again re-reads the provider."),
        reversible: true,
      },
      reasonLabel: t("Reconciliation reason"),
      submitLabel: t("Reconcile provider state"),
      onSubmit: async (reason) => {
        const result = adminSubscriptionRefundCommandResponseSchema.parse(
          await apiWrite<unknown>(
            `/api/v2/admin/billing/subscriptions/${encodeURIComponent(subscriptionId)}/refund/reconcile`,
            "POST",
            { reason, confirmation: confirmationTarget },
            { "idempotency-key": idempotencyKey },
          ),
        );
        toast({
          tone: "success",
          title: t("Subscription {id} refund is {state}.", {
            id: subscriptionId,
            state: result.refund.state,
          }),
        });
        load(query);
      },
    });
  }

  const filtered = isBillingQueryFiltered(query);
  const ledger = ledgerState.data?.items ?? [];
  const subscriptions = subscriptionState.data?.items ?? [];
  const subscriptionRows: DataTableRow[] = subscriptions.map((row, index) => {
    const refund = row.refund;
    const refundState = refund?.state ?? "";
    const claimUrl = refund?.claimUrl ?? "";
    const action = isSubscriptionRefundable(row) ? (
      canRefund ? (
        <button
          className="inline-flex min-h-9 items-center gap-2 rounded-md bg-[var(--ad-ink)] px-3 text-xs font-semibold text-white"
          onClick={() => requestSubscriptionRefund(row)}
          type="button"
        >
          <ReceiptText className="h-4 w-4" /> {t("Full refund")}
        </button>
      ) : "—"
    ) : refundState && refundState !== "completed" && refundState !== "canceled" ? (
      <div className="flex flex-wrap gap-2">
        {claimUrl ? (
          <a className="inline-flex min-h-9 items-center rounded-md border border-[var(--ad-border)] px-3 text-xs font-semibold" href={claimUrl} rel="noreferrer" target="_blank">{t("Open claim")}</a>
        ) : null}
        {canRefund ? (
          <button className="inline-flex min-h-9 items-center rounded-md border border-[var(--ad-border)] px-3 text-xs font-semibold" onClick={() => requestSubscriptionRefundReconciliation(row)} type="button">{t("Reconcile")}</button>
        ) : null}
      </div>
    ) : refundState ? (
      <span>{valueLabel(refundState)}{refund?.providerRefundId ? ` · ${refund.providerRefundId}` : ""}</span>
    ) : "—";
    return {
      id: row.id || `subscription-${index}`,
      cells: [
        row.id,
        row.userId,
        row.userEmail,
        row.plan,
        row.billingPeriod,
        row.provider,
        valueLabel(row.status),
        display(row.currentPeriodEnd),
        display(row.cancelAtPeriodEnd),
        refundState ? valueLabel(refundState) : "—",
        action,
      ],
    };
  });
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

                  {t("Acknowledge refund")}
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
          purpose={t("Reconcile subscription and Dreamcoin authority, then make tightly audited ledger corrections.")}
          title={t("Billing Operations")}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--ad-text-muted)]" role="status">
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          <AuthorityFreshness label="Ledger" state={ledgerState} />
          <AuthorityFreshness label="Subscriptions" state={subscriptionState} />
          <AuthorityFreshness label="Reconciliation" state={reconciliationState} />
        </div>
        <div className="flex flex-wrap gap-2">
          {!canAdjust ? <PermissionNotice permission="billing.ledger.adjust" /> : null}
          {!canReconcile ? <PermissionNotice permission="billing.checkout.reconcile" /> : null}
          {!canRefund ? <PermissionNotice permission="billing.subscription.refund" /> : null}
        </div>
      </div>

      <form className="grid gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 md:grid-cols-2 xl:grid-cols-[minmax(260px,1fr)_200px_220px_auto]" onSubmit={apply}>
        <Field label={t("Search billing records")} onChange={(search) => setQueryDraft((current) => ({ ...current, search }))} placeholder={t("user, email, subscription, or source")} value={queryDraft.search} />
        <Select label={t("Ledger reason")} onChange={(ledgerReason) => setQueryDraft((current) => ({ ...current, ledgerReason }))} options={["", "signup_bonus", "subscription_grant", "subscription_refund", "subscription_refund_restore", "generation_spend", "refund", "redeem", "referral", "admin_adjust"]} value={queryDraft.ledgerReason} />
        <Select label={t("Subscription status")} onChange={(subscriptionStatus) => setQueryDraft((current) => ({ ...current, subscriptionStatus }))} options={["", "checkout_created", "checkout_completed", "active", "past_due", "canceled", "expired", "refund_pending", "refunded"]} value={queryDraft.subscriptionStatus} />
        <div className="flex items-end gap-2">
          <button className="min-h-11 rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white" type="submit">{t("Apply")}</button>
          {filtered ? <button aria-label={t("Clear billing filters")} className="grid min-h-11 min-w-11 place-items-center rounded-md border border-[var(--ad-border)]" onClick={clearFilters} type="button"><X className="h-4 w-4" /></button> : null}
        </div>
      </form>

      {canAdjust ? (
        <section aria-labelledby="billing-adjustment-title" className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h3 className="font-semibold" id="billing-adjustment-title">{t("Adjust Ledger")}</h3><p className="mt-1 text-xs text-[var(--ad-text-muted)]">{t("Every signed delta requires a reason, target confirmation, unique idempotency key, and server-side audit.")}</p></div>
            <button className="inline-flex min-h-11 items-center gap-2 rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white disabled:opacity-50" disabled={!canAdjustLedger(adjustment)} onClick={requestAdjustment} type="button"><BadgeDollarSign className="h-4 w-4" />{t("Adjust")}</button>
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

            {t("Late-settlement resolution")}
          </h3>
          <p className="mt-1 text-xs text-[var(--ad-text-muted)]">

            {t("Enter the provider refund transaction or case reference, then acknowledge only after the external refund is complete.")}
          </p>
          <div className="mt-4 max-w-xl">
            <Field
              label="Provider refund reference"
              onChange={setRefundReference}
              placeholder={t("Refund transaction or provider case ID")}
              value={refundReference}
            />
          </div>
        </section>
      ) : null}

      <AuthorityError onRetry={() => void loadLedger(query)} state={ledgerState} />
      <AuthorityError onRetry={() => void loadSubscriptions(query)} state={subscriptionState} />
      <AuthorityError onRetry={() => void loadReconciliation()} state={reconciliationState} />
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
            empty={<EmptyState hint="No checkout intents currently require provider reconciliation." title={t("Checkout reconciliation is clear")} />}
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
          <DataTable caption="Customer subscriptions" empty={<BillingEmpty filtered={Boolean(query.search || query.subscriptionStatus)} kind="subscriptions" onClear={clearFilters} />} headers={["ID", "User", "Email", "Plan", "Period", "Provider", "Status", "Period end", "Cancel at end", "Refund state", "Action"]} rows={subscriptionRows} stickyLastColumn />
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
  const { t } = useAdminI18n();
  return <div aria-label={t("Loading billing records…")} className="space-y-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4" role="status"><span className="inline-flex items-center gap-2 text-sm text-[var(--ad-text-muted)]"><Loader2 className="h-4 w-4 animate-spin" />{t("Loading billing records…")}</span>{[0, 1, 2].map((row) => <span aria-hidden="true" className="block h-12 animate-pulse rounded bg-black/5" key={row} />)}</div>;
}

function AuthorityFreshness<T>({ label, state }: { label: string; state: AuthorityState<T> }) {
  const { t } = useAdminI18n();
  if (state.loading && state.data) {
    return <span>{label}{t(": refreshing · as of")} <time dateTime={state.refreshedAt ?? undefined}>{freshnessTime(state.refreshedAt)}</time></span>;
  }
  if (state.error && state.data) {
    return <span>{label}{t(": stale · last good")} <time dateTime={state.refreshedAt ?? undefined}>{freshnessTime(state.refreshedAt)}</time></span>;
  }
  if (state.error) return <span>{label}{t(": unavailable")}</span>;
  if (state.data) return <span>{label}{t(": as of")} <time dateTime={state.refreshedAt ?? undefined}>{freshnessTime(state.refreshedAt)}</time></span>;
  return <span>{label}{t(": loading…")}</span>;
}

function AuthorityError<T>({
  onRetry,
  state,
}: {
  onRetry: () => void;
  state: AuthorityState<T>;
}) {
  if (!state.error) return null;
  return (
    <AuthorityRequestError
      cause={state.cause}
      message={state.error}
      onRetry={onRetry}
      snapshotAt={state.data ? state.refreshedAt : null}
    />
  );
}

function freshnessTime(value: string | null) {
  return value ? new Date(value).toLocaleTimeString() : "unknown";
}

function BillingEmpty({ filtered, kind, onClear }: { filtered: boolean; kind: string; onClear: () => void }) {
  const { t } = useAdminI18n();
  const title = canonicalListEmptyTitle(
    kind === "ledger entries" ? "ledger" : "subscriptions",
    filtered,
  );
  return <EmptyState action={filtered ? <button className="min-h-11 rounded-md border border-[var(--ad-border)] px-4 text-sm font-semibold" onClick={onClear} type="button">{t("Clear filters")}</button> : undefined} hint={filtered ? `The complete authority query returned no ${kind}.` : `No ${kind} exist in the authority yet.`} title={title} />;
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
  const { t, value: valueLabel } = useAdminI18n();
  return <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{label}<select className="min-h-11 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm" onChange={(event) => onChange(event.target.value)} value={value}>{options.map((option) => <option key={option || "all"} value={option}>{option ? valueLabel(option) : t("All")}</option>)}</select></label>;
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

function money(amountCents: number, currency: string) {
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: currency || "USD",
    }).format(amountCents / 100);
  } catch {
    return `${amountCents} ${currency || "currency cents"}`;
  }
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
