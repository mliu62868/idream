"use client";

// SPEC: 生成质量 + 增长洞察面板（ADMIN_PHASE3_DESIGN §5.1/§5.3 的 UI）。
//   - 留存 cohort 表 + Analytics CSV 导出（浏览器下载）。
//   - 按 profile id 查健康度 + 跑 dry-run。
// INTENT: 自取数、无 props；样式对齐 TagsView。
import { useEffect, useState } from "react";
import { Activity, Download, Loader2, RefreshCcw } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";

const inputClass =
  "h-10 w-full border border-white/10 bg-black/30 px-3 text-sm outline-none focus:border-white/30";

type RetentionRow = { cohort: string; size: number; d1: number; d7: number; d1Rate: number; d7Rate: number };
type Health = {
  metrics: {
    total: number;
    completed: number;
    failed: number;
    blocked: number;
    successRate: number;
    blockedRate: number;
    refundRate: number;
    latencyP50Ms: number;
    latencyP95Ms: number;
  };
};

export function InsightsView() {
  return (
    <div className="space-y-6">
      <RetentionSection />
      <ProfileHealthSection />
    </div>
  );
}

function RetentionSection() {
  const [rows, setRows] = useState<RetentionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ items: RetentionRow[] }>("/api/v1/admin/analytics/retention");
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
  }, []);

  async function exportCsv() {
    setExporting(true);
    setError(null);
    try {
      const data = await apiGet<{ csv: string }>("/api/v1/admin/analytics/export");
      const blob = new Blob([data.csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "analytics-export.csv";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  return (
    <section className="border border-white/10 bg-[rgb(18,18,18)]">
      <div className="flex items-center justify-between border-b border-white/10 p-3">
        <h2 className="text-sm font-semibold">Retention cohorts (D1 / D7)</h2>
        <div className="flex items-center gap-2">
          <button
            className="inline-flex h-9 items-center gap-2 border border-white/10 px-3 text-sm disabled:opacity-50"
            disabled={exporting}
            onClick={() => void exportCsv()}
            type="button"
          >
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Export CSV
          </button>
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
            <th className="px-3 py-2 font-medium">cohort</th>
            <th className="px-3 py-2 font-medium">size</th>
            <th className="px-3 py-2 font-medium">D1</th>
            <th className="px-3 py-2 font-medium">D7</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.cohort} className="border-b border-white/5">
              <td className="px-3 py-2 font-mono text-xs">{row.cohort}</td>
              <td className="px-3 py-2">{row.size}</td>
              <td className="px-3 py-2">{row.d1Rate}% ({row.d1})</td>
              <td className="px-3 py-2">{row.d7Rate}% ({row.d7})</td>
            </tr>
          ))}
          {rows.length === 0 && !loading ? (
            <tr>
              <td className="px-3 py-6 text-center text-xs text-[rgb(170,170,170)]" colSpan={4}>
                No cohorts in window.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </section>
  );
}

function ProfileHealthSection() {
  const [profileId, setProfileId] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [busy, setBusy] = useState<"health" | "dryrun" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function loadHealth() {
    setBusy("health");
    setErr(null);
    setNote(null);
    try {
      const data = await apiGet<Health>(
        `/api/v1/admin/generation/model-profiles/${encodeURIComponent(profileId.trim())}/health`,
      );
      setHealth(data);
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Health load failed");
    } finally {
      setBusy(null);
    }
  }

  async function dryRun() {
    const reason = window.prompt("Reason for dry-run (≥3 chars)");
    if (!reason || reason.trim().length < 3) return;
    setBusy("dryrun");
    setErr(null);
    setNote(null);
    try {
      const data = await apiWrite<{ dryRun: { status: string; passed: number; total: number } }>(
        `/api/v1/admin/generation/model-profiles/${encodeURIComponent(profileId.trim())}/dry-run`,
        "POST",
        { reason: reason.trim(), confirmation: "DRYRUN" },
      );
      setNote(`Dry-run ${data.dryRun.status}: ${data.dryRun.passed}/${data.dryRun.total} samples passed.`);
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Dry-run failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="border border-white/10 bg-[rgb(18,18,18)] p-4">
      <h2 className="text-sm font-semibold">Profile health + dry-run</h2>
      <p className="mt-1 text-xs text-[rgb(170,170,170)]">
        发布前依据：输入 model profile id 查近 30 天健康度，或跑配置 dry-run。
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-[1fr_auto_auto]">
        <input
          className={inputClass}
          onChange={(e) => setProfileId(e.target.value)}
          placeholder="Model profile id"
          value={profileId}
        />
        <button
          className="inline-flex h-10 items-center gap-2 border border-white/10 px-3 text-sm disabled:opacity-50"
          disabled={busy !== null || !profileId.trim()}
          onClick={() => void loadHealth()}
          type="button"
        >
          {busy === "health" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
          Health
        </button>
        <button
          className="inline-flex h-10 items-center gap-2 bg-white px-3 text-sm font-semibold text-black disabled:opacity-50"
          disabled={busy !== null || !profileId.trim()}
          onClick={() => void dryRun()}
          type="button"
        >
          {busy === "dryrun" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Dry-run
        </button>
      </div>
      {err ? <p className="mt-2 text-xs text-red-300">{err}</p> : null}
      {note ? <p className="mt-2 text-xs text-emerald-300">{note}</p> : null}
      {health ? (
        <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden border border-white/10 bg-white/10 md:grid-cols-4">
          <Metric label="Total" value={health.metrics.total} />
          <Metric label="Success" value={`${health.metrics.successRate}%`} />
          <Metric label="Blocked" value={`${health.metrics.blockedRate}%`} />
          <Metric label="Refund" value={`${health.metrics.refundRate}%`} />
          <Metric label="p50" value={`${health.metrics.latencyP50Ms}ms`} />
          <Metric label="p95" value={`${health.metrics.latencyP95Ms}ms`} />
          <Metric label="Failed" value={health.metrics.failed} />
          <Metric label="Completed" value={health.metrics.completed} />
        </div>
      ) : null}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-[rgb(18,18,18)] p-3">
      <p className="text-xs text-[rgb(170,170,170)]">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}
