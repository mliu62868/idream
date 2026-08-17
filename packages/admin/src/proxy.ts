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
// INTENT: 用 next({ status }) 而不是 rewrite()。next() 让路由照常渲染（notFound() 仍然渲出
//         admin 段自己的 not-found.tsx），状态码则在流式输出开始之前就定好——Next 收到 proxy
//         响应后无条件执行 res.statusCode = middlewareRes.status
//         （dist/server/lib/router-utils/resolve-routes.js），然后才去渲染页面。
// NOTE: rewrite() 这条路两位实现者的实测不一致——一方在真实 admin 应用的 production build 上
//       看到它退化成 500（怀疑 rewrite 目标又被自己的 matcher 兜了一圈），另一方在最小复现
//       应用上量到的是干净的 404。没有人在同一环境下同时跑过两者，所以这里只记录分歧，不下
//       结论。选 next() 不依赖这个分歧：它无需把 not-found 页搬到应用根下，本身就是更小的改动。
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
