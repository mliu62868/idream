"use client";

import { AdminText, useAdminI18n } from "@/components/admin/i18n";
import { dreamcoins } from "@/features/billing/money";
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
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { PermissionNotice } from "@/components/admin/ui/PermissionNotice";
import { useFailureToast, useToast } from "@/components/admin/ui/Toast";
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
  cause: unknown;
  refreshedAt: string | null;
};

const emptyPageInfo: PageInfo = { endCursor: null, hasNextPage: false };
const emptyAuthority = (): AuthorityState => ({
  rows: null,
  pageInfo: emptyPageInfo,
  loading: true,
  error: null,
  cause: undefined,
  refreshedAt: null,
});

export function PromoWorkspace({ canWrite }: { canWrite: boolean }) {
  const { t, value: valueLabel } = useAdminI18n();
  const { toast } = useToast();
  const [query, setQuery] = useState<PromoQuery>(() => currentQuery());
  const [draft, setDraft] = useState<PromoQuery>(() => currentQuery());
  const [codes, setCodes] = useState<AuthorityState>(emptyAuthority);
  const [referrals, setReferrals] = useState<AuthorityState>(emptyAuthority);
  const [confirmation, setConfirmation] = useState<ConfirmSpec | null>(null);
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
        cause: undefined,
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
        cause,
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
      title: t("Disable redeem code {id}", { id }),
      destructive: { expectedName: id, inputLabel: "Confirmation" },
      // INTENT: 后台只有 disable，没有 re-enable —— 停掉的码只能再发一个新的。
      consequence: {
        effect: t("Every future redemption of this code fails. There is no re-enable command; a replacement has to be issued as a new code."),
        reversible: false,
      },
      reasonLabel: "Reason",
      submitLabel: "Disable",
      onSubmit: async (reason) => {
        await apiWrite(
          `/api/v2/admin/promo/redeem-codes/${id}/disable`,
          "POST",
          { reason, confirmation: id },
          { "idempotency-key": idempotencyKey },
        );
        toast({ tone: "success", title: t("Redeem code {id} disabled", { id }) });
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
        title={t("Promotions")}
      />
      <div
        className="flex flex-wrap justify-between gap-3 text-xs text-[var(--ad-text-muted)]"
        role="status"
      >
        <div className="flex flex-wrap gap-3">
          <Freshness label="Redeem codes" state={codes} />
          <Freshness label="Referrals" state={referrals} />
        </div>
        {!canWrite ? <PermissionNotice permission="growth.promo.write" /> : null}
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
          optionLabel={valueLabel}
          onChange={(codeStatus) =>
            setDraft((value) => ({ ...value, codeStatus }))
          }
          options={["", "active", "disabled", "expired"]}
          value={draft.codeStatus}
        />
        <Select
          label="Referral status"
          optionLabel={valueLabel}
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

            {t("Filter promotions")}
          </button>
          {filtered ? (
            <button
              aria-label={t("Clear promotion filters")}
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
      <AuthorityError
        onRetry={() => void loadScope(query, "codes")}
        state={codes}
      />
      <AuthoritySection
        empty={
          filtered
            ? "No redeem codes match these filters"
            : "No redeem codes exist yet"
        }
        loadingLabel="Loading redeem codes…"
        rows={codeRows(codes.rows ?? [], canWrite, confirmDisable, t, valueLabel)}
        state={codes}
        title={t("Redeem codes")}
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
        onRetry={() => void loadScope(query, "referrals")}
        state={referrals}
      />
      <AuthoritySection
        empty={
          filtered
            ? "No referrals match these filters"
            : "No referrals exist yet"
        }
        loadingLabel="Loading referrals…"
        rows={referralRows(referrals.rows ?? [], valueLabel)}
        state={referrals}
        title={t("Referrals")}
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
  const { t } = useAdminI18n();
  const { toast } = useToast();
  const failureToast = useFailureToast();
  const [code, setCode] = useState("");
  const [coins, setCoins] = useState("");
  const [maxRedemptions, setMaxRedemptions] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const idempotencyKey = useRef<string | null>(null);
  const trimmedCode = code.trim();
  const dreamcoinValue = strictIntegerFromText(coins, 1, 1_000_000);
  const maxRedemptionsValue = maxRedemptions.trim()
    ? strictIntegerFromText(maxRedemptions, 1, 1_000_000)
    : null;
  const expiryValue = isoFromLocalDateTime(expiresAt);
  const ready =
    trimmedCode.length >= 4 &&
    dreamcoinValue !== null &&
    (!maxRedemptions.trim() || maxRedemptionsValue !== null) &&
    (!expiresAt.trim() || expiryValue !== null) &&
    reason.trim().length >= 3 &&
    confirmation.trim() === trimmedCode;

  async function create() {
    if (!ready || busy) return;
    setBusy(true);
    idempotencyKey.current ??= crypto.randomUUID();
    try {
      await apiWrite(
        "/api/v2/admin/promo/redeem-codes",
        "POST",
        {
          code: trimmedCode,
          reward: { dreamcoins: dreamcoinValue },
          maxRedemptions: maxRedemptionsValue,
          ...(expiryValue ? { expiresAt: expiryValue } : {}),
          reason: reason.trim(),
          confirmation: confirmation.trim(),
        },
        { "idempotency-key": idempotencyKey.current },
      );
      setCode("");
      setCoins("");
      setMaxRedemptions("");
      setExpiresAt("");
      setReason("");
      setConfirmation("");
      idempotencyKey.current = null;
      toast({ tone: "success", title: t("Redeem code {code} created", { code: trimmedCode }) });
      onCreated();
    } catch (cause) {
      // INTENT: 失败时不清表单——码、面额、原因、确认串全留着，重试只差再点一次。
      failureToast(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <h2 className="text-sm font-semibold">{t("Create redeem code")}</h2>
      <p className="mt-1 text-xs text-[var(--ad-text-muted)]">

        {t("Plaintext code is used only to derive its hash and is not returned by the authority.")}
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-7">
        <Input label="Code (≥4)" onChange={setCode} value={code} />
        <Input label="Dreamcoins" onChange={setCoins} value={coins} />
        <Input
          label="Max uses (blank=∞)"
          onChange={setMaxRedemptions}
          value={maxRedemptions}
        />
        {/* INTENT: 契约一直收 expiresAt，表单却没这个格子——控制台发出去的每个码都是永久有效的，
            而表里还有一列 Expires 永远显示 —。没有期限的码就是一笔没有截止日的负债。 */}
        <Input
          label="Expires (blank=never)"
          onChange={setExpiresAt}
          type="datetime-local"
          value={expiresAt}
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

          {t("Create")}
        </button>
      </div>
      {coins.length > 0 && dreamcoinValue === null ? (
        <p className="mt-2 text-xs text-[var(--ad-red-text)]" role="alert">

          {t("Dreamcoins must be a whole number from 1 to 1,000,000.")}
        </p>
      ) : null}
      {maxRedemptions.length > 0 && maxRedemptionsValue === null ? (
        <p className="mt-2 text-xs text-[var(--ad-red-text)]" role="alert">

          {t("Max uses must be a whole number from 1 to 1,000,000.")}
        </p>
      ) : null}
      {expiresAt.length > 0 && expiryValue === null ? (
        <p className="mt-2 text-xs text-[var(--ad-red-text)]" role="alert">

          {t("Expiry must be a valid date and time.")}
        </p>
      ) : null}
      {dreamcoinValue !== null ? (
        <CodeLiability
          dreamcoinValue={dreamcoinValue}
          expiryValue={expiryValue}
          maxRedemptionsValue={maxRedemptionsValue}
        />
      ) : null}
    </section>
  );
}

/**
 * SPEC: 建码之前，把这个码最多能发出去多少梦币摆出来。
 *
 * INTENT: 面额和次数是两个独立的小格子，乘出来才是真正的敞口。运营填 500 × 2000 的时候
 * 心里想的是「500 的码」，实际是一百万梦币。次数留空更危险——那是一笔没有上限的负债，
 * 而表单把它写成一个轻描淡写的 `blank=∞`。
 * INVARIANT: 只做乘法，不换算成法币——梦币和法币之间的汇率不在这个契约里，估一个就是编。
 */
function CodeLiability({
  dreamcoinValue,
  expiryValue,
  maxRedemptionsValue,
}: {
  dreamcoinValue: number;
  expiryValue: string | null;
  maxRedemptionsValue: number | null;
}) {
  const { t } = useAdminI18n();
  const unbounded = maxRedemptionsValue === null;
  return (
    <p
      className={`mt-3 rounded-md px-3 py-2 text-xs ${
        unbounded
          ? "bg-[var(--ad-yellow-bg)] text-[var(--ad-yellow-text)]"
          : "bg-black/[0.04] text-[var(--ad-text-muted)]"
      }`}
      role="status"
    >
      {unbounded
        ? t("Every redemption grants {each} Dreamcoins and nothing caps how many times. The total this code can pay out is unbounded.", {
            each: dreamcoins(dreamcoinValue),
          })
        : t("At most {total} Dreamcoins in total: {each} each, up to {uses} redemptions.", {
            each: dreamcoins(dreamcoinValue),
            total: dreamcoins(dreamcoinValue * maxRedemptionsValue),
            uses: dreamcoins(maxRedemptionsValue),
          })}
      {" "}
      {/* INVARIANT: 期限和次数是两件独立的事。上面那句不许替这句下结论——
          设了期限却没设次数的码，说「没有有效期」就是假话。 */}
      {expiryValue
        ? t("It stops working at {when}.", { when: new Date(expiryValue).toLocaleString() })
        : t("It never expires.")}
    </p>
  );
}

/**
 * INTENT: `datetime-local` 给的是不带时区的本地时间串，契约要 ISO。用 Date 解一遍，
 * 解不出来就返回 null 让表单自己报错——不要把 `Invalid Date` 送到后端。
 */
export function isoFromLocalDateTime(value: string) {
  const normalized = value.trim();
  if (!normalized) return null;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function codeRows(
  rows: Row[],
  canWrite: boolean,
  disable: (id: string) => void,
  t: (key: string, values?: Record<string, string | number>) => string,
  valueLabel: (key: string) => string,
): DataTableRow[] {
  return rows.map((row, index) => {
    const id = text(row.id);
    const active = text(row.status) === "active";
    return {
      id: id || `code-${index}`,
      cells: [
        id,
        text(row.status) ? valueLabel(text(row.status)) : "—",
        <RewardCell key="reward" reward={row.reward} t={t} />,
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

            <AdminText text="Disable" />
          </button>
        ) : (
          "Read only"
        ),
      ],
    };
  });
}

function referralRows(rows: Row[], valueLabel: (key: string) => string): DataTableRow[] {
  return rows.map((row, index) => ({
    id: text(row.id) || `referral-${index}`,
    cells: [
      display(row.id),
      display(row.inviterId),
      display(row.inviteeId),
      text(row.status) ? valueLabel(text(row.status)) : "—",
      text(row.rewardStatus) ? valueLabel(text(row.rewardStatus)) : "—",
      date(row.createdAt),
    ],
  }));
}

/**
 * SPEC: 兑换码的面额是钱，按梦币排版；认不出来的奖励形状才退回原始 JSON。
 *
 * INTENT: 这一格原来直接 `JSON.stringify(row.reward)`，运营在表里读到的是
 * `{"dreamcoins":500}`。契约里 reward 是自由 JSON（历史遗留），但控制台建出来的码
 * 只有 `{dreamcoins, note?}` 一种形状——认得出就好好印，认不出也不能假装认得。
 */
function RewardCell({
  reward,
  t,
}: {
  reward: unknown;
  t: (key: string, values?: Record<string, string | number>) => string;
}) {
  if (!isRecord(reward) || typeof reward.dreamcoins !== "number") {
    return <span className="font-mono text-xs">{display(reward)}</span>;
  }
  const note = typeof reward.note === "string" ? reward.note.trim() : "";
  return (
    <span>
      <span className="font-semibold tabular-nums">
        {t("{count} Dreamcoins", { count: dreamcoins(reward.dreamcoins) })}
      </span>
      {note ? <span className="block text-xs text-[var(--ad-text-muted)]">{note}</span> : null}
    </span>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  title: string;
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
  onRetry,
  state,
}: {
  onRetry: () => void;
  state: AuthorityState;
}) {
  if (!state.error) return null;
  return (
    <AuthorityRequestError
      cause={state.cause}
      message={state.error}
      onRetry={onRetry}
      snapshotAt={state.rows ? state.refreshedAt : null}
    />
  );
}
function Freshness({ label, state }: { label: string; state: AuthorityState }) {
  const { t } = useAdminI18n();
  const time = state.refreshedAt
    ? new Date(state.refreshedAt).toLocaleTimeString()
    : "unknown";
  if (state.loading && state.rows)
    return (
      <span>
        {label}{t(": refreshing · as of")} {time}
      </span>
    );
  if (state.error && state.rows)
    return (
      <span>
        {label}{t(": stale · last good")} {time}
      </span>
    );
  if (state.error) return <span>{label}{t(": unavailable")}</span>;
  if (state.rows)
    return (
      <span>
        {label}{t(": as of")} {time}
      </span>
    );
  return <span>{label}{t(": loading…")}</span>;
}

// MIGRATION: 只有「下一页」。ui/Pagination.tsx 已建（含上一页），合并后切过去。
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
  type,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  search?: boolean;
  type?: string;
  value: string;
}) {
  return (
    <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">
      {label}
      <input
        className="min-h-11 rounded-md border bg-[var(--ad-surface)] px-3 text-sm"
        onChange={(event) => onChange(event.target.value)}
        role={search ? "searchbox" : undefined}
        type={type}
        value={value}
      />
    </label>
  );
}

function Select({
  label,
  onChange,
  optionLabel,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  optionLabel?: (option: string) => string;
  options: string[];
  value: string;
}) {
  const { t } = useAdminI18n();
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
            {option ? (optionLabel?.(option) ?? option) : t("All")}
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

export function strictIntegerFromText(
  value: string,
  min: number,
  max: number,
) {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < min ||
    parsed > max
  ) {
    return null;
  }
  return parsed;
}

// MIGRATION: 与 billing/access/pricing 的同名三件套重复，等 ui/format.ts 统一后一起切。
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
