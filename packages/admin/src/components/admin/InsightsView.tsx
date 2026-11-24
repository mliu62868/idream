"use client";

// 按模型配置查健康度，或执行不会调用 provider 的确定性配置检查。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Loader2 } from "lucide-react";
import { apiGet } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { PermissionNotice } from "@/components/admin/ui/PermissionNotice";
import { requestErrorMessage } from "@/components/admin/section-kit";
import { adminV2Operation, type AdminV2OperationResponse } from "@/lib/admin-v2-operation";
import { createLatestRequestGate } from "@/lib/latest-request";
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
  return <ProfileHealthSection canWrite={canWrite} key={canWrite ? "write" : "read"} />;
}

function ProfileHealthSection({ canWrite }: { canWrite: boolean }) {
  const { t, value } = useAdminI18n();
  const [profiles, setProfiles] = useState<ProfileOption[] | null>(null);
  const [profilesError, setProfilesError] = useState<unknown>(null);
  const [profileSearch, setProfileSearch] = useState("");
  const [profileQuery, setProfileQuery] = useState("");
  const [nextProfileCursor, setNextProfileCursor] = useState<string | null>(null);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [selectedProfile, setSelectedProfile] = useState<ProfileOption | null>(null);
  const [profileId, setProfileId] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [busy, setBusy] = useState<"health" | "check" | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [configurationError, setConfigurationError] = useState<unknown>(null);
  const [configurationResult, setConfigurationResult] = useState<ConfigurationResult | null>(null);
  const requestGate = useRef(createLatestRequestGate());
  const requestedProfileCursor = useRef<string | undefined>(undefined);
  const diagnosticGate = useRef(createLatestRequestGate());

  // SPEC: 运营不该手敲 UUID —— 没有选择器时，一个打错的字符和一个不存在的 profile 长得一样。
  const loadProfiles = useCallback(async (cursor?: string) => {
    const request = requestGate.current.begin();
    requestedProfileCursor.current = cursor;
    if (!cursor) setNextProfileCursor(null);
    setProfilesError(null);
    setProfilesLoading(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (profileQuery) params.set("search", profileQuery);
      if (cursor) params.set("cursor", cursor);
      const data = await apiGet<{ items: ProfileOption[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }>(
        `/api/v2/admin/generation/model-profiles?${params}`,
      );
      if (!request.isCurrent()) return;
      setProfiles(previous => cursor ? [...new Map([...(previous ?? []), ...data.items].map(profile => [profile.id, profile])).values()] : data.items);
      setNextProfileCursor(data.pageInfo?.hasNextPage ? data.pageInfo.endCursor : null);
      setSelectedProfile(previous => data.items.find(profile => profile.id === previous?.id) ?? previous);
    } catch (error) {
      if (!request.isCurrent()) return;
      if (!cursor) setProfiles([]);
      setProfilesError(error);
    } finally {
      if (request.isCurrent()) setProfilesLoading(false);
    }
  }, [profileQuery]);

  useEffect(() => {
    const gate = requestGate.current;
    const timer = window.setTimeout(() => void loadProfiles(), 0);
    return () => {
      gate.invalidate();
      window.clearTimeout(timer);
    };
  }, [loadProfiles]);

  useEffect(() => {
    const diagnostics = diagnosticGate.current;
    return () => diagnostics.invalidate();
  }, []);

  const selected = useMemo(
    () => profiles?.find((profile) => profile.id === profileId) ?? (selectedProfile?.id === profileId ? selectedProfile : null),
    [profiles, profileId, selectedProfile],
  );

  async function loadHealth() {
    if (!selected || busy) return;
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
    if (health && !busy && !configurationError) void loadHealth();
  });

  async function checkConfiguration() {
    if (!canWrite || !selected || busy) return;
    const request = diagnosticGate.current.begin();
    setBusy("check");
    setConfigurationError(null);
    setConfigurationResult(null);
    try {
      const data = await adminV2Operation("POST /api/v2/admin/generation/model-profiles/:id/commands/dry-run", {
        path: { id: selected.id },
        body: { reason: "Validate the selected model configuration", confirmation: selected.id },
      });
      if (request.isCurrent()) setConfigurationResult({ profile: selected, verdict: data.dryRun });
    } catch (error) {
      if (request.isCurrent()) setConfigurationError(error);
    } finally {
      if (request.isCurrent()) setBusy(null);
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
      <form className="mt-3 flex gap-2" onSubmit={event => { event.preventDefault(); if (profileQuery === profileSearch.trim()) void loadProfiles(); else setProfileQuery(profileSearch.trim()); }}>
        <input aria-label={t("Search model profiles")} className={inputClass} value={profileSearch} onChange={event => setProfileSearch(event.target.value)} />
        <button className="shrink-0 rounded-md border border-[var(--ad-border)] px-3 text-sm" type="submit">{t("Search")}</button>
      </form>
      <div className="mt-3 grid gap-3 md:grid-cols-[1fr_auto_auto]">
        <label className="grid gap-1">
          <span className="sr-only">{t("Model profile")}</span>
          <select
            aria-label={t("Model profile")}
            className={`${inputClass} appearance-none`}
            disabled={profiles === null || (profiles.length === 0 && !selected)}
            onChange={(event) => {
              diagnosticGate.current.invalidate();
              setProfileId(event.target.value);
              setSelectedProfile(profiles?.find(profile => profile.id === event.target.value) ?? null);
              setHealth(null);
              setErr(null);
              setBusy(null);
              setConfigurationError(null);
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
            {selected && !profiles?.some(profile => profile.id === selected.id) ? <option value={selected.id}>{selected.label} · {selected.profileKey} v{selected.version}</option> : null}
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
          className="inline-flex h-10 items-center gap-2 rounded-md bg-[var(--ad-ink)] px-3 text-sm font-semibold text-white disabled:opacity-50"
          disabled={!canWrite || busy !== null || !selected}
          onClick={() => void checkConfiguration()}
          type="button"
        >
          {busy === "check" ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : null}
          {t(busy === "check" ? "Checking configuration…" : "Configuration check")}
        </button>
      </div>
      {nextProfileCursor ? <button className="mt-2 rounded-md border border-[var(--ad-border)] px-3 py-2 text-sm disabled:opacity-50" disabled={profilesLoading} onClick={() => void loadProfiles(nextProfileCursor)} type="button">{t("Load more")}</button> : null}
      {!canWrite ? <p className="mt-2 text-sm"><PermissionNotice permission="generation.config.write" /></p> : null}
      {profilesError ? (
        <div className="mt-2">
          <AuthorityRequestError cause={profilesError} message={requestErrorMessage(profilesError, t)} onRetry={() => void loadProfiles(requestedProfileCursor.current)} requestKind="read" />
        </div>
      ) : null}
      {configurationResult ? <ConfigurationCheckResult result={configurationResult} /> : null}
      {configurationError && !busy ? (
        <AuthorityRequestError cause={configurationError} message={t("Configuration check could not finish")} onRetry={() => void checkConfiguration()} requestKind="write" />
      ) : null}
      {err && !busy ? (
        <div className="mt-2">
          <AuthorityRequestError cause={err} message={requestErrorMessage(err, t)} onRetry={() => void loadHealth()} requestKind="read" />
        </div>
      ) : null}
      {health ? <ProfileHealthMetrics health={health} /> : null}
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
