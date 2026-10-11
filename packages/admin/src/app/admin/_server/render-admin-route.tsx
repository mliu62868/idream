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
// INTENT: 语言与工作模式都已随 cookie 首帧到位，只有标签页标题还先出英文、
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

// Resolve titles from the same route/view authority used by the renderer. Explicit
// pages and the catch-all must agree, including aliases caught by a dynamic segment.
export function adminRouteLabel(
  section: readonly string[],
  query: Readonly<Record<string, string | string[] | undefined>> = {},
) {
  const match = parseAdminPath(withSearchParams(section.join("/"), query));
  if (!match) return "Admin";
  if (match.view.kind === "new" && match.item.id === "content/official") return "New Character";
  if (match.view.kind === "detail") {
    const details: Partial<Record<typeof match.item.id, string>> = {
      "content/official": "Character Detail",
      "content/production": "Creative Run Detail",
      "cases": "Case Detail",
      "ops/incidents": "Incident Detail",
    };
    return details[match.item.id] ?? match.item.label;
  }
  return match.item.label;
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
  // SPEC: 语言、工作模式在服务端就读出来，随首帧下发。
  // INTENT: 它们过去存 localStorage、挂载后才读，于是首帧必然是 English + 默认工作模式，
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
        locale={preferences.locale}
      />
    );
  }

  return (
    <AdminConsoleClientOnly
      actor={bootstrap.actor}
      canCreateCharacters={bootstrap.canCreateCharacters}
      initialAccess={Boolean(bootstrap.actor)}
      initialPermissions={bootstrap.permissions}
      initialSection={initialSection}
      preferences={preferences}
      shellSignals={bootstrap.shellSignals}
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
