import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AdminPermissionKey } from "@idream/shared/admin/permissions";
import {
  AdminAuthorityUnavailablePage,
  AdminNotFoundPage,
} from "./AdminMessagePage";

function notFound(options: {
  attemptedPath: string | null;
  locale?: "en" | "zh";
  permissions?: AdminPermissionKey[];
}) {
  return renderToString(
    <AdminNotFoundPage
      attemptedPath={options.attemptedPath}
      locale={options.locale ?? "en"}
      permissions={options.permissions ?? []}
    />,
  );
}

describe("admin not-found page", () => {
  // SPEC: 整页文案走 i18n；语言由服务端从 cookie 读出后传进来。
  // INTENT: 这张页面原先整页硬编码中文，英文 locale 下直接露馅。
  it("renders in the operator's language rather than a hardcoded one", () => {
    const english = notFound({ attemptedPath: "nope" });
    expect(english).toContain("Admin workspace not found");
    expect(english).not.toContain("未找到后台工作区");

    const chinese = notFound({ attemptedPath: "nope", locale: "zh" });
    expect(chinese).toContain("未找到后台工作区");
    expect(chinese).toContain("返回今日工作");
  });

  // SPEC: 不再是死胡同——认不出的路径要给出最接近的几个目的地。
  it("suggests the closest workspaces for a stale or mistyped path", () => {
    const markup = notFound({
      attemptedPath: "ops/deadletter",
      permissions: ["ops.queue.read"],
    });

    expect(markup).toContain('data-testid="admin-not-found-suggestions"');
    expect(markup).toContain("Dead-letter");
    expect(markup).toContain("/admin/ops/jobs?view=dead-letter");
    // 原路径要显示出来，运营才知道是哪个书签失效了。
    expect(markup).toContain("/admin/ops/deadletter");
  });

  // SPEC: 半个页面名也要能猜中 —— 运营常常只记得一半就直接敲地址栏。
  // INTENT: 从被取代的 app/admin/not-found.test.tsx 收编的用例；那份测试断言的是另一个
  //         并行实现的组件 API，行为意图仍然成立，搬到真实实现这边继续锁住。
  it("suggests destinations from a partial page name too", () => {
    const markup = notFound({ attemptedPath: "taxonom", permissions: ["content.read"] });

    expect(markup).toContain("Taxonomy");
    expect(markup).toContain("/admin/characters/taxonomy");
  });

  it("suggests in the operator's language too", () => {
    const markup = notFound({
      attemptedPath: "taxonomy",
      locale: "zh",
      permissions: ["content.read"],
    });

    expect(markup).toContain("你可能想去的是");
    expect(markup).toContain("分类体系");
  });

  // SPEC: 只建议运营真读得进去的页面。
  // INTENT: 建议一个他点开还是被拒的目的地，等于把 404 换成了另一堵墙。
  it("never suggests a workspace the operator cannot read", () => {
    const markup = notFound({ attemptedPath: "taxonomy", permissions: [] });

    expect(markup).not.toContain('data-testid="admin-not-found-suggestions"');
    expect(markup).not.toContain("Taxonomy");
    // 但回 Today 的出口永远在。
    expect(markup).toContain('href="/admin/today"');
  });

  // SPEC: 猜不出来就不猜——proxy 没递路径过来时（有人绕过它直接 notFound()）只出返回按钮。
  it("falls back to the plain exit when the attempted path is unknown", () => {
    const markup = notFound({ attemptedPath: null, permissions: ["content.read"] });

    expect(markup).not.toContain('data-testid="admin-not-found-suggestions"');
    expect(markup).not.toContain('data-testid="admin-not-found-path"');
    expect(markup).toContain('href="/admin/today"');
  });
});

describe("admin authority unavailable page", () => {
  it("renders in the operator's language rather than a hardcoded one", () => {
    expect(renderToString(<AdminAuthorityUnavailablePage locale="en" />))
      .toContain("Admin authority service unavailable");
    expect(renderToString(<AdminAuthorityUnavailablePage locale="zh" />))
      .toContain("后台权威服务不可用");
  });
});
