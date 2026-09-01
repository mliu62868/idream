"use client";

import Link from "next/link";
import { type AdminPermissionKey } from "@idream/shared/admin/permissions";
import { type KeyboardEvent, type WheelEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Ban,
  ChevronDown,
  ChevronRight,
  Languages,
  LayoutGrid,
  Menu,
  RefreshCcw,
  UserRound,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { focusAdminMainContent } from "./admin-skip-link";
import {
  AdminI18nProvider,
  useAdminI18n,
} from "@/components/admin/i18n";
import {
  canReadWorkspace,
  parseAdminPath,
  defaultWorkModeForRole,
  missingWorkspacePermissions,
  navGroupsForPermissions,
  type AdminPath,
  type NavItem,
} from "@/components/admin/nav-config";
import {
  ADMIN_LOCALE_COOKIE,
  ADMIN_WORK_MODE_COOKIE,
  ADMIN_WORK_MODES,
  writeAdminPreferenceCookie,
  type AdminLocale,
  type AdminShellPreferences,
  type WorkMode,
} from "@/components/admin/shell-preferences";
import {
  adminShellEnvironmentNotice,
  adminShellSignalChips,
  type AdminShellSignals,
} from "@/components/admin/shell-signals";
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
  // SPEC: 语言 / 工作模式由服务端从 cookie 读出后随首帧一起下发，必填。
  // INVARIANT: 外壳不得在挂载后再去别处读这两项——那正是每次导航先闪一次默认值的来源。
  //            运行时只写 cookie，不读。必填是唯一的强制点：漏传就是编译错误。
  preferences: AdminShellPreferences;
  // dev-only：展示退出按钮以便切换内置账号。
  devLogout?: boolean;
};

const WORK_MODE_LABELS: Record<WorkMode, string> = {
  admin: "Admin",
  character_producer: "Character producer",
  creative_operator: "Creative operator",
  platform_ops: "Platform ops",
  support: "Support",
  moderator: "Moderator",
  growth_analyst: "Growth analyst",
};

export function AdminConsoleClient(props: AdminConsoleClientProps) {
  const [locale, setLocale] = useState<AdminLocale>(props.preferences.locale);

  // SPEC: 首帧的 <html lang> 由 app/layout.tsx 直接按同一个 cookie 渲染；这里只负责运营
  //       在页内切换语言之后把它同步过去，不需要重新加载。
  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  }, [locale]);

  const changeLocale = useCallback((next: AdminLocale) => {
    setLocale(next);
    writeAdminPreferenceCookie(ADMIN_LOCALE_COOKIE, next);
  }, []);

  // SPEC: 未知路径由服务端路由 notFound() 拦下（app/admin/_server/render-admin-route.tsx）。
  // INVARIANT: 能渲染到这里的 initialSection 必然可解析；null 分支只为类型收窄，不是兜底 UI。
  const path = parseAdminPath(props.initialSection);

  return (
    <AdminI18nProvider locale={locale}>
      {path ? (
        <AdminConsoleContent {...props} locale={locale} path={path} setLocale={changeLocale} />
      ) : null}
    </AdminI18nProvider>
  );
}

function AdminConsoleContent({
  actor,
  initialAccess,
  initialPermissions,
  path,
  preferences,
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
  const permissions = useMemo(() => new Set(initialPermissions), [initialPermissions]);
  const canAccessActiveSection = canReadWorkspace(activeItem, permissions);
  // 只有 admin 能改工作模式，所以也只有 admin 的 cookie 值算数——被降权的账号不该继续按
  // 上一次的模式排列导航。
  const canChooseWorkMode = actor?.role === "admin";
  const [workMode, setWorkMode] = useState<WorkMode>(
    () => (canChooseWorkMode && preferences.workMode) || defaultWorkModeForRole(actor?.role),
  );
  const navGroups = useMemo(
    () => navGroupsForPermissions(permissions, workMode),
    [permissions, workMode],
  );
  const permittedNavItems = navGroups.flatMap(({ items }) => items);
  // SPEC: 常驻导航只回答两个最高频问题：今天做什么、当前角色怎么样。
  //       其他能力按业务工作区收敛成一个入口，具体页面在页头的区内切换器中选择。
  // INVARIANT: 每个已授权页面至少有一个「工作区入口 → 区内入口」路径；兼容工具也不例外。
  const primaryNavItems = permittedNavItems.filter((item) => item.navigation === "primary");
  const primaryWorkspaceNames = new Set(primaryNavItems.map((item) => item.group));
  const workspaceNavGroups = navGroups.filter(
    ({ group }) => group !== "Today" && !primaryWorkspaceNames.has(group),
  );
  const activeWorkspaceItems = canAccessActiveSection
    ? navGroups.find(({ group }) => group === activeItem.group)?.items ?? []
    : [];
  const activeInWorkspaces = workspaceNavGroups.some(
    ({ group }) => group === activeItem.group,
  );
  // 手动开合只属于当前 section；同一个客户端边界切到另一低频 section 时，按新页面重新推导。
  // 这样既不需要 effect 同步派生状态，也不会让 Jobs 页的折叠选择把 Dead-letter 一并藏住。
  const [workspaceNavState, setWorkspaceNavState] = useState(
    () => ({ sectionId, open: activeInWorkspaces }),
  );
  const workspaceNavOpen = workspaceNavState.sectionId === sectionId
    ? workspaceNavState.open
    : activeInWorkspaces;
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
    const persistentSidebar = window.matchMedia("(min-width: 1200px)");
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

  const changeWorkMode = useCallback((next: WorkMode) => {
    setWorkMode(next);
    writeAdminPreferenceCookie(ADMIN_WORK_MODE_COOKIE, next);
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
    {/* 标签页标题由服务端 generateMetadata 出（读 locale cookie），首帧即终态。
        这里曾经再渲染一个 <title> 覆盖它——那正是标题会先英文后中文闪一下的原因。 */}
    <a
      className="admin-skip-link"
      href="#admin-main-content"
      id="admin-skip-link"
      onClick={focusAdminMainContent}
    >
      {t("Skip to admin content")}
    </a>
    <main className="min-h-screen overflow-x-clip bg-[var(--ad-canvas)] text-[var(--ad-ink)]">
      <div className="flex min-h-screen" id="admin-shell-background">
        <aside
          inert={mobileNavOpen ? true : undefined}
          className="sticky top-0 hidden h-screen w-[248px] shrink-0 overflow-hidden border-r border-[var(--ad-border)] bg-[var(--ad-surface)] min-[1200px]:flex min-[1200px]:flex-col"
          onWheel={handleSidebarWheel}
        >
          <div className="flex h-14 shrink-0 items-center border-b border-[var(--ad-border)] px-5">
            <div>
              <p className="text-sm font-semibold">iDream Admin</p>
              <p className="text-[11px] text-[var(--ad-text-muted)]">{t(actor.role)}</p>
            </div>
          </div>
          <nav ref={sidebarNavRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
            <div className="space-y-1 pb-3">
              {primaryNavItems.map((item) => (
                <NavLink
                  active={item.group === activeItem.group}
                  item={item}
                  key={item.id}
                />
              ))}
            </div>
            {workspaceNavGroups.length > 0 ? (
              <div className="border-t border-[var(--ad-border)] pt-3">
                <button
                  aria-expanded={workspaceNavOpen}
                  className={cn(
                    "mb-1 flex h-10 w-full items-center gap-3 rounded-md px-3 text-[13px] font-medium text-[var(--ad-text-muted)] transition-colors hover:bg-black/[0.04] hover:text-[var(--ad-ink)]",
                    activeInWorkspaces && "bg-black/[0.05] text-[var(--ad-ink)]",
                  )}
                  onClick={() => setWorkspaceNavState({ sectionId, open: !workspaceNavOpen })}
                  type="button"
                >
                  <LayoutGrid aria-hidden="true" className="h-4 w-4" />
                  <span>{t("Workspaces")}</span>
                  <ChevronRight
                    aria-hidden="true"
                    className={cn("ml-auto h-4 w-4 transition-transform", workspaceNavOpen && "rotate-90")}
                  />
                </button>
                {workspaceNavOpen ? (
                  <div className="mt-2 border-l border-[var(--ad-border)] pl-2">
                    {workspaceNavGroups.map(({ group, items }) => (
                      <WorkspaceLink
                        active={group === activeItem.group}
                        entry={workspaceEntry(items)}
                        group={group}
                        key={group}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </nav>
        </aside>

        {mobileNavOpen ? (
          <div className="fixed inset-0 z-50 min-[1200px]:hidden">
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
                <section className="border-b border-[var(--ad-border)] pb-3">
                  {primaryNavItems.map((item) => (
                    <NavLink
                      active={item.group === activeItem.group}
                      item={item}
                      key={item.id}
                      onNavigate={() => setMobileNavOpen(false)}
                    />
                  ))}
                </section>
                {workspaceNavGroups.length > 0 ? (
                  <section className="pt-3">
                    <h2 className="px-3 pb-2 text-[10px] font-semibold uppercase text-[var(--ad-text-muted)]">
                      {t("Workspaces")}
                    </h2>
                    {workspaceNavGroups.map(({ group, items }) => (
                      <WorkspaceLink
                        active={group === activeItem.group}
                        entry={workspaceEntry(items)}
                        group={group}
                        key={group}
                        onNavigate={() => setMobileNavOpen(false)}
                      />
                    ))}
                  </section>
                ) : null}
              </nav>
            </aside>
          </div>
        ) : null}

        <section
          className="min-w-0 flex-1"
          id="admin-main-content"
          inert={mobileNavOpen ? true : undefined}
          tabIndex={-1}
        >
          <header className="sticky top-0 z-20 border-b border-[var(--ad-border)] bg-[rgba(247,246,243,0.92)] backdrop-blur">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 md:min-h-14 md:px-6">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <button
                  aria-controls="admin-mobile-navigation"
                  aria-expanded={mobileNavOpen}
                  aria-label={t("Open navigation")}
                  className="grid min-h-11 min-w-11 shrink-0 place-items-center rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] min-[1200px]:hidden"
                  onClick={() => setMobileNavOpen(true)}
                  ref={mobileNavTriggerRef}
                  type="button"
                >
                  <Menu className="h-5 w-5" />
                </button>
                <ShellTitle
                  activeItem={activeItem}
                  chrome={activeItem.chrome}
                  environmentNotice={adminShellEnvironmentNotice(shellSignals)}
                  group={activeItem.group}
                  label={activeItem.label}
                  workspaceItems={activeWorkspaceItems}
                />
              </div>
              <div className="flex w-full items-center gap-2 md:w-auto">
                <div className="min-w-0 flex-1 md:flex-none"><GlobalAdminSearch permissions={permissions} /></div>
                {/* SPEC: 刷新只广播事件；各工作台自取数、自报加载态。 */}
                <button
                  aria-label={t("Refresh")}
                  className="inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-[var(--ad-border)] px-3 text-sm text-[var(--ad-text)] hover:bg-black/[0.04]"
                  onClick={() => window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT))}
                  type="button"
                >
                  <RefreshCcw className="h-4 w-4" />
                  <span className="hidden sm:inline">{t("Refresh")}</span>
                </button>
                <AccountMenu
                  actor={actor}
                  canChooseWorkMode={canChooseWorkMode}
                  devLogout={devLogout}
                  locale={locale}
                  setLocale={setLocale}
                  setWorkMode={changeWorkMode}
                  signals={shellSignals}
                  workMode={workMode}
                />
              </div>
            </div>
          </header>

          <div className="p-4 md:p-6">
            {!canAccessActiveSection ? (
              <PermissionDenied
                canReachTeamAccess={permissions.has("user.read")}
                missing={missingWorkspacePermissions(activeItem, permissions)}
              />
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

// SPEC: 拒绝页要能让运营走下一步：缺哪几个键、在哪儿授予、授予者需要什么。
// INTENT: 原来的文案（"你的有效权限键不包含此能力"）是一条死路——运营在这一页唯一能做的
//         就是关掉它。这里只写能从代码里如实推出来的三件事：missingWorkspacePermissions()
//         算出的键、授予面是「团队访问」（AccessWorkspace）、授予者需要 user.role.write
//         （AccessWorkspace 自己就是这么判 managePermissions 的）。为什么被拒、该找哪位同事，
//         前端推不出来，就不写。
// INVARIANT: 「团队访问」的链接只在运营真读得进去时才出——否则只是把他们推向第二堵墙。
function PermissionDenied({
  canReachTeamAccess,
  missing,
}: {
  canReachTeamAccess: boolean;
  missing: readonly AdminPermissionKey[];
}) {
  const { t } = useAdminI18n();

  return (
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
        {t("This workspace requires permission keys your account does not have.")}
      </p>
      <p className="mt-4 text-[11px] font-semibold uppercase text-[var(--ad-text-muted)]">
        {t("Missing permission keys")}
      </p>
      <ul className="mt-1.5 flex flex-wrap gap-2" data-testid="admin-missing-permission-keys">
        {missing.map((permission) => (
          <li
            className="rounded-md bg-[var(--ad-surface-subtle)] px-2 py-1 font-mono text-xs text-[var(--ad-ink)]"
            key={permission}
          >
            {permission}
          </li>
        ))}
      </ul>
      <p className="mt-4 text-sm text-[var(--ad-text-muted)]">
        {t("These keys are granted in Team Access by an operator holding {key}.", { key: "user.role.write" })}{" "}
        {t("Navigation updates after the grant and a refresh.")}
      </p>
      {canReachTeamAccess ? (
        <Link
          className="mt-4 inline-flex min-h-11 items-center rounded-md border border-[var(--ad-border)] px-4 text-sm font-semibold text-[var(--ad-ink)] hover:bg-black/[0.04] focus-visible:border-[var(--ad-ink)] focus-visible:ring-2 focus-visible:ring-[var(--ad-ink)]/10"
          href="/admin/system/access"
        >
          {t("Team Access")}
        </Link>
      ) : null}
    </section>
  );
}

// SPEC: 顶栏的身份区——面包屑（分组 › 页面）加页面标题。
// INTENT: 之前这里是「页名 + `seed-admin-user · 角色制作`」，运营完全不知道自己在导航树的
//         哪一层；而账号 ID 与工作模式属于"我是谁"，已经收进右上角的账号菜单。
//         chrome="compact" 时页名本身就是 h1（角色工作台自带 96px 头像加角色名的大标题，
//         外壳再叠一个 h1 就是两层标题），其余页面照常出一行独立标题。
function ShellTitle({
  activeItem,
  chrome,
  environmentNotice,
  group,
  label,
  workspaceItems,
}: {
  activeItem: NavItem;
  chrome: NavItem["chrome"];
  environmentNotice: string | null;
  group: string;
  label: string;
  workspaceItems: readonly NavItem[];
}) {
  const { t } = useAdminI18n();
  const compact = chrome === "compact";
  // Today 的分组名与页名是同一个词，重复一遍只是噪音。
  const showGroup = group !== label;

  return (
    <div className="min-w-0">
      <nav aria-label={t("Breadcrumb")}>
        <ol className="flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--ad-text-muted)]">
          {showGroup ? (
            <>
              <li className="shrink-0">
                <WorkspaceMenu activeItem={activeItem} group={group} items={workspaceItems} />
              </li>
              <li aria-hidden="true" className="shrink-0">›</li>
            </>
          ) : null}
          <li aria-current="page" className="min-w-0">
            {compact ? (
              <h1 className="truncate text-sm font-semibold text-[var(--ad-ink)]">{t(label)}</h1>
            ) : (
              <span className="truncate">{t(label)}</span>
            )}
          </li>
          {environmentNotice ? (
            <li className="shrink-0">
              <span
                className="rounded-full bg-[var(--ad-yellow-bg)] px-2 py-0.5 text-[10px] font-semibold uppercase text-[var(--ad-yellow-text)]"
                data-testid="admin-environment-notice"
              >
                {t(environmentNotice)}
              </span>
            </li>
          ) : null}
        </ol>
      </nav>
      {compact ? null : (
        <h1 className="truncate text-base font-semibold md:text-lg">{t(label)}</h1>
      )}
    </div>
  );
}

// SPEC: 全局目录只选择工作区；区内切换器先给常规任务，再渐进披露低频工具。
// INTENT: 低频子视图不能和日常任务争夺同等注意力，也不能靠搜索或记 URL 才能到达。
function WorkspaceMenu({
  activeItem,
  group,
  items,
}: {
  activeItem: NavItem;
  group: string;
  items: readonly NavItem[];
}) {
  const { t } = useAdminI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const mainItems = items.filter((item) => item.navigation !== "tool");
  const toolItems = items.filter((item) => item.navigation === "tool");
  const activeInTools = toolItems.some((item) => item.id === activeItem.id);
  // 手动开合只属于当前 section；同一个客户端边界切到低频工具时必须自动展开。
  const [toolNavState, setToolNavState] = useState(
    () => ({ sectionId: activeItem.id, open: activeInTools }),
  );
  const toolNavOpen = toolNavState.sectionId === activeItem.id
    ? toolNavState.open
    : activeInTools;

  useEffect(() => {
    if (!open) return;
    function closeOnOutsidePointer(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  if (items.length <= 1) return <span>{t(group)}</span>;

  return (
    <div className="relative" ref={rootRef}>
      <button
        aria-controls="admin-workspace-section-menu"
        aria-expanded={open}
        className="inline-flex min-h-8 items-center gap-1 rounded px-1 font-medium text-[var(--ad-text-muted)] hover:bg-black/[0.04] hover:text-[var(--ad-ink)] focus-visible:text-[var(--ad-ink)] focus-visible:ring-2 focus-visible:ring-[var(--ad-ink)]/10"
        onClick={() => setOpen((previous) => !previous)}
        ref={triggerRef}
        type="button"
      >
        {t(group)}
        <ChevronDown
          aria-hidden="true"
          className={cn("h-3 w-3 transition-transform", open && "rotate-180")}
        />
      </button>
      {open ? (
        <nav
          aria-label={t(group)}
          className="absolute left-0 z-50 mt-1 max-h-[min(80vh,40rem)] w-[min(86vw,18rem)] overflow-y-auto rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-1.5 shadow-xl"
          id="admin-workspace-section-menu"
        >
          <WorkspaceMenuItems
            activeItem={activeItem}
            items={mainItems.length > 0 ? mainItems : toolItems}
            onNavigate={() => setOpen(false)}
          />
          {mainItems.length > 0 && toolItems.length > 0 ? (
            <div className="mt-1 border-t border-[var(--ad-border)] pt-1">
              <button
                aria-controls="admin-workspace-tools-menu"
                aria-expanded={toolNavOpen}
                className="flex min-h-10 w-full items-center gap-2 rounded-md px-3 text-left text-[12px] font-medium text-[var(--ad-text-muted)] hover:bg-black/[0.04] hover:text-[var(--ad-ink)] focus-visible:ring-2 focus-visible:ring-[var(--ad-ink)]/10"
                onClick={() => setToolNavState({
                  sectionId: activeItem.id,
                  open: !toolNavOpen,
                })}
                type="button"
              >
                <span>{t("Tools & diagnostics")}</span>
                <ChevronRight
                  aria-hidden="true"
                  className={cn("ml-auto h-3.5 w-3.5 transition-transform", toolNavOpen && "rotate-90")}
                />
              </button>
              {toolNavOpen ? (
                <div className="border-l border-[var(--ad-border)] pl-1" id="admin-workspace-tools-menu">
                  <WorkspaceMenuItems
                    activeItem={activeItem}
                    items={toolItems}
                    onNavigate={() => setOpen(false)}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}

function WorkspaceMenuItems({
  activeItem,
  items,
  onNavigate,
}: {
  activeItem: NavItem;
  items: readonly NavItem[];
  onNavigate: () => void;
}) {
  const { t } = useAdminI18n();

  return items.map((item) => {
    const Icon = item.icon;
    const active = item.id === activeItem.id;
    return (
      <Link
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex min-h-10 items-center gap-3 rounded-md px-3 text-[13px] text-[var(--ad-text-muted)] hover:bg-black/[0.04] hover:text-[var(--ad-ink)]",
          active && "bg-black/[0.05] font-semibold text-[var(--ad-ink)]",
        )}
        href={item.href}
        key={item.id}
        onClick={onNavigate}
      >
        <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
        <span>{t(item.label)}</span>
      </Link>
    );
  });
}

// SPEC: 右上角账号菜单——身份、语言、工作模式、数据来源、退出。
// INTENT: 这五样过去平铺在顶栏，其中来源芯片还独占一整行（ShellSignalBar）。它们几乎恒定，
//         却让每一页都为之付出一整行垂直空间。收进菜单：常驻的只剩面包屑、搜索、刷新。
//         来源信息本身没有删——它是有意的产品决策，只是不再占正文流；唯一还常驻的是
//         非生产环境提示（见 adminShellEnvironmentNotice）。
function AccountMenu({
  actor,
  canChooseWorkMode,
  devLogout,
  locale,
  setLocale,
  setWorkMode,
  signals,
  workMode,
}: {
  actor: Actor;
  canChooseWorkMode: boolean;
  devLogout: boolean;
  locale: AdminLocale;
  setLocale: (locale: AdminLocale) => void;
  setWorkMode: (mode: WorkMode) => void;
  signals: AdminShellSignals;
  workMode: WorkMode;
}) {
  const { t } = useAdminI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function closeOnOutsidePointer(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="relative shrink-0" ref={rootRef}>
      <button
        aria-controls="admin-account-menu"
        aria-expanded={open}
        aria-label={t("Account and shell settings")}
        className="inline-flex h-9 items-center gap-2 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-2.5 text-sm text-[var(--ad-text)] hover:bg-black/[0.04] focus-visible:border-[var(--ad-ink)] focus-visible:ring-2 focus-visible:ring-[var(--ad-ink)]/10"
        onClick={() => setOpen((previous) => !previous)}
        ref={triggerRef}
        type="button"
      >
        <UserRound className="h-4 w-4 text-[var(--ad-text-muted)]" />
        <span className="hidden max-w-[10rem] truncate lg:inline">{actor.id}</span>
        <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div
          aria-label={t("Account and shell settings")}
          className="absolute right-0 z-50 mt-2 w-[min(92vw,20rem)] rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3 shadow-xl"
          id="admin-account-menu"
          role="group"
        >
          <p className="truncate text-sm font-semibold">{actor.id}</p>
          <p className="text-[11px] text-[var(--ad-text-muted)]">{t(actor.role)}</p>

          <label className="mt-3 grid gap-1 text-[11px] font-semibold text-[var(--ad-text-muted)]">
            {t("Language")}
            <span className="inline-flex h-9 items-center gap-2 rounded-md border border-[var(--ad-border)] px-3 text-sm font-normal text-[var(--ad-text)] focus-within:border-[var(--ad-ink)] focus-within:ring-2 focus-within:ring-[var(--ad-ink)]/10">
              <Languages className="h-4 w-4 text-[var(--ad-text-muted)]" />
              <select
                aria-label={t("Language")}
                className="h-full w-full bg-transparent text-sm outline-none"
                name="admin-language"
                onChange={(event) => setLocale(event.target.value as AdminLocale)}
                value={locale}
              >
                <option value="en">English</option>
                <option value="zh">中文</option>
              </select>
            </span>
          </label>

          {canChooseWorkMode ? (
            <label className="mt-3 grid gap-1 text-[11px] font-semibold text-[var(--ad-text-muted)]">
              {t("Work mode")}
              <select
                aria-label={t("Work mode")}
                className="h-9 rounded-md border border-[var(--ad-border)] bg-transparent px-3 text-sm font-normal text-[var(--ad-text)] outline-none focus-visible:border-[var(--ad-ink)] focus-visible:ring-2 focus-visible:ring-[var(--ad-ink)]/10"
                onChange={(event) => setWorkMode(event.target.value as WorkMode)}
                value={workMode}
              >
                {ADMIN_WORK_MODES.map((mode) => (
                  <option key={mode} value={mode}>{t(WORK_MODE_LABELS[mode])}</option>
                ))}
              </select>
            </label>
          ) : null}

          <dl
            aria-label={t("Data provenance")}
            className="mt-3 grid gap-1 border-t border-[var(--ad-border)] pt-3 text-[11px]"
            data-testid="admin-shell-signals"
          >
            {adminShellSignalChips(signals).map((signal) => (
              <div className="flex items-baseline justify-between gap-3" data-signal={signal.key} key={signal.key}>
                <dt className="shrink-0 text-[var(--ad-text-muted)]">{t(signal.label)}</dt>
                <dd className="truncate text-right text-[var(--ad-ink)]">{t(signal.value)}</dd>
              </div>
            ))}
          </dl>

          {devLogout ? (
            <button
              className="mt-3 inline-flex h-9 w-full items-center justify-center rounded-md border border-[var(--ad-border)] text-sm text-[var(--ad-text-muted)] hover:bg-black/[0.04]"
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
      ) : null}
    </div>
  );
}

// SPEC: 工作区入口落到第一个常规任务；只有账号没有任何常规任务权限时，才回退到低频工具。
function workspaceEntry(items: readonly NavItem[]) {
  return items.find((item) => item.navigation !== "tool") ?? items[0]!;
}

function WorkspaceLink({
  active,
  entry,
  group,
  onNavigate,
}: {
  active: boolean;
  entry: NavItem;
  group: string;
  onNavigate?: () => void;
}) {
  const { t } = useAdminI18n();
  const Icon = entry.icon;

  return (
    <Link
      className={cn(
        "mb-1 flex h-10 items-center gap-3 rounded-md px-3 text-[13px] font-medium text-[var(--ad-text-muted)] transition-colors hover:bg-black/[0.04] hover:text-[var(--ad-ink)]",
        active && "bg-black/[0.05] text-[var(--ad-ink)]",
      )}
      href={entry.href}
      onClick={onNavigate}
    >
      <Icon aria-hidden="true" className="h-4 w-4" />
      <span>{t(group)}</span>
      {active ? <ChevronRight aria-hidden="true" className="ml-auto h-4 w-4" /> : null}
    </Link>
  );
}

// SPEC: shared primary sidebar link markup for desktop and mobile.
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
      <Icon aria-hidden="true" className="h-4 w-4" />
      <span>{t(item.label)}</span>
      {active ? <ChevronRight className="ml-auto h-4 w-4" /> : null}
    </Link>
  );
}
