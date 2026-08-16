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
// INTENT: 用 next({ status }) 而不是 rewrite()。rewrite 到同一个 URL 在 dev 下确实出 404，但
//         production build 里服务端会把它当成向自己发起的代理请求，直接 socket hang up 成 500
//         （实测）。next() 让路由照常渲染（notFound() 仍然渲出 not-found.tsx），只是状态码在
//         流式输出开始之前就定好了。
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
