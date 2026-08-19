import { describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";
import { ALL_SECTION_ITEMS } from "@/components/admin/nav-config";
import { ADMIN_UNKNOWN_PATH_HEADER, config, proxy } from "./proxy";

// proxy 只读 nextUrl 和 headers；给它这两样就够了。
function request(url: string): NextRequest {
  return {
    nextUrl: new URL(url, "http://admin.local"),
    headers: new Headers({ cookie: "session=abc" }),
  } as unknown as NextRequest;
}

function statusOf(url: string) {
  return proxy(request(url)).status;
}

describe("admin proxy 404 authority", () => {
  // SPEC: 认不出的后台路径要在响应体流式输出开始之前就把状态码定成 404。
  // INTENT: renderAdminRoute 里的 notFound() 只换得掉页面内容——app/admin/loading.tsx 的
  //         Suspense fallback 一渲染，状态码就被锁成 200。单元层原先完全没有守卫这件事。
  it("answers 404 for a path navigation cannot resolve", () => {
    expect(statusOf("/admin/definitely-not-a-route")).toBe(404);
    expect(statusOf("/admin/nope/deeper")).toBe(404);
    expect(statusOf("/admin/characters/review/extra/deep")).toBe(404);
  });

  it("lets every published destination through untouched", () => {
    for (const item of ALL_SECTION_ITEMS) {
      expect(statusOf(item.href), item.href).toBe(200);
      if (item.legacyHref) expect(statusOf(item.legacyHref), item.legacyHref).toBe(200);
    }
  });

  // SPEC: /admin 与 /admin/inbox 解析不出导航项，但它们是入口别名，由页面 redirect 处理。
  it("never 404s the entry aliases that redirect to Today", () => {
    expect(statusOf("/admin")).toBe(200);
    expect(statusOf("/admin/")).toBe(200);
    expect(statusOf("/admin/inbox")).toBe(200);
    expect(statusOf("/admin/inbox?view=unassigned")).toBe(200);
  });

  it("keeps the query string that distinguishes a sub-view", () => {
    expect(statusOf("/admin/ops/recipes?view=presets")).toBe(200);
    expect(statusOf("/admin/ops/jobs?view=dead-letter")).toBe(200);
    expect(statusOf("/admin/characters/char-1?tab=release")).toBe(200);
  });

  it("stays out of everything that is not an admin route", () => {
    expect(statusOf("/api/v2/admin/search?q=amy")).toBe(200);
    expect(statusOf("/admin-not-a-segment")).toBe(200);
    expect(config.matcher).toBe("/admin/:path*");
  });

  // SPEC: not-found.tsx 拿不到 pathname，只能靠 proxy 把它写进请求头。
  it("hands the unresolved path to not-found.tsx through a request header", () => {
    const denied = proxy(request("/admin/nope/deeper"));
    expect(denied.headers.get("x-middleware-override-headers"))
      .toContain(ADMIN_UNKNOWN_PATH_HEADER);
    expect(denied.headers.get(`x-middleware-request-${ADMIN_UNKNOWN_PATH_HEADER}`))
      .toBe("nope/deeper");
  });
});
