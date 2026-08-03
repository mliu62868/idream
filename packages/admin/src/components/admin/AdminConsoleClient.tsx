"use client";

import Link from "next/link";
import { type AdminPermissionKey } from "@idream/shared/admin/permissions";
import { type KeyboardEvent, type WheelEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Ban,
  ChevronRight,
  Languages,
  Menu,
  RefreshCcw,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  AdminI18nProvider,
  getStoredAdminLocale,
  storeAdminLocale,
  type AdminLocale,
  useAdminI18n,
} from "@/components/admin/i18n";
import {
  canReadWorkspace,
  parseAdminPath,
  defaultWorkModeForRole,
  navGroupsForPermissions,
  type AdminPath,
  type NavItem,
  type WorkMode,
} from "@/components/admin/nav-config";
import type { AdminShellSignals } from "@/components/admin/shell-signals";
import { GlobalAdminSearch } from "@/features/search/GlobalAdminSearch";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";

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

  // SPEC: 未知路径由服务端路由 notFound() 拦下（app/admin/_server/render-admin-route.tsx）。
  // INVARIANT: 能渲染到这里的 initialSection 必然可解析；null 分支只为类型收窄，不是兜底 UI。
  const path = parseAdminPath(props.initialSection);

  return (
    <AdminI18nProvider locale={locale}>
      {path ? (
        <AdminConsoleContent {...props} locale={locale} path={path} setLocale={setLocale} />
      ) : null}
    </AdminI18nProvider>
  );
}

function AdminConsoleContent({
  actor,
  initialAccess,
  initialPermissions,
  path,
  shellSignals,
  devLogout = false,
  locale,
  setLocale,
}: AdminConsoleClientProps & {
  locale: AdminLocale;
  path: AdminPath;
  setLocale: (locale: AdminLocale) => void;
}) {
  const { t } = useAdminI18n();
  const sidebarNavRef = useRef<HTMLElement | null>(null);
  const mobileNavRef = useRef<HTMLElement | null>(null);
  const mobileNavTriggerRef = useRef<HTMLButtonElement | null>(null);
  const activeItem = path.item;
  const sectionId = activeItem.id;
  const isCharacterWorkspace = sectionId === "content/official";
  const permissions = useMemo(() => new Set(initialPermissions), [initialPermissions]);
  const canAccessActiveSection = canReadWorkspace(activeItem, permissions);
  const [workMode, setWorkMode] = useState<WorkMode>(() => defaultWorkModeForRole(actor?.role));
  const navGroups = useMemo(
    () => navGroupsForPermissions(permissions, workMode),
    [permissions, workMode],
  );
  // SPEC: 角色工作台不裁剪导航。
  // INTENT: 曾把侧边栏裁到 Today + 角色/角色审核队列，但工作台里就有"检查生成路由"这类
  // 需要跳生成任务/供应商诊断的动作，裁完就没有出口，只能绕回 Today。非当前组本来就是
  // 折叠态（渐进披露），保留它们不增加视觉噪音，却能一步跳出去。
  const visibleNavGroups = navGroups;
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

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
            {visibleNavGroups.map(({ group, items }, groupIndex) => {
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
                {visibleNavGroups.map(({ group, items }) => (
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
                  {isCharacterWorkspace ? null : (
                    <p className="truncate text-[11px] text-[var(--ad-text-muted)]">{actor.id} · {t(workModeLabel(workMode))}</p>
                  )}
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-[1fr_auto] lg:ml-auto lg:flex lg:items-center">
                {isCharacterWorkspace ? null : <GlobalAdminSearch />}
                <div className="flex flex-wrap items-center gap-2">
                  {actor.role === "admin" && !isCharacterWorkspace ? (
                    <label className="inline-flex h-9 items-center gap-2 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm text-[var(--ad-text)]">
                      <span className="sr-only">{t("Work mode")}</span>
                      <select
                        aria-label={t("Work mode")}
                        className="h-full bg-transparent text-sm outline-none"
                        onChange={(event) => {
                          const nextMode = event.target.value as WorkMode;
                          setWorkMode(nextMode);
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
                  {/* SPEC: 刷新只广播事件；各工作台自取数、自报加载态。 */}
                  <button
                    className="inline-flex h-9 items-center gap-2 rounded-md border border-[var(--ad-border)] px-3 text-sm text-[var(--ad-text)] hover:bg-black/[0.04]"
                    onClick={() => window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT))}
                    type="button"
                  >
                    <RefreshCcw className="h-4 w-4" />
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
            {isCharacterWorkspace ? null : <ShellSignalBar signals={shellSignals} />}
          </header>

          <div className="p-4 md:p-6">
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
            ) : (
              activeItem.render({
                actorId: actor.id,
                canRead: canAccessActiveSection,
                permissions,
                view: path.view,
                workMode,
              })
            )}
          </div>
        </section>
      </div>

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

