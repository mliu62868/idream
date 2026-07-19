"use client";

import Link from "next/link";
import { type AdminPermissionKey } from "@idream/shared/admin/permissions";
import { type KeyboardEvent, type WheelEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Ban,
  Check,
  ChevronRight,
  Languages,
  Loader2,
  Menu,
  RefreshCcw,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { apiGet, formatApiError, type ApiEnvelope } from "@/components/admin/api";
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
import { type TodayProjection } from "@idream/shared/admin";
import { PlacementsSection } from "@/components/admin/placements/PlacementsSection";
import {
  GENERATION_JOBS_REFRESH_EVENT,
} from "@/features/jobs/query";
import {
  AdminI18nProvider,
  getStoredAdminLocale,
  storeAdminLocale,
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
import { AccessWorkspace } from "@/features/access/AccessWorkspace";
import { ModerationWorkspace } from "@/features/moderation/ModerationWorkspace";
import { SupportWorkspace } from "@/features/support/SupportWorkspace";
import { PromoWorkspace } from "@/features/promo/PromoWorkspace";
import { ApprovalsWorkspace } from "@/features/approvals/ApprovalsWorkspace";
import { ChatOpsWorkspace } from "@/features/chat-ops/ChatOpsWorkspace";
import { ContentMerchandisingWorkspace } from "@/features/content-merchandising/ContentMerchandisingWorkspace";
import {
  AnalyticsWorkspace,
  ProviderOverviewWorkspace,
  RiskWorkspace,
} from "@/features/overviews/OverviewWorkspaces";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import { buildCompatibilityListUrl } from "@/features/compatibility-lists/query";

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


type DashboardData = TodayData;

type SectionData =
  | { kind: "dashboard"; data: DashboardData }
  | { kind: "users"; rows: Row[] }
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
        | "dead-letter"
        | "access"
        | "moderation"
        | "support"
        | "promo"
        | "approvals"
        | "chat"
        | "content-merchandising"
        | "analytics-overview"
        | "risk-overview"
        | "provider-overview";
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

export function AdminConsoleClient(props: AdminConsoleClientProps) {
  const [locale, setLocale] = useState<AdminLocale>("en");
  const [localeReady, setLocaleReady] = useState(false);

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

  return (
    <AdminI18nProvider locale={locale}>
      <AdminConsoleContent {...props} locale={locale} setLocale={setLocale} />
    </AdminI18nProvider>
  );
}

function AdminConsoleContent({
  actor,
  initialSection,
  initialAccess,
  initialPermissions,
  shellSignals,
  devLogout = false,
  locale,
  setLocale,
}: AdminConsoleClientProps & {
  locale: AdminLocale;
  setLocale: (locale: AdminLocale) => void;
}) {
  const { t } = useAdminI18n();
  const sidebarNavRef = useRef<HTMLElement | null>(null);
  const mobileNavRef = useRef<HTMLElement | null>(null);
  const mobileNavTriggerRef = useRef<HTMLButtonElement | null>(null);
  const { sectionId, view: subview } = parseAdminPath(initialSection);
  const activeItem = adminSectionItem(sectionId);
  const permissions = useMemo(() => new Set(initialPermissions), [initialPermissions]);
  const canAccessActiveSection = sectionIsPermitted(sectionId, permissions);
  const [workMode, setWorkMode] = useState<WorkMode>(() => defaultWorkModeForRole(actor?.role));
  const navGroups = useMemo(
    () => navGroupsForPermissions(permissions, workMode),
    [permissions, workMode],
  );
  const [data, setData] = useState<SectionData | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const pendingActionDialogRef = useRef<HTMLDivElement | null>(null);
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const skipLink = document.getElementById("admin-skip-link");
    const trigger = mobileNavTriggerRef.current;
    const previousOverflow = document.body.style.overflow;
    skipLink?.setAttribute("aria-hidden", "true");
    if (skipLink instanceof HTMLElement) skipLink.inert = true;
    document.body.style.overflow = "hidden";
    const timer = window.setTimeout(() => {
      mobileNavRef.current?.querySelector<HTMLElement>("button, a")?.focus();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      skipLink?.removeAttribute("aria-hidden");
      if (skipLink instanceof HTMLElement) skipLink.inert = false;
      document.body.style.overflow = previousOverflow;
      trigger?.focus();
    };
  }, [mobileNavOpen]);

  useEffect(() => {
    const persistentSidebar = window.matchMedia("(min-width: 1280px)");
    const closeDrawer = (event: MediaQueryListEvent) => {
      if (event.matches) setMobileNavOpen(false);
    };
    persistentSidebar.addEventListener("change", closeDrawer);
    return () => persistentSidebar.removeEventListener("change", closeDrawer);
  }, []);

  function handleMobileNavKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setMobileNavOpen(false);
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(mobileNavRef.current?.querySelectorAll<HTMLElement>(
      "button:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])",
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

  async function load(nextWorkMode: WorkMode = workMode) {
    if (!initialAccess || !canAccessActiveSection) return;
    setLoading(true);
    setError(null);
    try {
      setData(await fetchSection(sectionId, {
        workMode: nextWorkMode,
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
      void load();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
    // load intentionally reads the restored URL at event time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionId]);

  function updateRouteQuery(updates: Record<string, string | null>, clearCursors: readonly string[] = []) {
    const nextUrl = buildCompatibilityListUrl(window.location.pathname, window.location.search, updates, clearCursors);
    window.history.pushState(null, "", nextUrl);
    void load();
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
      <main
        className="min-h-screen bg-[var(--ad-canvas)] px-6 py-8 text-[var(--ad-ink)]"
        data-admin-auth-wall="access-denied-v1"
      >
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
    <>
    <title>{`${t(activeItem.label)} | iDream Admin`}</title>
    <a className="admin-skip-link" href="#admin-main-content" id="admin-skip-link">{t("Skip to admin content")}</a>
    <main className="min-h-screen overflow-x-hidden bg-[var(--ad-canvas)] text-[var(--ad-ink)]">
      <div className="flex min-h-screen" id="admin-shell-background">
        <aside
          inert={mobileNavOpen ? true : undefined}
          className="sticky top-0 hidden h-screen w-[248px] shrink-0 overflow-hidden border-r border-[var(--ad-border)] bg-[var(--ad-surface)] xl:flex xl:flex-col"
          onWheel={handleSidebarWheel}
        >
          <div className="flex h-14 shrink-0 items-center border-b border-[var(--ad-border)] px-5">
            <div>
              <p className="text-sm font-semibold">iDream Admin</p>
              <p className="text-[11px] text-[var(--ad-text-muted)]">{t(actor.role)}</p>
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

        {mobileNavOpen ? (
          <div className="fixed inset-0 z-50 xl:hidden">
            <button
              aria-label={t("Close navigation")}
              className="absolute inset-0 bg-black/50"
              onClick={() => setMobileNavOpen(false)}
              type="button"
            />
            <aside
              aria-label={t("Admin navigation")}
              aria-modal="true"
              className="relative flex h-full w-[min(22rem,88vw)] flex-col border-r border-[var(--ad-border)] bg-[var(--ad-surface)] shadow-2xl"
              id="admin-mobile-navigation"
              onKeyDown={handleMobileNavKeyDown}
              ref={mobileNavRef}
              role="dialog"
            >
              <div className="flex min-h-14 items-center justify-between border-b border-[var(--ad-border)] px-4">
                <div>
                  <p className="text-sm font-semibold">iDream Admin</p>
                  <p className="text-[11px] text-[var(--ad-text-muted)]">{t(actor.role)}</p>
                </div>
                <button
                  aria-label={t("Close navigation")}
                  className="grid min-h-11 min-w-11 place-items-center rounded-md hover:bg-black/[0.04]"
                  onClick={() => setMobileNavOpen(false)}
                  type="button"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <nav className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
                {navGroups.map(({ group, items }) => (
                  <section className="border-b border-[var(--ad-border)] py-2 last:border-b-0" key={group}>
                    {group === "Today" ? null : (
                      <h2 className="px-3 pb-1 text-[10px] font-semibold uppercase text-[var(--ad-text-muted)]">
                        {t(group)}
                      </h2>
                    )}
                    {items.map((item) => (
                      <NavLink
                        active={item.id === sectionId}
                        item={item}
                        key={item.id}
                        onNavigate={() => setMobileNavOpen(false)}
                      />
                    ))}
                  </section>
                ))}
              </nav>
            </aside>
          </div>
        ) : null}

        <section className="min-w-0 flex-1" id="admin-main-content" inert={mobileNavOpen ? true : undefined}>
          <header className="sticky top-0 z-20 border-b border-[var(--ad-border)] bg-[rgba(247,246,243,0.92)] backdrop-blur">
            <div className="grid gap-3 px-4 py-3 md:px-6 lg:flex lg:min-h-14 lg:items-center">
              <div className="flex min-w-0 items-center gap-3">
                <button
                  aria-controls="admin-mobile-navigation"
                  aria-expanded={mobileNavOpen}
                  aria-label={t("Open navigation")}
                  className="grid min-h-11 min-w-11 shrink-0 place-items-center rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] xl:hidden"
                  onClick={() => setMobileNavOpen(true)}
                  ref={mobileNavTriggerRef}
                  type="button"
                >
                  <Menu className="h-5 w-5" />
                </button>
                <div className="min-w-0">
                  <h1 className="truncate text-base font-semibold md:text-lg">{t(activeItem.label)}</h1>
                  <p className="truncate text-[11px] text-[var(--ad-text-muted)]">{actor.id} · {t(workModeLabel(workMode))}</p>
                </div>
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
                          if (sectionId === "dashboard") void load(nextMode);
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
                updateQuery: updateRouteQuery,
                reload: () => void load(),
                permissions,
                canRead: canAccessActiveSection,
                workMode,
                actorId: actor?.id ?? "anonymous",
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
                aria-label={t("Close")}
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
      tabIndex={0}
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
function NavLink({ active, item, onNavigate }: { active: boolean; item: NavItem; onNavigate?: () => void }) {
  const { t } = useAdminI18n();
  const Icon = item.icon;

  return (
    <Link
      className={cn(
        "mb-1 flex h-10 items-center gap-3 rounded-md px-3 text-[13px] font-medium text-[var(--ad-text-muted)] transition-colors hover:bg-black/[0.04] hover:text-[var(--ad-ink)]",
        active && "bg-black/[0.05] text-[var(--ad-ink)]",
      )}
      href={item.href}
      onClick={onNavigate}
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
    workMode?: WorkMode;
  } = {},
): Promise<SectionData> {
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
    return { kind: "selfFetch", view: "provider-overview" };
  }
  if (sectionId === "generation/recipes") return { kind: "selfFetch", view: "recipes" };
  if (sectionId === "generation/presets") return { kind: "selfFetch", view: "presets" };
  if (sectionId === "generation/config") return { kind: "selfFetch", view: "config" };
  if (sectionId === "moderation") return { kind: "selfFetch", view: "moderation" };
  if (sectionId === "users") return { kind: "users", rows: [] };
  if (sectionId === "system/access") return { kind: "selfFetch", view: "access" };
  if (sectionId === "billing") {
    return { kind: "selfFetch", view: "billing" };
  }
  if (sectionId === "pricing") return { kind: "selfFetch", view: "pricing" };
  if (sectionId === "analytics") {
    return { kind: "selfFetch", view: "analytics-overview" };
  }
  if (sectionId === "risk") {
    return { kind: "selfFetch", view: "risk-overview" };
  }
  if (sectionId === "support") return { kind: "selfFetch", view: "support" };
  if (sectionId === "content") {
    return { kind: "selfFetch", view: "content-merchandising" };
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
  if (sectionId === "promo") return { kind: "selfFetch", view: "promo" };
  if (sectionId === "approvals") return { kind: "selfFetch", view: "approvals" };
  if (sectionId === "chat") return { kind: "selfFetch", view: "chat" };

  const [legacy, projection] = await Promise.all([
    apiGet<TodayLegacyData>("/api/v1/admin/dashboard"),
    apiGet<TodayProjection>(`/api/v2/admin/today?workMode=${encodeURIComponent(options.workMode ?? "admin")}`),
  ]);
  return { kind: "dashboard", data: { legacy, projection } };
}


function renderSection(
  section: SectionData | null,
  subview: AdminSubview,
  ctx: {
    openAction: (action: PendingAction) => void;
    updateQuery: (updates: Record<string, string | null>, clearCursors?: readonly string[]) => void;
    reload: () => void | Promise<void>;
    permissions: ReadonlySet<AdminPermissionKey>;
    canRead: boolean;
    workMode: WorkMode;
    actorId: string;
  },
) {
  if (!section) return null;
  if (section.kind === "dashboard") {
    return <TodayView data={section.data} onPreferenceChanged={ctx.reload} workMode={ctx.workMode} />;
  }
  if (section.kind === "users") {
    return <CustomerWorkspace initialCustomerId={subview.kind === "detail" ? subview.id : null} />;
  }
  if (section.kind === "selfFetch") {
    if (section.view === "jobs") {
      return <GenerationJobsWorkspace />;
    }
    if (section.view === "production") {
      return <CreativeRunWorkspace actorId={ctx.actorId} permissions={{
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
      return <CharacterWorkspace actorId={ctx.actorId} permissions={{
        read: ctx.canRead,
        writeProject: ctx.permissions.has("character.project.write"),
        proposeRelease: ctx.permissions.has("character.release.propose"),
        publishRelease: ctx.permissions.has("character.release.publish"),
        reviewRelease: ctx.permissions.has("character.release.review"),
        writeVisual: ctx.permissions.has("content.official.write"),
        evaluateRoute: ctx.permissions.has("content.production.write"),
        readAssets: ctx.permissions.has("creative.run.read"),
        createAssets: ctx.permissions.has("creative.run.write"),
        reviewAssets: ctx.permissions.has("creative.run.review"),
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
    if (section.view === "billing") {
      return (
        <BillingWorkspace
          canAdjust={ctx.permissions.has("billing.ledger.adjust")}
          canReconcile={ctx.permissions.has("billing.checkout.reconcile")}
        />
      );
    }
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
    if (section.view === "access") {
      return <AccessWorkspace permissions={{
        changeStatus: ctx.permissions.has("user.status.write"),
        managePermissions: ctx.permissions.has("user.role.write"),
      }} />;
    }
    if (section.view === "moderation") {
      return <ModerationWorkspace canDecide={ctx.permissions.has("safety.review.write")} />;
    }
    if (section.view === "support") {
      return (
        <SupportWorkspace
          canViewPlaintext={ctx.permissions.has("support.plaintext.view")}
          canWrite={ctx.permissions.has("support.request.write")}
        />
      );
    }
    if (section.view === "promo") {
      return <PromoWorkspace canWrite={ctx.permissions.has("growth.promo.write")} />;
    }
    if (section.view === "approvals") {
      return <ApprovalsWorkspace canReview={ctx.permissions.has("admin.approval.review")} />;
    }
    if (section.view === "chat") {
      return <ChatOpsWorkspace canRead={ctx.permissions.has("chat.ops.read")} />;
    }
    if (section.view === "content-merchandising") {
      return <ContentMerchandisingWorkspace canWrite={ctx.permissions.has("content.takedown.write")} />;
    }
    if (section.view === "analytics-overview") {
      return (
        <AnalyticsWorkspace
          canReadCanonical={ctx.canRead}
          canReadLegacy={ctx.permissions.has("analytics.export")}
        />
      );
    }
    if (section.view === "risk-overview") {
      return <RiskWorkspace canRead={ctx.permissions.has("billing.read")} />;
    }
    if (section.view === "provider-overview") {
      return <ProviderOverviewWorkspace canRead={ctx.permissions.has("ops.queue.read")} />;
    }
    return <ReviewQueueView />;
  }
  return null;
}
