"use client";

import Link from "next/link";
import { ADMIN_PERMISSION_KEYS, type AdminPermissionKey } from "@idream/shared/admin/permissions";
import { type FormEvent, type KeyboardEvent, type ReactNode, type WheelEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Ban,
  Bookmark,
  Check,
  ChevronRight,
  ClipboardCheck,
  Flag,
  Inbox,
  Languages,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCcw,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { apiDelete, apiGet, apiWrite, formatApiError, type ApiEnvelope } from "@/components/admin/api";
import { BackendsView } from "@/components/admin/BackendsView";
import { GenerationMetricsView } from "@/components/admin/GenerationMetricsView";
import { WorkflowsView } from "@/components/admin/WorkflowsView";
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
import {
  type MetricDashboardResponse,
  type TodayProjection,
} from "@idream/shared/admin";
import { PlacementsSection } from "@/components/admin/placements/PlacementsSection";
import {
  GENERATION_JOBS_REFRESH_EVENT,
} from "@/features/jobs/query";
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
  adminSectionItem,
  parseAdminPath,
  defaultWorkModeForRole,
  navGroupsForPermissions,
  sectionIsPermitted,
  type AdminSubview,
  type NavItem,
  type WorkMode,
} from "@/components/admin/nav-config";
import type { AdminShellSignals } from "@/components/admin/shell-signals";
import { IncidentWorkspace } from "@/features/incidents/IncidentWorkspace";
import { CaseWorkspace } from "@/features/cases/CaseWorkspace";
import { CustomerWorkspace } from "@/features/customers/CustomerWorkspace";
import { GlobalAdminSearch } from "@/features/search/GlobalAdminSearch";
import { CharacterPerformanceWorkspace, CharacterWorkspace } from "@/features/characters/CharacterWorkspace";
import { CreativeRunWorkspace } from "@/features/creative/CreativeRunWorkspace";
import { JobsView as GenerationJobsWorkspace } from "@/features/jobs/JobsView";
import { AuditWorkspace } from "@/features/audit/AuditWorkspace";
import { PricingWorkspace } from "@/features/pricing/PricingWorkspace";
import { BillingWorkspace } from "@/features/billing/BillingWorkspace";
import { GenerationConfigWorkspace } from "@/features/config/GenerationConfigWorkspace";
import { DeadLetterWorkspace } from "@/features/dead-letter/DeadLetterWorkspace";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import {
  buildCompatibilityListUrl,
  readCompatibilityListQuery,
  type CompatibilityListQuery,
} from "@/features/compatibility-lists/query";

type Actor = {
  id: string;
  role: string;
};

type AdminConsoleClientProps = {
  actor: Actor | null;
  initialSection: string;
  initialAccess: boolean;
  initialPermissions: AdminPermissionKey[];
  shellSignals: AdminShellSignals;
  // dev-only：展示退出按钮以便切换内置账号。
  devLogout?: boolean;
};

type Row = Record<string, unknown>;

type PageInfo = { endCursor: string | null; hasNextPage: boolean };
const emptyPageInfo: PageInfo = { endCursor: null, hasNextPage: false };
type ListQuery = CompatibilityListQuery;

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
  legacy: AnalyticsData | null;
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
  | { kind: "moderation"; reports: Row[]; blockedMedia: Row[]; appeals: Row[]; pageInfo: { reports: PageInfo; blockedMedia: PageInfo; appeals: PageInfo }; query: ListQuery }
  | { kind: "users"; rows: Row[] }
  | { kind: "access"; rows: Row[] }
  | { kind: "analytics"; data: AnalyticsWorkspaceData }
  | { kind: "risk"; data: AbuseData }
  | { kind: "providers"; data: ProviderOpsData }
  | { kind: "content"; characters: Row[]; featured: Row[]; featuredIds: string[]; pageInfo: PageInfo; query: ListQuery }
  | { kind: "promo"; codes: Row[]; referrals: Row[]; pageInfo: { codes: PageInfo; referrals: PageInfo }; query: ListQuery }
  | { kind: "support"; rows: Row[] }
  | { kind: "approvals"; rows: Row[]; pageInfo: PageInfo; query: ListQuery }
  // 自取数视图（组件内部 fetch），section 只需一个标记，不在此预取数据。
  | {
      kind: "selfFetch";
      view:
        | "jobs"
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
        | "generation-metrics"
        | "incidents"
        | "cases"
        | "audit"
        | "character-performance"
        | "pricing"
        | "billing"
        | "config"
        | "dead-letter";
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
      pageInfo: { sessions: PageInfo; usage: PageInfo; events: PageInfo };
      query: ListQuery;
    };

type PendingAction = {
  title: string;
  endpoint: string;
  method: "POST" | "PATCH";
  confirmText: string;
  reasonRequired: boolean;
  idempotencyKey?: string;
  body: (reason: string, confirmation: string) => Record<string, unknown>;
};

type PermissionForm = {
  userId: string;
  permissionKey: string;
  effect: "grant" | "revoke" | "clear";
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
const SUPPORT_REQUEST_REFRESH_EVENT = "idream:support-requests-refresh";
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
  const initialRouteParams = new URLSearchParams(initialSection.split("?", 2)[1] ?? "");
  const activeItem = adminSectionItem(sectionId);
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
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const pendingActionDialogRef = useRef<HTMLDivElement | null>(null);
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [permissionForm, setPermissionForm] = useState<PermissionForm>(defaultPermissionForm);
  const [chatOpsFilters, setChatOpsFilters] = useState<ChatOpsFilters>(() => chatOpsFiltersFromParams(initialRouteParams));
  const [locale, setLocale] = useState<AdminLocale>("en");
  const [localeReady, setLocaleReady] = useState(false);
  const t = (key: string, values?: Record<string, string | number>) =>
    translateAdmin(locale, key, values);

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
      setData(await fetchSection(sectionId, {
        chatOps: nextChatOpsFilters,
        workMode: nextWorkMode,
        includeLegacyAnalytics: permissions.has("analytics.export"),
        searchParams: new URLSearchParams(window.location.search),
      }));
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

  useEffect(() => {
    const onPopState = () => {
      const filters = chatOpsFiltersFromParams(new URLSearchParams(window.location.search));
      setChatOpsFilters(filters);
      void load(filters);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
    // load intentionally reads the restored URL at event time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionId]);

  function updateRouteQuery(updates: Record<string, string | null>, clearCursors: readonly string[] = []) {
    const nextUrl = buildCompatibilityListUrl(window.location.pathname, window.location.search, updates, clearCursors);
    window.history.pushState(null, "", nextUrl);
    const params = new URLSearchParams(window.location.search);
    if (sectionId === "chat") {
      const filters = chatOpsFiltersFromParams(params);
      setChatOpsFilters(filters);
      void load(filters);
    } else {
      void load();
    }
  }

  function openAction(action: PendingAction) {
    setReason("");
    setConfirmation("");
    setActionStatus(null);
    setPendingAction(action);
  }

  useEffect(() => {
    if (!pendingAction) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const background = document.getElementById("admin-shell-background");
    const skipLink = document.getElementById("admin-skip-link");
    background?.setAttribute("aria-hidden", "true");
    skipLink?.setAttribute("aria-hidden", "true");
    if (background instanceof HTMLElement) background.inert = true;
    if (skipLink instanceof HTMLElement) skipLink.inert = true;
    const timer = window.setTimeout(() => {
      pendingActionDialogRef.current?.querySelector<HTMLElement>("textarea, input, button:not([disabled])")?.focus();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      background?.removeAttribute("aria-hidden");
      skipLink?.removeAttribute("aria-hidden");
      if (background instanceof HTMLElement) background.inert = false;
      if (skipLink instanceof HTMLElement) skipLink.inert = false;
      previousFocus?.focus();
    };
  }, [pendingAction]);

  function handlePendingActionDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && !actionBusy) {
      event.preventDefault();
      setPendingAction(null);
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(pendingActionDialogRef.current?.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
    ) ?? [])];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function submitAction() {
    if (!pendingAction) return;
    setActionBusy(true);
    setError(null);
    try {
      const response = await fetch(pendingAction.endpoint, {
        method: pendingAction.method,
        headers: {
          "content-type": "application/json",
          ...(pendingAction.idempotencyKey ? { "idempotency-key": pendingAction.idempotencyKey } : {}),
        },
        body: JSON.stringify(pendingAction.body(reason, confirmation)),
      });
      const payload = (await response.json()) as ApiEnvelope<unknown>;
      if (!payload.ok) {
        throw new Error(formatApiError(payload.error, "Admin action failed"));
      }
      const completedEndpoint = pendingAction.endpoint;
      const completedTitle = pendingAction.title;
      setPendingAction(null);
      setActionStatus(`${completedTitle} completed.`);
      await load();
      if (completedEndpoint.startsWith("/api/v1/admin/generation/jobs/")) {
        window.dispatchEvent(new Event(GENERATION_JOBS_REFRESH_EVENT));
      }
      if (completedEndpoint.startsWith("/api/v1/admin/support/requests/")) {
        window.dispatchEvent(new Event(SUPPORT_REQUEST_REFRESH_EVENT));
      }
    } catch (actionError) {
      setActionStatus(null);
      setError(actionError instanceof Error ? actionError.message : "Admin action failed");
    } finally {
      setActionBusy(false);
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
    <>
    <a className="admin-skip-link" href="#admin-main-content" id="admin-skip-link">Skip to admin content</a>
    <main className="min-h-screen overflow-x-hidden bg-[var(--ad-canvas)] text-[var(--ad-ink)]">
      <div className="flex min-h-screen" id="admin-shell-background">
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

        <section className="min-w-0 flex-1" id="admin-main-content">
          <header className="sticky top-0 z-20 border-b border-[var(--ad-border)] bg-[rgba(247,246,243,0.92)] backdrop-blur">
            <div className="grid gap-3 px-4 py-3 md:px-6 lg:flex lg:min-h-14 lg:items-center">
              <div className="min-w-0">
                <h1 className="text-base font-semibold md:text-lg">{t(activeItem.label)}</h1>
                <p className="truncate text-[11px] text-[var(--ad-text-muted)]">{actor.id} · {t(workModeLabel(workMode))}</p>
              </div>
              <div className="grid gap-2 sm:grid-cols-[1fr_auto] lg:ml-auto lg:flex lg:items-center">
                <GlobalAdminSearch />
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
                    onClick={() => {
                      window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT));
                      void load();
                    }}
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
            ) : loading && !data ? (
              <div className="flex h-48 items-center justify-center text-[var(--ad-text-muted)]">
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                {t("Loading")}
              </div>
            ) : (
              renderSection(data, subview, {
                openAction,
                permissionForm,
                setPermissionForm,
                chatOpsFilters,
                setChatOpsFilters,
                applyChatOpsFilters: (next) => {
                  setChatOpsFilters(next);
                  updateRouteQuery(chatOpsFiltersToRouteQuery(next), ["chatSessionCursor", "chatUsageCursor", "chatEventCursor"]);
                },
                updateQuery: updateRouteQuery,
                reload: () => void load(),
                permissions,
                canRead: canAccessActiveSection,
                workMode,
              })
            )}
          </div>
        </section>
      </div>

      {pendingAction ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4">
          <div
            aria-labelledby="pending-action-dialog-title"
            aria-modal="true"
            className="w-full max-w-md rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-5 shadow-2xl"
            onKeyDown={handlePendingActionDialogKeyDown}
            ref={pendingActionDialogRef}
            role="dialog"
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold" id="pending-action-dialog-title">{pendingAction.title}</h2>
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
                  (pendingAction.reasonRequired && reason.trim().length < 3)
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
    </>
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

async function fetchSection(
  sectionId: string,
  options: {
    chatOps?: ChatOpsFilters;
    workMode?: WorkMode;
    includeLegacyAnalytics?: boolean;
    searchParams?: URLSearchParams;
  } = {},
): Promise<SectionData> {
  const params = options.searchParams ?? new URLSearchParams();
  if (sectionId === "generation/jobs") {
    return { kind: "selfFetch", view: "jobs" };
  }
  if (sectionId === "ops/incidents") return { kind: "selfFetch", view: "incidents" };
  if (sectionId === "cases") return { kind: "selfFetch", view: "cases" };
  if (sectionId === "audit-log") return { kind: "selfFetch", view: "audit" };
  if (sectionId === "growth/characters") return { kind: "selfFetch", view: "character-performance" };
  if (sectionId === "generation/dead-letter") {
    return { kind: "selfFetch", view: "dead-letter" };
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
  if (sectionId === "generation/config") return { kind: "selfFetch", view: "config" };
  if (sectionId === "moderation") {
    const query = listQuery(params, ["moderationSearch", "moderationStatus", "moderationTargetType", "reportCursor", "mediaCursor", "appealCursor"]);
    const payload = await apiGet<{ reports: Row[]; blockedMedia: Row[]; appeals: Row[]; pageInfo: { reports: PageInfo; blockedMedia: PageInfo; appeals: PageInfo } }>(
      `/api/v1/admin/moderation/queue${queryString({
        search: query.moderationSearch,
        status: query.moderationStatus,
        targetType: query.moderationTargetType,
        reportCursor: query.reportCursor,
        mediaCursor: query.mediaCursor,
        appealCursor: query.appealCursor,
        limit: "25",
      })}`,
    );
    return {
      kind: "moderation",
      reports: payload.reports,
      blockedMedia: payload.blockedMedia,
      appeals: payload.appeals,
      pageInfo: payload.pageInfo ?? { reports: emptyPageInfo, blockedMedia: emptyPageInfo, appeals: emptyPageInfo },
      query,
    };
  }
  if (sectionId === "users") return { kind: "users", rows: [] };
  if (sectionId === "system/access") {
    const payload = await apiGet<{ items: Row[] }>("/api/v1/admin/users?limit=100");
    return { kind: "access", rows: payload.items };
  }
  if (sectionId === "billing") {
    return { kind: "selfFetch", view: "billing" };
  }
  if (sectionId === "pricing") return { kind: "selfFetch", view: "pricing" };
  if (sectionId === "analytics") {
    const [legacy, canonical] = await Promise.all([
      options.includeLegacyAnalytics
        ? apiGet<AnalyticsData>("/api/v1/admin/analytics/overview")
        : Promise.resolve(null),
      apiGet<MetricDashboardResponse>("/api/v2/admin/metrics"),
    ]);
    return { kind: "analytics", data: { legacy, canonical } };
  }
  if (sectionId === "risk") {
    const payload = await apiGet<AbuseData>("/api/v1/admin/risk/abuse");
    return { kind: "risk", data: payload };
  }
  if (sectionId === "support") {
    const payload = await apiGet<{ items: Row[] }>("/api/v1/admin/support/requests");
    return { kind: "support", rows: payload.items };
  }
  if (sectionId === "content") {
    const query = listQuery(params, ["contentSearch", "contentStatus", "contentVisibility", "contentCursor"]);
    const [characters, featured] = await Promise.all([
      apiGet<{ items: Row[]; pageInfo: PageInfo }>(`/api/v1/admin/content/characters${queryString({ search: query.contentSearch, status: query.contentStatus, visibility: query.contentVisibility, cursor: query.contentCursor, limit: "25" })}`),
      apiGet<{ items: Row[]; characterIds: string[] }>("/api/v1/admin/content/featured"),
    ]);
    return {
      kind: "content",
      characters: characters.items,
      featured: featured.items,
      featuredIds: featured.characterIds,
      pageInfo: characters.pageInfo ?? emptyPageInfo,
      query,
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
    const query = listQuery(params, ["promoSearch", "promoStatus", "referralStatus", "promoCursor", "referralCursor"]);
    const [codes, referrals] = await Promise.all([
      apiGet<{ items: Row[]; pageInfo: PageInfo }>(`/api/v1/admin/promo/redeem-codes${queryString({ search: query.promoSearch, status: query.promoStatus, cursor: query.promoCursor, limit: "25" })}`),
      apiGet<{ items: Row[]; pageInfo: PageInfo }>(`/api/v1/admin/promo/referrals${queryString({ search: query.promoSearch, status: query.referralStatus, cursor: query.referralCursor, limit: "25" })}`),
    ]);
    return { kind: "promo", codes: codes.items, referrals: referrals.items, pageInfo: { codes: codes.pageInfo ?? emptyPageInfo, referrals: referrals.pageInfo ?? emptyPageInfo }, query };
  }
  if (sectionId === "approvals") {
    const query = listQuery(params, ["approvalSearch", "approvalStatus", "approvalCursor"]);
    const payload = await apiGet<{ items: Row[]; pageInfo: PageInfo }>(`/api/v1/admin/approvals${queryString({ search: query.approvalSearch, status: query.approvalStatus || "pending", cursor: query.approvalCursor, limit: "25" })}`);
    return { kind: "approvals", rows: payload.items, pageInfo: payload.pageInfo ?? emptyPageInfo, query };
  }
  if (sectionId === "chat") {
    const filters = options.chatOps ?? defaultChatOpsFilters;
    const routeQuery = listQuery(params, ["chatUserId", "chatCharacterId", "chatSessionStatus", "chatEventStatus", "chatEventLayer", "chatPolicyCode", "chatTargetId", "chatLimit", "chatSessionCursor", "chatUsageCursor", "chatEventCursor"]);
    const common = {
      userId: filters.userId,
      limit: filters.limit,
    };
    const sessionQuery = queryString({
      ...common,
      characterId: filters.characterId,
      status: filters.sessionStatus,
      cursor: routeQuery.chatSessionCursor,
    });
    const usageQuery = queryString({ ...common, cursor: routeQuery.chatUsageCursor });
    const eventQuery = queryString({
      limit: filters.limit,
      status: filters.eventStatus,
      layer: filters.eventLayer,
      policyCode: filters.policyCode,
      targetId: filters.targetId,
      cursor: routeQuery.chatEventCursor,
    });
    const [overview, providerHealth, sessions, events] = await Promise.all([
      apiGet<{
        configured: boolean;
        diagnostics?: ChatOpsDiagnostics;
        overview: Record<string, unknown> | null;
      }>(
        "/api/v1/admin/chat/overview",
      ),
      apiGet<{ configured: boolean; diagnostics?: ChatOpsDiagnostics; items?: Row[]; pageInfo?: PageInfo }>(
        "/api/v1/admin/chat/provider-health",
      ),
      apiGet<{ configured: boolean; diagnostics?: ChatOpsDiagnostics; items?: Row[]; pageInfo?: PageInfo }>(
        `/api/v1/admin/chat/sessions${sessionQuery}`,
      ),
      apiGet<{ configured: boolean; diagnostics?: ChatOpsDiagnostics; items?: Row[]; pageInfo?: PageInfo }>(
        `/api/v1/admin/chat/moderation-events${eventQuery}`,
      ),
    ]);
    const usage = await apiGet<{ configured: boolean; diagnostics?: ChatOpsDiagnostics; items?: Row[]; pageInfo?: PageInfo }>(
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
      pageInfo: {
        sessions: sessions.pageInfo ?? emptyPageInfo,
        usage: usage.pageInfo ?? emptyPageInfo,
        events: events.pageInfo ?? emptyPageInfo,
      },
      query: routeQuery,
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

function parseCsv(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function intFromText(value: string, fallback: number) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function listQuery(params: URLSearchParams, keys: readonly string[]): ListQuery {
  return readCompatibilityListQuery(params, keys);
}

function chatOpsFiltersFromParams(params: URLSearchParams): ChatOpsFilters {
  const limit = params.get("chatLimit");
  return {
    userId: params.get("chatUserId")?.trim() ?? "",
    characterId: params.get("chatCharacterId")?.trim() ?? "",
    sessionStatus: params.get("chatSessionStatus")?.trim() || defaultChatOpsFilters.sessionStatus,
    eventStatus: params.get("chatEventStatus")?.trim() || defaultChatOpsFilters.eventStatus,
    eventLayer: params.get("chatEventLayer")?.trim() || defaultChatOpsFilters.eventLayer,
    policyCode: params.get("chatPolicyCode")?.trim() ?? "",
    targetId: params.get("chatTargetId")?.trim() ?? "",
    limit: ["25", "50", "100"].includes(limit ?? "") ? limit! : defaultChatOpsFilters.limit,
  };
}

function chatOpsFiltersToRouteQuery(filters: ChatOpsFilters) {
  return {
    chatUserId: filters.userId,
    chatCharacterId: filters.characterId,
    chatSessionStatus: filters.sessionStatus,
    chatEventStatus: filters.eventStatus,
    chatEventLayer: filters.eventLayer,
    chatPolicyCode: filters.policyCode,
    chatTargetId: filters.targetId,
    chatLimit: filters.limit,
  };
}

function renderSection(
  section: SectionData | null,
  subview: AdminSubview,
  ctx: {
    openAction: (action: PendingAction) => void;
    permissionForm: PermissionForm;
    setPermissionForm: (value: PermissionForm) => void;
    chatOpsFilters: ChatOpsFilters;
    setChatOpsFilters: (value: ChatOpsFilters) => void;
    applyChatOpsFilters: (value: ChatOpsFilters) => void;
    updateQuery: (updates: Record<string, string | null>, clearCursors?: readonly string[]) => void;
    reload: () => void | Promise<void>;
    permissions: ReadonlySet<AdminPermissionKey>;
    canRead: boolean;
    workMode: WorkMode;
  },
) {
  if (!section) return null;
  if (section.kind === "dashboard") {
    return <TodayView data={section.data} onPreferenceChanged={ctx.reload} workMode={ctx.workMode} />;
  }
  if (section.kind === "moderation") {
    return (
      <ModerationView
        appeals={section.appeals}
        blockedMedia={section.blockedMedia}
        openAction={ctx.openAction}
        reports={section.reports}
        pageInfo={section.pageInfo}
        query={section.query}
        updateQuery={ctx.updateQuery}
      />
    );
  }
  if (section.kind === "users") {
    return <CustomerWorkspace initialCustomerId={subview.kind === "detail" ? subview.id : null} />;
  }
  if (section.kind === "access") {
    return (
      <UsersView
        canChangeStatus={ctx.permissions.has("user.status.write")}
        canManagePermissions={ctx.permissions.has("user.role.write")}
        openAction={ctx.openAction}
        permissionForm={ctx.permissionForm}
        rows={section.rows}
        setPermissionForm={ctx.setPermissionForm}
      />
    );
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
        pageInfo={section.pageInfo}
        query={section.query}
        updateQuery={ctx.updateQuery}
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
        pageInfo={section.pageInfo}
        query={section.query}
        updateQuery={ctx.updateQuery}
      />
    );
  }
  if (section.kind === "support") {
    return <SupportRequestsView rows={section.rows} openAction={ctx.openAction} />;
  }
  if (section.kind === "approvals") {
    return <ApprovalsView rows={section.rows} openAction={ctx.openAction} pageInfo={section.pageInfo} query={section.query} updateQuery={ctx.updateQuery} />;
  }
  if (section.kind === "selfFetch") {
    if (section.view === "jobs") {
      return <GenerationJobsWorkspace />;
    }
    if (section.view === "production") {
      return <CreativeRunWorkspace permissions={{
        read: ctx.canRead,
        write: ctx.permissions.has("creative.run.write"),
        review: ctx.permissions.has("creative.run.review"),
        place: ctx.permissions.has("creative.placement.publish"),
        manageIncident: ctx.permissions.has("ops.incident.manage"),
      }} view={subview} />;
    }
    if (section.view === "assets") return <AssetsSection canReview={ctx.permissions.has("content.asset.review")} view={subview} />;
    if (section.view === "placements") return <PlacementsSection canPublish={ctx.permissions.has("creative.placement.publish")} view={subview} />;
    if (section.view === "official") {
      return <CharacterWorkspace permissions={{
        read: ctx.canRead,
        writeProject: ctx.permissions.has("character.project.write"),
        proposeRelease: ctx.permissions.has("character.release.propose"),
        publishRelease: ctx.permissions.has("character.release.publish"),
        reviewRelease: ctx.permissions.has("character.release.review"),
      }} view={subview} />;
    }
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
    if (section.view === "incidents") {
      return <IncidentWorkspace
        canManage={ctx.permissions.has("ops.incident.manage")}
        initialIncidentId={subview.kind === "detail" ? subview.id : null}
        key={subview.kind === "detail" ? subview.id : "incident-list"}
      />;
    }
    if (section.view === "cases") {
      return (
        <CaseWorkspace
          canAssign={ctx.permissions.has("case.assign")}
          canDecide={ctx.permissions.has("case.decide")}
          initialCaseId={subview.kind === "detail" ? subview.id : null}
          key={subview.kind === "detail" ? subview.id : "case-list"}
        />
      );
    }
    if (section.view === "audit") return <AuditWorkspace />;
    if (section.view === "character-performance") {
      return <CharacterPerformanceWorkspace
        canOpenProjects={[
          "character.project.read",
          "character.release.read",
          "character.performance.read",
        ].every((permission) => ctx.permissions.has(permission as AdminPermissionKey))}
        canRead={ctx.permissions.has("character.performance.read")}
      />;
    }
    if (section.view === "pricing") return <PricingWorkspace canWrite={ctx.permissions.has("config.pricing.write")} />;
    if (section.view === "billing") return <BillingWorkspace canAdjust={ctx.permissions.has("billing.ledger.adjust")} />;
    if (section.view === "config") {
      return <GenerationConfigWorkspace permissions={{
        manageProfiles: ctx.permissions.has("generation.config.write"),
        manageFlags: ctx.permissions.has("config.feature_flag.write"),
      }} />;
    }
    if (section.view === "dead-letter") {
      return <DeadLetterWorkspace permissions={{
        requeue: ctx.permissions.has("generation.job.requeue"),
        discard: ctx.permissions.has("ops.deadletter.write"),
      }} />;
    }
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
        pageInfo={section.pageInfo}
        updateQuery={ctx.updateQuery}
        providerHealth={section.providerHealth}
        sessions={section.sessions}
        usage={section.usage}
      />
    );
  }
  return null;
}

function ModerationView({
  reports,
  blockedMedia,
  appeals,
  openAction,
  pageInfo,
  query,
  updateQuery,
}: {
  reports: Row[];
  blockedMedia: Row[];
  appeals: Row[];
  openAction: (action: PendingAction) => void;
  pageInfo: { reports: PageInfo; blockedMedia: PageInfo; appeals: PageInfo };
  query: ListQuery;
  updateQuery: (updates: Record<string, string | null>, clearCursors?: readonly string[]) => void;
}) {
  return (
    <div className="space-y-6">
      <ServerListToolbar cursorKeys={["reportCursor", "mediaCursor", "appealCursor"]} fields={[
        { key: "moderationSearch", label: "Search" },
        { key: "moderationStatus", label: "Report status", options: ["open", "triaged", "reviewing", "actioned", "closed"] },
        { key: "moderationTargetType", label: "Target type", options: ["character", "media", "message"] },
      ]} query={query} updateQuery={updateQuery} />
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
        empty={queryIsFiltered(query, ["moderationSearch", "moderationStatus", "moderationTargetType"]) ? "No reports match these filters" : "No reports require review"}
      />
      <CanonicalPager cursorKey="reportCursor" pageInfo={pageInfo.reports} updateQuery={updateQuery} />
      <DataTable
        columns={["id", "ownerId", "type", "safetyStatus", "createdAt"]}
        rows={blockedMedia}
        title="Blocked Media"
        empty={query.moderationSearch ? "No blocked media match this search" : "No blocked media require review"}
      />
      <CanonicalPager cursorKey="mediaCursor" pageInfo={pageInfo.blockedMedia} updateQuery={updateQuery} />
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
        empty={query.moderationSearch ? "No appeals match this search" : "No appeals require review"}
      />
      <CanonicalPager cursorKey="appealCursor" pageInfo={pageInfo.appeals} updateQuery={updateQuery} />
    </div>
  );
}

export function UsersView({
  rows,
  openAction,
  permissionForm,
  setPermissionForm,
  canChangeStatus,
  canManagePermissions,
}: {
  rows: Row[];
  openAction: (action: PendingAction) => void;
  permissionForm: PermissionForm;
  setPermissionForm: (value: PermissionForm) => void;
  canChangeStatus: boolean;
  canManagePermissions: boolean;
}) {
  const { t, value: valueLabel } = useAdminI18n();

  return (
    <div className="space-y-5">
      {canManagePermissions ? <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
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
                idempotencyKey: crypto.randomUUID(),
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
      </section> : null}
      <DataTable
        actions={canChangeStatus ? (row) => {
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
                  idempotencyKey: crypto.randomUUID(),
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
        } : undefined}
        columns={["id", "email", "displayName", "role", "status", "dreamcoins", "createdAt"]}
        rows={rows}
        title="Users"
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
      {legacy ? (
        <>
          <p className="text-xs text-[var(--ad-text-muted)]">
            {t("Window")} {compactDate(legacy.window.from, locale)} → {compactDate(legacy.window.to, locale)} ·{" "}
            {t("legacy operational diagnostics")}
          </p>
          <div className="rounded-lg grid gap-px overflow-hidden border border-[var(--ad-border)] bg-black/[0.05] md:grid-cols-4">
            <Metric label="Signups" value={legacy.funnel.signups} meta="new users" />
            <Metric label="Activated" value="Invalid" meta="invalid for decisions · definition v1" />
            <Metric label="Paying" value={legacy.funnel.payingUsers} meta="subscribed" />
            <Metric label="Conversion" value="Invalid" meta="invalid for decisions · mixed cohort/window" />
          </div>
          <div className="rounded-lg grid gap-px overflow-hidden border border-[var(--ad-border)] bg-black/[0.05] md:grid-cols-4">
            <Metric label="Generations" value={legacy.generation.total} meta={t("{count} completed", { count: legacy.generation.completed })} />
            <Metric label="Failed" value={legacy.generation.failed} meta="generation jobs" />
            <Metric label="Blocked" value={legacy.generation.blocked} meta="generation jobs" />
            <Metric label="Coins net" value={legacy.economy.net} meta={t("{count} granted", { count: legacy.economy.coinsGranted })} />
          </div>
          <DataTable columns={["reason", "totalDelta", "count"]} rows={legacy.economy.byReason} title="Coin economy by reason" />
          <DataTable columns={["name", "count"]} rows={legacy.topEvents} title="Top events" />
        </>
      ) : (
        <p className="rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3 text-xs text-[var(--ad-text-muted)]">
          Technical metric scope: business and legacy diagnostics are not included.
        </p>
      )}
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

function ContentView({
  characters,
  featured,
  featuredIds,
  openAction,
  reload,
  pageInfo,
  query,
  updateQuery,
}: {
  characters: Row[];
  featured: Row[];
  featuredIds: string[];
  openAction: (action: PendingAction) => void;
  reload: () => void;
  pageInfo: PageInfo;
  query: ListQuery;
  updateQuery: (updates: Record<string, string | null>, clearCursors?: readonly string[]) => void;
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
      <ServerListToolbar cursorKeys={["contentCursor"]} fields={[
        { key: "contentSearch", label: "Search" },
        { key: "contentStatus", label: "Status", options: ["draft", "pending_review", "approved", "rejected", "removed", "archived"] },
        { key: "contentVisibility", label: "Visibility", options: ["private", "unlisted", "public"] },
      ]} query={query} updateQuery={updateQuery} />
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
        {err ? <p role="alert" className="mt-2 text-xs text-[var(--ad-red-text)]">{err}</p> : null}
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
        empty={queryIsFiltered(query, ["contentSearch", "contentStatus", "contentVisibility"]) ? "No characters match these filters" : "No characters exist yet"}
      />
      <CanonicalPager cursorKey="contentCursor" pageInfo={pageInfo} updateQuery={updateQuery} />
    </div>
  );
}

function PromoView({
  codes,
  referrals,
  openAction,
  reload,
  pageInfo,
  query,
  updateQuery,
}: {
  codes: Row[];
  referrals: Row[];
  openAction: (action: PendingAction) => void;
  reload: () => void;
  pageInfo: { codes: PageInfo; referrals: PageInfo };
  query: ListQuery;
  updateQuery: (updates: Record<string, string | null>, clearCursors?: readonly string[]) => void;
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
      <ServerListToolbar cursorKeys={["promoCursor", "referralCursor"]} fields={[
        { key: "promoSearch", label: "Search" },
        { key: "promoStatus", label: "Code status", options: ["active", "disabled", "expired"] },
        { key: "referralStatus", label: "Referral status", options: ["pending", "qualified", "rewarded", "rejected"] },
      ]} query={query} updateQuery={updateQuery} />
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
        {err ? <p role="alert" className="mt-2 text-xs text-[var(--ad-red-text)]">{err}</p> : null}
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
        empty={queryIsFiltered(query, ["promoSearch", "promoStatus"]) ? "No redeem codes match these filters" : "No redeem codes exist yet"}
      />
      <CanonicalPager cursorKey="promoCursor" pageInfo={pageInfo.codes} updateQuery={updateQuery} />
      <DataTable
        columns={["id", "inviterId", "inviteeId", "status", "rewardStatus", "createdAt"]}
        rows={referrals}
        title="Referrals"
        empty={queryIsFiltered(query, ["promoSearch", "referralStatus"]) ? "No referrals match these filters" : "No referrals exist yet"}
      />
      <CanonicalPager cursorKey="referralCursor" pageInfo={pageInfo.referrals} updateQuery={updateQuery} />
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
  const [visibleRows, setVisibleRows] = useState<Row[]>(rows);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [pageInfo, setPageInfo] = useState({ endCursor: null as string | null, hasNextPage: false });
  const [ready, setReady] = useState(false);
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

  const loadRows = useCallback(async (nextCursor?: string) => {
    setListLoading(true);
    setListError(null);
    try {
      const params = new URLSearchParams({ limit: "25" });
      if (filters.query.trim()) params.set("search", filters.query.trim());
      if (filters.status !== "all") params.set("status", filters.status);
      if (filters.sla !== "all") params.set("sla", filters.sla);
      if (filters.category.trim()) params.set("category", filters.category.trim());
      if (nextCursor) params.set("cursor", nextCursor);
      const data = await apiGet<{ items: Row[]; pageInfo: { endCursor: string | null; hasNextPage: boolean } }>(`/api/v1/admin/support/requests?${params}`);
      setVisibleRows(data.items);
      setCursor(nextCursor);
      setPageInfo(data.pageInfo);
      window.history.replaceState(null, "", `${window.location.pathname}?${params}`);
    } catch (cause) {
      setVisibleRows([]);
      setPageInfo({ endCursor: null, hasNextPage: false });
      setListError(cause instanceof Error ? cause.message : "Support requests could not be loaded");
    } finally {
      setListLoading(false);
    }
  }, [filters.category, filters.query, filters.sla, filters.status]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const timer = window.setTimeout(() => {
      setFilters({
        query: params.get("search") ?? "",
        status: supportStatusFromUnknown(params.get("status")),
        sla: supportSlaFromUnknown(params.get("sla")),
        category: params.get("category") ?? "",
      });
      setCursor(params.get("cursor") ?? undefined);
      setReady(true);
      void loadSavedViews();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadSavedViews]);

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => void loadRows(cursor), filters.query.trim() ? 250 : 0);
    const refresh = () => void loadRows(cursor);
    window.addEventListener(SUPPORT_REQUEST_REFRESH_EVENT, refresh);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(SUPPORT_REQUEST_REFRESH_EVENT, refresh);
    };
  }, [cursor, filters.query, loadRows, ready]);

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
    setCursor(undefined);
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
              onChange={(event) => { setFilters((current) => ({ ...current, query: event.target.value })); setCursor(undefined); }}
              placeholder={t("Ticket, user, subject, or notes")}
              value={filters.query}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Status")}</span>
            <select
              aria-label={t("Support status")}
              className="rounded-md h-10 w-full border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm text-[var(--ad-text)] outline-none focus:border-[var(--ad-ink)]"
              onChange={(event) => {
                setFilters((current) => ({
                  ...current,
                  status: supportStatusFromUnknown(event.target.value),
                }));
                setCursor(undefined);
              }}
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
              onChange={(event) => {
                setFilters((current) => ({
                  ...current,
                  sla: supportSlaFromUnknown(event.target.value),
                }));
                setCursor(undefined);
              }}
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
              onChange={(event) => { setFilters((current) => ({ ...current, category: event.target.value })); setCursor(undefined); }}
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
              onClick={() => { setFilters(defaultSupportRequestFilters); setCursor(undefined); }}
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

      {listError ? <p className="text-sm text-[var(--ad-red-text)]" role="alert">{listError}</p> : null}

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
      <div className="flex justify-end"><button className="min-h-10 rounded-md border border-[var(--ad-border)] px-4 text-sm font-semibold disabled:opacity-50" disabled={listLoading || !pageInfo.hasNextPage || !pageInfo.endCursor} onClick={() => setCursor(pageInfo.endCursor ?? undefined)} type="button">Next page</button></div>
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

function ApprovalsView({
  rows,
  openAction,
  pageInfo,
  query,
  updateQuery,
}: {
  rows: Row[];
  openAction: (action: PendingAction) => void;
  pageInfo: PageInfo;
  query: ListQuery;
  updateQuery: (updates: Record<string, string | null>, clearCursors?: readonly string[]) => void;
}) {
  return (
    <div className="space-y-4">
      <ServerListToolbar cursorKeys={["approvalCursor"]} fields={[
        { key: "approvalSearch", label: "Search" },
        { key: "approvalStatus", label: "Status", options: ["pending", "approved", "rejected", "canceled"] },
      ]} query={query} updateQuery={updateQuery} />
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
        empty={queryIsFiltered(query, ["approvalSearch", "approvalStatus"]) ? "No approval requests match these filters" : "No approval requests are pending"}
      />
      <CanonicalPager cursorKey="approvalCursor" pageInfo={pageInfo} updateQuery={updateQuery} />
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
  pageInfo,
  updateQuery,
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
  pageInfo: { sessions: PageInfo; usage: PageInfo; events: PageInfo };
  updateQuery: (updates: Record<string, string | null>) => void;
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
        empty={filters.userId ? "No chat usage matches this user" : "No chat usage exists for the current product day"}
      />
      <CanonicalPager cursorKey="chatUsageCursor" pageInfo={pageInfo.usage} updateQuery={updateQuery} />
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
        empty={filters.userId || filters.characterId || filters.sessionStatus !== "all" ? "No chat sessions match these filters" : "No chat sessions exist yet"}
      />
      <CanonicalPager cursorKey="chatSessionCursor" pageInfo={pageInfo.sessions} updateQuery={updateQuery} />
      <DataTable
        columns={["id", "targetType", "targetId", "layer", "status", "policyCode", "confidence", "createdAt"]}
        rows={events}
        title="Chat moderation events"
        empty={filters.eventStatus !== "all" || filters.eventLayer !== "all" || filters.policyCode || filters.targetId ? "No chat events match these filters" : "No chat events exist yet"}
      />
      <CanonicalPager cursorKey="chatEventCursor" pageInfo={pageInfo.events} updateQuery={updateQuery} />
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

type ServerQueryField = {
  key: string;
  label: string;
  options?: readonly string[];
};

function ServerListToolbar({
  query,
  fields,
  cursorKeys,
  updateQuery,
}: {
  query: ListQuery;
  fields: readonly ServerQueryField[];
  cursorKeys: readonly string[];
  updateQuery: (updates: Record<string, string | null>, clearCursors?: readonly string[]) => void;
}) {
  const { t } = useAdminI18n();

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    updateQuery(Object.fromEntries(fields.map((field) => [field.key, String(form.get(field.key) ?? "")])), cursorKeys);
  }

  return (
    <form className="rounded-lg grid gap-3 border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 md:grid-cols-2 xl:grid-cols-4" key={fields.map((field) => `${field.key}:${query[field.key] ?? ""}`).join("|")} onSubmit={apply}>
      {fields.map((field) => field.options ? (
        <label className="grid gap-1" key={field.key}>
          <span className="text-xs font-medium text-[var(--ad-text-muted)]">{t(field.label)}</span>
          <select className="h-11 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm" defaultValue={query[field.key] ?? ""} name={field.key}>
            <option value="">{t("All")}</option>
            {field.options.map((option) => <option key={option} value={option}>{t(option)}</option>)}
          </select>
        </label>
      ) : (
        <label className="grid gap-1" key={field.key}>
          <span className="text-xs font-medium text-[var(--ad-text-muted)]">{t(field.label)}</span>
          <input className="h-11 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm" defaultValue={query[field.key] ?? ""} name={field.key} type="search" />
        </label>
      ))}
      <div className="flex items-end gap-2">
        <button className="inline-flex h-11 items-center gap-2 rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white" type="submit"><Search className="h-4 w-4" />{t("Apply")}</button>
        <button className="inline-flex h-11 items-center gap-2 rounded-md border border-[var(--ad-border)] px-4 text-sm" onClick={() => updateQuery(Object.fromEntries(fields.map((field) => [field.key, null])), cursorKeys)} type="button"><RotateCcw className="h-4 w-4" />{t("Reset")}</button>
      </div>
    </form>
  );
}

function CanonicalPager({ pageInfo, cursorKey, updateQuery }: { pageInfo: PageInfo; cursorKey: string; updateQuery: (updates: Record<string, string | null>) => void }) {
  const { t } = useAdminI18n();
  if (!pageInfo.hasNextPage || !pageInfo.endCursor) return null;
  return <button className="inline-flex h-11 items-center gap-2 rounded-md border border-[var(--ad-border)] px-4 text-sm" onClick={() => updateQuery({ [cursorKey]: pageInfo.endCursor })} type="button">{t("Next page")}<ChevronRight className="h-4 w-4" /></button>;
}

function queryIsFiltered(query: ListQuery, keys: readonly string[]) {
  return keys.some((key) => Boolean(query[key]));
}

function DataTable({
  title,
  rows,
  columns,
  actions,
  empty,
}: {
  title: string;
  rows: Row[];
  columns: string[];
  actions?: (row: Row) => React.ReactNode;
  empty?: string;
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
          <caption className="sr-only">{t("Operational records")}</caption>
          <thead className="bg-black/[0.03] text-[11px] uppercase text-[var(--ad-text-muted)]">
            <tr>
              {columns.map((column) => (
                <th scope="col" key={column} className="border-b border-[var(--ad-border)] px-3 py-2 font-semibold">
                  {columnLabel(column)}
                </th>
              ))}
              {actions ? (
                <th scope="col" className="sticky right-0 z-10 border-b border-l border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 py-2 font-semibold">
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
                  {t(empty ?? "No records exist yet")}
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

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
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
