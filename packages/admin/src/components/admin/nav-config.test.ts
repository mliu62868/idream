import { describe, expect, it } from "vitest";
import {
  firstScreenPermissions,
} from "./workspace-access";
import type { AdminV2DeclaredOperationId } from "@idream/shared/admin";
import type { AdminPermissionKey } from "@idream/shared/admin/permissions";
import { ADMIN_WORK_MODES } from "./shell-preferences";
import {
  ALL_SECTION_ITEMS,
  ADMIN_WORKSPACES,
  adminEntryRedirect,
  canReadAnyWorkspace,
  defaultWorkModeForRole,
  missingWorkspacePermissions,
  navGroupsForPermissions,
  navItems,
  parseAdminPath,
  sectionIsPermitted,
} from "./nav-config";

// parseAdminPath 解析出的是导航项本身；断言只关心它的 id 与子视图。
function at(value: string) {
  const parsed = parseAdminPath(value);
  return parsed ? { sectionId: parsed.item.id, view: parsed.view } : null;
}

const NAV_IDS = [
  "dashboard", "generation/jobs", "generation/config", "generation/recipes", "generation/presets", "generation/dead-letter",
  "ops/providers", "generation/backends", "generation/workflows", "generation/metrics",
  "content/production", "content/assets", "content/placements", "content",
  "content/official", "content/templates", "content/tags",
  "cms", "cases", "chat", "users", "billing", "pricing", "promo",
  "announcements", "analytics", "insights", "experiments", "compliance", "ops/incidents",
  "approvals", "system/access", "audit-log",
];
const TARGET_ONLY_NAV_IDS = ["growth/characters", "ops/invariants", "growth/affiliates"];

describe("admin navigation information architecture", () => {
  it("publishes every decision workspace exactly once inside the task groups", () => {
    expect(navItems.map((item) => item.id).sort()).toEqual([...NAV_IDS, ...TARGET_ONLY_NAV_IDS].sort());
    expect(new Set(navItems.map((item) => item.id)).size).toBe(NAV_IDS.length + TARGET_ONLY_NAV_IDS.length);
    expect(new Set(navItems.map((item) => item.group))).toEqual(new Set(ADMIN_WORKSPACES));
  });

  it("publishes canonical workspace URLs while retaining each legacy URL", () => {
    for (const item of navItems) {
      expect(item.href).toMatch(/^\/admin\/(today|characters|creative|cases|customers|customer-ops|growth|ops|system)/);
      if (TARGET_ONLY_NAV_IDS.includes(item.id)) expect(item.legacyHref).toBeNull();
      else expect(item.legacyHref).toBe(item.id === "dashboard" ? "/admin" : `/admin/${item.id}`);
    }
    expect(navItems.filter((item) => item.legacyHref !== null)).toHaveLength(33);
  });

  it("presents Character as the primary admin object", () => {
    expect(navItems.find((item) => item.id === "content/official")?.label).toBe("Characters");
    expect(navItems.filter((item) => item.navigation === "primary").map((item) => item.label))
      .toEqual(["Today"]);
    const groups = navGroupsForPermissions(new Set(ALL_SECTION_ITEMS.flatMap((item) => item.read.allOf)), "admin");
    expect(groups.slice(0, 2).map(({ group }) => group)).toEqual(["Today", "Characters"]);
    expect(groups.slice(-2).map(({ group }) => group)).toEqual(["Platform Operations", "System"]);
  });

  // SPEC: 入口层级是产品语义，不由组件按 URL 或名字猜。
  //       常规工作页直接出现；低频配置、诊断和兼容子视图进入渐进披露区。
  it("classifies low-frequency tools without removing their destinations", () => {
    expect(ALL_SECTION_ITEMS.filter((item) => item.navigation === "tool").map((item) => item.id).sort())
      .toEqual([
        "content/production",
        "generation/backends",
        "generation/dead-letter",
        "generation/metrics",
        "generation/presets",
        "generation/workflows",
        "insights",
        "moderation",
        "risk",
        "support",
      ].sort());
    expect(ALL_SECTION_ITEMS.every((item) =>
      ["primary", "workspace", "tool"].includes(item.navigation),
    )).toBe(true);
  });

  // SPEC: 导航项的名字只承诺页面真正提供的东西。
  // INTENT: 这一项曾叫「Funnels & Retention」并挂在 Growth 下 —— 但页面里既没有漏斗也没有
  //         cohort，数据契约里就没有这两样；它实际提供的是按 model-profile 查健康度加一个
  //         不调 provider 的配置检查，读它的是平台运维而不是增长分析师。名字和分组都得跟着
  //         页面走，否则运营点进去只会以为自己点错了。
  it("names the profile-health workspace after what the page actually shows", () => {
    const insights = navItems.find((item) => item.id === "insights");

    expect(insights?.label).toBe("Profile Diagnostics");
    expect(insights?.group).toBe("Platform Operations");
    // 换 URL 会废掉现有书签，这一轮只改元数据。
    expect(insights?.href).toBe("/admin/growth/funnels");
  });

  // SPEC: 外壳给多少外框由导航项自己声明，外壳里不再有 `sectionId === "content/official"` 的特判。
  it("declares its own shell chrome instead of being special-cased by the shell", () => {
    for (const item of navItems) expect(["default", "compact"], item.id).toContain(item.chrome);
    expect(navItems.filter((item) => item.chrome === "compact").map((item) => item.id))
      .toEqual(["content/official"]);
  });

  it("maps canonical routes and query-backed saved views onto domain workspaces", () => {
    expect(at("today")).toEqual({ sectionId: "dashboard", view: { kind: "list" } });
    expect(at("characters/new")).toEqual({ sectionId: "content/official", view: { kind: "new" } });
    expect(at("characters/releases")).toEqual({ sectionId: "content/official", view: { kind: "list" } });
    expect(at("characters/calendar")).toEqual({ sectionId: "content/official", view: { kind: "list" } });
    expect(at("characters/review")).toEqual({ sectionId: "content/official", view: { kind: "list" } });
    expect(at("characters/starters")).toEqual({ sectionId: "content/templates", view: { kind: "list" } });
    expect(at("characters/taxonomy")).toEqual({ sectionId: "content/tags", view: { kind: "list" } });
    expect(at("characters/char-1")).toEqual({ sectionId: "content/official", view: { kind: "detail", id: "char-1" } });
    expect(at("cases?view=overdue")?.sectionId).toBe("cases");
    expect(at("cases/case-1")).toEqual({ sectionId: "cases", view: { kind: "detail", id: "case-1" } });
    expect(at("customers/customer-1")).toEqual({ sectionId: "users", view: { kind: "detail", id: "customer-1" } });
    expect(at("ops/incidents")?.sectionId).toBe("ops/incidents");
    expect(at("ops/incidents/incident-1")).toEqual({ sectionId: "ops/incidents", view: { kind: "detail", id: "incident-1" } });
    expect(at("characters/char-1?tab=release&releaseId=release-1")).toEqual({ sectionId: "content/official", view: { kind: "detail", id: "char-1" } });
    expect(at("system/audit?commandId=command-1")).toEqual({ sectionId: "audit-log", view: { kind: "list" } });
    expect(at("growth/offers?view=promo")?.sectionId).toBe("promo");
    expect(at("growth/characters")?.sectionId).toBe("growth/characters");
    expect(at("ops/recipes?view=presets")?.sectionId).toBe("generation/presets");
    expect(at("growth/merchandising?view=announcements")?.sectionId).toBe("announcements");
  });

  // SPEC: 认不出的路径必须解析失败，好让路由层 notFound()。
  // INTENT: 这里曾静默返回 dashboard —— 拼错的 URL 显示成 Today 且仍回 200。
  it("refuses to resolve unknown paths instead of falling back to Today", () => {
    expect(parseAdminPath("nope")).toBeNull();
    expect(parseAdminPath("ops/does-not-exist")).toBeNull();
    expect(parseAdminPath("characters/review/extra/deep")).toBeNull();
    expect(parseAdminPath("")).toBeNull();
    // 合法但只做子视图的段仍然解析得出，不能被一并判死。
    expect(at("content/official/char-1")?.sectionId).toBe("content/official");
  });

  it("retains compatibility routes until their Case commands reach parity", () => {
    for (const id of NAV_IDS) expect(at(id)?.sectionId).toBe(id);
    expect(at("content/review-queue")?.sectionId).toBe("content/official");
    expect(at("characters/review")?.sectionId).toBe("content/official");
    expect(navItems.map((item) => item.id)).not.toContain("content/review-queue");
    expect(at("moderation")?.sectionId).toBe("moderation");
    expect(at("support")?.sectionId).toBe("support");
    expect(at("risk")?.sectionId).toBe("risk");
    expect(at("generation/models")?.sectionId).toBe("generation/config");
    expect(sectionIsPermitted("support", new Set(["support.request.read"]))).toBe(true);
    expect(sectionIsPermitted("moderation", new Set(["safety.review.read"]))).toBe(true);
    expect(navItems.some((item) => ["support", "moderation", "risk"].includes(item.id))).toBe(false);
  });

  it("redirects only entry aliases and preserves query state", () => {
    expect(adminEntryRedirect([], { view: "mine", severity: ["p0", "p1"] })).toBe(
      "/admin/today?view=mine&severity=p0&severity=p1",
    );
    expect(adminEntryRedirect(["inbox"], { view: "unassigned" })).toBe(
      "/admin/today?view=unassigned",
    );
    expect(adminEntryRedirect(["users"], {})).toBeNull();
  });
});

describe("permission and work-mode navigation", () => {
  it("derives every v2 workspace and deep-link gate from the API authority manifest", () => {
    for (const item of ALL_SECTION_ITEMS) {
      const complete = new Set<AdminPermissionKey>(item.read.allOf);
      expect(sectionIsPermitted(item.id, complete), item.id).toBe(true);
      for (const missing of item.read.allOf) {
        const incomplete = new Set(item.read.allOf.filter((key) => key !== missing));
        expect(sectionIsPermitted(item.id, incomplete), `${item.id} without ${missing}`).toBe(false);
      }
    }
  });

  // SPEC: 入口读权限必须覆盖该页首屏真正调用的 API 所需权限。
  // INTENT: 这三页只读 generation/* 权威（backends、metrics、model-profiles），要求的是
  //         generation.config.read。它们曾分别挂在 ops.queue.read 和 metrics 工作区
  //         （analytics.metric.read）下：菜单可见、点进去首屏请求 403，只有分析师这种
  //         单权限账号才会撞上，内置的 ops/admin 因为同时持有两个权限一直掩盖着它。
  // SPEC: 每个入口都要登记它"首屏必需"的 operation；入口读权限必须覆盖这些 operation 在 API
  //       manifest 里要求的全部权限。
  // INTENT: 入口权限和页面真正调的接口曾各自演化，漂移出三处「菜单可见、点进去整页 403」
  //         （Profile Diagnostics / 后端诊断 / 生成健康）。权限键是手写的，没有任何机制把它
  //         和接口绑在一起。把首屏依赖登记下来之后：漏登记 → 红；入口比首屏松（会 403）→ 红；
  //         入口比首屏严 → 必须写明理由，避免无意中把有权限的人挡在外面。
  // 定义：首屏必需 = 进页面就会发、且失败会让这一屏拿不到主要内容的请求。挂载即发但失败可
  //       优雅降级的附加面板（saved-views、correlation-outbox、flag-monitoring 等）不算。
  const FIRST_SCREEN: Record<string, readonly AdminV2DeclaredOperationId[]> = {
    dashboard: ["GET /api/v2/admin/dashboard", "GET /api/v2/admin/today"],
    "content/official": ["GET /api/v2/admin/characters/portfolio"],
    "content/templates": ["GET /api/v2/admin/content/templates"],
    "content/tags": ["GET /api/v2/admin/content/tags"],
    "content/assets": ["GET /api/v2/admin/assets"],
    "content/placements": ["GET /api/v2/admin/content/placements"],
    "content/production": ["GET /api/v2/admin/creative/runs"],
    cases: ["GET /api/v2/admin/cases"],
    users: ["GET /api/v2/admin/customers"],
    billing: [
      "GET /api/v2/admin/billing/ledger",
      "GET /api/v2/admin/billing/subscriptions",
      "GET /api/v2/admin/billing/reconciliation",
    ],
    compliance: [
      "GET /api/v2/admin/compliance/account-deletions",
      "GET /api/v2/admin/compliance/age-verifications",
    ],
    analytics: ["GET /api/v2/admin/metrics"],
    "growth/characters": ["GET /api/v2/admin/characters/portfolio"],
    experiments: ["GET /api/v2/admin/experiments"],
    content: ["GET /api/v2/admin/content/characters", "GET /api/v2/admin/content/featured"],
    announcements: ["GET /api/v2/admin/announcements"],
    cms: ["GET /api/v2/admin/cms/pages"],
    pricing: ["GET /api/v2/admin/pricing/rules"],
    "growth/affiliates": ["GET /api/v2/admin/affiliate/applications"],
    promo: ["GET /api/v2/admin/promo/redeem-codes", "GET /api/v2/admin/promo/referrals"],
    "ops/incidents": ["GET /api/v2/admin/incidents"],
    "ops/invariants": ["GET /api/v2/admin/reconciliation/invariants"],
    "generation/jobs": ["GET /api/v2/admin/jobs"],
    "generation/dead-letter": ["GET /api/v2/admin/generation/dead-letter"],
    "ops/providers": ["GET /api/v2/admin/ops/providers"],
    "generation/backends": ["GET /api/v2/admin/generation/backends"],
    "generation/metrics": ["GET /api/v2/admin/generation/metrics"],
    insights: ["GET /api/v2/admin/generation/model-profiles"],
    "generation/config": ["GET /api/v2/admin/generation/model-profiles"],
    "generation/recipes": ["GET /api/v2/admin/generation/recipes"],
    "generation/presets": ["GET /api/v2/admin/generation/presets"],
    "generation/workflows": ["GET /api/v2/admin/generation/workflows"],
    chat: [
      "GET /api/v2/admin/chat/overview",
      "GET /api/v2/admin/chat/provider-health",
      "GET /api/v2/admin/chat/sessions",
      "GET /api/v2/admin/chat/usage",
      "GET /api/v2/admin/chat/moderation-events",
    ],
    approvals: ["GET /api/v2/admin/approvals"],
    "system/access": ["GET /api/v2/admin/users"],
    "audit-log": ["GET /api/v2/admin/audit-log"],
    moderation: ["GET /api/v2/admin/moderation/queue"],
    support: ["GET /api/v2/admin/support/requests"],
    risk: ["GET /api/v2/admin/risk/abuse"],
  };

  // 入口权限严格超集于首屏必需权限的条目，必须在这里写明为什么 —— 每一条都会挡住
  // "本来看得了这一屏"的人，所以只有想清楚了的才允许存在。
  const STRICTER_BY_DESIGN: Record<string, string> = {
    "content/official":
      "同一个入口还承载 /admin/characters/:id 详情态，详情首屏是 GET /characters/:id，" +
      "它要 project+release+performance 三个权限；入口取两个子视图的高水位线，" +
      "只有 performance.read 的人走 Character Performance 那个入口。",
    "generation/config":
      "挂载即发的还有 feature-flags（Settings tab）与 jobs（详情侧栏）；两者失败都只影响" +
      "非默认 tab，但入口按全部挂载期请求的并集要求权限，宁可挡住也不让人进来看半张页面。",
  };

  it("declares a first screen for every entry and never gates it looser than that screen needs", () => {
    const registered = new Set(Object.keys(FIRST_SCREEN));
    expect(
      ALL_SECTION_ITEMS.map((item) => item.id).filter((id) => !registered.has(id)),
      "every nav entry registers its first screen",
    ).toEqual([]);

    for (const item of ALL_SECTION_ITEMS) {
      const required = firstScreenPermissions(FIRST_SCREEN[item.id] ?? []);
      const declared = new Set<AdminPermissionKey>(item.read.allOf);
      const missing = required.filter((permission) => !declared.has(permission));
      // 入口比首屏松 = 菜单可见、点进去 403。这是硬失败。
      expect(missing, `${item.id} entry permission must cover its first screen`).toEqual([]);

      const extra = item.read.allOf.filter((permission) => !required.includes(permission));
      if (extra.length > 0) {
        expect(
          STRICTER_BY_DESIGN[item.id],
          `${item.id} is stricter than its first screen (${extra.join(", ")}) — record why`,
        ).toBeTruthy();
      }
    }
  });

  it("gates the generation diagnostics pages on the permission their first request needs", () => {
    // 入口权限从 manifest 推导，所以这里断言的是"和接口要求一致"，不是某个写死的权限键：
    // 接口哪天换了权限，入口跟着换，这条用例仍然成立。
    const firstScreen = {
      "generation/backends": "GET /api/v2/admin/generation/backends",
      "generation/metrics": "GET /api/v2/admin/generation/metrics",
      insights: "GET /api/v2/admin/generation/model-profiles",
    } as const satisfies Record<string, AdminV2DeclaredOperationId>;

    for (const [id, operationId] of Object.entries(firstScreen)) {
      const required = firstScreenPermissions([operationId]);
      expect(required.length, `${operationId} declares permissions`).toBeGreaterThan(0);
      expect(navItems.find((candidate) => candidate.id === id)?.read, id).toEqual({ allOf: required });
      expect(sectionIsPermitted(id, new Set<AdminPermissionKey>(required)), id).toBe(true);
      for (const missing of required) {
        const withoutOne = new Set<AdminPermissionKey>(required.filter((key) => key !== missing));
        expect(sectionIsPermitted(id, withoutOne), `${id} without ${missing}`).toBe(false);
      }
    }
  });

  it("uses the exact workspace read predicate for navigation and direct access", () => {
    const supportPermissions = new Set<AdminPermissionKey>([
      "dashboard.read", "case.read", "support.request.read", "customer.read", "billing.read", "compliance.read", "audit.read",
    ]);
    const groups = navGroupsForPermissions(supportPermissions, "support");
    const ids = groups.flatMap((group) => group.items.map((item) => item.id));

    expect(ids).toEqual([
      "dashboard", "cases", "users", "compliance", "support", "risk",
      "billing", "pricing", "audit-log",
    ]);
    // 同一个 read key 可能打开多个工作区；模式只改变分组顺序，不能擅自隐藏其中一个入口。
    expect(ids).toContain("pricing");
    expect(ids).toContain("audit-log");
    expect(sectionIsPermitted("pricing", supportPermissions)).toBe(true);
    expect(sectionIsPermitted("audit-log", supportPermissions)).toBe(true);
    for (const id of ids) expect(sectionIsPermitted(id, supportPermissions)).toBe(true);
    expect(sectionIsPermitted("content/official", new Set(["character.project.write"]))).toBe(false);
    expect(sectionIsPermitted("content/official", new Set([
      "character.project.read",
      "character.release.read",
      "character.performance.read",
    ]))).toBe(true);
    expect(sectionIsPermitted("growth/characters", new Set(["character.performance.read"]))).toBe(true);
    expect(sectionIsPermitted("content/official", new Set(["character.performance.read"]))).toBe(false);
    expect(sectionIsPermitted("content/production", new Set(["content.production.write"]))).toBe(false);
    expect(sectionIsPermitted("content/production", new Set(["creative.run.read"]))).toBe(true);
    expect(sectionIsPermitted("content/assets", new Set(["creative.asset.read"]))).toBe(true);
    expect(sectionIsPermitted("content/placements", new Set(["creative.placement.read"]))).toBe(true);
    expect(sectionIsPermitted("content/assets", new Set(["content.asset.read"]))).toBe(false);
  });

  // SPEC: 拒绝页要能说出差哪几个键——只报 read.allOf 里真实缺失的，不多不少。
  it("names exactly the read keys a denied workspace is missing", () => {
    const characters = navItems.find((item) => item.id === "content/official")!;
    expect(missingWorkspacePermissions(characters, new Set())).toEqual(characters.read.allOf);
    expect(missingWorkspacePermissions(characters, new Set(["character.project.read"])))
      .toEqual(["character.release.read", "character.performance.read"]);
    expect(missingWorkspacePermissions(characters, new Set(characters.read.allOf))).toEqual([]);
    // 持有无关的键不能让缺失列表变短。
    expect(missingWorkspacePermissions(characters, new Set(["audit.read"])))
      .toEqual(characters.read.allOf);
  });

  it("allows bootstrap when any exact workspace predicate is satisfied", () => {
    expect(canReadAnyWorkspace(new Set(["ops.incident.read"]))).toBe(true);
    expect(canReadAnyWorkspace(new Set(["character.performance.read"]))).toBe(true);
    expect(canReadAnyWorkspace(new Set(["character.project.read"]))).toBe(false);
    expect(canReadAnyWorkspace(new Set(["character.project.write"]))).toBe(false);
    expect(canReadAnyWorkspace(new Set())).toBe(false);
  });

  it("fails every workspace closed when any required read key is missing", () => {
    for (const workspace of navItems) {
      const complete = new Set(workspace.read.allOf);
      expect(sectionIsPermitted(workspace.id, complete), workspace.id).toBe(true);
      for (const missing of workspace.read.allOf) {
        const incomplete = new Set(workspace.read.allOf.filter((permission) => permission !== missing));
        expect(sectionIsPermitted(workspace.id, incomplete), `${workspace.id} without ${missing}`).toBe(false);
      }
    }
  });

  // SPEC: 工作模式回答“先看哪组”，权限回答“能去哪里”；模式不能成为第二套权限系统。
  // INVARIANT: 包括迁移期兼容工具在内，每个已授权目的地都必须进入所属工作区。
  it("keeps every permitted destination visible while work mode only reorders groups", () => {
    const permissions = new Set(ALL_SECTION_ITEMS.flatMap((item) => item.read.allOf));
    const expectedIds = new Set(ALL_SECTION_ITEMS.map((item) => item.id));

    for (const mode of ADMIN_WORK_MODES) {
      const groups = navGroupsForPermissions(permissions, mode);
      expect(new Set(groups.flatMap((group) => group.items.map((item) => item.id))), mode)
        .toEqual(expectedIds);
    }
    expect(navGroupsForPermissions(permissions, "support")[0]?.group).toBe("Today");
    expect(navGroupsForPermissions(permissions, "support")[1]?.group).toBe("Customers & Support");
    expect(navGroupsForPermissions(permissions, "platform_ops")[1]?.group).toBe("Platform Operations");

    expect(sectionIsPermitted("generation/dead-letter", permissions)).toBe(true);
    expect(at("ops/jobs?view=dead-letter")?.sectionId).toBe("generation/dead-letter");
    expect(navGroupsForPermissions(permissions, "support")
      .flatMap((group) => group.items.map((item) => item.id)))
      .toContain("generation/dead-letter");
  });

  it("keeps permitted low-frequency operations reachable in an unrelated work mode", () => {
    // generation.config.read 是两个诊断页首屏请求要的权限，所以它也是它们的入口权限。
    const permissions = new Set<AdminPermissionKey>(["generation.job.read", "ops.queue.read", "generation.config.read"]);
    const ids = navGroupsForPermissions(permissions, "support")
      .flatMap((group) => group.items.map((item) => item.id));

    expect(ids).toContain("generation/jobs");
    expect(ids).toContain("generation/dead-letter");
    expect(ids).toContain("generation/backends");
    expect(ids).toContain("generation/metrics");
    expect(ids).not.toContain("system/access");
  });

  it("maps v2 grant bundles to their canonical workspaces", () => {
    const creative = navGroupsForPermissions(new Set([
      "creative.run.read",
      "creative.run.write",
      "creative.run.review",
      "creative.asset.read",
      "creative.placement.read",
      "content.asset.read",
    ]), "creative_operator").flatMap((group) => group.items.map((item) => item.id));
    expect(creative).toEqual(expect.arrayContaining(["content/production", "content/assets", "content/placements"]));

    const growth = navGroupsForPermissions(new Set([
      "analytics.metric.read",
      "experiment.manage",
      "character.performance.read",
    ]), "growth_analyst").flatMap((group) => group.items.map((item) => item.id));
    expect(growth).toEqual(expect.arrayContaining(["analytics", "experiments"]));
    expect(growth).toContain("growth/characters");
    // Profile Diagnostics 读的是生成配置权威，不是增长指标：分析师看不到它，
    // 也不该看到——它以前在这里，点进去只会拿到 403。
    expect(growth).not.toContain("insights");
    expect(sectionIsPermitted("insights", new Set(["analytics.metric.read"]))).toBe(false);
    expect(sectionIsPermitted("growth/characters", new Set(["character.performance.read"]))).toBe(true);
    expect(growth).not.toContain("content/official");
  });

  it("derives conservative default modes from existing auth roles", () => {
    expect(defaultWorkModeForRole("moderator")).toBe("moderator");
    expect(defaultWorkModeForRole("support")).toBe("support");
    expect(defaultWorkModeForRole("ops")).toBe("platform_ops");
    expect(defaultWorkModeForRole("analyst")).toBe("growth_analyst");
    expect(defaultWorkModeForRole("admin")).toBe("admin");
  });
});
