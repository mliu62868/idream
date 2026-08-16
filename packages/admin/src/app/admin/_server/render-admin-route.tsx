import type { Metadata } from "next";
import { adminBootstrapSchema, type AdminBootstrap } from "@idream/shared/admin";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import { AdminDevLogin } from "@/components/admin/AdminDevLogin";
import { adminZhShell } from "@/components/admin/i18n-zh-shell";
import { canReadAnyWorkspace, parseAdminPath } from "@/components/admin/nav-config";
import {
  readAdminShellPreferences,
  type AdminLocale,
} from "@/components/admin/shell-preferences";
import { proxyToMain } from "@/server/main-proxy";
import { AdminConsoleClientOnly } from "../AdminConsoleClientOnly";

export type AdminSearchParams = Promise<Record<string, string | string[] | undefined>>;

export function adminRouteMetadata(label: string): Metadata {
  return {
    title: `${label} | iDream Admin`,
    robots: { index: false, follow: false },
  };
}

// SPEC: 浏览器标签页用的名字，就是这条路径在侧栏里的名字。
// INTENT: 这里过去把 URL 段首字母大写拼起来，于是标签页写着「Ops · Providers」「System · Access」，
//         侧栏却写着「Providers」「Team Access」。运营同时开七八个后台标签页时，标签页上的名字
//         才是他找回某一页的唯一线索——它必须和点进去时看到的名字是同一个。
// INVARIANT: 名字只来自 nav-config；认不出的路径在 src/proxy.ts 就被拦成 404，走不到这里。
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
  // SPEC: 认不出的后台路径不渲染工作台。
  // INTENT: 状态码由 src/proxy.ts 定 —— 请求走到这里时 app/admin/loading.tsx 的 Suspense
  //         fallback 已经冲出去了，notFound() 只换得了 body。这一句留着是因为它守的是另一件事：
  //         下面的代码可以无条件相信 parseAdminPath 有值，拼错的 URL 不会先打一次权威服务
  //         再显示成 Today。
  if (!parseAdminPath(initialSection)) notFound();

  const [headerList, cookieStore] = await Promise.all([headers(), cookies()]);
  // SPEC: 语言、工作模式、展开的分组在服务端就读出来，随首帧下发。
  // INTENT: 它们过去存 localStorage、挂载后才读，于是首帧必然是 English + 全折叠侧栏，
  //         几百毫秒后整页跳变一次。cookie 让首帧就是最终形态。
  const preferences = readAdminShellPreferences((name) => cookieStore.get(name)?.value);

  const bootstrap = await loadBootstrap(headerList);
  if (!bootstrap) return <AdminAuthorityUnavailable locale={preferences.locale} />;

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

async function loadBootstrap(requestHeaders: Headers): Promise<AdminBootstrap | null> {
  const response = await proxyToMain(
    new Request("http://admin.local/api/v2/admin/bootstrap", { headers: requestHeaders }),
    "/api/v2/admin/bootstrap",
  );
  if (!response.ok) return null;
  const envelope = await response.json() as { data?: { bootstrap?: unknown } };
  const parsed = adminBootstrapSchema.safeParse(envelope.data?.bootstrap);
  return parsed.success ? parsed.data : null;
}

// SPEC: 服务端兜底页也说运营选定的那门语言。
// INTENT: i18n.tsx 是 "use client"，服务端 import 到的只是引用桩，一调就抛
//         （"Attempted to call translateAdmin() from the server"）。这一页在
//         AdminI18nProvider 之外、又必须首帧就对，所以直接查同一张外壳词典 ——
//         同一份文案，不是第二套 i18n。
function AdminAuthorityUnavailable({ locale }: { locale: AdminLocale }) {
  const t = (key: string) => (locale === "zh" ? (adminZhShell[key] ?? key) : key);

  return (
    <main className="grid min-h-screen place-items-center bg-[var(--ad-canvas)] p-6 text-[var(--ad-ink)]">
      <section className="max-w-md rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-6">
        <h1 className="text-lg font-semibold">{t("The admin authority service is unavailable.")}</h1>
        <p className="mt-2 text-sm text-[var(--ad-text-muted)]">
          {t("The control plane cannot verify identity, permissions, or data provenance right now. Admin data and actions stay unavailable until it recovers.")}
        </p>
      </section>
    </main>
  );
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
