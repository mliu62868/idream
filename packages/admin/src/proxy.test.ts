import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { ALL_SECTION_ITEMS } from "@/components/admin/nav-config";
import { config, proxy } from "./proxy";

// SPEC: 锁的是发出去的那个状态码，不是「notFound() 被调用过」。
//
// INTENT: 这个 bug 的全部要害就在状态码：页面内容一直是对的（not-found.tsx 渲染出来了），
//         HTTP 状态码却是 200。单元层断言 parseAdminPath 返回 null 是过得去的——它以前就过着，
//         而线上照样回 200。所以这里断言的是 proxy 返回的响应本身：Next 收到 proxy 的响应后
//         第一件事就是 `res.statusCode = middlewareRes.status`
//         （next/dist/server/lib/router-utils/resolve-routes.js），随后照常渲染页面。
//         这个 status 就是运营 curl 到的那个 status，中间没有第二次赋值。
//
// 真实 HTTP 端到端另有实测（production standalone build，见本轮报告）：
//   /admin/definitely-not-a-route -> 404，/admin/today -> 200。
function head(path: string) {
  return proxy(new NextRequest(new URL(`http://admin.local${path}`)));
}

describe("admin proxy — unrecognised routes get a real 404", () => {
  it("answers an unknown admin path with 404 instead of a 200 page", () => {
    expect(head("/admin/definitely-not-a-route").status).toBe(404);
    expect(head("/admin/nope/deeper").status).toBe(404);
    // 只差一个字母的拼写同样是 404 —— 从前它会安静地显示 Today。
    expect(head("/admin/growth/funnel").status).toBe(404);
  });

  it("lets every navigable destination through untouched", () => {
    const rejected = ALL_SECTION_ITEMS
      .map((item) => ({ href: item.href, status: head(item.href).status }))
      .filter((entry) => entry.status !== 200);

    expect(rejected).toEqual([]);
  });

  // SPEC: 旧 URL 仍然可达 —— 状态码变严了，可达性不能跟着变严。
  it("keeps every legacy destination URL reachable", () => {
    const rejected = ALL_SECTION_ITEMS
      .filter((item) => item.legacyHref !== null)
      .map((item) => ({ href: item.legacyHref, status: head(item.legacyHref as string).status }))
      .filter((entry) => entry.status !== 200);

    expect(rejected).toEqual([]);
  });

  // /admin 与 /admin/inbox 过不了 parseAdminPath，但它们是入口跳板，不是死路。
  it("does not 404 the entry paths that redirect to Today", () => {
    expect(head("/admin").status).toBe(200);
    expect(head("/admin/inbox").status).toBe(200);
    expect(head("/admin?utm=mail").status).toBe(200);
  });

  // 七个目的地只靠 ?view= 区分，判定必须带上 query，否则会把它们认成同一页。
  it("judges the query string, not just the path", () => {
    expect(head("/admin/ops/recipes?view=presets").status).toBe(200);
    expect(head("/admin/ops/recipes?view=workflows").status).toBe(200);
    expect(head("/admin/ops/providers?view=backends").status).toBe(200);
  });

  it("only runs on admin paths", () => {
    expect(config.matcher).toBe("/admin/:path*");
  });
});
