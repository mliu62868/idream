import { describe, expect, it } from "vitest";
import { resolveAdminPermissions, type AdminPermissionKey } from "@idream/shared/admin";
import {
  CHARACTER_WORKSPACE_WRITES,
  characterWorkspacePermissions,
} from "./character-workspace-permissions";

const granted = new Set<AdminPermissionKey>([
  "character.project.read",
  "character.release.read",
  "character.performance.read",
  "creative.asset.read",
  "creative.run.read",
  ...Object.values(CHARACTER_WORKSPACE_WRITES),
]);

describe("Character workspace permission derivation", () => {
  it("grants every declared capability when the operator holds its permission", () => {
    const permissions = characterWorkspacePermissions(granted, false);

    expect(permissions.read).toBe(true);
    expect(permissions.readImages).toBe(true);
    expect(permissions.readVideos).toBe(true);
    expect(permissions.readProduction).toBe(true);
    for (const capability of Object.keys(CHARACTER_WORKSPACE_WRITES)) {
      expect(permissions[capability as keyof typeof CHARACTER_WORKSPACE_WRITES], capability)
        .toBe(true);
    }
  });

  /**
   * SPEC: durable command 待决期间，**每一个**写能力都必须是 false。
   * INVARIANT: 断言遍历键集而不是逐条列出——曾经的写入锁是 8 条手写的 `&& !writesLocked`，
   *            漏掉的一项让写按钮在待决期间仍然可点，运营点下去拿到的是一个抛出的错误而不是禁用态。
   */
  it("locks every write capability while a durable command is pending", () => {
    const permissions = characterWorkspacePermissions(granted, true);

    for (const capability of Object.keys(CHARACTER_WORKSPACE_WRITES)) {
      expect(permissions[capability as keyof typeof CHARACTER_WORKSPACE_WRITES], capability)
        .toBe(false);
    }
    // 读不受写入锁影响：锁住的是写入，不是看见。
    expect(permissions.read).toBe(true);
    expect(permissions.readImages).toBe(true);
    expect(permissions.readVideos).toBe(true);
    expect(permissions.readProduction).toBe(true);
  });

  // SPEC: 全平台默认声音不是角色级写入，角色工作区不再派生它（编辑入口在平台配置页）。
  it("does not derive a platform-wide voice-defaults capability for one Character", () => {
    const permissions = characterWorkspacePermissions(new Set([...granted, "generation.config.write"]), false);

    expect(Object.values(CHARACTER_WORKSPACE_WRITES)).not.toContain("generation.config.write");
    expect(permissions).not.toHaveProperty("manageVoiceDefaults");
  });

  it("denies the workspace read unless every permission the read operation declares is held", () => {
    for (const missing of [
      "character.project.read",
      "character.release.read",
      "character.performance.read",
    ] as const) {
      const partial = new Set(granted);
      partial.delete(missing);
      expect(characterWorkspacePermissions(partial, false).read, missing).toBe(false);
    }
  });

  it.each([
    { revoked: "creative.run.read", readImages: false, readVideos: true },
    { revoked: "creative.asset.read", readImages: true, readVideos: false },
  ] as const)("respects an effective $revoked revoke without inferring another grant", ({ revoked, readImages, readVideos }) => {
    const effective = resolveAdminPermissions({
      role: "ops",
      grantBundles: ["character_producer", "creative_operator"],
      overrides: [{ permissionKey: revoked, effect: "revoke" }],
    });
    const permissions = characterWorkspacePermissions(effective, false);

    expect(permissions.read).toBe(true);
    expect(permissions.readImages).toBe(readImages);
    expect(permissions.readVideos).toBe(readVideos);
  });

  // SPEC: 每个角色级权限包单独授予时，图片 tab 的本职动作都可用；发布运营看不到生图。
  it.each([
    { bundle: "character_creator", createAssets: true, writeVisual: true, publishRelease: false, manageFeatured: false },
    { bundle: "character_producer", createAssets: true, writeVisual: true, publishRelease: true, manageFeatured: false },
    { bundle: "character_publisher", createAssets: false, writeVisual: false, publishRelease: true, manageFeatured: true },
  ] as const)("lets $bundle alone run its Images tab chain", ({ bundle, ...expected }) => {
    const permissions = characterWorkspacePermissions(
      resolveAdminPermissions({ role: "user", grantBundles: [bundle] }),
      false,
    );

    expect(permissions.read).toBe(true);
    expect(permissions.readImages).toBe(true);
    expect(permissions.readProduction).toBe(true);
    // Choosing a display slot needs project authorship, which every Character bundle keeps.
    expect(permissions.writeProject).toBe(true);
    expect(permissions).toMatchObject(expected);
  });
});
