import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { adminEntryRedirect, parseAdminPath } from "@/components/admin/nav-config";

// SPEC: /admin 下认不出的路径回真的 404 —— 状态码，不只是页面内容。
//
// INTENT: renderAdminRoute 里的 notFound() 换得了 body，换不了状态码。app/admin/loading.tsx
//         给整个 /admin 段挂了 Suspense 边界，页面一进入渲染 Next 就把 fallback 冲出去；
//         响应头（状态码在里面）此刻已经发走，后到的 notFound() 只能改剩下的 body。
//         这不是 dev 特有的：production standalone build 实测同样 200，把 loading.tsx 拿掉
//         同一个请求立刻变 404 —— 那个 Suspense 边界是唯一变量。状态码只能在渲染开始之前定，
//         而请求进入渲染之前只剩这里。
//
// INTENT: 用 next({ status }) 而不是自己造一个 404 响应：Next 在调用 proxy 后立刻把
//         `res.statusCode = middlewareRes.status`（next/dist/server/lib/router-utils/
//         resolve-routes.js），然后照常渲染。于是状态码归这里、页面归 app/admin/not-found.tsx，
//         运营看到的仍是带建议的那一页，而不是一个裸 404。
//
// INVARIANT: 判定复用 nav-config 的 parseAdminPath，这里不另立第二张路由表 —— 状态码和页面
//            内容因此永远出自同一个判断。它是纯函数、不打网络，压在每个 /admin 请求前可忽略。
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const section = pathname.split("/").filter(Boolean).slice(1);

  // /admin 和 /admin/inbox 本身不是工作台，由 page.tsx redirect 到 /admin/today；
  // 它们过不了 parseAdminPath，得先放行。
  if (adminEntryRedirect(section, {})) return NextResponse.next();
  if (parseAdminPath(`${section.join("/")}${search}`)) return NextResponse.next();

  return NextResponse.next({ status: 404 });
}

export const config = { matcher: "/admin/:path*" };
