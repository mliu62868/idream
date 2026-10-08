"use client";

// SPEC: 生成质量 + 增长洞察面板（BackendFeatureSpec 生成质量与指标契约）。
//   - Phase 0 hides invalid legacy retention values and export.
//   - 按 profile 查健康度 + 跑不调用 provider 的配置检查（兼容既有 dry-run API）。
// INTENT: 自取数；外壳只传按操作契约算出的写权限，样式对齐 TagsView。
// WHY(诚实化): 导航把本页叫「Funnels & Retention」，但本页两个响应类型里既没有漏斗也没有
//   cohort——这不是渲染缺口，是数据契约里就没有。所以顶部直说"契约里还没有"，不编指标、
//   不放占位图；页面实际提供的能力（profile 健康度 + 配置检查）如实说明。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, Loader2 } from "lucide-react";
import { apiGet } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { PermissionNotice } from "@/components/admin/ui/PermissionNotice";
import { requestErrorMessage } from "@/components/admin/section-kit";
import { adminV2Operation, type AdminV2OperationResponse } from "@/lib/admin-v2-operation";
import { createLatestRequestGate, type LatestRequestToken } from "@/lib/latest-request";
import { useWorkspaceRefresh } from "@/features/workspace-refresh";

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

type ConfigurationResult = {
  profile: ProfileOption;
  verdict: AdminV2OperationResponse<"POST /api/v2/admin/generation/model-profiles/:id/commands/dry-run">["dryRun"];
};

export function InsightsView({ canWrite = false }: { canWrite?: boolean } = {}) {
  return (
    <div className="space-y-6">
      <RetentionSection />
      {/* A changed write grant retires filled confirmations and in-flight receipts. */}
      <ProfileHealthSection canWrite={canWrite} key={canWrite ? "write" : "read"} />
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
            {t("Funnel and retention data are unavailable")}
          </h2>
          <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">
            {t("View generation health and check model configuration below.")}
          </p>
          <p className="mt-3 text-xs leading-5 text-[var(--ad-text-muted)]">
            {t("D1 / D7 retention values and exports remain unavailable until the metric definitions are verified.")}
          </p>
        </div>
      </div>
    </section>
  );
}

function ProfileHealthSection({ canWrite }: { canWrite: boolean }) {
  const { t, value } = useAdminI18n();
  const [profiles, setProfiles] = useState<ProfileOption[] | null>(null);
  const [profilesError, setProfilesError] = useState<unknown>(null);
  const [profileId, setProfileId] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [busy, setBusy] = useState<"health" | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [dryRunTarget, setDryRunTarget] = useState<{ profile: ProfileOption; request: LatestRequestToken } | null>(null);
  const [configurationResult, setConfigurationResult] = useState<ConfigurationResult | null>(null);
  const requestGate = useRef(createLatestRequestGate());
  const diagnosticGate = useRef(createLatestRequestGate());

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
      setProfilesError(error);
    }
  }, []);

  useEffect(() => {
    const gate = requestGate.current;
    const diagnostics = diagnosticGate.current;
    const timer = window.setTimeout(() => void loadProfiles(), 0);
    return () => {
      gate.invalidate();
      diagnostics.invalidate();
      window.clearTimeout(timer);
    };
  }, [loadProfiles]);

  const selected = useMemo(
    () => profiles?.find((profile) => profile.id === profileId) ?? null,
    [profiles, profileId],
  );

  async function loadHealth() {
    if (!selected) return;
    const request = diagnosticGate.current.begin();
    setBusy("health");
    setErr(null);
    try {
      const data = await apiGet<Health>(
        `/api/v2/admin/generation/model-profiles/${encodeURIComponent(selected.id)}/health`,
      );
      if (request.isCurrent()) setHealth(data);
    } catch (error) {
      if (request.isCurrent()) setErr(error);
    } finally {
      if (request.isCurrent()) setBusy(null);
    }
  }

  useWorkspaceRefresh(() => {
    void loadProfiles();
    // A data refresh must not retire an open or unresolved configuration command.
    if (health && !dryRunTarget) void loadHealth();
  });

  // WHY(confirmation 自动填充): 后端要求 confirmation === profile.id，但 id 现在由选择器给出，
  // 让运营再把 UUID 抄一遍不增加任何安全性。走 TagsView 改名同款约定：ConfirmDialog 采集
  // reason，confirmation 由代码填 id，人读到的是 label。
  const dryRunSpec: ConfirmSpec | null = canWrite && dryRunTarget
    ? {
        title: t("Confirm configuration check"),
        summary: t("Runs deterministic profile and runtime validation for {label}. No provider is called and no media is generated.", { label: dryRunTarget.profile.label }),
        submitLabel: t("Confirm configuration check"),
        onSubmit: async (reason) => {
          if (!canWrite || !dryRunTarget.request.isCurrent()) return;
          setConfigurationResult(null);
          const data = await adminV2Operation("POST /api/v2/admin/generation/model-profiles/:id/commands/dry-run", {
            path: { id: dryRunTarget.profile.id }, body: { reason, confirmation: dryRunTarget.profile.id },
          });
          if (!dryRunTarget.request.isCurrent()) return;
          setConfigurationResult({ profile: dryRunTarget.profile, verdict: data.dryRun });
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
              diagnosticGate.current.invalidate();
              setProfileId(event.target.value);
              setHealth(null);
              setErr(null);
              setBusy(null);
              setDryRunTarget(null);
              setConfigurationResult(null);
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
          disabled={!canWrite || busy !== null || !selected}
          onClick={() => {
            if (canWrite && selected) setDryRunTarget({ profile: selected, request: diagnosticGate.current.begin() });
          }}
          type="button"
        >
          {t("Configuration check")}
        </button>
      </div>
      {!canWrite ? <p className="mt-2 text-sm"><PermissionNotice permission="generation.config.write" /></p> : null}
      {profilesError ? (
        <div className="mt-2">
          <AuthorityRequestError cause={profilesError} message={requestErrorMessage(profilesError, t)} onRetry={() => void loadProfiles()} requestKind="read" />
        </div>
      ) : null}
      {configurationResult ? <ConfigurationCheckResult result={configurationResult} /> : null}
      {err ? (
        <div className="mt-2">
          <AuthorityRequestError cause={err} message={requestErrorMessage(err, t)} onRetry={() => void loadHealth()} requestKind="read" />
        </div>
      ) : null}
      {health ? <ProfileHealthMetrics health={health} /> : null}
      {dryRunSpec && dryRunTarget ? <ConfirmDialog onClose={() => {
        if (!dryRunTarget.request.isCurrent()) return;
        diagnosticGate.current.invalidate();
        setDryRunTarget(null);
      }} spec={dryRunSpec} /> : null}
    </section>
  );
}

function ConfigurationCheckResult({ result }: { result: ConfigurationResult }) {
  const { t, value } = useAdminI18n();
  const { profile, verdict } = result;
  return (
    <section aria-label={t("Configuration check")} className="mt-3 space-y-3 rounded-md border border-[var(--ad-border)] p-3 text-sm" role="region">
      <p className={verdict.status === "pass" ? "text-[var(--ad-green-text)]" : "text-[var(--ad-red-text)]"} role="status">
        {t("Configuration check {status}: {passed}/{total} configuration cases passed. No provider call was made.", {
          status: value(verdict.status), passed: verdict.passed, total: verdict.total,
        })}
      </p>
      {/* The response has no profile/version CAS; this identifies the submitted selection, not an authority-verified version. */}
      <p>{t("Selected profile")}: {profile.label} · {profile.profileKey} · {t("Version")}: {profile.version}<br /><code className="break-all">{profile.id}</code></p>
      <h3 className="font-semibold">{t("Samples")}</h3>
      <ul className="space-y-2">
        {verdict.samples.map((sample, index) => (
          <li key={index}>
            <p>{t("Use Case")}: {value(sample.useCase)} · {t("Orientation")}: {value(sample.orientation)} · {value(sample.ok ? "pass" : "fail")}</p>
            {sample.issues.length > 0 ? <ul className="list-inside list-disc text-[var(--ad-red-text)]">{sample.issues.map((issue, issueIndex) => <li key={issueIndex}>{issue}</li>)}</ul> : null}
          </li>
        ))}
      </ul>
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
