"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Plus, RefreshCcw, RotateCcw, UploadCloud, X } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { DataTable, type DataTableRow } from "@/components/admin/ui/DataTable";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { PermissionNotice } from "@/components/admin/ui/PermissionNotice";
import { useFailureToast, useToast } from "@/components/admin/ui/Toast";
import { createLatestRequestGate } from "@/lib/latest-request";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import {
  canCreatePricingRule,
  defaultPricingDraft,
  defaultPricingQuery,
  isPricingQueryFiltered,
  pricingDraftPayload,
  pricingListPath,
  pricingQueryFromSearch,
  pricingWorkspaceUrl,
  type PricingDraft,
  type PricingQuery,
} from "./query";

type PricingRecord = Record<string, unknown>;
type PricingPageInfo = { endCursor: string | null; hasNextPage: boolean };
type PricingListResponse = { items: PricingRecord[]; pageInfo?: PricingPageInfo };
const emptyPageInfo: PricingPageInfo = { endCursor: null, hasNextPage: false };

export function PricingWorkspace({ canWrite }: { canWrite: boolean }) {
  const { t, value: valueLabel } = useAdminI18n();
  const { toast } = useToast();
  const failureToast = useFailureToast();
  const [query, setQuery] = useState<PricingQuery>(() => currentQuery());
  const [queryDraft, setQueryDraft] = useState<PricingQuery>(() => currentQuery());
  const [pricingDraft, setPricingDraft] = useState<PricingDraft>(defaultPricingDraft);
  const [rows, setRows] = useState<PricingRecord[] | null>(null);
  const [pageInfo, setPageInfo] = useState<PricingPageInfo>(emptyPageInfo);
  const [loading, setLoading] = useState(true);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCause, setErrorCause] = useState<unknown>(undefined);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmSpec | null>(null);
  const requestGate = useRef(createLatestRequestGate());
  const initialQuery = useRef(query);

  const load = useCallback(async (next: PricingQuery) => {
    const request = requestGate.current.begin();
    setLoading(true);
    setError(null);
    setErrorCause(undefined);
    try {
      const data = await apiGet<PricingListResponse>(pricingListPath(next));
      if (!request.isCurrent()) return;
      setRows(data.items);
      setPageInfo(data.pageInfo ?? emptyPageInfo);
      setRefreshedAt(new Date().toISOString());
    } catch (cause) {
      if (request.isCurrent()) {
        setError(cause instanceof Error ? cause.message : "Pricing authority request failed");
        setErrorCause(cause);
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
    window.addEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, restore);
    return () => {
      gate.invalidate();
      window.removeEventListener("popstate", restore);
      window.removeEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, restore);
    };
  }, [load]);

  function navigate(next: PricingQuery, mode: "push" | "replace" = "push") {
    const url = pricingWorkspaceUrl(window.location.pathname, window.location.search, {
      pricingSearch: next.search || null,
      pricingMode: next.mode || null,
      pricingStatus: next.status || null,
      pricingCursor: next.cursor || null,
    });
    window.history[mode === "push" ? "pushState" : "replaceState"](null, "", url);
    setQuery(next);
    setQueryDraft(next);
    void load(next);
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate({ ...queryDraft, cursor: "" });
  }

  function clearFilters() {
    navigate(defaultPricingQuery);
  }

  async function createDraft() {
    if (!canWrite || !canCreatePricingRule(pricingDraft)) return;
    setWriting(true);
    setError(null);
    try {
      await apiWrite(
        "/api/v2/admin/pricing/rules",
        "POST",
        pricingDraftPayload(pricingDraft),
        { "idempotency-key": crypto.randomUUID() },
      );
      setPricingDraft((current) => ({ ...current, reason: "", confirmation: "" }));
      toast({ tone: "success", title: t("Pricing draft {key} created", { key: pricingDraft.ruleKey }) });
      const next = { ...query, cursor: "" };
      navigate(next, "replace");
    } catch (cause) {
      // INTENT: 写失败不再灌进读错误横幅——那条横幅的 Retry 是重拉列表，救不了这次创建；
      //         草稿字段也一并保留，运营不用把七个格子重敲一遍。
      failureToast(cause);
    } finally {
      setWriting(false);
    }
  }

  function confirmVersionAction(row: PricingRecord, action: "publish" | "rollback") {
    const id = text(row.id);
    const name = text(row.label) || text(row.ruleKey) || id;
    const idempotencyKey = crypto.randomUUID();
    setConfirmation({
      title: action === "publish" ? t("Publish pricing rule") : t("Rollback pricing rule"),
      // INTENT: 这个框原来只写「名字 · 版本 N」——运营点「发布」的时候看不到自己要发布的价格
      //         是多少，也看不到它顶掉的是哪一版。定价页的整个意义就在这两个数上。
      summary: (
        <span>
          {name}  {t("· version")} {display(row.version)}  {t("· mode")} {text(row.mode) ? valueLabel(text(row.mode)) : "—"}
          <span className="mt-1 block">
            {t("Price: {base} base Dreamcoins × {multiplier}", {
              base: display(row.baseCost),
              multiplier: display(row.multiplier),
            })}
          </span>
          <span className="mt-1 block">{replacedVersionNote(rows, row, action, t)}</span>
        </span>
      ),
      destructive: { expectedName: name },
      // INTENT: publish 立刻改客户看到的价格并归档上一版；rollback 是把上一版请回来，
      //         两个都能被对方抵消，所以是可撤回的——但中间下单的客户按新价结算，说清楚。
      consequence: {
        effect:
          action === "publish"
            ? t("Customers are charged this price from the next generation onwards and the previous active version is archived. A rollback restores it, but orders placed in between keep the new price.")
            : t("The previously active version becomes the customer-facing price again from the next generation onwards."),
        reversible: true,
      },
      submitLabel: capitalize(action),
      onSubmit: async (reason) => {
        await apiWrite(
          `/api/v2/admin/pricing/rules/${encodeURIComponent(id)}/${action}`,
          "POST",
          { reason, confirmation: id },
          { "idempotency-key": idempotencyKey },
        );
        toast({
          tone: "success",
          title:
            action === "publish"
              ? t("Pricing rule {name} published", { name })
              : t("Pricing rule {name} rolled back", { name }),
        });
        const next = { ...query, cursor: "" };
        navigate(next, "replace");
      },
    });
  }

  const filtered = isPricingQueryFiltered(query);
  return (
    <section aria-labelledby="pricing-workspace-title" className="space-y-5">
      <div id="pricing-workspace-title"><PageHeader purpose="Version, publish, and roll back customer-facing generation prices while keeping every decision auditable." title={t("Pricing")} /></div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--ad-text-muted)]" role="status"><span>{refreshedAt ? <>{t("Refreshed")} <time dateTime={refreshedAt}>{new Date(refreshedAt).toLocaleTimeString()}</time></> : null}</span>{!canWrite ? <PermissionNotice permission="config.pricing.write" /> : null}</div>

      <form className="grid gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 md:grid-cols-2 xl:grid-cols-[minmax(240px,1fr)_180px_180px_auto]" onSubmit={apply}>
        <Field label="Search prices" onChange={(search) => setQueryDraft((current) => ({ ...current, search }))} placeholder={t("rule key, label, or ID")} value={queryDraft.search} />
        <Select label="Mode" onChange={(mode) => setQueryDraft((current) => ({ ...current, mode }))} optionLabel={valueLabel} options={["", "image", "video", "voice"]} value={queryDraft.mode} />
        <Select label="Status" onChange={(status) => setQueryDraft((current) => ({ ...current, status }))} optionLabel={valueLabel} options={["", "draft", "active", "archived"]} value={queryDraft.status} />
        <div className="flex items-end gap-2"><button className="min-h-11 rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white" type="submit">{t("Apply")}</button>{filtered ? <button aria-label={t("Clear pricing filters")} className="grid min-h-11 min-w-11 place-items-center rounded-md border border-[var(--ad-border)]" onClick={clearFilters} type="button"><X className="h-4 w-4" /></button> : null}</div>
      </form>

      {canWrite ? <PricingDraftForm busy={writing} draft={pricingDraft} onChange={setPricingDraft} onCreate={createDraft} /> : null}
      {error ? <AuthorityRequestError cause={errorCause} message={error} onRetry={() => void load(query)} snapshotAt={rows ? refreshedAt : null} /> : null}
      {loading && rows === null ? <PricingLoading /> : rows?.length === 0 ? <EmptyState action={filtered ? <button className="min-h-11 rounded-md border border-[var(--ad-border)] px-4 text-sm font-semibold" onClick={clearFilters} type="button">{t("Clear filters")}</button> : undefined} hint={filtered ? "The complete authority query returned no pricing versions." : "Create a versioned pricing draft before publishing a customer-facing price."} title={filtered ? "No pricing rules match these filters" : "No pricing rules exist yet"} /> : rows ? <PricingTable canWrite={canWrite} onAction={confirmVersionAction} rows={rows} /> : null}
      {/* MIGRATION: 只有「下一页」。ui/Pagination.tsx 已建（含上一页），合并后切过去。 */}
      {pageInfo.hasNextPage && pageInfo.endCursor ? <button className="inline-flex min-h-11 items-center gap-2 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-4 text-sm font-semibold" disabled={loading} onClick={() => navigate({ ...query, cursor: pageInfo.endCursor ?? "" })} type="button"><RefreshCcw className="h-4 w-4" />{t("Next page")}</button> : null}
      {confirmation ? <ConfirmDialog onClose={() => setConfirmation(null)} spec={confirmation} /> : null}
    </section>
  );
}

function PricingDraftForm({ busy, draft, onChange, onCreate }: { busy: boolean; draft: PricingDraft; onChange: (draft: PricingDraft) => void; onCreate: () => Promise<void> }) {
  const { t } = useAdminI18n();
  return <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4" aria-labelledby="pricing-draft-title"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold" id="pricing-draft-title">{t("Create Pricing Rule Draft")}</h3><p className="mt-1 text-xs text-[var(--ad-text-muted)]">{t("Draft → publish archives the previous active version; rollback restores the previous authority.")}</p></div><button className="inline-flex min-h-11 items-center gap-2 rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white disabled:opacity-50" disabled={busy || !canCreatePricingRule(draft)} onClick={() => void onCreate()} type="button">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}{t("Create Draft")}</button></div><div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-7"><Field label="Rule Key" onChange={(ruleKey) => onChange({ ...draft, ruleKey })} value={draft.ruleKey} /><Field label="Label" onChange={(label) => onChange({ ...draft, label })} value={draft.label} /><Select label="Mode" onChange={(mode) => onChange({ ...draft, mode: mode as PricingDraft["mode"] })} options={["image", "video", "voice"]} value={draft.mode} /><Field label="Base Cost (coins)" onChange={(baseCost) => onChange({ ...draft, baseCost })} value={draft.baseCost} /><Field label="Multiplier" onChange={(multiplier) => onChange({ ...draft, multiplier })} value={draft.multiplier} /><Field label="Reason (≥3)" onChange={(reason) => onChange({ ...draft, reason })} value={draft.reason} /><Field label="Confirm rule key" onChange={(confirmation) => onChange({ ...draft, confirmation })} value={draft.confirmation} /></div></section>;
}

function PricingTable({ canWrite, onAction, rows }: { canWrite: boolean; onAction: (row: PricingRecord, action: "publish" | "rollback") => void; rows: PricingRecord[] }) {
  const { value: valueLabel } = useAdminI18n();
  const tableRows: DataTableRow[] = rows.map((row, index) => {
    const status = text(row.status);
    const actions = canWrite && status === "draft" ? <ActionButton icon={<UploadCloud className="h-4 w-4" />} label="Publish" onClick={() => onAction(row, "publish")} /> : canWrite && status === "active" ? <ActionButton icon={<RotateCcw className="h-4 w-4" />} label="Rollback" onClick={() => onAction(row, "rollback")} /> : "—";
    // INTENT: 「哪一版在售」是这张表唯一要一眼看出来的东西，所以在售那一行的状态加粗。
    return { id: text(row.id) || `pricing-${index}`, cells: [<code key="id">{text(row.id) || "—"}</code>, text(row.ruleKey) || "—", text(row.label) || "—", text(row.mode) ? valueLabel(text(row.mode)) : "—", <span className="tabular-nums" key="base">{display(row.baseCost)}</span>, <span className="tabular-nums" key="multiplier">{display(row.multiplier)}</span>, status ? <span className={status === "active" ? "font-semibold" : undefined} key="status">{valueLabel(status)}</span> : "—", display(row.version), date(row.effectiveFrom), date(row.publishedAt), actions] };
  });
  return <DataTable caption="Pricing rule versions" headers={["ID", "Rule key", "Label", "Mode", "Base cost", "Multiplier", "Status", "Version", "Effective", "Published", "Action"]} rows={tableRows} />;
}

function ActionButton({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) { return <button className="inline-flex min-h-11 items-center gap-2 rounded-md border border-[var(--ad-border)] px-3 text-xs font-semibold" onClick={onClick} type="button">{icon}{label}</button>; }
function Field({ label, onChange, placeholder, value }: { label: string; onChange: (value: string) => void; placeholder?: string; value: string }) { return <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{label}<input className="min-h-11 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2" onChange={(event) => onChange(event.target.value)} placeholder={placeholder} value={value} /></label>; }
function Select({ label, onChange, optionLabel, options, value }: { label: string; onChange: (value: string) => void; optionLabel?: (option: string) => string; options: readonly string[]; value: string }) { const { t } = useAdminI18n(); return <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{label}<select className="min-h-11 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm" onChange={(event) => onChange(event.target.value)} value={value}>{options.map((option) => <option key={option || "all"} value={option}>{option ? (optionLabel?.(option) ?? option) : t("All")}</option>)}</select></label>; }
function PricingLoading() {
  const { t } = useAdminI18n(); return <div aria-label={t("Loading prices…")} className="overflow-hidden rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]" role="status"><span className="sr-only">{t("Loading prices…")}</span>{[0, 1, 2, 3].map((row) => <div className="grid min-h-14 animate-pulse grid-cols-5 gap-4 border-b border-[var(--ad-border)] px-4 py-3 last:border-0" key={row}>{[0, 1, 2, 3, 4].map((cell) => <span className="h-4 rounded bg-black/5" key={cell} />)}</div>)}</div>; }
/**
 * SPEC: 发布时说清楚它顶掉的是哪一版、那一版现在的价格是多少。
 *
 * INTENT: 表是一列平铺的版本，同一个 ruleKey 的 draft 和 active 可能隔着好几行。
 * 运营发布 v4 之前，得自己在表里找 v3 —— 那正是「改一个价格，影响面是什么」这个问题
 * 唯一能从现有契约里如实回答的部分。
 * INVARIANT: 契约里没有「当前有多少人在这个价位」，也没有商品关联，所以这里一个字都不提。
 *            找不到在售版本时（比如它不在当前这一页）就说找不到，不猜「没有」。
 */
export function replacedVersionNote(
  rows: PricingRecord[] | null,
  row: PricingRecord,
  action: "publish" | "rollback",
  t: (key: string, values?: Record<string, string | number>) => string,
) {
  if (action === "rollback") {
    return t("The version this restores is decided by the authority, not by this page.");
  }
  const ruleKey = text(row.ruleKey);
  const active = (rows ?? []).find(
    (candidate) => text(candidate.ruleKey) === ruleKey && text(candidate.status) === "active",
  );
  if (!active) {
    return t("No active version of this rule key is loaded here, so the price it replaces is unknown.");
  }
  return t("Replaces the live version {version}, priced at {base} base Dreamcoins × {multiplier}.", {
    base: display(active.baseCost),
    multiplier: display(active.multiplier),
    version: display(active.version),
  });
}

function currentQuery() { return typeof window === "undefined" ? defaultPricingQuery : pricingQueryFromSearch(window.location.search); }
// MIGRATION: 与 billing/access/promo 的同名三件套重复，等 ui/format.ts 统一后一起切。
function text(value: unknown) { return typeof value === "string" ? value : ""; }
function display(value: unknown) { return typeof value === "number" || typeof value === "string" ? String(value) : "—"; }
function date(value: unknown) { const raw = text(value); if (!raw) return "—"; const parsed = new Date(raw); return <time dateTime={raw}>{Number.isNaN(parsed.getTime()) ? raw : parsed.toLocaleString()}</time>; }
function capitalize(value: string) { return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`; }
