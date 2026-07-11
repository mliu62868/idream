import { describe, expect, it } from "vitest";
import { ADMIN_GRANT_BUNDLES, ADMIN_ROLE_PERMISSIONS } from "@idream/shared";
import {
  ROLE_PERMISSIONS,
  applyOverrides,
  expandGrantBundles,
  isPermissionKey,
  resolvePermissions,
} from "./permissions";

describe("main admin permission adapter", () => {
  it("uses the shared v2 role matrix without changing existing auth roles", () => {
    expect(ROLE_PERMISSIONS).toBe(ADMIN_ROLE_PERMISSIONS);
    expect(resolvePermissions("admin")).toContain("character.release.publish");
    expect(resolvePermissions("support")).toContain("case.read");
    expect(resolvePermissions("ops")).toContain("ops.incident.manage");
    expect(resolvePermissions("analyst")).toContain("analytics.metric.export");
    expect(resolvePermissions(undefined)).toEqual(new Set());
  });

  it("applies user grants and revokes only for shared contract keys", () => {
    const effective = applyOverrides(resolvePermissions("support"), [
      { permissionKey: "character.project.read", effect: "grant" },
      { permissionKey: "customer.read", effect: "revoke" },
      { permissionKey: "not.real", effect: "grant" },
    ]);
    expect(effective).toContain("character.project.read");
    expect(effective).not.toContain("customer.read");
    expect(isPermissionKey("not.real")).toBe(false);
  });

  it("expands bundles but keeps high-risk publish/export permissions separate", () => {
    expect(expandGrantBundles(["character_producer"])).toEqual(
      new Set(ADMIN_GRANT_BUNDLES.character_producer.permissions),
    );
    expect(expandGrantBundles(["character_producer"])).not.toContain("character.release.publish");
  });
});
