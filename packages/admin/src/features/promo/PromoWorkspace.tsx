"use client";

import { Ban, Loader2, Plus, RefreshCcw, X } from "lucide-react";
import type { FormEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiWrite } from "@/components/admin/api";
import {
  ConfirmDialog,
  type ConfirmSpec,
} from "@/components/admin/ui/ConfirmDialog";
import { DataTable, type DataTableRow } from "@/components/admin/ui/DataTable";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { createLatestRequestGate } from "@/lib/latest-request";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import {
  defaultPromoQuery,
  promoListPath,
  promoQueryFromSearch,
  promoWorkspaceUrl,
  type PromoQuery,
  type PromoScope,
} from "./query";

type Row = Record<string, unknown>;
type PageInfo = { endCursor: string | null; hasNextPage: boolean };
type ListResponse = { items: Row[]; pageInfo?: PageInfo };
type AuthorityState = {
  rows: Row[] | null;
  pageInfo: PageInfo;
  loading: boolean;
  error: string | null;
  refreshedAt: string | null;
};

const emptyPageInfo: PageInfo = { endCursor: null, hasNextPage: false };
const emptyAuthority = (): AuthorityState => ({
  rows: null,
  pageInfo: emptyPageInfo,
  loading: true,
  error: null,
  refreshedAt: null,
});

export function PromoWorkspace({ canWrite }: { canWrite: boolean }) {
  const [query, setQuery] = useState<PromoQuery>(() => currentQuery());
  const [draft, setDraft] = useState<PromoQuery>(() => currentQuery());
  const [codes, setCodes] = useState<AuthorityState>(emptyAuthority);
  const [referrals, setReferrals] = useState<AuthorityState>(emptyAuthority);
  const [confirmation, setConfirmation] = useState<ConfirmSpec | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const gates = useRef({
    codes: createLatestRequestGate(),
    referrals: createLatestRequestGate(),
  });
  const initialQuery = useRef(query);

  const loadScope = useCallback(async (next: PromoQuery, scope: PromoScope) => {
    const request = gates.current[scope].begin();
    const setter = scope === "codes" ? setCodes : setReferrals;
    setter((state) => ({ ...state, loading: true, error: null }));
    try {
      const response = await apiGet<ListResponse>(promoListPath(next, scope));
      if (!request.isCurrent()) return;
      setter({
        rows: response.items,
        pageInfo: response.pageInfo ?? emptyPageInfo,
        loading: false,
        error: null,
        refreshedAt: new Date().toISOString(),
      });
    } catch (cause) {
      if (!request.isCurrent()) return;
      setter((state) => ({
        ...state,
        loading: false,
        error:
          cause instanceof Error
            ? cause.message
            : `${scope} authority request failed`,
      }));
    }
  }, []);

  const load = useCallback(
    (next: PromoQuery) => {
      void loadScope(next, "codes");
      void loadScope(next, "referrals");
    },
    [loadScope],
  );

  useEffect(() => {
    const requestGates = gates.current;
    load(initialQuery.current);
    const restore = () => {
      const next = currentQuery();
      setQuery(next);
      setDraft(next);
      load(next);
    };
    window.addEventListener("popstate", restore);
    window.addEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, restore);
    return () => {
      requestGates.codes.invalidate();
      requestGates.referrals.invalidate();
      window.removeEventListener("popstate", restore);
      window.removeEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, restore);
    };
  }, [load]);

  function navigate(next: PromoQuery, mode: "push" | "replace" = "push") {
    const url = promoWorkspaceUrl(
      window.location.pathname,
      window.location.search,
      next,
    );
    window.history[mode === "push" ? "pushState" : "replaceState"](
      null,
      "",
      url,
    );
    setQuery(next);
    setDraft(next);
    load(next);
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate({ ...draft, codeCursor: "", referralCursor: "" });
  }

  function confirmDisable(id: string) {
    if (!canWrite) return;
    const idempotencyKey = crypto.randomUUID();
    setConfirmation({
      title: `Disable ${id}`,
      destructive: { expectedName: id, inputLabel: "Confirmation" },
      reasonLabel: "Reason",
      submitLabel: "Disable",
      onSubmit: async (reason) => {
        await apiWrite(
          `/api/v1/admin/promo/redeem-codes/${id}/disable`,
          "POST",
          { reason, confirmation: id },
          { "idempotency-key": idempotencyKey },
        );
        setNotice(`Disable ${id} completed.`);
        navigate({ ...query, codeCursor: "" }, "replace");
      },
    });
  }

  const filtered = Boolean(
    query.search || query.codeStatus || query.referralStatus,
  );
  return (
    <section className="space-y-5">
      <PageHeader
        purpose="Operate redeem codes and inspect referral authority through independent, server-filtered snapshots."
        title="Promotions"
      />
      <div
        className="flex flex-wrap justify-between gap-3 text-xs text-[var(--ad-text-muted)]"
        role="status"
      >
        <div className="flex flex-wrap gap-3">
          <Freshness label="Redeem codes" state={codes} />
          <Freshness label="Referrals" state={referrals} />
        </div>
        {!canWrite ? (
          <strong>Read only · growth.promo.write is not granted</strong>
        ) : null}
      </div>
      <form
        className="grid gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 md:grid-cols-2 xl:grid-cols-[minmax(280px,1fr)_200px_200px_auto]"
        onSubmit={apply}
      >
        <Field
          label="Search"
          onChange={(search) => setDraft((value) => ({ ...value, search }))}
          search
          value={draft.search}
        />
        <Select
          label="Code status"
          onChange={(codeStatus) =>
            setDraft((value) => ({ ...value, codeStatus }))
          }
          options={["", "active", "disabled", "expired"]}
          value={draft.codeStatus}
        />
        <Select
          label="Referral status"
          onChange={(referralStatus) =>
            setDraft((value) => ({ ...value, referralStatus }))
          }
          options={["", "pending", "qualified", "rewarded", "rejected"]}
          value={draft.referralStatus}
        />
        <div className="flex items-end gap-2">
          <button
            className="min-h-11 rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white"
            type="submit"
          >
            Filter promotions
          </button>
          {filtered ? (
            <button
              aria-label="Clear promotion filters"
              className="grid min-h-11 min-w-11 place-items-center rounded-md border"
              onClick={() => navigate(defaultPromoQuery)}
              type="button"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </form>
      {canWrite ? (
        <RedeemCodeForm
          onCreated={() => navigate({ ...query, codeCursor: "" }, "replace")}
        />
      ) : null}
      {notice ? (
        <p
          aria-live="polite"
          className="rounded-md bg-[var(--ad-green-bg)] p-3 text-sm text-[var(--ad-green-text)]"
          data-testid="admin-action-status"
          role="status"
        >
          {notice}
        </p>
      ) : null}
      <AuthorityError
        label="redeem codes"
        onRetry={() => void loadScope(query, "codes")}
        state={codes}
      />
      <AuthoritySection
        empty={
          filtered
            ? "No redeem codes match these filters"
            : "No redeem codes exist yet"
        }
        loadingLabel="Loading redeem-code authority"
        rows={codeRows(codes.rows ?? [], canWrite, confirmDisable)}
        state={codes}
        title="Redeem codes"
      />
      <Pager
        label="Next code page"
        loading={codes.loading}
        onClick={() =>
          navigate({ ...query, codeCursor: codes.pageInfo.endCursor ?? "" })
        }
        pageInfo={codes.pageInfo}
      />
      <AuthorityError
        label="referrals"
        onRetry={() => void loadScope(query, "referrals")}
        state={referrals}
      />
      <AuthoritySection
        empty={
          filtered
            ? "No referrals match these filters"
            : "No referrals exist yet"
        }
        loadingLabel="Loading referral authority"
        rows={referralRows(referrals.rows ?? [])}
        state={referrals}
        title="Referrals"
      />
      <Pager
        label="Next referral page"
        loading={referrals.loading}
        onClick={() =>
          navigate({
            ...query,
            referralCursor: referrals.pageInfo.endCursor ?? "",
          })
        }
        pageInfo={referrals.pageInfo}
      />
      {confirmation ? (
        <ConfirmDialog
          onClose={() => setConfirmation(null)}
          spec={confirmation}
        />
      ) : null}
    </section>
  );
}

function RedeemCodeForm({ onCreated }: { onCreated: () => void }) {
  const [code, setCode] = useState("");
  const [dreamcoins, setDreamcoins] = useState("");
  const [maxRedemptions, setMaxRedemptions] = useState("");
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKey = useRef<string | null>(null);
  const trimmedCode = code.trim();
  const ready =
    trimmedCode.length >= 4 &&
    reason.trim().length >= 3 &&
    confirmation.trim() === trimmedCode;

  async function create() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    idempotencyKey.current ??= crypto.randomUUID();
    try {
      await apiWrite(
        "/api/v1/admin/promo/redeem-codes",
        "POST",
        {
          code: trimmedCode,
          reward: { dreamcoins: intFromText(dreamcoins, 0) },
          maxRedemptions: maxRedemptions.trim()
            ? intFromText(maxRedemptions, 1)
            : null,
          reason: reason.trim(),
          confirmation: confirmation.trim(),
        },
        { "idempotency-key": idempotencyKey.current },
      );
      setCode("");
      setDreamcoins("");
      setMaxRedemptions("");
      setReason("");
      setConfirmation("");
      idempotencyKey.current = null;
      onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <h2 className="text-sm font-semibold">Create redeem code</h2>
      <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
        Plaintext code is used only to derive its hash and is not returned by
        the authority.
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-6">
        <Input label="Code (≥4)" onChange={setCode} value={code} />
        <Input label="Dreamcoins" onChange={setDreamcoins} value={dreamcoins} />
        <Input
          label="Max uses (blank=∞)"
          onChange={setMaxRedemptions}
          value={maxRedemptions}
        />
        <Input label="Reason (≥3)" onChange={setReason} value={reason} />
        <Input
          label="Redeem code confirmation"
          onChange={setConfirmation}
          value={confirmation}
        />
        <button
          className="inline-flex min-h-11 items-center justify-center gap-2 bg-[var(--ad-ink)] px-3 text-sm font-semibold text-white disabled:opacity-50"
          disabled={!ready || busy}
          onClick={() => void create()}
          type="button"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          Create
        </button>
      </div>
      {error ? (
        <p className="mt-2 text-xs text-[var(--ad-red-text)]" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function codeRows(
  rows: Row[],
  canWrite: boolean,
  disable: (id: string) => void,
): DataTableRow[] {
  return rows.map((row, index) => {
    const id = text(row.id);
    const active = text(row.status) === "active";
    return {
      id: id || `code-${index}`,
      cells: [
        id,
        display(row.status),
        display(row.reward),
        display(row.maxRedemptions),
        display(row.redemptions),
        date(row.expiresAt),
        date(row.createdAt),
        canWrite && active ? (
          <button
            className="inline-flex min-h-9 items-center gap-1 rounded border px-2"
            onClick={() => disable(id)}
            type="button"
          >
            <Ban className="h-4 w-4" />
            Disable
          </button>
        ) : (
          "Read only"
        ),
      ],
    };
  });
}

function referralRows(rows: Row[]): DataTableRow[] {
  return rows.map((row, index) => ({
    id: text(row.id) || `referral-${index}`,
    cells: [
      display(row.id),
      display(row.inviterId),
      display(row.inviteeId),
      display(row.status),
      display(row.rewardStatus),
      date(row.createdAt),
    ],
  }));
}

function AuthoritySection({
  empty,
  loadingLabel,
  rows,
  state,
  title,
}: {
  empty: string;
  loadingLabel: string;
  rows: DataTableRow[];
  state: AuthorityState;
  title: "Redeem codes" | "Referrals";
}) {
  if (!state.rows && state.loading) {
    return (
      <div className="rounded-lg border p-4" role="status">
        <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
        {loadingLabel}
      </div>
    );
  }
  if (!state.rows) return null;
  if (!rows.length)
    return (
      <EmptyState
        hint="The complete server authority query returned no records."
        title={empty}
      />
    );
  return (
    <DataTable
      caption={title}
      headers={
        title === "Redeem codes"
          ? [
              "ID",
              "Status",
              "Reward",
              "Max uses",
              "Redemptions",
              "Expires",
              "Created",
              "Actions",
            ]
          : ["ID", "Inviter", "Invitee", "Status", "Reward status", "Created"]
      }
      rows={rows}
    />
  );
}

function AuthorityError({
  label,
  onRetry,
  state,
}: {
  label: string;
  onRetry: () => void;
  state: AuthorityState;
}) {
  if (!state.error) return null;
  return (
    <div
      className="rounded-md bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]"
      role="alert"
    >
      {label} authority refresh failed: {state.error}
      <button
        className="ml-3 min-h-8 rounded border border-current px-2"
        onClick={onRetry}
        type="button"
      >
        Retry {label}
      </button>
      {state.rows ? (
        <span className="ml-2">The last good snapshot remains visible.</span>
      ) : null}
    </div>
  );
}

function Freshness({ label, state }: { label: string; state: AuthorityState }) {
  const time = state.refreshedAt
    ? new Date(state.refreshedAt).toLocaleTimeString()
    : "unknown";
  if (state.loading && state.rows)
    return (
      <span>
        {label}: refreshing · showing snapshot from {time}
      </span>
    );
  if (state.error && state.rows)
    return (
      <span>
        {label}: stale · last good {time}
      </span>
    );
  if (state.error) return <span>{label}: unavailable</span>;
  if (state.rows)
    return (
      <span>
        {label}: current client snapshot · {time}
      </span>
    );
  return <span>{label}: refreshing · no snapshot yet</span>;
}

function Pager({
  label,
  loading,
  onClick,
  pageInfo,
}: {
  label: string;
  loading: boolean;
  onClick: () => void;
  pageInfo: PageInfo;
}) {
  if (!pageInfo.hasNextPage || !pageInfo.endCursor) return null;
  return (
    <button
      className="inline-flex min-h-11 items-center gap-2 rounded border px-4 text-sm font-semibold"
      disabled={loading}
      onClick={onClick}
      type="button"
    >
      <RefreshCcw className="h-4 w-4" />
      {label}
    </button>
  );
}

function Field({
  label,
  onChange,
  search = false,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  search?: boolean;
  value: string;
}) {
  return (
    <Input label={label} onChange={onChange} search={search} value={value} />
  );
}

function Input({
  label,
  onChange,
  search = false,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  search?: boolean;
  value: string;
}) {
  return (
    <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">
      {label}
      <input
        className="min-h-11 rounded-md border bg-[var(--ad-surface)] px-3 text-sm"
        onChange={(event) => onChange(event.target.value)}
        role={search ? "searchbox" : undefined}
        value={value}
      />
    </label>
  );
}

function Select({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: string[];
  value: string;
}) {
  return (
    <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">
      {label}
      <select
        className="min-h-11 rounded-md border bg-[var(--ad-surface)] px-3 text-sm"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {options.map((option) => (
          <option key={option || "all"} value={option}>
            {option || "All"}
          </option>
        ))}
      </select>
    </label>
  );
}

function currentQuery() {
  return typeof window === "undefined"
    ? defaultPromoQuery
    : promoQueryFromSearch(window.location.search);
}

function intFromText(value: string, fallback: number) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function display(value: unknown) {
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (value && typeof value === "object") return JSON.stringify(value);
  return "—";
}

function date(value: unknown) {
  const parsed = new Date(text(value));
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString();
}
