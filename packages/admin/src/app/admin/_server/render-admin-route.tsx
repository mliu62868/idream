import type { Metadata } from "next";
import { adminBootstrapSchema, type AdminBootstrap } from "@idream/shared/admin";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import { AdminDevLogin } from "@/components/admin/AdminDevLogin";
import { canReadAnyWorkspace, parseAdminPath } from "@/components/admin/nav-config";
import { AdminAuthorityUnavailablePage } from "@/components/admin/AdminMessagePage";
import { readAdminShellPreferences } from "@/components/admin/shell-preferences";
// 走纯查表层：i18n.tsx 是 "use client"，服务端调它会报
// 「Attempted to call translateAdmin() from the server」。
import { translateAdmin } from "@/components/admin/i18n-dictionary";
import { proxyToMain } from "@/server/main-proxy";
import { AdminConsoleClientOnly } from "../AdminConsoleClientOnly";

export type AdminSearchParams = Promise<Record<string, string | string[] | undefined>>;

// SPEC: 标签页的名字也随运营选的语言，且首帧就对。
// INTENT: 语言、侧栏、工作模式都已随 cookie 首帧到位，只有标签页标题还先出英文、
//         hydration 后才变中文——运营同时开七八个后台标签页时，那一栏是他找回某一页的
//         唯一线索，闪一下就等于闪在最需要认字的地方。locale 就在 cookie 里，服务端读得到。
// INVARIANT: 品牌名不翻译；翻的只有导航 label 那一半。
export async function adminRouteMetadata(label: string): Promise<Metadata> {
  const cookieStore = await cookies();
  const { locale } = readAdminShellPreferences((name) => cookieStore.get(name)?.value);
  return {
    title: `${translateAdmin(locale, label)} | iDream Admin`,
    robots: { index: false, follow: false },
  };
}

// SPEC: 浏览器标签页用的名字，就是这条路径在侧栏里的名字。
// INTENT: 这里过去把 URL 段首字母大写拼起来，于是标签页写着「Ops · Providers」「System · Access」，
//         侧栏却写着「Providers」「Team Access」。运营同时开七八个后台标签页时，标签页上的名字
//         才是他找回某一页的唯一线索——它必须和点进去时看到的名字是同一个。
// INVARIANT: 名字只来自 nav-config；认不出的路径由 renderAdminRoute 走 notFound()。
// INVARIANT: query 必须一起传 —— 七个目的地靠 `?view=` 区分（ops/recipes?view=workflows
//            是「Workflow Diagnostics」，不是「Prompt Recipes」），只看路径会认成同一页。
export function adminRouteLabel(
  section: readonly string[],
  query: Readonly<Record<string, string | string[] | undefined>> = {},
) {
  return parseAdminPath(withSearchParams(section.join("/"), query))?.item.label ?? "Admin";
}

export async function renderAdminRoute(
  section: readonly string[],
  searchParams: AdminSearchParams,
) {
  const query = await searchParams;
  const initialSection = withSearchParams(section.join("/"), query);
  // SPEC: 认不出的后台路径回 404，走 app/admin/not-found.tsx。
  // INTENT: 在取 bootstrap 之前判——拼错的 URL 不该先打一次权威服务再显示成 Today。
  if (!parseAdminPath(initialSection)) notFound();

  const [headerList, cookieStore] = await Promise.all([headers(), cookies()]);
  // SPEC: 语言、工作模式、展开的分组在服务端就读出来，随首帧下发。
  // INTENT: 它们过去存 localStorage、挂载后才读，于是首帧必然是 English + 全折叠侧栏，
  //         几百毫秒后整页跳变一次。cookie 让首帧就是最终形态。
  const preferences = readAdminShellPreferences((name) => cookieStore.get(name)?.value);

  const bootstrap = await loadAdminBootstrap(headerList);
  if (!bootstrap) return <AdminAuthorityUnavailablePage locale={preferences.locale} />;

  const canReadAdmin = Boolean(bootstrap.actor)
    && canReadAnyWorkspace(new Set(bootstrap.permissions));

  if (!canReadAdmin && bootstrap.devLogin.enabled) {
    return (
      <AdminDevLogin
        accounts={bootstrap.devLogin.accounts}
        actor={bootstrap.actor}
      />
    );
  }

  return (
    <AdminConsoleClientOnly
      actor={bootstrap.actor}
      initialAccess={Boolean(bootstrap.actor)}
      initialPermissions={bootstrap.permissions}
      initialSection={initialSection}
      preferences={preferences}
      shellSignals={bootstrap.shellSignals}
      devLogout={bootstrap.devLogin.enabled}
    />
  );
}

// not-found.tsx 也要用它拿权限（只为了不建议运营打不开的页面），所以导出。
export async function loadAdminBootstrap(requestHeaders: Headers): Promise<AdminBootstrap | null> {
  const response = await proxyToMain(
    new Request("http://admin.local/api/v2/admin/bootstrap", { headers: requestHeaders }),
    "/api/v2/admin/bootstrap",
  );
  if (!response.ok) return null;
  const envelope = await response.json() as { data?: { bootstrap?: unknown } };
  const parsed = adminBootstrapSchema.safeParse(envelope.data?.bootstrap);
  return parsed.success ? parsed.data : null;
}

function withSearchParams(
  path: string,
  values: Readonly<Record<string, string | string[] | undefined>>,
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) value.forEach((entry) => query.append(key, entry));
    else if (value !== undefined) query.set(key, value);
  }
  const encoded = query.toString();
  return `${path}${encoded ? `?${encoded}` : ""}`;
}
