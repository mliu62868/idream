import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AdminPermissionKey } from "@idream/shared/admin/permissions";
import { AdminConsoleClient } from "@/components/admin/AdminConsoleClient";
import {
  DEFAULT_ADMIN_SHELL_PREFERENCES,
  type AdminShellPreferences,
} from "@/components/admin/shell-preferences";
import type { AdminShellSignals } from "@/components/admin/shell-signals";

const adminRoot = path.resolve(import.meta.dirname);

const testSignals: AdminShellSignals = {
  environment: "test",
  dataClass: "fixture",
  fixtureState: "included",
  productTimezone: "UTC",
  freshness: { state: "reported", label: "2026-08-11T00:00:00.000Z" },
};

function shellProps(overrides: {
  actor?: { id: string; role: string };
  initialPermissions?: AdminPermissionKey[];
  initialSection?: string;
  preferences?: Partial<AdminShellPreferences>;
  shellSignals?: AdminShellSignals;
} = {}) {
  return {
    actor: overrides.actor ?? { id: "operator-1", role: "admin" },
    initialAccess: true,
    initialPermissions: overrides.initialPermissions ?? (["dashboard.read"] as AdminPermissionKey[]),
    initialSection: overrides.initialSection ?? "today",
    preferences: { ...DEFAULT_ADMIN_SHELL_PREFERENCES, ...overrides.preferences },
    shellSignals: overrides.shellSignals ?? testSignals,
  };
}
const canonicalPageFiles = [
  "today/page.tsx",
  "characters/page.tsx",
  "characters/new/page.tsx",
  "characters/review/page.tsx",
  "characters/[id]/page.tsx",
  "creative/runs/page.tsx",
  "creative/runs/[id]/page.tsx",
  "ops/incidents/page.tsx",
  "ops/incidents/[id]/page.tsx",
  "cases/page.tsx",
  "cases/[id]/page.tsx",
  "ops/jobs/page.tsx",
] as const;

describe("canonical Admin route shell", () => {
  it("ships each core decision workspace as a physical Next page", async () => {
    await Promise.all(canonicalPageFiles.map((relativePath) => access(path.join(adminRoot, relativePath))));

    for (const relativePath of canonicalPageFiles) {
      const source = await readFile(path.join(adminRoot, relativePath), "utf8");
      expect(source, relativePath).toContain("renderAdminRoute(");
      expect(source, relativePath).toContain('export const dynamic = "force-dynamic"');
    }
  });

  it("retains the optional catch-all as compatibility glue over the shared renderer", async () => {
    const source = await readFile(path.join(adminRoot, "[[...section]]/page.tsx"), "utf8");
    const renderer = await readFile(path.join(adminRoot, "_server/render-admin-route.tsx"), "utf8");

    expect(source).toContain("adminEntryRedirect");
    expect(source).toContain("renderAdminRoute(section");
    expect(source).not.toContain("loadAdminBootstrap");
    expect(renderer).toContain("loadAdminBootstrap");
    expect(renderer).toContain("canReadAnyWorkspace");
    expect(renderer).toContain("<AdminConsoleClientOnly");
  });

  it("keeps the initial SSR and hydration render deterministic with a closed drawer", () => {
    const props = shellProps();
    const serverMarkup = renderToString(<AdminConsoleClient {...props} />);
    const hydrationMarkup = renderToString(<AdminConsoleClient {...props} />);

    expect(hydrationMarkup).toBe(serverMarkup);
    expect(serverMarkup).toContain('aria-controls="admin-mobile-navigation"');
    expect(serverMarkup).toContain('aria-expanded="false"');
    expect(serverMarkup).not.toContain('id="admin-mobile-navigation"');
  });

  it("gives the skip link a focusable main-content target", () => {
    const markup = renderToString(<AdminConsoleClient {...shellProps()} />);

    expect(markup).toMatch(/<section[^>]*id="admin-main-content"[^>]*tabindex="-1"/);
  });

  it("renders the canonical character review route as the pending submissions queue", () => {
    const markup = renderToString(
      <AdminConsoleClient
        {...shellProps({
          actor: { id: "moderator-1", role: "moderator" },
          initialPermissions: ["safety.review.read"],
          initialSection: "characters/review",
        })}
      />,
    );

    expect(markup).toContain("Character Review");
    expect(markup).toContain("Pending submissions");
    expect(markup).toContain('name="review-queue-search"');
  });

  // SPEC: 服务端第一帧就是最终形态——语言、展开的分组、工作模式全部来自 cookie。
  // INTENT: 这三项过去在 useEffect(rAF → localStorage) 里读，于是首帧必然是 English +
  //         全折叠侧栏，几百毫秒后整页跳变。断言的是"首帧已经对"，不是"最终会对"。
  it("renders the operator's stored language and expanded groups in the first server frame", () => {
    const markup = renderToString(
      <AdminConsoleClient
        {...shellProps({
          initialPermissions: ["dashboard.read", "content.read", "safety.review.read"],
          preferences: { locale: "zh", openNavGroups: ["Character Studio"] },
        })}
      />,
    );

    expect(markup).toContain("今日工作");
    expect(markup).not.toContain(">Today<");
    // 展开的分组把它的导航项也一并渲染出来了，而不是只留一个分组标题。
    expect(markup).toContain("角色工作室");
    expect(markup).toContain("分类体系");
  });

  it("never reads a shell preference back out of browser storage", async () => {
    const source = await readFile(
      path.resolve(adminRoot, "../../components/admin/AdminConsoleClient.tsx"),
      "utf8",
    );

    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("requestAnimationFrame");
  });

  // SPEC: 冷启动（没有任何 cookie）的侧栏不能只剩一个可去的地方。
  it("expands a workable default set of destinations on a cold start", () => {
    const permissions = ["dashboard.read", "content.read", "safety.review.read"] as AdminPermissionKey[];
    const markup = renderToString(
      <AdminConsoleClient {...shellProps({ initialPermissions: permissions })} />,
    );

    // admin 模式的首要分组是 Character Studio；这三个获准的能力应当直接可见，
    // 而不是藏在一个只写着分组名的折叠标题后面。
    expect(markup).toContain(">Character Review<");
    expect(markup).toContain(">Character Starters<");
    expect(markup).toContain(">Taxonomy<");
    // 非首要分组仍然折叠：Growth 只出标题，不出它的导航项。
    expect(markup).toContain(">Growth<");
    expect(markup).not.toContain(">CMS &amp; SEO<");
  });

  // SPEC: 顶栏出面包屑；账号、语言、工作模式、数据来源都收进账号菜单，不再占正文流。
  it("replaces the always-on identity and provenance rows with a breadcrumb and an account menu", () => {
    const markup = renderToString(
      <AdminConsoleClient
        {...shellProps({ initialSection: "ops/jobs", initialPermissions: ["ops.queue.read", "generation.job.read"] })}
      />,
    );

    expect(markup).toContain('aria-label="Breadcrumb"');
    expect(markup).toContain("Platform Operations");
    expect(markup).toContain('aria-controls="admin-account-menu"');
    // 菜单默认关闭：来源信息与工作模式选择器都不在首帧的正文流里。
    expect(markup).not.toContain('data-testid="admin-shell-signals"');
    expect(markup).not.toContain('aria-label="Work mode"');
    // 但"这里不是生产环境"必须常驻可见。
    expect(markup).toContain('data-testid="admin-environment-notice"');
  });

  it("keeps the production environment notice out of the header", () => {
    const markup = renderToString(
      <AdminConsoleClient
        {...shellProps({ shellSignals: { ...testSignals, environment: "production" } })}
      />,
    );

    expect(markup).not.toContain('data-testid="admin-environment-notice"');
  });

  // SPEC: 角色工作台不再是外壳里的硬编码特判，只是一个声明了 chrome="compact" 的导航项。
  // INTENT: 旧特判在四个地方各 null 一次，副作用是角色页成了全站唯一没有全局搜索的页面。
  //         compact 现在只表示一件事：这一页自带页面级标题，外壳不再叠第二个 h1。
  it("gives the character workspace the same global search as every other page", async () => {
    const markup = renderToString(
      <AdminConsoleClient
        {...shellProps({
          initialSection: "characters",
          initialPermissions: ["character.project.read", "character.release.read", "character.performance.read"],
        })}
      />,
    );
    const source = await readFile(
      path.resolve(adminRoot, "../../components/admin/AdminConsoleClient.tsx"),
      "utf8",
    );

    expect(markup).toContain('aria-label="Global admin search"');
    expect(markup).toContain('aria-controls="admin-account-menu"');
    expect(source).not.toContain("isCharacterWorkspace");
    expect(source).not.toContain('"content/official"');
  });

  // SPEC: 拒绝页必须给出下一步：缺哪几个键、在哪儿授予、授予者需要什么。
  // INTENT: 原文案只说"你没权限"，运营在这一页唯一能做的就是关掉它。
  it("tells a denied operator which permission keys are missing and where they are granted", () => {
    const markup = renderToString(
      <AdminConsoleClient
        {...shellProps({
          initialSection: "characters",
          initialPermissions: ["character.project.read"],
        })}
      />,
    );

    expect(markup).toContain('data-testid="admin-section-permission-denied"');
    expect(markup).toContain("character.release.read");
    expect(markup).toContain("character.performance.read");
    // 已经持有的那个键不该出现在"缺少"清单里。
    expect(markup).not.toContain(">character.project.read<");
    expect(markup).toContain("Team Access");
    expect(markup).toContain("user.role.write");
  });

  // SPEC: 「团队访问」的入口只在运营真读得进去时才给——否则只是第二堵墙。
  it("only links Team Access to an operator who can actually open it", () => {
    const withoutUserRead = renderToString(
      <AdminConsoleClient
        {...shellProps({ initialSection: "characters", initialPermissions: ["character.project.read"] })}
      />,
    );
    const withUserRead = renderToString(
      <AdminConsoleClient
        {...shellProps({
          initialSection: "characters",
          initialPermissions: ["character.project.read", "user.read"],
        })}
      />,
    );

    expect(withoutUserRead).not.toContain('href="/admin/system/access"');
    expect(withUserRead).toContain('href="/admin/system/access"');
  });

  it("uses an accessible drawer instead of a horizontal link strip below desktop", async () => {
    const source = await readFile(
      path.resolve(adminRoot, "../../components/admin/AdminConsoleClient.tsx"),
      "utf8",
    );

    expect(source).not.toContain('<nav className="flex gap-2 overflow-x-auto');
    expect(source).toContain('aria-controls="admin-mobile-navigation"');
    expect(source).toContain('aria-modal="true"');
    expect(source).toContain('event.key === "Escape"');
    expect(source).toContain("trigger?.focus()");
    expect(source).toContain('window.matchMedia("(min-width: 1280px)")');
    expect(source).toContain("xl:flex xl:flex-col");
  });
});
