"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  BadgeDollarSign,
  Ban,
  Check,
  ChevronRight,
  ClipboardCheck,
  Flag,
  Gauge,
  History,
  Loader2,
  Plus,
  RefreshCcw,
  RotateCcw,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  UploadCloud,
  Users,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Actor = {
  id: string;
  role: string;
};

type AdminConsoleClientProps = {
  actor: Actor | null;
  initialSection: string;
  initialAccess: boolean;
};

type ApiError = {
  code?: string;
  message?: string;
  details?: unknown;
};

type ApiEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiError };

type Row = Record<string, unknown>;

type DashboardData = {
  metrics: {
    users: { active: number; suspended: number };
    generation: { queued: number; failed: number; blocked: number; successRate: number };
    moderation: { openReports: number };
    billing: { activeSubscriptions: number };
  };
  featureFlags: Row[];
};

type ConfigData = {
  profiles: Row[];
  templates: Row[];
  presets: Row[];
  flags: Row[];
};

type SectionData =
  | { kind: "dashboard"; data: DashboardData }
  | { kind: "jobs"; rows: Row[] }
  | { kind: "config"; data: ConfigData }
  | { kind: "moderation"; reports: Row[]; blockedMedia: Row[]; appeals: Row[] }
  | { kind: "users"; rows: Row[] }
  | { kind: "billing"; rows: Row[] }
  | { kind: "audit"; rows: Row[] };

type PendingAction = {
  title: string;
  endpoint: string;
  method: "POST" | "PATCH";
  confirmText: string;
  reasonRequired: boolean;
  body: (reason: string, confirmation: string) => Record<string, unknown>;
};

type ModelDraft = {
  profileKey: string;
  label: string;
  mode: "image" | "video";
  runner: "pipeline" | "sd_cpp" | "mlx" | "comfyui" | "external";
  pipelineModel: string;
  sourceModelPath: string;
  convertedModelPath: string;
  modelFormat: "safetensors" | "gguf" | "diffusers" | "external";
  defaultWidth: string;
  defaultHeight: string;
  allowedOrientations: string;
  steps: string;
  sampler: string;
  cfgScale: string;
  costMultiplier: string;
  requiredEntitlement: string;
  maxCount: string;
  runnerConfigJson: string;
};

type TemplateDraft = {
  templateKey: string;
  label: string;
  mode: "image" | "video" | "negative";
  useCase: "character" | "freeplay" | "negative";
  body: string;
  negativeBase: string;
};

const defaultModelDraft: ModelDraft = {
  profileKey: "profile_image_default_v2",
  label: "Default image v2",
  mode: "image",
  runner: "sd_cpp",
  pipelineModel: "pornmaster-zimage-turbo",
  sourceModelPath: "/Users/kk/Downloads/pornmasterZImage_turboV35Bf16.safetensors",
  convertedModelPath: "",
  modelFormat: "safetensors",
  defaultWidth: "768",
  defaultHeight: "1024",
  allowedOrientations: "1:1,4:5,3:4,9:16,16:9",
  steps: "28",
  sampler: "dpmpp_2m",
  cfgScale: "7",
  costMultiplier: "1",
  requiredEntitlement: "",
  maxCount: "4",
  runnerConfigJson:
    '{"cliPath":"/Users/kk/code/sdcpp/sd-cli","llmPath":"/Users/kk/.localai/models/z-image-components/Qwen3-4B-Instruct-2507-Q4_K_M.gguf","vaePath":"/Users/kk/.localai/models/z-image-components/split_files/vae/ae.safetensors"}',
};

const defaultTemplateDraft: TemplateDraft = {
  templateKey: "template_image_character_v2",
  label: "Image character v2",
  mode: "image",
  useCase: "character",
  body: "Character image generation template with appearance, pose, outfit, background, style, and quality blocks.",
  negativeBase: "low quality, distorted anatomy, extra fingers, watermark, text",
};

const navItems = [
  { id: "dashboard", label: "Dashboard", href: "/admin", icon: Gauge },
  { id: "generation/jobs", label: "Generation Jobs", href: "/admin/generation/jobs", icon: Activity },
  { id: "generation/config", label: "Generation Config", href: "/admin/generation/config", icon: SlidersHorizontal },
  { id: "moderation", label: "Moderation", href: "/admin/moderation", icon: ShieldAlert },
  { id: "users", label: "Users", href: "/admin/users", icon: Users },
  { id: "billing", label: "Billing", href: "/admin/billing", icon: BadgeDollarSign },
  { id: "audit-log", label: "Audit Log", href: "/admin/audit-log", icon: History },
];

export function AdminConsoleClient({
  actor,
  initialSection,
  initialAccess,
}: AdminConsoleClientProps) {
  const sectionId = normalizeSection(initialSection);
  const activeItem = navItems.find((item) => item.id === sectionId) ?? navItems[0];
  const [data, setData] = useState<SectionData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [adjustment, setAdjustment] = useState({ userId: "", delta: "" });
  const [modelDraft, setModelDraft] = useState<ModelDraft>(defaultModelDraft);
  const [templateDraft, setTemplateDraft] = useState<TemplateDraft>(defaultTemplateDraft);
  const [configBusy, setConfigBusy] = useState<"model" | "template" | null>(null);

  const filteredData = useMemo(() => filterSectionData(data, query), [data, query]);

  async function load() {
    if (!initialAccess) return;
    setLoading(true);
    setError(null);
    try {
      setData(await fetchSection(sectionId));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load admin data");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
    // sectionId is derived from the route; load should run when the route changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionId, initialAccess]);

  function openAction(action: PendingAction) {
    setReason("");
    setConfirmation("");
    setPendingAction(action);
  }

  async function submitAction() {
    if (!pendingAction) return;
    setActionBusy(true);
    setError(null);
    try {
      const response = await fetch(pendingAction.endpoint, {
        method: pendingAction.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(pendingAction.body(reason, confirmation)),
      });
      const payload = (await response.json()) as ApiEnvelope<unknown>;
      if (!payload.ok) {
        throw new Error(payload.error.message ?? payload.error.code ?? "Admin action failed");
      }
      setPendingAction(null);
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Admin action failed");
    } finally {
      setActionBusy(false);
    }
  }

  async function createModelProfile() {
    setConfigBusy("model");
    setError(null);
    try {
      await apiWrite("/api/v1/admin/generation/model-profiles", "POST", modelDraftPayload(modelDraft));
      await load();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Model profile create failed");
    } finally {
      setConfigBusy(null);
    }
  }

  async function createPromptTemplate() {
    setConfigBusy("template");
    setError(null);
    try {
      await apiWrite(
        "/api/v1/admin/generation/prompt-templates",
        "POST",
        templateDraftPayload(templateDraft),
      );
      await load();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Prompt template create failed");
    } finally {
      setConfigBusy(null);
    }
  }

  if (!actor || !initialAccess) {
    return (
      <main className="min-h-screen bg-[rgb(13,13,13)] px-6 py-8 text-white">
        <div className="mx-auto max-w-xl border border-white/10 bg-[rgb(18,18,18)] p-6">
          <div className="flex items-center gap-3">
            <Ban className="h-5 w-5 text-red-300" />
            <h1 className="text-lg font-semibold">Admin access denied</h1>
          </div>
          <p className="mt-3 text-sm text-[rgb(170,170,170)]">
            Signed-in internal roles only.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[rgb(13,13,13)] text-white">
      <div className="flex min-h-screen">
        <aside className="sticky top-0 hidden h-screen w-[248px] shrink-0 border-r border-white/10 bg-[rgb(18,18,18)] md:block">
          <div className="flex h-14 items-center border-b border-white/10 px-5">
            <div>
              <p className="text-sm font-semibold">iDream Admin</p>
              <p className="text-[11px] text-[rgb(170,170,170)]">{actor.role}</p>
            </div>
          </div>
          <nav className="p-3">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = item.id === sectionId;
              return (
                <Link
                  key={item.id}
                  className={cn(
                    "mb-1 flex h-10 items-center gap-3 rounded-md px-3 text-[13px] font-medium text-[rgb(170,170,170)] transition-colors hover:bg-white/10 hover:text-white",
                    active && "bg-white/10 text-white",
                  )}
                  href={item.href}
                >
                  <Icon className="h-4 w-4" />
                  <span>{item.label}</span>
                  {active ? <ChevronRight className="ml-auto h-4 w-4" /> : null}
                </Link>
              );
            })}
          </nav>
        </aside>

        <section className="min-w-0 flex-1">
          <header className="sticky top-0 z-20 border-b border-white/10 bg-[rgba(13,13,13,0.92)] backdrop-blur">
            <div className="flex min-h-14 flex-wrap items-center gap-3 px-4 py-3 md:px-6">
              <div>
                <h1 className="text-base font-semibold md:text-lg">{activeItem.label}</h1>
                <p className="text-[11px] text-[rgb(170,170,170)]">{actor.id}</p>
              </div>
              <div className="ml-auto flex h-9 min-w-[220px] items-center gap-2 border border-white/10 bg-[rgb(18,18,18)] px-3">
                <Search className="h-4 w-4 text-[rgb(170,170,170)]" />
                <input
                  className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[rgb(114,113,112)]"
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Filter"
                  value={query}
                />
              </div>
              <button
                className="inline-flex h-9 items-center gap-2 border border-white/10 px-3 text-sm text-[rgb(230,230,230)] hover:bg-white/10"
                onClick={() => void load()}
                type="button"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
                Refresh
              </button>
            </div>
          </header>

          <div className="p-4 md:p-6">
            {error ? (
              <div className="mb-4 border border-red-400/30 bg-red-950/30 px-4 py-3 text-sm text-red-100">
                {error}
              </div>
            ) : null}
            {loading && !filteredData ? (
              <div className="flex h-48 items-center justify-center text-[rgb(170,170,170)]">
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                Loading
              </div>
            ) : (
              renderSection(filteredData, {
                openAction,
                adjustment,
                setAdjustment,
                modelDraft,
                setModelDraft,
                templateDraft,
                setTemplateDraft,
                configBusy,
                createModelProfile,
                createPromptTemplate,
              })
            )}
          </div>
        </section>
      </div>

      {pendingAction ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-md border border-white/10 bg-[rgb(18,18,18)] p-5 shadow-2xl">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold">{pendingAction.title}</h2>
              <button
                aria-label="Close"
                className="grid h-8 w-8 place-items-center rounded-md hover:bg-white/10"
                onClick={() => setPendingAction(null)}
                type="button"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-4 space-y-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-[rgb(170,170,170)]">Reason</span>
                <textarea
                  className="min-h-20 w-full resize-y border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-white/30"
                  onChange={(event) => setReason(event.target.value)}
                  value={reason}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-[rgb(170,170,170)]">
                  Confirmation
                </span>
                <input
                  className="h-10 w-full border border-white/10 bg-black/30 px-3 font-mono text-sm outline-none focus:border-white/30"
                  onChange={(event) => setConfirmation(event.target.value)}
                  value={confirmation}
                />
              </label>
              <div className="border border-white/10 bg-black/20 px-3 py-2 font-mono text-xs text-[rgb(230,230,230)]">
                {pendingAction.confirmText}
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                className="h-9 border border-white/10 px-3 text-sm text-[rgb(230,230,230)] hover:bg-white/10"
                onClick={() => setPendingAction(null)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="inline-flex h-9 items-center gap-2 bg-white px-3 text-sm font-semibold text-black disabled:opacity-50"
                disabled={
                  actionBusy ||
                  confirmation !== pendingAction.confirmText ||
                  (pendingAction.reasonRequired && reason.trim().length < 3)
                }
                onClick={() => void submitAction()}
                type="button"
              >
                {actionBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                Confirm
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

async function fetchSection(sectionId: string): Promise<SectionData> {
  if (sectionId === "generation/jobs") {
    const payload = await apiGet<{ items: Row[] }>("/api/v1/admin/generation/jobs?mode=image");
    return { kind: "jobs", rows: payload.items };
  }
  if (sectionId === "generation/config") {
    const [profiles, templates, presets, flags] = await Promise.all([
      apiGet<{ items: Row[] }>("/api/v1/admin/generation/model-profiles"),
      apiGet<{ items: Row[] }>("/api/v1/admin/generation/prompt-templates"),
      apiGet<{ items: Row[] }>("/api/v1/admin/generation/presets"),
      apiGet<{ items: Row[] }>("/api/v1/admin/feature-flags"),
    ]);
    return {
      kind: "config",
      data: {
        profiles: profiles.items,
        templates: templates.items,
        presets: presets.items,
        flags: flags.items,
      },
    };
  }
  if (sectionId === "moderation") {
    const payload = await apiGet<{ reports: Row[]; blockedMedia: Row[]; appeals: Row[] }>(
      "/api/v1/admin/moderation/queue",
    );
    return {
      kind: "moderation",
      reports: payload.reports,
      blockedMedia: payload.blockedMedia,
      appeals: payload.appeals,
    };
  }
  if (sectionId === "users") {
    const payload = await apiGet<{ items: Row[] }>("/api/v1/admin/users");
    return { kind: "users", rows: payload.items };
  }
  if (sectionId === "billing") {
    const payload = await apiGet<{ items: Row[] }>("/api/v1/admin/billing/ledger");
    return { kind: "billing", rows: payload.items };
  }
  if (sectionId === "audit-log") {
    const payload = await apiGet<{ items: Row[] }>("/api/v1/admin/audit-log");
    return { kind: "audit", rows: payload.items };
  }

  const payload = await apiGet<DashboardData>("/api/v1/admin/dashboard");
  return { kind: "dashboard", data: payload };
}

async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store" });
  const payload = (await response.json()) as ApiEnvelope<T>;
  if (!payload.ok) {
    throw new Error(payload.error.message ?? payload.error.code ?? "Request failed");
  }
  return payload.data;
}

async function apiWrite<T>(
  path: string,
  method: "POST" | "PATCH",
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as ApiEnvelope<T>;
  if (!payload.ok) {
    throw new Error(payload.error.message ?? payload.error.code ?? "Request failed");
  }
  return payload.data;
}

function canCreateModelProfile(draft: ModelDraft) {
  return Boolean(
    draft.profileKey.trim() &&
      draft.label.trim() &&
      draft.pipelineModel.trim() &&
      parseCsv(draft.allowedOrientations).length > 0,
  );
}

function modelDraftPayload(draft: ModelDraft): Record<string, unknown> {
  return {
    profileKey: draft.profileKey.trim(),
    label: draft.label.trim(),
    mode: draft.mode,
    runner: draft.runner,
    pipelineModel: draft.pipelineModel.trim(),
    sourceModelPath: nullableText(draft.sourceModelPath),
    convertedModelPath: nullableText(draft.convertedModelPath),
    modelFormat: draft.modelFormat,
    defaultWidth: intFromText(draft.defaultWidth, 768),
    defaultHeight: intFromText(draft.defaultHeight, 1024),
    allowedOrientations: parseCsv(draft.allowedOrientations),
    steps: intFromText(draft.steps, 28),
    sampler: draft.sampler.trim() || "dpmpp_2m",
    cfgScale: numberFromText(draft.cfgScale, 7),
    costMultiplier: numberFromText(draft.costMultiplier, 1),
    requiredEntitlement: nullableText(draft.requiredEntitlement),
    maxCount: intFromText(draft.maxCount, 4),
    concurrencyLimit: 1,
    enabled: true,
    rolloutPercent: 100,
    runnerConfig: jsonRecordFromText(draft.runnerConfigJson),
    dryRunSummary: { source: "admin_console", status: "draft_created" },
  };
}

function templateDraftPayload(draft: TemplateDraft): Record<string, unknown> {
  return {
    templateKey: draft.templateKey.trim(),
    label: draft.label.trim(),
    mode: draft.mode,
    useCase: draft.useCase,
    body: draft.body.trim(),
    negativeBase: nullableText(draft.negativeBase),
    presetOrder: [],
    safetyHints: { source: "admin_console" },
    sampleMatrix: [],
    dryRunSummary: { source: "admin_console", status: "draft_created" },
  };
}

function nullableText(value: string) {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseCsv(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function intFromText(value: string, fallback: number) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function numberFromText(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function jsonRecordFromText(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = JSON.parse(trimmed) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Runner Config must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function renderSection(
  section: SectionData | null,
  ctx: {
    openAction: (action: PendingAction) => void;
    adjustment: { userId: string; delta: string };
    setAdjustment: (value: { userId: string; delta: string }) => void;
    modelDraft: ModelDraft;
    setModelDraft: (value: ModelDraft) => void;
    templateDraft: TemplateDraft;
    setTemplateDraft: (value: TemplateDraft) => void;
    configBusy: "model" | "template" | null;
    createModelProfile: () => void;
    createPromptTemplate: () => void;
  },
) {
  if (!section) return null;
  if (section.kind === "dashboard") return <DashboardView data={section.data} />;
  if (section.kind === "jobs") return <JobsView rows={section.rows} openAction={ctx.openAction} />;
  if (section.kind === "config") {
    return (
      <ConfigView
        configBusy={ctx.configBusy}
        createModelProfile={ctx.createModelProfile}
        createPromptTemplate={ctx.createPromptTemplate}
        data={section.data}
        modelDraft={ctx.modelDraft}
        openAction={ctx.openAction}
        setModelDraft={ctx.setModelDraft}
        setTemplateDraft={ctx.setTemplateDraft}
        templateDraft={ctx.templateDraft}
      />
    );
  }
  if (section.kind === "moderation") {
    return (
      <ModerationView
        appeals={section.appeals}
        blockedMedia={section.blockedMedia}
        openAction={ctx.openAction}
        reports={section.reports}
      />
    );
  }
  if (section.kind === "users") return <UsersView rows={section.rows} openAction={ctx.openAction} />;
  if (section.kind === "billing") {
    return (
      <BillingView
        adjustment={ctx.adjustment}
        openAction={ctx.openAction}
        rows={section.rows}
        setAdjustment={ctx.setAdjustment}
      />
    );
  }
  return <AuditView rows={section.rows} />;
}

function DashboardView({ data }: { data: DashboardData }) {
  return (
    <div className="space-y-5">
      <div className="grid gap-px overflow-hidden border border-white/10 bg-white/10 md:grid-cols-4">
        <Metric label="Users" value={data.metrics.users.active} meta={`${data.metrics.users.suspended} suspended`} />
        <Metric label="Generation" value={`${data.metrics.generation.successRate}%`} meta={`${data.metrics.generation.queued} queued`} />
        <Metric label="Moderation" value={data.metrics.moderation.openReports} meta="open reports" />
        <Metric label="Billing" value={data.metrics.billing.activeSubscriptions} meta="active subscriptions" />
      </div>
      <DataTable
        columns={["key", "enabled", "rolloutPercent", "version"]}
        rows={data.featureFlags}
        title="Feature Flags"
      />
    </div>
  );
}

function JobsView({
  rows,
  openAction,
}: {
  rows: Row[];
  openAction: (action: PendingAction) => void;
}) {
  return (
    <DataTable
      actions={(row) => {
        const id = stringValue(row.id);
        const status = stringValue(row.status);
        if (status !== "failed") return null;
        return (
          <IconAction
            icon={<RefreshCcw className="h-4 w-4" />}
            label="Requeue"
            onClick={() =>
              openAction({
                title: `Requeue ${id}`,
                endpoint: `/api/v1/admin/generation/jobs/${id}/requeue`,
                method: "POST",
                confirmText: "REQUEUE",
                reasonRequired: false,
                body: (actionReason) => ({
                  reason: actionReason || undefined,
                  confirmation: "REQUEUE",
                }),
              })
            }
          />
        );
      }}
      columns={["id", "userId", "mode", "status", "profileId", "profileVersion", "costDreamcoins", "errorCode", "createdAt"]}
      rows={rows}
      title="Generation Jobs"
    />
  );
}

function ConfigView({
  configBusy,
  createModelProfile,
  createPromptTemplate,
  data,
  modelDraft,
  openAction,
  setModelDraft,
  setTemplateDraft,
  templateDraft,
}: {
  configBusy: "model" | "template" | null;
  createModelProfile: () => void;
  createPromptTemplate: () => void;
  data: ConfigData;
  modelDraft: ModelDraft;
  openAction: (action: PendingAction) => void;
  setModelDraft: (value: ModelDraft) => void;
  setTemplateDraft: (value: TemplateDraft) => void;
  templateDraft: TemplateDraft;
}) {
  return (
    <div className="space-y-6">
      <ModelProfileDraftForm
        busy={configBusy === "model"}
        draft={modelDraft}
        onCreate={createModelProfile}
        onDraftChange={setModelDraft}
      />
      <PromptTemplateDraftForm
        busy={configBusy === "template"}
        draft={templateDraft}
        onCreate={createPromptTemplate}
        onDraftChange={setTemplateDraft}
      />
      <DataTable
        actions={(row) => {
          const id = stringValue(row.id);
          const status = stringValue(row.status);
          const enabled = Boolean(row.enabled);
          return (
            <div className="flex flex-wrap gap-1">
              {status === "draft" ? (
                <IconAction
                  icon={<UploadCloud className="h-4 w-4" />}
                  label="Publish"
                  onClick={() =>
                    openAction({
                      title: `Publish profile ${id}`,
                      endpoint: `/api/v1/admin/generation/model-profiles/${id}/publish`,
                      method: "POST",
                      confirmText: "PUBLISH",
                      reasonRequired: true,
                      body: (actionReason) => ({
                        reason: actionReason,
                        confirmation: "PUBLISH",
                        dryRunSummary: { source: "admin_console" },
                      }),
                    })
                  }
                />
              ) : null}
              {status === "active" ? (
                <IconAction
                  icon={<RotateCcw className="h-4 w-4" />}
                  label="Rollback"
                  onClick={() =>
                    openAction({
                      title: `Rollback profile ${id}`,
                      endpoint: `/api/v1/admin/generation/model-profiles/${id}/rollback`,
                      method: "POST",
                      confirmText: "ROLLBACK",
                      reasonRequired: true,
                      body: (actionReason) => ({ reason: actionReason, confirmation: "ROLLBACK" }),
                    })
                  }
                />
              ) : null}
              {enabled ? (
                <IconAction
                  icon={<Ban className="h-4 w-4" />}
                  label="Disable"
                  onClick={() =>
                    openAction({
                      title: `Disable profile ${id}`,
                      endpoint: `/api/v1/admin/generation/model-profiles/${id}`,
                      method: "PATCH",
                      confirmText: "DISABLE",
                      reasonRequired: true,
                      body: (actionReason) => ({
                        enabled: false,
                        reason: actionReason,
                        confirmation: "DISABLE",
                      }),
                    })
                  }
                />
              ) : null}
            </div>
          );
        }}
        columns={[
          "id",
          "profileKey",
          "label",
          "mode",
          "runner",
          "pipelineModel",
          "sourceModelPath",
          "convertedModelPath",
          "modelFormat",
          "status",
          "version",
          "enabled",
          "rolloutPercent",
          "requiredEntitlement",
        ]}
        rows={data.profiles}
        title="Model Profiles"
      />

      <DataTable
        actions={(row) => {
          const id = stringValue(row.id);
          const status = stringValue(row.status);
          return (
            <div className="flex flex-wrap gap-1">
              {status === "draft" ? (
                <IconAction
                  icon={<UploadCloud className="h-4 w-4" />}
                  label="Publish"
                  onClick={() =>
                    openAction({
                      title: `Publish template ${id}`,
                      endpoint: `/api/v1/admin/generation/prompt-templates/${id}/publish`,
                      method: "POST",
                      confirmText: "PUBLISH",
                      reasonRequired: true,
                      body: (actionReason) => ({
                        reason: actionReason,
                        confirmation: "PUBLISH",
                        dryRunSummary: { source: "admin_console" },
                      }),
                    })
                  }
                />
              ) : null}
              {status === "active" ? (
                <IconAction
                  icon={<RotateCcw className="h-4 w-4" />}
                  label="Rollback"
                  onClick={() =>
                    openAction({
                      title: `Rollback template ${id}`,
                      endpoint: `/api/v1/admin/generation/prompt-templates/${id}/rollback`,
                      method: "POST",
                      confirmText: "ROLLBACK",
                      reasonRequired: true,
                      body: (actionReason) => ({ reason: actionReason, confirmation: "ROLLBACK" }),
                    })
                  }
                />
              ) : null}
            </div>
          );
        }}
        columns={["id", "templateKey", "label", "mode", "useCase", "status", "version"]}
        rows={data.templates}
        title="Prompt Templates"
      />

      <DataTable
        columns={["id", "type", "category", "label", "visibility", "status"]}
        rows={data.presets}
        title="Built-in Presets"
      />

      <DataTable
        actions={(row) => {
          const key = stringValue(row.key);
          const enabled = Boolean(row.enabled);
          return (
            <IconAction
              icon={<Flag className="h-4 w-4" />}
              label={enabled ? "Disable" : "Enable"}
              onClick={() =>
                openAction({
                  title: `${enabled ? "Disable" : "Enable"} ${key}`,
                  endpoint: `/api/v1/admin/feature-flags/${key}`,
                  method: "PATCH",
                  confirmText: "FLAG",
                  reasonRequired: true,
                  body: (actionReason) => ({
                    enabled: !enabled,
                    reason: actionReason,
                    confirmation: "FLAG",
                  }),
                })
              }
            />
          );
        }}
        columns={["key", "enabled", "rolloutPercent", "version", "hardPolicy"]}
        rows={data.flags}
        title="Feature Flags"
      />
    </div>
  );
}

function ModelProfileDraftForm({
  busy,
  draft,
  onCreate,
  onDraftChange,
}: {
  busy: boolean;
  draft: ModelDraft;
  onCreate: () => void;
  onDraftChange: (value: ModelDraft) => void;
}) {
  return (
    <section className="border border-white/10 bg-[rgb(18,18,18)] p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Create Model Profile Draft</h2>
        <button
          className="inline-flex h-9 items-center gap-2 bg-white px-3 text-sm font-semibold text-black disabled:opacity-50"
          disabled={busy || !canCreateModelProfile(draft)}
          onClick={onCreate}
          type="button"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Create Draft
        </button>
      </div>
      <div className="grid gap-3 md:grid-cols-4">
        <FormField
          label="Profile Key"
          onChange={(value) => onDraftChange({ ...draft, profileKey: value })}
          value={draft.profileKey}
        />
        <FormField
          label="Label"
          onChange={(value) => onDraftChange({ ...draft, label: value })}
          value={draft.label}
        />
        <FormSelect
          label="Mode"
          onChange={(value) => onDraftChange({ ...draft, mode: value as ModelDraft["mode"] })}
          options={["image", "video"]}
          value={draft.mode}
        />
        <FormSelect
          label="Runner"
          onChange={(value) => onDraftChange({ ...draft, runner: value as ModelDraft["runner"] })}
          options={["sd_cpp", "pipeline", "mlx", "comfyui", "external"]}
          value={draft.runner}
        />
        <FormField
          label="Pipeline Model"
          onChange={(value) => onDraftChange({ ...draft, pipelineModel: value })}
          value={draft.pipelineModel}
        />
        <FormSelect
          label="Format"
          onChange={(value) => onDraftChange({ ...draft, modelFormat: value as ModelDraft["modelFormat"] })}
          options={["safetensors", "gguf", "diffusers", "external"]}
          value={draft.modelFormat}
        />
        <FormField
          label="Width"
          onChange={(value) => onDraftChange({ ...draft, defaultWidth: value })}
          value={draft.defaultWidth}
        />
        <FormField
          label="Height"
          onChange={(value) => onDraftChange({ ...draft, defaultHeight: value })}
          value={draft.defaultHeight}
        />
        <FormField
          label="Steps"
          onChange={(value) => onDraftChange({ ...draft, steps: value })}
          value={draft.steps}
        />
        <FormField
          label="Sampler"
          onChange={(value) => onDraftChange({ ...draft, sampler: value })}
          value={draft.sampler}
        />
        <FormField
          label="CFG"
          onChange={(value) => onDraftChange({ ...draft, cfgScale: value })}
          value={draft.cfgScale}
        />
        <FormField
          label="Max Count"
          onChange={(value) => onDraftChange({ ...draft, maxCount: value })}
          value={draft.maxCount}
        />
        <FormField
          label="Cost Multiplier"
          onChange={(value) => onDraftChange({ ...draft, costMultiplier: value })}
          value={draft.costMultiplier}
        />
        <FormField
          label="Entitlement"
          onChange={(value) => onDraftChange({ ...draft, requiredEntitlement: value })}
          value={draft.requiredEntitlement}
        />
        <FormField
          label="Orientations"
          onChange={(value) => onDraftChange({ ...draft, allowedOrientations: value })}
          value={draft.allowedOrientations}
        />
        <FormField
          label="Source Model"
          onChange={(value) => onDraftChange({ ...draft, sourceModelPath: value })}
          value={draft.sourceModelPath}
        />
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <FormField
          label="Converted Model"
          onChange={(value) => onDraftChange({ ...draft, convertedModelPath: value })}
          value={draft.convertedModelPath}
        />
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-[rgb(170,170,170)]">Runner Config</span>
          <textarea
            className="min-h-20 w-full resize-y border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs outline-none focus:border-white/30"
            onChange={(event) => onDraftChange({ ...draft, runnerConfigJson: event.target.value })}
            value={draft.runnerConfigJson}
          />
        </label>
      </div>
    </section>
  );
}

function PromptTemplateDraftForm({
  busy,
  draft,
  onCreate,
  onDraftChange,
}: {
  busy: boolean;
  draft: TemplateDraft;
  onCreate: () => void;
  onDraftChange: (value: TemplateDraft) => void;
}) {
  return (
    <section className="border border-white/10 bg-[rgb(18,18,18)] p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Create Prompt Template Draft</h2>
        <button
          className="inline-flex h-9 items-center gap-2 bg-white px-3 text-sm font-semibold text-black disabled:opacity-50"
          disabled={busy || !draft.templateKey.trim() || !draft.label.trim() || !draft.body.trim()}
          onClick={onCreate}
          type="button"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Create Draft
        </button>
      </div>
      <div className="grid gap-3 md:grid-cols-4">
        <FormField
          label="Template Key"
          onChange={(value) => onDraftChange({ ...draft, templateKey: value })}
          value={draft.templateKey}
        />
        <FormField
          label="Label"
          onChange={(value) => onDraftChange({ ...draft, label: value })}
          value={draft.label}
        />
        <FormSelect
          label="Mode"
          onChange={(value) => onDraftChange({ ...draft, mode: value as TemplateDraft["mode"] })}
          options={["image", "video", "negative"]}
          value={draft.mode}
        />
        <FormSelect
          label="Use Case"
          onChange={(value) => onDraftChange({ ...draft, useCase: value as TemplateDraft["useCase"] })}
          options={["character", "freeplay", "negative"]}
          value={draft.useCase}
        />
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-[rgb(170,170,170)]">Body</span>
          <textarea
            className="min-h-24 w-full resize-y border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-white/30"
            onChange={(event) => onDraftChange({ ...draft, body: event.target.value })}
            value={draft.body}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-[rgb(170,170,170)]">Negative Base</span>
          <textarea
            className="min-h-24 w-full resize-y border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-white/30"
            onChange={(event) => onDraftChange({ ...draft, negativeBase: event.target.value })}
            value={draft.negativeBase}
          />
        </label>
      </div>
    </section>
  );
}

function FormField({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-[rgb(170,170,170)]">{label}</span>
      <input
        className="h-10 w-full border border-white/10 bg-black/30 px-3 text-sm outline-none focus:border-white/30"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      />
    </label>
  );
}

function FormSelect({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: string[];
  value: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-[rgb(170,170,170)]">{label}</span>
      <select
        className="h-10 w-full border border-white/10 bg-black/30 px-3 text-sm outline-none focus:border-white/30"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function ModerationView({
  reports,
  blockedMedia,
  appeals,
  openAction,
}: {
  reports: Row[];
  blockedMedia: Row[];
  appeals: Row[];
  openAction: (action: PendingAction) => void;
}) {
  return (
    <div className="space-y-6">
      <DataTable
        actions={(row) => {
          const id = stringValue(row.id);
          return (
            <div className="flex flex-wrap gap-1">
              <IconAction
                icon={<ClipboardCheck className="h-4 w-4" />}
                label="Action"
                onClick={() =>
                  openAction({
                    title: `Action report ${id}`,
                    endpoint: `/api/v1/admin/moderation/${id}/decision`,
                    method: "POST",
                    confirmText: "TAKEDOWN",
                    reasonRequired: true,
                    body: (actionReason) => ({
                      decision: "actioned",
                      policyCode: "manual_review",
                      reason: actionReason,
                      confirmation: "TAKEDOWN",
                    }),
                  })
                }
              />
              <IconAction
                icon={<Check className="h-4 w-4" />}
                label="Close"
                onClick={() =>
                  openAction({
                    title: `Close report ${id}`,
                    endpoint: `/api/v1/admin/moderation/${id}/decision`,
                    method: "POST",
                    confirmText: id,
                    reasonRequired: true,
                    body: (actionReason) => ({
                      decision: "no_violation",
                      reason: actionReason,
                      confirmation: id,
                    }),
                  })
                }
              />
            </div>
          );
        }}
        columns={["id", "targetType", "targetId", "category", "status", "priority", "createdAt"]}
        rows={reports}
        title="Reports"
      />
      <DataTable
        columns={["id", "ownerId", "type", "safetyStatus", "createdAt"]}
        rows={blockedMedia}
        title="Blocked Media"
      />
      <DataTable
        columns={["id", "userId", "targetType", "targetId", "status", "createdAt"]}
        rows={appeals}
        title="Appeals"
      />
    </div>
  );
}

function UsersView({
  rows,
  openAction,
}: {
  rows: Row[];
  openAction: (action: PendingAction) => void;
}) {
  return (
    <DataTable
      actions={(row) => {
        const id = stringValue(row.id);
        const status = stringValue(row.status);
        const nextStatus = status === "suspended" ? "active" : "suspended";
        return (
          <IconAction
            icon={nextStatus === "active" ? <Check className="h-4 w-4" /> : <Ban className="h-4 w-4" />}
            label={nextStatus === "active" ? "Restore" : "Suspend"}
            onClick={() =>
              openAction({
                title: `${nextStatus === "active" ? "Restore" : "Suspend"} ${id}`,
                endpoint: `/api/v1/admin/users/${id}/status`,
                method: "POST",
                confirmText: nextStatus.toUpperCase(),
                reasonRequired: true,
                body: (actionReason) => ({
                  status: nextStatus,
                  reason: actionReason,
                  confirmation: nextStatus.toUpperCase(),
                }),
              })
            }
          />
        );
      }}
      columns={["id", "email", "displayName", "role", "status", "dreamcoins", "createdAt"]}
      rows={rows}
      title="Users"
    />
  );
}

function BillingView({
  rows,
  adjustment,
  setAdjustment,
  openAction,
}: {
  rows: Row[];
  adjustment: { userId: string; delta: string };
  setAdjustment: (value: { userId: string; delta: string }) => void;
  openAction: (action: PendingAction) => void;
}) {
  return (
    <div className="space-y-5">
      <div className="border border-white/10 bg-[rgb(18,18,18)] p-4">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_140px_auto]">
          <input
            className="h-10 border border-white/10 bg-black/30 px-3 text-sm outline-none focus:border-white/30"
            onChange={(event) => setAdjustment({ ...adjustment, userId: event.target.value })}
            placeholder="User ID"
            value={adjustment.userId}
          />
          <input
            className="h-10 border border-white/10 bg-black/30 px-3 text-sm outline-none focus:border-white/30"
            onChange={(event) => setAdjustment({ ...adjustment, delta: event.target.value })}
            placeholder="Delta"
            value={adjustment.delta}
          />
          <button
            className="inline-flex h-10 items-center justify-center gap-2 bg-white px-3 text-sm font-semibold text-black disabled:opacity-50"
            disabled={!adjustment.userId || !Number.isFinite(Number(adjustment.delta))}
            onClick={() =>
              openAction({
                title: `Adjust ledger ${adjustment.userId}`,
                endpoint: "/api/v1/admin/billing/adjustments",
                method: "POST",
                confirmText: "ADJUST",
                reasonRequired: true,
                body: (actionReason) => ({
                  userId: adjustment.userId,
                  delta: Number(adjustment.delta),
                  reason: actionReason,
                  confirmation: "ADJUST",
                }),
              })
            }
            type="button"
          >
            <BadgeDollarSign className="h-4 w-4" />
            Adjust
          </button>
        </div>
      </div>
      <DataTable
        columns={["id", "userId", "userEmail", "delta", "balanceAfter", "reason", "sourceId", "createdAt"]}
        rows={rows}
        title="Ledger"
      />
    </div>
  );
}

function AuditView({ rows }: { rows: Row[] }) {
  return (
    <DataTable
      columns={["id", "actorId", "actorRole", "action", "targetType", "targetId", "reason", "createdAt"]}
      rows={rows}
      title="Audit"
    />
  );
}

function DataTable({
  title,
  rows,
  columns,
  actions,
}: {
  title: string;
  rows: Row[];
  columns: string[];
  actions?: (row: Row) => React.ReactNode;
}) {
  return (
    <section className="overflow-hidden border border-white/10 bg-[rgb(18,18,18)]">
      <div className="flex h-11 items-center justify-between border-b border-white/10 px-4">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-xs text-[rgb(170,170,170)]">{rows.length}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] border-collapse text-left text-sm">
          <thead className="bg-black/20 text-[11px] uppercase text-[rgb(170,170,170)]">
            <tr>
              {columns.map((column) => (
                <th key={column} className="border-b border-white/10 px-3 py-2 font-semibold">
                  {column}
                </th>
              ))}
              {actions ? <th className="border-b border-white/10 px-3 py-2 font-semibold">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={`${stringValue(row.id) || stringValue(row.key) || title}-${index}`} className="border-b border-white/5 last:border-0">
                {columns.map((column) => (
                  <td key={column} className="max-w-[260px] px-3 py-2 align-top text-[rgb(230,230,230)]">
                    {renderCell(row[column])}
                  </td>
                ))}
                {actions ? <td className="px-3 py-2 align-top">{actions(row)}</td> : null}
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td className="px-3 py-8 text-center text-sm text-[rgb(170,170,170)]" colSpan={columns.length + (actions ? 1 : 0)}>
                  Empty
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Metric({ label, value, meta }: { label: string; value: string | number; meta: string }) {
  return (
    <div className="bg-[rgb(18,18,18)] p-4">
      <p className="text-xs font-medium text-[rgb(170,170,170)]">{label}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
      <p className="mt-1 text-xs text-[rgb(114,113,112)]">{meta}</p>
    </div>
  );
}

function IconAction({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className="inline-flex h-8 items-center gap-1 border border-white/10 px-2 text-xs text-[rgb(230,230,230)] hover:bg-white/10"
      onClick={onClick}
      title={label}
      type="button"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function filterSectionData(section: SectionData | null, query: string): SectionData | null {
  if (!section || !query.trim()) return section;
  const q = query.trim().toLowerCase();
  const filterRows = (rows: Row[]) =>
    rows.filter((row) => JSON.stringify(row).toLowerCase().includes(q));
  if (section.kind === "jobs") return { ...section, rows: filterRows(section.rows) };
  if (section.kind === "users") return { ...section, rows: filterRows(section.rows) };
  if (section.kind === "billing") return { ...section, rows: filterRows(section.rows) };
  if (section.kind === "audit") return { ...section, rows: filterRows(section.rows) };
  if (section.kind === "moderation") {
    return {
      ...section,
      reports: filterRows(section.reports),
      blockedMedia: filterRows(section.blockedMedia),
      appeals: filterRows(section.appeals),
    };
  }
  if (section.kind === "config") {
    return {
      ...section,
      data: {
        profiles: filterRows(section.data.profiles),
        templates: filterRows(section.data.templates),
        presets: filterRows(section.data.presets),
        flags: filterRows(section.data.flags),
      },
    };
  }
  return section;
}

function renderCell(value: unknown) {
  if (typeof value === "boolean") {
    return (
      <span className={cn("inline-flex items-center gap-1 text-xs", value ? "text-emerald-300" : "text-[rgb(170,170,170)]")}>
        {value ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
        {String(value)}
      </span>
    );
  }
  if (typeof value === "string") {
    if (value.includes("T") && value.endsWith("Z")) return compactDate(value);
    if (["active", "completed", "approved", "actioned"].includes(value)) return <Status value={value} tone="good" />;
    if (["failed", "blocked", "suspended", "removed", "refunded"].includes(value)) return <Status value={value} tone="bad" />;
    if (["draft", "queued", "pending", "open"].includes(value)) return <Status value={value} tone="warn" />;
    return <span className="break-words">{value}</span>;
  }
  if (typeof value === "number") return <span className="font-mono">{value}</span>;
  if (value === null || value === undefined) return <span className="text-[rgb(114,113,112)]">-</span>;
  return (
    <code className="block max-w-[260px] truncate text-xs text-[rgb(170,170,170)]">
      {JSON.stringify(value)}
    </code>
  );
}

function Status({ value, tone }: { value: string; tone: "good" | "bad" | "warn" }) {
  return (
    <span
      className={cn(
        "inline-flex rounded px-2 py-0.5 text-xs font-medium",
        tone === "good" && "bg-emerald-400/10 text-emerald-300",
        tone === "bad" && "bg-red-400/10 text-red-300",
        tone === "warn" && "bg-amber-400/10 text-amber-200",
      )}
    >
      {value}
    </span>
  );
}

function normalizeSection(value: string) {
  if (value === "generation/jobs") return value;
  if (value === "generation/config") return value;
  if (value === "moderation") return value;
  if (value === "users") return value;
  if (value === "billing") return value;
  if (value === "audit-log") return value;
  return "dashboard";
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function compactDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
