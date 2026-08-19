"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  customer360Schema,
  customerListResponseSchema,
  type Customer360,
  type CustomerListResponse,
} from "@idream/shared/admin";
import { ArrowLeft, RefreshCcw, Search, UserRound } from "lucide-react";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { useAdminFormat } from "@/components/admin/ui/format";
import { Pagination } from "@/components/admin/ui/Pagination";
import { adminV2Request, setWorkspaceUrl } from "@/lib/admin-v2-api";
import { createWorkspaceHistoryController, observeWorkspacePopState, workspaceDetailId } from "@/lib/workspace-history";
import {
  buildCustomerWorkspaceParams,
  CUSTOMER_PAGE_SIZE,
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
  const { t } = useAdminI18n();
  const format = useAdminFormat();
  const [initialUrlState] = useState(() => stateFromLocation(initialCustomerId));
  const [query, setQuery] = useState<CustomerQuery>(initialUrlState.query);
  const [list, setList] = useState<CustomerListResponse | null>(null);
  const [selectedId, setSelectedId] = useState(initialUrlState.selectedId);
  const [detail, setDetail] = useState<Customer360 | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // SPEC: 「上一页」重发自己走过的那个游标，不给后端发 `before`。
  // INTENT: 后端确实支持反向 keyset，但页码只有翻页栈知道 —— 用同一份栈同时回答
  //         「能不能回去」和「这是第几页」，两个读数就不会互相打架。栈空即第一页，置灰。
  const [cursorTrail, setCursorTrail] = useState<string[]>([]);
  const firstQuery = useRef(query);
  const history = useRef(createWorkspaceHistoryController(initialUrlState));
  const listRequestId = useRef(0);
  const detailRequestId = useRef(0);

  const loadList = useCallback(async (next: CustomerQuery) => {
    const requestId = ++listRequestId.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ search: next.search, status: next.status, limit: String(CUSTOMER_PAGE_SIZE) });
      if (next.cursor) params.set("cursor", next.cursor);
      const response = await adminV2Request<CustomerListResponse>(`/api/v2/admin/customers?${params}`, {
        schema: customerListResponseSchema,
      });
      if (requestId !== listRequestId.current) return;
      setList(response);
    } catch (cause) {
      if (requestId === listRequestId.current) setError(cause);
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
      if (requestId === detailRequestId.current) setError(cause);
    } finally {
      if (requestId === detailRequestId.current) setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!initialCustomerId) history.current.replace(initialUrlState, writeCustomerUrl);
      void loadList(firstQuery.current);
      if (initialUrlState.selectedId) void loadDetail(initialUrlState.selectedId);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [initialCustomerId, initialUrlState, loadDetail, loadList]);

  useEffect(() => {
    return observeWorkspacePopState(window, () => stateFromLocation(null), (restored) => {
      listRequestId.current += 1;
      detailRequestId.current += 1;
      setQuery(restored.query);
      setCursorTrail([]);
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
    setCursorTrail([]);
    history.current.navigate({ query: normalized, selectedId }, writeCustomerUrl);
    void loadList(normalized);
  }

  function goToPage(cursor: string | undefined, trail: string[]) {
    const next = { ...history.current.current().query, cursor };
    setQuery(next);
    setCursorTrail(trail);
    history.current.navigate({ query: next, selectedId }, writeCustomerUrl);
    void loadList(next);
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
          <h2 className="sr-only">{t("Customers")}</h2>
          <p className="max-w-2xl text-sm text-[var(--ad-text-muted)]">{t("One view of relationship activity, generations, billing, Cases, and operator history.")}</p>
          {list ? <p className="mt-1 text-xs text-[var(--ad-text-muted)]" role="status">{t(list.freshness)} {t("· data as of")} <time dateTime={list.asOf}>{format.time(list.asOf)}</time></p> : null}
        </div>
        <WorkspaceButton disabled={loading} onClick={() => void loadList(history.current.current().query)}>
          <RefreshCcw className="h-4 w-4" />{loading ? t("Refreshing…") : t("Refresh")}
        </WorkspaceButton>
      </header>

      {/* SPEC: 读取失败走统一横幅 —— 人话 + 下一步 + 可复制的技术详情，并且原地能重试。 */}
      {error ? (
        <AuthorityRequestError
          cause={error}
          message="Customer workspace request failed"
          onRetry={() => void loadList(history.current.current().query)}
        />
      ) : null}

      <form className="grid gap-3 rounded-xl bg-[var(--ad-surface)] p-4 sm:grid-cols-[minmax(0,1fr)_180px_auto]" onSubmit={(event) => { event.preventDefault(); applyQuery(query); }}>
        {/* INVARIANT: 两个控件都要 aria-label —— <label> 的可见文字与控件之间隔着一层 <span>，
            读屏在搜索框上只念得出 placeholder、在状态下拉上什么都念不出来。 */}
        <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">

          {t("Search")}
          <span className="relative"><Search className="pointer-events-none absolute left-3 top-3 h-4 w-4" /><input aria-label={t("Search customers")} className={`${fieldClass} pl-9`} onChange={(event) => updateDraft({ search: event.target.value })} placeholder={t("Email, name, or customer ID")} type="search" value={query.search} /></span>
        </label>
        <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">

          {t("Status")}
          <select aria-label={t("Customer status")} className={fieldClass} onChange={(event) => updateDraft({ status: event.target.value })} value={query.status}><option value="">{t("All")}</option><option value="active">{t("Active")}</option><option value="suspended">{t("Suspended")}</option><option value="deleted">{t("Deleted")}</option></select>
        </label>
        <WorkspaceButton tone="primary" type="submit">{t("Apply")}</WorkspaceButton>
      </form>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(420px,0.9fr)]">
        <section aria-label={t("Customer results")} className="overflow-hidden rounded-xl bg-[var(--ad-surface)]">
          {list && list.items.length > 0 ? (
            <ul className="divide-y divide-[var(--ad-border)]">
              {list.items.map((customer) => (
                <li key={customer.id}>
                  <button aria-current={selectedId === customer.id ? "true" : undefined} className={`grid min-h-24 w-full gap-3 p-4 text-left hover:bg-black/[0.025] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--ad-ink)] sm:grid-cols-[minmax(0,1fr)_repeat(3,110px)] ${selectedId === customer.id ? "bg-black/[0.04]" : ""}`} onClick={() => selectCustomer(customer.id)} type="button">
                    <span className="min-w-0"><span className="flex items-center gap-2 font-semibold"><UserRound className="h-4 w-4" />{customer.displayName ?? customer.email}</span><span className="mt-1 block truncate text-xs text-[var(--ad-text-muted)]">{customer.email} · {customer.id}</span><span className="mt-2 flex gap-2"><StatusBadge value={customer.status} />{customer.subscriptionStatus ? <StatusBadge value={customer.subscriptionStatus} /> : null}</span></span>
                    <ListStat label={t("Balance")} value={format.dreamcoins(customer.balanceDreamcoins)} />
                    <ListStat label={t("Active Cases")} value={customer.activeCaseCount} />
                    <ListStat label={t("Failed 30d")} value={customer.failedGenerationCount30d} />
                  </button>
                </li>
              ))}
            </ul>
          ) : error ? null : <EmptyWorkspace filtered={Boolean(query.search || query.status)} onClear={() => applyQuery(defaultCustomerQuery)} />}
          {list && list.items.length > 0 ? (
            <div className="border-t border-[var(--ad-border)] p-4">
              <Pagination
                hasNext={Boolean(list.pageInfo.hasNextPage && list.pageInfo.endCursor)}
                hasPrevious={cursorTrail.length > 0}
                loading={loading}
                onNext={() => {
                  if (!list.pageInfo.endCursor) return;
                  goToPage(list.pageInfo.endCursor, [...cursorTrail, query.cursor ?? ""]);
                }}
                onPrevious={() => goToPage(cursorTrail.at(-1) || undefined, cursorTrail.slice(0, -1))}
                page={cursorTrail.length + 1}
                pageSize={CUSTOMER_PAGE_SIZE}
                rowCount={list.items.length}
                // 后端 count 出来的筛选后总行数；缺席时传 null，分页条就只说"本页几条"。
                totalCount={list.pageInfo.totalCount ?? null}
              />
            </div>
          ) : null}
        </section>

        {selectedId ? (
          detailLoading && !detail ? <LoadingWorkspace label="Loading Customer 360…" /> : detail ? <CustomerInspector detail={detail} onClose={() => selectCustomer(null)} /> : null
        ) : <aside className="hidden rounded-xl bg-[var(--ad-surface-subtle)] p-8 text-sm text-[var(--ad-text-muted)] xl:block">{t("Select a customer to inspect their complete operational context.")}</aside>}
      </div>
    </div>
  );
}

function CustomerInspector({ detail, onClose }: { detail: Customer360; onClose: () => void }) {
  // INVARIANT: 枚举值走 value()（zhValues 通道），自由文案走 t()。billingPeriod（monthly/yearly）
  // 与 ledger.reason（取值见 schema.prisma 上 CoinLedger.reason 的注释）的词条已补齐；
  // 将来新增的取值没有词条时 value() 原样返回英文——比编一个译名诚实，补词条即自动生效。
  const { t, value } = useAdminI18n();
  const format = useAdminFormat();
  const subscription = detail.subscription;
  return (
    <aside aria-labelledby="customer-detail-title" className="space-y-5 rounded-xl bg-[var(--ad-surface)] p-5 xl:sticky xl:top-40">
      {/* SPEC: 封禁 / 注销状态必须出现在详情头 —— 列表里有、详情里没有，等于客服点开一个已封禁
          的客户后看不到他被封了，照常按正常流程答复。开户时间同理：是分辨"新号刷量"的第一眼依据。 */}
      <header className="flex items-start justify-between gap-4"><div className="min-w-0"><p className="truncate font-mono text-xs text-[var(--ad-text-muted)]">{detail.customer.id}</p><h3 className="mt-1 text-lg font-semibold" id="customer-detail-title">{detail.customer.displayName ?? detail.customer.email}</h3><p className="break-all text-xs text-[var(--ad-text-muted)]">{detail.customer.email}</p><div className="mt-2 flex flex-wrap items-center gap-2"><StatusBadge value={detail.customer.status} /><span className="text-xs text-[var(--ad-text-muted)]">{t("Customer since")} <time dateTime={detail.customer.createdAt}>{format.date(detail.customer.createdAt)}</time></span></div></div><button aria-label={t("Close customer detail")} className="grid min-h-11 min-w-11 place-items-center rounded-md hover:bg-black/[0.04]" onClick={onClose} type="button"><ArrowLeft className="h-4 w-4" /></button></header>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4"><ListStat label={t("Balance")} value={format.dreamcoins(detail.overview.balanceDreamcoins)} /><ListStat label={t("Active Cases")} value={detail.overview.activeCaseCount} /><ListStat label={t("Failed 30d")} value={detail.overview.failedGenerationCount30d} /><ListStat label={t("Last active")} value={detail.overview.lastActiveAt ? <RelativeTime referenceTime={detail.asOf} value={detail.overview.lastActiveAt} /> : "—"} /></dl>
      <DetailSection title={t("Subscription")}>{subscription ? <div className="space-y-1 text-sm"><p className="flex flex-wrap items-center gap-2"><strong>{subscription.plan.name}</strong><StatusBadge value={subscription.status} /><span className="text-xs text-[var(--ad-text-muted)]">{value(subscription.plan.billingPeriod)}</span></p><p className="text-xs text-[var(--ad-text-muted)]">{subscription.currentPeriodEnd ? <>{subscription.cancelAtPeriodEnd ? t("Access ends") : t("Renews")} <time dateTime={subscription.currentPeriodEnd}>{format.date(subscription.currentPeriodEnd)}</time></> : t("No period end on record")}</p>{subscription.cancelAtPeriodEnd ? <p className="text-xs text-[var(--ad-yellow-text)]">{t("Cancellation is already scheduled; it will not renew.")}</p> : null}</div> : <p className="text-sm text-[var(--ad-text-muted)]">{t("No subscription")}</p>}</DetailSection>
      <DetailSection title={t("Relationships ({count})", { count: detail.relationships.length })}>{detail.relationships.length === 0 ? <EmptyRows /> : <ul className="space-y-2">{detail.relationships.slice(0, 8).map((row) => <li className="flex justify-between gap-3 text-xs" key={row.sessionId}><Link className="truncate font-semibold underline" href={`/admin/characters/${encodeURIComponent(row.characterId)}`}>{row.characterName}</Link><span className="shrink-0 text-[var(--ad-text-muted)]">{row.lastMessageAt ? <RelativeTime referenceTime={detail.asOf} value={row.lastMessageAt} /> : "—"}</span></li>)}</ul>}</DetailSection>
      {/* SPEC: 工单行要带优先级和 SLA —— 客服看客户历史是为了判断"这人是不是一直没被处理"，
          光有类型和状态回答不了。超过 10 条时给出跳到工单队列的出口，而不是默默截断。 */}
      <DetailSection title={t("Cases ({count})", { count: detail.cases.length })}>{detail.cases.length === 0 ? <EmptyRows /> : <ul className="space-y-2">{detail.cases.slice(0, 10).map((row) => <li key={row.id}><Link className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-[var(--ad-surface-subtle)] p-2 text-xs hover:bg-black/[0.04]" href={`/admin/cases/${encodeURIComponent(row.id)}`}><span className="font-semibold">{t(row.type.replaceAll("_", " "))}</span><span className="flex items-center gap-2"><StatusBadge value={row.priority} /><StatusBadge value={row.status} /><span className="text-[var(--ad-text-muted)]"><RelativeTime referenceTime={detail.asOf} value={row.slaDueAt} /></span></span></Link></li>)}</ul>}{detail.cases.length > 10 ? <p className="mt-2 text-xs"><Link className="underline" href={`/admin/cases?view=all&search=${encodeURIComponent(detail.customer.id)}`}>{t("Open all Cases for this customer")}</Link></p> : null}</DetailSection>
      <DetailSection title={t("Generations ({count})", { count: detail.generations.length })}>{detail.generations.length === 0 ? <EmptyRows /> : <ul className="space-y-2">{detail.generations.slice(0, 8).map((row) => <li className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 text-xs" key={row.id}><Link className="truncate font-mono underline" href={`/admin/ops/jobs?job=${encodeURIComponent(row.id)}`} title={row.id}>{row.id}</Link><span className="text-[var(--ad-text-muted)]">{value(row.mode)} · {format.dreamcoins(row.costDreamcoins)}</span><StatusBadge value={row.status} /></li>)}</ul>}</DetailSection>
      <DetailSection title={t("Recent ledger")}>{detail.ledger.length === 0 ? <EmptyRows /> : <ul className="space-y-2">{detail.ledger.slice(0, 8).map((row) => <li className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-3 text-xs" key={row.id}><span className="truncate" title={row.reason}>{value(row.reason)}<time className="ml-2 text-[var(--ad-text-muted)]" dateTime={row.createdAt}>{format.date(row.createdAt)}</time></span>{/* 账本是有借有贷的流水，正负号必须显式；余额列紧跟其后，不再缀一遍单位。 */}<span className={`font-mono ${row.delta > 0 ? "text-[var(--ad-green-text)]" : ""}`}>{format.dreamcoins(row.delta, { signed: true })}</span><span className="font-mono text-[var(--ad-text-muted)]">{format.dreamcoins(row.balanceAfter, { unit: false })}</span></li>)}</ul>}</DetailSection>
      {/* SPEC: 运营改过什么必须能在客户档案里看到 —— 这份 activity 一直在响应里，之前整段丢弃，
          页面顶上却写着"operator history"。交接和申诉复核都要靠它回答"上一次是谁动的"。 */}
      <DetailSection title={t("Operator history ({count})", { count: detail.activity.length })}>{detail.activity.length === 0 ? <EmptyRows /> : <ol className="space-y-2">{detail.activity.slice(0, 10).map((row) => <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 text-xs" key={row.id}><code className="truncate" title={`${row.targetType} ${row.targetId}`}>{row.action}</code><span className="shrink-0 text-[var(--ad-text-muted)]"><RelativeTime referenceTime={detail.asOf} value={row.createdAt} /></span></li>)}</ol>}</DetailSection>
    </aside>
  );
}

function DetailSection({ children, title }: { children: React.ReactNode; title: string }) { return <section className="border-t border-[var(--ad-border)] pt-4"><h4 className="mb-3 text-sm font-semibold">{title}</h4>{children}</section>; }
function EmptyRows() { const { t } = useAdminI18n(); return <p className="text-xs text-[var(--ad-text-muted)]">{t("No records.")}</p>; }
function ListStat({ label, value }: { label: string; value: React.ReactNode }) { return <span><span className="block text-[10px] font-semibold uppercase tracking-wide text-[var(--ad-text-muted)]">{label}</span><span className="mt-1 block font-mono text-sm">{value}</span></span>; }
function stateFromLocation(initialCustomerId: string | null) { const parsed = typeof window === "undefined" ? { query: defaultCustomerQuery, selectedId: null } : parseCustomerWorkspaceParams(new URLSearchParams(window.location.search)); return { ...parsed, selectedId: initialCustomerId ?? parsed.selectedId ?? (typeof window === "undefined" ? null : workspaceDetailId(window.location.pathname, "/admin/customers")) }; }
function writeCustomerUrl(state: CustomerWorkspaceUrlState, mode: "push" | "replace") { setWorkspaceUrl(buildCustomerWorkspaceParams(state), { mode, pathname: customerWorkspacePath(state.selectedId) }); }
