"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Plus, RefreshCcw, RotateCcw, UploadCloud, X } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { DataTable, type DataTableRow } from "@/components/admin/ui/DataTable";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { createLatestRequestGate } from "@/lib/latest-request";
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
  const { t } = useAdminI18n();
  const [query, setQuery] = useState<PricingQuery>(() => currentQuery());
  const [queryDraft, setQueryDraft] = useState<PricingQuery>(() => currentQuery());
  const [pricingDraft, setPricingDraft] = useState<PricingDraft>(defaultPricingDraft);
  const [rows, setRows] = useState<PricingRecord[] | null>(null);
  const [pageInfo, setPageInfo] = useState<PricingPageInfo>(emptyPageInfo);
  const [loading, setLoading] = useState(true);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmSpec | null>(null);
  const requestGate = useRef(createLatestRequestGate());
  const initialQuery = useRef(query);

  const load = useCallback(async (next: PricingQuery) => {
    const request = requestGate.current.begin();
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<PricingListResponse>(pricingListPath(next));
      if (!request.isCurrent()) return;
      setRows(data.items);
      setPageInfo(data.pageInfo ?? emptyPageInfo);
      setRefreshedAt(new Date().toISOString());
    } catch (cause) {
      if (request.isCurrent()) setError(cause instanceof Error ? cause.message : "Pricing authority request failed");
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
      const next = { ...query, cursor: "" };
      navigate(next, "replace");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pricing rule draft could not be created");
    } finally {
      setWriting(false);
    }
  }

  function confirmVersionAction(row: PricingRecord, action: "publish" | "rollback") {
    const id = text(row.id);
    const name = text(row.label) || text(row.ruleKey) || id;
    const idempotencyKey = crypto.randomUUID();
    setConfirmation({
      title: `${capitalize(action)} pricing rule`,
      summary: <span>{name}  {t("· version")} {display(row.version)}</span>,
      destructive: { expectedName: name },
      submitLabel: capitalize(action),
      onSubmit: async (reason) => {
        await apiWrite(
          `/api/v2/admin/pricing/rules/${encodeURIComponent(id)}/${action}`,
          "POST",
          { reason, confirmation: id },
          { "idempotency-key": idempotencyKey },
        );
        const next = { ...query, cursor: "" };
        navigate(next, "replace");
      },
    });
  }

  const filtered = isPricingQueryFiltered(query);
  return (
    <section aria-labelledby="pricing-workspace-title" className="space-y-5">
      <div id="pricing-workspace-title"><PageHeader purpose="Version, publish, and roll back customer-facing generation prices while keeping every decision auditable." title={t("Pricing & Offers")} /></div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--ad-text-muted)]" role="status"><span>{t("Legacy compatibility authority · freshness watermark unavailable")}{refreshedAt ? <>  {t("· refreshed")} <time dateTime={refreshedAt}>{new Date(refreshedAt).toLocaleTimeString()}</time></> : null}</span>{!canWrite ? <strong>{t("Read only · config.pricing.write is not granted")}</strong> : null}</div>

      <form className="grid gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 md:grid-cols-2 xl:grid-cols-[minmax(240px,1fr)_180px_180px_auto]" onSubmit={apply}>
        <Field label="Search pricing authority" onChange={(search) => setQueryDraft((current) => ({ ...current, search }))} placeholder={t("rule key, label, or ID")} value={queryDraft.search} />
        <Select label="Mode" onChange={(mode) => setQueryDraft((current) => ({ ...current, mode }))} options={["", "image", "video", "voice"]} value={queryDraft.mode} />
        <Select label="Status" onChange={(status) => setQueryDraft((current) => ({ ...current, status }))} options={["", "draft", "active", "archived"]} value={queryDraft.status} />
        <div className="flex items-end gap-2"><button className="min-h-11 rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white" type="submit">{t("Apply")}</button>{filtered ? <button aria-label={t("Clear pricing filters")} className="grid min-h-11 min-w-11 place-items-center rounded-md border border-[var(--ad-border)]" onClick={clearFilters} type="button"><X className="h-4 w-4" /></button> : null}</div>
      </form>

      {canWrite ? <PricingDraftForm busy={writing} draft={pricingDraft} onChange={setPricingDraft} onCreate={createDraft} /> : null}
      {error ? <div className="rounded-md bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]" role="alert">{error}<button className="ml-3 min-h-8 rounded border border-current px-2 font-semibold" onClick={() => void load(query)} type="button">{t("Retry")}</button></div> : null}
      {loading && rows === null ? <PricingLoading /> : rows?.length === 0 ? <EmptyState action={filtered ? <button className="min-h-11 rounded-md border border-[var(--ad-border)] px-4 text-sm font-semibold" onClick={clearFilters} type="button">{t("Clear filters")}</button> : undefined} hint={filtered ? "The complete authority query returned no pricing versions." : "Create a versioned pricing draft before publishing a customer-facing price."} title={filtered ? "No pricing rules match these filters" : "No pricing rules exist yet"} /> : rows ? <PricingTable canWrite={canWrite} onAction={confirmVersionAction} rows={rows} /> : null}
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
  const tableRows: DataTableRow[] = rows.map((row, index) => {
    const status = text(row.status);
    const actions = canWrite && status === "draft" ? <ActionButton icon={<UploadCloud className="h-4 w-4" />} label="Publish" onClick={() => onAction(row, "publish")} /> : canWrite && status === "active" ? <ActionButton icon={<RotateCcw className="h-4 w-4" />} label="Rollback" onClick={() => onAction(row, "rollback")} /> : "—";
    return { id: text(row.id) || `pricing-${index}`, cells: [<code key="id">{text(row.id) || "—"}</code>, text(row.ruleKey) || "—", text(row.label) || "—", text(row.mode) || "—", display(row.baseCost), display(row.multiplier), status || "—", display(row.version), date(row.effectiveFrom), date(row.publishedAt), actions] };
  });
  return <DataTable caption="Pricing rule versions" headers={["ID", "Rule key", "Label", "Mode", "Base cost", "Multiplier", "Status", "Version", "Effective", "Published", "Action"]} rows={tableRows} />;
}

function ActionButton({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) { return <button className="inline-flex min-h-11 items-center gap-2 rounded-md border border-[var(--ad-border)] px-3 text-xs font-semibold" onClick={onClick} type="button">{icon}{label}</button>; }
function Field({ label, onChange, placeholder, value }: { label: string; onChange: (value: string) => void; placeholder?: string; value: string }) { return <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{label}<input className="min-h-11 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2" onChange={(event) => onChange(event.target.value)} placeholder={placeholder} value={value} /></label>; }
function Select({ label, onChange, options, value }: { label: string; onChange: (value: string) => void; options: readonly string[]; value: string }) { return <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{label}<select className="min-h-11 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm" onChange={(event) => onChange(event.target.value)} value={value}>{options.map((option) => <option key={option || "all"} value={option}>{option || "All"}</option>)}</select></label>; }
function PricingLoading() {
  const { t } = useAdminI18n(); return <div aria-label={t("Loading pricing authority")} className="overflow-hidden rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]" role="status"><span className="sr-only">{t("Loading pricing authority")}</span>{[0, 1, 2, 3].map((row) => <div className="grid min-h-14 animate-pulse grid-cols-5 gap-4 border-b border-[var(--ad-border)] px-4 py-3 last:border-0" key={row}>{[0, 1, 2, 3, 4].map((cell) => <span className="h-4 rounded bg-black/5" key={cell} />)}</div>)}</div>; }
function currentQuery() { return typeof window === "undefined" ? defaultPricingQuery : pricingQueryFromSearch(window.location.search); }
function text(value: unknown) { return typeof value === "string" ? value : ""; }
function display(value: unknown) { return typeof value === "number" || typeof value === "string" ? String(value) : "—"; }
function date(value: unknown) { const raw = text(value); if (!raw) return "—"; const parsed = new Date(raw); return <time dateTime={raw}>{Number.isNaN(parsed.getTime()) ? raw : parsed.toLocaleString()}</time>; }
function capitalize(value: string) { return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`; }
