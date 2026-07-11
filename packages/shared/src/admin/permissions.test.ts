import { describe, expect, it } from "vitest";
import {
  ADMIN_GRANT_BUNDLES,
  ADMIN_PERMISSION_KEYS,
  ADMIN_ROLE_PERMISSION_SCOPES,
  ADMIN_ROLE_PERMISSIONS,
  adminPermissionKeySchema,
  expandAdminGrantBundles,
  resolveAdminPermissions,
} from "./permissions";

describe("Admin v2 permission contract", () => {
  it("keeps existing roles and applies the v2 permission matrix", () => {
    expect(Object.keys(ADMIN_ROLE_PERMISSIONS).sort()).toEqual([
      "admin",
      "analyst",
      "moderator",
      "ops",
      "support",
      "user",
    ]);
    expect(ADMIN_ROLE_PERMISSIONS.admin).toContain("character.release.publish");
    expect(ADMIN_ROLE_PERMISSIONS.moderator).toContain("case.decide");
    expect(ADMIN_ROLE_PERMISSIONS.support).toContain("customer.read");
    expect(ADMIN_ROLE_PERMISSIONS.ops).toContain("ops.incident.manage");
    expect(ADMIN_ROLE_PERMISSIONS.analyst).toContain("analytics.metric.export");
    expect(ADMIN_ROLE_PERMISSIONS.support).not.toContain("character.release.publish");
    expect(ADMIN_ROLE_PERMISSIONS.admin).toEqual(ADMIN_PERMISSION_KEYS);
    expect(new Set(ADMIN_PERMISSION_KEYS).size).toBe(ADMIN_PERMISSION_KEYS.length);
    expect(ADMIN_ROLE_PERMISSION_SCOPES.support?.["case.decide"]).toBe("support_case_subtypes");
    expect(ADMIN_ROLE_PERMISSION_SCOPES.ops?.["analytics.metric.read"]).toBe("technical_metrics");
  });

  it("publishes only known permission keys", () => {
    expect(adminPermissionKeySchema.safeParse("creative.run.review").success).toBe(true);
    expect(adminPermissionKeySchema.safeParse("creative.run.delete_everything").success).toBe(false);
  });

  it("expands work-mode grant bundles without smuggling publish or export rights", () => {
    expect(expandAdminGrantBundles(["character_producer"])).toEqual(
      new Set(ADMIN_GRANT_BUNDLES.character_producer.permissions),
    );
    expect(expandAdminGrantBundles(["creative_operator"])).not.toContain("creative.placement.publish");
    expect(expandAdminGrantBundles(["growth_operator"])).not.toContain("analytics.metric.export");
  });

  it("resolves role plus bundles plus grant/revoke overrides deterministically", () => {
    const effective = resolveAdminPermissions({
      role: "support",
      grantBundles: ["growth_operator"],
      overrides: [
        { permissionKey: "analytics.metric.export", effect: "grant" },
        { permissionKey: "customer.read", effect: "revoke" },
        { permissionKey: "unknown.permission", effect: "grant" },
      ],
    });

    expect(effective).toContain("analytics.metric.read");
    expect(effective).toContain("analytics.metric.export");
    expect(effective).not.toContain("customer.read");
    expect([...effective]).not.toContain("unknown.permission");
  });
});
