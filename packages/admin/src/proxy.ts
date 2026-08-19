import { NextResponse, type NextRequest } from "next/server";
import { adminRouteExists } from "@/components/admin/nav-routes";

/** 认不出的路径原样转给 not-found.tsx —— 它拿不到 pathname，只能靠 proxy 递过去。 */
export const ADMIN_UNKNOWN_PATH_HEADER = "x-admin-unknown-path";

// SPEC: 认不出的后台路径要以 404 状态返回，而不是 200 加一个长得像 404 的页面。
// INTENT: renderAdminRoute 里的 notFound() 换得掉页面内容，换不掉状态码——app/admin/loading.tsx
//         的 Suspense fallback 一渲染，响应体就开始流式输出，状态码随即被锁成 200。这是 Next
//         写在文档里的行为（file-conventions/loading#status-codes），并指名 proxy 是"在响应体
//         开始流式输出之前确认资源存在"的地方。实测：移走 loading.tsx 就是 404，放回就是 200——
//         骨架屏值得留着，所以判定挪到这里。
//         这不是 dev 假象：production standalone build 上停用本 proxy 的 matcher，同一个未知
//         路径返回 200，body 里 notFound() 已经触发、admin 的 404 页也渲染了——教科书式 soft 404。
// INTENT: 用 next({ status }) 而不是 rewrite()。next() 让路由照常渲染（notFound() 仍然渲出
//         admin 段自己的 not-found.tsx），状态码则在流式输出开始之前就定好——Next 收到 proxy
//         响应后无条件执行 res.statusCode = middlewareRes.status
//         （dist/server/lib/router-utils/resolve-routes.js），然后才去渲染页面。
// NOTE: rewrite() 为什么不行，分两种情况——production standalone build 上三变体对照实测，
//       唯一变量是本函数的返回语句（同一份源码、同一条 build 流水线、not-found 页原地不动）：
//       · rewrite 到**同一个 URL**：Next 发出的是绝对 URL 的 x-middleware-rewrite，standalone
//         server 把它当成一次打回自己的 HTTP 代理请求 → 500。具体错码随 hostname 绑定与 IPv6
//         解析而变（bind 127.0.0.1 而 localhost 解析到 ::1 时是 ECONNREFUSED，也见过
//         socket hang up）；变的是错码，不变的是"绝对 URL rewrite 会变成自代理"。
//       · rewrite 到**另一个内部路径**（如 /_not-found）：状态码是干净的 404，但渲染的是 Next
//         内置的 "This page could not be found"——admin 自己的 404 页（i18n + 最近目的地建议）
//         被丢掉了，除非把它搬到应用根下。
//       next() 两样代价都不用付：状态码在流式输出开始前定好，页面仍由 app/admin/not-found.tsx
//       渲染。这也是它比 rewrite 更小的改动——不需要动 404 页的位置。
// NOTE: 还有一条走不通的路，省得后人再试：在 app/admin/layout.tsx 里 notFound() 状态码确实是
//       404（layout 在 Suspense 边界之外），但渲染出来的是 Next 内置的默认 404 页——layout
//       抛出时用的是父级边界，同段的 not-found.tsx 在它下面，够不着。
// INVARIANT: 这里只做纯字符串判定，不取数、不读 cookie、不碰权限。proxy 只回答"这条路径存不
//            存在"；"你能不能看"仍然只由 renderAdminRoute 的 bootstrap 决定。
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (pathname !== "/admin" && !pathname.startsWith("/admin/")) return NextResponse.next();

  const section = pathname.slice("/admin".length).replace(/^\/+|\/+$/g, "");
  // "/admin" 与 "/admin/inbox" 是入口别名，由 [[...section]]/page.tsx 的 adminEntryRedirect
  // 重定向到 /admin/today；它们本来就解析不出导航项，不能当成拼错的 URL。
  if (section === "" || section === "inbox") return NextResponse.next();
  if (adminRouteExists(`${section}${search}`)) return NextResponse.next();

  const headers = new Headers(request.headers);
  headers.set(ADMIN_UNKNOWN_PATH_HEADER, section);
  return NextResponse.next({ status: 404, request: { headers } });
}

export const config = {
  matcher: "/admin/:path*",
};
