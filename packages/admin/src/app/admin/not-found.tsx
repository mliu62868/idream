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
//
// NOTE: 这一页的可见内容不在首帧 HTML 里，是客户端渲染的（浏览器里确实画得出来：标题、
//       原路径回显、返回按钮都在，有实测）。曾怀疑是上面那次 bootstrap 网络往返把整页推过了
//       Suspense 边界，于是试着把它去掉——**实测证伪：去掉前后响应体逐字节相同（48435 B），
//       可见文字仍然是 0**。真正的原因是 notFound() 在流式输出开始后抛出，React 直接切客户端
//       渲染（响应体里的 NEXT_HTTP_ERROR_FALLBACK;404 + "Switched to client rendering"），
//       和 async / 网络往返都无关。所以不要再为了换回 SSR 去删这次 bootstrap —— 换不回来，
//       只会白白丢掉建议列表的权限过滤。
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
