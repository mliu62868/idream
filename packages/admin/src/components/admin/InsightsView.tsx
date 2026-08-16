"use client";

// SPEC: 生成质量 + 增长洞察面板（ADMIN_PHASE3_DESIGN §5.1/§5.3 的 UI）。
//   - Phase 0 hides invalid legacy retention values and export.
//   - 按 profile 查健康度 + 跑不调用 provider 的配置检查（兼容既有 dry-run API）。
// INTENT: 自取数、无 props；样式对齐 TagsView。
// WHY(诚实化): 导航把本页叫「Funnels & Retention」，但本页两个响应类型里既没有漏斗也没有
//   cohort——这不是渲染缺口，是数据契约里就没有。所以顶部直说"契约里还没有"，不编指标、
//   不放占位图；页面实际提供的能力（profile 健康度 + 配置检查）如实说明。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, Loader2 } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { useWriteFeedback, WriteFeedbackBanner } from "@/components/admin/section-kit";
import { createLatestRequestGate } from "@/lib/latest-request";

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

type ProfileOption = {
  id: string;
  label: string;
  profileKey: string;
  version: number;
  status: string;
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
          <h2 className="text-sm font-semibold text-[var(--ad-yellow-text)]">
            {t("No funnel or cohort series exists behind this page")}
          </h2>
          <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">
            {t("This is a contract gap, not a rendering gap: the authority this page reads returns generation health only. Nothing is being hidden from you — there is no funnel or retention series to show, and none is invented here.")}
          </p>
          <p className="mt-3 text-xs font-semibold text-[var(--ad-yellow-text)]">
            {t("D1 / D7 retention · invalid for decisions")}
          </p>
          <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">
            {t("Legacy v1 measures any activity inside cumulative 1/7-day windows, not exact calendar-day return. Values and export are unavailable until Metric Registry v2 is certified.")}
          </p>
          <p className="mt-3 text-xs leading-5 text-[var(--ad-text-muted)]">
            {t("What this page can answer today is below: per-profile generation health, and a configuration check that never calls a provider.")}
          </p>
        </div>
      </div>
    </section>
  );
}

function ProfileHealthSection() {
  const { t, value } = useAdminI18n();
  const [profiles, setProfiles] = useState<ProfileOption[] | null>(null);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const [profileId, setProfileId] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [busy, setBusy] = useState<"health" | "dryrun" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmingDryRun, setConfirmingDryRun] = useState(false);
  const { feedback, reportSuccess, reportFailure, clearFeedback } = useWriteFeedback();
  const requestGate = useRef(createLatestRequestGate());

  // SPEC: 运营不该手敲 UUID —— 没有选择器时，一个打错的字符和一个不存在的 profile 长得一样。
  const loadProfiles = useCallback(async () => {
    const request = requestGate.current.begin();
    setProfilesError(null);
    try {
      const data = await apiGet<{ items: ProfileOption[] }>(
        "/api/v2/admin/generation/model-profiles?limit=100",
      );
      if (!request.isCurrent()) return;
      setProfiles(data.items);
    } catch (error) {
      if (!request.isCurrent()) return;
      setProfiles([]);
      setProfilesError(error instanceof Error ? error.message : t("Request failed"));
    }
  }, [t]);

  useEffect(() => {
    const gate = requestGate.current;
    const timer = window.setTimeout(() => void loadProfiles(), 0);
    return () => {
      gate.invalidate();
      window.clearTimeout(timer);
    };
  }, [loadProfiles]);

  const selected = useMemo(
    () => profiles?.find((profile) => profile.id === profileId) ?? null,
    [profiles, profileId],
  );

  async function loadHealth() {
    if (!selected) return;
    setBusy("health");
    setErr(null);
    clearFeedback();
    try {
      const data = await apiGet<Health>(
        `/api/v2/admin/generation/model-profiles/${encodeURIComponent(selected.id)}/health`,
      );
      setHealth(data);
    } catch (error) {
      setErr(error instanceof Error ? error.message : t("Request failed"));
    } finally {
      setBusy(null);
    }
  }

  // WHY(confirmation 自动填充): 后端要求 confirmation === profile.id，但 id 现在由选择器给出，
  // 让运营再把 UUID 抄一遍不增加任何安全性。走 TagsView 改名同款约定：ConfirmDialog 采集
  // reason，confirmation 由代码填 id，人读到的是 label。
  const dryRunSpec: ConfirmSpec | null = confirmingDryRun && selected
    ? {
        title: t("Confirm configuration check"),
        summary: t("Runs deterministic profile and runtime validation for {label}. No provider is called and no media is generated.", { label: selected.label }),
        submitLabel: t("Confirm configuration check"),
        onSubmit: async (reason) => {
          const data = await apiWrite<{ dryRun: { status: string; passed: number; total: number } }>(
            `/api/v2/admin/generation/model-profiles/${encodeURIComponent(selected.id)}/commands/dry-run`,
            "POST",
            { reason, confirmation: selected.id },
            { "idempotency-key": crypto.randomUUID() },
          );
          reportSuccess(
            t("Configuration check {status}: {passed}/{total} configuration cases passed. No provider call was made.", {
              status: value(data.dryRun.status),
              passed: data.dryRun.passed,
              total: data.dryRun.total,
            }),
          );
        },
      }
    : null;

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
        <label className="grid gap-1">
          <span className="sr-only">{t("Model profile")}</span>
          <select
            aria-label={t("Model profile")}
            className={`${inputClass} appearance-none`}
            disabled={profiles === null || profiles.length === 0}
            onChange={(event) => {
              setProfileId(event.target.value);
              setHealth(null);
              setErr(null);
              clearFeedback();
            }}
            value={profileId}
          >
            <option value="">
              {profiles === null
                ? t("Loading…")
                : profiles.length === 0
                  ? t("No model profiles available.")
                  : t("Select a model profile…")}
            </option>
            {(profiles ?? []).map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.label} · {profile.profileKey} v{profile.version} · {value(profile.status)}
              </option>
            ))}
          </select>
        </label>
        <button
          className="rounded-md inline-flex h-10 items-center gap-2 border border-[var(--ad-border)] px-3 text-sm disabled:opacity-50"
          disabled={busy !== null || !selected}
          onClick={() => void loadHealth()}
          type="button"
        >
          {busy === "health" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
          {t("Health")}
        </button>
        <button
          className="inline-flex h-10 items-center gap-2 bg-[var(--ad-ink)] px-3 text-sm font-semibold text-white disabled:opacity-50"
          disabled={busy !== null || !selected}
          onClick={() => setConfirmingDryRun(true)}
          type="button"
        >
          {t("Configuration check")}
        </button>
      </div>
      {profilesError ? (
        <p className="mt-2 text-xs text-[var(--ad-red-text)]" role="alert">
          {profilesError}{" "}
          <button className="font-semibold underline" onClick={() => void loadProfiles()} type="button">
            {t("Retry")}
          </button>
        </p>
      ) : null}
      <div className="mt-2">
        <WriteFeedbackBanner feedback={feedback} onDismiss={clearFeedback} />
      </div>
      {err ? <p role="alert" className="mt-2 text-xs text-[var(--ad-red-text)]">{err}</p> : null}
      {health ? <ProfileHealthMetrics health={health} /> : null}
      {dryRunSpec ? <ConfirmDialog onClose={() => setConfirmingDryRun(false)} spec={dryRunSpec} /> : null}
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

function Metric({ label, value }: { label: string; value: string | number }) {
  const { t } = useAdminI18n();

  return (
    <div className="bg-[var(--ad-surface)] p-3">
      <p className="text-xs text-[var(--ad-text-muted)]">{t(label)}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}
