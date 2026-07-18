import { describe, expect, it } from "vitest";
import {
  ADMIN_V2_WORKSPACE_ACCESS,
  type AdminV2WorkspaceAccessKey,
} from "@idream/shared/admin/workspace-access";
import type { AdminPermissionKey } from "@idream/shared/admin/permissions";
import {
  ADMIN_WORKSPACES,
  adminEntryRedirect,
  canReadAnyWorkspace,
  defaultWorkModeForRole,
  navGroupsForPermissions,
  navItems,
  normalizeSection,
  parseAdminPath,
  sectionIsPermitted,
  type WorkMode,
} from "./nav-config";

const NAV_IDS = [
  "dashboard", "generation/jobs", "generation/config", "generation/recipes", "generation/presets", "generation/dead-letter",
  "ops/providers", "generation/backends", "generation/workflows", "generation/metrics",
  "content/production", "content/assets", "content/placements", "content",
  "content/official", "content/templates", "content/tags", "content/review-queue",
  "cms", "cases", "chat", "users", "billing", "pricing", "promo",
  "announcements", "analytics", "insights", "experiments", "compliance", "ops/incidents",
  "approvals", "system/access", "audit-log",
];
const TARGET_ONLY_NAV_IDS = ["growth/characters"];

describe("admin navigation information architecture", () => {
  it("publishes every decision workspace exactly once inside the seven workspaces", () => {
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
    expect(navItems.filter((item) => item.legacyHref !== null)).toHaveLength(34);
  });

  it("maps canonical routes and query-backed saved views onto domain workspaces", () => {
    expect(parseAdminPath("today")).toEqual({ sectionId: "dashboard", view: { kind: "list" } });
    expect(parseAdminPath("characters/new")).toEqual({ sectionId: "content/official", view: { kind: "new" } });
    expect(parseAdminPath("characters/releases")).toEqual({ sectionId: "content/official", view: { kind: "list" } });
    expect(parseAdminPath("characters/calendar")).toEqual({ sectionId: "content/official", view: { kind: "list" } });
    expect(parseAdminPath("characters/review")).toEqual({ sectionId: "content/review-queue", view: { kind: "list" } });
    expect(parseAdminPath("characters/starters")).toEqual({ sectionId: "content/templates", view: { kind: "list" } });
    expect(parseAdminPath("characters/taxonomy")).toEqual({ sectionId: "content/tags", view: { kind: "list" } });
    expect(parseAdminPath("characters/char-1")).toEqual({ sectionId: "content/official", view: { kind: "detail", id: "char-1" } });
    expect(parseAdminPath("cases?view=overdue").sectionId).toBe("cases");
    expect(parseAdminPath("cases/case-1")).toEqual({ sectionId: "cases", view: { kind: "detail", id: "case-1" } });
    expect(parseAdminPath("customers/customer-1")).toEqual({ sectionId: "users", view: { kind: "detail", id: "customer-1" } });
    expect(parseAdminPath("ops/incidents").sectionId).toBe("ops/incidents");
    expect(parseAdminPath("ops/incidents/incident-1")).toEqual({ sectionId: "ops/incidents", view: { kind: "detail", id: "incident-1" } });
    expect(parseAdminPath("characters/char-1?tab=release&releaseId=release-1")).toEqual({ sectionId: "content/official", view: { kind: "detail", id: "char-1" } });
    expect(parseAdminPath("system/audit?commandId=command-1")).toEqual({ sectionId: "audit-log", view: { kind: "list" } });
    expect(parseAdminPath("growth/offers?view=promo").sectionId).toBe("promo");
    expect(parseAdminPath("growth/characters").sectionId).toBe("growth/characters");
    expect(parseAdminPath("ops/recipes?view=presets").sectionId).toBe("generation/presets");
    expect(parseAdminPath("growth/merchandising?view=announcements").sectionId).toBe("announcements");
  });

  it("retains compatibility routes until their Case commands reach parity", () => {
    for (const id of NAV_IDS) expect(normalizeSection(id)).toBe(id);
    expect(normalizeSection("moderation")).toBe("moderation");
    expect(normalizeSection("support")).toBe("support");
    expect(normalizeSection("risk")).toBe("risk");
    expect(normalizeSection("generation/models")).toBe("generation/config");
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
    const expected = {
      dashboard: "today",
      "content/official": "character_workspace",
      "growth/characters": "character_performance",
      "content/production": "creative_runs",
      users: "customers",
      cases: "cases",
      experiments: "experiments",
      "ops/incidents": "incidents",
      "generation/jobs": "generation_jobs",
      analytics: "metrics",
      insights: "metrics",
    } as const satisfies Record<string, AdminV2WorkspaceAccessKey>;

    for (const [id, workspace] of Object.entries(expected)) {
      const item = navItems.find((candidate) => candidate.id === id);
      expect(item?.apiWorkspace, id).toBe(workspace);
      expect(item?.read, id).toBe(ADMIN_V2_WORKSPACE_ACCESS[workspace]);

      const complete = new Set<AdminPermissionKey>(ADMIN_V2_WORKSPACE_ACCESS[workspace].allOf);
      expect(sectionIsPermitted(id, complete), `${id} complete`).toBe(true);
      for (const missing of ADMIN_V2_WORKSPACE_ACCESS[workspace].allOf) {
        const incomplete = new Set<AdminPermissionKey>(
          ADMIN_V2_WORKSPACE_ACCESS[workspace].allOf.filter((key) => key !== missing),
        );
        expect(sectionIsPermitted(id, incomplete), `${id} deep link without ${missing}`).toBe(false);
      }
    }
  });

  it("uses the exact workspace read predicate for navigation and direct access", () => {
    const supportPermissions = new Set<AdminPermissionKey>([
      "dashboard.read", "case.read", "support.request.read", "customer.read", "billing.read", "audit.read",
    ]);
    const groups = navGroupsForPermissions(supportPermissions, "support");
    const ids = groups.flatMap((group) => group.items.map((item) => item.id));

    expect(ids).toContain("cases");
    expect(ids).toContain("users");
    expect(ids).not.toContain("generation/config");
    expect(ids).toContain("pricing");
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

  it("uses work mode only to reorder permitted workspaces, never to grant access", () => {
    const permissions = new Set(navItems.flatMap((item) => item.read.allOf));
    const expectedIds = new Set(navItems.map((item) => item.id));
    const modes: WorkMode[] = [
      "character_producer", "creative_operator", "platform_ops", "support",
      "moderator", "growth_analyst", "admin",
    ];

    for (const mode of modes) {
      const groups = navGroupsForPermissions(permissions, mode);
      expect(new Set(groups.flatMap((group) => group.items.map((item) => item.id)))).toEqual(expectedIds);
    }
    expect(navGroupsForPermissions(permissions, "support")[0]?.group).toBe("Today");
    expect(navGroupsForPermissions(permissions, "support")[1]?.group).toBe("Customer Operations");
    expect(navGroupsForPermissions(permissions, "platform_ops")[1]?.group).toBe("Platform Operations");
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
    expect(growth).toEqual(expect.arrayContaining(["analytics", "insights", "experiments", "growth/characters"]));
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
