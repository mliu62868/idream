"use client";

// SPEC: 合规运营面板（ADMIN_PHASE3_DESIGN §4）。DSAR 数据导出/账号擦除 + 年龄验证人工复核。
// INTENT: 自取数、无 props；样式对齐 TagsView。导出展示脱敏 JSON；擦除/override 需 reason+typed。
// INVARIANTS: erase confirmation=userId、override confirmation=verificationId，均 reason≥3。
import { useEffect, useState } from "react";
import { Download, Loader2, RefreshCcw, ShieldAlert, Trash2 } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";

const inputClass =
  "rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]";

type AgeRow = {
  id: string;
  userId: string;
  provider: string;
  status: string;
  jurisdiction: string | null;
  verifiedAt: string | null;
  createdAt: string;
};

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
      <AgeVerificationSection />
    </div>
  );
}

function DsarSection() {
  const { t } = useAdminI18n();
  const [userId, setUserId] = useState("");
  const [exported, setExported] = useState<unknown>(null);
  const [busy, setBusy] = useState<"export" | "erase" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [eraseDraft, setEraseDraft] = useState<ConfirmDraft | null>(null);

  async function exportData() {
    setBusy("export");
    setErr(null);
    setNote(null);
    try {
      const data = await apiGet<{ export: unknown }>(
        `/api/v1/admin/compliance/users/${encodeURIComponent(userId.trim())}/export`,
      );
      setExported(data.export);
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Export failed");
    } finally {
      setBusy(null);
    }
  }

  async function erase() {
    if (!eraseDraft || !canConfirm(eraseDraft, userId.trim())) return;
    setBusy("erase");
    setErr(null);
    setNote(null);
    try {
      const data = await apiWrite<{ erased: boolean; idempotent?: boolean }>(
        `/api/v1/admin/compliance/users/${encodeURIComponent(userId.trim())}/erase`,
        "POST",
        {
          reason: eraseDraft.reason.trim(),
          confirmation: eraseDraft.confirmation.trim(),
        },
      );
      setEraseDraft(null);
      setNote(data.idempotent ? t("Already erased (idempotent).") : t("Erasure requested."));
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Erase failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <h2 className="text-sm font-semibold">{t("DSAR — export / erase")}</h2>
      <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
        导出为脱敏结构化数据（不含明文 prompt/chat）。擦除走 P0-F 跨服务流，需确认。
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
            setNote(null);
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
      {err ? <p role="alert" className="mt-2 text-xs text-[var(--ad-red-text)]">{err}</p> : null}
      {note ? <p className="mt-2 text-xs text-[var(--ad-green-text)]">{note}</p> : null}
      {exported ? (
        <pre className="rounded-lg mt-3 max-h-80 overflow-auto border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3 text-xs">
          {JSON.stringify(exported, null, 2)}
        </pre>
      ) : null}
    </section>
  );
}

function AgeVerificationSection() {
  const { t, value: valueLabel } = useAdminI18n();
  const [rows, setRows] = useState<AgeRow[]>([]);
  const [status, setStatus] = useState("pending");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [overrideDraft, setOverrideDraft] = useState<AgeOverrideDraft | null>(null);
  const [overrideBusy, setOverrideBusy] = useState(false);

  async function load(options?: { silent?: boolean }) {
    setLoading(true);
    if (!options?.silent) setError(null);
    try {
      const data = await apiGet<{ items: AgeRow[] }>(
        `/api/v1/admin/compliance/age-verifications?status=${encodeURIComponent(status)}`,
      );
      setRows(data.items);
    } catch (err) {
      if (!options?.silent) setError(err instanceof Error ? err.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  async function override() {
    if (!overrideDraft || !canConfirm(overrideDraft, overrideDraft.id)) return;
    const draft = overrideDraft;
    setOverrideBusy(true);
    try {
      await apiWrite(`/api/v1/admin/compliance/age-verifications/${draft.id}/override`, "POST", {
        status: draft.next,
        reason: draft.reason.trim(),
        confirmation: draft.confirmation.trim(),
      });
      setOverrideDraft(null);
      setError(null);
      setNotice(t("Age verification updated."));
      setRows((current) =>
        current.flatMap((row) =>
          row.id !== draft.id ? [row] : status === draft.next ? [{ ...row, status: draft.next }] : [],
        ),
      );
      void load({ silent: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Override failed");
    } finally {
      setOverrideBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
      <div className="flex items-center justify-between border-b border-[var(--ad-border)] p-3">
        <h2 className="text-sm font-semibold">{t("Age verification queue")}</h2>
        <div className="flex items-center gap-2">
          <select
            className="rounded-md h-9 border border-[var(--ad-border)] bg-[var(--ad-surface)] px-2 text-sm outline-none"
            onChange={(e) => setStatus(e.target.value)}
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
            disabled={loading}
            onClick={() => void load()}
            type="button"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
            {t("Refresh")}
          </button>
        </div>
      </div>
      {error ? <p role="alert" className="px-3 py-2 text-xs text-[var(--ad-red-text)]">{error}</p> : null}
      {notice ? <p className="px-3 py-2 text-xs text-[var(--ad-green-text)]">{notice}</p> : null}
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
              onClick={() => setOverrideDraft(null)}
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
        </section>
      ) : null}
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Compliance records</caption>
        <thead className="border-b border-[var(--ad-border)] text-xs text-[var(--ad-text-muted)]">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">{t("user")}</th>
            <th scope="col" className="px-3 py-2 font-medium">{t("provider")}</th>
            <th scope="col" className="px-3 py-2 font-medium">{t("status")}</th>
            <th scope="col" className="px-3 py-2 font-medium">{t("jurisdiction")}</th>
            <th scope="col" className="px-3 py-2 font-medium"><span className="sr-only">{t("Actions")}</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-[var(--ad-border)]">
              <td className="px-3 py-2 font-mono text-xs">{row.userId}</td>
              <td className="px-3 py-2">{row.provider}</td>
              <td className="px-3 py-2 text-[var(--ad-text-muted)]">{valueLabel(row.status)}</td>
              <td className="px-3 py-2">{row.jurisdiction ?? "—"}</td>
              <td className="px-3 py-2 text-right">
                <div className="flex justify-end gap-2">
                  <button
                    className="inline-flex h-8 items-center gap-1 bg-[var(--ad-ink)] px-2 text-xs font-semibold text-white"
                    disabled={overrideBusy}
                    onClick={() => {
                      setError(null);
                      setNotice(null);
                      setOverrideDraft({ id: row.id, next: "verified", reason: "", confirmation: "" });
                    }}
                    type="button"
                  >
                    <ShieldAlert className="h-3.5 w-3.5" />
                    {t("Verify")}
                  </button>
                  <button
                    className="rounded-md inline-flex h-8 items-center gap-1 border border-[var(--ad-border)] px-2 text-xs"
                    disabled={overrideBusy}
                    onClick={() => {
                      setError(null);
                      setNotice(null);
                      setOverrideDraft({ id: row.id, next: "failed", reason: "", confirmation: "" });
                    }}
                    type="button"
                  >
                    {t("Fail")}
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {rows.length === 0 && !loading ? (
            <tr>
              <td className="px-3 py-6 text-center text-xs text-[var(--ad-text-muted)]" colSpan={5}>
                {t("No records.")}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </section>
  );
}

function canConfirm(draft: ConfirmDraft, targetId: string) {
  const confirmation = draft.confirmation.trim();
  return draft.reason.trim().length >= 3 && Boolean(targetId) && confirmation === targetId;
}
