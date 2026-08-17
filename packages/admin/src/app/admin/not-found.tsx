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
// NOTE: 这一页的可见内容不在首帧 HTML 里，是客户端渲染的。别用 grep body 判断它是否渲染——
//       `admin-not-found-suggestions` 这类 testid 在原始 HTTP body 里**永远是 0**，页面正常
//       与否都一样。要判断得把 flight payload 按元素行拆开：本组件以元素形式出现
//       （`["$","$L<id>",null,{"attemptedPath":...}]`）就说明它渲染了，这一条已实测确认。
// NOTE: 曾怀疑是上面那次 bootstrap 网络往返把整页推过了 Suspense 边界导致不能 SSR，于是试着
//       把它去掉——**实测证伪：去掉前后响应体逐字节相同（48435 B），可见文字仍然是 0**。
//       真因是 notFound() 在流式输出开始后抛出，React 直接切客户端渲染（响应体里的
//       NEXT_HTTP_ERROR_FALLBACK;404 + "Switched to client rendering"），与 async 和网络往返
//       都无关。所以不要再为了换回 SSR 去删这次 bootstrap —— 换不回来，只会白丢权限过滤。
// UNVERIFIED: 「有权限的会话下建议列表长什么样」仍无人验证过。已确认的只是本组件会被渲染；
//       建议非空需要非空 permissions，而目前所有实测都是未认证会话（permissions: []）。
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
