"use client";

// SPEC: 生成质量 + 增长洞察面板（ADMIN_PHASE3_DESIGN §5.1/§5.3 的 UI）。
//   - Phase 0 hides invalid legacy retention values and export.
//   - 按 profile id 查健康度 + 跑不调用 provider 的配置检查（兼容既有 dry-run API）。
// INTENT: 自取数、无 props；样式对齐 TagsView。
import { useState } from "react";
import { Activity, AlertTriangle, Loader2 } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";

const inputClass =
  "rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]";

export type Health = {
  metrics: {
    total: number;
    completed: number;
    failed: number;
    blocked: number;
    successRate: number | null;
    blockedRate: number | null;
    refundRate: number | null;
    latencyP50Ms: number | null;
    latencyP95Ms: number | null;
  };
};
type DryRunDraft = {
  profileId: string;
  reason: string;
  confirmation: string;
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
  const { t } = useAdminI18n();

  return (
    <section className="rounded-lg border border-[var(--ad-yellow-text)]/25 bg-[var(--ad-yellow-bg)] p-4" role="status">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ad-yellow-text)]" />
        <div>
          <h2 className="text-sm font-semibold text-[var(--ad-yellow-text)]">{t("D1 / D7 retention · invalid for decisions")}</h2>
          <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">
            {t("Legacy v1 measures any activity inside cumulative 1/7-day windows, not exact calendar-day return. Values and export are unavailable until Metric Registry v2 is certified.")}
          </p>
        </div>
      </div>
    </section>
  );
}

function ProfileHealthSection() {
  const { t } = useAdminI18n();
  const [profileId, setProfileId] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [busy, setBusy] = useState<"health" | "dryrun" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [dryRunDraft, setDryRunDraft] = useState<DryRunDraft | null>(null);

  async function loadHealth() {
    setBusy("health");
    setErr(null);
    setNote(null);
    try {
      const data = await apiGet<Health>(
        `/api/v2/admin/generation/model-profiles/${encodeURIComponent(profileId.trim())}/health`,
      );
      setHealth(data);
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Health load failed");
    } finally {
      setBusy(null);
    }
  }

  function startDryRun() {
    const id = profileId.trim();
    if (!id) return;
    setErr(null);
    setNote(null);
    setDryRunDraft({ profileId: id, reason: "", confirmation: "" });
  }

  async function dryRun() {
    if (!dryRunDraft || !canConfirmDryRun(dryRunDraft)) return;
    setBusy("dryrun");
    setErr(null);
    setNote(null);
    try {
      const data = await apiWrite<{ dryRun: { status: string; passed: number; total: number } }>(
        `/api/v2/admin/generation/model-profiles/${encodeURIComponent(dryRunDraft.profileId)}/commands/dry-run`,
        "POST",
        {
          reason: dryRunDraft.reason.trim(),
          confirmation: dryRunDraft.confirmation.trim(),
        },
        { "idempotency-key": crypto.randomUUID() },
      );
      setDryRunDraft(null);
      setNote(
        t(
          "Configuration check {status}: {passed}/{total} configuration cases passed. No provider call was made.",
          {
            status: data.dryRun.status,
            passed: data.dryRun.passed,
            total: data.dryRun.total,
          },
        ),
      );
    } catch (error) {
      setErr(
        error instanceof Error
          ? error.message
          : t("Configuration check failed"),
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <h2 className="text-sm font-semibold">
        {t("Profile health + configuration check")}
      </h2>
      <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
        {t(
          "The configuration check validates deterministic profile and runtime fields only; it does not call a provider or generate media.",
        )}
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-[1fr_auto_auto]">
        <input
          aria-label={t("Model profile id")}
          className={inputClass}
          onChange={(e) => setProfileId(e.target.value)}
          placeholder={t("Model profile id")}
          value={profileId}
        />
        <button
          className="rounded-md inline-flex h-10 items-center gap-2 border border-[var(--ad-border)] px-3 text-sm disabled:opacity-50"
          disabled={busy !== null || !profileId.trim()}
          onClick={() => void loadHealth()}
          type="button"
        >
          {busy === "health" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
          {t("Health")}
        </button>
        <button
          className="inline-flex h-10 items-center gap-2 bg-[var(--ad-ink)] px-3 text-sm font-semibold text-white disabled:opacity-50"
          disabled={busy !== null || !profileId.trim()}
          onClick={startDryRun}
          type="button"
        >
          {busy === "dryrun" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {t("Configuration check")}
        </button>
      </div>
      {dryRunDraft ? (
        <section className="rounded-lg mt-3 border border-[var(--ad-yellow-text)]/20 bg-[var(--ad-yellow-bg)] p-3">
          <p className="text-xs font-semibold text-[var(--ad-yellow-text)]">
            {t("Confirm configuration check")}{" "}
            <span className="font-mono">{dryRunDraft.profileId}</span>
          </p>
          <div className="mt-3 grid gap-3 md:grid-cols-[1fr_260px_auto_auto]">
            <input
              aria-label={t("Configuration check reason")}
              className={inputClass}
              onChange={(event) => setDryRunDraft({ ...dryRunDraft, reason: event.target.value })}
              placeholder={t("Reason (≥3)")}
              value={dryRunDraft.reason}
            />
            <input
              aria-label={t("Configuration check confirmation")}
              className={`${inputClass} font-mono`}
              onChange={(event) => setDryRunDraft({ ...dryRunDraft, confirmation: event.target.value })}
              placeholder={t("Type profile ID")}
              value={dryRunDraft.confirmation}
            />
            <button
              className="rounded-md inline-flex h-10 items-center justify-center border border-[var(--ad-border)] px-3 text-sm"
              onClick={() => setDryRunDraft(null)}
              type="button"
            >
              {t("Cancel")}
            </button>
            <button
              className="inline-flex h-10 items-center justify-center bg-[var(--ad-yellow-bg)] px-3 text-sm font-semibold text-[var(--ad-yellow-text)] disabled:opacity-50"
              disabled={busy !== null || !canConfirmDryRun(dryRunDraft)}
              onClick={() => void dryRun()}
              type="button"
            >
              {busy === "dryrun" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {t("Confirm configuration check")}
            </button>
          </div>
        </section>
      ) : null}
      {err ? <p role="alert" className="mt-2 text-xs text-[var(--ad-red-text)]">{err}</p> : null}
      {note ? <p className="mt-2 text-xs text-[var(--ad-green-text)]">{note}</p> : null}
      {health ? <ProfileHealthMetrics health={health} /> : null}
    </section>
  );
}

export function ProfileHealthMetrics({ health }: { health: Health }) {
  return (
    <div className="rounded-lg mt-3 grid grid-cols-2 gap-px overflow-hidden border border-[var(--ad-border)] bg-black/[0.05] md:grid-cols-4">
      <Metric label="Total" value={health.metrics.total} />
      <Metric
        label="Success"
        value={
          health.metrics.successRate === null
            ? "—"
            : `${health.metrics.successRate}%`
        }
      />
      <Metric label="Blocked" value={percent(health.metrics.blockedRate)} />
      <Metric label="Refund" value={percent(health.metrics.refundRate)} />
      <Metric label="p50" value={milliseconds(health.metrics.latencyP50Ms)} />
      <Metric label="p95" value={milliseconds(health.metrics.latencyP95Ms)} />
      <Metric label="Failed" value={health.metrics.failed} />
      <Metric label="Completed" value={health.metrics.completed} />
    </div>
  );
}

function percent(value: number | null) {
  return value === null ? "—" : `${value}%`;
}

function milliseconds(value: number | null) {
  return value === null ? "—" : `${value}ms`;
}

function canConfirmDryRun(draft: DryRunDraft) {
  const confirmation = draft.confirmation.trim();
  return draft.reason.trim().length >= 3 && confirmation === draft.profileId;
}

function Metric({ label, value }: { label: string; value: string | number }) {
  const { t } = useAdminI18n();

  return (
    <div className="bg-[var(--ad-surface)] p-3">
      <p className="text-xs text-[var(--ad-text-muted)]">{t(label)}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}
