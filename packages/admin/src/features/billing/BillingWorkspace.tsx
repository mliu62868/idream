"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { BadgeDollarSign, Loader2, ReceiptText, X } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import {
  adminBillingSubscriptionListResponseSchema,
  adminSubscriptionRefundCommandResponseSchema,
  type AdminBillingSubscriptionListItem,
  type AdminBillingSubscriptionListResponse,
  type AdminSubscriptionRefundCommandResponse,
} from "@idream/shared/admin";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { DataTable, type DataTableRow } from "@/components/admin/ui/DataTable";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { useAdminFormat, text } from "@/components/admin/ui/format";
import { emptyPageInfo, Pagination, type PageInfo } from "@/components/admin/ui/Pagination";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { PermissionNotice } from "@/components/admin/ui/PermissionNotice";
import { useToast } from "@/components/admin/ui/Toast";
import { createLatestRequestGate } from "@/lib/latest-request";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import { canonicalListEmptyTitle } from "@/features/compatibility-lists/empty-state";
import {
  BILLING_PAGE_SIZE,
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
type BillingDataScope = {
  kind: "customer";
  includedDataClasses: string[];
  excludedDataClasses: string[];
};
type BillingListResponse<T = BillingRecord> = {
  dataScope: BillingDataScope;
  items: T[];
  pageInfo?: PageInfo;
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

const emptyAdjustment: AdjustmentDraft = { userId: "", delta: "" };
/** 两张表各自翻页，但一次 navigate 会把两边都重新拉一遍，所以轨迹要一起带着走。 */
type BillingTrails = { ledger: string[]; subscription: string[] };
const emptyTrails: BillingTrails = { ledger: [], subscription: [] };
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
  const format = useAdminFormat();
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
  // INTENT: 退款结算数字（冲销多少、余额落到哪、有没有还回来）只在 toast 里闪一下就没了，
  //         而这正是财务事后要核对的那几个数。留在页面上直到运营自己关掉。
  const [refundOutcome, setRefundOutcome] = useState<AdminSubscriptionRefundCommandResponse | null>(null);
  // 游标分页没有页码，只有「上一页用的是哪个游标」。这条轨迹就是 Pagination 的第 N 页。
  const [trails, setTrails] = useState<BillingTrails>(emptyTrails);
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
    // 回退到的那一页是哪一页，历史条目里没记；不知道就说不知道，把「上一页」置灰。
    const restore = () => {
      const restored = currentQuery();
      setQuery(restored);
      setQueryDraft(restored);
      setTrails(emptyTrails);
      load(restored);
    };
    const refresh = () => {
      const refreshed = currentQuery();
      setQuery(refreshed);
      setQueryDraft(refreshed);
      setTrails(emptyTrails);
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

  // SPEC: 任何改变结果集的动作都回到第一页 —— 所以 trails 默认清空，只有翻页自己传轨迹。
  function navigate(next: BillingQuery, mode: "push" | "replace" = "push", nextTrails: BillingTrails = emptyTrails) {
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
    setTrails(nextTrails);
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
            // 币种是可空的自由字符串；空串交给 formatMoney 自己退回默认币种。
            amount: format.money(amountCents, subscription.currency ?? ""),
            count: format.dreamcoins(includedDreamcoins, { unit: false }),
          })}
          {" "}
          {/* INTENT: 「退到哪」在加密支付里不是自动到账——provider 发一笔 payout，客户得自己去
              claim。运营发起前就该知道点完之后还有一段不由自己控制的链路。 */}
          {t("The money leaves as a {provider} payout that {email} claims; its claim link and payout state appear in this row once the provider accepts it.", {
            provider: subscription.provider,
            email: subscription.userEmail,
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
        setRefundOutcome(result);
        toast({
          tone: "success",
          title: t("Subscription {id} refund is {state}.", {
            id: subscriptionId,
            state: t(REFUND_STATE_LABEL[result.refund.state]),
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
        setRefundOutcome(result);
        toast({
          tone: "success",
          title: t("Subscription {id} refund is {state}.", {
            id: subscriptionId,
            state: t(REFUND_STATE_LABEL[result.refund.state]),
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
        format.dateTime(row.currentPeriodEnd),
        format.display(row.cancelAtPeriodEnd),
        refund ? <RefundDetail key="refund" refund={refund} /> : "—",
        action,
      ],
    };
  });
  // INTENT: 账本这几列是钱：delta 带正负、balanceAfter 带千分位、reason 是枚举要走 value()。
  //         走通用 display() 的话它们跟旁边的 ID 长得一模一样。
  const ledgerRows: DataTableRow[] = ledger.map((row, index) => ({
    id: text(row.id) || `ledger-${index}`,
    cells: [
      format.display(row.id),
      format.display(row.userId),
      format.display(row.userEmail),
      <span className="font-semibold tabular-nums" key="delta">{coinCell(row.delta, format, { signed: true })}</span>,
      <span className="tabular-nums" key="balance">{coinCell(row.balanceAfter, format)}</span>,
      text(row.reason) ? valueLabel(text(row.reason)) : "—",
      format.display(row.sourceId),
      format.dateTime(row.createdAt),
    ],
  }));
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
        ].map((key) => format.display(row[key])),
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

      {refundOutcome ? (
        <RefundSettlementNotice onDismiss={() => setRefundOutcome(null)} result={refundOutcome} />
      ) : null}

      <AuthorityError onRetry={() => void loadLedger(query)} state={ledgerState} />
      <AuthorityError onRetry={() => void loadSubscriptions(query)} state={subscriptionState} />
      <AuthorityError onRetry={() => void loadReconciliation()} state={reconciliationState} />
      {initiallyLoading ? <BillingLoading /> : (
        <>
          {reconciliation ? <>
          <div className="grid gap-px overflow-hidden rounded-lg border border-[var(--ad-border)] bg-black/[0.05] md:grid-cols-4">
            <Metric label="Net coins (window)" meta={t("{count} ledger entries", { count: format.count(reconciliation.totals.entries) })} value={format.dreamcoins(reconciliation.totals.net, { signed: true, unit: false })} />
            <Metric label="Active subscriptions" meta="status = active" value={format.count(reconciliation.activeSubscriptions)} />
            <Metric label="Checkout exceptions" meta="provider reconciliation queue" value={format.count(reconciliation.checkoutExceptions.length)} />
            <Metric label="Window" meta={format.dateTime(reconciliation.window.to)} value={`${format.dateTime(reconciliation.window.from)} →`} />
          </div>
          <DataTable caption="Reconciliation by reason" headers={["Reason", "Total delta", "Count"]} rows={reconciliation.byReason.map((row, index) => ({
            id: text(row.reason) || `reconciliation-${index}`,
            cells: [
              text(row.reason) ? valueLabel(text(row.reason)) : "—",
              <span className="font-semibold tabular-nums" key="delta">{coinCell(row.totalDelta, format, { signed: true })}</span>,
              format.display(row.count),
            ],
          }))} />
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
          <ListPagination
            cursor={query.subscriptionCursor}
            loading={subscriptionState.loading}
            onNavigate={(cursor, trail) => navigate({ ...query, subscriptionCursor: cursor }, "push", { ...trails, subscription: trail })}
            pageInfo={subscriptionState.data.pageInfo ?? emptyPageInfo}
            rowCount={subscriptions.length}
            trail={trails.subscription}
          />
          </> : null}
          {ledgerState.data ? <>
          <DataTable caption="Customer ledger" empty={<BillingEmpty filtered={Boolean(query.search || query.ledgerReason)} kind="ledger entries" onClear={clearFilters} />} headers={["ID", "User", "Email", "Delta", "Balance after", "Reason", "Source", "Created"]} rows={ledgerRows} />
          <ListPagination
            cursor={query.ledgerCursor}
            loading={ledgerState.loading}
            onNavigate={(cursor, trail) => navigate({ ...query, ledgerCursor: cursor }, "push", { ...trails, ledger: trail })}
            pageInfo={ledgerState.data.pageInfo ?? emptyPageInfo}
            rowCount={ledger.length}
            trail={trails.ledger}
          />
          </> : null}
        </>
      )}
      {confirmation ? <ConfirmDialog onClose={() => setConfirmation(null)} spec={confirmation} /> : null}
    </section>
  );
}

type SubscriptionRefund = NonNullable<AdminBillingSubscriptionListItem["refund"]>;

/**
 * SPEC: 退款状态与 payout 状态 → 运营看得懂的说法（i18n key）。
 *
 * INTENT: 这两组枚举走不了 `value()` —— 那条通道只查 zhValues，而 zhValues 里没有
 * `provider_dispatching` / `awaiting_approval` 这些值，中文界面会把枚举码原样印出来。
 * 走 t() 就能在本域的词条文件里给全译文；顺带英文也从 `awaiting_payment` 变成人话。
 * INVARIANT: 键是契约里 adminSubscriptionRefundStateSchema 的全集；漏一个就编译不过。
 */
const REFUND_STATE_LABEL: Record<SubscriptionRefund["state"], string> = {
  provider_dispatching: "Sending to provider",
  provider_unknown: "Provider state unknown",
  claimable: "Waiting for the customer to claim",
  awaiting_approval: "Awaiting payout approval",
  awaiting_payment: "Awaiting payout",
  in_progress: "Payout in progress",
  completed: "Paid out",
  canceled: "Canceled",
};

const PAYOUT_STATE_LABEL: Record<SubscriptionRefund["payouts"][number]["state"], string> = {
  awaiting_approval: "Awaiting payout approval",
  awaiting_payment: "Awaiting payout",
  in_progress: "Payout in progress",
  completed: "Paid out",
  canceled: "Canceled",
};

/**
 * SPEC: 退款那一格要能独立回答「退了多少、客户余额落到哪、钱走到哪一步了」。
 *
 * INTENT: 这一格原本只印一个状态词。而契约里 amountCents / reversedDreamcoins /
 * balanceAfter / payouts[] / restoredAt 全都在——运营想知道「钱到底出去没有」，
 * 得去翻 provider 后台，或者干脆再点一次 Reconcile 看 toast。
 * INVARIANT: 只印契约里真有的字段。没有的（比如客户实际收到的时间）就不印，不估。
 */
function RefundDetail({ refund }: { refund: SubscriptionRefund }) {
  const { t } = useAdminI18n();
  const format = useAdminFormat();
  const owed = refund.balanceAfter < 0;
  return (
    <div className="min-w-56 space-y-1 text-xs">
      <p className="font-semibold">{t(REFUND_STATE_LABEL[refund.state])}</p>
      <p>
        {format.money(refund.amountCents, refund.currency)}
        {" · "}
        {t("{count} Dreamcoin grant reversed", { count: format.dreamcoins(refund.reversedDreamcoins, { unit: false }) })}
      </p>
      <p className={owed ? "font-semibold text-[var(--ad-red-text)]" : undefined}>
        {t("Balance after reversal")}: {format.dreamcoins(refund.balanceAfter, { signed: true, unit: false })}
        {/* INTENT: 余额被冲成负数，说的就是「已消费的梦币不返还」这条规则真的生效了——
            客户花掉的那部分现在挂在他账上。这句话必须由数字带出来，不能只写在确认框里。 */}
        {owed ? ` · ${t("the customer had already spent part of the grant")}` : ""}
      </p>
      {refund.restoredAt ? (
        <p>
          {t("Grant restored")}
          {refund.restoredBalanceAfter === null
            ? ""
            : ` · ${t("Balance after reversal")}: ${format.dreamcoins(refund.restoredBalanceAfter, { signed: true, unit: false })}`}
        </p>
      ) : null}
      {refund.payouts.length > 0 ? (
        <p className="text-[var(--ad-text-muted)]">
          {t("Provider payout")}:{" "}
          {refund.payouts.map((payout) => t(PAYOUT_STATE_LABEL[payout.state])).join(" · ")}
        </p>
      ) : (
        <p className="text-[var(--ad-text-muted)]">{t("No provider payout recorded yet")}</p>
      )}
      {refund.providerRefundId ? (
        <p className="font-mono text-[11px] text-[var(--ad-text-muted)]">{refund.providerRefundId}</p>
      ) : null}
    </div>
  );
}

/**
 * SPEC: 退款/对账命令返回的结算数字，留在页面上而不是随 toast 消失。
 * INTENT: 这四个数（冲销、余额、还回、还回后余额）是财务事后对账要抄的东西。
 *         replayed 也要说——重放意味着这次点击没有产生新的资金动作。
 */
function RefundSettlementNotice({
  onDismiss,
  result,
}: {
  onDismiss: () => void;
  result: AdminSubscriptionRefundCommandResponse;
}) {
  const { t, value: valueLabel } = useAdminI18n();
  const format = useAdminFormat();
  const { settlement } = result;
  return (
    <section
      className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 text-sm"
      role="status"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 className="font-semibold">
          {t("Refund settlement for {id}", { id: result.subscriptionId })}
        </h3>
        <button
          aria-label={t("Dismiss refund settlement")}
          className="grid min-h-9 min-w-9 place-items-center rounded-md border border-[var(--ad-border)]"
          onClick={onDismiss}
          type="button"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {result.replayed ? (
        <p className="mt-2 text-xs text-[var(--ad-text-muted)]">
          {t("This repeated an earlier identical command. No new money moved.")}
        </p>
      ) : null}
      <dl className="mt-3 grid gap-px overflow-hidden rounded-md border border-[var(--ad-border)] bg-[var(--ad-border)] sm:grid-cols-2 lg:grid-cols-4">
        <SettlementFigure
          label={t("Refund amount")}
          value={format.money(result.refund.amountCents, result.refund.currency)}
        />
        <SettlementFigure
          label={t("Dreamcoins reversed")}
          value={format.dreamcoins(-settlement.reversedDreamcoins, { signed: true, unit: false })}
        />
        <SettlementFigure
          label={t("Balance after reversal")}
          tone={settlement.balanceAfter < 0 ? "owed" : undefined}
          value={format.dreamcoins(settlement.balanceAfter, { signed: true, unit: false })}
        />
        <SettlementFigure
          label={t("Subscription status")}
          value={valueLabel(result.subscriptionStatus)}
        />
      </dl>
      {settlement.restoredDreamcoins > 0 ? (
        <p className="mt-2 text-xs">
          {t("{count} Dreamcoins were put back because the provider refund did not complete.", {
            count: format.dreamcoins(settlement.restoredDreamcoins, { unit: false }),
          })}
          {settlement.restoredBalanceAfter === null
            ? ""
            : ` ${t("Balance after reversal")}: ${format.dreamcoins(settlement.restoredBalanceAfter, { signed: true, unit: false })}`}
        </p>
      ) : null}
      {settlement.balanceAfter < 0 ? (
        <p className="mt-2 text-xs text-[var(--ad-red-text)]">
          {t("The balance is negative: the customer had already spent part of the grant, and those coins are not returned.")}
        </p>
      ) : null}
    </section>
  );
}

function SettlementFigure({ label, tone, value }: { label: string; tone?: "owed"; value: string }) {
  return (
    <div className="bg-[var(--ad-surface)] px-3 py-2">
      <dt className="text-[11px] font-medium text-[var(--ad-text-muted)]">{label}</dt>
      <dd className={`mt-0.5 text-base font-semibold tabular-nums${tone === "owed" ? " text-[var(--ad-red-text)]" : ""}`}>
        {value}
      </dd>
    </div>
  );
}

function BillingLoading() {
  const { t } = useAdminI18n();
  return <div aria-label={t("Loading billing records…")} className="space-y-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4" role="status"><span className="inline-flex items-center gap-2 text-sm text-[var(--ad-text-muted)]"><Loader2 className="h-4 w-4 animate-spin" />{t("Loading billing records…")}</span>{[0, 1, 2].map((row) => <span aria-hidden="true" className="block h-12 animate-pulse rounded bg-black/5" key={row} />)}</div>;
}

function AuthorityFreshness<T>({ label, state }: { label: string; state: AuthorityState<T> }) {
  const { t } = useAdminI18n();
  const format = useAdminFormat();
  const at = state.refreshedAt ? format.time(state.refreshedAt) : t("unknown");
  if (state.loading && state.data) {
    return <span>{label}{t(": refreshing · as of")} <time dateTime={state.refreshedAt ?? undefined}>{at}</time></span>;
  }
  if (state.error && state.data) {
    return <span>{label}{t(": stale · last good")} <time dateTime={state.refreshedAt ?? undefined}>{at}</time></span>;
  }
  if (state.error) return <span>{label}{t(": unavailable")}</span>;
  if (state.data) return <span>{label}{t(": as of")} <time dateTime={state.refreshedAt ?? undefined}>{at}</time></span>;
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

function BillingEmpty({ filtered, kind, onClear }: { filtered: boolean; kind: string; onClear: () => void }) {
  const { t } = useAdminI18n();
  const title = canonicalListEmptyTitle(
    kind === "ledger entries" ? "ledger" : "subscriptions",
    filtered,
  );
  return <EmptyState action={filtered ? <button className="min-h-11 rounded-md border border-[var(--ad-border)] px-4 text-sm font-semibold" onClick={onClear} type="button">{t("Clear filters")}</button> : undefined} hint={filtered ? `The complete authority query returned no ${kind}.` : `No ${kind} exist in the authority yet.`} title={title} />;
}

// SPEC: 账本和订阅两张表的分页条形状完全一样，只有游标属于哪一张不同。
function ListPagination({ cursor, loading, onNavigate, pageInfo, rowCount, trail }: {
  cursor: string;
  loading: boolean;
  onNavigate: (cursor: string, trail: string[]) => void;
  pageInfo: PageInfo;
  rowCount: number;
  trail: string[];
}) {
  return (
    <Pagination
      hasNext={Boolean(pageInfo.hasNextPage && pageInfo.endCursor)}
      hasPrevious={trail.length > 0}
      loading={loading}
      onNext={() => {
        if (!pageInfo.endCursor) return;
        onNavigate(pageInfo.endCursor, [...trail, cursor]);
      }}
      onPrevious={() => onNavigate(trail.at(-1) ?? "", trail.slice(0, -1))}
      page={trail.length + 1}
      pageSize={BILLING_PAGE_SIZE}
      rowCount={rowCount}
    />
  );
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

/**
 * INTENT: 账本行是 unknown 进来的。是数字才按钱排版，不是数字就退回通用占位——
 * 不把非数字硬塞进金额格式化器里，省得把脏数据印成一个看起来很正经的 0。
 */
function coinCell(
  value: unknown,
  format: ReturnType<typeof useAdminFormat>,
  options?: { signed?: boolean },
): ReactNode {
  // 列头已经写着 Delta / Balance after，每格再缀一遍单位是噪音。
  return typeof value === "number"
    ? format.dreamcoins(value, { ...options, unit: false })
    : format.display(value);
}

function canAdjustLedger(draft: AdjustmentDraft) {
  return Boolean(draft.userId.trim() && parseLedgerAdjustmentDelta(draft.delta) !== null);
}

function currentQuery() {
  return typeof window === "undefined" ? defaultBillingQuery : billingQueryFromSearch(window.location.search);
}
