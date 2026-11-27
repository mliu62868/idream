import { describe, expect, it } from "vitest";
import {
  ADMIN_GRANT_BUNDLES,
  adminGrantBundlePermissionIsCharacterScoped,
  adminGrantBundleRequiresCharacterScope,
  ADMIN_PERMISSION_KEYS,
  ADMIN_ROLE_PERMISSION_SCOPES,
  ADMIN_ROLE_PERMISSIONS,
  adminPermissionKeySchema,
  expandAdminGrantBundles,
  resolveAdminPermissions,
} from "./permissions";
import { ADMIN_V2_API_OPERATIONS } from "./api-manifest";

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

  it("expands work-mode grant bundles with only their intended execution rights", () => {
    expect(expandAdminGrantBundles(["character_producer"])).toEqual(
      new Set(ADMIN_GRANT_BUNDLES.character_producer.permissions),
    );
    expect(expandAdminGrantBundles(["creative_operator"])).toContain("creative.placement.publish");
    expect(expandAdminGrantBundles(["growth_operator"])).not.toContain("analytics.metric.export");
  });

  // SPEC: 创作者能写角色、不能发布；发布运营能发布、选槽位（project.write）和改精选。
  it("separates the optional creator and publisher bundles without changing the producer", () => {
    const creator = expandAdminGrantBundles(["character_creator"]);
    expect(creator).toContain("character.project.write");
    expect(creator).not.toContain("character.release.publish");
    const publisher = expandAdminGrantBundles(["character_publisher"]);
    expect(publisher).toContain("character.release.publish");
    expect(publisher).toContain("character.project.write");
    expect(publisher).toContain("content.featured.write");
    expect([...expandAdminGrantBundles(["character_producer"])].sort()).toEqual([
      "character.performance.read",
      "character.project.read",
      "character.project.write",
      "character.release.publish",
      "character.release.read",
      "content.official.write",
      "creative.run.read",
      "creative.run.write",
    ]);
    for (const bundle of ["character_producer", "character_creator", "character_publisher"] as const) {
      expect(adminGrantBundleRequiresCharacterScope(bundle)).toBe(true);
    }
    expect(adminGrantBundleRequiresCharacterScope("growth_operator")).toBe(false);
  });

  // SPEC: 每个角色级权限包都要能独立走完本职链路，且只在被分配的角色上生效。
  it("lets every Character bundle finish its own chain without leaving the assigned Characters", () => {
    const allowed = (bundle: "character_producer" | "character_creator" | "character_publisher", operationId: string) => {
      const operation = ADMIN_V2_API_OPERATIONS.find(({ id }) => id === operationId);
      if (!operation || operation.authorization.kind !== "all_of") throw new Error(`Expected all_of ${operationId}`);
      const granted = expandAdminGrantBundles([bundle]);
      return operation.authorization.permissions.every((permission) => granted.has(permission));
    };
    const imageLibrary = "GET /api/v2/admin/characters/:id/image-sources";
    const createRun = "POST /api/v2/admin/creative/runs";
    const uploadImage = "POST /api/v2/admin/characters/:id/image-sources";
    const visualIdentity = "POST /api/v2/admin/content/characters/:id/visual-profiles";
    const referenceSet = "POST /api/v2/admin/characters/:id/reference-sets";
    const archiveLook = "PATCH /api/v2/admin/characters/:id/looks/:lookId";
    const featured = "PUT /api/v2/admin/content/featured";

    for (const operation of [imageLibrary, createRun, uploadImage, visualIdentity, referenceSet, archiveLook]) {
      expect(allowed("character_creator", operation)).toBe(true);
      expect(allowed("character_producer", operation)).toBe(true);
    }
    expect(expandAdminGrantBundles(["character_creator"])).not.toContain("character.release.publish");
    expect(expandAdminGrantBundles(["character_producer"])).toContain("character.release.publish");
    for (const permission of expandAdminGrantBundles(["character_creator"])) {
      expect(expandAdminGrantBundles(["character_producer"])).toContain(permission);
    }

    expect(allowed("character_publisher", imageLibrary)).toBe(true);
    expect(allowed("character_publisher", featured)).toBe(true);
    expect(allowed("character_publisher", createRun)).toBe(false);
    expect(allowed("character_publisher", uploadImage)).toBe(false);

    // Every new right is Character-scoped; only the publisher's storefront-wide Featured rights are global.
    for (const bundle of ["character_producer", "character_creator"] as const) {
      for (const permission of ADMIN_GRANT_BUNDLES[bundle].permissions) {
        expect(adminGrantBundlePermissionIsCharacterScoped(bundle, permission)).toBe(true);
      }
    }
    expect(adminGrantBundlePermissionIsCharacterScoped("character_publisher", "creative.run.read")).toBe(true);
    expect(adminGrantBundlePermissionIsCharacterScoped("character_publisher", "content.featured.write")).toBe(false);
    expect(adminGrantBundlePermissionIsCharacterScoped("character_publisher", "content.read")).toBe(false);
    expect(adminGrantBundlePermissionIsCharacterScoped("creative_operator", "creative.run.write")).toBe(false);
  });

  // SPEC: 精选写权限是 content.featured.write：增长运营能用，且不因此拿到下架权或展示位发布权。
  it("gives the growth operator Featured curation without takedown rights", () => {
    const featured = ADMIN_V2_API_OPERATIONS.find(({ id }) => id === "PUT /api/v2/admin/content/featured");
    expect(featured?.authorization).toEqual({ kind: "all_of", permissions: ["content.featured.write"] });
    const growth = expandAdminGrantBundles(["growth_operator"]);
    expect(growth).toContain("content.featured.write");
    expect(growth).not.toContain("content.placement.write");
    expect(growth).toContain("content.read");
    expect(growth).not.toContain("content.takedown.write");
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
