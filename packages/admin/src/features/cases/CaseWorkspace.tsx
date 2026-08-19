"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import Link from "next/link";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, CheckCircle2, ClipboardCheck, X } from "lucide-react";
import {
  APPEAL_CASE_DECISIONS,
  BILLING_CASE_ACTIONS,
  CONTENT_REPORT_CASE_DECISIONS,
  operationsCaseDetailSchema,
  operationsCaseListResponseSchema,
  SUPPORT_CASE_ACTIONS,
  type AdminListResponse,
  type OperationsCase,
} from "@idream/shared/admin";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { useAdminFormat } from "@/components/admin/ui/format";
import { Pagination } from "@/components/admin/ui/Pagination";
import { useFailureToast, useToast } from "@/components/admin/ui/Toast";
import { adminV2Request, setWorkspaceUrl } from "@/lib/admin-v2-api";
import { createWorkspaceHistoryController, observeWorkspacePopState, workspaceDetailId } from "@/lib/workspace-history";
import { CollaborationPanel } from "@/features/collaboration/CollaborationPanel";
import { SavedViewsControl } from "@/features/collaboration/SavedViewsControl";
import {
  caseQueryFromSavedState,
  caseSavedState,
  type SavedViewRecord,
} from "@/features/collaboration/saved-views";
import {
  buildCaseQuery,
  buildCaseWorkspaceParams,
  caseWorkspacePath,
  caseViews,
  defaultCaseQuery,
  parseCaseWorkspaceParams,
  type CaseQueryDraft,
  type CaseWorkspaceUrlState,
} from "./query";
import {
  EmptyWorkspace,
  fieldClass,
  LoadingWorkspace,
  RelativeTime,
  StatusBadge,
  textAreaClass,
  WorkspaceButton,
} from "../operations/WorkspaceUi";

type CaseList = AdminListResponse<OperationsCase>;

// SPEC: 详情响应用共享契约校验，不再自己抄一份窄类型。
// INTENT: 手抄的那份漏掉了 decisions/activity 的绝大多数字段，于是"上一步谁做了什么"在类型层面
// 就已经不存在了；服务端本来就是用同一个 schema parse 后才返回的。
type CaseDetail = ReturnType<typeof operationsCaseDetailSchema.parse>;

export function CaseWorkspace({ canAssign, canDecide, initialCaseId = null }: { canAssign: boolean; canDecide: boolean; initialCaseId?: string | null }) {
  const { t } = useAdminI18n();
  const format = useAdminFormat();
  const { toast } = useToast();
  const failureToast = useFailureToast();
  const [initialUrlState] = useState(() => initialCaseWorkspaceState(initialCaseId));
  const [query, setQuery] = useState<CaseQueryDraft>(initialUrlState.query);
  const [list, setList] = useState<CaseList | null>(null);
  const [selectedId, setSelectedId] = useState(initialUrlState.selectedId);
  const [selectedSavedViewId, setSelectedSavedViewId] = useState(initialUrlState.savedViewId);
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  // SPEC: 「上一页」重发自己走过的那个游标；工单列表还是单向 keyset（没有 startCursor /
  //       hasPreviousPage），栈空即第一页，置灰而不是给一个会 400 的按钮。
  const [cursorTrail, setCursorTrail] = useState<string[]>([]);
  const history = useRef(createWorkspaceHistoryController(initialUrlState));
  const listRequestId = useRef(0);
  const detailRequestId = useRef(0);

  const loadList = useCallback(async (next: CaseQueryDraft) => {
    const requestId = ++listRequestId.current;
    setLoading(true);
    try {
      const response = await adminV2Request<CaseList>(`/api/v2/admin/cases?${buildCaseQuery(next)}`, {
        schema: operationsCaseListResponseSchema,
      });
      if (requestId !== listRequestId.current) return;
      setList(response);
    } catch (loadError) {
      if (requestId === listRequestId.current) failureToast(loadError);
    } finally {
      if (requestId === listRequestId.current) setLoading(false);
    }
  }, [failureToast]);

  const loadDetail = useCallback(async (caseId: string) => {
    const requestId = ++detailRequestId.current;
    setDetailLoading(true);
    try {
      const response = await adminV2Request<CaseDetail>(`/api/v2/admin/cases/${encodeURIComponent(caseId)}`, {
        schema: operationsCaseDetailSchema,
      });
      if (requestId === detailRequestId.current) setDetail(response);
    } catch (loadError) {
      if (requestId === detailRequestId.current) failureToast(loadError);
    } finally {
      if (requestId === detailRequestId.current) setDetailLoading(false);
    }
  }, [failureToast]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const restored = stateFromLocation(initialCaseId);
      history.current.restore(restored);
      setQuery(restored.query);
      setSelectedSavedViewId(restored.savedViewId);
      setSelectedId(restored.selectedId);
      setDetail(null);
      if (!initialCaseId) history.current.replace(restored, writeCaseUrl);
      void loadList(restored.query);
      if (restored.selectedId) void loadDetail(restored.selectedId);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [initialCaseId, loadDetail, loadList]);

  useEffect(() => {
    return observeWorkspacePopState(window, () => stateFromLocation(null), (restored) => {
      listRequestId.current += 1;
      detailRequestId.current += 1;
      setQuery(restored.query);
      history.current.restore(restored);
      setSelectedSavedViewId(restored.savedViewId);
      setSelectedId(restored.selectedId);
      setDetail(null);
      void loadList(restored.query);
      if (restored.selectedId) void loadDetail(restored.selectedId);
    });
  }, [loadDetail, loadList]);

  function updateDraft(patch: Partial<CaseQueryDraft>) {
    const next = { ...query, ...patch, cursor: undefined };
    setQuery(next);
    history.current.draft({ ...history.current.current(), query: next }, writeCaseUrl);
  }

  function applyFilters(event?: FormEvent) {
    event?.preventDefault();
    const next = { ...query, cursor: undefined };
    setSelectedSavedViewId(null);
    setQuery(next);
    setCursorTrail([]);
    history.current.navigate({ query: next, selectedId, savedViewId: null }, writeCaseUrl);
    void loadList(next);
  }

  function selectView(view: string) {
    const next = { ...query, view, cursor: undefined };
    setSelectedSavedViewId(null);
    setQuery(next);
    setCursorTrail([]);
    history.current.navigate({ query: next, selectedId, savedViewId: null }, writeCaseUrl);
    void loadList(next);
  }

  function clearFilters() {
    const next = { ...defaultCaseQuery, view: query.view };
    setSelectedSavedViewId(null);
    setQuery(next);
    setCursorTrail([]);
    history.current.navigate({ query: next, selectedId, savedViewId: null }, writeCaseUrl);
    void loadList(next);
  }

  function goToPage(cursor: string | undefined, trail: string[]) {
    const next = { ...history.current.current().query, cursor };
    setQuery(next);
    setCursorTrail(trail);
    history.current.navigate({ query: next, selectedId, savedViewId: selectedSavedViewId }, writeCaseUrl);
    void loadList(next);
  }

  function selectCase(id: string | null) {
    detailRequestId.current += 1;
    setSelectedId(id);
    setDetail(null);
    history.current.navigate({ ...history.current.current(), selectedId: id }, writeCaseUrl);
    if (id) void loadDetail(id);
  }

  const applySavedView = useCallback((view: SavedViewRecord) => {
    const next = caseQueryFromSavedState(view.queryState);
    setSelectedSavedViewId(view.id);
    setQuery(next);
    setCursorTrail([]);
    history.current.navigate({ query: next, selectedId, savedViewId: view.id }, writeCaseUrl);
    void loadList(next);
  }, [loadList, selectedId]);

  const selectSavedView = useCallback((id: string | null) => {
    setSelectedSavedViewId(id);
  }, []);

  // SPEC: 写成功的提示必须等重新拉完数据再出现。
  // INTENT: 此前是"先弹已完成、再去拉列表"，重拉那几秒运营盯着的是旧队列配一句成功——
  // 尤其关闭工单后那条工单还在原地，很容易被再点一次。
  async function refreshAfterMutation(label: string) {
    const next = { ...history.current.current().query, cursor: undefined };
    setQuery(next);
    setCursorTrail([]);
    history.current.replace({ query: next, selectedId, savedViewId: selectedSavedViewId }, writeCaseUrl);
    await Promise.all([loadList(next), selectedId ? loadDetail(selectedId) : Promise.resolve()]);
    // INVARIANT: label 是词典 key，翻译收在这一处 —— 调用点散在十来个按钮上，
    // 让它们各自 t() 就是让其中几个忘记（旧的 notice 出口正是这样露出英文的）。
    toast({ tone: "success", title: t(label) });
  }

  async function mutate(label: string, execute: () => Promise<unknown>) {
    setBusy(true);
    try {
      await execute();
      await refreshAfterMutation(label);
    } catch (mutationError) {
      failureToast(mutationError);
    } finally {
      setBusy(false);
    }
  }

  const filtered = Boolean(query.search || query.type || query.status || query.priority || query.ownerId);

  return (
    <section aria-labelledby="case-workspace-title" className="space-y-5">
      <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div><h2 className="sr-only" id="case-workspace-title">{t("Cases")}</h2><p className="max-w-2xl text-sm leading-6 text-[var(--ad-text-muted)]">{t("Evidence, decision, downstream verification, and closure stay attached to the customer problem.")}</p></div>
        {list ? <p className="text-xs text-[var(--ad-text-muted)]" role="status">{t(list.freshness)}  {t("· data as of")} <time dateTime={list.asOf}>{format.time(list.asOf)}</time></p> : null}
      </header>

      <CaseTabs active={query.view} onChange={selectView} />

      <SavedViewsControl
        currentState={caseSavedState(query)}
        onApply={applySavedView}
        onSelectedChange={selectSavedView}
        scope="case"
        selectedId={selectedSavedViewId}
      />

      <form className="grid gap-3 rounded-xl bg-[var(--ad-surface)] p-4 md:grid-cols-2 xl:grid-cols-[minmax(220px,1fr)_repeat(4,150px)_auto]" onSubmit={applyFilters}>
        <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Search all cases")}<input className={fieldClass} onChange={(event) => updateDraft({ search: event.target.value })} placeholder={t("target or case key")} value={query.search} /></label>
        <Select label="Type" onChange={(type) => updateDraft({ type })} options={["", "content_report", "appeal", "support_request", "billing_dispute"]} value={query.type} />
        <Select label="Status" onChange={(status) => updateDraft({ status })} options={["", "new", "triaged", "in_progress", "waiting", "resolved", "closed", "reopened"]} value={query.status} />
        <Select label="Priority" onChange={(priority) => updateDraft({ priority })} options={["", "urgent", "high", "normal", "low"]} value={query.priority} />
        <Select label="Sort" onChange={(sort) => updateDraft({ sort: sort as CaseQueryDraft["sort"] })} options={["updated_desc", "updated_asc"]} value={query.sort} />
        <div className="flex items-end gap-2"><WorkspaceButton tone="primary" type="submit">{t("Apply")}</WorkspaceButton>{filtered ? <WorkspaceButton onClick={clearFilters}>{t("Clear")}</WorkspaceButton> : null}</div>
      </form>

      {loading && !list ? <LoadingWorkspace label="Loading cases" /> : list && list.items.length === 0 ? <EmptyWorkspace filtered={filtered} onClear={clearFilters} /> : (
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,0.92fr)_minmax(460px,1.08fr)]">
          <div className="space-y-2" aria-label={t("Case results")}>
            {list?.items.map((adminCase) => <CaseRow adminCase={adminCase} active={selectedId === adminCase.id} key={adminCase.id} onSelect={() => selectCase(adminCase.id)} referenceTime={list.asOf} />)}
            {list && list.items.length > 0 ? (
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
                pageSize={query.limit}
                rowCount={list.items.length}
                // 工单列表的 pageInfo 只有 endCursor / hasNextPage —— 总数拿不到就不显示"共 N 条"。
                totalCount={list.pageInfo.totalCount ?? null}
              />
            ) : null}
          </div>
          {selectedId ? detailLoading && !detail ? <LoadingWorkspace label="Loading case detail" /> : detail ? <CaseInspector busy={busy} canAssign={canAssign} canDecide={canDecide} detail={detail} key={detail.case.id} onClose={() => selectCase(null)} onConfirmed={refreshAfterMutation} onMutate={mutate} referenceTime={list?.asOf ?? detail.case.updatedAt} /> : null : <aside className="hidden rounded-xl bg-[var(--ad-surface-subtle)] p-8 text-sm text-[var(--ad-text-muted)] xl:block">{t("Select a case to inspect evidence and complete the decision loop.")}</aside>}
        </div>
      )}
    </section>
  );
}

function CaseTabs({ active, onChange }: { active: string; onChange: (view: string) => void }) {
  const { t, value } = useAdminI18n();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const next = (index + direction + caseViews.length) % caseViews.length;
    refs.current[next]?.focus();
    onChange(caseViews[next]);
  }
  return <div aria-label={t("Case queue views")} className="flex gap-1 overflow-x-auto rounded-lg bg-[var(--ad-surface-subtle)] p-1" role="group">{caseViews.map((view, index) => <button aria-pressed={active === view} className={`min-h-11 shrink-0 rounded-md px-3 text-sm font-semibold transition ${active === view ? "bg-[var(--ad-surface)] text-[var(--ad-ink)] shadow-sm" : "text-[var(--ad-text-muted)] hover:text-[var(--ad-ink)]"}`} key={view} onClick={() => onChange(view)} onKeyDown={(event) => onKeyDown(event, index)} ref={(node) => { refs.current[index] = node; }} type="button">{value(view)}</button>)}</div>;
}

// SPEC: 行上必须回答"卡了多久 / 上次谁动过"——队列按 updated_at 排序，却从不显示 updated_at，
// 运营只能靠 SLA 倒推。Opened 是工单真实年龄，Last touch 是它上次被人碰的时间。
function CaseRow({ active, adminCase, onSelect, referenceTime }: { active: boolean; adminCase: OperationsCase; onSelect: () => void; referenceTime: string }) {
  const { value } = useAdminI18n();
  const overdue = new Date(adminCase.slaDueAt).getTime() < new Date(referenceTime).getTime() && !["resolved", "closed"].includes(adminCase.status);
  return <button aria-current={active ? "true" : undefined} className={`group w-full rounded-lg bg-[var(--ad-surface)] p-4 text-left transition hover:-translate-y-0.5 hover:shadow-[var(--ad-shadow-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)] ${active ? "ring-1 ring-[var(--ad-ink)]" : ""}`} onClick={onSelect} type="button"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="text-xs font-semibold text-[var(--ad-text-muted)]">{value(adminCase.type)} · {value(adminCase.target.type)}</p><p className="mt-1 truncate font-mono text-sm font-semibold">{adminCase.target.id}</p></div><ArrowRight className="mt-1 h-4 w-4 shrink-0 text-[var(--ad-text-muted)] transition group-hover:translate-x-0.5" /></div><div className="mt-3 flex flex-wrap gap-2"><StatusBadge value={adminCase.priority} /><StatusBadge value={adminCase.status} />{overdue ? <StatusBadge tone="bad" value="overdue" /> : null}</div><dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4"><Stat label="Owner" value={adminCase.ownerId ?? value("unassigned")} /><Stat label="SLA" value={<RelativeTime referenceTime={referenceTime} value={adminCase.slaDueAt} />} /><Stat label="Opened" value={<RelativeTime referenceTime={referenceTime} value={adminCase.createdAt} />} /><Stat label="Last touch" value={<RelativeTime referenceTime={referenceTime} value={adminCase.updatedAt} />} /></dl></button>;
}

// SPEC: 详情里的所有相对时间都以列表快照 asOf 为基准，跟队列行保持同一个"现在"。
// INTENT: 此前基准是这条工单自己的 updatedAt，于是同一屏上行里写「SLA 71 hours ago · overdue」、
// 详情里写「SLA in 24 hours」——同一个字段两个答案，运营只能猜哪个是真的。
function CaseInspector({ busy, canAssign, canDecide, detail, onClose, onConfirmed, onMutate, referenceTime }: { busy: boolean; canAssign: boolean; canDecide: boolean; detail: CaseDetail; onClose: () => void; onConfirmed: (label: string) => Promise<void>; onMutate: (label: string, execute: () => Promise<unknown>) => Promise<void>; referenceTime: string }) {
  const { t, value } = useAdminI18n();
  const format = useAdminFormat();
  const adminCase = detail.case;
  const defaultEvidence = detail.evidence.map((item) => item.id).join(", ");
  const [ownerId, setOwnerId] = useState(adminCase.ownerId ?? "");
  const [priority, setPriority] = useState(adminCase.priority);
  const [reason, setReason] = useState("");
  const [confirmSpec, setConfirmSpec] = useState<ConfirmSpec | null>(null);
  const customerCase = adminCase.type === "support_request" || adminCase.type === "billing_dispute";
  const operationOptions = adminCase.type === "content_report"
    ? CONTENT_REPORT_CASE_DECISIONS
    : adminCase.type === "appeal"
      ? APPEAL_CASE_DECISIONS
      : adminCase.type === "billing_dispute"
        ? BILLING_CASE_ACTIONS
        : SUPPORT_CASE_ACTIONS;
  const [decision, setDecision] = useState<string>(operationOptions[0]);
  const [summary, setSummary] = useState(adminCase.resolutionSummary ?? "");
  const [outcomeRef, setOutcomeRef] = useState("");
  const [evidenceRefs, setEvidenceRefs] = useState(defaultEvidence);
  const [verificationOverrideReason, setVerificationOverrideReason] = useState("");
  const [resumeAt, setResumeAt] = useState("");
  const [decisionIdempotencyKey, setDecisionIdempotencyKey] = useState(() => crypto.randomUUID());
  const [verificationIdempotencyKey, setVerificationIdempotencyKey] = useState(() => crypto.randomUUID());
  const [verificationOverrideIdempotencyKey, setVerificationOverrideIdempotencyKey] = useState(() => crypto.randomUUID());
  const refs = evidenceRefs.split(",").map((item) => item.trim()).filter(Boolean);
  const verified = ["passed", "overridden"].includes(adminCase.verification?.state ?? "");
  const canClose = adminCase.status === "resolved" && verified;
  // SPEC: 说清楚为什么关不了，而不是给一个灰按钮。
  // INTENT: 关闭要「已解决 + 下游已验证」两个前提，此前两个前提都不在界面上，
  // 运营只能看见按钮是灰的，然后来问同事。
  const closeBlockedBy = canClose ? null : adminCase.status !== "resolved"
    ? t("Close needs a recorded decision first — this case is {status}, not resolved.", { status: value(adminCase.status) })
    : t("Close needs downstream verification to pass or be explicitly overridden first.");

  // SPEC: 生命周期与关闭走全站统一的 ConfirmDialog（确认串 + reason 都在框里收）。
  // INTENT: 此前这三个操作的确认串输入框散落在详情页里，而 reason 只在「分配」表单里存在——
  // 只有 case.decide 没有 case.assign 的运营，界面上根本没有能填 reason 的地方，
  // 于是关闭按钮永远是灰的且没有任何提示。ConfirmDialog 自带 reason≥3，一并修掉。
  function confirmCommand(input: { command: "wait" | "reopen" | "close"; title: string; effect: string; submitLabel: string; notice: string; body: (reason: string) => Record<string, unknown> }) {
    const expectedName = `${adminCase.id}:${input.command}`;
    // INVARIANT: 三个 command 端点都要 Idempotency-Key —— wait / reopen 此前根本没发，
    // 后端一律 400「Idempotency-Key header is required」，也就是说这两个按钮从来没成功过。
    // 键在开框时生成：同一个框里重试复用同一个键（重试不重复执行），取消再开则换新键。
    const idempotencyKey = crypto.randomUUID();
    setConfirmSpec({
      title: input.title,
      // SPEC: 后果以常驻横幅出现在敲确认串之前，不再混在 summary 里被当成说明文字读过去。
      // close 不可撤销 —— 重开会新开一条生命周期记录，不是把这一条收回来。
      consequence: { effect: input.effect, reversible: input.command !== "close" },
      destructive: { expectedName, inputLabel: t("Type confirmation") },
      submitLabel: input.submitLabel,
      onSubmit: async (confirmationReason) => {
        await adminV2Request(`/api/v2/admin/cases/${encodeURIComponent(adminCase.id)}/commands/${input.command}`, {
          method: "POST",
          idempotencyKey,
          body: { entityVersion: adminCase.version, confirmation: expectedName, ...input.body(confirmationReason) },
        });
        await onConfirmed(input.notice);
      },
    });
  }

  return <aside aria-labelledby="case-detail-title" className="rounded-xl bg-[var(--ad-surface)] shadow-[0_18px_50px_rgb(45_42_34/0.08)] xl:sticky xl:top-40"><header className="flex items-start justify-between gap-4 border-b border-[var(--ad-border)] p-5"><div className="min-w-0"><p className="text-xs font-semibold text-[var(--ad-text-muted)]">{value(adminCase.type)} · <span className="font-mono font-normal">{adminCase.caseKey}</span></p><h3 className="mt-1 truncate font-mono text-lg font-semibold" id="case-detail-title">{adminCase.target.id}</h3>
      {/* SPEC: 工单必须能一键跳到它背后的客户。此前 Cases→Customer 是断的（只有 Customer→Cases），
          客服要另开一个标签页把 ID 粘过去才能看到这人的余额、订阅和历史工单。 */}
      {adminCase.target.type === "user" ? <Link className="mt-1 inline-block text-xs underline" href={`/admin/customers/${encodeURIComponent(adminCase.target.id)}`}>{t("Open Customer 360")}</Link> : null}
      <div className="mt-3 flex flex-wrap gap-2"><StatusBadge value={adminCase.priority} /><StatusBadge value={adminCase.severity} /><StatusBadge value={adminCase.status} />{adminCase.verification ? <StatusBadge value={adminCase.verification.state} /> : null}</div></div><button aria-label={t("Close case detail")} className="grid min-h-11 min-w-11 place-items-center rounded-md hover:bg-black/[0.04]" onClick={onClose} type="button"><X className="h-4 w-4" /></button></header>
    <div className="space-y-5 p-5">
      <section aria-labelledby="case-summary-title"><h4 className="text-sm font-semibold" id="case-summary-title">{t("Summary")}</h4><dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4"><Stat label="Owner" value={adminCase.ownerId ?? value("unassigned")} /><Stat label="SLA" value={<RelativeTime referenceTime={referenceTime} value={adminCase.slaDueAt} />} /><Stat label="Opened" value={<RelativeTime referenceTime={referenceTime} value={adminCase.createdAt} />} /><Stat label="Evidence" value={detail.evidence.length} /></dl>{adminCase.resolutionSummary ? <p className="mt-3 rounded-md bg-[var(--ad-green-bg)] p-3 text-sm text-[var(--ad-green-text)]">{adminCase.resolutionSummary}</p> : null}{adminCase.verification?.overrideReason ? <p className="mt-2 rounded-md bg-[var(--ad-yellow-bg)] p-3 text-xs text-[var(--ad-yellow-text)]">{t("Verification overridden:")} {adminCase.verification.overrideReason}</p> : null}</section>

      {adminCase.relatedIncidentIds.length > 0 || adminCase.relatedCaseIds.length > 0 ? <nav aria-label={t("Related operational records")} className="rounded-md bg-[var(--ad-surface-subtle)] p-3"><h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--ad-text-muted)]">{t("Related records")}</h4><div className="mt-2 flex flex-wrap gap-2">{adminCase.relatedIncidentIds.map((id) => <Link className="rounded border border-[var(--ad-border)] px-2 py-1 text-xs font-semibold hover:border-[var(--ad-ink)]" href={`/admin/ops/incidents/${encodeURIComponent(id)}`} key={id}>{t("Incident")} {id}</Link>)}{adminCase.relatedCaseIds.map((id) => <Link className="rounded border border-[var(--ad-border)] px-2 py-1 text-xs font-semibold hover:border-[var(--ad-ink)]" href={`/admin/cases?case=${encodeURIComponent(id)}`} key={id}>{t("Case")} {id}</Link>)}</div></nav> : null}

      <section aria-labelledby="case-evidence-title"><div className="flex items-center justify-between"><h4 className="text-sm font-semibold" id="case-evidence-title">{t("Evidence")}</h4><span className="text-xs text-[var(--ad-text-muted)]">{t("immutable sources")}</span></div><ol className="mt-3 space-y-2">{detail.evidence.map((item) => <li className="rounded-md bg-[var(--ad-surface-subtle)] p-3" key={item.id}><div className="flex flex-wrap items-center justify-between gap-2"><span className="font-mono text-xs">{item.id}</span><span className="text-xs text-[var(--ad-text-muted)]"><RelativeTime referenceTime={referenceTime} value={item.occurredAt} /></span></div><p className="mt-2 text-sm leading-6">{item.summary}</p><p className="mt-2 text-xs text-[var(--ad-text-muted)]">{value(item.evidenceType)} · {value(item.access)}</p></li>)}</ol></section>

      {canAssign ? <form className="space-y-3 border-t border-[var(--ad-border)] pt-5" onSubmit={(event) => { event.preventDefault(); void onMutate("Case assignment saved", () => adminV2Request(`/api/v2/admin/cases/${encodeURIComponent(adminCase.id)}/assignment`, { method: "POST", body: { entityVersion: adminCase.version, ownerId: ownerId.trim() || null, priority, reason: reason.trim() } })); }}><h4 className="text-sm font-semibold">{t("Assignment")}</h4><div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Owner ID")}<input className={fieldClass} onChange={(event) => setOwnerId(event.target.value)} value={ownerId} /></label><Select label="Priority" onChange={(value) => setPriority(value as OperationsCase["priority"])} options={["urgent", "high", "normal", "low"]} value={priority} /></div><label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Audit reason")}<input className={fieldClass} onChange={(event) => setReason(event.target.value)} required value={reason} /></label><WorkspaceButton disabled={busy || reason.trim().length < 3} tone="primary" type="submit">{t("Save assignment")}</WorkspaceButton></form> : null}

      {canAssign || canDecide ? <section className="space-y-3 border-t border-[var(--ad-border)] pt-5"><h4 className="text-sm font-semibold">{t("Lifecycle")}</h4>{canAssign && ["new", "triaged", "in_progress", "reopened"].includes(adminCase.status) ? <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Resume after (optional)")}<input className={fieldClass} onChange={(event) => setResumeAt(event.target.value)} type="datetime-local" value={resumeAt} /></label> : null}<div className="flex flex-wrap gap-2">{canAssign && ["new", "triaged", "in_progress", "reopened"].includes(adminCase.status) ? <WorkspaceButton disabled={busy} onClick={() => confirmCommand({ command: "wait", title: t("Park this case on a dependency"), effect: t("The case leaves the active queue until someone resumes it. SLA keeps running."), submitLabel: t("Wait for dependency"), notice: "Case moved to waiting", body: (waitReason) => ({ reason: waitReason, resumeAt: resumeAt ? new Date(resumeAt).toISOString() : undefined }) })}>{t("Wait for dependency")}</WorkspaceButton> : null}{canDecide && ["resolved", "closed"].includes(adminCase.status) ? <WorkspaceButton disabled={busy} onClick={() => confirmCommand({ command: "reopen", title: t("Reopen this case"), effect: t("A resolved case goes back to the active queue, or a recurrence is filed against it."), submitLabel: t("Reopen / create recurrence"), notice: "Case reopened or recurrence created", body: (reopenReason) => ({ reason: reopenReason }) })}>{t("Reopen / create recurrence")}</WorkspaceButton> : null}</div></section> : null}

      {canDecide ? <section className="space-y-4 border-t border-[var(--ad-border)] pt-5" aria-labelledby="case-decision-title"><h4 className="text-sm font-semibold" id="case-decision-title">{t("Decision and verification")}</h4><Select label={customerCase ? "Customer action" : "Decision"} onChange={setDecision} options={operationOptions} value={decision} />{customerCase ? <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Outcome reference")}<input className={fieldClass} onChange={(event) => setOutcomeRef(event.target.value)} placeholder={adminCase.type === "billing_dispute" ? "ledger:<id>, refund:<id>, subscription:<id>:<status>" : "incident:<id>"} value={outcomeRef} /></label> : null}<label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Resolution summary")}<textarea className={textAreaClass} onChange={(event) => setSummary(event.target.value)} value={summary} /></label><label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Evidence IDs (comma separated)")}<input className={fieldClass} onChange={(event) => setEvidenceRefs(event.target.value)} value={evidenceRefs} /></label><div className="flex flex-wrap gap-2"><WorkspaceButton disabled={busy || !decision || !summary.trim() || refs.length === 0 || (customerCase && !outcomeRef.trim())} onClick={() => void onMutate(customerCase ? "Customer Case action recorded" : "Case decision recorded", async () => { const result = await adminV2Request(`/api/v2/admin/cases/${encodeURIComponent(adminCase.id)}/${customerCase ? "actions" : "decisions"}`, { method: "POST", idempotencyKey: decisionIdempotencyKey, body: customerCase ? { entityVersion: adminCase.version, action: decision, summary: summary.trim(), evidenceRefs: refs, outcomeRef: outcomeRef.trim() } : { entityVersion: adminCase.version, decision, summary: summary.trim(), evidenceRefs: refs } }); setDecisionIdempotencyKey(crypto.randomUUID()); return result; })}><ClipboardCheck className="h-4 w-4" />{customerCase ? t("Record action") : t("Record decision")}</WorkspaceButton><WorkspaceButton disabled={busy || !adminCase.resolutionSummary || refs.length === 0} onClick={() => void onMutate("Downstream outcome verified", async () => { const result = await adminV2Request(`/api/v2/admin/cases/${encodeURIComponent(adminCase.id)}/verification`, { method: "POST", idempotencyKey: verificationIdempotencyKey, body: { entityVersion: adminCase.version, state: "passed", evidenceRefs: refs } }); setVerificationIdempotencyKey(crypto.randomUUID()); return result; })}><CheckCircle2 className="h-4 w-4" />{t("Verify from authority")}</WorkspaceButton></div><label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Override reason (only when automatic verification is unavailable)")}<textarea className={textAreaClass} onChange={(event) => setVerificationOverrideReason(event.target.value)} value={verificationOverrideReason} /></label><WorkspaceButton disabled={busy || !adminCase.resolutionSummary || refs.length === 0 || verificationOverrideReason.trim().length < 3} onClick={() => void onMutate("Case verification explicitly overridden", async () => { const result = await adminV2Request(`/api/v2/admin/cases/${encodeURIComponent(adminCase.id)}/verification`, { method: "POST", idempotencyKey: verificationOverrideIdempotencyKey, body: { entityVersion: adminCase.version, state: "overridden", evidenceRefs: refs, overrideReason: verificationOverrideReason.trim() } }); setVerificationOverrideIdempotencyKey(crypto.randomUUID()); return result; })}>{t("Override verification")}</WorkspaceButton>
        <div className="rounded-md bg-[var(--ad-surface-subtle)] p-3">{closeBlockedBy ? <p className="text-xs text-[var(--ad-text-muted)]">{closeBlockedBy}</p> : null}<div className={closeBlockedBy ? "mt-3" : undefined}><WorkspaceButton disabled={busy || !canClose} tone="danger" onClick={() => confirmCommand({ command: "close", title: t("Close case"), effect: t("Closing is the end of this customer problem. Reopening it later files a new lifecycle entry."), submitLabel: t("Close case"), notice: "Case close command accepted", body: (closeReason) => ({ reason: { code: "outcome_verified", summary: closeReason } }) })}>{t("Close case")}</WorkspaceButton></div></div>
      </section> : <p className="rounded-md bg-[var(--ad-surface-subtle)] p-3 text-sm text-[var(--ad-text-muted)]">{t("Read access only. Decisions require")} <code>{t("case.decide")}</code>.</p>}

      {/* SPEC: 决策记录与审计时间线 —— 这两段一直在详情响应里，之前整段丢弃。
          「上一步谁做的、为什么」是接手一条工单的第一个问题，此前界面上根本没有答案。 */}
      {detail.decisions.length > 0 ? <section aria-labelledby="case-decisions-title" className="border-t border-[var(--ad-border)] pt-5"><h4 className="text-sm font-semibold" id="case-decisions-title">{t("Recorded decisions")}</h4><ol className="mt-3 space-y-2">{detail.decisions.map((item) => <li className="rounded-md bg-[var(--ad-surface-subtle)] p-3" key={item.id}><div className="flex flex-wrap items-center justify-between gap-2"><StatusBadge value={item.decision} /><time className="text-xs text-[var(--ad-text-muted)]" dateTime={item.createdAt}>{format.dateTime(item.createdAt)}</time></div><p className="mt-2 text-sm leading-6">{item.question}</p><p className="mt-1 text-xs text-[var(--ad-text-muted)]">{t("Owner")}: <span className="font-mono">{item.ownerId}</span> · {t("Evidence level")}: {value(item.evidenceLevel)}</p></li>)}</ol></section> : null}

      <section aria-labelledby="case-audit-title" className="border-t border-[var(--ad-border)] pt-5"><h4 className="text-sm font-semibold" id="case-audit-title">{t("Audit trail")}</h4>{detail.activity.length === 0 ? <p className="mt-3 text-sm text-[var(--ad-text-muted)]">{t("No operator actions recorded on this case yet.")}</p> : <ol className="mt-3 space-y-2">{detail.activity.slice(0, 20).map((item) => <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-l-2 border-[var(--ad-border)] pl-3 text-xs" key={item.id}><span className="min-w-0"><code className="break-all font-semibold">{item.action}</code><span className="mt-0.5 block text-[var(--ad-text-muted)]">{item.actorId} · {value(item.actorRole)}</span>{item.reason ? <span className="mt-0.5 block break-words leading-5">{item.reason}</span> : null}</span><span className="shrink-0 text-[var(--ad-text-muted)]"><RelativeTime referenceTime={referenceTime} value={item.createdAt} /></span></li>)}</ol>}</section>

      <CollaborationPanel canWrite={canAssign} onAuthorityChange={() => void onConfirmed("Ownership transferred; the case was reloaded from authority.")} targetId={adminCase.id} targetType="case" targetVersion={adminCase.version} />
      {confirmSpec ? <ConfirmDialog onClose={() => setConfirmSpec(null)} spec={confirmSpec} /> : null}
    </div></aside>;
}

// INVARIANT: 选项是枚举，走 value()（zhValues 下划线键），不是 t(空格形态) —— 后者查的是
// 主表里根本不存在的键，中文界面上会原样吐出 "content report" 这种英文。
function Select({ label, onChange, options, value }: { label: string; onChange: (value: string) => void; options: readonly string[]; value: string }) { const { t, value: enumLabel } = useAdminI18n(); return <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t(label)}<select className={fieldClass} onChange={(event) => onChange(event.target.value)} value={value}>{options.map((option) => <option key={option || "all"} value={option}>{option ? enumLabel(option) : enumLabel("all")}</option>)}</select></label>; }
function Stat({ label, value }: { label: string; value: ReactNode }) { const { t } = useAdminI18n(); return <div><dt className="text-[10px] font-semibold uppercase tracking-wide text-[var(--ad-text-muted)]">{t(label)}</dt><dd className="mt-1 truncate font-mono text-sm text-[var(--ad-ink)]" title={typeof value === "string" ? value : undefined}>{value}</dd></div>; }
// INVARIANT: server and first browser render must use the same state; location is restored after hydration.
function initialCaseWorkspaceState(initialCaseId: string | null): CaseWorkspaceUrlState {
  return { query: defaultCaseQuery, selectedId: initialCaseId, savedViewId: null };
}
function stateFromLocation(initialCaseId: string | null): CaseWorkspaceUrlState {
  const parsed = parseCaseWorkspaceParams(new URLSearchParams(window.location.search));
  return {
    ...parsed,
    selectedId: initialCaseId ?? parsed.selectedId ?? workspaceDetailId(window.location.pathname, "/admin/cases"),
  };
}
function writeCaseUrl(state: CaseWorkspaceUrlState, mode: "push" | "replace") { setWorkspaceUrl(buildCaseWorkspaceParams(state), { mode, pathname: caseWorkspacePath(state.selectedId) }); }
