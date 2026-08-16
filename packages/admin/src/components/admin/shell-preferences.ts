// SPEC: 后台外壳的三项运营偏好——界面语言、工作模式、侧栏展开的分组——的取值域与 cookie 编解码。
// INTENT: 这三项过去存 localStorage，只有挂载之后才读得到；于是服务端和首帧客户端必然渲染成
//         English + 全部分组折叠，几百毫秒后整页跳成中文 + 展开态，每次导航闪一次，侧栏高度
//         从 ~340px 蹦到 ~800px。cookie 随请求一起到达服务端，首帧即最终形态。
// INVARIANT: 本文件不得 import 任何 "use client" 模块 —— 服务端组件（app/layout.tsx、
//            render-admin-route.tsx）要在渲染前直接调用它，而从客户端模块导入的函数在服务端
//            只是一个引用桩，一调就抛。AdminLocale / WorkMode 因此以这里为准，i18n.tsx 与
//            nav-config.tsx 再把类型转出去给各自的既有引用方。

export type AdminLocale = "en" | "zh";

export const ADMIN_WORK_MODES = [
  "admin",
  "character_producer",
  "creative_operator",
  "platform_ops",
  "support",
  "moderator",
  "growth_analyst",
] as const;

export type WorkMode = (typeof ADMIN_WORK_MODES)[number];

export const ADMIN_LOCALE_COOKIE = "idream.admin.locale";
export const ADMIN_WORK_MODE_COOKIE = "idream.admin.workMode";
export const ADMIN_NAV_GROUPS_COOKIE = "idream.admin.openNavGroups";

export type AdminShellPreferences = {
  locale: AdminLocale;
  // null = 运营从没选过工作模式，由 defaultWorkModeForRole() 按角色推导。
  workMode: WorkMode | null;
  // null = 运营从没折叠或展开过分组，由 defaultOpenNavGroups() 给冷启动集合；
  //        空数组是"我把它们全折上了"，与 null 是两件事。
  openNavGroups: readonly string[] | null;
};

export const DEFAULT_ADMIN_SHELL_PREFERENCES: AdminShellPreferences = {
  locale: "en",
  workMode: null,
  openNavGroups: null,
};

export function isAdminLocale(value: string | null | undefined): value is AdminLocale {
  return value === "en" || value === "zh";
}

export function isWorkMode(value: string | null | undefined): value is WorkMode {
  return ADMIN_WORK_MODES.some((mode) => mode === value);
}

/** 读一个 cookie 的原始值；服务端传 `(name) => cookieStore.get(name)?.value`。 */
export type AdminCookieReader = (name: string) => string | undefined;

export function readAdminShellPreferences(read: AdminCookieReader): AdminShellPreferences {
  const locale = read(ADMIN_LOCALE_COOKIE);
  const workMode = read(ADMIN_WORK_MODE_COOKIE);
  return {
    locale: isAdminLocale(locale) ? locale : DEFAULT_ADMIN_SHELL_PREFERENCES.locale,
    workMode: isWorkMode(workMode) ? workMode : null,
    openNavGroups: parseOpenNavGroups(read(ADMIN_NAV_GROUPS_COOKIE)),
  };
}

// SPEC: 认不出的 cookie 一律当作"没设过"，而不是当作"全折叠"。
// INTENT: 两者的默认值不同——没设过要展开冷启动集合，全折叠要如实全折。解析失败时猜后者，
//         会把一个坏 cookie 变成"侧栏只剩一条"的旧毛病。
function parseOpenNavGroups(raw: string | undefined): readonly string[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(raw));
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return null;
  }
}

export function serializeOpenNavGroups(groups: Iterable<string>) {
  return JSON.stringify([...groups]);
}

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

// SPEC: 客户端写偏好 cookie；服务端只读。
// INTENT: 不带 Secure —— 本地 dev 走 http，而这三项是纯展示偏好，不承载任何授权信息。
//         权限永远由服务端 bootstrap 决定，伪造 cookie 最多只能给自己换个语言。
export function writeAdminPreferenceCookie(name: string, value: string) {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
}
