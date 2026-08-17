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
// NOTE: 为什么首帧 HTML 里没有可见文字——三个变量逐个测过，别再重复这三次：
//       · 删掉上面那次 bootstrap 网络往返：响应体逐字节相同（48435 B），可见文字仍是 0。
//       · 把本组件改成完全同步（一个 await 都没有）：可见文字仍是 0。async 无罪。
//       · 把渲染内容换成纯服务端 markup（同步）：**可见文字出现了**。
//       三种情况下 NEXT_HTTP_ERROR_FALLBACK;404 都在——**边界照样在流式之后报错，但服务端
//       markup 依然进得了首帧**。所以"notFound() 抛在流式之后"不是丢 SSR 的原因，别照那句
//       推出"这一页不可能 SSR"的结论。
// TRADEOFF: 真正的取舍是 **i18n ↔ SSR**。这一页要按运营选的语言说话，就得用 AdminNotFoundPage，
//       而它是客户端组件（useAdminI18n 在 "use client" 里），服务端只留模块引用、DOM 由客户端
//       产出。想让它重回 SSR，得把翻译表移出 "use client" 让文案能在服务端翻译——不是删 await，
//       更不是删这次 bootstrap（那只会白丢建议列表的权限过滤）。
// NOTE: 这条约束不止这一页：authority 不可用页、以及外壳早期那个 getStoredAdminLocale，都撞过
//       同一堵墙。真要解就一次性解在 i18n 那层。
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
