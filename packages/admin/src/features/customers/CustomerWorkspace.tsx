"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  customer360Schema,
  customerListResponseSchema,
  type Customer360,
  type CustomerListResponse,
} from "@idream/shared/admin";
import { ArrowLeft, RefreshCcw, Search, UserRound } from "lucide-react";
import { adminV2Request, setWorkspaceUrl } from "@/lib/admin-v2-api";
import { createWorkspaceHistoryController, observeWorkspacePopState } from "@/lib/workspace-history";
import {
  buildCustomerWorkspaceParams,
  customerWorkspacePath,
  defaultCustomerQuery,
  parseCustomerWorkspaceParams,
  type CustomerQuery,
  type CustomerWorkspaceUrlState,
} from "./query";
import {
  EmptyWorkspace,
  fieldClass,
  LoadingWorkspace,
  RelativeTime,
  StatusBadge,
  WorkspaceButton,
} from "@/features/operations/WorkspaceUi";

export function CustomerWorkspace({ initialCustomerId = null }: { initialCustomerId?: string | null }) {
  const [initialUrlState] = useState(() => stateFromLocation(initialCustomerId));
  const [query, setQuery] = useState<CustomerQuery>(initialUrlState.query);
  const [list, setList] = useState<CustomerListResponse | null>(null);
  const [selectedId, setSelectedId] = useState(initialUrlState.selectedId);
  const [detail, setDetail] = useState<Customer360 | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstQuery = useRef(query);
  const history = useRef(createWorkspaceHistoryController(initialUrlState));
  const listRequestId = useRef(0);
  const detailRequestId = useRef(0);

  const loadList = useCallback(async (next: CustomerQuery) => {
    const requestId = ++listRequestId.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ search: next.search, status: next.status, limit: "30" });
      if (next.cursor) params.set("cursor", next.cursor);
      const response = await adminV2Request<CustomerListResponse>(`/api/v2/admin/customers?${params}`, {
        schema: customerListResponseSchema,
      });
      if (requestId !== listRequestId.current) return;
      setList(response);
    } catch (cause) {
      if (requestId === listRequestId.current) setError(message(cause));
    } finally {
      if (requestId === listRequestId.current) setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (customerId: string) => {
    const requestId = ++detailRequestId.current;
    setDetailLoading(true);
    setError(null);
    try {
      const response = await adminV2Request<Customer360>(`/api/v2/admin/customers/${encodeURIComponent(customerId)}`, {
        schema: customer360Schema,
      });
      if (requestId === detailRequestId.current) setDetail(response);
    } catch (cause) {
      if (requestId === detailRequestId.current) setError(message(cause));
    } finally {
      if (requestId === detailRequestId.current) setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      history.current.replace(initialUrlState, writeCustomerUrl);
      void loadList(firstQuery.current);
      if (initialUrlState.selectedId) void loadDetail(initialUrlState.selectedId);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [initialUrlState, loadDetail, loadList]);

  useEffect(() => {
    return observeWorkspacePopState(window, () => stateFromLocation(null), (restored) => {
      listRequestId.current += 1;
      detailRequestId.current += 1;
      setQuery(restored.query);
      history.current.restore(restored);
      setSelectedId(restored.selectedId);
      setDetail(null);
      void loadList(restored.query);
      if (restored.selectedId) void loadDetail(restored.selectedId);
    });
  }, [loadDetail, loadList]);

  function updateDraft(patch: Partial<CustomerQuery>) {
    const next = { ...query, ...patch, cursor: undefined };
    setQuery(next);
    history.current.draft({ ...history.current.current(), query: next }, writeCustomerUrl);
  }

  function applyQuery(next: CustomerQuery) {
    const normalized = { ...next, cursor: undefined };
    setQuery(normalized);
    history.current.navigate({ query: normalized, selectedId }, writeCustomerUrl);
    void loadList(normalized);
  }

  function selectCustomer(id: string | null) {
    detailRequestId.current += 1;
    setSelectedId(id);
    setDetail(null);
    history.current.navigate({ ...history.current.current(), selectedId: id }, writeCustomerUrl);
    if (id) void loadDetail(id);
  }

  if (loading && !list) return <LoadingWorkspace label="Loading customers…" />;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ad-text-muted)]">Customer Operations</p>
          <h2 className="mt-1 text-2xl font-semibold">Customers</h2>
          <p className="mt-1 max-w-2xl text-sm text-[var(--ad-text-muted)]">One authoritative view of relationship activity, generations, billing, Cases, and operator history.</p>
        </div>
        <WorkspaceButton onClick={() => void loadList(history.current.current().query)}>
          <RefreshCcw className="h-4 w-4" />Refresh
        </WorkspaceButton>
      </header>

      {error ? <div className="rounded-md bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]" role="alert">{error}</div> : null}

      <form className="grid gap-3 rounded-xl bg-[var(--ad-surface)] p-4 sm:grid-cols-[minmax(0,1fr)_180px_auto]" onSubmit={(event) => { event.preventDefault(); applyQuery(query); }}>
        <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">
          Search
          <span className="relative"><Search className="pointer-events-none absolute left-3 top-3 h-4 w-4" /><input className={`${fieldClass} pl-9`} onChange={(event) => updateDraft({ search: event.target.value })} placeholder="Email, name, or customer ID" value={query.search} /></span>
        </label>
        <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">
          Status
          <select className={fieldClass} onChange={(event) => updateDraft({ status: event.target.value })} value={query.status}><option value="">All</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="deleted">Deleted</option></select>
        </label>
        <WorkspaceButton tone="primary" type="submit">Apply</WorkspaceButton>
      </form>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(420px,0.9fr)]">
        <section className="overflow-hidden rounded-xl bg-[var(--ad-surface)]">
          {list && list.items.length > 0 ? (
            <ul className="divide-y divide-[var(--ad-border)]">
              {list.items.map((customer) => (
                <li key={customer.id}>
                  <button className="grid min-h-24 w-full gap-3 p-4 text-left hover:bg-black/[0.025] sm:grid-cols-[minmax(0,1fr)_repeat(3,110px)]" onClick={() => selectCustomer(customer.id)} type="button">
                    <span className="min-w-0"><span className="flex items-center gap-2 font-semibold"><UserRound className="h-4 w-4" />{customer.displayName ?? customer.email}</span><span className="mt-1 block truncate text-xs text-[var(--ad-text-muted)]">{customer.email} · {customer.id}</span><span className="mt-2 flex gap-2"><StatusBadge value={customer.status} />{customer.subscriptionStatus ? <StatusBadge value={customer.subscriptionStatus} /> : null}</span></span>
                    <ListStat label="Balance" value={`${customer.balanceDreamcoins} DC`} />
                    <ListStat label="Active Cases" value={customer.activeCaseCount} />
                    <ListStat label="Failed 30d" value={customer.failedGenerationCount30d} />
                  </button>
                </li>
              ))}
            </ul>
          ) : <EmptyWorkspace filtered={Boolean(query.search || query.status)} onClear={() => applyQuery(defaultCustomerQuery)} />}
          {list?.pageInfo.hasNextPage ? <div className="border-t border-[var(--ad-border)] p-4"><WorkspaceButton onClick={() => { const next = { ...history.current.current().query, cursor: list.pageInfo.endCursor ?? undefined }; setQuery(next); history.current.navigate({ query: next, selectedId }, writeCustomerUrl); void loadList(next); }}>Next page</WorkspaceButton></div> : null}
        </section>

        {selectedId ? (
          detailLoading && !detail ? <LoadingWorkspace label="Loading Customer 360…" /> : detail ? <CustomerInspector detail={detail} onClose={() => selectCustomer(null)} /> : null
        ) : <aside className="hidden rounded-xl bg-[var(--ad-surface-subtle)] p-8 text-sm text-[var(--ad-text-muted)] xl:block">Select a customer to inspect their complete operational context.</aside>}
      </div>
    </div>
  );
}

function CustomerInspector({ detail, onClose }: { detail: Customer360; onClose: () => void }) {
  return (
    <aside className="space-y-5 rounded-xl bg-[var(--ad-surface)] p-5 xl:sticky xl:top-40">
      <header className="flex items-start justify-between gap-4"><div><p className="font-mono text-xs text-[var(--ad-text-muted)]">{detail.customer.id}</p><h3 className="mt-1 text-lg font-semibold">{detail.customer.displayName ?? detail.customer.email}</h3><p className="text-xs text-[var(--ad-text-muted)]">{detail.customer.email}</p></div><button aria-label="Close customer detail" className="grid min-h-11 min-w-11 place-items-center rounded-md hover:bg-black/[0.04]" onClick={onClose} type="button"><ArrowLeft className="h-4 w-4" /></button></header>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4"><ListStat label="Balance" value={`${detail.overview.balanceDreamcoins} DC`} /><ListStat label="Active Cases" value={detail.overview.activeCaseCount} /><ListStat label="Failed 30d" value={detail.overview.failedGenerationCount30d} /><ListStat label="Last active" value={detail.overview.lastActiveAt ? <RelativeTime referenceTime={detail.asOf} value={detail.overview.lastActiveAt} /> : "—"} /></dl>
      <DetailSection title="Subscription">{detail.subscription ? <p className="text-sm"><strong>{detail.subscription.plan.name}</strong> · {detail.subscription.status} · {detail.subscription.plan.billingPeriod}</p> : <p className="text-sm text-[var(--ad-text-muted)]">No subscription</p>}</DetailSection>
      <DetailSection title={`Relationships (${detail.relationships.length})`}><ul className="space-y-2">{detail.relationships.slice(0, 8).map((row) => <li className="flex justify-between gap-3 text-xs" key={row.sessionId}><Link className="font-semibold underline" href={`/admin/characters/${encodeURIComponent(row.characterId)}`}>{row.characterName}</Link><span className="text-[var(--ad-text-muted)]">{row.lastMessageAt ? <RelativeTime referenceTime={detail.asOf} value={row.lastMessageAt} /> : "—"}</span></li>)}</ul></DetailSection>
      <DetailSection title={`Cases (${detail.cases.length})`}><ul className="space-y-2">{detail.cases.slice(0, 10).map((row) => <li key={row.id}><Link className="flex justify-between gap-3 rounded-md bg-[var(--ad-surface-subtle)] p-2 text-xs" href={`/admin/cases/${encodeURIComponent(row.id)}`}><span>{row.type}</span><StatusBadge value={row.status} /></Link></li>)}</ul></DetailSection>
      <DetailSection title={`Generations (${detail.generations.length})`}><ul className="space-y-2">{detail.generations.slice(0, 8).map((row) => <li className="flex justify-between gap-3 text-xs" key={row.id}><Link className="truncate font-mono underline" href={`/admin/ops/jobs?job=${encodeURIComponent(row.id)}`}>{row.id}</Link><StatusBadge value={row.status} /></li>)}</ul></DetailSection>
      <DetailSection title="Recent ledger"><ul className="space-y-2">{detail.ledger.slice(0, 8).map((row) => <li className="grid grid-cols-[1fr_auto_auto] gap-3 text-xs" key={row.id}><span>{row.reason}</span><span className="font-mono">{row.delta > 0 ? "+" : ""}{row.delta}</span><span className="text-[var(--ad-text-muted)]">{row.balanceAfter}</span></li>)}</ul></DetailSection>
    </aside>
  );
}

function DetailSection({ children, title }: { children: React.ReactNode; title: string }) { return <section className="border-t border-[var(--ad-border)] pt-4"><h4 className="mb-3 text-sm font-semibold">{title}</h4>{children}</section>; }
function ListStat({ label, value }: { label: string; value: React.ReactNode }) { return <span><span className="block text-[10px] font-semibold uppercase tracking-wide text-[var(--ad-text-muted)]">{label}</span><span className="mt-1 block font-mono text-sm">{value}</span></span>; }
function stateFromLocation(initialCustomerId: string | null) { const parsed = typeof window === "undefined" ? { query: defaultCustomerQuery, selectedId: null } : parseCustomerWorkspaceParams(new URLSearchParams(window.location.search)); return { ...parsed, selectedId: initialCustomerId ?? parsed.selectedId }; }
function writeCustomerUrl(state: CustomerWorkspaceUrlState, mode: "push" | "replace") { setWorkspaceUrl(buildCustomerWorkspaceParams(state), { mode, pathname: customerWorkspacePath(state.selectedId) }); }
function message(cause: unknown) { return cause instanceof Error ? cause.message : "Customer workspace request failed"; }
