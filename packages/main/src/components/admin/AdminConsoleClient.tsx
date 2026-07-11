"use client";

import Link from "next/link";
import { ADMIN_PERMISSION_KEYS } from "@idream/shared/admin/permissions";
import { type FormEvent, type ReactNode, type WheelEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BadgeDollarSign,
  Ban,
  Bookmark,
  Check,
  ChevronRight,
  ClipboardCheck,
  ExternalLink,
  FileText,
  Flag,
  Inbox,
  Languages,
  Library,
  Loader2,
  MessageSquare,
  Plus,
  Play,
  RefreshCcw,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  UploadCloud,
  Workflow,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { apiDelete, apiForm, apiGet, apiWrite, formatApiError, type ApiEnvelope } from "@/components/admin/api";
import { BackendsView } from "@/components/admin/BackendsView";
import { GenerationMetricsView } from "@/components/admin/GenerationMetricsView";
import { WorkflowsView } from "@/components/admin/WorkflowsView";
import { OfficialSection } from "@/components/admin/official/OfficialSection";
import { StartersSection } from "@/components/admin/starters/StartersSection";
import { RecipesSection } from "@/components/admin/recipes/RecipesSection";
import { PresetsSection } from "@/components/admin/presets/PresetsSection";
import { AssetsSection } from "@/components/admin/assets/AssetsSection";
import { TagsView } from "@/components/admin/TagsView";
import { ReviewQueueView } from "@/components/admin/ReviewQueueView";
import { CmsView } from "@/components/admin/CmsView";
import { ComplianceView } from "@/components/admin/ComplianceView";
import { InsightsView } from "@/components/admin/InsightsView";
import { AnnouncementsView } from "@/components/admin/AnnouncementsView";
import { ExperimentsView } from "@/components/admin/ExperimentsView";
import { TodayView, type TodayData, type TodayLegacyData } from "@/components/admin/today/TodayView";
import type { MetricDashboardResponse, TodayProjection } from "@idream/shared/admin";
import { PlacementsSection } from "@/components/admin/placements/PlacementsSection";
import { ImageProductionView } from "@/components/admin/ImageProductionView";
import { OperatorFlow, type OperatorFlowItem } from "@/components/admin/generation/OperatorFlow";
import { FailureReason } from "@/components/admin/generation/FailureReason";
import { ReadonlyOpsView, type OpsColumn } from "@/components/admin/generation/ReadonlyOpsView";
import { EngineeringDetails } from "@/components/admin/generation/EngineeringDetails";
import {
  AdminI18nProvider,
  adminDateLocale,
  adminValueLabel,
  getStoredAdminLocale,
  storeAdminLocale,
  translateAdmin,
  type AdminLocale,
  useAdminI18n,
} from "@/components/admin/i18n";
import {
  navItems,
  parseAdminPath,
  configSliceForSection,
  defaultWorkModeForRole,
  navGroupsForPermissions,
  sectionIsPermitted,
  type AdminSubview,
  type ConfigSlice,
  type NavItem,
  type WorkMode,
} from "@/components/admin/nav-config";
import type { AdminShellSignals } from "@/components/admin/shell-signals";

type Actor = {
  id: string;
  role: string;
};

type AdminConsoleClientProps = {
  actor: Actor | null;
  initialSection: string;
  initialAccess: boolean;
  initialPermissions: string[];
  shellSignals: AdminShellSignals;
  // dev-only：展示退出按钮以便切换内置账号。
  devLogout?: boolean;
};

type Row = Record<string, unknown>;

type SavedView = {
  id: string;
  scope: string;
  label: string;
  filters: unknown;
  createdAt: string;
  updatedAt: string;
};

type SupportStatusFilter =
  | "all"
  | "active"
  | "received"
  | "open"
  | "waiting_on_user"
  | "resolved"
  | "closed";
type SupportSlaFilter = "all" | "overdue" | "due_soon" | "on_track" | "paused" | "closed";

type SupportRequestFilters = {
  query: string;
  status: SupportStatusFilter;
  sla: SupportSlaFilter;
  category: string;
};

type PlaintextTargetType = "generation_job" | "media";

type PlaintextAccessDraft = {
  targetType: PlaintextTargetType;
  targetId: string;
  ticketId: string;
  legalHoldId: string;
  reason: string;
  confirmation: string;
};

type PlaintextAccessResult = {
  target: {
    type: PlaintextTargetType;
    id: string;
    ownerId: string;
  };
  plaintext: Record<string, string | null>;
  authorization: {
    ticketId: string | null;
    legalHoldId: string | null;
  };
};

type DashboardData = TodayData;

type ConfigData = {
  profiles: Row[];
  flags: Row[];
  recentJobs: Row[];
};

type ConfigTab = "profiles" | "settings";

type ReconciliationData = {
  window: { from: string; to: string };
  activeSubscriptions: number;
  byReason: Row[];
  totals: { net: number; entries: number };
};

type AnalyticsData = {
  window: { from: string; to: string };
  funnel: {
    signups: number;
    activatedUsers: number | null;
    payingUsers: number;
    conversionRate: number | null;
    qualityState?: "certified" | "directional" | "invalid" | "stale";
  };
  generation: { total: number; completed: number; failed: number; blocked: number };
  economy: { coinsGranted: number; coinsSpent: number; net: number; byReason: Row[] };
  topEvents: Row[];
};

type AnalyticsWorkspaceData = {
  legacy: AnalyticsData;
  canonical: MetricDashboardResponse;
};

type AbuseData = {
  window: { from: string; to: string };
  deviceClusters: Row[];
  referralAbuse: Row[];
  adjustAnomalies: Row[];
};

type ProviderOpsData = {
  window: { from: string; to: string };
  providers: Row[];
};

type ChatOpsDiagnostics = {
  reason?: string;
  status?: number;
  serviceUrlConfigured: boolean;
};

type ChatOpsFilters = {
  userId: string;
  characterId: string;
  sessionStatus: string;
  eventStatus: string;
  eventLayer: string;
  policyCode: string;
  targetId: string;
  limit: string;
};

type SectionData =
  | { kind: "dashboard"; data: DashboardData }
  | { kind: "jobs"; rows: Row[] }
  | { kind: "config"; data: ConfigData; slice: ConfigSlice }
  | { kind: "moderation"; reports: Row[]; blockedMedia: Row[]; appeals: Row[] }
  | { kind: "users"; rows: Row[] }
  | { kind: "billing"; rows: Row[]; subscriptions: Row[]; reconciliation: ReconciliationData }
  | { kind: "pricing"; rows: Row[] }
  | { kind: "deadletter"; rows: Row[] }
  | { kind: "analytics"; data: AnalyticsWorkspaceData }
  | { kind: "risk"; data: AbuseData }
  | { kind: "providers"; data: ProviderOpsData }
  | { kind: "content"; characters: Row[]; featured: Row[]; featuredIds: string[] }
  | { kind: "promo"; codes: Row[]; referrals: Row[] }
  | { kind: "support"; rows: Row[] }
  | { kind: "approvals"; rows: Row[] }
  // 自取数视图（组件内部 fetch），section 只需一个标记，不在此预取数据。
  | {
      kind: "selfFetch";
      view:
        | "official"
        | "production"
        | "assets"
        | "placements"
        | "templates"
        | "recipes"
        | "presets"
        | "tags"
        | "review-queue"
        | "cms"
        | "compliance"
        | "insights"
        | "announcements"
        | "experiments"
        | "backends"
        | "workflows"
        | "generation-metrics";
    }
  | {
      kind: "chatops";
      configured: boolean;
      diagnostics: ChatOpsDiagnostics | null;
      overview: Record<string, unknown> | null;
      providerHealth: Row[];
      sessions: Row[];
      usage: Row[];
      events: Row[];
    }
  | { kind: "audit"; rows: Row[] };

type PendingAction = {
  title: string;
  endpoint: string;
  method: "POST" | "PATCH";
  confirmText: string;
  reasonRequired: boolean;
  review?: "image_consistency";
  verification?: ProfileVerificationSummary;
  body: (
    reason: string,
    confirmation: string,
    review?: ActionReviewDraft,
  ) => Record<string, unknown>;
};

type ActionReviewDraft = {
  sampleCount: string;
  passCount: string;
  reviewUrl: string;
  notes: string;
};

type ProfileVerificationSummary = {
  status: string;
  tone: "good" | "bad" | "warn";
  meta: string;
  failureMode: string;
  blockedReason: string;
  components: Array<{ key: string; status: string; tone: "good" | "bad" | "warn" }>;
};

type ModelDraft = {
  profileTemplate: ModelProfileTemplateId;
  profileKey: string;
  label: string;
  mode: "image" | "video";
  runner: "pipeline" | "sd_cpp" | "mlx" | "comfyui" | "external";
  pipelineModel: string;
  sourceModelPath: string;
  convertedModelPath: string;
  modelFormat: "safetensors" | "gguf" | "diffusers" | "external";
  diffusionModelPath: string;
  llmPath: string;
  vaePath: string;
  llmVisionPath: string;
  backend: string;
  conversionEnabled: boolean;
  conversionType: string;
  conversionSourceArg: "model" | "diffusion-model";
  loraModelDir: string;
  loraApplyMode: "auto" | "immediately" | "at_runtime";
  lorasJson: string;
  defaultWidth: string;
  defaultHeight: string;
  allowedOrientations: string;
  steps: string;
  sampler: string;
  scheduler: string;
  cfgScale: string;
  costMultiplier: string;
  requiredEntitlement: string;
  maxCount: string;
  runnerConfigJson: string;
};

type ModelProfileTemplateId =
  | "text_identity_sdcpp"
  | "reference_identity_sdcpp"
  | "reference_identity_comfyui"
  | "advanced_custom";

type ModelImportKind = "model" | "lora" | "llm" | "vae";

type ModelImportAsset = {
  kind: ModelImportKind;
  name: string;
  path: string;
  format: "safetensors" | "gguf";
  sizeBytes: number;
  modifiedAt: string;
  draftPatch: Record<string, unknown>;
};

type ModelImportLibrary = {
  roots: Record<string, string>;
  maxUploadBytes: number;
  items: ModelImportAsset[];
};

type ModelImportResult = {
  asset?: ModelImportAsset;
  assets?: ModelImportAsset[];
  roots: Record<string, string>;
};

type GenerationJobDetail = {
  job: Row;
  user: Row | null;
  character: Row | null;
  assets: Row[];
  providerError: Row | null;
  ledger: Row[];
  timeline: Array<{
    at: string;
    type: string;
    message: string;
    metadata?: unknown;
  }>;
};

type LoraDraft = {
  key: string;
  path: string;
  fileName?: string;
  weight: number;
  enabled: boolean;
};

type PricingDraft = {
  ruleKey: string;
  label: string;
  mode: "image" | "video" | "voice";
  baseCost: string;
  multiplier: string;
  reason: string;
  confirmation: string;
};

type PermissionForm = {
  userId: string;
  permissionKey: string;
  effect: "grant" | "revoke" | "clear";
};

const textIdentityCapabilities = {
  textToImage: true,
  stableSeed: true,
  referenceImages: false,
  initImage: false,
  lora: false,
} satisfies Record<string, boolean>;

const referenceIdentityCapabilities = {
  textToImage: true,
  stableSeed: true,
  referenceImages: true,
  initImage: true,
  lora: false,
} satisfies Record<string, boolean>;

const comfyReferenceIdentityCapabilities = {
  textToImage: false,
  stableSeed: true,
  referenceImages: true,
  initImage: true,
  lora: false,
} satisfies Record<string, boolean>;

const modelProfileTemplates: Array<{
  id: ModelProfileTemplateId;
  label: string;
  description: string;
  intent: string;
}> = [
  {
    id: "text_identity_sdcpp",
    label: "Text identity template",
    description: "CVP identity prompt + stable seed. No reference image is sent.",
    intent: "text_to_image_identity_seed",
  },
  {
    id: "reference_identity_sdcpp",
    label: "Reference identity template",
    description: "Reference-image candidate for sd.cpp-compatible runners; publish only after reference smoke.",
    intent: "image_to_image_identity_reference",
  },
  {
    id: "reference_identity_comfyui",
    label: "ComfyUI reference template",
    description: "Reference-image candidate for external ComfyUI workflows.",
    intent: "comfyui_reference_identity",
  },
  {
    id: "advanced_custom",
    label: "Advanced custom profile",
    description: "Full runner control for model operations.",
    intent: "advanced_custom",
  },
];
const fallbackModelProfileTemplate = modelProfileTemplates[0]!;

const defaultPricingDraft: PricingDraft = {
  ruleKey: "generation_image_default",
  label: "Image generation default",
  mode: "image",
  baseCost: "5",
  multiplier: "1",
  reason: "",
  confirmation: "",
};

const defaultPermissionForm: PermissionForm = {
  userId: "",
  permissionKey: "billing.ledger.adjust",
  effect: "grant",
};

const defaultChatOpsFilters: ChatOpsFilters = {
  userId: "",
  characterId: "",
  sessionStatus: "active",
  eventStatus: "all",
  eventLayer: "all",
  policyCode: "",
  targetId: "",
  limit: "50",
};

const SUPPORT_REQUEST_SAVED_VIEW_SCOPE = "support.requests";
const defaultSupportRequestFilters: SupportRequestFilters = {
  query: "",
  status: "all",
  sla: "all",
  category: "",
};
const defaultPlaintextAccessDraft: PlaintextAccessDraft = {
  targetType: "generation_job",
  targetId: "",
  ticketId: "",
  legalHoldId: "",
  reason: "",
  confirmation: "",
};
const plaintextTargetTypeOptions: Array<{
  value: PlaintextTargetType;
  label: string;
  fields: string;
}> = [
  { value: "generation_job", label: "Generation job", fields: "prompt, negativePrompt" },
  { value: "media", label: "Media asset", fields: "prompt" },
];
const supportStatusOptions: Array<{ value: SupportStatusFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active support" },
  { value: "received", label: "received" },
  { value: "open", label: "open" },
  { value: "waiting_on_user", label: "waiting_on_user" },
  { value: "resolved", label: "resolved" },
  { value: "closed", label: "closed" },
];
const supportSlaOptions: Array<{ value: SupportSlaFilter; label: string }> = [
  { value: "all", label: "All SLA" },
  { value: "overdue", label: "overdue" },
  { value: "due_soon", label: "due_soon" },
  { value: "on_track", label: "on_track" },
  { value: "paused", label: "paused" },
  { value: "closed", label: "closed" },
];

const samplerOptions = [
  { value: "euler", label: "Euler", aliases: ["euler"] },
  { value: "euler_a", label: "Euler a", aliases: ["euler a", "euler_a", "euler ancestral"] },
  { value: "heun", label: "Heun", aliases: ["heun"] },
  { value: "dpm2", label: "DPM2", aliases: ["dpm2"] },
  { value: "dpm++2s_a", label: "DPM++ 2S a", aliases: ["dpm++ 2s a", "dpmpp 2s a", "dpmpp_2s_a"] },
  {
    value: "dpm++2m",
    label: "DPM++ 2M",
    aliases: [
      "dpm++ 2m",
      "dpmpp 2m",
      "dpmpp_2m",
      "dpm++ 2m sde",
      "dpmpp 2m sde",
      "dpmpp_2m_sde",
      "dpm++ 3m sde",
      "dpmpp 3m sde",
      "dpmpp_3m_sde",
    ],
  },
  { value: "dpm++2mv2", label: "DPM++ 2M v2", aliases: ["dpm++ 2m v2", "dpmpp 2m v2", "dpmpp_2mv2"] },
  { value: "ipndm", label: "IPNDM", aliases: ["ipndm"] },
  { value: "ipndm_v", label: "IPNDM v", aliases: ["ipndm v", "ipndm_v"] },
  { value: "lcm", label: "LCM", aliases: ["lcm"] },
  { value: "ddim_trailing", label: "DDIM trailing", aliases: ["ddim trailing", "ddim_trailing", "ddim"] },
  { value: "tcd", label: "TCD", aliases: ["tcd"] },
  { value: "res_multistep", label: "Res multistep", aliases: ["res multistep", "res_multistep"] },
  { value: "res_2s", label: "Res 2S", aliases: ["res 2s", "res_2s"] },
  { value: "er_sde", label: "ER_SDE", aliases: ["er_sde", "er sde", "dpmpp_sde"] },
  {
    value: "euler_cfg_pp",
    label: "Euler CFG++",
    aliases: ["euler cfg pp", "euler_cfg_pp"],
  },
  {
    value: "euler_a_cfg_pp",
    label: "Euler a CFG++",
    aliases: ["euler a cfg pp", "euler_a_cfg_pp"],
  },
];

const schedulerOptions = [
  { value: "model_default", label: "Model default", aliases: ["model default", "model-specific", "model specific"] },
  { value: "discrete", label: "Discrete", aliases: ["discrete"] },
  { value: "karras", label: "Karras", aliases: ["karras"] },
  { value: "exponential", label: "Exponential", aliases: ["exponential"] },
  { value: "ays", label: "AYS", aliases: ["ays"] },
  { value: "gits", label: "GITS", aliases: ["gits"] },
  { value: "smoothstep", label: "Smoothstep", aliases: ["smoothstep"] },
  { value: "sgm_uniform", label: "SGM Uniform", aliases: ["sgm uniform", "sgm_uniform"] },
  { value: "simple", label: "Simple", aliases: ["simple"] },
  { value: "kl_optimal", label: "KL Optimal", aliases: ["kl optimal", "kl_optimal"] },
  { value: "lcm", label: "LCM", aliases: ["lcm"] },
  { value: "bong_tangent", label: "Bong Tangent", aliases: ["bong tangent", "bong_tangent"] },
  { value: "ltx2", label: "LTX2", aliases: ["ltx2"] },
  { value: "logit_normal", label: "Logit Normal", aliases: ["logit normal", "logit_normal"] },
];

// SPEC: localStorage key for which folded sidebar nav groups the operator last expanded.
const NAV_GROUPS_STORAGE_KEY = "idream.admin.openNavGroups";
const WORK_MODE_STORAGE_KEY = "idream.admin.workMode";
const WORK_MODE_OPTIONS: Array<{ value: WorkMode; label: string }> = [
  { value: "admin", label: "Admin" },
  { value: "character_producer", label: "Character producer" },
  { value: "creative_operator", label: "Creative operator" },
  { value: "platform_ops", label: "Platform ops" },
  { value: "support", label: "Support" },
  { value: "moderator", label: "Moderator" },
  { value: "growth_analyst", label: "Growth analyst" },
];

export function AdminConsoleClient({
  actor,
  initialSection,
  initialAccess,
  initialPermissions,
  shellSignals,
  devLogout = false,
}: AdminConsoleClientProps) {
  const sidebarNavRef = useRef<HTMLElement | null>(null);
  const { sectionId, view: subview } = parseAdminPath(initialSection);
  const activeItem = navItems.find((item) => item.id === sectionId) ?? navItems[0];
  const permissions = useMemo(() => new Set(initialPermissions), [initialPermissions]);
  const canAccessActiveSection = sectionIsPermitted(sectionId, permissions);
  const [workMode, setWorkMode] = useState<WorkMode>(() => defaultWorkModeForRole(actor?.role));
  const navGroups = useMemo(
    () => navGroupsForPermissions(permissions, workMode),
    [permissions, workMode],
  );
  const [data, setData] = useState<SectionData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [actionReview, setActionReview] = useState<ActionReviewDraft>({
    sampleCount: "",
    passCount: "",
    reviewUrl: "",
    notes: "",
  });
  const [actionBusy, setActionBusy] = useState(false);
  const [adjustment, setAdjustment] = useState({ userId: "", delta: "" });
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [pricingDraft, setPricingDraft] = useState<PricingDraft>(defaultPricingDraft);
  const [pricingBusy, setPricingBusy] = useState(false);
  const [permissionForm, setPermissionForm] = useState<PermissionForm>(defaultPermissionForm);
  const [chatOpsFilters, setChatOpsFilters] = useState<ChatOpsFilters>(defaultChatOpsFilters);
  const [locale, setLocale] = useState<AdminLocale>("en");
  const [localeReady, setLocaleReady] = useState(false);
  const t = (key: string, values?: Record<string, string | number>) =>
    translateAdmin(locale, key, values);

  const filteredData = useMemo(() => filterSectionData(data, query), [data, query]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setLocale(getStoredAdminLocale());
      setLocaleReady(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!localeReady) return;
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
    storeAdminLocale(locale);
  }, [locale, localeReady]);

  useEffect(() => {
    if (actor?.role !== "admin") return;
    const frame = window.requestAnimationFrame(() => {
      try {
        const stored = window.localStorage.getItem(WORK_MODE_STORAGE_KEY) as WorkMode | null;
        if (WORK_MODE_OPTIONS.some((option) => option.value === stored)) setWorkMode(stored ?? "admin");
      } catch {
        // Storage is a preference only; authorization is always server-derived.
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [actor?.role]);

  async function load(nextChatOpsFilters: ChatOpsFilters = chatOpsFilters, nextWorkMode: WorkMode = workMode) {
    if (!initialAccess || !canAccessActiveSection) return;
    setLoading(true);
    setError(null);
    try {
      setData(await fetchSection(sectionId, { chatOps: nextChatOpsFilters, workMode: nextWorkMode }));
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
  }, [sectionId, initialAccess, canAccessActiveSection]);

  function openAction(action: PendingAction) {
    setReason("");
    setConfirmation("");
    setActionReview({ sampleCount: "", passCount: "", reviewUrl: "", notes: "" });
    setActionStatus(null);
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
        body: JSON.stringify(pendingAction.body(reason, confirmation, actionReview)),
      });
      const payload = (await response.json()) as ApiEnvelope<unknown>;
      if (!payload.ok) {
        throw new Error(formatApiError(payload.error, "Admin action failed"));
      }
      const completedEndpoint = pendingAction.endpoint;
      const completedTitle = pendingAction.title;
      setPendingAction(null);
      setActionStatus(`${completedTitle} completed.`);
      if (completedEndpoint === "/api/v1/admin/billing/adjustments") {
        setAdjustment({ userId: "", delta: "" });
      }
      await load();
    } catch (actionError) {
      setActionStatus(null);
      setError(actionError instanceof Error ? actionError.message : "Admin action failed");
    } finally {
      setActionBusy(false);
    }
  }

  async function createPricingRule() {
    setPricingBusy(true);
    setError(null);
    try {
      await apiWrite("/api/v1/admin/pricing/rules", "POST", pricingDraftPayload(pricingDraft));
      setPricingDraft({ ...pricingDraft, reason: "", confirmation: "" });
      await load();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Pricing rule create failed");
    } finally {
      setPricingBusy(false);
    }
  }

  // SPEC: which folded nav groups are expanded; default all-collapsed (progressive
  // disclosure), persisted so an operator's expanded groups survive a reload.
  // INTENT: a group holding the active item is auto-revealed at render time
  // (see sidebar JSX below) without mutating this persisted set.
  // SSR-safe: server + first client hydrate render all-collapsed (empty set); the saved
  // expansion is read from localStorage only after mount (mirrors the `locale` pattern
  // above), so a returning user with expanded groups can't cause a hydration mismatch.
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try {
        const raw = window.localStorage.getItem(NAV_GROUPS_STORAGE_KEY);
        if (raw) setOpenGroups(new Set(JSON.parse(raw) as string[]));
      } catch {
        /* ignore */
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  const toggleGroup = useCallback((group: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      try {
        window.localStorage.setItem(NAV_GROUPS_STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const handleSidebarWheel = useCallback((event: WheelEvent<HTMLElement>) => {
    if (event.ctrlKey) return;

    const nav = sidebarNavRef.current;
    if (!nav) return;

    const maxScrollTop = nav.scrollHeight - nav.clientHeight;
    if (maxScrollTop <= 0) return;

    const deltaY =
      event.deltaMode === 1
        ? event.deltaY * 16
        : event.deltaMode === 2
          ? event.deltaY * nav.clientHeight
          : event.deltaY;

    if (deltaY === 0) return;

    nav.scrollTop = Math.max(0, Math.min(maxScrollTop, nav.scrollTop + deltaY));
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const pendingVerification = pendingAction?.verification;
  const pendingVerificationBlocked = Boolean(pendingVerification?.blockedReason);

  if (!actor || !initialAccess) {
    return (
      <main className="min-h-screen bg-[var(--ad-canvas)] px-6 py-8 text-[var(--ad-ink)]">
        <div className="mx-auto max-w-xl rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-6">
          <div className="flex items-center gap-3">
            <Ban className="h-5 w-5 text-[var(--ad-red-text)]" />
            <h1 className="text-lg font-semibold">{t("Admin access denied")}</h1>
          </div>
          <p className="mt-3 text-sm text-[var(--ad-text-muted)]">
            {t("Signed-in internal roles only.")}
          </p>
        </div>
      </main>
    );
  }

  return (
    <AdminI18nProvider locale={locale}>
    <main className="min-h-screen bg-[var(--ad-canvas)] text-[var(--ad-ink)]">
      <div className="flex min-h-screen">
        <aside
          className="sticky top-0 hidden h-screen w-[248px] shrink-0 overflow-hidden border-r border-[var(--ad-border)] bg-[var(--ad-surface)] lg:flex lg:flex-col"
          onWheel={handleSidebarWheel}
        >
          <div className="flex h-14 shrink-0 items-center border-b border-[var(--ad-border)] px-5">
            <div>
              <p className="text-sm font-semibold">iDream Admin</p>
              <p className="text-[11px] text-[var(--ad-text-muted)]">{actor.role}</p>
            </div>
          </div>
          <nav ref={sidebarNavRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
            {navGroups.map(({ group, items }, groupIndex) => {
              if (group === "Today") {
                return (
                  <div className="pb-2" key={group}>
                    {items.map((item) => (
                      <NavLink active={item.id === sectionId} item={item} key={item.id} />
                    ))}
                  </div>
                );
              }
              // Progressive disclosure: collapsed unless the operator opened it, or
              // it holds the active item (auto-revealed without persisting the toggle).
              const forcedOpen = activeItem.group === group;
              const open = openGroups.has(group) || forcedOpen;
              return (
                <div className={cn(groupIndex === 1 && "border-t border-[var(--ad-border)] pt-3")} key={group}>
                    <button
                      aria-disabled={forcedOpen}
                      aria-expanded={open}
                      className={cn(
                        "flex h-9 w-full items-center justify-between gap-2 rounded-md px-3 text-[10px] font-semibold uppercase tracking-normal text-[var(--ad-text-muted)] transition-colors hover:bg-black/[0.04] hover:text-[var(--ad-ink)]",
                        forcedOpen && "cursor-default hover:bg-transparent hover:text-[var(--ad-text-muted)]",
                      )}
                      onClick={forcedOpen ? undefined : () => toggleGroup(group)}
                      type="button"
                    >
                      <span>{t(group)}</span>
                      <ChevronRight
                        className={cn("h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-90")}
                      />
                    </button>
                    {open
                      ? items.map((item) => (
                          <NavLink active={item.id === sectionId} item={item} key={item.id} />
                        ))
                      : null}
                </div>
              );
            })}
          </nav>
        </aside>

        <section className="min-w-0 flex-1">
          <header className="sticky top-0 z-20 border-b border-[var(--ad-border)] bg-[rgba(247,246,243,0.92)] backdrop-blur">
            <div className="grid gap-3 px-4 py-3 md:px-6 lg:flex lg:min-h-14 lg:items-center">
              <div className="min-w-0">
                <h1 className="text-base font-semibold md:text-lg">{t(activeItem.label)}</h1>
                <p className="truncate text-[11px] text-[var(--ad-text-muted)]">{actor.id} · {t(workModeLabel(workMode))}</p>
              </div>
              <div className="grid gap-2 sm:grid-cols-[1fr_auto] lg:ml-auto lg:flex lg:items-center">
                <div className="flex h-9 min-w-0 items-center gap-2 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 lg:w-[260px]">
                  <Search className="h-4 w-4 shrink-0 text-[var(--ad-text-muted)]" />
                  <input
                    aria-label={t("Filter")}
                    className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--ad-text-muted)]"
                    name="admin-filter"
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t("Filter")}
                    value={query}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {actor.role === "admin" ? (
                    <label className="inline-flex h-9 items-center gap-2 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm text-[var(--ad-text)]">
                      <span className="sr-only">{t("Work mode")}</span>
                      <select
                        aria-label={t("Work mode")}
                        className="h-full bg-transparent text-sm outline-none"
                        onChange={(event) => {
                          const nextMode = event.target.value as WorkMode;
                          setWorkMode(nextMode);
                          if (sectionId === "dashboard") void load(chatOpsFilters, nextMode);
                          try {
                            window.localStorage.setItem(WORK_MODE_STORAGE_KEY, nextMode);
                          } catch {
                            // Preference persistence failure must not affect authorization.
                          }
                        }}
                        value={workMode}
                      >
                        {WORK_MODE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>{t(option.label)}</option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  <label className="inline-flex h-9 items-center gap-2 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm text-[var(--ad-text)]">
                    <Languages className="h-4 w-4 text-[var(--ad-text-muted)]" />
                    <span className="sr-only">{t("Language")}</span>
                    <select
                      aria-label={t("Language")}
                      className="h-full bg-transparent text-sm outline-none"
                      name="admin-language"
                      onChange={(event) => setLocale(event.target.value as AdminLocale)}
                      value={locale}
                    >
                      <option value="en">English</option>
                      <option value="zh">中文</option>
                    </select>
                  </label>
                  <button
                    className="inline-flex h-9 items-center gap-2 rounded-md border border-[var(--ad-border)] px-3 text-sm text-[var(--ad-text)] hover:bg-black/[0.04]"
                    onClick={() => void load()}
                    type="button"
                  >
                    {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
                    {t("Refresh")}
                  </button>
                  {devLogout ? (
                    <button
                      className="inline-flex h-9 items-center gap-2 rounded-md border border-[var(--ad-border)] px-3 text-sm text-[var(--ad-text-muted)] hover:bg-black/[0.04]"
                      onClick={async () => {
                        await fetch("/api/admin-auth/logout", { method: "POST" });
                        window.location.reload();
                      }}
                      type="button"
                    >
                      {t("Logout")}
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
            <ShellSignalBar signals={shellSignals} />
            <nav className="flex gap-2 overflow-x-auto border-t border-[var(--ad-border)] px-4 py-2 md:px-6 lg:hidden">
              {navGroups.flatMap((group) => group.items).map((item) => {
                const Icon = item.icon;
                const active = item.id === sectionId;
                return (
                  <Link
                    className={cn(
                      "inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-[var(--ad-border)] px-3 text-xs font-medium text-[var(--ad-text-muted)]",
                      active && "bg-[var(--ad-ink)] text-white",
                    )}
                    href={item.href}
                    key={item.id}
                  >
                    <Icon className="h-4 w-4" />
                    {t(item.label)}
                  </Link>
                );
              })}
            </nav>
          </header>

          <div className="p-4 md:p-6">
            {error ? (
              <div
                aria-live="assertive"
                className="mb-4 rounded-lg border border-[var(--ad-red-text)]/20 bg-[var(--ad-red-bg)] px-4 py-3 text-sm text-[var(--ad-red-text)]"
                role="alert"
              >
                {error}
              </div>
            ) : null}
            {actionStatus ? (
              <div
                aria-live="polite"
                className="mb-4 rounded-lg border border-[var(--ad-green-text)]/20 bg-[var(--ad-green-bg)] px-4 py-3 text-sm text-[var(--ad-green-text)]"
                data-testid="admin-action-status"
                role="status"
              >
                {actionStatus}
              </div>
            ) : null}
            {!canAccessActiveSection ? (
              <section
                aria-labelledby="admin-section-denied-title"
                className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-6"
                data-testid="admin-section-permission-denied"
              >
                <div className="flex items-center gap-3">
                  <Ban className="h-5 w-5 text-[var(--ad-red-text)]" />
                  <h2 className="text-base font-semibold" id="admin-section-denied-title">{t("No permission for this workspace")}</h2>
                </div>
                <p className="mt-2 text-sm text-[var(--ad-text-muted)]">
                  {t("Your effective permission keys do not include this capability. Navigation updates after a permission change and refresh.")}
                </p>
              </section>
            ) : loading && !filteredData ? (
              <div className="flex h-48 items-center justify-center text-[var(--ad-text-muted)]">
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                {t("Loading")}
              </div>
            ) : (
              renderSection(filteredData, subview, {
                openAction,
                adjustment,
                setAdjustment,
                selectedProfileId,
                setSelectedProfileId,
                pricingDraft,
                setPricingDraft,
                pricingBusy,
                createPricingRule,
                permissionForm,
                setPermissionForm,
                chatOpsFilters,
                setChatOpsFilters,
                applyChatOpsFilters: (next) => {
                  setChatOpsFilters(next);
                  void load(next);
                },
                reload: () => void load(),
                permissions,
                workMode,
              })
            )}
          </div>
        </section>
      </div>

      {pendingAction ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-md rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-5 shadow-2xl">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold">{pendingAction.title}</h2>
              <button
                aria-label="Close"
                className="grid h-8 w-8 place-items-center rounded-md hover:bg-black/[0.04]"
                onClick={() => setPendingAction(null)}
                type="button"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-4 space-y-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-[var(--ad-text-muted)]">{t("Reason")}</span>
                <textarea
                  className="min-h-20 w-full resize-y rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 py-2 text-sm text-[var(--ad-text)] outline-none focus:border-[var(--ad-ink)]"
                  onChange={(event) => setReason(event.target.value)}
                  value={reason}
                />
              </label>
              {pendingAction.review === "image_consistency" ? (
                <div className="rounded-lg border border-[var(--ad-border)] bg-black/[0.03] p-3">
                  <div className="mb-3">
                    <h3 className="text-sm font-semibold">{t("Image consistency review")}</h3>
                    <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">
                      {t("Publish needs at least 20 reviewed image samples and 80% identity consistency.")}
                    </p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FormField
                      label="Reviewed samples"
                      onChange={(value) => setActionReview({ ...actionReview, sampleCount: value })}
                      value={actionReview.sampleCount}
                    />
                    <FormField
                      label="Consistent samples"
                      onChange={(value) => setActionReview({ ...actionReview, passCount: value })}
                      value={actionReview.passCount}
                    />
                  </div>
                  <div className="mt-3 space-y-3">
                    <FormField
                      label="Review URL"
                      onChange={(value) => setActionReview({ ...actionReview, reviewUrl: value })}
                      value={actionReview.reviewUrl}
                    />
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-[var(--ad-text-muted)]">
                        {t("Review notes")}
                      </span>
                      <textarea
                        className="min-h-16 w-full resize-y rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 py-2 text-sm text-[var(--ad-text)] outline-none focus:border-[var(--ad-ink)]"
                        onChange={(event) => setActionReview({ ...actionReview, notes: event.target.value })}
                        value={actionReview.notes}
                      />
                    </label>
                    <p className="text-xs text-[var(--ad-text-muted)]">
                      {t("Consistency rate")}: {formatPercent(consistencyRateFromReview(actionReview))}
                    </p>
                  </div>
                </div>
              ) : null}
              {pendingVerification ? (
                <div
                  className={cn(
                    "rounded-lg border p-3",
                    pendingVerificationBlocked
                      ? "border-[var(--ad-red-text)]/20 bg-[var(--ad-red-bg)]"
                      : "border-[var(--ad-border)] bg-black/[0.03]",
                  )}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold">{t("Model verification")}</h3>
                    <Status locale={locale} value={pendingVerification.status} tone={pendingVerification.tone} />
                  </div>
                  <p className="mt-2 text-xs leading-5 text-[var(--ad-text-muted)]">
                    {t(pendingVerification.meta)}
                  </p>
                  {pendingVerification.failureMode ? (
                    <p className="mt-2 break-all text-xs leading-5 text-[var(--ad-red-text)]">
                      {t("Failure mode")}: {pendingVerification.failureMode}
                    </p>
                  ) : null}
                  {pendingVerification.blockedReason ? (
                    <p className="mt-2 text-xs leading-5 text-[var(--ad-red-text)]">
                      {t(pendingVerification.blockedReason)}
                    </p>
                  ) : null}
                  {pendingVerification.components.length > 0 ? (
                    <div className="mt-3 space-y-1">
                      {pendingVerification.components.slice(0, 5).map((component) => (
                        <div
                          className="flex min-w-0 items-center justify-between gap-2 text-xs"
                          key={component.key}
                        >
                          <span className="min-w-0 truncate text-[var(--ad-text-muted)]">{component.key}</span>
                          <Status locale={locale} value={component.status} tone={component.tone} />
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-[var(--ad-text-muted)]">
                  {t("Confirmation")}
                </span>
                <input
                  className="h-10 w-full rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 font-mono text-sm text-[var(--ad-text)] outline-none focus:border-[var(--ad-ink)]"
                  onChange={(event) => setConfirmation(event.target.value)}
                  value={confirmation}
                />
              </label>
              <div className="rounded-lg border border-[var(--ad-border)] bg-black/[0.03] px-3 py-2 font-mono text-xs text-[var(--ad-text)]">
                {pendingAction.confirmText}
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                className="h-9 rounded-md border border-[var(--ad-border)] px-3 text-sm text-[var(--ad-text)] hover:bg-black/[0.04]"
                onClick={() => setPendingAction(null)}
                type="button"
              >
                {t("Cancel")}
              </button>
              <button
                className="inline-flex h-9 items-center gap-2 rounded-md bg-[var(--ad-ink)] px-3 text-sm font-semibold text-white disabled:opacity-50"
                disabled={
                  actionBusy ||
                  confirmation !== pendingAction.confirmText ||
                  (pendingAction.reasonRequired && reason.trim().length < 3) ||
                  !actionReviewComplete(pendingAction, actionReview) ||
                  pendingVerificationBlocked
                }
                onClick={() => void submitAction()}
                type="button"
              >
                {actionBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                {t("Confirm")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
    </AdminI18nProvider>
  );
}

function ShellSignalBar({ signals }: { signals: AdminShellSignals }) {
  const { t } = useAdminI18n();
  const signalItems = [
    { key: "environment", label: "Environment", value: signals.environment },
    { key: "data-class", label: "Data class", value: signals.dataClass },
    { key: "fixtures", label: "Fixtures", value: signals.fixtureState },
    { key: "timezone", label: "Product timezone", value: signals.productTimezone },
    { key: "freshness", label: "Freshness", value: signals.freshness.label },
  ];

  return (
    <div
      aria-label={t("Data provenance")}
      className="flex gap-2 overflow-x-auto border-t border-[var(--ad-border)] px-4 py-2 md:px-6"
      data-testid="admin-shell-signals"
      role="status"
    >
      {signalItems.map((signal) => (
        <span
          className="shrink-0 rounded-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-2.5 py-1 text-[10px] text-[var(--ad-text-muted)]"
          data-signal={signal.key}
          key={signal.key}
        >
          <span className="font-semibold uppercase">{t(signal.label)}</span>{" "}
          <span className="text-[var(--ad-ink)]">{t(signal.value)}</span>
        </span>
      ))}
    </div>
  );
}

function workModeLabel(mode: WorkMode) {
  return WORK_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? "Admin";
}

// SPEC: shared sidebar link markup for both the pinned daily section and the
// folded groups, so the two render paths (and any future ones) can't drift apart.
function NavLink({ active, item }: { active: boolean; item: NavItem }) {
  const { t } = useAdminI18n();
  const Icon = item.icon;

  return (
    <Link
      className={cn(
        "mb-1 flex h-10 items-center gap-3 rounded-md px-3 text-[13px] font-medium text-[var(--ad-text-muted)] transition-colors hover:bg-black/[0.04] hover:text-[var(--ad-ink)]",
        active && "bg-black/[0.05] text-[var(--ad-ink)]",
      )}
      href={item.href}
    >
      <Icon className="h-4 w-4" />
      <span>{t(item.label)}</span>
      {active ? <ChevronRight className="ml-auto h-4 w-4" /> : null}
    </Link>
  );
}

async function fetchGenerationConfig(): Promise<ConfigData> {
  const [profiles, flags, jobs] = await Promise.all([
    apiGet<{ items: Row[] }>("/api/v1/admin/generation/model-profiles"),
    apiGet<{ items: Row[] }>("/api/v1/admin/feature-flags"),
    apiGet<{ items: Row[] }>("/api/v1/admin/generation/jobs?mode=image&limit=12"),
  ]);
  return {
    profiles: profiles.items,
    flags: flags.items,
    recentJobs: jobs.items,
  };
}

async function fetchSection(
  sectionId: string,
  options: { chatOps?: ChatOpsFilters; workMode?: WorkMode } = {},
): Promise<SectionData> {
  if (sectionId === "generation/jobs") {
    const payload = await apiGet<{ items: Row[] }>("/api/v1/admin/generation/jobs?mode=image");
    return { kind: "jobs", rows: payload.items };
  }
  if (sectionId === "generation/dead-letter") {
    const payload = await apiGet<{ items: Row[] }>("/api/v1/admin/generation/dead-letter");
    return { kind: "deadletter", rows: payload.items };
  }
  if (sectionId === "generation/models") {
    return fetchSection("generation/config", options);
  }
  if (sectionId === "ops/providers") {
    const payload = await apiGet<ProviderOpsData>("/api/v1/admin/ops/providers");
    return { kind: "providers", data: payload };
  }
  if (sectionId === "generation/recipes") return { kind: "selfFetch", view: "recipes" };
  if (sectionId === "generation/presets") return { kind: "selfFetch", view: "presets" };
  const configSlice = configSliceForSection(sectionId);
  if (configSlice) {
    return { kind: "config", data: await fetchGenerationConfig(), slice: configSlice };
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
    const [ledger, subscriptions, reconciliation] = await Promise.all([
      apiGet<{ items: Row[] }>("/api/v1/admin/billing/ledger"),
      apiGet<{ items: Row[] }>("/api/v1/admin/billing/subscriptions"),
      apiGet<ReconciliationData>("/api/v1/admin/billing/reconciliation"),
    ]);
    return {
      kind: "billing",
      rows: ledger.items,
      subscriptions: subscriptions.items,
      reconciliation,
    };
  }
  if (sectionId === "pricing") {
    const payload = await apiGet<{ items: Row[] }>("/api/v1/admin/pricing/rules");
    return { kind: "pricing", rows: payload.items };
  }
  if (sectionId === "analytics") {
    const [legacy, canonical] = await Promise.all([
      apiGet<AnalyticsData>("/api/v1/admin/analytics/overview"),
      apiGet<MetricDashboardResponse>("/api/v2/admin/metrics"),
    ]);
    return { kind: "analytics", data: { legacy, canonical } };
  }
  if (sectionId === "risk") {
    const payload = await apiGet<AbuseData>("/api/v1/admin/risk/abuse");
    return { kind: "risk", data: payload };
  }
  if (sectionId === "audit-log") {
    const payload = await apiGet<{ items: Row[] }>("/api/v1/admin/audit-log");
    return { kind: "audit", rows: payload.items };
  }
  if (sectionId === "support") {
    const payload = await apiGet<{ items: Row[] }>("/api/v1/admin/support/requests");
    return { kind: "support", rows: payload.items };
  }
  if (sectionId === "content") {
    const [characters, featured] = await Promise.all([
      apiGet<{ items: Row[] }>("/api/v1/admin/content/characters"),
      apiGet<{ items: Row[]; characterIds: string[] }>("/api/v1/admin/content/featured"),
    ]);
    return {
      kind: "content",
      characters: characters.items,
      featured: featured.items,
      featuredIds: featured.characterIds,
    };
  }
  if (sectionId === "content/production") return { kind: "selfFetch", view: "production" };
  if (sectionId === "content/assets") return { kind: "selfFetch", view: "assets" };
  if (sectionId === "content/placements") return { kind: "selfFetch", view: "placements" };
  if (sectionId === "content/official") return { kind: "selfFetch", view: "official" };
  if (sectionId === "content/templates") return { kind: "selfFetch", view: "templates" };
  if (sectionId === "content/tags") return { kind: "selfFetch", view: "tags" };
  if (sectionId === "content/review-queue") return { kind: "selfFetch", view: "review-queue" };
  if (sectionId === "cms") return { kind: "selfFetch", view: "cms" };
  if (sectionId === "compliance") return { kind: "selfFetch", view: "compliance" };
  if (sectionId === "insights") return { kind: "selfFetch", view: "insights" };
  if (sectionId === "announcements") return { kind: "selfFetch", view: "announcements" };
  if (sectionId === "experiments") return { kind: "selfFetch", view: "experiments" };
  if (sectionId === "generation/backends") return { kind: "selfFetch", view: "backends" };
  if (sectionId === "generation/workflows") return { kind: "selfFetch", view: "workflows" };
  if (sectionId === "generation/metrics") return { kind: "selfFetch", view: "generation-metrics" };
  if (sectionId === "promo") {
    const [codes, referrals] = await Promise.all([
      apiGet<{ items: Row[] }>("/api/v1/admin/promo/redeem-codes"),
      apiGet<{ items: Row[] }>("/api/v1/admin/promo/referrals"),
    ]);
    return { kind: "promo", codes: codes.items, referrals: referrals.items };
  }
  if (sectionId === "approvals") {
    const payload = await apiGet<{ items: Row[] }>("/api/v1/admin/approvals?status=pending");
    return { kind: "approvals", rows: payload.items };
  }
  if (sectionId === "chat") {
    const filters = options.chatOps ?? defaultChatOpsFilters;
    const common = {
      userId: filters.userId,
      limit: filters.limit,
    };
    const sessionQuery = queryString({
      ...common,
      characterId: filters.characterId,
      status: filters.sessionStatus,
    });
    const usageQuery = queryString(common);
    const eventQuery = queryString({
      limit: filters.limit,
      status: filters.eventStatus,
      layer: filters.eventLayer,
      policyCode: filters.policyCode,
      targetId: filters.targetId,
    });
    const [overview, providerHealth, sessions, events] = await Promise.all([
      apiGet<{
        configured: boolean;
        diagnostics?: ChatOpsDiagnostics;
        overview: Record<string, unknown> | null;
      }>(
        "/api/v1/admin/chat/overview",
      ),
      apiGet<{ configured: boolean; diagnostics?: ChatOpsDiagnostics; items?: Row[] }>(
        "/api/v1/admin/chat/provider-health",
      ),
      apiGet<{ configured: boolean; diagnostics?: ChatOpsDiagnostics; items?: Row[] }>(
        `/api/v1/admin/chat/sessions${sessionQuery}`,
      ),
      apiGet<{ configured: boolean; diagnostics?: ChatOpsDiagnostics; items?: Row[] }>(
        `/api/v1/admin/chat/moderation-events${eventQuery}`,
      ),
    ]);
    const usage = await apiGet<{ configured: boolean; diagnostics?: ChatOpsDiagnostics; items?: Row[] }>(
      `/api/v1/admin/chat/usage${usageQuery}`,
    );
    const configured = overview.configured || providerHealth.configured || sessions.configured || events.configured || usage.configured;
    const diagnostics =
      overview.diagnostics ??
      providerHealth.diagnostics ??
      sessions.diagnostics ??
      events.diagnostics ??
      usage.diagnostics ??
      null;
    return {
      kind: "chatops",
      configured,
      diagnostics,
      overview: overview.overview,
      providerHealth: providerHealth.items ?? [],
      sessions: sessions.items ?? [],
      usage: usage.items ?? [],
      events: events.items ?? [],
    };
  }

  const [legacy, projection] = await Promise.all([
    apiGet<TodayLegacyData>("/api/v1/admin/dashboard"),
    apiGet<TodayProjection>(`/api/v2/admin/today?workMode=${encodeURIComponent(options.workMode ?? "admin")}`),
  ]);
  return { kind: "dashboard", data: { legacy, projection } };
}

function queryString(params: Record<string, string | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const trimmed = value?.trim();
    if (!trimmed || trimmed === "all") continue;
    query.set(key, trimmed);
  }
  const serialized = query.toString();
  return serialized ? `?${serialized}` : "";
}

function canCreateModelProfile(draft: ModelDraft) {
  return Boolean(
    draft.profileKey.trim() &&
      draft.label.trim() &&
      draft.pipelineModel.trim() &&
      parseCsv(draft.allowedOrientations).length > 0,
  );
}

function runnerConfigForProfileTemplate(template: ModelProfileTemplateId) {
  if (template === "text_identity_sdcpp") {
    return {
      templateIntent: "text_to_image_identity_seed",
      capabilities: textIdentityCapabilities,
    };
  }
  if (template === "reference_identity_sdcpp") {
    return {
      templateIntent: "image_to_image_identity_reference",
      capabilities: referenceIdentityCapabilities,
    };
  }
  if (template === "reference_identity_comfyui") {
    return {
      templateIntent: "comfyui_reference_identity",
      capabilities: comfyReferenceIdentityCapabilities,
    };
  }
  return {};
}

function canCreatePricingRule(draft: PricingDraft) {
  const ruleKey = draft.ruleKey.trim();
  return Boolean(
    ruleKey &&
      draft.label.trim() &&
      draft.baseCost.trim() !== "" &&
      draft.reason.trim().length >= 3 &&
      draft.confirmation.trim() === ruleKey,
  );
}

function pricingDraftPayload(draft: PricingDraft): Record<string, unknown> {
  return {
    ruleKey: draft.ruleKey.trim(),
    label: draft.label.trim(),
    mode: draft.mode,
    baseCost: intFromText(draft.baseCost, 5),
    multiplier: numberFromText(draft.multiplier, 1),
    reason: draft.reason.trim(),
    confirmation: draft.confirmation.trim(),
  };
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
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Runner Config must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function stringRecordValue(value: Record<string, unknown>, key: string) {
  const child = value[key];
  return typeof child === "string" && child.trim() ? child.trim() : undefined;
}

function runnerConfigJsonWithApiModelId(
  value: string,
  apiModelId: string,
  patch: Record<string, unknown> = {},
) {
  const config = jsonRecordFromText(value);
  const patchConfig = isRecord(patch.runnerConfig) ? patch.runnerConfig : {};
  const backend = stringPatch(patch, "backend");
  const llmVisionPath = stringPatch(patch, "llmVisionPath");
  return JSON.stringify(pruneUndefined({
    ...config,
    ...patchConfig,
    apiModelId: stringRecordValue(patchConfig, "apiModelId") ?? apiModelId,
    backend: backend || stringRecordValue(patchConfig, "backend") || stringRecordValue(config, "backend"),
    llmVisionPath:
      llmVisionPath ||
      stringRecordValue(patchConfig, "llmVisionPath") ||
      stringRecordValue(config, "llmVisionPath"),
  }));
}

function runnerConfigJsonWithTemplate(
  value: string,
  template: ModelProfileTemplateId,
  patch: Record<string, unknown> = {},
) {
  const config = jsonRecordFromTextOrEmpty(value);
  const templateConfig = runnerConfigForProfileTemplate(template);
  return JSON.stringify(pruneUndefined({
    ...config,
    ...patch,
    profileTemplate: template,
    templateIntent: templateConfig.templateIntent ?? stringRecordValue(config, "templateIntent"),
    capabilities: templateConfig.capabilities ?? config.capabilities,
  }));
}

function jsonRecordFromTextOrEmpty(value: string) {
  try {
    return jsonRecordFromText(value);
  } catch {
    return {};
  }
}

function jsonArrayFromText(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed)) throw new Error("LoRAs must be a JSON array");
  return parsed;
}

function loraDraftsFromText(value: string): LoraDraft[] {
  return jsonArrayFromText(value)
    .map((item): LoraDraft | null => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
      const record = item as Record<string, unknown>;
      const key = typeof record.key === "string" ? record.key : "";
      const pathValue = typeof record.path === "string" ? record.path : "";
      const fileName = typeof record.fileName === "string" ? record.fileName : undefined;
      const weight = typeof record.weight === "number" && Number.isFinite(record.weight) ? record.weight : 1;
      const enabled = typeof record.enabled === "boolean" ? record.enabled : true;
      if (!key.trim() && !pathValue.trim()) return null;
      return { key, path: pathValue, fileName, weight, enabled };
    })
    .filter((item): item is LoraDraft => item !== null);
}

function loraDraftsToText(items: LoraDraft[]) {
  return JSON.stringify(
    items.map((item) =>
      pruneUndefined({
        key: item.key.trim() || undefined,
        path: item.path.trim() || undefined,
        fileName: item.fileName?.trim() || undefined,
        weight: item.weight,
        enabled: item.enabled,
      }),
    ),
  );
}

function isSubmittableLora(item: LoraDraft) {
  return item.enabled && Boolean(item.path.trim() || item.fileName?.trim());
}

type ParsedCivitaiConfig = {
  steps?: number;
  sampler?: string;
  scheduler?: string;
  cfgScale?: number;
  width?: number;
  height?: number;
  modelName?: string;
  vaeName?: string;
  loras: Array<{ name: string; weight?: number }>;
};

type CivitaiApplyResult = {
  draft: ModelDraft;
  applied: string[];
  warnings: string[];
};

function applyCivitaiConfig(
  draft: ModelDraft,
  input: string,
  assets: ModelImportAsset[],
  options: { includeLoras: boolean } = { includeLoras: false },
): CivitaiApplyResult {
  const parsed = parseCivitaiConfig(input);
  let next = { ...draft };
  const applied: string[] = [];
  const warnings: string[] = [];

  if (parsed.steps !== undefined) {
    next = { ...next, steps: String(parsed.steps) };
    applied.push("Steps");
  }
  if (parsed.cfgScale !== undefined) {
    next = { ...next, cfgScale: String(parsed.cfgScale) };
    applied.push("CFG");
  }
  if (parsed.width !== undefined) {
    next = { ...next, defaultWidth: String(parsed.width) };
    applied.push("Width");
  }
  if (parsed.height !== undefined) {
    next = { ...next, defaultHeight: String(parsed.height) };
    applied.push("Height");
  }
  if (parsed.sampler) {
    const sampler = normalizeSamplerValue(parsed.sampler);
    if (sampler) {
      next = { ...next, sampler };
      applied.push("Sampler");
    } else {
      warnings.push("Sampler was not recognized");
    }
  }
  if (parsed.scheduler) {
    const scheduler = normalizeSchedulerValue(parsed.scheduler);
    if (scheduler) {
      next = { ...next, scheduler };
      applied.push("Scheduler");
    } else {
      warnings.push("Scheduler was not recognized");
    }
  }
  if (parsed.modelName) {
    const matchedModel = matchImportAsset(assets, parsed.modelName, "model");
    if (matchedModel) {
      next = applyModelImport(next, matchedModel);
      applied.push("Main model");
    } else {
      const slug = slugFromName(parsed.modelName);
      if (slug) {
        next = {
          ...next,
          profileKey: `sdcpp_${slug}`,
          label: titleFromName(parsed.modelName),
          pipelineModel: slug,
        };
        applied.push("Model name");
      }
    }
  }
  if (parsed.vaeName) {
    const matchedVae = matchImportAsset(assets, parsed.vaeName, "vae");
    if (matchedVae) {
      next = applyModelImport(next, matchedVae);
      applied.push("VAE");
    } else if (looksLikeModelPath(parsed.vaeName)) {
      next = { ...next, vaePath: parsed.vaeName };
      applied.push("VAE");
    }
  }
  if (parsed.loras.length > 0 && !options.includeLoras) {
    warnings.push("LoRA tags ignored by default");
  }
  if (parsed.loras.length > 0 && options.includeLoras) {
    const existing = loraDraftsFromText(next.lorasJson);
    const imported = parsed.loras.flatMap((lora) => {
      const matched = matchImportAsset(assets, lora.name, "lora");
      if (!matched) {
        warnings.push("Some LoRA tags need matching local files");
        return [];
      }
      return [{
        key: slugFromName(lora.name) || lora.name,
        path: matched.path,
        fileName: matched.name,
        weight: lora.weight ?? 1,
        enabled: true,
      }];
    });
    if (imported.length > 0) {
      const merged = mergeLoraDrafts(existing, imported);
      const firstMatched = imported.find((item) => item.path);
      next = {
        ...next,
        loraModelDir: firstMatched?.path ? pathDirName(firstMatched.path) : next.loraModelDir,
        lorasJson: loraDraftsToText(merged),
      };
      applied.push("LoRA Stack");
    }
  }

  return { draft: next, applied: [...new Set(applied)], warnings: [...new Set(warnings)] };
}

function parseCivitaiConfig(input: string): ParsedCivitaiConfig {
  const json = parseMaybeJson(input);
  const text = input.trim();
  const widthHeight = extractSize(text, json);
  const loras = mergeCivitaiLoras(extractTextLoras(text), json ? collectJsonLoras(json) : []);
  const sampler =
    stringFromUnknown(findJsonValue(json, ["sampler", "samplername", "samplingmethod"])) ??
    firstText(text, /(?:^|[,;\n])\s*Sampler\s*:\s*([^,\n]+)/i);
  return {
    steps: numberFromUnknown(findJsonValue(json, ["steps", "stepcount"])) ?? firstNumber(text, /(?:^|[,;\n])\s*Steps\s*:\s*([\d.]+)/i),
    sampler,
    scheduler:
      stringFromUnknown(findJsonValue(json, ["scheduler", "schedulername", "schedule", "sigmascheduler"])) ??
      firstText(text, /(?:^|[,;\n])\s*Scheduler\s*:\s*([^,\n]+)/i) ??
      schedulerFromSamplerText(sampler),
    cfgScale:
      numberFromUnknown(findJsonValue(json, ["cfg", "cfgscale", "guidancescale", "scale"])) ??
      firstNumber(text, /(?:^|[,;\n])\s*(?:CFG scale|CFG|Guidance scale)\s*:\s*([\d.]+)/i),
    width: widthHeight.width,
    height: widthHeight.height,
    modelName:
      stringFromUnknown(findJsonValue(json, ["model", "modelname", "checkpoint", "checkpointname"])) ??
      firstText(text, /(?:^|[,;\n])\s*Model\s*:\s*([^,\n]+)/i),
    vaeName:
      stringFromUnknown(findJsonValue(json, ["vae", "vaename"])) ??
      firstText(text, /(?:^|[,;\n])\s*VAE\s*:\s*([^,\n]+)/i),
    loras,
  };
}

function parseMaybeJson(input: string): unknown {
  const trimmed = input.trim();
  if (!trimmed || !["{", "["].includes(trimmed[0] ?? "")) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function extractSize(input: string, json: unknown): { width?: number; height?: number } {
  const width = numberFromUnknown(findJsonValue(json, ["width", "w"]));
  const height = numberFromUnknown(findJsonValue(json, ["height", "h"]));
  if (width !== undefined && height !== undefined) return { width, height };
  const sizeText = stringFromUnknown(findJsonValue(json, ["size", "resolution"]));
  const sizeMatch = (sizeText ?? input).match(/(\d{2,5})\s*[xX]\s*(\d{2,5})/);
  if (!sizeMatch) return {};
  return {
    width: Number.parseInt(sizeMatch[1] ?? "", 10),
    height: Number.parseInt(sizeMatch[2] ?? "", 10),
  };
}

function findJsonValue(value: unknown, keys: string[]): unknown {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJsonValue(item, keys);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (keys.includes(normalizeMetadataKey(key))) return child;
  }
  for (const child of Object.values(record)) {
    const found = findJsonValue(child, keys);
    if (found !== undefined) return found;
  }
  return undefined;
}

function collectJsonLoras(value: unknown, fromLoraContainer = false): Array<{ name: string; weight?: number }> {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectJsonLoras(item, fromLoraContainer));
  if (typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const normalizedType = stringFromUnknown(record.type ?? record.modelType ?? record.resourceType)?.toLowerCase() ?? "";
  const isLora = fromLoraContainer || normalizedType.includes("lora");
  const name = stringFromUnknown(record.name ?? record.modelName ?? record.modelVersionName ?? record.loraName);
  const current = isLora && name ? [{ name, weight: numberFromUnknown(record.weight ?? record.strength) }] : [];
  const childLoras = Object.entries(record).flatMap(([key, child]) =>
    collectJsonLoras(child, fromLoraContainer || normalizeMetadataKey(key).includes("lora")),
  );
  return mergeCivitaiLoras(current, childLoras);
}

function extractTextLoras(input: string): Array<{ name: string; weight?: number }> {
  const loras: Array<{ name: string; weight?: number }> = [];
  const loraRegex = /<lora:([^:>]+)(?::([\d.]+))?>/gi;
  for (const match of input.matchAll(loraRegex)) {
    const name = match[1]?.trim();
    if (!name) continue;
    loras.push({ name, weight: match[2] ? Number(match[2]) : undefined });
  }
  return mergeCivitaiLoras(loras);
}

function mergeCivitaiLoras(
  first: Array<{ name: string; weight?: number }>,
  second: Array<{ name: string; weight?: number }> = [],
) {
  const merged = new Map<string, { name: string; weight?: number }>();
  for (const item of [...first, ...second]) {
    const key = slugFromName(item.name);
    if (!key) continue;
    merged.set(key, item);
  }
  return [...merged.values()];
}

function mergeLoraDrafts(existing: LoraDraft[], incoming: LoraDraft[]) {
  const merged = new Map<string, LoraDraft>();
  for (const item of [...existing, ...incoming]) {
    const key = item.path || item.key;
    if (!key) continue;
    merged.set(key, item);
  }
  return [...merged.values()];
}

function firstNumber(input: string, pattern: RegExp) {
  const value = firstText(input, pattern);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstText(input: string, pattern: RegExp) {
  return input.match(pattern)?.[1]?.trim();
}

function normalizeSamplerValue(input: string) {
  const fingerprint = samplerFingerprint(input);
  return (
    samplerOptions.find((option) =>
      [option.value, option.label, ...option.aliases].some((candidate) => samplerFingerprint(candidate) === fingerprint),
    )?.value ?? ""
  );
}

function samplerFingerprint(value: string) {
  return value
    .toLowerCase()
    .replace(
      /\b(model default|model-specific|model specific|discrete|karras|exponential|ays|gits|smoothstep|sgm uniform|sgm_uniform|simple|kl optimal|kl_optimal|bong tangent|bong_tangent|ltx2|logit normal|logit_normal|normal|scheduler|schedule)\b/g,
      "",
    )
    .replace(/\+/g, "p")
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeSchedulerValue(input: string) {
  const fingerprint = schedulerFingerprint(input);
  return (
    schedulerOptions.find((option) =>
      [option.value, option.label, ...option.aliases].some((candidate) => schedulerFingerprint(candidate) === fingerprint),
    )?.value ?? ""
  );
}

function schedulerFromSamplerText(input: string | undefined) {
  if (!input) return undefined;
  const normalizedInput = input.toLowerCase().replace(/_/g, " ");
  return schedulerOptions
    .filter((option) => option.value !== "model_default" && option.value !== "lcm")
    .find((option) =>
      [option.value, option.label, ...option.aliases].some((candidate) =>
        normalizedInput.includes(candidate.toLowerCase().replace(/_/g, " ")),
      ),
    )?.value;
}

function schedulerFingerprint(value: string) {
  return value
    .toLowerCase()
    .replace(/model[-_\s]?specific/g, "model default")
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeMetadataKey(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function numberFromUnknown(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringFromUnknown(value: unknown) {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number") return String(value);
  return undefined;
}

function matchImportAsset(assets: ModelImportAsset[], name: string, kind: ModelImportKind) {
  const target = slugFromName(name);
  if (!target) return undefined;
  return assets.find((asset) => asset.kind === kind && slugFromName(asset.name).includes(target));
}

function slugFromName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function titleFromName(value: string) {
  const words = value.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").trim();
  return words || value.trim();
}

function looksLikeModelPath(value: string) {
  return value.startsWith("/") || /\.(safetensors|gguf|ckpt|pt)$/i.test(value);
}

function pathDirName(value: string) {
  const parts = value.split("/");
  parts.pop();
  return parts.join("/") || "";
}

function applyModelImport(draft: ModelDraft, asset: ModelImportAsset): ModelDraft {
  const patch = asset.draftPatch;
  if (asset.kind === "lora") {
    const incoming = loraFromPatch(patch);
    if (!incoming) return draft;
    const loras = loraDraftsFromText(draft.lorasJson);
    const nextLoras = [
      ...loras.filter((item) => (item.path || item.key) !== (incoming.path || incoming.key)),
      incoming,
    ];
    return {
      ...draft,
      loraModelDir: stringPatch(patch, "loraModelDir") || draft.loraModelDir,
      lorasJson: loraDraftsToText(nextLoras),
    };
  }
  if (asset.kind === "llm") {
    return { ...draft, llmPath: stringPatch(patch, "llmPath") || draft.llmPath };
  }
  if (asset.kind === "vae") {
    return { ...draft, vaePath: stringPatch(patch, "vaePath") || draft.vaePath };
  }
  const pipelineModel = stringPatch(patch, "pipelineModel") || draft.pipelineModel;
  const profileTemplate = modelProfileTemplatePatch(patch) ?? draft.profileTemplate;
  const patchedRunner = modelRunnerPatch(patch);
  const runner =
    patchedRunner ??
    (profileTemplate === "reference_identity_comfyui"
      ? "comfyui"
      : profileTemplate === "advanced_custom"
        ? draft.runner
        : "sd_cpp");
  return {
    ...draft,
    profileTemplate,
    profileKey: stringPatch(patch, "profileKey") || draft.profileKey,
    label: stringPatch(patch, "label") || draft.label,
    runner,
    pipelineModel,
    sourceModelPath: stringPatch(patch, "sourceModelPath") || draft.sourceModelPath,
    diffusionModelPath: stringPatch(patch, "diffusionModelPath") || draft.diffusionModelPath,
    convertedModelPath:
      typeof patch.convertedModelPath === "string" ? stringPatch(patch, "convertedModelPath") : draft.convertedModelPath,
    modelFormat: asset.format,
    conversionEnabled: booleanPatch(patch, "conversionEnabled", draft.conversionEnabled),
    conversionType: stringPatch(patch, "conversionType") || draft.conversionType,
    conversionSourceArg:
      stringPatch(patch, "conversionSourceArg") === "model" ? "model" : "diffusion-model",
    llmPath: stringPatch(patch, "llmPath") || draft.llmPath,
    vaePath: stringPatch(patch, "vaePath") || draft.vaePath,
    llmVisionPath: stringPatch(patch, "llmVisionPath") || draft.llmVisionPath,
    backend: stringPatch(patch, "backend") || draft.backend,
    steps: stringPatch(patch, "steps") || draft.steps,
    sampler: stringPatch(patch, "sampler") || draft.sampler,
    scheduler: stringPatch(patch, "scheduler") || draft.scheduler,
    cfgScale: stringPatch(patch, "cfgScale") || draft.cfgScale,
    runnerConfigJson: runnerConfigJsonWithApiModelId(draft.runnerConfigJson, pipelineModel, patch),
  };
}

function modelProfileTemplatePatch(patch: Record<string, unknown>): ModelProfileTemplateId | null {
  const value = stringPatch(patch, "profileTemplate");
  return value === "text_identity_sdcpp" ||
    value === "reference_identity_sdcpp" ||
    value === "reference_identity_comfyui" ||
    value === "advanced_custom"
    ? value
    : null;
}

function modelRunnerPatch(patch: Record<string, unknown>): ModelDraft["runner"] | null {
  const value = stringPatch(patch, "runner");
  return value === "pipeline" ||
    value === "sd_cpp" ||
    value === "mlx" ||
    value === "comfyui" ||
    value === "external"
    ? value
    : null;
}

function applyModelProfileTemplate(draft: ModelDraft, template: ModelProfileTemplateId): ModelDraft {
  const base = { ...draft, profileTemplate: template };
  if (template === "text_identity_sdcpp") {
    return {
      ...base,
      mode: "image",
      runner: "sd_cpp",
      modelFormat: base.modelFormat === "external" ? "safetensors" : base.modelFormat,
      defaultWidth: "960",
      defaultHeight: "1440",
      allowedOrientations: "3:4,4:5,1:1",
      steps: "10",
      sampler: "er_sde",
      scheduler: "simple",
      cfgScale: "1",
      maxCount: "1",
      runnerConfigJson: runnerConfigJsonWithTemplate(base.runnerConfigJson, template, {
        apiModelId: base.pipelineModel,
      }),
    };
  }
  if (template === "reference_identity_sdcpp") {
    return {
      ...base,
      mode: "image",
      runner: "sd_cpp",
      modelFormat: base.modelFormat === "external" ? "safetensors" : base.modelFormat,
      defaultWidth: "768",
      defaultHeight: "1024",
      allowedOrientations: "4:5,3:4,1:1",
      steps: "12",
      sampler: "euler",
      scheduler: "model_default",
      cfgScale: "1",
      maxCount: "1",
      runnerConfigJson: runnerConfigJsonWithTemplate(base.runnerConfigJson, template, {
        apiModelId: base.pipelineModel,
      }),
    };
  }
  if (template === "reference_identity_comfyui") {
    return {
      ...base,
      mode: "image",
      runner: "comfyui",
      modelFormat: "safetensors",
      defaultWidth: "512",
      defaultHeight: "640",
      allowedOrientations: "4:5,3:4,1:1",
      steps: "8",
      sampler: "euler",
      scheduler: "model_default",
      cfgScale: "1",
      maxCount: "1",
      conversionEnabled: false,
      runnerConfigJson: runnerConfigJsonWithTemplate(base.runnerConfigJson, template, {
        apiModelId: base.pipelineModel,
        requiredComponents: ["reference workflow", "text encoder", "vae", "reference adapter"],
      }),
    };
  }
  return {
    ...base,
    runnerConfigJson: runnerConfigJsonWithTemplate(base.runnerConfigJson, template),
  };
}

function mergeImportAsset(
  current: ModelImportLibrary | null,
  result: ModelImportResult,
): ModelImportLibrary {
  const items = current?.items ?? [];
  const incoming = modelImportResultAssets(result);
  const incomingPaths = new Set(incoming.map((item) => item.path));
  return {
    roots: result.roots,
    maxUploadBytes: current?.maxUploadBytes ?? 0,
    items: [...incoming, ...items.filter((item) => !incomingPaths.has(item.path))],
  };
}

function modelImportResultAssets(result: ModelImportResult) {
  if (result.assets?.length) return result.assets;
  return result.asset ? [result.asset] : [];
}

function loraFromPatch(patch: Record<string, unknown>): LoraDraft | null {
  const lora = patch.lora;
  if (typeof lora !== "object" || lora === null || Array.isArray(lora)) return null;
  const record = lora as Record<string, unknown>;
  const key = typeof record.key === "string" ? record.key : "";
  const pathValue = typeof record.path === "string" ? record.path : "";
  if (!key.trim() && !pathValue.trim()) return null;
  return {
    key,
    path: pathValue,
    fileName: typeof record.fileName === "string" ? record.fileName : undefined,
    weight: typeof record.weight === "number" && Number.isFinite(record.weight) ? record.weight : 1,
    enabled: typeof record.enabled === "boolean" ? record.enabled : true,
  };
}

function stringPatch(patch: Record<string, unknown>, key: string) {
  const value = patch[key];
  return typeof value === "string" ? value : "";
}

function booleanPatch(patch: Record<string, unknown>, key: string, fallback: boolean) {
  const value = patch[key];
  return typeof value === "boolean" ? value : fallback;
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && size >= 1024; index += 1) {
    size /= 1024;
    unit = units[index];
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${unit}`;
}

function pruneUndefined(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}

function renderSection(
  section: SectionData | null,
  subview: AdminSubview,
  ctx: {
    openAction: (action: PendingAction) => void;
    adjustment: { userId: string; delta: string };
    setAdjustment: (value: { userId: string; delta: string }) => void;
    selectedProfileId: string | null;
    setSelectedProfileId: (value: string | null) => void;
    pricingDraft: PricingDraft;
    setPricingDraft: (value: PricingDraft) => void;
    pricingBusy: boolean;
    createPricingRule: () => void;
    permissionForm: PermissionForm;
    setPermissionForm: (value: PermissionForm) => void;
    chatOpsFilters: ChatOpsFilters;
    setChatOpsFilters: (value: ChatOpsFilters) => void;
    applyChatOpsFilters: (value: ChatOpsFilters) => void;
    reload: () => void | Promise<void>;
    permissions: ReadonlySet<string>;
    workMode: WorkMode;
  },
) {
  if (!section) return null;
  if (section.kind === "dashboard") {
    return <TodayView data={section.data} workMode={ctx.workMode} />;
  }
  if (section.kind === "jobs") return <JobsView rows={section.rows} openAction={ctx.openAction} />;
  if (section.kind === "config") {
    return (
      <ConfigView
        data={section.data}
        openAction={ctx.openAction}
        reload={ctx.reload}
        selectedProfileId={ctx.selectedProfileId}
        setSelectedProfileId={ctx.setSelectedProfileId}
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
  if (section.kind === "users") {
    return (
      <UsersView
        openAction={ctx.openAction}
        permissionForm={ctx.permissionForm}
        rows={section.rows}
        setPermissionForm={ctx.setPermissionForm}
      />
    );
  }
  if (section.kind === "billing") {
    return (
      <BillingView
        adjustment={ctx.adjustment}
        openAction={ctx.openAction}
        reconciliation={section.reconciliation}
        rows={section.rows}
        setAdjustment={ctx.setAdjustment}
        subscriptions={section.subscriptions}
      />
    );
  }
  if (section.kind === "pricing") {
    return (
      <PricingView
        busy={ctx.pricingBusy}
        draft={ctx.pricingDraft}
        onCreate={ctx.createPricingRule}
        onDraftChange={ctx.setPricingDraft}
        openAction={ctx.openAction}
        rows={section.rows}
      />
    );
  }
  if (section.kind === "deadletter") {
    return <DeadLetterView rows={section.rows} openAction={ctx.openAction} />;
  }
  if (section.kind === "analytics") return <AnalyticsView data={section.data} />;
  if (section.kind === "risk") return <RiskView data={section.data} />;
  if (section.kind === "providers") return <ProviderOpsView data={section.data} />;
  if (section.kind === "content") {
    return (
      <ContentView
        characters={section.characters}
        featured={section.featured}
        featuredIds={section.featuredIds}
        openAction={ctx.openAction}
        reload={ctx.reload}
      />
    );
  }
  if (section.kind === "promo") {
    return (
      <PromoView
        codes={section.codes}
        openAction={ctx.openAction}
        referrals={section.referrals}
        reload={ctx.reload}
      />
    );
  }
  if (section.kind === "support") {
    return <SupportRequestsView rows={section.rows} openAction={ctx.openAction} />;
  }
  if (section.kind === "approvals") {
    return <ApprovalsView rows={section.rows} openAction={ctx.openAction} />;
  }
  if (section.kind === "selfFetch") {
    if (section.view === "production") return <ImageProductionView />;
    if (section.view === "assets") return <AssetsSection view={subview} />;
    if (section.view === "placements") return <PlacementsSection view={subview} />;
    if (section.view === "official") return <OfficialSection view={subview} />;
    if (section.view === "templates") return <StartersSection view={subview} />;
    if (section.view === "recipes") return <RecipesSection view={subview} />;
    if (section.view === "presets") return <PresetsSection view={subview} />;
    if (section.view === "tags") return <TagsView />;
    if (section.view === "cms") return <CmsView />;
    if (section.view === "compliance") return <ComplianceView />;
    if (section.view === "insights") return <InsightsView />;
    if (section.view === "announcements") return <AnnouncementsView />;
    if (section.view === "experiments") return <ExperimentsView />;
    if (section.view === "backends") return <BackendsView />;
    if (section.view === "workflows") return <WorkflowsView />;
    if (section.view === "generation-metrics") return <GenerationMetricsView />;
    return <ReviewQueueView />;
  }
  if (section.kind === "chatops") {
    return (
      <ChatOpsView
        configured={section.configured}
        diagnostics={section.diagnostics}
        events={section.events}
        filters={ctx.chatOpsFilters}
        overview={section.overview}
        onApplyFilters={ctx.applyChatOpsFilters}
        onFiltersChange={ctx.setChatOpsFilters}
        providerHealth={section.providerHealth}
        sessions={section.sessions}
        usage={section.usage}
      />
    );
  }
  return <AuditView rows={section.rows} />;
}

function JobsView({
  rows,
  openAction,
}: {
  rows: Row[];
  openAction: (action: PendingAction) => void;
}) {
  const { locale, t, value } = useAdminI18n();
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [detail, setDetail] = useState<GenerationJobDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  async function openJobDetail(id: string) {
    if (!id) return;
    setSelectedJobId(id);
    setDetail(null);
    setDetailError(null);
    setDetailBusy(true);
    try {
      setDetail(await apiGet<GenerationJobDetail>(`/api/v1/admin/generation/jobs/${id}`));
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : t("Job detail load failed"));
    } finally {
      setDetailBusy(false);
    }
  }

  // SPEC: read-mostly triage table — plain-language failure for failed jobs; the raw jobId/errorCode
  //        never sit as bare columns (errorCode folds inside FailureReason; jobId only inside controls).
  // INTENT: keep BOTH existing per-row controls (Requeue = mutating, via openAction verbatim; Details = view).
  const columns: OpsColumn[] = [
    {
      key: "userId",
      label: "User",
      render: (row) => <span className="font-mono text-xs">{shortId(stringValue(row.userId))}</span>,
    },
    {
      key: "createdAt",
      label: "Created",
      render: (row) => compactDate(stringValue(row.createdAt), locale),
    },
    { key: "status", label: "Status", render: (row) => value(stringValue(row.status)) },
    {
      key: "failure",
      label: "Failure reason",
      render: (row) =>
        stringValue(row.status) === "failed" ? (
          <FailureReason code={stringValue(row.errorCode)} />
        ) : (
          <span className="text-[var(--ad-text-muted)]">—</span>
        ),
    },
    {
      key: "actions",
      label: "Actions",
      render: (row) => {
        const id = stringValue(row.id);
        const status = stringValue(row.status);
        return (
          <div className="flex flex-wrap gap-1">
            <IconAction
              icon={<FileText className="h-4 w-4" />}
              label="Details"
              onClick={() => void openJobDetail(id)}
            />
            {status === "failed" ? (
              <IconAction
                icon={<RefreshCcw className="h-4 w-4" />}
                label="Requeue"
                onClick={() =>
                  openAction({
                    title: `Requeue ${id}`,
                    endpoint: `/api/v1/admin/generation/jobs/${id}/requeue`,
                    method: "POST",
                    confirmText: id,
                    reasonRequired: false,
                    body: (actionReason, actionConfirmation) => ({
                      reason: actionReason || undefined,
                      confirmation: actionConfirmation,
                    }),
                  })
                }
              />
            ) : null}
          </div>
        );
      },
    },
  ];

  return (
    <div className="space-y-4">
      <ReadonlyOpsView columns={columns} rows={rows} title="Generation Jobs" />
      {selectedJobId ? (
        <GenerationJobInspector
          detail={detail}
          error={detailError}
          jobId={selectedJobId}
          loading={detailBusy}
          locale={locale}
          onClose={() => {
            setSelectedJobId(null);
            setDetail(null);
            setDetailError(null);
          }}
        />
      ) : null}
    </div>
  );
}

function GenerationJobInspector({
  detail,
  error,
  jobId,
  loading,
  locale,
  onClose,
}: {
  detail: GenerationJobDetail | null;
  error: string | null;
  jobId: string;
  loading: boolean;
  locale: AdminLocale;
  onClose: () => void;
}) {
  const { t, value } = useAdminI18n();
  const job = detail?.job ?? null;
  const assets = detail?.assets ?? [];
  const providerError = detail?.providerError ?? null;
  const timeline = detail?.timeline ?? [];

  return (
    <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--ad-border)] p-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase text-[var(--ad-text-muted)]">{t("Generation job detail")}</p>
          <h2 className="mt-1 truncate font-mono text-base font-semibold">{shortId(jobId)}</h2>
        </div>
        <button
          aria-label={t("Close")}
          className="rounded-lg grid h-8 w-8 place-items-center border border-[var(--ad-border)] text-[var(--ad-text-muted)] hover:bg-black/[0.04]"
          onClick={onClose}
          type="button"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {loading ? (
        <div className="flex h-28 items-center justify-center text-sm text-[var(--ad-text-muted)]">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          {t("Loading job detail")}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-lg m-4 border border-[var(--ad-red-text)]/20 bg-[var(--ad-red-bg)] px-3 py-2 text-sm text-[var(--ad-red-text)]">
          {error}
        </div>
      ) : null}

      {job ? (
        <div className="grid gap-px bg-black/[0.05] lg:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
          <div className="space-y-4 bg-[var(--ad-surface)] p-4">
            <div className="grid gap-3 sm:grid-cols-4">
              <Metric label="Status" value={value(stringValue(job.status) || "-")} meta={compactDate(stringValue(job.createdAt), locale)} />
              <Metric label="Mode" value={value(stringValue(job.mode) || "-")} meta={stringValue(job.provider) || "-"} />
              <Metric label="Profile" value={shortId(stringValue(job.profileId) || "-")} meta={`v${numberValue(job.profileVersion) || "-"}`} />
              <Metric label="Cost" value={numberValue(job.costDreamcoins)} meta="dreamcoins" />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <TextPanel label="Prompt" value={stringValue(job.prompt)} />
              <TextPanel label="Negative prompt" value={stringValue(job.negativePrompt)} />
            </div>
            {providerError ? (
              <div className="rounded-lg border border-[var(--ad-red-text)]/20 bg-[var(--ad-red-bg)] p-3 text-xs text-[var(--ad-red-text)]">
                <p className="font-semibold">{t("Provider error")}</p>
                <code className="mt-2 block break-words text-[var(--ad-red-text)]/80">
                  {JSON.stringify(providerError)}
                </code>
              </div>
            ) : null}
          </div>

          <div className="space-y-4 bg-[var(--ad-surface)] p-4">
            <div>
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold">{t("Generated assets")}</h3>
                <span className="text-xs text-[var(--ad-text-muted)]">{assets.length}</span>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {assets.map((asset) => {
                  const url = stringValue(asset.thumbnailUrl) || stringValue(asset.url);
                  return (
                    <div className="rounded-lg border border-[var(--ad-border)] bg-black/[0.03] p-2" key={stringValue(asset.id) || url}>
                      <SafeImagePreview alt={t("Generated asset")} src={url} />
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--ad-text-muted)]">
                        <span>{value(stringValue(asset.type))}</span>
                        <span>{value(stringValue(asset.safetyStatus))}</span>
                      </div>
                    </div>
                  );
                })}
                {assets.length === 0 ? (
                  <div className="rounded-lg border border-[var(--ad-border)] bg-black/[0.03] px-3 py-8 text-center text-sm text-[var(--ad-text-muted)] sm:col-span-2">
                    {t("No generated assets")}
                  </div>
                ) : null}
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold">{t("Timeline")}</h3>
                <span className="text-xs text-[var(--ad-text-muted)]">{timeline.length}</span>
              </div>
              <div className="rounded-lg mt-3 max-h-72 overflow-y-auto border border-[var(--ad-border)]">
                {timeline.map((event, index) => (
                  <div className="border-b border-[var(--ad-border)] p-3 text-xs last:border-0" key={`${event.at}-${event.type}-${index}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-[var(--ad-text)]">{value(event.type)}</span>
                      <span className="text-[var(--ad-text-muted)]">{compactDate(event.at, locale)}</span>
                    </div>
                    <p className="mt-1 text-[var(--ad-text-muted)]">{event.message}</p>
                  </div>
                ))}
                {timeline.length === 0 ? (
                  <div className="px-3 py-8 text-center text-sm text-[var(--ad-text-muted)]">
                    {t("No timeline events")}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ConfigOverviewHeader() {
  const { t } = useAdminI18n();

  return (
    <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <p className="text-xs font-semibold uppercase text-[var(--ad-text-muted)]">{t("Model Profiles")}</p>
      <h2 className="mt-1 text-lg font-semibold">{t("Test and publish generation profiles")}</h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--ad-text-muted)]">
        {t("Pick a profile to check readiness, then publish it. Model files and runner setup stay in engineering-owned config.")}
      </p>
    </section>
  );
}

function ConfigTabNav({
  active,
  counts,
  onChange,
}: {
  active: ConfigTab;
  counts: Record<ConfigTab, number | string>;
  onChange: (tab: ConfigTab) => void;
}) {
  const { t } = useAdminI18n();
  const items: Array<{ id: ConfigTab; label: string; meta: string }> = [
    { id: "profiles", label: "Profiles", meta: "Test and publish" },
    { id: "settings", label: "Settings", meta: "Feature flags" },
  ];

  return (
    <div className="rounded-lg grid gap-px overflow-hidden border border-[var(--ad-border)] bg-black/[0.05] md:grid-cols-2">
      {items.map((item) => {
        const selected = active === item.id;
        return (
          <button
            aria-current={selected ? "page" : undefined}
            className={cn(
              "bg-[var(--ad-surface)] px-3 py-3 text-left hover:bg-black/[0.04]",
              selected && "bg-[var(--ad-ink)] text-white hover:bg-[var(--ad-ink)]",
            )}
            key={item.id}
            onClick={() => onChange(item.id)}
            type="button"
          >
            <span className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold">{t(item.label)}</span>
              <span
                className={cn(
                  "font-mono text-xs",
                  selected ? "text-white/60" : "text-[var(--ad-text-muted)]",
                )}
              >
                {counts[item.id]}
              </span>
            </span>
            <span className={cn("mt-1 block text-xs", selected ? "text-white/60" : "text-[var(--ad-text-muted)]")}>
              {t(item.meta)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// SPEC: operator-facing state phrase (returns an i18n key) shared by the list subtitle and detail header.
// INTENT: never leak machine codes; blocked -> needs engineering; active -> published;
//         draft without a dry run -> needs testing, otherwise -> ready to publish.
function profileStateLabelKey(profile: Row, verification: ProfileVerificationSummary): string {
  if (verification.blockedReason) return "Blocked — needs engineering";
  const status = stringValue(profile.status);
  if (status === "active") return "Published";
  if (status === "archived") return "Archived";
  if (status === "draft") {
    return dryRunSummary(profile.dryRunSummary).status === "missing" ? "Needs testing" : "Ready to publish";
  }
  return status || "draft";
}

// SPEC: pick the most specific machine code for FailureReason (plain-language title first, raw code folded away).
// failureMode wins (e.g. missing_flux2_klein_reference_runtime_components -> "Model files not ready");
// else a bad component -> missing_runtime_components; else fall back to the raw verificationStatus.
function profileBlockCode(verification: ProfileVerificationSummary): string {
  if (verification.failureMode) return verification.failureMode;
  if (verification.components.some((component) => component.tone === "bad")) return "missing_runtime_components";
  return verification.status;
}

type ProfileWorkflowSlot = { type: string; default?: string | number | null };
type ProfileWorkflowOption = { workflowKey: string; backendKind: string; inputs?: ProfileWorkflowSlot[] };

// I-1 (P2 final review): edit workflows (e.g. qwen-image-edit-img2img) declare a REQUIRED image
// slot — type "image" with no default — that a plain text-to-image test/publish job cannot fill,
// so the picker lists but disables them for standard profiles.
function requiresReferenceImage(workflow: ProfileWorkflowOption): boolean {
  return Array.isArray(workflow.inputs)
    ? workflow.inputs.some((slot) => slot.type === "image" && (slot.default === undefined || slot.default === null))
    : false;
}

// SPEC: selected profile detail — status action rail (incl. the pre-publish "generate test image"),
//       plain-language block reason, latest test-image preview, and folded engineering config.
// INVARIANTS: dry-run/publish/rollback/disable go via openAction (confirm+reason modal), publish is
//             disabled while blocked; test-image reuses the existing test-job endpoint verbatim
//             (direct apiWrite, same body); the workflow-key editor is engineering config, folded away.
function ProfileDetail({
  jobs,
  onOpenAction,
  onReload,
  profile,
}: {
  jobs: Row[];
  onOpenAction: (action: PendingAction) => void;
  onReload: () => void | Promise<void>;
  profile: Row | null;
}) {
  const { locale, t, value } = useAdminI18n();
  const [testPrompt, setTestPrompt] = useState("cinematic portrait, natural skin texture, soft studio lighting");
  const [testBusy, setTestBusy] = useState(false);
  const [testNotice, setTestNotice] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [watchJobId, setWatchJobId] = useState<string | null>(null);
  const [workflowOptions, setWorkflowOptions] = useState<ProfileWorkflowOption[]>([]);
  const [workflowDraft, setWorkflowDraft] = useState(() => stringValue(profile?.workflowKey));
  const [syncedProfileId, setSyncedProfileId] = useState(() => stringValue(profile?.id));
  const [workflowSaveBusy, setWorkflowSaveBusy] = useState(false);
  const [workflowSaveNotice, setWorkflowSaveNotice] = useState<string | null>(null);
  const [workflowSaveError, setWorkflowSaveError] = useState<string | null>(null);

  const id = stringValue(profile?.id);
  const status = stringValue(profile?.status);
  const mode = stringValue(profile?.mode);
  const enabled = Boolean(profile?.enabled);
  const orientation = firstString(jsonStringArrayValue(profile?.allowedOrientations), "1:1");
  const workflowKey = stringValue(profile?.workflowKey);

  // Adjust the workflow draft during render when the selected profile changes (adjust-state-on-
  // prop-change pattern) so a background job-status reload never clobbers an unsaved dropdown edit.
  if (id !== syncedProfileId) {
    setSyncedProfileId(id);
    setWorkflowDraft(workflowKey);
    setWorkflowSaveNotice(null);
    setWorkflowSaveError(null);
  }

  const verification = profileVerificationSummary(profile);
  const publishBlocked = Boolean(verification.blockedReason);
  const dryRun = dryRunSummary(profile?.dryRunSummary);
  const relatedJobs = useMemo(() => profileRelatedJobs(jobs, profile), [jobs, profile]);
  const latestJob = relatedJobs[0] ?? null;
  const latestAsset = latestImageAsset(relatedJobs);
  const watchedJob = watchJobId ? jobs.find((job) => stringValue(job.id) === watchJobId) ?? null : null;
  const canTest = Boolean(profile && mode === "image" && status !== "archived");

  // Poll job status while a queued test image is still rendering; stop once terminal.
  useEffect(() => {
    if (!watchJobId) return;
    if (watchedJob && isTerminalJobStatus(stringValue(watchedJob.status))) {
      const timer = window.setTimeout(() => setWatchJobId(null), 0);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setInterval(() => {
      void onReload();
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [onReload, watchedJob, watchJobId]);

  // Populate the workflow dropdown once from the read-only workflows catalog.
  useEffect(() => {
    let cancelled = false;
    void apiGet<{ items: ProfileWorkflowOption[] }>("/api/v1/admin/generation/workflows")
      .then((data) => {
        if (!cancelled) setWorkflowOptions(data.items);
      })
      .catch(() => {
        // Non-fatal: the select falls back to "(use pipelineModel)" only.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function createTestImage() {
    if (!id || !canTest) return;
    setTestBusy(true);
    setTestNotice(null);
    setTestError(null);
    try {
      const result = await apiWrite<{ job: Row }>(
        `/api/v1/admin/generation/model-profiles/${id}/test-job`,
        "POST",
        {
          prompt: testPrompt.trim() || undefined,
          orientation,
          outputCount: 1,
          reason: "Admin image test from Generation Config",
          confirmation: id,
        },
      );
      const jobId = stringValue(result.job.id);
      setWatchJobId(jobId || null);
      setTestNotice(jobId ? t("Test image queued: {id}", { id: shortId(jobId) }) : t("Test image queued"));
      await onReload();
    } catch (error) {
      setTestError(error instanceof Error ? error.message : t("Test image failed"));
    } finally {
      setTestBusy(false);
    }
  }

  async function saveWorkflowKey() {
    if (!id) return;
    setWorkflowSaveBusy(true);
    setWorkflowSaveNotice(null);
    setWorkflowSaveError(null);
    try {
      await apiWrite(`/api/v1/admin/generation/model-profiles/${id}`, "PATCH", {
        workflowKey: workflowDraft || null,
      });
      setWorkflowSaveNotice(t("Workflow saved"));
      await onReload();
    } catch (error) {
      setWorkflowSaveError(error instanceof Error ? error.message : t("Workflow save failed"));
    } finally {
      setWorkflowSaveBusy(false);
    }
  }

  if (!profile) {
    return (
      <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-6 text-sm text-[var(--ad-text-muted)]">
        {t("Select a profile to review its readiness and publish it.")}
      </section>
    );
  }

  const source = profileSourceLabel(profile);

  return (
    <section className="rounded-lg min-w-0 space-y-4 border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold">{profileDisplayName(profile, locale)}</h2>
          <p className="mt-1 text-sm text-[var(--ad-text-muted)]">{t(profileStateLabelKey(profile, verification))}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Link
            className="rounded-md inline-flex h-8 items-center gap-1 border border-[var(--ad-border)] px-2 text-xs text-[var(--ad-text)] hover:bg-black/[0.04]"
            href="/admin/generation/jobs"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {t("Open jobs")}
          </Link>
          <button
            className="rounded-md inline-flex h-8 items-center gap-1 border border-[var(--ad-border)] px-2 text-xs text-[var(--ad-text)] hover:bg-black/[0.04]"
            onClick={() => void onReload()}
            type="button"
          >
            <RefreshCcw className="h-3.5 w-3.5" />
            {t("Refresh")}
          </button>
        </div>
      </div>

      {id ? (
        <div className="flex flex-wrap gap-2">
          {status === "draft" ? (
            <IconAction
              icon={<Activity className="h-4 w-4" />}
              label="Dry Run"
              onClick={() => onOpenAction(dryRunProfileAction(id))}
            />
          ) : null}
          {canTest ? (
            <IconAction
              disabled={testBusy}
              icon={testBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              label="Generate test image"
              onClick={() => void createTestImage()}
            />
          ) : null}
          {status === "draft" ? (
            <IconAction
              disabled={publishBlocked}
              icon={<UploadCloud className="h-4 w-4" />}
              label="Publish"
              onClick={() => onOpenAction(publishProfileAction(id, mode, profile))}
            />
          ) : null}
          {status === "active" ? (
            <IconAction
              icon={<RotateCcw className="h-4 w-4" />}
              label="Rollback"
              onClick={() => onOpenAction(rollbackProfileAction(id))}
            />
          ) : null}
          {enabled ? (
            <IconAction
              icon={<Ban className="h-4 w-4" />}
              label="Disable"
              onClick={() => onOpenAction(disableProfileAction(id))}
            />
          ) : null}
        </div>
      ) : null}

      {publishBlocked ? (
        <div className="rounded-lg border border-[var(--ad-red-text)]/20 bg-[var(--ad-red-bg)] p-3">
          <FailureReason code={profileBlockCode(verification)} detail={verification.meta} />
        </div>
      ) : null}

      {canTest ? (
        <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,300px)]">
          <label className="block min-w-0">
            <span className="mb-1 block text-xs font-medium text-[var(--ad-text-muted)]">{t("Test prompt")}</span>
            <textarea
              className="rounded-md min-h-24 w-full resize-y border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 py-2 text-sm leading-6 outline-none focus:border-[var(--ad-ink)]"
              onChange={(event) => setTestPrompt(event.target.value)}
              value={testPrompt}
            />
            {testNotice ? (
              <div className="rounded-lg mt-2 border border-[var(--ad-green-text)]/20 bg-[var(--ad-green-bg)] px-3 py-2 text-sm text-[var(--ad-green-text)]">
                {testNotice}
              </div>
            ) : null}
            {testError ? (
              <div className="rounded-lg mt-2 border border-[var(--ad-red-text)]/20 bg-[var(--ad-red-bg)] px-3 py-2 text-sm text-[var(--ad-red-text)]">
                {testError}
              </div>
            ) : null}
          </label>
          <div className="min-w-0">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">{t("Latest test image")}</h3>
              {latestJob ? (
                <span className="text-xs text-[var(--ad-text-muted)]">
                  {compactDate(stringValue(latestJob.createdAt), locale)}
                </span>
              ) : null}
            </div>
            <div className="rounded-lg mt-2 aspect-[4/5] overflow-hidden border border-[var(--ad-border)] bg-[var(--ad-surface)]">
              {latestAsset ? (
                <a href={latestAsset.url} rel="noreferrer" target="_blank">
                  <SafeImagePreview alt={t("Latest test image")} src={latestAsset.thumbnailUrl || latestAsset.url} />
                </a>
              ) : (
                <div className="flex h-full items-center justify-center px-6 text-center text-sm text-[var(--ad-text-muted)]">
                  {latestJob
                    ? isTerminalJobStatus(stringValue(latestJob.status))
                      ? t("No image generated: {status}", { status: value(stringValue(latestJob.status)) })
                      : t("Waiting for generated asset")
                    : t("No test image yet")}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <EngineeringDetails summary={t("Model & workflow details")}>
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 flex items-center gap-1 font-medium text-[var(--ad-text-muted)]">
              <Workflow className="h-3.5 w-3.5" />
              {t("Workflow")}
            </span>
            <div className="flex gap-2">
              <select
                className="rounded-md h-9 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-2 text-xs outline-none focus:border-[var(--ad-ink)] disabled:opacity-50"
                disabled={status !== "draft"}
                onChange={(event) => setWorkflowDraft(event.target.value)}
                value={workflowDraft}
              >
                <option value="">{t("(use pipelineModel)")}</option>
                {workflowOptions.map((workflow) => {
                  const needsReferenceImage = requiresReferenceImage(workflow);
                  return (
                    <option disabled={needsReferenceImage} key={workflow.workflowKey} value={workflow.workflowKey}>
                      {needsReferenceImage
                        ? `${workflow.workflowKey} (${workflow.backendKind}) ${t("(needs reference image — not for standard profiles)")}`
                        : `${workflow.workflowKey} (${workflow.backendKind})`}
                    </option>
                  );
                })}
              </select>
              <button
                className="rounded-md inline-flex h-9 shrink-0 items-center gap-2 border border-[var(--ad-border)] px-3 text-xs text-[var(--ad-text)] hover:bg-black/[0.04] disabled:opacity-50"
                disabled={status !== "draft" || workflowSaveBusy || workflowDraft === workflowKey}
                onClick={() => void saveWorkflowKey()}
                type="button"
              >
                {workflowSaveBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : t("Save")}
              </button>
            </div>
            {status !== "draft" ? (
              <span className="mt-1 block text-[var(--ad-text-muted)]">
                {t("Only draft profiles can change workflow routing.")}
              </span>
            ) : null}
          </label>
          {workflowSaveNotice ? (
            <div className="rounded-lg border border-[var(--ad-green-text)]/20 bg-[var(--ad-green-bg)] px-3 py-2 text-[var(--ad-green-text)]">
              {workflowSaveNotice}
            </div>
          ) : null}
          {workflowSaveError ? (
            <div className="rounded-lg border border-[var(--ad-red-text)]/20 bg-[var(--ad-red-bg)] px-3 py-2 text-[var(--ad-red-text)]">{workflowSaveError}</div>
          ) : null}
          <div className="space-y-1">
            <div>{t("Profile ID")}: {id || "-"}</div>
            <div>{t("Profile key")}: {stringValue(profile.profileKey) || "-"}</div>
            <div>{t("Version")}: v{numberValue(profile.version) || "-"}</div>
            <div>{t("Runner")}: {stringValue(profile.runner) || "-"}</div>
            <div>{t("Mode")}: {mode || "-"}</div>
            <div>{t("Pipeline model")}: {stringValue(profile.pipelineModel) || "-"}</div>
            <div>{t("Model file")}: {source || "-"}</div>
            <div>{t("Active workflow")}: {workflowKey || t("(use pipelineModel)")}</div>
            <div>
              {t("Output size")}: {numberValue(profile.defaultWidth) || "-"}x{numberValue(profile.defaultHeight) || "-"}
            </div>
            <div>
              {t("Dry Run")}: {value(dryRun.status)} · {dryRun.meta}
            </div>
            <div>{t("Verification status")}: {verification.status}</div>
            <div>{t("Rollout")}: {numberValue(profile.rolloutPercent) || 0}%</div>
            <div>{t("Required entitlement")}: {stringValue(profile.requiredEntitlement) || "-"}</div>
            <div>
              {t("Latest job")}:{" "}
              {latestJob
                ? `${shortId(stringValue(latestJob.id))} · ${value(stringValue(latestJob.status))}`
                : t("No test jobs")}
            </div>
          </div>
          <ProfileVerificationPanel summary={verification} />
        </div>
      </EngineeringDetails>
    </section>
  );
}

function ConfigView({
  data,
  openAction,
  reload,
  selectedProfileId,
  setSelectedProfileId,
}: {
  data: ConfigData;
  openAction: (action: PendingAction) => void;
  reload: () => void | Promise<void>;
  selectedProfileId: string | null;
  setSelectedProfileId: (value: string | null) => void;
}) {
  const { locale, t } = useAdminI18n();
  const [initialUrlState] = useState(() => readConfigUrlState());
  const [configTab, setConfigTab] = useState<ConfigTab>(() => initialUrlState.tab ?? "profiles");
  const selectedProfile = useMemo(
    () => selectedGenerationProfile(data.profiles, selectedProfileId),
    [data.profiles, selectedProfileId],
  );
  const orderedProfiles = useMemo(() => profileOptions(data.profiles), [data.profiles]);
  const tabCounts = useMemo<Record<ConfigTab, number | string>>(
    () => ({
      profiles: data.profiles.length,
      settings: data.flags.length,
    }),
    [data.flags.length, data.profiles.length],
  );
  const profileItems = useMemo<OperatorFlowItem[]>(
    () =>
      orderedProfiles
        .filter((profile) => stringValue(profile.id))
        .map((profile) => {
          const verification = profileVerificationSummary(profile);
          const status = stringValue(profile.status);
          const tone: "good" | "bad" | "warn" = verification.blockedReason
            ? "bad"
            : status === "active"
              ? "good"
              : "warn";
          return {
            id: stringValue(profile.id),
            primary: profileDisplayName(profile, locale),
            secondary: t(profileStateLabelKey(profile, verification)),
            badge: <Status locale={locale} tone={tone} value={status || "draft"} />,
          };
        }),
    [locale, orderedProfiles, t],
  );

  useEffect(() => {
    if (selectedProfileId || !selectedProfile) return;
    const profileId = stringValue(selectedProfile.id);
    if (profileId) setSelectedProfileId(profileId);
  }, [selectedProfile, selectedProfileId, setSelectedProfileId]);

  return (
    <div className="space-y-6">
      <ConfigOverviewHeader />
      <ConfigTabNav active={configTab} counts={tabCounts} onChange={setConfigTab} />

      {configTab === "profiles" && (
        <OperatorFlow
          detail={<ProfileDetail jobs={data.recentJobs} onOpenAction={openAction} onReload={reload} profile={selectedProfile} />}
          empty={t("No built-in generation profiles are seeded yet.")}
          items={profileItems}
          onSelect={setSelectedProfileId}
          selectedId={selectedProfileId}
        />
      )}

      {configTab === "settings" && (
        <DataTable
          actions={(row) => featureFlagActions(row, openAction)}
          columns={["key", "enabled", "rolloutPercent", "version", "hardPolicy"]}
          rows={data.flags}
          title="Feature Flags"
        />
      )}
    </div>
  );
}

function featureFlagActions(row: Row, openAction: (action: PendingAction) => void) {
  const key = stringValue(row.key);
  if (!key) return null;
  const enabled = Boolean(row.enabled);

  return (
    <IconAction
      icon={<Flag className="h-4 w-4" />}
      label={enabled ? "Disable" : "Enable"}
      onClick={() => openAction(toggleFeatureFlagAction(key, enabled))}
    />
  );
}

function dryRunProfileAction(id: string): PendingAction {
  return {
    title: `Dry run profile ${id}`,
    endpoint: `/api/v1/admin/generation/model-profiles/${id}/dry-run`,
    method: "POST",
    confirmText: id,
    reasonRequired: true,
    body: (actionReason, actionConfirmation) => ({
      reason: actionReason,
      confirmation: actionConfirmation,
    }),
  };
}

function publishProfileAction(id: string, mode: string, profile?: Row | null): PendingAction {
  const requiresReview = mode === "image";
  return {
    title: `Publish profile ${id}`,
    endpoint: `/api/v1/admin/generation/model-profiles/${id}/publish`,
    method: "POST",
    confirmText: id,
    reasonRequired: true,
    review: requiresReview ? "image_consistency" : undefined,
    verification: profile ? profileVerificationSummary(profile) : undefined,
    body: (actionReason, actionConfirmation, review) => ({
      reason: actionReason,
      confirmation: actionConfirmation,
      ...(requiresReview ? { dryRunSummary: actionReviewDryRunSummary(review) } : {}),
    }),
  };
}

function rollbackProfileAction(id: string): PendingAction {
  return {
    title: `Rollback profile ${id}`,
    endpoint: `/api/v1/admin/generation/model-profiles/${id}/rollback`,
    method: "POST",
    confirmText: id,
    reasonRequired: true,
    body: (actionReason, actionConfirmation) => ({
      reason: actionReason,
      confirmation: actionConfirmation,
    }),
  };
}

function disableProfileAction(id: string): PendingAction {
  return {
    title: `Disable profile ${id}`,
    endpoint: `/api/v1/admin/generation/model-profiles/${id}`,
    method: "PATCH",
    confirmText: id,
    reasonRequired: true,
    body: (actionReason, actionConfirmation) => ({
      enabled: false,
      reason: actionReason,
      confirmation: actionConfirmation,
    }),
  };
}

function toggleFeatureFlagAction(key: string, enabled: boolean): PendingAction {
  const nextEnabled = !enabled;
  const confirmationTarget = `${key}:${nextEnabled ? "enabled" : "disabled"}`;
  return {
    title: `${enabled ? "Disable" : "Enable"} ${key}`,
    endpoint: `/api/v1/admin/feature-flags/${key}`,
    method: "PATCH",
    confirmText: confirmationTarget,
    reasonRequired: true,
    body: (actionReason, actionConfirmation) => ({
      enabled: nextEnabled,
      reason: actionReason,
      confirmation: actionConfirmation,
    }),
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- retained for engineering-only model diagnostics; no product route renders it.
function ModelManagementView() {
  const { t } = useAdminI18n();
  const [library, setLibrary] = useState<ModelImportLibrary | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [serverImportKind, setServerImportKind] = useState<ModelImportKind>("model");
  const [serverImportPath, setServerImportPath] = useState("");

  async function refreshLibrary() {
    setBusy("refresh");
    setError(null);
    setNotice(null);
    try {
      setLibrary(await apiGet<ModelImportLibrary>("/api/v1/admin/generation/model-imports"));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Model library load failed");
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshLibrary();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function uploadAsset(kind: ModelImportKind, file: File | null) {
    if (!file) return;
    setBusy(`upload-${kind}`);
    setError(null);
    setNotice(null);
    try {
      const form = new FormData();
      form.set("kind", kind);
      form.set("file", file);
      const result = await apiForm<ModelImportResult>("/api/v1/admin/generation/model-imports/upload", form);
      setLibrary((current) => mergeImportAsset(current, result));
      setNotice(t("{count} assets imported", { count: modelImportResultAssets(result).length }));
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Model upload failed");
    } finally {
      setBusy(null);
    }
  }

  async function registerAsset(kind: ModelImportKind, filePath: string) {
    const trimmed = filePath.trim();
    if (!trimmed) return;
    setBusy(`register-${kind}`);
    setError(null);
    setNotice(null);
    try {
      const result = await apiWrite<ModelImportResult>(
        "/api/v1/admin/generation/model-imports/register",
        "POST",
        { kind, path: trimmed, reason: "admin model import" },
      );
      setLibrary((current) => mergeImportAsset(current, result));
      setServerImportPath("");
      setNotice(t("{count} assets imported from server path", { count: modelImportResultAssets(result).length }));
    } catch (registerError) {
      setError(registerError instanceof Error ? registerError.message : "Model import failed");
    } finally {
      setBusy(null);
    }
  }

  const items = library?.items ?? [];
  const mainModels = items.filter((item) => item.kind === "model");
  const loras = items.filter((item) => item.kind === "lora");
  const components = items.filter((item) => item.kind === "llm" || item.kind === "vae");

  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase text-[var(--ad-text-muted)]">
              {t("Engineering diagnostics")}
            </p>
            <h2 className="mt-1 text-lg font-semibold">{t("Model diagnostics library")}</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--ad-text-muted)]">
              {t("Engineering-only model diagnostics. Operators use seeded profiles in Model Profiles.")}
            </p>
          </div>
          <button
            className="rounded-md inline-flex h-9 items-center gap-2 border border-[var(--ad-border)] px-3 text-sm text-[var(--ad-text)] hover:bg-black/[0.04] disabled:opacity-50"
            disabled={busy === "refresh"}
            onClick={() => void refreshLibrary()}
            type="button"
          >
            {busy === "refresh" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
            {t("Refresh library")}
          </button>
        </div>
        <div className="mt-4 grid gap-2 lg:grid-cols-4">
          <WorkflowStep
            active={mainModels.length === 0}
            index={1}
            meta={mainModels.length ? t("{count} main models", { count: mainModels.length }) : t("Import one checkpoint")}
            title={t("Diagnostic import")}
          />
          <WorkflowStep
            active={mainModels.length > 0}
            index={2}
            meta={loras.length ? t("{count} LoRA attached", { count: loras.length }) : t("LoRA optional")}
            title={t("Attach LoRA")}
          />
          <WorkflowStep
            active={mainModels.length > 0}
            index={3}
            meta={components.length ? t("{count} components", { count: components.length }) : t("Use defaults or register components")}
            title={t("Configure profile")}
          />
          <WorkflowStep
            active={mainModels.length > 0}
            index={4}
            meta={t("Dry run and test image")}
            title={t("Publish")}
          />
        </div>
        <div className="rounded-lg mt-4 grid gap-px overflow-hidden border border-[var(--ad-border)] bg-black/[0.05] md:grid-cols-4">
          <Metric label="Main Models" value={mainModels.length} meta={library ? t("Library root: {path}", { path: library.roots.root }) : "missing"} />
          <Metric label="LoRA Models" value={loras.length} meta="optional adapters" />
          <Metric label="Model components" value={components.length} meta="LLM / VAE" />
          <Metric label="Max upload" value={library ? formatBytes(library.maxUploadBytes) : "-"} meta="local file upload" />
        </div>
      </section>

      {error ? (
        <div className="rounded-lg border border-[var(--ad-red-text)]/20 bg-[var(--ad-red-bg)] px-3 py-2 text-sm text-[var(--ad-red-text)]">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="rounded-lg border border-[var(--ad-green-text)]/20 bg-[var(--ad-green-bg)] px-3 py-2 text-sm text-[var(--ad-green-text)]">
          {notice}
        </div>
      ) : null}

      <section className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <ModelImportPanel
          accept=".safetensors,.gguf"
          busy={busy === "upload-model"}
          description="Upload or register a checkpoint once. Generation profiles can select it later."
          onUpload={(file) => void uploadAsset("model", file)}
          title="Diagnostic model import"
          uploadLabel="Upload diagnostic model"
        />
        <ModelImportPanel
          accept=".safetensors"
          busy={busy === "upload-lora"}
          description="LoRA files are optional adapters. Import them here before attaching them to a profile."
          onUpload={(file) => void uploadAsset("lora", file)}
          title="LoRA import"
          uploadLabel="Upload LoRA"
        />
      </section>

      <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
        <div className="mb-3">
          <h3 className="text-sm font-semibold">{t("Import from server path")}</h3>
          <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">
            {t("Enter a server file path or a directory path. Directory import registers all supported files under that folder.")}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[160px]">
            <FormSelect
              label="Asset kind"
              onChange={(value) => setServerImportKind(value as ModelImportKind)}
              options={["model", "lora", "llm", "vae"]}
              value={serverImportKind}
            />
          </div>
          <label className="min-w-[260px] flex-1">
            <span className="mb-1 block text-xs font-medium text-[var(--ad-text-muted)]">
              {t("Server file or directory path")}
            </span>
            <input
              className="rounded-md h-10 w-full min-w-0 border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
              onChange={(event) => setServerImportPath(event.target.value)}
              placeholder={t("/Users/kk/Downloads/models or /path/model.safetensors")}
              value={serverImportPath}
            />
          </label>
          <button
            className="inline-flex h-10 items-center justify-center gap-2 bg-[var(--ad-ink)] px-3 text-sm font-semibold text-white disabled:opacity-50"
            disabled={Boolean(busy) || !serverImportPath.trim()}
            onClick={() => void registerAsset(serverImportKind, serverImportPath)}
            type="button"
          >
            {busy?.startsWith("register") ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {t("Import Path")}
          </button>
        </div>
      </section>

      <ModelAssetLibraryTable items={items} />
    </div>
  );
}

function ModelImportPanel({
  accept,
  busy,
  description,
  onUpload,
  title,
  uploadLabel,
}: {
  accept: string;
  busy: boolean;
  description: string;
  onUpload: (file: File | null) => void;
  title: string;
  uploadLabel: string;
}) {
  const { t } = useAdminI18n();
  return (
    <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <h3 className="text-sm font-semibold">{t(title)}</h3>
      <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">{t(description)}</p>
      <label className="mt-4 inline-flex h-10 cursor-pointer items-center justify-center gap-2 bg-[var(--ad-ink)] px-3 text-sm font-semibold text-white hover:bg-[#333333] focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--ad-ink)]">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
        {t(uploadLabel)}
        <input
          accept={accept}
          aria-label={t(uploadLabel)}
          className="sr-only"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0] ?? null;
            event.target.value = "";
            onUpload(file);
          }}
          type="file"
        />
      </label>
    </section>
  );
}

function ModelAssetLibraryTable({ items }: { items: ModelImportAsset[] }) {
  const { t } = useAdminI18n();
  return (
    <section className="rounded-lg overflow-hidden border border-[var(--ad-border)] bg-[var(--ad-surface)]">
      <div className="flex h-11 items-center justify-between border-b border-[var(--ad-border)] px-4">
        <h2 className="text-sm font-semibold">{t("Imported model assets")}</h2>
        <span className="text-xs text-[var(--ad-text-muted)]">{items.length}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-xs">
          <thead className="bg-black/[0.03] text-[var(--ad-text-muted)]">
            <tr>
              {["Asset kind", "Name", "Format", "Size", "Path", "Updated", "Actions"].map((column) => (
                <th key={column} className="border-b border-[var(--ad-border)] px-3 py-2 font-semibold">
                  {t(column)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={`${item.kind}-${item.path}`} className="border-b border-[var(--ad-border)] last:border-0">
                <td className="px-3 py-2 align-top">
                  <span className="rounded-lg border border-[var(--ad-border)] px-2 py-1 text-[11px] text-[var(--ad-text)]">
                    {item.kind}
                  </span>
                </td>
                <td className="max-w-[220px] px-3 py-2 align-top text-[var(--ad-text)]">
                  <span className="break-words">{item.name}</span>
                </td>
                <td className="px-3 py-2 align-top text-[var(--ad-text-muted)]">{item.format}</td>
                <td className="px-3 py-2 align-top font-mono text-[var(--ad-text-muted)]">{formatBytes(item.sizeBytes)}</td>
                <td className="max-w-[440px] px-3 py-2 align-top font-mono text-[var(--ad-text-muted)]">
                  <span className="break-all">{item.path}</span>
                </td>
                <td className="px-3 py-2 align-top text-[var(--ad-text-muted)]">{compactDate(item.modifiedAt)}</td>
                <td className="px-3 py-2 align-top">
                  <Link
                    className="rounded-md inline-flex h-8 items-center gap-2 border border-[var(--ad-border)] px-2 text-xs text-[var(--ad-text)] hover:bg-black/[0.04]"
                    href={modelAssetConfigureHref(item)}
                  >
                    <SlidersHorizontal className="h-4 w-4" />
                    {item.kind === "model" ? t("Use in profile") : t("Attach to profile")}
                  </Link>
                </td>
              </tr>
            ))}
            {items.length === 0 ? (
              <tr>
                <td className="px-3 py-8 text-center text-sm text-[var(--ad-text-muted)]" colSpan={7}>
                  {t("No model assets imported")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- retained for engineering-only model diagnostics; no product route renders it.
function ModelProfileDraftForm({
  busy,
  draft,
  initialAssetPath,
  onCreate,
  onDraftChange,
}: {
  busy: boolean;
  draft: ModelDraft;
  initialAssetPath: string;
  onCreate: () => void;
  onDraftChange: (value: ModelDraft) => void;
}) {
  const { t } = useAdminI18n();
  const [library, setLibrary] = useState<ModelImportLibrary | null>(null);
  const [importBusy, setImportBusy] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [selectedAssetPath, setSelectedAssetPath] = useState("");
  const [manualLora, setManualLora] = useState({ key: "", path: "", weight: "1" });
  const [showCivitai, setShowCivitai] = useState(false);
  const [importCivitaiLoras, setImportCivitaiLoras] = useState(false);
  const [civitaiText, setCivitaiText] = useState("");
  const [appliedInitialAssetPath, setAppliedInitialAssetPath] = useState("");
  const [civitaiStatus, setCivitaiStatus] = useState<{
    tone: "good" | "warn" | "bad";
    message: string;
  } | null>(null);
  const loraItems = useMemo(() => {
    try {
      return loraDraftsFromText(draft.lorasJson);
    } catch {
      return [];
    }
  }, [draft.lorasJson]);

  async function refreshImports() {
    setImportBusy("refresh");
    setImportError(null);
    try {
      setLibrary(await apiGet<ModelImportLibrary>("/api/v1/admin/generation/model-imports"));
    } catch (loadError) {
      setImportError(loadError instanceof Error ? loadError.message : "Model library load failed");
    } finally {
      setImportBusy(null);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshImports();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!initialAssetPath || appliedInitialAssetPath === initialAssetPath || !library) return;
    const asset = library.items.find((item) => item.path === initialAssetPath);
    if (!asset) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      setSelectedAssetPath(asset.path);
      onDraftChange(applyModelImport(draft, asset));
      setAppliedInitialAssetPath(initialAssetPath);
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [appliedInitialAssetPath, draft, initialAssetPath, library, onDraftChange]);

  function useSelectedAsset() {
    const asset = library?.items.find((item) => item.path === selectedAssetPath);
    if (!asset) return;
    setAppliedInitialAssetPath(asset.path);
    onDraftChange(applyModelImport(draft, asset));
  }

  function setLoras(items: LoraDraft[]) {
    onDraftChange({ ...draft, lorasJson: loraDraftsToText(items) });
  }

  function clearLoras() {
    onDraftChange({ ...draft, loraModelDir: "", lorasJson: "[]" });
  }

  function addManualLora() {
    const key = manualLora.key.trim();
    const loraPath = manualLora.path.trim();
    if (!key && !loraPath) return;
    const weight = numberFromText(manualLora.weight, 1);
    setLoras([
      ...loraItems,
      {
        key,
        path: loraPath,
        fileName: loraPath ? loraPath.split("/").pop() : undefined,
        weight,
        enabled: true,
      },
    ]);
    setManualLora({ key: "", path: "", weight: "1" });
  }

  function applyCivitaiPaste(source: string) {
    if (!source.trim()) {
      setCivitaiStatus({ tone: "bad", message: t("Paste Civitai config first.") });
      return;
    }
    const result = applyCivitaiConfig(draft, source, library?.items ?? [], {
      includeLoras: importCivitaiLoras,
    });
    if (result.applied.length === 0) {
      setCivitaiStatus({ tone: "bad", message: t("No supported Civitai fields found.") });
      return;
    }
    onDraftChange(result.draft);
    setCivitaiStatus({
      tone: result.warnings.length ? "warn" : "good",
      message: [
        t("{count} fields applied", { count: result.applied.length }),
        ...result.warnings.map((warning) => t(warning)),
      ].join(" · "),
    });
  }

  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      setCivitaiText(text);
      applyCivitaiPaste(text);
    } catch {
      setCivitaiStatus({ tone: "bad", message: t("Clipboard read failed. Paste manually.") });
    }
  }

  const selectedAsset = library?.items.find((item) => item.path === selectedAssetPath);
  const selectedTemplate =
    modelProfileTemplates.find((template) => template.id === draft.profileTemplate) ?? fallbackModelProfileTemplate;
  const modelAssetOptions = library?.items.filter((item) => item.kind === "model") ?? [];
  const requiresModelFile = draft.runner === "sd_cpp" || draft.runner === "comfyui";
  const requiresSdcppComponents = draft.runner === "sd_cpp";
  const hasMainModel =
    !requiresModelFile || Boolean(draft.sourceModelPath.trim() || draft.diffusionModelPath.trim());
  const hasConversionTarget =
    draft.runner !== "sd_cpp" || !draft.conversionEnabled || Boolean(draft.convertedModelPath.trim());
  const hasComponents = !requiresSdcppComponents || Boolean(draft.llmPath.trim() && draft.vaePath.trim());
  const hasValidLorasJson = useMemo(() => {
    try {
      jsonArrayFromText(draft.lorasJson);
      return true;
    } catch {
      return false;
    }
  }, [draft.lorasJson]);
  const usableLoraItems = useMemo(() => loraItems.filter(isSubmittableLora), [loraItems]);
  const incompleteLoraCount = loraItems.length - usableLoraItems.length;
  const canCreate = canCreateModelProfile(draft) && hasValidLorasJson;
  const civitaiExpanded = showCivitai || Boolean(civitaiText.trim() || civitaiStatus);
  const readinessItems = [
    { label: "Built-in template selected", passed: Boolean(selectedTemplate) },
    { label: "Main model selected", passed: hasMainModel },
    { label: "Conversion target ready", passed: hasConversionTarget },
    { label: "Runner components configured", passed: hasComponents },
    { label: "LoRA optional", passed: hasValidLorasJson },
    { label: "Draft can be created", passed: canCreate },
  ];
  const libraryCount = library?.items.length ?? 0;

  return (
    <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
      <div className="border-b border-[var(--ad-border)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase text-[var(--ad-text-muted)]">
              {t("sdcpp operations")}
            </p>
            <h2 className="mt-1 text-lg font-semibold">{t("Generation profile setup")}</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--ad-text-muted)]">
              {t("Select an imported model, tune generation defaults, then create a draft for dry run and publish.")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="rounded-md inline-flex h-9 items-center gap-2 border border-[var(--ad-border)] px-3 text-sm text-[var(--ad-text)] hover:bg-black/[0.04] disabled:opacity-50"
              disabled={importBusy === "refresh"}
              onClick={() => void refreshImports()}
              type="button"
            >
              {importBusy === "refresh" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCcw className="h-4 w-4" />
              )}
              {t("Refresh library")}
            </button>
            <button
              className="inline-flex h-9 items-center gap-2 bg-[var(--ad-ink)] px-3 text-sm font-semibold text-white disabled:opacity-50"
              disabled={busy || !canCreate}
              onClick={onCreate}
              type="button"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {t("Create Draft")}
            </button>
          </div>
        </div>

        <div className="mt-4 grid gap-2 lg:grid-cols-3">
          <WorkflowStep
            active={!selectedTemplate}
            index={1}
            meta={selectedTemplate ? t(selectedTemplate.label) : t("Choose a template")}
            title={t("Choose template")}
          />
          <WorkflowStep
            active={Boolean(selectedTemplate) && !hasMainModel}
            index={2}
            meta={hasMainModel ? pathFileName(draft.sourceModelPath || draft.diffusionModelPath) : t("Waiting for main model")}
            title={t("Select model")}
          />
          <WorkflowStep
            active={hasMainModel && (!hasConversionTarget || !hasComponents)}
            index={3}
            meta={usableLoraItems.length ? t("{count} LoRA attached", { count: usableLoraItems.length }) : t("No LoRA")}
            title={t("Review configuration")}
          />
          <WorkflowStep
            active={canCreate}
            index={4}
            meta={canCreate ? t("Draft is ready") : t("Complete required checks")}
            title={t("Create and dry run")}
          />
        </div>
      </div>

      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-4">
          <section className="rounded-lg border border-[var(--ad-border)] bg-black/[0.03] p-3">
            <SectionHeader
              description="Start from the consistency path, then adjust only what this model needs."
              eyebrow="Step 1"
              title="Built-in generation template"
            />
            <div className="mt-3 grid gap-2 lg:grid-cols-4">
              {modelProfileTemplates.map((template) => {
                const selected = template.id === draft.profileTemplate;
                return (
                  <button
                    aria-pressed={selected}
                    className="rounded-md min-h-28 border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3 text-left hover:bg-black/[0.04] aria-pressed:border-[var(--ad-ink)] aria-pressed:bg-[var(--ad-ink)] aria-pressed:text-white"
                    key={template.id}
                    onClick={() => onDraftChange(applyModelProfileTemplate(draft, template.id))}
                    type="button"
                  >
                    <span className="block text-sm font-semibold">{t(template.label)}</span>
                    <span className={cn("mt-2 block text-xs leading-5", selected ? "text-white/70" : "text-[var(--ad-text-muted)]")}>
                      {t(template.description)}
                    </span>
                    <span className={cn("mt-3 block font-mono text-[11px]", selected ? "text-white/60" : "text-[var(--ad-text-muted)]")}>
                      {template.intent}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <div className="rounded-lg border border-[var(--ad-border)] bg-black/[0.03] p-3">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">{t("Select model from library")}</h3>
                <p className="mt-1 max-w-2xl text-xs leading-5 text-[var(--ad-text-muted)]">
                  {t("Engineering imports are hidden diagnostics; default Admin uses seeded profiles.")}
                </p>
              </div>
              <Link
                className="rounded-md inline-flex h-8 items-center gap-2 border border-[var(--ad-border)] px-2 text-xs text-[var(--ad-text)] hover:bg-black/[0.04]"
                href="/admin/generation/config"
              >
                <Library className="h-4 w-4" />
                {t("Open Model Profiles")}
              </Link>
            </div>
            {importError ? (
              <div className="rounded-lg mb-3 border border-[var(--ad-red-text)]/20 bg-[var(--ad-red-bg)] px-3 py-2 text-xs text-[var(--ad-red-text)]">
                {importError}
              </div>
            ) : null}
            <div className="grid gap-2 md:grid-cols-[1fr_auto]">
              <label className="block min-w-0">
                <span className="sr-only">{t("Select from model library")}</span>
                <select
                  aria-label={t("Select from model library")}
                  className="rounded-md h-10 w-full min-w-0 border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
                  onChange={(event) => setSelectedAssetPath(event.target.value)}
                  value={selectedAssetPath}
                >
                  <option value="">{t("Select from model library")}</option>
                  {modelAssetOptions.map((asset) => (
                    <option key={asset.path} value={asset.path}>
                      {asset.name} · {asset.format} · {formatBytes(asset.sizeBytes)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="inline-flex h-10 items-center justify-center gap-2 bg-[var(--ad-ink)] px-3 text-sm font-semibold text-white disabled:opacity-50"
                disabled={!selectedAsset}
                onClick={useSelectedAsset}
                type="button"
              >
                <Check className="h-4 w-4" />
                {t("Use")}
              </button>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--ad-text-muted)]">
              <span>{selectedAsset ? `${selectedAsset.kind} · ${selectedAsset.path}` : t("No model asset selected")}</span>
              {library ? <span>· {t("{count} assets", { count: libraryCount })}</span> : null}
              {importBusy === "refresh" ? <span>· {t("Loading…")}</span> : null}
              <button
                className="rounded-md ml-auto inline-flex h-7 items-center gap-1 border border-[var(--ad-border)] px-2 text-[11px] text-[var(--ad-text)] hover:bg-black/[0.04] disabled:opacity-50"
                disabled={importBusy === "refresh"}
                onClick={() => void refreshImports()}
                type="button"
              >
                <RefreshCcw className="h-3 w-3" />
                {t("Refresh library")}
              </button>
            </div>
            {modelAssetOptions.length === 0 ? (
              <div className="rounded-lg mt-3 border border-[var(--ad-yellow-text)]/20 bg-[var(--ad-yellow-bg)] px-3 py-2 text-xs leading-5 text-[var(--ad-yellow-text)]">
                {t("No diagnostic model assets available. Default Admin uses seeded profiles.")}
              </div>
            ) : null}
          </div>

          <section className="rounded-lg border border-[var(--ad-border)] bg-black/[0.03]">
            <button
              aria-expanded={civitaiExpanded}
              className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left hover:bg-black/[0.04]"
              onClick={() => setShowCivitai(!civitaiExpanded)}
              type="button"
            >
              <span>
                <span className="block text-xs font-semibold uppercase text-[var(--ad-text-muted)]">
                  {t("Optional")}
                </span>
                <span className="mt-1 block text-sm font-semibold">{t("Civitai config paste")}</span>
                <span className="mt-1 block text-xs leading-5 text-[var(--ad-text-muted)]">
                  {t("Paste Civitai metadata when you want to prefill generation defaults.")}
                </span>
              </span>
              <ChevronRight className={cn("h-4 w-4 shrink-0 transition-transform", civitaiExpanded && "rotate-90")} />
            </button>
            {civitaiExpanded ? (
              <div className="border-t border-[var(--ad-border)] p-3">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <label className="rounded-md inline-flex h-8 items-center gap-2 border border-[var(--ad-border)] px-2 text-xs text-[var(--ad-text)]">
                    <input
                      checked={importCivitaiLoras}
                      className="h-3 w-3 accent-[var(--ad-ink)]"
                      onChange={(event) => setImportCivitaiLoras(event.target.checked)}
                      type="checkbox"
                    />
                    {t("Import LoRA tags")}
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <button
                      className="rounded-md inline-flex h-8 items-center gap-2 border border-[var(--ad-border)] px-2 text-xs text-[var(--ad-text)] hover:bg-black/[0.04]"
                      onClick={() => void pasteFromClipboard()}
                      type="button"
                    >
                      <ClipboardCheck className="h-4 w-4" />
                      {t("Paste from clipboard")}
                    </button>
                    <button
                      className="inline-flex h-8 items-center gap-2 bg-[var(--ad-ink)] px-2 text-xs font-semibold text-white disabled:opacity-50"
                      disabled={!civitaiText.trim()}
                      onClick={() => applyCivitaiPaste(civitaiText)}
                      type="button"
                    >
                      <Check className="h-4 w-4" />
                      {t("Apply Civitai config")}
                    </button>
                  </div>
                </div>
                <textarea
                  className="rounded-md min-h-24 w-full resize-y border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 py-2 font-mono text-xs outline-none placeholder:text-[var(--ad-text-muted)] focus:border-[var(--ad-ink)]"
                  onChange={(event) => {
                    setCivitaiText(event.target.value);
                    setCivitaiStatus(null);
                  }}
                  placeholder={t("Paste Civitai generation data or JSON here")}
                  value={civitaiText}
                />
                {civitaiStatus ? (
                  <p
                    className={cn(
                      "mt-2 text-xs leading-5",
                      civitaiStatus.tone === "good" && "text-[var(--ad-green-text)]",
                      civitaiStatus.tone === "warn" && "text-[var(--ad-yellow-text)]",
                      civitaiStatus.tone === "bad" && "text-[var(--ad-red-text)]",
                    )}
                  >
                    {civitaiStatus.message}
                  </p>
                ) : null}
              </div>
            ) : null}
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-lg border border-[var(--ad-border)] bg-black/[0.03] p-3">
              <SectionHeader
                description="This is what operators will find later in dry run, publish, and rollback tables."
                eyebrow="Step 2"
                title="Profile identity"
              />
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
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
              </div>
            </section>

            <section className="rounded-lg border border-[var(--ad-border)] bg-black/[0.03] p-3">
              <SectionHeader
                description="Keep the common operating knobs visible; deeper runner details are below."
                eyebrow="Step 3"
                title="Generation defaults"
              />
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
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
                <SamplerSelect
                  label="Sampler"
                  onChange={(value) => onDraftChange({ ...draft, sampler: value })}
                  value={draft.sampler}
                />
                <SchedulerSelect
                  label="Scheduler"
                  onChange={(value) => onDraftChange({ ...draft, scheduler: value })}
                  value={draft.scheduler}
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
                <div className="sm:col-span-2">
                  <FormField
                    label="Orientations"
                    onChange={(value) => onDraftChange({ ...draft, allowedOrientations: value })}
                    value={draft.allowedOrientations}
                  />
                </div>
              </div>
            </section>
          </div>

          <section className="rounded-lg border border-[var(--ad-border)] bg-black/[0.03] p-3">
            <SectionHeader
              description="Review the generated source paths and GGUF output before draft creation."
              eyebrow="Step 4"
              title="Model components and conversion"
            />
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <FormField
                label="Source Model"
                onChange={(value) => onDraftChange({ ...draft, sourceModelPath: value })}
                value={draft.sourceModelPath}
              />
              <FormField
                label="Diffusion Model"
                onChange={(value) => onDraftChange({ ...draft, diffusionModelPath: value })}
                value={draft.diffusionModelPath}
              />
              <FormField
                label="LLM Encoder"
                onChange={(value) => onDraftChange({ ...draft, llmPath: value })}
                value={draft.llmPath}
              />
              <FormField
                label="LLM Vision Encoder"
                onChange={(value) => onDraftChange({ ...draft, llmVisionPath: value })}
                value={draft.llmVisionPath}
              />
              <FormField
                label="VAE"
                onChange={(value) => onDraftChange({ ...draft, vaePath: value })}
                value={draft.vaePath}
              />
              <FormField
                label="Backend"
                onChange={(value) => onDraftChange({ ...draft, backend: value })}
                value={draft.backend}
              />
              <FormField
                label="Converted Model"
                onChange={(value) => onDraftChange({ ...draft, convertedModelPath: value })}
                value={draft.convertedModelPath}
              />
              <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
                <FormField
                  label="Conversion Type"
                  onChange={(value) => onDraftChange({ ...draft, conversionType: value })}
                  value={draft.conversionType}
                />
                <FormSelect
                  label="Convert Source"
                  onChange={(value) => onDraftChange({ ...draft, conversionSourceArg: value as ModelDraft["conversionSourceArg"] })}
                  options={["model", "diffusion-model"]}
                  value={draft.conversionSourceArg}
                />
                <button
                  aria-pressed={draft.conversionEnabled}
                  className="rounded-md flex h-10 items-center justify-center gap-2 self-end border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-left text-sm text-[var(--ad-text)] aria-pressed:bg-[var(--ad-ink)] aria-pressed:text-white"
                  onClick={() => onDraftChange({ ...draft, conversionEnabled: !draft.conversionEnabled })}
                  type="button"
                >
                  <span className="rounded-lg grid h-4 w-4 place-items-center border border-current">
                    {draft.conversionEnabled ? <Check className="h-3 w-3" /> : null}
                  </span>
                  <span>{t("Convert to GGUF")}</span>
                </button>
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-[var(--ad-border)] bg-black/[0.03] p-3">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
              <SectionHeader
                description="Attach optional style or character adapters without editing runner JSON."
                eyebrow="Step 5"
                title="LoRA stack"
              />
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-lg border border-[var(--ad-border)] px-2 py-1 text-[11px] text-[var(--ad-text-muted)]">
                  {usableLoraItems.length
                    ? t("{count} LoRA attached", { count: usableLoraItems.length })
                    : t("No LoRA")}
                </span>
                {incompleteLoraCount > 0 ? (
                  <span className="rounded-lg border border-[var(--ad-yellow-text)]/20 bg-[var(--ad-yellow-bg)] px-2 py-1 text-[11px] text-[var(--ad-yellow-text)]">
                    {t("{count} incomplete LoRA skipped", { count: incompleteLoraCount })}
                  </span>
                ) : null}
                <button
                  className="rounded-md inline-flex h-7 items-center gap-1 border border-[var(--ad-border)] px-2 text-[11px] text-[var(--ad-text)] hover:bg-black/[0.04] disabled:opacity-50"
                  disabled={loraItems.length === 0}
                  onClick={clearLoras}
                  type="button"
                >
                  <Trash2 className="h-3 w-3" />
                  {t("Clear LoRA")}
                </button>
              </div>
            </div>
            <div className="rounded-lg border border-[var(--ad-border)] bg-black/[0.03]">
              <div className="grid gap-2 border-b border-[var(--ad-border)] p-2 md:grid-cols-[1fr_1.5fr_96px_auto]">
                <label className="block">
                  <span className="sr-only">{t("LoRA key")}</span>
                  <input
                    aria-label={t("LoRA key")}
                    className="rounded-md h-9 w-full min-w-0 border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
                    onChange={(event) => setManualLora({ ...manualLora, key: event.target.value })}
                    placeholder={t("LoRA key")}
                    value={manualLora.key}
                  />
                </label>
                <label className="block">
                  <span className="sr-only">{t("LoRA file path")}</span>
                  <input
                    aria-label={t("LoRA file path")}
                    className="rounded-md h-9 w-full min-w-0 border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
                    onChange={(event) => setManualLora({ ...manualLora, path: event.target.value })}
                    placeholder={t("LoRA file path")}
                    value={manualLora.path}
                  />
                </label>
                <label className="block">
                  <span className="sr-only">{t("Weight")}</span>
                  <input
                    aria-label={t("Weight")}
                    className="rounded-md h-9 w-full min-w-0 border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
                    onChange={(event) => setManualLora({ ...manualLora, weight: event.target.value })}
                    placeholder={t("Weight")}
                    value={manualLora.weight}
                  />
                </label>
                <button
                  className="rounded-md inline-flex h-9 items-center justify-center gap-2 border border-[var(--ad-border)] px-3 text-sm text-[var(--ad-text)] hover:bg-black/[0.04]"
                  onClick={addManualLora}
                  type="button"
                >
                  <Plus className="h-4 w-4" />
                  {t("Add LoRA")}
                </button>
              </div>
              <div className="max-h-52 overflow-y-auto">
                {loraItems.map((item, index) => (
                  <div
                    className="grid gap-2 border-b border-[var(--ad-border)] p-2 text-xs last:border-0 md:grid-cols-[1fr_1.5fr_84px_84px]"
                    key={`${item.path || item.key}-${index}`}
                  >
                    <input
                      aria-label={t("LoRA key")}
                      className="rounded-md h-8 min-w-0 border border-[var(--ad-border)] bg-[var(--ad-surface)] px-2 outline-none focus:border-[var(--ad-ink)]"
                      onChange={(event) => {
                        const next = [...loraItems];
                        next[index] = { ...item, key: event.target.value };
                        setLoras(next);
                      }}
                      value={item.key}
                    />
                    <input
                      aria-label={t("LoRA file path")}
                      className="rounded-md h-8 min-w-0 border border-[var(--ad-border)] bg-[var(--ad-surface)] px-2 font-mono outline-none focus:border-[var(--ad-ink)]"
                      onChange={(event) => {
                        const next = [...loraItems];
                        next[index] = { ...item, path: event.target.value };
                        setLoras(next);
                      }}
                      value={item.path}
                    />
                    <input
                      aria-label={t("Weight")}
                      className="rounded-md h-8 min-w-0 border border-[var(--ad-border)] bg-[var(--ad-surface)] px-2 outline-none focus:border-[var(--ad-ink)]"
                      onChange={(event) => {
                        const next = [...loraItems];
                        next[index] = { ...item, weight: numberFromText(event.target.value, item.weight) };
                        setLoras(next);
                      }}
                      value={String(item.weight)}
                    />
                    <div className="flex gap-1">
                      <button
                        aria-label={item.enabled ? t("Disable LoRA") : t("Enable LoRA")}
                        aria-pressed={item.enabled}
                        className="rounded-md grid h-8 w-8 place-items-center border border-[var(--ad-border)] text-[var(--ad-text)] hover:bg-black/[0.04] aria-pressed:bg-[var(--ad-ink)] aria-pressed:text-white"
                        onClick={() => {
                          const next = [...loraItems];
                          next[index] = { ...item, enabled: !item.enabled };
                          setLoras(next);
                        }}
                        title={item.enabled ? t("Disable LoRA") : t("Enable LoRA")}
                        type="button"
                      >
                        <Check className="h-4 w-4" />
                      </button>
                      <button
                        aria-label={t("Remove LoRA")}
                        className="rounded-lg grid h-8 w-8 place-items-center border border-[var(--ad-border)] text-[var(--ad-text-muted)] hover:bg-black/[0.04]"
                        onClick={() => setLoras(loraItems.filter((_, childIndex) => childIndex !== index))}
                        title={t("Remove LoRA")}
                        type="button"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}
                {loraItems.length === 0 ? (
                  <div className="px-3 py-6 text-center text-xs text-[var(--ad-text-muted)]">
                    {t("No LoRA models added. This model will run without LoRA.")}
                  </div>
                ) : null}
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-[var(--ad-border)] bg-black/[0.03]">
            <button
              aria-expanded={showAdvanced}
              className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left text-sm font-semibold text-[var(--ad-text)] hover:bg-black/[0.04]"
              onClick={() => setShowAdvanced(!showAdvanced)}
              type="button"
            >
              <span>{t("Advanced runner details")}</span>
              <ChevronRight className={cn("h-4 w-4 transition-transform", showAdvanced && "rotate-90")} />
            </button>
            {showAdvanced ? (
              <div className="grid gap-3 border-t border-[var(--ad-border)] p-3 md:grid-cols-2">
                <FormField
                  label="LoRA Dir"
                  onChange={(value) => onDraftChange({ ...draft, loraModelDir: value })}
                  value={draft.loraModelDir}
                />
                <FormSelect
                  label="LoRA Apply"
                  onChange={(value) => onDraftChange({ ...draft, loraApplyMode: value as ModelDraft["loraApplyMode"] })}
                  options={["auto", "immediately", "at_runtime"]}
                  value={draft.loraApplyMode}
                />
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-[var(--ad-text-muted)]">
                    {t("Runner Config")}
                  </span>
                  <textarea
                    className="rounded-md min-h-20 w-full resize-y border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--ad-ink)]"
                    onChange={(event) => onDraftChange({ ...draft, runnerConfigJson: event.target.value })}
                    value={draft.runnerConfigJson}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-[var(--ad-text-muted)]">
                    {t("LoRA JSON")}
                  </span>
                  <textarea
                    className={cn(
                      "rounded-md min-h-20 w-full resize-y border bg-[var(--ad-surface)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--ad-ink)]",
                      hasValidLorasJson ? "border-[var(--ad-border)]" : "border-[var(--ad-red-text)]/20",
                    )}
                    onChange={(event) => onDraftChange({ ...draft, lorasJson: event.target.value })}
                    value={draft.lorasJson}
                  />
                </label>
              </div>
            ) : null}
          </section>
        </div>

        <aside className="space-y-4 xl:sticky xl:top-20 xl:self-start">
          <section className="rounded-lg border border-[var(--ad-border)] bg-black/[0.03] p-3">
            <h3 className="text-sm font-semibold">{t("Draft readiness")}</h3>
            <div className="mt-3 space-y-2">
              {readinessItems.map((item) => (
                <ReadinessItem key={item.label} label={t(item.label)} passed={item.passed} />
              ))}
            </div>
            <button
              className="mt-4 inline-flex h-10 w-full items-center justify-center gap-2 bg-[var(--ad-ink)] px-3 text-sm font-semibold text-white disabled:opacity-50"
              disabled={busy || !canCreate}
              onClick={onCreate}
              type="button"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {t("Create Draft")}
            </button>
            <p className="mt-2 text-xs leading-5 text-[var(--ad-text-muted)]">
              {t("After creation, the draft appears in Drafts for testing and publish.")}
            </p>
          </section>
          <section className="rounded-lg border border-[var(--ad-border)] bg-black/[0.03] p-3">
            <h3 className="text-sm font-semibold">{t("Current draft summary")}</h3>
            <div className="mt-3 space-y-3 text-xs">
              <SummaryRow label="Profile" value={draft.profileKey || "-"} />
              <SummaryRow
                label="Main model"
                value={pathFileName(draft.sourceModelPath || draft.diffusionModelPath) || "-"}
              />
              <SummaryRow label="Format" value={draft.modelFormat} />
              <SummaryRow
                label="GGUF target"
                value={draft.conversionEnabled ? pathFileName(draft.convertedModelPath) || "-" : t("Disabled")}
              />
              <SummaryRow
                label="LoRA"
                value={usableLoraItems.length ? t("{count} LoRA attached", { count: usableLoraItems.length }) : t("No LoRA")}
              />
              <SummaryRow label="Size" value={`${draft.defaultWidth} x ${draft.defaultHeight}`} />
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}

function WorkflowStep({
  active,
  index,
  meta,
  title,
}: {
  active: boolean;
  index: number;
  meta: string;
  title: string;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-[var(--ad-border)] bg-black/[0.03] p-3",
        active && "border-[var(--ad-ink)] bg-black/[0.04]",
      )}
    >
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "rounded-lg grid h-7 w-7 place-items-center border border-[var(--ad-border)] font-mono text-xs text-[var(--ad-text-muted)]",
            active && "border-[var(--ad-ink)] bg-[var(--ad-ink)] text-white",
          )}
        >
          {index}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[var(--ad-text)]">{title}</p>
          <p className="mt-0.5 truncate text-xs text-[var(--ad-text-muted)]">{meta}</p>
        </div>
      </div>
    </div>
  );
}

function SectionHeader({
  description,
  eyebrow,
  title,
}: {
  description: string;
  eyebrow: string;
  title: string;
}) {
  const { t } = useAdminI18n();

  return (
    <div>
      <p className="text-[11px] font-semibold uppercase text-[var(--ad-text-muted)]">{t(eyebrow)}</p>
      <h3 className="mt-1 text-sm font-semibold">{t(title)}</h3>
      <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">{t(description)}</p>
    </div>
  );
}

function TextPanel({ label, value }: { label: string; value: string }) {
  const { t } = useAdminI18n();
  return (
    <div className="rounded-lg border border-[var(--ad-border)] bg-black/[0.03] p-3">
      <p className="text-xs font-semibold uppercase text-[var(--ad-text-muted)]">{t(label)}</p>
      <p className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-6 text-[var(--ad-text)]">
        {value || "-"}
      </p>
    </div>
  );
}

function SafeImagePreview({ alt, src }: { alt: string; src: string }) {
  const { t } = useAdminI18n();
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let nextObjectUrl: string | null = null;
    if (!src) {
      const missingTimer = window.setTimeout(() => {
        if (!cancelled) setFailed(true);
      }, 0);
      return () => {
        cancelled = true;
        window.clearTimeout(missingTimer);
      };
    }

    const resetTimer = window.setTimeout(() => {
      if (cancelled) return;
      setObjectUrl(null);
      setFailed(false);
    }, 0);

    void fetch(src, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`Image unavailable: ${response.status}`);
        return response.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        nextObjectUrl = URL.createObjectURL(blob);
        setObjectUrl(nextObjectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      window.clearTimeout(resetTimer);
      if (nextObjectUrl) URL.revokeObjectURL(nextObjectUrl);
    };
  }, [src]);

  if (objectUrl) {
    return (
      // Generated admin assets may be local blob URLs or transient signed URLs; Next Image cannot optimize them reliably.
      // eslint-disable-next-line @next/next/no-img-element
      <img alt={alt} className="aspect-[4/5] w-full object-cover" src={objectUrl} />
    );
  }

  return (
    <div className="grid aspect-[4/5] place-items-center bg-[var(--ad-surface)] px-4 text-center text-xs text-[var(--ad-text-muted)]">
      {failed ? t("Asset unavailable") : t("Checking asset")}
    </div>
  );
}

function ReadinessItem({ label, passed }: { label: string; passed: boolean }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span
        className={cn(
          "rounded-lg grid h-5 w-5 place-items-center border",
          passed
            ? "border-[var(--ad-green-text)]/20 bg-[var(--ad-green-bg)] text-[var(--ad-green-text)]"
            : "border-[var(--ad-border)] text-[var(--ad-text-muted)]",
        )}
      >
        {passed ? <Check className="h-3 w-3" /> : null}
      </span>
      <span className={passed ? "text-[var(--ad-text)]" : "text-[var(--ad-text-muted)]"}>{label}</span>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  const { t } = useAdminI18n();

  return (
    <div className="grid min-w-0 grid-cols-[76px_minmax(0,1fr)] gap-3 sm:grid-cols-[96px_minmax(0,1fr)]">
      <span className="text-[var(--ad-text-muted)]">{t(label)}</span>
      <span className="min-w-0 truncate font-mono text-[var(--ad-text)]" title={value}>
        {value}
      </span>
    </div>
  );
}

function ProfileVerificationPanel({
  compact = false,
  summary,
}: {
  compact?: boolean;
  summary: ProfileVerificationSummary;
}) {
  const { locale, t } = useAdminI18n();
  const shouldShowComponents = !compact || summary.blockedReason || summary.failureMode;

  return (
    <div
      className={cn(
        "rounded-lg mt-3 border px-3 py-2 text-xs",
        summary.blockedReason
          ? "border-[var(--ad-red-text)]/20 bg-[var(--ad-red-bg)]"
          : "border-[var(--ad-border)] bg-black/[0.03]",
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-[var(--ad-text)]">{t("Model verification")}</span>
        <Status locale={locale} value={summary.status} tone={summary.tone} />
      </div>
      <p className="mt-1 break-words leading-5 text-[var(--ad-text-muted)]">{t(summary.meta)}</p>
      {summary.failureMode ? (
        <p className="mt-1 break-all leading-5 text-[var(--ad-red-text)]">
          {t("Failure mode")}: {summary.failureMode}
        </p>
      ) : null}
      {summary.blockedReason ? (
        <p className="mt-1 leading-5 text-[var(--ad-red-text)]">{t(summary.blockedReason)}</p>
      ) : null}
      {shouldShowComponents && summary.components.length > 0 ? (
        <div className="mt-2 grid gap-1">
          {summary.components.slice(0, compact ? 3 : 8).map((component) => (
            <div className="flex min-w-0 items-center justify-between gap-2" key={component.key}>
              <span className="min-w-0 truncate text-[var(--ad-text-muted)]" title={component.key}>
                {component.key}
              </span>
              <Status locale={locale} value={component.status} tone={component.tone} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function pathFileName(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.split("/").filter(Boolean).pop() ?? trimmed;
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
  const { t } = useAdminI18n();

  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-[var(--ad-text-muted)]">{t(label)}</span>
      <input
        className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
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
  const { t, value: valueLabel } = useAdminI18n();

  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-[var(--ad-text-muted)]">{t(label)}</span>
      <select
        className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {valueLabel(option)}
          </option>
        ))}
      </select>
    </label>
  );
}

function SamplerSelect({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const { t } = useAdminI18n();
  const normalizedValue = samplerOptions.some((option) => option.value === value) ? value : "euler";

  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-[var(--ad-text-muted)]">{t(label)}</span>
      <select
        className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
        onChange={(event) => onChange(event.target.value)}
        value={normalizedValue}
      >
        {samplerOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function SchedulerSelect({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const { t } = useAdminI18n();
  const normalizedValue = schedulerOptions.some((option) => option.value === value) ? value : "model_default";

  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-[var(--ad-text-muted)]">{t(label)}</span>
      <select
        className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
        onChange={(event) => onChange(event.target.value)}
        value={normalizedValue}
      >
        {schedulerOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
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
        actions={(row) => {
          const id = stringValue(row.id);
          return (
            <div className="flex flex-wrap gap-1">
              <IconAction
                icon={<Check className="h-4 w-4" />}
                label="Uphold"
                onClick={() =>
                  openAction({
                    title: `Uphold appeal ${id}`,
                    endpoint: `/api/v1/admin/moderation/appeals/${id}`,
                    method: "PATCH",
                    confirmText: "UPHOLD",
                    reasonRequired: true,
                    body: (actionReason, confirmation) => ({
                      outcome: "upheld",
                      notes: actionReason,
                      reason: actionReason,
                      confirmation,
                    }),
                  })
                }
              />
              <IconAction
                icon={<RotateCcw className="h-4 w-4" />}
                label="Overturn"
                onClick={() =>
                  openAction({
                    title: `Overturn appeal ${id}`,
                    endpoint: `/api/v1/admin/moderation/appeals/${id}`,
                    method: "PATCH",
                    confirmText: "OVERTURN",
                    reasonRequired: true,
                    body: (actionReason, confirmation) => ({
                      outcome: "overturned",
                      notes: actionReason,
                      reason: actionReason,
                      confirmation,
                    }),
                  })
                }
              />
              <IconAction
                icon={<ClipboardCheck className="h-4 w-4" />}
                label="Modify"
                onClick={() =>
                  openAction({
                    title: `Modify appeal ${id}`,
                    endpoint: `/api/v1/admin/moderation/appeals/${id}`,
                    method: "PATCH",
                    confirmText: "MODIFY",
                    reasonRequired: true,
                    body: (actionReason, confirmation) => ({
                      outcome: "modified",
                      notes: actionReason,
                      reason: actionReason,
                      confirmation,
                    }),
                  })
                }
              />
            </div>
          );
        }}
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
  permissionForm,
  setPermissionForm,
}: {
  rows: Row[];
  openAction: (action: PendingAction) => void;
  permissionForm: PermissionForm;
  setPermissionForm: (value: PermissionForm) => void;
}) {
  const { t, value: valueLabel } = useAdminI18n();

  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
        <h2 className="mb-1 text-sm font-semibold">{t("Permission override")}</h2>
        <p className="mb-3 text-xs text-[var(--ad-text-muted)]">
          按 user 精确 grant / revoke / clear 单个 permission key（不动 role）。admin only，写审计。
        </p>
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_140px_auto]">
          <input
            aria-label={t("Permission user ID")}
            className="rounded-md h-10 border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
            onChange={(event) => setPermissionForm({ ...permissionForm, userId: event.target.value })}
            placeholder={t("User ID")}
            value={permissionForm.userId}
          />
          <select
            aria-label={t("Permission key")}
            className="rounded-md h-10 border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
            onChange={(event) =>
              setPermissionForm({ ...permissionForm, permissionKey: event.target.value })
            }
            value={permissionForm.permissionKey}
          >
            {ADMIN_PERMISSION_KEYS.map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
          <select
            aria-label={t("Permission effect")}
            className="rounded-md h-10 border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
            onChange={(event) =>
              setPermissionForm({
                ...permissionForm,
                effect: event.target.value as PermissionForm["effect"],
              })
            }
            value={permissionForm.effect}
          >
            {["grant", "revoke", "clear"].map((effect) => (
              <option key={effect} value={effect}>
                {valueLabel(effect)}
              </option>
            ))}
          </select>
          <button
            className="inline-flex h-10 items-center justify-center gap-2 bg-[var(--ad-ink)] px-3 text-sm font-semibold text-white disabled:opacity-50"
            disabled={!permissionForm.userId.trim()}
            onClick={() => {
              const targetUserId = permissionForm.userId.trim();
              const confirmationTarget = `${targetUserId}:${permissionForm.permissionKey}:${permissionForm.effect}`;
              openAction({
                title: `${permissionForm.effect} ${permissionForm.permissionKey}`,
                endpoint: `/api/v1/admin/users/${targetUserId}/permissions`,
                method: "POST",
                confirmText: confirmationTarget,
                reasonRequired: true,
                body: (actionReason, actionConfirmation) => ({
                  permissionKey: permissionForm.permissionKey,
                  effect: permissionForm.effect,
                  reason: actionReason,
                  confirmation: actionConfirmation,
                }),
              });
            }}
            type="button"
          >
            <ShieldCheck className="h-4 w-4" />
            {t("Apply")}
          </button>
        </div>
      </section>
      <DataTable
        actions={(row) => {
          const id = stringValue(row.id);
          const status = stringValue(row.status);
          const nextStatus = status === "suspended" ? "active" : "suspended";
          const confirmationTarget = `${id}:${nextStatus}`;
          return (
            <IconAction
              icon={nextStatus === "active" ? <Check className="h-4 w-4" /> : <Ban className="h-4 w-4" />}
              label={nextStatus === "active" ? "Restore" : "Suspend"}
              onClick={() =>
                openAction({
                  title: `${nextStatus === "active" ? "Restore" : "Suspend"} ${id}`,
                  endpoint: `/api/v1/admin/users/${id}/status`,
                  method: "POST",
                  confirmText: confirmationTarget,
                  reasonRequired: true,
                  body: (actionReason, actionConfirmation) => ({
                    status: nextStatus,
                    reason: actionReason,
                    confirmation: actionConfirmation,
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
    </div>
  );
}

function BillingView({
  rows,
  subscriptions,
  reconciliation,
  adjustment,
  setAdjustment,
  openAction,
}: {
  rows: Row[];
  subscriptions: Row[];
  reconciliation: ReconciliationData;
  adjustment: { userId: string; delta: string };
  setAdjustment: (value: { userId: string; delta: string }) => void;
  openAction: (action: PendingAction) => void;
}) {
  const { locale, t } = useAdminI18n();

  return (
    <div className="space-y-5">
      <div className="rounded-lg grid gap-px overflow-hidden border border-[var(--ad-border)] bg-black/[0.05] md:grid-cols-3">
        <Metric
          label="Net coins (window)"
          value={reconciliation.totals.net}
          meta={t("{count} ledger entries", { count: reconciliation.totals.entries })}
        />
        <Metric
          label="Active subscriptions"
          value={reconciliation.activeSubscriptions}
          meta="status = active"
        />
        <Metric
          label="Window"
          value={`${compactDate(reconciliation.window.from, locale)} →`}
          meta={compactDate(reconciliation.window.to, locale)}
        />
      </div>
      <DataTable
        columns={["reason", "totalDelta", "count"]}
        rows={reconciliation.byReason}
        title="Reconciliation by reason"
      />
      <DataTable
        columns={[
          "id",
          "userId",
          "userEmail",
          "plan",
          "billingPeriod",
          "provider",
          "status",
          "currentPeriodEnd",
          "cancelAtPeriodEnd",
        ]}
        rows={subscriptions}
        title="Subscriptions"
      />
      <div className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_140px_auto]">
          <input
            aria-label={t("Adjustment user ID")}
            className="rounded-md h-10 border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
            onChange={(event) => setAdjustment({ ...adjustment, userId: event.target.value })}
            placeholder={t("User ID")}
            value={adjustment.userId}
          />
          <input
            aria-label={t("Adjustment delta")}
            className="rounded-md h-10 border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
            inputMode="numeric"
            onChange={(event) => setAdjustment({ ...adjustment, delta: event.target.value })}
            placeholder={t("Delta")}
            value={adjustment.delta}
          />
          <button
            className="inline-flex h-10 items-center justify-center gap-2 bg-[var(--ad-ink)] px-3 text-sm font-semibold text-white disabled:opacity-50"
            disabled={!adjustment.userId || !Number.isFinite(Number(adjustment.delta))}
            onClick={() => {
              const userId = adjustment.userId.trim();
              const delta = Number(adjustment.delta);
              const confirmationTarget = `${userId}:${delta}`;
              openAction({
                title: `Adjust ledger ${userId}`,
                endpoint: "/api/v1/admin/billing/adjustments",
                method: "POST",
                confirmText: confirmationTarget,
                reasonRequired: true,
                body: (actionReason, actionConfirmation) => ({
                  userId,
                  delta,
                  reason: actionReason,
                  confirmation: actionConfirmation,
                }),
              });
            }}
            type="button"
          >
            <BadgeDollarSign className="h-4 w-4" />
            {t("Adjust")}
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

function PricingView({
  busy,
  draft,
  onCreate,
  onDraftChange,
  openAction,
  rows,
}: {
  busy: boolean;
  draft: PricingDraft;
  onCreate: () => void;
  onDraftChange: (value: PricingDraft) => void;
  openAction: (action: PendingAction) => void;
  rows: Row[];
}) {
  const { t } = useAdminI18n();

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">{t("Create Pricing Rule Draft")}</h2>
            <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
              改价走 draft → publish 版本化发布；发布即归档同 mode 旧 active，可一键 rollback。
            </p>
          </div>
          <button
            className="inline-flex h-9 items-center gap-2 bg-[var(--ad-ink)] px-3 text-sm font-semibold text-white disabled:opacity-50"
            disabled={busy || !canCreatePricingRule(draft)}
            onClick={onCreate}
            type="button"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {t("Create Draft")}
          </button>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-7">
          <FormField
            label="Rule Key"
            onChange={(value) => onDraftChange({ ...draft, ruleKey: value })}
            value={draft.ruleKey}
          />
          <FormField
            label="Label"
            onChange={(value) => onDraftChange({ ...draft, label: value })}
            value={draft.label}
          />
          <FormSelect
            label="Mode"
            onChange={(value) => onDraftChange({ ...draft, mode: value as PricingDraft["mode"] })}
            options={["image", "video", "voice"]}
            value={draft.mode}
          />
          <FormField
            label="Base Cost (coins)"
            onChange={(value) => onDraftChange({ ...draft, baseCost: value })}
            value={draft.baseCost}
          />
          <FormField
            label="Multiplier"
            onChange={(value) => onDraftChange({ ...draft, multiplier: value })}
            value={draft.multiplier}
          />
          <FormField
            label="Reason (≥3)"
            onChange={(value) => onDraftChange({ ...draft, reason: value })}
            value={draft.reason}
          />
          <FormField
            label="Confirm rule key"
            onChange={(value) => onDraftChange({ ...draft, confirmation: value })}
            value={draft.confirmation}
          />
        </div>
      </section>

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
                      title: `Publish pricing ${id}`,
                      endpoint: `/api/v1/admin/pricing/rules/${id}/publish`,
                      method: "POST",
                      confirmText: id,
                      reasonRequired: true,
                      body: (actionReason, actionConfirmation) => ({
                        reason: actionReason,
                        confirmation: actionConfirmation,
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
                      title: `Rollback pricing ${id}`,
                      endpoint: `/api/v1/admin/pricing/rules/${id}/rollback`,
                      method: "POST",
                      confirmText: id,
                      reasonRequired: true,
                      body: (actionReason, actionConfirmation) => ({
                        reason: actionReason,
                        confirmation: actionConfirmation,
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
          "ruleKey",
          "label",
          "mode",
          "baseCost",
          "multiplier",
          "status",
          "version",
          "effectiveFrom",
          "publishedAt",
        ]}
        rows={rows}
        title="Pricing Rules"
      />
    </div>
  );
}

function DeadLetterView({
  rows,
  openAction,
}: {
  rows: Row[];
  openAction: (action: PendingAction) => void;
}) {
  const { locale, t, value } = useAdminI18n();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const rowIds = rows.map((row) => stringValue(row.id)).filter(Boolean);
  const selectedIds = rowIds.filter((id) => selected.has(id));
  const selectedConfirmation = selectedIds.join(",");
  const allSelected = rowIds.length > 0 && selectedIds.length === rowIds.length;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(rowIds));
  }

  // SPEC: read-mostly dead-letter triage on ReadonlyOpsView — plain-language failure reason folds
  //       errorCode away; raw job id never sits as a bare column (only inside selection/controls,
  //       same rule JobsView (T10) established).
  // INTENT: keep ALL three existing actions verbatim — per-row Requeue/Discard (openAction, in the
  //         "actions" column render) AND bulk Requeue-selected/Discard-selected (wrapper bar above
  //         the table, same endpoints/bodies). Selection state (Set<string>) still lives here in the
  //         wrapper; ReadonlyOpsView has no header-render slot, so the "select all" toggle that used
  //         to live in the <thead> checkbox moves into the bar next to "{count} selected".
  const columns: OpsColumn[] = [
    {
      key: "select",
      label: "",
      render: (row) => {
        const id = stringValue(row.id);
        return (
          <input
            aria-label={id ? t("Select dead-letter job {id}", { id }) : t("Select dead-letter job")}
            checked={selected.has(id)}
            onChange={() => toggle(id)}
            type="checkbox"
          />
        );
      },
    },
    {
      key: "userId",
      label: "User",
      render: (row) => <span className="font-mono text-xs">{shortId(stringValue(row.userId))}</span>,
    },
    { key: "mode", label: "Mode", render: (row) => value(stringValue(row.mode)) },
    { key: "status", label: "Status", render: (row) => value(stringValue(row.status)) },
    {
      key: "failure",
      label: "Failure reason",
      render: (row) => {
        const status = stringValue(row.status);
        return status === "failed" || status === "blocked" ? (
          <FailureReason code={stringValue(row.errorCode)} />
        ) : (
          <span className="text-[var(--ad-text-muted)]">—</span>
        );
      },
    },
    { key: "ledgerState", label: "Ledger", render: (row) => value(stringValue(row.ledgerState)) },
    { key: "costDreamcoins", label: "Cost" },
    {
      key: "updatedAt",
      label: "Updated",
      render: (row) => compactDate(stringValue(row.updatedAt), locale),
    },
    {
      key: "actions",
      label: "Actions",
      render: (row) => {
        const id = stringValue(row.id);
        const status = stringValue(row.status);
        return (
          <div className="flex flex-wrap gap-1">
            {status === "failed" ? (
              <IconAction
                icon={<RefreshCcw className="h-4 w-4" />}
                label="Requeue"
                onClick={() =>
                  openAction({
                    title: `Requeue ${id}`,
                    endpoint: `/api/v1/admin/generation/jobs/${id}/requeue`,
                    method: "POST",
                    confirmText: id,
                    reasonRequired: false,
                    body: (actionReason, actionConfirmation) => ({
                      reason: actionReason || undefined,
                      confirmation: actionConfirmation,
                    }),
                  })
                }
              />
            ) : null}
            {status === "failed" || status === "blocked" ? (
              <IconAction
                icon={<Trash2 className="h-4 w-4" />}
                label="Discard"
                onClick={() =>
                  openAction({
                    title: `Discard ${id}`,
                    endpoint: `/api/v1/admin/generation/jobs/${id}/discard`,
                    method: "POST",
                    confirmText: id,
                    reasonRequired: true,
                    body: (actionReason, actionConfirmation) => ({
                      reason: actionReason,
                      confirmation: actionConfirmation,
                    }),
                  })
                }
              />
            ) : null}
          </div>
        );
      },
    },
  ];

  return (
    <div className="space-y-4">
      <div className="rounded-lg flex flex-wrap items-center gap-3 border border-[var(--ad-border)] bg-[var(--ad-surface)] px-4 py-3">
        <label className="flex items-center gap-2 text-xs text-[var(--ad-text-muted)]">
          <input
            aria-label={t("Select all dead-letter jobs")}
            checked={allSelected}
            onChange={toggleAll}
            type="checkbox"
          />
          {t("Select all")}
        </label>
        <span className="text-xs text-[var(--ad-text-muted)]">
          {t("{count} selected", { count: selectedIds.length })}
        </span>
        <div className="ml-auto flex gap-2">
          <button
            className="rounded-md inline-flex h-9 items-center gap-2 border border-[var(--ad-border)] px-3 text-sm text-[var(--ad-text)] hover:bg-black/[0.04] disabled:opacity-40"
            disabled={selectedIds.length === 0}
            onClick={() =>
              openAction({
                title: `Requeue ${selectedIds.length} jobs`,
                endpoint: "/api/v1/admin/generation/dead-letter/requeue",
                method: "POST",
                confirmText: selectedConfirmation,
                reasonRequired: true,
                body: (actionReason, actionConfirmation) => ({
                  jobIds: selectedIds,
                  reason: actionReason,
                  confirmation: actionConfirmation,
                }),
              })
            }
            type="button"
          >
            <RefreshCcw className="h-4 w-4" />
            {t("Requeue selected")}
          </button>
          <button
            className="rounded-md inline-flex h-9 items-center gap-2 border border-[var(--ad-border)] px-3 text-sm text-[var(--ad-red-text)] hover:bg-black/[0.04] disabled:opacity-40"
            disabled={selectedIds.length === 0}
            onClick={() =>
              openAction({
                title: `Discard ${selectedIds.length} jobs`,
                endpoint: "/api/v1/admin/generation/dead-letter/discard",
                method: "POST",
                confirmText: selectedConfirmation,
                reasonRequired: true,
                body: (actionReason, actionConfirmation) => ({
                  jobIds: selectedIds,
                  reason: actionReason,
                  confirmation: actionConfirmation,
                }),
              })
            }
            type="button"
          >
            <Trash2 className="h-4 w-4" />
            {t("Discard selected")}
          </button>
        </div>
      </div>

      <ReadonlyOpsView
        columns={columns}
        rows={rows}
        title="Dead-letter Queue"
        empty={t("No dead-letter jobs")}
      />
    </div>
  );
}

function AnalyticsView({ data }: { data: AnalyticsWorkspaceData }) {
  const { locale, t } = useAdminI18n();
  const { legacy, canonical } = data;

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-semibold text-[var(--ad-text)]">Canonical Metrics v2</p>
            <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
              asOf {compactDate(canonical.asOf, locale)} · {canonical.freshness} · join {(canonical.quality.joinCoverage * 100).toFixed(1)}%
            </p>
          </div>
          <span className={cn(
            "rounded-full px-2.5 py-1 text-xs font-medium",
            canonical.quality.qualityState === "certified"
              ? "bg-[var(--ad-green-bg)] text-[var(--ad-green-text)]"
              : "bg-[var(--ad-red-bg)] text-[var(--ad-red-text)]",
          )}>
            {canonical.quality.qualityState}
          </span>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {canonical.cards.map((card) => (
            <div className="rounded-md border border-[var(--ad-border)] p-3" key={card.key}>
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium text-[var(--ad-text)]">{card.name}</p>
                <span className="text-[10px] uppercase tracking-wide text-[var(--ad-text-muted)]">
                  {card.publicationStatus}
                </span>
              </div>
              <p className="mt-2 text-2xl font-semibold text-[var(--ad-text)]">
                {card.value === null ? "—" : card.unit === "ratio" ? `${(Number(card.value) * 100).toFixed(1)}%` : card.value}
              </p>
              <p className="mt-2 text-xs text-[var(--ad-text-muted)]">
                v{card.definitionVersion} · sample {card.sampleSize} · mature {card.matureSampleSize} · {card.qualityState}
              </p>
              <p className="mt-1 text-xs text-[var(--ad-text-muted)]">{card.window}</p>
            </div>
          ))}
        </div>
      </div>
      <p className="text-xs text-[var(--ad-text-muted)]">
        {t("Window")} {compactDate(legacy.window.from, locale)} → {compactDate(legacy.window.to, locale)} ·{" "}
        {t("legacy operational diagnostics")}
      </p>
      <div className="rounded-lg grid gap-px overflow-hidden border border-[var(--ad-border)] bg-black/[0.05] md:grid-cols-4">
        <Metric label="Signups" value={legacy.funnel.signups} meta="new users" />
        <Metric label="Activated" value="Invalid" meta="invalid for decisions · definition v1" />
        <Metric label="Paying" value={legacy.funnel.payingUsers} meta="subscribed" />
        <Metric
          label="Conversion"
          value="Invalid"
          meta="invalid for decisions · mixed cohort/window"
        />
      </div>
      <div className="rounded-lg grid gap-px overflow-hidden border border-[var(--ad-border)] bg-black/[0.05] md:grid-cols-4">
        <Metric
          label="Generations"
          value={legacy.generation.total}
          meta={t("{count} completed", { count: legacy.generation.completed })}
        />
        <Metric label="Failed" value={legacy.generation.failed} meta="generation jobs" />
        <Metric label="Blocked" value={legacy.generation.blocked} meta="generation jobs" />
        <Metric
          label="Coins net"
          value={legacy.economy.net}
          meta={t("{count} granted", { count: legacy.economy.coinsGranted })}
        />
      </div>
      <DataTable
        columns={["reason", "totalDelta", "count"]}
        rows={legacy.economy.byReason}
        title="Coin economy by reason"
      />
      <DataTable columns={["name", "count"]} rows={legacy.topEvents} title="Top events" />
    </div>
  );
}

function RiskView({ data }: { data: AbuseData }) {
  const { locale, t } = useAdminI18n();

  return (
    <div className="space-y-5">
      <p className="text-xs text-[var(--ad-text-muted)]">
        {t("Window")} {compactDate(data.window.from, locale)} → {compactDate(data.window.to, locale)} · 只读告警信号，处置走
        Users 封禁 / Billing 调整。多账号聚类基于 anonymousId，清 cookie / 无痕可绕，非完备。
      </p>
      <DataTable
        columns={["anonymousId", "accountCount", "userIds"]}
        rows={data.deviceClusters}
        title="Multi-account device clusters"
      />
      <DataTable
        columns={["inviterId", "referralCount"]}
        rows={data.referralAbuse}
        title="Referral farming (≥3 invites)"
      />
      <DataTable
        columns={["userId", "count", "totalDelta"]}
        rows={data.adjustAnomalies}
        title="Manual adjust anomalies"
      />
    </div>
  );
}

function ProviderOpsView({ data }: { data: ProviderOpsData }) {
  const { locale, t } = useAdminI18n();

  return (
    <div className="space-y-4">
      <p className="text-xs text-[var(--ad-text-muted)]">
        {t("Window")} {compactDate(data.window.from, locale)} → {compactDate(data.window.to, locale)} · latency = completed −
        created（仅 completed 计入）
      </p>
      <DataTable
        columns={[
          "provider",
          "total",
          "completed",
          "failed",
          "blocked",
          "successRate",
          "coinsCost",
          "avgCostPerJob",
          "latencyP50Ms",
          "latencyP95Ms",
          "latencySamples",
        ]}
        rows={data.providers}
        title="Provider health & cost"
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

function ContentView({
  characters,
  featured,
  featuredIds,
  openAction,
  reload,
}: {
  characters: Row[];
  featured: Row[];
  featuredIds: string[];
  openAction: (action: PendingAction) => void;
  reload: () => void;
}) {
  const { t } = useAdminI18n();
  const [featuredInput, setFeaturedInput] = useState(featuredIds.join(", "));
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const expectedConfirmation = parseCsv(featuredInput).join(",") || "CLEAR";
  const canSaveFeatured =
    !busy &&
    reason.trim().length >= 3 &&
    confirmation.trim() === expectedConfirmation;

  async function saveFeatured() {
    setBusy(true);
    setErr(null);
    try {
      await apiWrite("/api/v1/admin/content/featured", "PUT", {
        characterIds: parseCsv(featuredInput),
        reason: reason.trim(),
        confirmation: confirmation.trim(),
      });
      setReason("");
      setConfirmation("");
      reload();
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
        <h2 className="text-sm font-semibold">{t("Featured curation")}</h2>
        <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
          逗号分隔的 character id；仅 public+approved 会被保留，公开 feed 优先展示。
        </p>
        <div className="mt-3 grid gap-3 md:grid-cols-[1fr_220px_260px_auto]">
          <input
            className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 font-mono text-sm outline-none focus:border-[var(--ad-ink)]"
            onChange={(event) => {
              setFeaturedInput(event.target.value);
              setConfirmation("");
            }}
            placeholder="char_a, char_b"
            value={featuredInput}
          />
          <input
            className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
            onChange={(event) => setReason(event.target.value)}
            placeholder={t("Reason (≥3 chars)")}
            value={reason}
          />
          <input
            aria-label={t("Featured confirmation")}
            className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 font-mono text-sm outline-none focus:border-[var(--ad-ink)]"
            onChange={(event) => setConfirmation(event.target.value)}
            placeholder={expectedConfirmation === "CLEAR" ? t("Type CLEAR") : t("Type featured IDs")}
            value={confirmation}
          />
          <button
            className="inline-flex h-10 items-center gap-2 bg-[var(--ad-ink)] px-3 text-sm font-semibold text-white disabled:opacity-50"
            disabled={!canSaveFeatured}
            onClick={() => void saveFeatured()}
            type="button"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Flag className="h-4 w-4" />}
            {t("Save featured")}
          </button>
        </div>
        {err ? <p className="mt-2 text-xs text-[var(--ad-red-text)]">{err}</p> : null}
      </section>
      <DataTable columns={["id", "name", "visibility", "status"]} rows={featured} title="Currently featured" />
      <DataTable
        actions={(row) => {
          const id = stringValue(row.id);
          return (
            <div className="flex gap-1">
              <IconAction
                icon={<ShieldCheck className="h-4 w-4" />}
                label="Make private"
                onClick={() =>
                  openAction({
                    title: `Make ${id} private`,
                    endpoint: `/api/v1/admin/content/characters/${id}/visibility`,
                    method: "POST",
                    confirmText: `${id}:visibility:private`,
                    reasonRequired: true,
                    body: (actionReason, confirmation) => ({
                      visibility: "private",
                      reason: actionReason,
                      confirmation,
                    }),
                  })
                }
              />
              <IconAction
                icon={<Trash2 className="h-4 w-4" />}
                label="Remove"
                onClick={() =>
                  openAction({
                    title: `Remove ${id}`,
                    endpoint: `/api/v1/admin/content/characters/${id}/status`,
                    method: "POST",
                    confirmText: `${id}:status:removed`,
                    reasonRequired: true,
                    body: (actionReason, confirmation) => ({
                      status: "removed",
                      reason: actionReason,
                      confirmation,
                    }),
                  })
                }
              />
            </div>
          );
        }}
        columns={["id", "name", "gender", "style", "visibility", "status", "createdAt"]}
        rows={characters}
        title="Characters"
      />
    </div>
  );
}

function PromoView({
  codes,
  referrals,
  openAction,
  reload,
}: {
  codes: Row[];
  referrals: Row[];
  openAction: (action: PendingAction) => void;
  reload: () => void;
}) {
  const { t } = useAdminI18n();
  const [code, setCode] = useState("");
  const [dreamcoins, setDreamcoins] = useState("");
  const [maxRedemptions, setMaxRedemptions] = useState("");
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const trimmedCode = code.trim();
  const canCreateCode =
    !busy &&
    trimmedCode.length >= 4 &&
    reason.trim().length >= 3 &&
    confirmation.trim() === trimmedCode;

  async function createCode() {
    setBusy(true);
    setErr(null);
    try {
      await apiWrite("/api/v1/admin/promo/redeem-codes", "POST", {
        code: code.trim(),
        reward: { dreamcoins: intFromText(dreamcoins, 0) },
        maxRedemptions: maxRedemptions.trim() ? intFromText(maxRedemptions, 1) : null,
        reason: reason.trim(),
        confirmation: confirmation.trim(),
      });
      setCode("");
      setDreamcoins("");
      setMaxRedemptions("");
      setReason("");
      setConfirmation("");
      reload();
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
        <h2 className="text-sm font-semibold">{t("Create redeem code")}</h2>
        <p className="mt-1 text-xs text-[var(--ad-text-muted)]">明文 code 仅用于生成 hash，不入库、不回显、不入审计。</p>
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-6">
          <input
            className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 font-mono text-sm outline-none focus:border-[var(--ad-ink)]"
            onChange={(event) => setCode(event.target.value)}
            placeholder={t("Code (≥4)")}
            value={code}
          />
          <input
            className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
            onChange={(event) => setDreamcoins(event.target.value)}
            placeholder={t("Dreamcoins")}
            value={dreamcoins}
          />
          <input
            className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
            onChange={(event) => setMaxRedemptions(event.target.value)}
            placeholder={t("Max uses (blank=∞)")}
            value={maxRedemptions}
          />
          <input
            className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
            onChange={(event) => setReason(event.target.value)}
            placeholder={t("Reason (≥3)")}
            value={reason}
          />
          <input
            aria-label={t("Redeem code confirmation")}
            className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 font-mono text-sm outline-none focus:border-[var(--ad-ink)]"
            onChange={(event) => setConfirmation(event.target.value)}
            placeholder={t("Type code to confirm")}
            value={confirmation}
          />
          <button
            className="inline-flex h-10 items-center gap-2 bg-[var(--ad-ink)] px-3 text-sm font-semibold text-white disabled:opacity-50"
            disabled={!canCreateCode}
            onClick={() => void createCode()}
            type="button"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {t("Create")}
          </button>
        </div>
        {err ? <p className="mt-2 text-xs text-[var(--ad-red-text)]">{err}</p> : null}
      </section>
      <DataTable
        actions={(row) => {
          if (stringValue(row.status) !== "active") return null;
          const id = stringValue(row.id);
          return (
            <IconAction
              icon={<Ban className="h-4 w-4" />}
              label="Disable"
              onClick={() =>
                openAction({
                  title: `Disable ${id}`,
                  endpoint: `/api/v1/admin/promo/redeem-codes/${id}/disable`,
                  method: "POST",
                  confirmText: id,
                  reasonRequired: true,
                  body: (actionReason, confirmation) => ({ reason: actionReason, confirmation }),
                })
              }
            />
          );
        }}
        columns={["id", "status", "reward", "maxRedemptions", "redemptions", "expiresAt", "createdAt"]}
        rows={codes}
        title="Redeem codes"
      />
      <DataTable
        columns={["id", "inviterId", "inviteeId", "status", "rewardStatus", "createdAt"]}
        rows={referrals}
        title="Referrals"
      />
    </div>
  );
}

function PlaintextAccessPanel() {
  const { t } = useAdminI18n();
  const formRef = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState<PlaintextAccessDraft>(defaultPlaintextAccessDraft);
  const [result, setResult] = useState<PlaintextAccessResult | null>(null);
  const [status, setStatus] = useState<{ tone: "good" | "bad"; message: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const canSubmit = canSubmitPlaintextDraft(draft, loading);

  async function performPlaintextView(form: HTMLFormElement | null = formRef.current) {
    const payloadDraft = form ? plaintextDraftFromForm(form) : draft;
    if (!canSubmitPlaintextDraft(payloadDraft, loading)) return;
    setLoading(true);
    setStatus(null);
    setResult(null);
    try {
      const data = await apiWrite<PlaintextAccessResult>("/api/v1/admin/support/plaintext/view", "POST", {
        targetType: payloadDraft.targetType,
        targetId: payloadDraft.targetId.trim(),
        ticketId: payloadDraft.ticketId.trim() || undefined,
        legalHoldId: payloadDraft.legalHoldId.trim() || undefined,
        reason: payloadDraft.reason.trim(),
        confirmation: payloadDraft.confirmation.trim(),
      });
      setResult(data);
      setStatus({ tone: "good", message: t("Plaintext access logged.") });
    } catch (err) {
      setStatus({ tone: "bad", message: err instanceof Error ? err.message : t("Plaintext access failed.") });
    } finally {
      setLoading(false);
    }
  }

  function submitPlaintextView(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void performPlaintextView(event.currentTarget);
  }

  const fieldSummary =
    plaintextTargetTypeOptions.find((option) => option.value === draft.targetType)?.fields ?? "prompt";

  return (
    <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <form className="space-y-4" onSubmit={submitPlaintextView} ref={formRef}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-[var(--ad-text)]">{t("Plaintext access")}</h2>
            <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
              {t("Requires active support consent or legal hold.")}
            </p>
          </div>
          <span className="rounded-lg inline-flex items-center gap-2 border border-[var(--ad-border)] px-3 py-1 text-xs text-[var(--ad-text-muted)]">
            <ShieldCheck className="h-3.5 w-3.5" />
            {t("Audit logged")}
          </span>
        </div>

        <div className="grid gap-3 lg:grid-cols-[180px_1fr_1fr]">
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Target type")}</span>
            <select
              aria-label={t("Target type")}
              className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm text-[var(--ad-text)] outline-none focus:border-[var(--ad-ink)]"
              name="targetType"
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  targetType: event.target.value as PlaintextTargetType,
                }))
              }
              value={draft.targetType}
            >
              {plaintextTargetTypeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.label)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Plaintext target ID")}</span>
            <input
              aria-label={t("Plaintext target ID")}
              className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm text-[var(--ad-text)] outline-none focus:border-[var(--ad-ink)]"
              name="targetId"
              onChange={(event) => setDraft((current) => ({ ...current, targetId: event.target.value }))}
              placeholder="job_or_media_id"
              value={draft.targetId}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Consent ticket ID")}</span>
            <input
              aria-label={t("Consent ticket ID")}
              className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm text-[var(--ad-text)] outline-none focus:border-[var(--ad-ink)]"
              name="ticketId"
              onChange={(event) => setDraft((current) => ({ ...current, ticketId: event.target.value }))}
              placeholder="SUP-..."
              value={draft.ticketId}
            />
          </label>
        </div>

        <div className="grid gap-3 lg:grid-cols-[1fr_1fr_1.5fr]">
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Legal hold ID")}</span>
            <input
              aria-label={t("Legal hold ID")}
              className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm text-[var(--ad-text)] outline-none focus:border-[var(--ad-ink)]"
              name="legalHoldId"
              onChange={(event) => setDraft((current) => ({ ...current, legalHoldId: event.target.value }))}
              placeholder="hold_id"
              value={draft.legalHoldId}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Plaintext confirmation")}</span>
            <input
              aria-label={t("Plaintext confirmation")}
              className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm text-[var(--ad-text)] outline-none focus:border-[var(--ad-ink)]"
              name="confirmation"
              onChange={(event) => setDraft((current) => ({ ...current, confirmation: event.target.value }))}
              placeholder={t("Type target ID")}
              value={draft.confirmation}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Plaintext reason")}</span>
            <input
              aria-label={t("Plaintext reason")}
              className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm text-[var(--ad-text)] outline-none focus:border-[var(--ad-ink)]"
              name="reason"
              onChange={(event) => setDraft((current) => ({ ...current, reason: event.target.value }))}
              placeholder={t("Reason for audit")}
              value={draft.reason}
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            className="inline-flex h-10 items-center gap-2 bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canSubmit}
            onClick={(event) => {
              event.preventDefault();
              void performPlaintextView(event.currentTarget.form);
            }}
            type="submit"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            {loading ? t("Viewing…") : t("View plaintext")}
          </button>
          <span className="text-xs text-[var(--ad-text-muted)]">
            {t("Fields available: {fields}", { fields: fieldSummary })}
          </span>
          {status ? (
            <span
              aria-live="polite"
              className={cn(
                "text-xs font-semibold",
                status.tone === "good" ? "text-[var(--ad-green-text)]" : "text-[var(--ad-red-text)]",
              )}
              data-testid="admin-plaintext-status"
              role="status"
            >
              {status.message}
            </span>
          ) : null}
        </div>
      </form>

      {result ? (
        <div
          className="rounded-lg mt-4 space-y-3 border border-[var(--ad-border)] bg-black/[0.03] p-3"
          data-testid="admin-plaintext-result"
        >
          <div className="grid gap-2 text-xs text-[var(--ad-text-muted)] md:grid-cols-3">
            <span>
              {t("Target")}: <code className="text-[var(--ad-text)]">{result.target.id}</code>
            </span>
            <span>
              {t("Owner")}: <code className="text-[var(--ad-text)]">{result.target.ownerId}</code>
            </span>
            <span>
              {t("Authorization")}:{" "}
              <code className="text-[var(--ad-text)]">
                {result.authorization.legalHoldId ?? result.authorization.ticketId ?? "-"}
              </code>
            </span>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {Object.entries(result.plaintext).map(([field, value]) => (
              <div className="rounded-lg border border-[var(--ad-border)] bg-black/[0.03] p-3" key={field}>
                <div className="text-xs font-semibold uppercase text-[var(--ad-text-muted)]">{field}</div>
                <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words text-sm leading-6 text-[var(--ad-text)]">{plaintextValueText(value)}</pre>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function canSubmitPlaintextDraft(draft: PlaintextAccessDraft, loading: boolean) {
  return (
    !loading &&
    draft.targetId.trim().length > 0 &&
    draft.reason.trim().length >= 3 &&
    draft.confirmation.trim() === draft.targetId.trim() &&
    (draft.ticketId.trim().length > 0 || draft.legalHoldId.trim().length > 0)
  );
}

function plaintextDraftFromForm(form: HTMLFormElement): PlaintextAccessDraft {
  const formData = new FormData(form);
  const targetType = formStringValue(formData, "targetType");
  return {
    targetType: targetType === "media" ? "media" : "generation_job",
    targetId: formStringValue(formData, "targetId"),
    ticketId: formStringValue(formData, "ticketId"),
    legalHoldId: formStringValue(formData, "legalHoldId"),
    confirmation: formStringValue(formData, "confirmation"),
    reason: formStringValue(formData, "reason"),
  };
}

function formStringValue(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function plaintextValueText(value: string | null) {
  if (value === null || value === "") return "(empty)";
  return value;
}

function SupportRequestsView({
  rows,
  openAction,
}: {
  rows: Row[];
  openAction: (action: PendingAction) => void;
}) {
  const { t, value: valueLabel } = useAdminI18n();
  const [filters, setFilters] = useState<SupportRequestFilters>(defaultSupportRequestFilters);
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [savedViewsLoading, setSavedViewsLoading] = useState(true);
  const [savedViewLabel, setSavedViewLabel] = useState("");
  const [savingView, setSavingView] = useState(false);
  const [savedViewError, setSavedViewError] = useState<string | null>(null);

  const visibleRows = useMemo(
    () => rows.filter((row) => matchesSupportRequestFilters(row, filters)),
    [filters, rows],
  );
  const activeFilterCount =
    (filters.query.trim() ? 1 : 0) +
    (filters.category.trim() ? 1 : 0) +
    (filters.status === "all" ? 0 : 1) +
    (filters.sla === "all" ? 0 : 1);

  const loadSavedViews = useCallback(async () => {
    setSavedViewsLoading(true);
    setSavedViewError(null);
    try {
      const data = await apiGet<{ items: SavedView[] }>(
        `/api/v1/admin/saved-views?scope=${encodeURIComponent(SUPPORT_REQUEST_SAVED_VIEW_SCOPE)}`,
      );
      setSavedViews(data.items);
    } catch (err) {
      setSavedViewError(err instanceof Error ? err.message : "Saved views failed");
    } finally {
      setSavedViewsLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadSavedViews();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadSavedViews]);

  async function saveCurrentView() {
    const label = savedViewLabel.trim();
    if (!label || savingView) return;
    setSavingView(true);
    setSavedViewError(null);
    try {
      await apiWrite<{ view: SavedView }>("/api/v1/admin/saved-views", "POST", {
        scope: SUPPORT_REQUEST_SAVED_VIEW_SCOPE,
        label,
        filters: normalizeSupportRequestFilters(filters),
      });
      setSavedViewLabel("");
      await loadSavedViews();
    } catch (err) {
      setSavedViewError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSavingView(false);
    }
  }

  async function deleteSavedView(view: SavedView) {
    setSavedViewError(null);
    try {
      await apiDelete<{ deleted: true }>(`/api/v1/admin/saved-views/${view.id}`);
      setSavedViews((current) => current.filter((item) => item.id !== view.id));
    } catch (err) {
      setSavedViewError(err instanceof Error ? err.message : "Delete failed");
    }
  }

  function applySavedView(view: SavedView) {
    setSavedViewError(null);
    setFilters(supportRequestFiltersFromUnknown(view.filters));
  }

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
        <div className="grid gap-3 xl:grid-cols-[1fr_160px_160px_160px_300px] xl:items-end">
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Support search")}</span>
            <input
              aria-label={t("Support search")}
              className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm text-[var(--ad-text)] outline-none focus:border-[var(--ad-ink)]"
              onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
              placeholder={t("Ticket, user, subject, or notes")}
              value={filters.query}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Status")}</span>
            <select
              aria-label={t("Support status")}
              className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm text-[var(--ad-text)] outline-none focus:border-[var(--ad-ink)]"
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  status: supportStatusFromUnknown(event.target.value),
                }))
              }
              value={filters.status}
            >
              {supportStatusOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.value === "all" || option.value === "active" ? t(option.label) : valueLabel(option.label)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("SLA")}</span>
            <select
              aria-label={t("Support SLA")}
              className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm text-[var(--ad-text)] outline-none focus:border-[var(--ad-ink)]"
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  sla: supportSlaFromUnknown(event.target.value),
                }))
              }
              value={filters.sla}
            >
              {supportSlaOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.value === "all" ? t(option.label) : valueLabel(option.label)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Category")}</span>
            <input
              aria-label={t("Support category")}
              className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm text-[var(--ad-text)] outline-none focus:border-[var(--ad-ink)]"
              onChange={(event) => setFilters((current) => ({ ...current, category: event.target.value }))}
              placeholder="generation"
              value={filters.category}
            />
          </label>
          <form
            className="flex min-w-0 flex-col gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              void saveCurrentView();
            }}
          >
            <span className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Saved view")}</span>
            <div className="flex gap-2">
              <input
                aria-label={t("Support saved view label")}
                className="rounded-md h-10 min-w-0 flex-1 border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm text-[var(--ad-text)] outline-none focus:border-[var(--ad-ink)]"
                onChange={(event) => setSavedViewLabel(event.target.value)}
                placeholder={t("Saved view label")}
                value={savedViewLabel}
              />
              <button
                className="inline-flex h-10 shrink-0 items-center gap-2 bg-[var(--ad-ink)] px-3 text-sm font-semibold text-white disabled:opacity-50"
                disabled={!savedViewLabel.trim() || savingView}
                type="submit"
              >
                {savingView ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bookmark className="h-4 w-4" />}
                {t("Save view")}
              </button>
            </div>
          </form>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-2 text-xs font-semibold text-[var(--ad-text-muted)]">
            <SlidersHorizontal className="h-4 w-4" />
            {t("Saved views")}
          </span>
          {savedViews.map((view) => (
            <span className="rounded-md inline-flex h-8 items-center border border-[var(--ad-border)]" key={view.id}>
              <button
                className="h-full px-3 text-xs text-[var(--ad-text)] hover:bg-black/[0.04]"
                onClick={() => applySavedView(view)}
                type="button"
              >
                {view.label}
              </button>
              <button
                aria-label={t("Delete saved view {label}", { label: view.label })}
                className="flex h-full w-8 items-center justify-center border-l border-[var(--ad-border)] text-[var(--ad-text-muted)] hover:text-[var(--ad-ink)]"
                onClick={() => void deleteSavedView(view)}
                title={t("Delete saved view {label}", { label: view.label })}
                type="button"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
          {savedViewsLoading ? <span className="text-xs text-[var(--ad-text-muted)]">{t("Loading…")}</span> : null}
          {!savedViewsLoading && savedViews.length === 0 ? (
            <span className="text-xs text-[var(--ad-text-muted)]">{t("No saved views.")}</span>
          ) : null}
          {activeFilterCount > 0 ? (
            <button
              className="rounded-lg h-8 border border-[var(--ad-border)] px-3 text-xs text-[var(--ad-text)] hover:border-[var(--ad-ink)]"
              onClick={() => setFilters(defaultSupportRequestFilters)}
              type="button"
            >
              {t("Reset filters")}
            </button>
          ) : null}
          <span className="text-xs text-[var(--ad-text-muted)]">
            {t("{visible}/{total} requests", { visible: visibleRows.length, total: rows.length })}
          </span>
        </div>
        {savedViewError ? <p className="mt-2 text-xs text-[var(--ad-red-text)]">{savedViewError}</p> : null}
      </section>

      <PlaintextAccessPanel />

      <DataTable
        actions={(row) => {
          const ticketId = stringValue(row.ticketId);
          const status = stringValue(row.status);
          const slaState = stringValue(row.slaState);
          const slaEscalatedAt = stringValue(row.slaEscalatedAt);
          const canEscalate =
            (slaState === "overdue" || slaState === "due_soon") &&
            !slaEscalatedAt &&
            status !== "resolved" &&
            status !== "closed";
          const actions: Array<{
            label: string;
            nextStatus?: string;
            icon: ReactNode;
            endpoint?: string;
            method?: "POST" | "PATCH";
            notes?: boolean;
          }> = [];
          if (canEscalate) {
            actions.push({
              endpoint: `/api/v1/admin/support/requests/${ticketId}/escalate`,
              icon: <AlertTriangle className="h-4 w-4" />,
              label: "Escalate",
              method: "POST",
            });
          }
          if (status === "received") {
            actions.push({ icon: <Inbox className="h-4 w-4" />, label: "Open", nextStatus: "open" });
          }
          if (status !== "waiting_on_user" && status !== "resolved" && status !== "closed") {
            actions.push({
              icon: <MessageSquare className="h-4 w-4" />,
              label: "Waiting",
              nextStatus: "waiting_on_user",
            });
          }
          if (status !== "resolved" && status !== "closed") {
            actions.push({
              icon: <ClipboardCheck className="h-4 w-4" />,
              label: "Resolve",
              nextStatus: "resolved",
              notes: true,
            });
          }
          if (status !== "closed") {
            actions.push({
              icon: <Check className="h-4 w-4" />,
              label: "Close",
              nextStatus: "closed",
              notes: true,
            });
          }

          return (
            <div className="flex flex-wrap gap-1">
              {actions.map((item) => (
                <IconAction
                  icon={item.icon}
                  key={`${ticketId}-${item.nextStatus}`}
                  label={item.label}
                  onClick={() =>
                    openAction({
                      title: `${item.label} ${ticketId}`,
                      endpoint: item.endpoint ?? `/api/v1/admin/support/requests/${ticketId}`,
                      method: item.method ?? "PATCH",
                      confirmText: ticketId,
                      reasonRequired: true,
                      body: (actionReason, actionConfirmation) => ({
                        confirmation: actionConfirmation,
                        reason: actionReason,
                        resolutionNotes: item.notes ? actionReason : undefined,
                        status: item.nextStatus,
                      }),
                    })
                  }
                />
              ))}
            </div>
          );
        }}
        columns={[
          "ticketId",
          "userEmail",
          "category",
          "subject",
          "description",
          "status",
          "priority",
          "slaState",
          "slaDueAt",
          "slaHoursRemaining",
          "slaEscalatedAt",
          "slaEscalationReason",
          "diagnosticConsent",
          "sourcePath",
          "assignedToEmail",
          "resolutionNotes",
          "createdAt",
        ]}
        rows={visibleRows}
        title="Support Requests"
      />
    </div>
  );
}

function normalizeSupportRequestFilters(filters: SupportRequestFilters): SupportRequestFilters {
  return {
    query: filters.query.trim(),
    status: filters.status,
    sla: filters.sla,
    category: filters.category.trim(),
  };
}

function supportRequestFiltersFromUnknown(value: unknown): SupportRequestFilters {
  if (typeof value !== "object" || value === null) return defaultSupportRequestFilters;
  const record = value as Record<string, unknown>;
  return {
    query: typeof record.query === "string" ? record.query : "",
    status: supportStatusFromUnknown(record.status),
    sla: supportSlaFromUnknown(record.sla),
    category: typeof record.category === "string" ? record.category : "",
  };
}

function supportStatusFromUnknown(value: unknown): SupportStatusFilter {
  return supportStatusOptions.some((option) => option.value === value)
    ? (value as SupportStatusFilter)
    : "all";
}

function supportSlaFromUnknown(value: unknown): SupportSlaFilter {
  return supportSlaOptions.some((option) => option.value === value)
    ? (value as SupportSlaFilter)
    : "all";
}

function matchesSupportRequestFilters(row: Row, filters: SupportRequestFilters) {
  const status = stringValue(row.status);
  if (filters.status === "active" && (status === "resolved" || status === "closed")) return false;
  if (filters.status !== "all" && filters.status !== "active" && status !== filters.status) return false;
  if (filters.sla !== "all" && stringValue(row.slaState) !== filters.sla) return false;

  const category = filters.category.trim().toLowerCase();
  if (category && stringValue(row.category).toLowerCase() !== category) return false;

  const query = filters.query.trim().toLowerCase();
  if (!query) return true;
  const haystack = [
    row.ticketId,
    row.userEmail,
    row.userId,
    row.category,
    row.subject,
    row.description,
    row.status,
    row.assignedToEmail,
    row.resolutionNotes,
    row.sourcePath,
  ]
    .map((value) => (value === null || value === undefined ? "" : String(value)))
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function ApprovalsView({
  rows,
  openAction,
}: {
  rows: Row[];
  openAction: (action: PendingAction) => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-xs text-[var(--ad-text-muted)]">
        高危操作复核队列。审批人须 ≠ 发起人，且持该请求声明的 permission key（不变量在服务端强制）。
      </p>
      <DataTable
        actions={(row) => {
          const id = stringValue(row.id);
          return (
            <div className="flex gap-1">
              <IconAction
                icon={<Check className="h-4 w-4" />}
                label="Approve"
                onClick={() =>
                  openAction({
                    title: `Approve ${id}`,
                    endpoint: `/api/v1/admin/approvals/${id}/approve`,
                    method: "POST",
                    confirmText: id,
                    reasonRequired: true,
                    body: (actionReason, confirmation) => ({ reason: actionReason, confirmation }),
                  })
                }
              />
              <IconAction
                icon={<X className="h-4 w-4" />}
                label="Reject"
                onClick={() =>
                  openAction({
                    title: `Reject ${id}`,
                    endpoint: `/api/v1/admin/approvals/${id}/reject`,
                    method: "POST",
                    confirmText: id,
                    reasonRequired: true,
                    body: (actionReason, confirmation) => ({ reason: actionReason, confirmation }),
                  })
                }
              />
            </div>
          );
        }}
        columns={["id", "action", "permissionKey", "targetType", "targetId", "requestedById", "reason", "createdAt"]}
        rows={rows}
        title="Pending approvals"
      />
    </div>
  );
}

function ChatOpsView({
  configured,
  diagnostics,
  overview,
  providerHealth,
  sessions,
  usage,
  events,
  filters,
  onApplyFilters,
  onFiltersChange,
}: {
  configured: boolean;
  diagnostics: ChatOpsDiagnostics | null;
  overview: Record<string, unknown> | null;
  providerHealth: Row[];
  sessions: Row[];
  usage: Row[];
  events: Row[];
  filters: ChatOpsFilters;
  onApplyFilters: (value: ChatOpsFilters) => void;
  onFiltersChange: (value: ChatOpsFilters) => void;
}) {
  const { locale, t } = useAdminI18n();
  const o = overview ?? {};
  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">{t("Chat Service status")}</span>
              <Status
                locale={locale}
                value={configured ? "connected" : "disconnected"}
                tone={configured ? "good" : "warn"}
              />
            </div>
            <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
              {configured
                ? t("Internal admin API is reachable.")
                : t(chatOpsDiagnosticText(diagnostics))}
            </p>
          </div>
          <div className="grid min-w-[220px] gap-1 text-xs text-[var(--ad-text-muted)]">
            <div className="flex justify-between gap-4">
              <span>{t("CHAT_SERVICE_URL")}</span>
              <span className="font-mono text-[var(--ad-text)]">
                {diagnostics?.serviceUrlConfigured ? t("configured") : t("missing")}
              </span>
            </div>
            {diagnostics?.status ? (
              <div className="flex justify-between gap-4">
                <span>{t("HTTP status")}</span>
                <span className="font-mono text-[var(--ad-text)]">{diagnostics.status}</span>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
        <div className="grid gap-3 lg:grid-cols-[1fr_1fr_160px_160px]">
          <input
            className="rounded-md h-10 border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
            onChange={(event) => onFiltersChange({ ...filters, userId: event.target.value })}
            placeholder={t("User ID")}
            value={filters.userId}
          />
          <input
            className="rounded-md h-10 border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
            onChange={(event) => onFiltersChange({ ...filters, characterId: event.target.value })}
            placeholder={t("Character ID")}
            value={filters.characterId}
          />
          <select
            className="rounded-md h-10 border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
            onChange={(event) => onFiltersChange({ ...filters, sessionStatus: event.target.value })}
            value={filters.sessionStatus}
          >
            {["active", "archived", "deleted", "all"].map((status) => (
              <option key={status} value={status}>
                {t(status)}
              </option>
            ))}
          </select>
          <select
            className="rounded-md h-10 border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
            onChange={(event) => onFiltersChange({ ...filters, limit: event.target.value })}
            value={filters.limit}
          >
            {["25", "50", "100"].map((limit) => (
              <option key={limit} value={limit}>
                {t("{count} rows", { count: limit })}
              </option>
            ))}
          </select>
        </div>
        <div className="mt-3 grid gap-3 lg:grid-cols-[160px_160px_1fr_1fr_auto_auto]">
          <select
            className="rounded-md h-10 border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
            onChange={(event) => onFiltersChange({ ...filters, eventStatus: event.target.value })}
            value={filters.eventStatus}
          >
            {["all", "blocked", "flagged", "passed"].map((status) => (
              <option key={status} value={status}>
                {t(status)}
              </option>
            ))}
          </select>
          <select
            className="rounded-md h-10 border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
            onChange={(event) => onFiltersChange({ ...filters, eventLayer: event.target.value })}
            value={filters.eventLayer}
          >
            {["all", "input", "output"].map((layer) => (
              <option key={layer} value={layer}>
                {t(layer)}
              </option>
            ))}
          </select>
          <input
            className="rounded-md h-10 border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
            onChange={(event) => onFiltersChange({ ...filters, policyCode: event.target.value })}
            placeholder={t("Policy code")}
            value={filters.policyCode}
          />
          <input
            className="rounded-md h-10 border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]"
            onChange={(event) => onFiltersChange({ ...filters, targetId: event.target.value })}
            placeholder={t("Target ID")}
            value={filters.targetId}
          />
          <button
            className="rounded-md inline-flex h-10 items-center justify-center gap-2 border border-[var(--ad-border)] px-3 text-sm text-[var(--ad-text)] hover:bg-black/[0.04]"
            onClick={() => onApplyFilters(filters)}
            type="button"
          >
            <Search className="h-4 w-4" />
            {t("Apply")}
          </button>
          <button
            className="rounded-md inline-flex h-10 items-center justify-center gap-2 border border-[var(--ad-border)] px-3 text-sm text-[var(--ad-text-muted)] hover:bg-black/[0.04]"
            onClick={() => {
              onFiltersChange(defaultChatOpsFilters);
              onApplyFilters(defaultChatOpsFilters);
            }}
            type="button"
          >
            <RotateCcw className="h-4 w-4" />
            {t("Reset")}
          </button>
        </div>
      </section>

      <div className="rounded-lg grid gap-px overflow-hidden border border-[var(--ad-border)] bg-black/[0.05] md:grid-cols-4">
        <Metric label="Active sessions" value={metricNumber(o.activeSessions)} meta="status=active" />
        <Metric label="Archived" value={metricNumber(o.archivedSessions)} meta="sessions" />
        <Metric label="Messages 24h" value={metricNumber(o.messages24h)} meta="last 24h" />
        <Metric label="Moderation 24h" value={metricNumber(o.moderationEvents24h)} meta="events" />
      </div>
      <div className="rounded-lg grid gap-px overflow-hidden border border-[var(--ad-border)] bg-black/[0.05] md:grid-cols-4">
        <Metric label="Messages used today" value={metricNumber(o.messagesUsedToday)} meta="quota ledger" />
        <Metric label="Users at daily limit" value={metricNumber(o.usersAtDailyLimit)} meta="free tier" />
        <Metric label="Unlimited users" value={metricNumber(o.unlimitedEntitlements)} meta="entitlements" />
        <Metric label="Blocked moderation 24h" value={metricNumber(o.blockedModeration24h)} meta="events" />
      </div>
      <DataTable
        columns={[
          "provider",
          "adapter",
          "status",
          "ok",
          "model",
          "endpoint",
          "latencyMs",
          "httpStatus",
          "modelListed",
          "error",
        ]}
        rows={providerHealth}
        title="Chat provider health"
      />
      <DataTable
        columns={[
          "userId",
          "modelTier",
          "unlimitedMessages",
          "messagesUsed",
          "freeDailyLimit",
          "freeRemaining",
          "quotaStatus",
          "activeSessions",
          "messages24h",
          "periodStart",
        ]}
        rows={usage}
        title="Chat usage and quota"
      />
      <DataTable
        columns={[
          "id",
          "userId",
          "characterId",
          "title",
          "status",
          "memoryEnabled",
          "messageCount",
          "lastMessageRole",
          "lastMessageStatus",
          "lastSafetyStatus",
          "lastMessageAt",
        ]}
        rows={sessions}
        title="Recent chat sessions (no plaintext)"
      />
      <DataTable
        columns={["id", "targetType", "targetId", "layer", "status", "policyCode", "confidence", "createdAt"]}
        rows={events}
        title="Chat moderation events"
      />
    </div>
  );
}

function chatOpsDiagnosticText(diagnostics: ChatOpsDiagnostics | null) {
  if (!diagnostics) return "Chat Service is not connected.";
  if (diagnostics.reason === "missing_url") {
    return "Chat Service is not connected: CHAT_SERVICE_URL is missing.";
  }
  if (diagnostics.reason === "unauthorized") {
    return "Chat Service rejected the internal admin token.";
  }
  if (diagnostics.reason === "bad_json") {
    return "Chat Service responded, but the internal admin API returned invalid JSON.";
  }
  if (diagnostics.reason === "upstream_error") {
    return "Chat Service internal admin API returned an error.";
  }
  if (diagnostics.reason === "unreachable") {
    return "Chat Service is configured but unreachable.";
  }
  return "Chat Service is not connected.";
}

function metricNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
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
  const { column: columnLabel, locale, t } = useAdminI18n();

  return (
    <section className="rounded-lg overflow-hidden border border-[var(--ad-border)] bg-[var(--ad-surface)]">
      <div className="flex h-11 items-center justify-between border-b border-[var(--ad-border)] px-4">
        <h2 className="text-sm font-semibold">{t(title)}</h2>
        <span className="text-xs text-[var(--ad-text-muted)]">{rows.length}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] border-collapse text-left text-sm">
          <thead className="bg-black/[0.03] text-[11px] uppercase text-[var(--ad-text-muted)]">
            <tr>
              {columns.map((column) => (
                <th key={column} className="border-b border-[var(--ad-border)] px-3 py-2 font-semibold">
                  {columnLabel(column)}
                </th>
              ))}
              {actions ? (
                <th className="sticky right-0 z-10 border-b border-l border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 py-2 font-semibold">
                  {t("Actions")}
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={`${stringValue(row.id) || stringValue(row.key) || title}-${index}`} className="border-b border-[var(--ad-border)] last:border-0">
                {columns.map((column) => (
                  <td key={column} className="max-w-[260px] px-3 py-2 align-top text-[var(--ad-text)]">
                    {renderCell(row[column], locale)}
                  </td>
                ))}
                {actions ? (
                  <td className="sticky right-0 border-l border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 py-2 align-top shadow-[-12px_0_18px_rgba(0,0,0,0.22)]">
                    {actions(row)}
                  </td>
                ) : null}
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td className="px-3 py-8 text-center text-sm text-[var(--ad-text-muted)]" colSpan={columns.length + (actions ? 1 : 0)}>
                  {t("Empty")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// SPEC: a single stat cell. Plain <div> by default (health grid); when `href` is given,
//       renders as a clickable <Link> with a hover state — the Dashboard attention row reuses
//       this exact component instead of forking a second stat-tile design.
function Metric({
  href,
  label,
  value,
  meta,
}: {
  href?: string;
  label: string;
  value: string | number;
  meta: string;
}) {
  const { t } = useAdminI18n();
  const body = (
    <>
      <p className="text-xs font-medium text-[var(--ad-text-muted)]">{t(label)}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
      <p className="mt-1 text-xs text-[var(--ad-text-muted)]">{t(meta)}</p>
    </>
  );

  if (href) {
    return (
      <Link className="block bg-[var(--ad-surface)] p-4 transition-colors hover:bg-black/[0.04]" href={href}>
        {body}
      </Link>
    );
  }

  return <div className="bg-[var(--ad-surface)] p-4">{body}</div>;
}

function IconAction({
  disabled = false,
  icon,
  label,
  onClick,
}: {
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  const { t } = useAdminI18n();
  const displayLabel = t(label);

  return (
    <button
      className="rounded-md inline-flex h-8 items-center gap-1 border border-[var(--ad-border)] px-2 text-xs text-[var(--ad-text)] hover:bg-black/[0.04] disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled}
      onClick={onClick}
      title={displayLabel}
      type="button"
    >
      {icon}
      <span>{displayLabel}</span>
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
  if (section.kind === "billing") {
    return {
      ...section,
      rows: filterRows(section.rows),
      subscriptions: filterRows(section.subscriptions),
    };
  }
  if (section.kind === "pricing") return { ...section, rows: filterRows(section.rows) };
  if (section.kind === "deadletter") return { ...section, rows: filterRows(section.rows) };
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
        flags: filterRows(section.data.flags),
        recentJobs: filterRows(section.data.recentJobs),
      },
    };
  }
  if (section.kind === "content") return { ...section, characters: filterRows(section.characters) };
  if (section.kind === "promo") {
    return { ...section, codes: filterRows(section.codes), referrals: filterRows(section.referrals) };
  }
  if (section.kind === "support") return { ...section, rows: filterRows(section.rows) };
  if (section.kind === "approvals") return { ...section, rows: filterRows(section.rows) };
  if (section.kind === "chatops") {
    return { ...section, sessions: filterRows(section.sessions), events: filterRows(section.events) };
  }
  return section;
}

function modelAssetConfigureHref(item: ModelImportAsset) {
  const params = new URLSearchParams({ tab: "profiles", asset: item.path });
  return `/admin/generation/config?${params.toString()}`;
}

function readConfigUrlState(): { tab: ConfigTab | null; assetPath: string } {
  if (typeof window === "undefined") return { tab: null, assetPath: "" };
  const params = new URLSearchParams(window.location.search);
  const tab = configTabValue(params.get("tab"));
  return {
    tab,
    assetPath: params.get("asset") ?? "",
  };
}

function configTabValue(value: string | null): ConfigTab | null {
  if (value === "settings") return "settings";
  if (value === "profiles" || value === "drafts" || value === "published" || value === "create") {
    return "profiles";
  }
  return null;
}

function renderCell(value: unknown, locale: AdminLocale = "en") {
  if (typeof value === "boolean") {
    return (
      <span className={cn("inline-flex items-center gap-1 text-xs", value ? "text-[var(--ad-green-text)]" : "text-[var(--ad-text-muted)]")}>
        {value ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
        {locale === "zh" ? (value ? "是" : "否") : String(value)}
      </span>
    );
  }
  if (typeof value === "string") {
    if (value.includes("T") && value.endsWith("Z")) return compactDate(value, locale);
    if (["active", "completed", "approved", "actioned", "sent", "passed", "connected", "unlimited", "free_remaining", "resolved", "closed", "on_track"].includes(value)) {
      return <Status locale={locale} value={value} tone="good" />;
    }
    if (["failed", "blocked", "suspended", "removed", "refunded", "rejected", "disconnected", "free_at_limit", "overdue"].includes(value)) {
      return <Status locale={locale} value={value} tone="bad" />;
    }
    if (["draft", "queued", "pending", "open", "required", "generating", "flagged", "received", "waiting_on_user", "due_soon", "paused"].includes(value)) {
      return <Status locale={locale} value={value} tone="warn" />;
    }
    return <span className="break-words">{adminValueLabel(locale, value)}</span>;
  }
  if (typeof value === "number") return <span className="font-mono">{value}</span>;
  if (value === null || value === undefined) return <span className="text-[var(--ad-text-muted)]">-</span>;
  return (
    <code className="block max-w-[260px] truncate text-xs text-[var(--ad-text-muted)]">
      {JSON.stringify(value)}
    </code>
  );
}

function Status({
  locale,
  value,
  tone,
}: {
  locale: AdminLocale;
  value: string;
  tone: "good" | "bad" | "warn";
}) {
  return (
    <span
      className={cn(
        "inline-flex rounded px-2 py-0.5 text-xs font-medium",
        tone === "good" && "bg-[var(--ad-green-bg)] text-[var(--ad-green-text)]",
        tone === "bad" && "bg-[var(--ad-red-bg)] text-[var(--ad-red-text)]",
        tone === "warn" && "bg-[var(--ad-yellow-bg)] text-[var(--ad-yellow-text)]",
      )}
    >
      {adminValueLabel(locale, value)}
    </span>
  );
}

function selectedGenerationProfile(profiles: Row[], selectedId: string | null) {
  const options = profileOptions(profiles);
  if (selectedId) {
    const selected = options.find((profile) => stringValue(profile.id) === selectedId);
    if (selected) return selected;
  }
  return options.find((profile) => stringValue(profile.status) === "draft") ?? options[0] ?? null;
}

function profileOptions(profiles: Row[]) {
  return [...profiles].sort((a, b) => {
    const statusDelta = profileStatusRank(a) - profileStatusRank(b);
    if (statusDelta !== 0) return statusDelta;
    const timeDelta = rowTimestamp(b) - rowTimestamp(a);
    if (timeDelta !== 0) return timeDelta;
    return numberValue(b.version) - numberValue(a.version);
  });
}

function profileStatusRank(profile: Row) {
  const status = stringValue(profile.status);
  if (status === "draft") return 0;
  if (status === "active") return 1;
  return 2;
}

function profileDisplayName(profile: Row, locale: AdminLocale) {
  const label = stringValue(profile.label) || stringValue(profile.profileKey) || stringValue(profile.id);
  return adminValueLabel(locale, label);
}

function profileSourceLabel(profile: Row) {
  const sourcePath =
    stringValue(profile.sourceModelPath) ||
    stringValue(profile.diffusionModelPath) ||
    stringValue(profile.convertedModelPath);
  return pathFileName(sourcePath) || stringValue(profile.pipelineModel);
}

function profileVerificationSummary(profile: Row | null): ProfileVerificationSummary {
  if (!profile) {
    return {
      status: "missing",
      tone: "warn",
      meta: "No profile selected.",
      failureMode: "",
      blockedReason: "",
      components: [],
    };
  }
  const runnerConfig = isRecord(profile.runnerConfig) ? profile.runnerConfig : {};
  const dryRunRecord = isRecord(profile.dryRunSummary) ? profile.dryRunSummary : {};
  const verificationStatus = stringValue(runnerConfig.verificationStatus);
  const failureMode = stringValue(dryRunRecord.failureMode);
  const needsVerification = profileRequiresModelVerification(profile, runnerConfig);
  const components = profileComponentStatuses(runnerConfig.componentStatus);
  const badComponents = components.filter((component) => component.tone === "bad");
  const goodStatus = isPassedVerificationStatus(verificationStatus);

  let blockedReason = "";
  if (failureMode) {
    blockedReason = "Publish blocked until dry run has no failureMode.";
  } else if (verificationStatus && !goodStatus) {
    blockedReason = "Publish blocked until model verification passes.";
  } else if (!verificationStatus && needsVerification) {
    blockedReason = "Publish blocked until model verification passes.";
  } else if (badComponents.length > 0) {
    blockedReason = "Publish blocked until required model components are available.";
  }

  const status = verificationStatus || (needsVerification ? "missing" : "not_required");
  const tone: ProfileVerificationSummary["tone"] = blockedReason
    ? "bad"
    : goodStatus || !needsVerification
      ? "good"
      : "warn";
  const componentMeta =
    components.length > 0
      ? `${badComponents.length}/${components.length} component issues`
      : "No component status recorded";
  const meta = verificationMeta(status, needsVerification, componentMeta);

  return {
    status,
    tone,
    meta,
    failureMode,
    blockedReason,
    components,
  };
}

function profileRequiresModelVerification(profile: Row, runnerConfig: Record<string, unknown>) {
  if (stringValue(profile.mode) !== "image") return false;
  return Boolean(
    stringValue(profile.sourceModelPath) ||
      stringValue(profile.convertedModelPath) ||
      stringValue(profile.diffusionModelPath) ||
      stringValue(runnerConfig.diffusionModelPath) ||
      stringValue(runnerConfig.modelPath) ||
      stringValue(runnerConfig.workflowPath),
  );
}

function profileComponentStatuses(value: unknown): ProfileVerificationSummary["components"] {
  const componentStatus = isRecord(value) ? value : {};
  return Object.entries(componentStatus).map(([key, rawValue]) => {
    const status = componentStatusValue(rawValue) || "configured";
    return { key, status, tone: componentStatusTone(status) };
  });
}

function componentStatusValue(value: unknown) {
  const rawStatus = typeof value === "string" ? value : isRecord(value) ? stringValue(value.status) : "";
  const status = rawStatus.trim();
  const normalized = status.toLowerCase();
  if (normalized.startsWith("available:")) return "available";
  if (normalized.startsWith("missing:")) return "missing";
  if (normalized.startsWith("failed:")) return "failed";
  if (normalized.startsWith("unsupported:")) return "unsupported";
  return status;
}

function componentStatusTone(status: string): ProfileVerificationSummary["tone"] {
  const normalized = status.toLowerCase();
  if (
    normalized.includes("missing") ||
    normalized.includes("failed") ||
    normalized.includes("unsupported") ||
    normalized.includes("not_imported")
  ) {
    return "bad";
  }
  if (
    normalized.includes("available") ||
    normalized.includes("passed") ||
    normalized.includes("verified") ||
    normalized === "ok" ||
    normalized === "present"
  ) {
    return "good";
  }
  return "warn";
}

function isPassedVerificationStatus(status: string) {
  return ["passed", "verified", "manual_passed"].includes(status);
}

function verificationMeta(status: string, needsVerification: boolean, componentMeta: string) {
  if (status === "not_required") return `No local model verification required · ${componentMeta}`;
  if (status === "missing" && needsVerification) return `Verification status missing · ${componentMeta}`;
  if (isPassedVerificationStatus(status)) return `Model verification passed · ${componentMeta}`;
  return `verificationStatus is ${status} · ${componentMeta}`;
}

function profileRelatedJobs(jobs: Row[], profile: Row | null) {
  if (!profile) return [];
  const profileId = stringValue(profile.id);
  const profileKey = stringValue(profile.profileKey);
  const profileVersion = numberValue(profile.version);
  return [...jobs]
    .filter((job) => {
      const jobProfileId = stringValue(job.profileId);
      if (jobProfileId !== profileKey && jobProfileId !== profileId) return false;
      const jobVersion = numberValue(job.profileVersion);
      return !profileVersion || !jobVersion || jobVersion === profileVersion;
    })
    .sort((a, b) => rowTimestamp(b) - rowTimestamp(a));
}

function dryRunSummary(value: unknown) {
  const record = isRecord(value) ? value : null;
  if (!record) return { status: "missing", meta: "Run Dry Run before publish" };
  const status = stringValue(record.status) || "recorded";
  const passed = numberValue(record.passed);
  const total = numberValue(record.total);
  const sampleCount = numberValue(record.sampleCount);
  const consistencyRate = numberValue(record.consistencyRate);
  if (sampleCount > 0) {
    return {
      status,
      meta: `${sampleCount} samples${consistencyRate > 0 ? ` · ${formatPercent(consistencyRate)}` : ""}`,
    };
  }
  return {
    status,
    meta: total > 0 ? `${passed}/${total} samples` : "dry-run summary exists",
  };
}

function actionReviewComplete(action: PendingAction, review: ActionReviewDraft) {
  if (action.review !== "image_consistency") return true;
  const sampleCount = actionReviewCount(review.sampleCount);
  const passCount = actionReviewCount(review.passCount);
  const consistencyRate = consistencyRateFromReview(review);
  return Boolean(
    sampleCount !== undefined &&
      passCount !== undefined &&
      sampleCount >= 20 &&
      passCount <= sampleCount &&
      consistencyRate !== undefined &&
      consistencyRate >= 0.8,
  );
}

function actionReviewDryRunSummary(review: ActionReviewDraft | undefined) {
  const sampleCount = actionReviewCount(review?.sampleCount ?? "") ?? 0;
  const passCount = actionReviewCount(review?.passCount ?? "") ?? 0;
  const consistencyRate = sampleCount > 0 ? passCount / sampleCount : 0;
  return {
    source: "admin_console_manual_consistency_review",
    status: "manual_passed",
    sampleCount,
    successRate: 1,
    consistencyPassCount: passCount,
    consistencyRate,
    reviewUrl: review?.reviewUrl.trim() || undefined,
    reviewNotes: review?.notes.trim() || undefined,
  };
}

function consistencyRateFromReview(review: ActionReviewDraft) {
  const sampleCount = actionReviewCount(review.sampleCount);
  const passCount = actionReviewCount(review.passCount);
  if (!sampleCount || passCount === undefined || passCount > sampleCount) return undefined;
  return passCount / sampleCount;
}

function actionReviewCount(value: string) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function formatPercent(value: number | undefined) {
  return value === undefined ? "-" : `${Math.round(value * 100)}%`;
}

function latestImageAsset(jobs: Row[]) {
  for (const job of jobs) {
    const asset = jobAssets(job).find((item) => item.type === "image");
    if (asset) return asset;
  }
  return null;
}

function jobAssets(job: Row) {
  return Array.isArray(job.assets)
    ? job.assets
        .map((asset): { id: string; type: string; url: string; thumbnailUrl: string; safetyStatus: string } | null => {
          if (!isRecord(asset)) return null;
          const url = stringValue(asset.url);
          if (!url) return null;
          return {
            id: stringValue(asset.id),
            type: stringValue(asset.type),
            url,
            thumbnailUrl: stringValue(asset.thumbnailUrl) || url,
            safetyStatus: stringValue(asset.safetyStatus),
          };
        })
        .filter((asset): asset is { id: string; type: string; url: string; thumbnailUrl: string; safetyStatus: string } => asset !== null)
    : [];
}

function isTerminalJobStatus(status: string) {
  return ["completed", "failed", "blocked", "refunded"].includes(status);
}

function firstString(values: string[], fallback: string) {
  return values.find(Boolean) ?? fallback;
}

function jsonStringArrayValue(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function rowTimestamp(row: Row) {
  const updated = Date.parse(stringValue(row.updatedAt));
  if (Number.isFinite(updated)) return updated;
  const created = Date.parse(stringValue(row.createdAt));
  return Number.isFinite(created) ? created : 0;
}

function shortId(value: string) {
  if (value.length <= 10) return value;
  return value.slice(0, 6);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compactDate(value: string, locale: AdminLocale = "en") {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(adminDateLocale(locale), {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
