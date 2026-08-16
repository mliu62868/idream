import { cookies, headers } from "next/headers";
import { AdminNotFoundPage } from "@/components/admin/AdminMessagePage";
import { readAdminShellPreferences } from "@/components/admin/shell-preferences";
import { loadAdminBootstrap } from "./_server/render-admin-route";
import { ADMIN_UNKNOWN_PATH_HEADER } from "@/proxy";

// SPEC: 404 页要知道运营原本想去哪儿，才能给出"你可能想去的是这几个"。
// INTENT: not-found.tsx 拿不到 pathname——Next 没给这个入口任何路由参数。proxy 判定这条路径
//         不存在时顺手把它写进请求头（文档里 proxy → 应用之间就是靠 header 传值），这里读回来。
//         读不到（例如有人绕过 proxy 直接 notFound()）就只出返回按钮，不猜。
// INTENT: 权限走一次 bootstrap，只为了不建议运营打不开的页面；权威服务挂了就退化成不给建议，
//         404 页本身不能因此也挂掉。
export default async function AdminNotFound() {
  const [headerList, cookieStore] = await Promise.all([headers(), cookies()]);
  const { locale } = readAdminShellPreferences((name) => cookieStore.get(name)?.value);
  const bootstrap = await loadAdminBootstrap(headerList).catch(() => null);

  return (
    <AdminNotFoundPage
      attemptedPath={headerList.get(ADMIN_UNKNOWN_PATH_HEADER)}
      locale={locale}
      permissions={bootstrap?.permissions ?? []}
    />
  );
}
