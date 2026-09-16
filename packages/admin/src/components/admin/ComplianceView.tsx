"use client";

// SPEC: 合规运营面板（ADMIN_CONSOLE_PLAN §4）。DSAR 数据导出/账号擦除 + 年龄验证人工复核。
// INTENT: 自取数、无 props；样式对齐 TagsView。导出展示脱敏 JSON；擦除/override 需 reason+typed。
// INVARIANTS: erase confirmation=userId、override confirmation=verificationId，均 reason≥3。
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Download, FileDown, Loader2, RefreshCcw, ShieldAlert, Trash2 } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { DataTable, type DataTableRow } from "@/components/admin/ui/DataTable";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { formatDateTime } from "@/components/admin/ui/format";
import { StatusPill } from "@/components/admin/ui/StatusPill";
import { WriteFeedbackBanner, requestErrorMessage, useWriteFeedback } from "@/components/admin/section-kit";
import {
  authorityRequestFailed,
  authorityRequestStarted,
  authorityRequestSucceeded,
  createAuthorityState,
} from "@/lib/authority-state";
import { createLatestRequestGate } from "@/lib/latest-request";

// INVARIANT: outline-none 必须配一个 focus-visible 补偿，否则键盘用户不知道焦点在哪；
// 只换边框颜色在高对比度模式下会被系统主题覆盖掉。
const inputClass =
  "rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)]";

type AgeRow = {
  id: string;
  userId: string;
  provider: string;
  status: string;
  jurisdiction: string | null;
  verifiedAt: string | null;
  createdAt: string;
};

type DeletionRow = {
  id: string;
  userId: string | null;
  waitingOn: string;
  pastDue: boolean;
  graceEndsAt: string;
  blobExpectedCount: number;
  blobDeletedCount: number;
  blockedReason: string | null;
  chatRequestDelivery: { status: string; attempts: number } | null;
};

type DeletionPayload = { items: DeletionRow[]; pastDueCount: number };

type ConfirmDraft = {
  reason: string;
  confirmation: string;
};

type AgeOverrideDraft = ConfirmDraft & {
  id: string;
  next: "verified" | "failed";
};

export function ComplianceView() {
  return (
    <div className="space-y-6">
      <DsarSection />
      <ErasureQueueSection />
      <AgeVerificationSection />
    </div>
  );
}

// SPEC: 「在等谁」的四个取值各自对应一句运营能据以行动的话。
// INTENT: status 列分不开「宽限期内的正常等待」和「宽限期已过还没擦」——它俩都是
//         `awaiting_chat`。派生值分开之后，这张表才回答得了唯一重要的那个问题：
//         这条要不要现在管。
export const WAITING_ON_COPY: Record<string, string> = {
  grace_period: "Inside the grace period — erasure starts on its own when it ends",
  chat_erasure: "Grace period is over; waiting for Chat to confirm its erasure",
  blob_deletion: "Deleting the stored objects this account owned",
  main_purge: "Waiting for the final purge of the Main database",
  nothing: "Erased — nothing is owed",
};

export const BLOCKER_COPY: Record<string, string> = {
  account_deletion_active_legal_hold:
    "Paused by an active legal hold — release the hold to let the purge continue",
  account_deletion_generation_authority_pending:
    "A generation request of this account has not reached a terminal state — settle it in Jobs",
};

function DsarSection() {
  const { t, locale } = useAdminI18n();
  const [userId, setUserId] = useState("");
  const [exported, setExported] = useState<unknown>(null);
  const [busy, setBusy] = useState<"export" | "erase" | null>(null);
  // INVARIANT: 存异常对象而不只是它的 message —— AuthorityRequestError 要靠 cause 才能按错误码
  // 出人话（只有 message 时它退回「读不到最新数据」的通用兜底，运营读到的仍是 authority 英文原文）。
  const [err, setErr] = useState<{ message: string; cause: unknown; retry: () => void } | null>(null);
  const [eraseDraft, setEraseDraft] = useState<ConfirmDraft | null>(null);
  const { feedback, reportSuccess, clearFeedback } = useWriteFeedback();

  async function exportData() {
    setBusy("export");
    setErr(null);
    clearFeedback();
    try {
      const data = await apiGet<{ export: unknown }>(
        `/api/v2/admin/compliance/users/${encodeURIComponent(userId.trim())}/export`,
      );
      setExported(data.export);
    } catch (error) {
      setErr({ message: requestErrorMessage(error, t), cause: error, retry: () => void exportData() });
    } finally {
      setBusy(null);
    }
  }

  // SPEC: DSAR 的交付物是一个可以发给用户/监管的文件，不是一段屏幕上的 JSON。
  // INTENT: 不引下载库——Blob + objectURL 是原生的；用完立刻 revoke，不留悬挂引用。
  function downloadExport() {
    if (exported === null) return;
    const blob = new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `dsar-export-${userId.trim() || "user"}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function erase() {
    if (!eraseDraft || !canConfirm(eraseDraft, userId.trim())) return;
    setBusy("erase");
    setErr(null);
    clearFeedback();
    try {
      const data = await apiWrite<{
        erased: boolean;
        idempotent?: boolean;
        deletion: { graceEndsAt: string };
      }>(
        `/api/v2/admin/compliance/users/${encodeURIComponent(userId.trim())}/erase`,
        "POST",
        {
          reason: eraseDraft.reason.trim(),
          confirmation: eraseDraft.confirmation.trim(),
        },
      );
      setEraseDraft(null);
      // SPEC: 成功文案必须说出「什么时候真的会被删」。
      // INTENT: 旧文案说完成会出现在审计日志里——那是假的：完成路径一行审计都不写，
      //         而请求那行审计的 targetId 在完成时会被改写成不可逆的 subject ref，
      //         按用户 ID 也再查不到。权威在响应里给了准确的到期时间，照它说。
      reportSuccess(
        data.idempotent
          ? t("{id} already has an erasure request — nothing changed.", { id: userId.trim() })
          : t("Access for {id} is revoked now. Erasure itself starts after {due}; track it in the queue below.", {
            id: userId.trim(),
            due: formatDateTime(data.deletion.graceEndsAt, locale),
          }),
      );
    } catch (error) {
      setErr({ message: requestErrorMessage(error, t), cause: error, retry: () => void erase() });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <h2 className="text-sm font-semibold">{t("DSAR — export / erase")}</h2>
      <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
        {t("The export is redacted structured data with no raw prompt or chat text. Erasure revokes access immediately, then runs across Chat and storage after a grace period — the queue below is where it can be followed.")}
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-[1fr_auto_auto]">
        <input
          aria-label={t("User ID")}
          className={inputClass}
          onChange={(e) => setUserId(e.target.value)}
          placeholder={t("User ID")}
          value={userId}
        />
        <button
          className="rounded-md inline-flex h-10 items-center gap-2 border border-[var(--ad-border)] px-3 text-sm disabled:opacity-50"
          disabled={busy !== null || !userId.trim()}
          onClick={() => void exportData()}
          type="button"
        >
          {busy === "export" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          {t("Export")}
        </button>
        <button
          className="rounded-md inline-flex h-10 items-center gap-2 border border-[var(--ad-red-text)]/20 px-3 text-sm text-[var(--ad-red-text)] disabled:opacity-50"
          disabled={busy !== null || !userId.trim()}
          onClick={() => {
            setErr(null);
            clearFeedback();
            setEraseDraft({ reason: "", confirmation: "" });
          }}
          type="button"
        >
          {busy === "erase" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          {t("Erase")}
        </button>
      </div>
      {eraseDraft ? (
        <section className="rounded-lg mt-3 border border-[var(--ad-red-text)]/20 bg-[var(--ad-red-bg)] p-3">
          <p className="text-xs font-semibold text-[var(--ad-red-text)]">
            {t("Confirm erasure for")} <span className="font-mono">{userId.trim()}</span>
          </p>
          <div className="mt-3 grid gap-3 md:grid-cols-[1fr_220px_auto_auto]">
            <input
              aria-label={t("Erase reason")}
              className={inputClass}
              onChange={(e) => setEraseDraft({ ...eraseDraft, reason: e.target.value })}
              placeholder={t("Reason (≥3 chars)")}
              value={eraseDraft.reason}
            />
            <input
              aria-label={t("Erase confirmation")}
              className={inputClass}
              onChange={(e) => setEraseDraft({ ...eraseDraft, confirmation: e.target.value })}
              placeholder={t("Type user ID")}
              value={eraseDraft.confirmation}
            />
            <button
              className="rounded-md inline-flex h-10 items-center justify-center border border-[var(--ad-border)] px-3 text-sm"
              onClick={() => setEraseDraft(null)}
              type="button"
            >
              {t("Cancel")}
            </button>
            <button
              className="inline-flex h-10 items-center justify-center bg-[var(--ad-red-bg)] px-3 text-sm font-semibold text-[var(--ad-red-text)] disabled:opacity-50"
              disabled={busy !== null || !canConfirm(eraseDraft, userId.trim())}
              onClick={() => void erase()}
              type="button"
            >
              {t("Confirm erase")}
            </button>
          </div>
        </section>
      ) : null}
      {err ? (
        <div className="mt-2">
          <AuthorityRequestError cause={err.cause} message={err.message} onRetry={err.retry} />
        </div>
      ) : null}
      <div className="mt-2">
        <WriteFeedbackBanner feedback={feedback} onDismiss={clearFeedback} />
      </div>
      {exported ? (
        <div className="mt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-semibold">{t("Export preview")}</h3>
            <button
              className="rounded-md inline-flex h-9 items-center gap-2 border border-[var(--ad-border)] px-3 text-sm"
              onClick={downloadExport}
              type="button"
            >
              <FileDown className="h-4 w-4" />
              {t("Download JSON")}
            </button>
          </div>
          <pre className="rounded-lg mt-2 max-h-80 overflow-auto border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3 text-xs">
            {JSON.stringify(exported, null, 2)}
          </pre>
        </div>
      ) : null}
    </section>
  );
}

function ErasureQueueSection() {
  const { t, locale } = useAdminI18n();
  const [scope, setScope] = useState<"open" | "all">("open");
  const [authority, setAuthority] = useState(() => createAuthorityState<DeletionPayload>());
  const requestGate = useRef(createLatestRequestGate());
  const initialScope = useRef(scope);
  const scopeFilterId = useId();

  const load = useCallback(async (nextScope: string) => {
    const queryKey = `scope=${encodeURIComponent(nextScope)}`;
    const request = requestGate.current.begin();
    setAuthority((current) => authorityRequestStarted(current, queryKey));
    try {
      const data = await apiGet<DeletionPayload>(
        `/api/v2/admin/compliance/account-deletions?${queryKey}`,
      );
      if (!request.isCurrent()) return;
      setAuthority(authorityRequestSucceeded(queryKey, data));
    } catch (err) {
      if (!request.isCurrent()) return;
      setAuthority((current) => authorityRequestFailed(current, queryKey, requestErrorMessage(err, t), err));
    }
  }, [t]);

  useEffect(() => {
    const gate = requestGate.current;
    const timer = window.setTimeout(() => void load(initialScope.current), 0);
    return () => {
      gate.invalidate();
      window.clearTimeout(timer);
    };
  }, [load]);

  const payload = authority.data;
  const rows: DataTableRow[] = (payload?.items ?? []).map((row) => ({
    id: row.id,
    cells: [
      <span className="font-mono text-xs" key="user">{row.userId ?? t("Purged")}</span>,
      <span key="stage" title={t(WAITING_ON_COPY[row.waitingOn] ?? row.waitingOn)}>
        <StatusPill status={row.waitingOn} />
      </span>,
      <span className={row.pastDue ? "text-[var(--ad-red-text)]" : undefined} key="due">
        {formatDateTime(row.graceEndsAt, locale)}
      </span>,
      row.blobExpectedCount > 0 ? `${row.blobDeletedCount}/${row.blobExpectedCount}` : "—",
      <span className="text-xs" key="blocked">{deletionRowNote(row, t)}</span>,
    ],
  }));

  return (
    <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--ad-border)] p-3">
        <div>
          <h2 className="text-sm font-semibold">{t("Erasure queue")}</h2>
          {/* INVARIANT: 没读到数之前不许说「没有超期的」——那是断言，不是占位。 */}
          {payload ? (
            <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
              {payload.pastDueCount > 0
                ? t("{count} past their grace period and not erased yet.", { count: String(payload.pastDueCount) })
                : t("Nothing is past its grace period.")}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-[var(--ad-text-muted)]" htmlFor={scopeFilterId}>
            {t("Show")}
          </label>
          <select
            className="rounded-md h-9 border border-[var(--ad-border)] bg-[var(--ad-surface)] px-2 text-sm outline-none focus:border-[var(--ad-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)]"
            id={scopeFilterId}
            onChange={(e) => {
              const next = e.target.value === "all" ? "all" : "open";
              setScope(next);
              void load(next);
            }}
            value={scope}
          >
            <option value="open">{t("In flight")}</option>
            <option value="all">{t("Including erased")}</option>
          </select>
          <button
            className="rounded-md inline-flex h-9 items-center gap-2 border border-[var(--ad-border)] px-3 text-sm disabled:opacity-50"
            disabled={authority.loading}
            onClick={() => void load(scope)}
            type="button"
          >
            {authority.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
            {t("Refresh")}
          </button>
        </div>
      </div>
      {authority.error ? (
        <div className="p-3">
          <AuthorityRequestError
            cause={authority.cause}
            message={authority.error}
            onRetry={() => void load(scope)}
            snapshotAt={authority.data ? authority.refreshedAt : null}
          />
        </div>
      ) : null}
      {authority.error && authority.data === null ? null : (
        <div className="p-3">
          <DataTable
            caption="Account erasure requests"
            empty={<EmptyState title={t("No erasure requests in flight.")} />}
            headers={[
              { label: t("User"), width: "20rem", truncate: true },
              t("Waiting on"),
              t("Grace ends"),
              t("Objects deleted"),
              t("Note"),
            ]}
            loading={authority.loading}
            minimumWidthClassName="min-w-[860px]"
            rows={rows}
          />
        </div>
      )}
    </section>
  );
}

// SPEC: 每行右侧只说一句「现在该知道什么」。
// INTENT: 优先级是 blocker > 到期未投递 > 阶段解释。第二条单独存在，是因为投递器按
//         eventType allowlist 取件：一条到期却 attempts 仍为 0 的行，意味着根本没人取过它
//         —— 这跟「取过但失败」是两种完全不同的故障，混成一句话运营就分不出来了。
function deletionRowNote(row: DeletionRow, t: (key: string, values?: Record<string, string>) => string) {
  if (row.blockedReason) return t(BLOCKER_COPY[row.blockedReason] ?? row.blockedReason);
  const delivery = row.chatRequestDelivery;
  if (row.waitingOn === "chat_erasure" && delivery && delivery.status === "pending" && delivery.attempts === 0) {
    return t("Due, but the Chat erasure request has never been picked up — check the event consumer");
  }
  return t(WAITING_ON_COPY[row.waitingOn] ?? row.waitingOn);
}

function AgeVerificationSection() {
  const { t, value: valueLabel } = useAdminI18n();
  const [authority, setAuthority] = useState(() => createAuthorityState<AgeRow[]>());
  const [status, setStatus] = useState("pending");
  const [overrideDraft, setOverrideDraft] = useState<AgeOverrideDraft | null>(null);
  const [overrideBusy, setOverrideBusy] = useState(false);
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const { feedback, reportSuccess, clearFeedback } = useWriteFeedback();
  const requestGate = useRef(createLatestRequestGate());
  const initialStatus = useRef(status);
  const statusFilterId = useId();

  const load = useCallback(async (nextStatus: string) => {
    const queryKey = `status=${encodeURIComponent(nextStatus)}`;
    const request = requestGate.current.begin();
    setAuthority((current) => authorityRequestStarted(current, queryKey));
    try {
      const data = await apiGet<{ items: AgeRow[] }>(
        `/api/v2/admin/compliance/age-verifications?${queryKey}`,
      );
      if (!request.isCurrent()) return;
      setAuthority(authorityRequestSucceeded(queryKey, data.items));
    } catch (err) {
      if (!request.isCurrent()) return;
      setAuthority((current) => authorityRequestFailed(
        current,
        queryKey,
        requestErrorMessage(err, t),
        err,
      ));
    }
  }, [t]);

  useEffect(() => {
    const gate = requestGate.current;
    const timer = window.setTimeout(() => void load(initialStatus.current), 0);
    return () => {
      gate.invalidate();
      window.clearTimeout(timer);
    };
  }, [load]);

  async function override() {
    if (!overrideDraft || !canConfirm(overrideDraft, overrideDraft.id)) return;
    const draft = overrideDraft;
    setOverrideBusy(true);
    setOverrideError(null);
    try {
      await apiWrite(`/api/v2/admin/compliance/age-verifications/${draft.id}/override`, "POST", {
        status: draft.next,
        reason: draft.reason.trim(),
        confirmation: draft.confirmation.trim(),
      });
      setOverrideDraft(null);
      setOverrideError(null);
      reportSuccess(t("{id} is now {status}. The queue below reflects the new state.", {
        id: draft.id,
        status: valueLabel(draft.next),
      }));
      setAuthority((current) => current.data ? {
        ...current,
        data: current.data.flatMap((row) =>
          row.id !== draft.id ? [row] : status === draft.next ? [{ ...row, status: draft.next }] : [],
        ),
        error: null,
      } : current);
      void load(status);
    } catch (err) {
      setOverrideError(requestErrorMessage(err, t));
    } finally {
      setOverrideBusy(false);
    }
  }

  const rows = authority.data ?? [];
  const tableRows: DataTableRow[] = rows.map((row) => ({
    id: row.id,
    cells: [
      <span className="font-mono text-xs" key="user">{row.userId}</span>,
      row.provider,
      <StatusPill key="status" status={row.status} />,
      row.jurisdiction ?? "—",
      <div className="flex justify-end gap-2" key="actions">
        <button
          className="inline-flex h-8 items-center gap-1 bg-[var(--ad-ink)] px-2 text-xs font-semibold text-white"
          disabled={overrideBusy}
          onClick={() => startOverride(row.id, "verified")}
          type="button"
        >
          <ShieldAlert className="h-3.5 w-3.5" />
          {t("Verify")}
        </button>
        <button
          className="rounded-md inline-flex h-8 items-center gap-1 border border-[var(--ad-border)] px-2 text-xs"
          disabled={overrideBusy}
          onClick={() => startOverride(row.id, "failed")}
          type="button"
        >
          {t("Fail")}
        </button>
      </div>,
    ],
  }));

  function startOverride(id: string, next: AgeOverrideDraft["next"]) {
    setAuthority((current) => ({ ...current, error: null }));
    clearFeedback();
    setOverrideError(null);
    setOverrideDraft({ id, next, reason: "", confirmation: "" });
  }

  return (
    <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
      <div className="flex items-center justify-between border-b border-[var(--ad-border)] p-3">
        <h2 className="text-sm font-semibold">{t("Age verification queue")}</h2>
        <div className="flex items-center gap-2">
          <label className="text-xs text-[var(--ad-text-muted)]" htmlFor={statusFilterId}>
            {t("Status")}
          </label>
          <select
            className="rounded-md h-9 border border-[var(--ad-border)] bg-[var(--ad-surface)] px-2 text-sm outline-none focus:border-[var(--ad-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)]"
            id={statusFilterId}
            onChange={(e) => {
              const nextStatus = e.target.value;
              setStatus(nextStatus);
              clearFeedback();
              setOverrideDraft(null);
              setOverrideError(null);
              void load(nextStatus);
            }}
            value={status}
          >
            {["pending", "required", "failed", "verified", "expired"].map((s) => (
              <option key={s} value={s}>
                {valueLabel(s)}
              </option>
            ))}
          </select>
          <button
            className="rounded-md inline-flex h-9 items-center gap-2 border border-[var(--ad-border)] px-3 text-sm disabled:opacity-50"
            disabled={authority.loading}
            onClick={() => void load(status)}
            type="button"
          >
            {authority.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
            {t("Refresh")}
          </button>
        </div>
      </div>
      {authority.error ? (
        <div className="p-3">
          <AuthorityRequestError
            cause={authority.cause}
            message={authority.error}
            onRetry={() => void load(status)}
            snapshotAt={authority.data ? authority.refreshedAt : null}
          />
        </div>
      ) : null}
      <div className="px-3 pt-2"><WriteFeedbackBanner feedback={feedback} onDismiss={clearFeedback} /></div>
      {overrideDraft ? (
        <section className="rounded-lg m-3 border border-[var(--ad-yellow-text)]/20 bg-[var(--ad-yellow-bg)] p-3">
          <p className="text-xs font-semibold text-[var(--ad-yellow-text)]">
            {t("Confirm age verification override")}{" "}
            <span className="font-mono">{overrideDraft.id}</span> → {valueLabel(overrideDraft.next)}
          </p>
          <div className="mt-3 grid gap-3 md:grid-cols-[1fr_260px_auto_auto]">
            <input
              aria-label={t("Override reason")}
              className={inputClass}
              onChange={(e) => setOverrideDraft({ ...overrideDraft, reason: e.target.value })}
              placeholder={t("Reason (≥3 chars)")}
              value={overrideDraft.reason}
            />
            <input
              aria-label={t("Override confirmation")}
              className={inputClass}
              onChange={(e) => setOverrideDraft({ ...overrideDraft, confirmation: e.target.value })}
              placeholder={t("Type verification ID")}
              value={overrideDraft.confirmation}
            />
            <button
              className="rounded-md inline-flex h-10 items-center justify-center border border-[var(--ad-border)] px-3 text-sm"
              onClick={() => {
                setOverrideDraft(null);
                setOverrideError(null);
              }}
              type="button"
            >
              {t("Cancel")}
            </button>
            <button
              className="inline-flex h-10 items-center justify-center bg-[var(--ad-yellow-bg)] px-3 text-sm font-semibold text-[var(--ad-yellow-text)] disabled:opacity-50"
              disabled={overrideBusy || !canConfirm(overrideDraft, overrideDraft.id)}
              onClick={() => void override()}
              type="button"
            >
              {t("Confirm override")}
            </button>
          </div>
          {overrideError ? (
            <div className="mt-3">
              <AuthorityRequestError message={overrideError} onRetry={() => void override()} />
            </div>
          ) : null}
        </section>
      ) : null}
      {/* INVARIANT: userId 是 UUID，窄屏必须在表内横滚——DataTable 的 minimumWidthClassName
          管这件事，否则整页被撑出横向滚动条。 */}
      {authority.error && authority.data === null ? null : (
        <div className="p-3">
          <DataTable
            caption="Compliance records"
            empty={
              <EmptyState title={t("No records.")} />
            }
            headers={[
              { label: t("User"), width: "20rem", truncate: true },
              t("Provider"),
              t("Status"),
              t("jurisdiction"),
              { label: t("Actions"), align: "right" },
            ]}
            loading={authority.loading}
            minimumWidthClassName="min-w-[720px]"
            rows={tableRows}
            stickyLastColumn
          />
        </div>
      )}
    </section>
  );
}

function canConfirm(draft: ConfirmDraft, targetId: string) {
  const confirmation = draft.confirmation.trim();
  return draft.reason.trim().length >= 3 && Boolean(targetId) && confirmation === targetId;
}
