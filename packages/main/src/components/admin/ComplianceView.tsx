"use client";

// SPEC: 合规运营面板（ADMIN_PHASE3_DESIGN §4）。DSAR 数据导出/账号擦除 + 年龄验证人工复核。
// INTENT: 自取数、无 props；样式对齐 TagsView。导出展示脱敏 JSON；擦除/override 需 reason+typed。
// INVARIANTS: erase confirmation=ERASE、override confirmation=OVERRIDE，均 reason≥3。
import { useEffect, useState } from "react";
import { Download, Loader2, RefreshCcw, ShieldAlert, Trash2 } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";

const inputClass =
  "h-10 w-full border border-white/10 bg-black/30 px-3 text-sm outline-none focus:border-white/30";

type AgeRow = {
  id: string;
  userId: string;
  provider: string;
  status: string;
  jurisdiction: string | null;
  verifiedAt: string | null;
  createdAt: string;
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
  const [userId, setUserId] = useState("");
  const [exported, setExported] = useState<unknown>(null);
  const [busy, setBusy] = useState<"export" | "erase" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

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
    const reason = window.prompt(`Reason for erasing ${userId} (≥3 chars)`);
    if (!reason || reason.trim().length < 3) return;
    setBusy("erase");
    setErr(null);
    setNote(null);
    try {
      const data = await apiWrite<{ erased: boolean; idempotent?: boolean }>(
        `/api/v1/admin/compliance/users/${encodeURIComponent(userId.trim())}/erase`,
        "POST",
        { reason: reason.trim(), confirmation: "ERASE" },
      );
      setNote(data.idempotent ? "Already erased (idempotent)." : "Erasure requested.");
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Erase failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="border border-white/10 bg-[rgb(18,18,18)] p-4">
      <h2 className="text-sm font-semibold">DSAR — export / erase</h2>
      <p className="mt-1 text-xs text-[rgb(170,170,170)]">
        导出为脱敏结构化数据（不含明文 prompt/chat）。擦除走 P0-F 跨服务流，需确认。
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-[1fr_auto_auto]">
        <input
          className={inputClass}
          onChange={(e) => setUserId(e.target.value)}
          placeholder="User ID"
          value={userId}
        />
        <button
          className="inline-flex h-10 items-center gap-2 border border-white/10 px-3 text-sm disabled:opacity-50"
          disabled={busy !== null || !userId.trim()}
          onClick={() => void exportData()}
          type="button"
        >
          {busy === "export" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          Export
        </button>
        <button
          className="inline-flex h-10 items-center gap-2 border border-red-400/30 px-3 text-sm text-red-200 disabled:opacity-50"
          disabled={busy !== null || !userId.trim()}
          onClick={() => void erase()}
          type="button"
        >
          {busy === "erase" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          Erase
        </button>
      </div>
      {err ? <p className="mt-2 text-xs text-red-300">{err}</p> : null}
      {note ? <p className="mt-2 text-xs text-emerald-300">{note}</p> : null}
      {exported ? (
        <pre className="mt-3 max-h-80 overflow-auto border border-white/10 bg-black/30 p-3 text-xs">
          {JSON.stringify(exported, null, 2)}
        </pre>
      ) : null}
    </section>
  );
}

function AgeVerificationSection() {
  const [rows, setRows] = useState<AgeRow[]>([]);
  const [status, setStatus] = useState("pending");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ items: AgeRow[] }>(
        `/api/v1/admin/compliance/age-verifications?status=${encodeURIComponent(status)}`,
      );
      setRows(data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  async function override(id: string, next: "verified" | "failed") {
    const reason = window.prompt(`Reason for overriding ${id} → ${next} (≥3 chars)`);
    if (!reason || reason.trim().length < 3) return;
    try {
      await apiWrite(`/api/v1/admin/compliance/age-verifications/${id}/override`, "POST", {
        status: next,
        reason: reason.trim(),
        confirmation: "OVERRIDE",
      });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Override failed");
    }
  }

  return (
    <section className="border border-white/10 bg-[rgb(18,18,18)]">
      <div className="flex items-center justify-between border-b border-white/10 p-3">
        <h2 className="text-sm font-semibold">Age verification queue</h2>
        <div className="flex items-center gap-2">
          <select
            className="h-9 border border-white/10 bg-black/30 px-2 text-sm outline-none"
            onChange={(e) => setStatus(e.target.value)}
            value={status}
          >
            {["pending", "required", "failed", "verified", "expired"].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <button
            className="inline-flex h-9 items-center gap-2 border border-white/10 px-3 text-sm disabled:opacity-50"
            disabled={loading}
            onClick={() => void load()}
            type="button"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
            Refresh
          </button>
        </div>
      </div>
      {error ? <p className="px-3 py-2 text-xs text-red-300">{error}</p> : null}
      <table className="w-full text-left text-sm">
        <thead className="border-b border-white/10 text-xs text-[rgb(170,170,170)]">
          <tr>
            <th className="px-3 py-2 font-medium">user</th>
            <th className="px-3 py-2 font-medium">provider</th>
            <th className="px-3 py-2 font-medium">status</th>
            <th className="px-3 py-2 font-medium">jurisdiction</th>
            <th className="px-3 py-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-white/5">
              <td className="px-3 py-2 font-mono text-xs">{row.userId}</td>
              <td className="px-3 py-2">{row.provider}</td>
              <td className="px-3 py-2 text-[rgb(170,170,170)]">{row.status}</td>
              <td className="px-3 py-2">{row.jurisdiction ?? "—"}</td>
              <td className="px-3 py-2 text-right">
                <div className="flex justify-end gap-2">
                  <button
                    className="inline-flex h-8 items-center gap-1 bg-white px-2 text-xs font-semibold text-black"
                    onClick={() => void override(row.id, "verified")}
                    type="button"
                  >
                    <ShieldAlert className="h-3.5 w-3.5" />
                    Verify
                  </button>
                  <button
                    className="inline-flex h-8 items-center gap-1 border border-white/10 px-2 text-xs"
                    onClick={() => void override(row.id, "failed")}
                    type="button"
                  >
                    Fail
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {rows.length === 0 && !loading ? (
            <tr>
              <td className="px-3 py-6 text-center text-xs text-[rgb(170,170,170)]" colSpan={5}>
                No records.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </section>
  );
}
