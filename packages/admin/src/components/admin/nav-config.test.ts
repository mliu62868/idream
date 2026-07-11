import { describe, expect, it } from "vitest";
import {
  ADMIN_WORKSPACES,
  adminEntryRedirect,
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
  "approvals", "audit-log",
];

describe("admin navigation information architecture", () => {
  it("publishes every decision workspace exactly once inside the seven workspaces", () => {
    expect(navItems.map((item) => item.id).sort()).toEqual([...NAV_IDS].sort());
    expect(new Set(navItems.map((item) => item.id)).size).toBe(NAV_IDS.length);
    expect(new Set(navItems.map((item) => item.group))).toEqual(new Set(ADMIN_WORKSPACES));
  });

  it("publishes canonical workspace URLs while retaining each legacy URL", () => {
    for (const item of navItems) {
      expect(item.href).toMatch(/^\/admin\/(today|characters|creative|cases|customers|customer-ops|growth|ops|system)/);
      expect(item.legacyHref).toBe(item.id === "dashboard" ? "/admin" : `/admin/${item.id}`);
    }
  });

  it("maps canonical routes and query-backed saved views onto domain workspaces", () => {
    expect(parseAdminPath("today")).toEqual({ sectionId: "dashboard", view: { kind: "list" } });
    expect(parseAdminPath("characters/new")).toEqual({ sectionId: "content/official", view: { kind: "new" } });
    expect(parseAdminPath("characters/char-1")).toEqual({ sectionId: "content/official", view: { kind: "detail", id: "char-1" } });
    expect(parseAdminPath("cases?view=overdue").sectionId).toBe("cases");
    expect(parseAdminPath("ops/incidents").sectionId).toBe("ops/incidents");
    expect(parseAdminPath("growth/offers?view=promo").sectionId).toBe("promo");
    expect(parseAdminPath("ops/recipes?view=presets").sectionId).toBe("generation/presets");
    expect(parseAdminPath("growth/merchandising?view=announcements").sectionId).toBe("announcements");
  });

  it("redirects retired raw queues into their authoritative domain root", () => {
    for (const id of NAV_IDS) expect(normalizeSection(id)).toBe(id);
    expect(normalizeSection("moderation")).toBe("cases");
    expect(normalizeSection("support")).toBe("cases");
    expect(normalizeSection("risk")).toBe("cases");
    expect(normalizeSection("generation/models")).toBe("generation/config");
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
  it("never exposes a section without one of its effective permissions", () => {
    const supportPermissions = new Set([
      "dashboard.read", "case.read", "support.request.read", "user.read", "billing.read", "audit.read",
    ]);
    const groups = navGroupsForPermissions(supportPermissions, "support");
    const ids = groups.flatMap((group) => group.items.map((item) => item.id));

    expect(ids).toContain("cases");
    expect(ids).toContain("users");
    expect(ids).not.toContain("generation/config");
    expect(ids).not.toContain("pricing");
    for (const id of ids) expect(sectionIsPermitted(id, supportPermissions)).toBe(true);
  });

  it("uses work mode only to reorder permitted workspaces, never to grant access", () => {
    const permissions = new Set(navItems.flatMap((item) => item.permissions));
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

  it("derives conservative default modes from existing auth roles", () => {
    expect(defaultWorkModeForRole("moderator")).toBe("moderator");
    expect(defaultWorkModeForRole("support")).toBe("support");
    expect(defaultWorkModeForRole("ops")).toBe("platform_ops");
    expect(defaultWorkModeForRole("analyst")).toBe("growth_analyst");
    expect(defaultWorkModeForRole("admin")).toBe("admin");
  });
});
