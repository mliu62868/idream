"use client";

// Phase 0 truth containment: FeatureFlag rollout is not an experiment without
// assignment + exposure. Keep the operational flag controls observable while hiding
// the pseudo-attributed activation/payment counts from decision makers.
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
  metrics: { signups: number | null; activatedUsers: number | null; payingUsers: number | null };
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
        <div>
          <h2 className="text-sm font-semibold">{t("Flag Monitoring")} ({items.length})</h2>
          <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
            {t("Directional only · no assignment or exposure records")}
          </p>
        </div>
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
      <div className="rounded-lg border border-[var(--ad-yellow-text)]/25 bg-[var(--ad-yellow-bg)] px-4 py-3 text-xs text-[var(--ad-yellow-text)]" role="status">
        {t("Activation and payment counts are hidden because users were not assigned to variants and no exposure was recorded. These flags cannot support causal decisions.")}
      </div>
      {note ? <p className="text-xs text-[var(--ad-text-muted)]">{note}</p> : null}
      {error ? <p className="text-xs text-[var(--ad-red-text)]" role="alert">{error}</p> : null}

      <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">{t("Feature flag rollout monitoring; not experiment results")}</caption>
          <thead className="border-b border-[var(--ad-border)] text-xs text-[var(--ad-text-muted)]">
            <tr>
              <th className="px-3 py-2 font-medium">{t("flag")}</th>
              <th className="px-3 py-2 font-medium">{t("enabled")}</th>
              <th className="px-3 py-2 font-medium">{t("rollout %")}</th>
              <th className="px-3 py-2 font-medium">{t("assignment / exposure")}</th>
              <th className="px-3 py-2 font-medium">{t("quality")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((row) => (
              <tr key={row.key} className="border-b border-[var(--ad-border)]">
                <td className="px-3 py-2 font-mono text-xs">{row.key}</td>
                <td className="px-3 py-2">{row.enabled ? t("yes") : t("no")}</td>
                <td className="px-3 py-2">{row.rolloutPercent}%</td>
                <td className="px-3 py-2 text-[var(--ad-text-muted)]">{t("not recorded")}</td>
                <td className="px-3 py-2">
                  <span className="rounded-full bg-[var(--ad-yellow-bg)] px-2 py-1 text-xs text-[var(--ad-yellow-text)]">
                    {t("directional")}
                  </span>
                </td>
              </tr>
            ))}
            {items.length === 0 && !loading ? (
              <tr>
                <td className="px-3 py-6 text-center text-xs text-[var(--ad-text-muted)]" colSpan={5}>
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
