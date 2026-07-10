"use client";

// SPEC: 实验度量面板（ADMIN_PHASE4_DESIGN §4）。只读：flag 列表 + 自创建以来方向性指标。
// INTENT: 自取数、无 props；诚实展示「非随机分臂归因」说明（来自后端 note）。
import { useEffect, useState } from "react";
import { Loader2, RefreshCcw } from "lucide-react";
import { apiGet } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";

type ExperimentRow = {
  key: string;
  label: string;
  enabled: boolean;
  rolloutPercent: number;
  hardPolicy: boolean;
  metrics: { signups: number; activatedUsers: number; payingUsers: number };
};

export function ExperimentsView() {
  const { t } = useAdminI18n();
  const [items, setItems] = useState<ExperimentRow[]>([]);
  const [note, setNote] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<{ items: ExperimentRow[]; note: string }>(
        "/api/v1/admin/experiments",
      );
      setItems(data.items);
      setNote(data.note);
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

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t("Experiments")} ({items.length})</h2>
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
      {note ? <p className="text-xs text-[var(--ad-text-muted)]">{note}</p> : null}
      {error ? <p className="text-xs text-[var(--ad-red-text)]">{error}</p> : null}

      <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[var(--ad-border)] text-xs text-[var(--ad-text-muted)]">
            <tr>
              <th className="px-3 py-2 font-medium">{t("flag")}</th>
              <th className="px-3 py-2 font-medium">{t("enabled")}</th>
              <th className="px-3 py-2 font-medium">{t("rollout %")}</th>
              <th className="px-3 py-2 font-medium">{t("signups")}</th>
              <th className="px-3 py-2 font-medium">{t("activated")}</th>
              <th className="px-3 py-2 font-medium">{t("paying")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((row) => (
              <tr key={row.key} className="border-b border-[var(--ad-border)]">
                <td className="px-3 py-2 font-mono text-xs">{row.key}</td>
                <td className="px-3 py-2">{row.enabled ? t("yes") : t("no")}</td>
                <td className="px-3 py-2">{row.rolloutPercent}%</td>
                <td className="px-3 py-2">{row.metrics.signups}</td>
                <td className="px-3 py-2">{row.metrics.activatedUsers}</td>
                <td className="px-3 py-2">{row.metrics.payingUsers}</td>
              </tr>
            ))}
            {items.length === 0 && !loading ? (
              <tr>
                <td className="px-3 py-6 text-center text-xs text-[var(--ad-text-muted)]" colSpan={6}>
                  {t("No feature flags.")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}
