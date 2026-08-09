import { describe, expect, it } from "vitest";
import type { AdminPermissionKey } from "@idream/shared/admin";
import {
  CHARACTER_WORKSPACE_WRITES,
  characterWorkspacePermissions,
} from "./character-workspace-permissions";

const granted = new Set<AdminPermissionKey>([
  "character.project.read",
  "character.release.read",
  "character.performance.read",
  "creative.run.read",
  ...Object.values(CHARACTER_WORKSPACE_WRITES),
]);

describe("Character workspace permission derivation", () => {
  it("grants every declared capability when the operator holds its permission", () => {
    const permissions = characterWorkspacePermissions(granted, false);

    expect(permissions.read).toBe(true);
    expect(permissions.readAssets).toBe(true);
    for (const capability of Object.keys(CHARACTER_WORKSPACE_WRITES)) {
      expect(permissions[capability as keyof typeof CHARACTER_WORKSPACE_WRITES], capability)
        .toBe(true);
    }
  });

  /**
   * SPEC: durable command 待决期间，**每一个**写能力都必须是 false。
   * INVARIANT: 断言遍历键集而不是逐条列出——曾经的写入锁是 8 条手写的 `&& !writesLocked`，
   *            漏掉的 manageVoiceDefaults 让「保存系统语音默认」在待决期间仍然可点，运营
   *            点下去拿到的是一个抛出的错误而不是禁用态。
   */
  it("locks every write capability while a durable command is pending", () => {
    const permissions = characterWorkspacePermissions(granted, true);

    for (const capability of Object.keys(CHARACTER_WORKSPACE_WRITES)) {
      expect(permissions[capability as keyof typeof CHARACTER_WORKSPACE_WRITES], capability)
        .toBe(false);
    }
    // 读不受写入锁影响：锁住的是写入，不是看见。
    expect(permissions.read).toBe(true);
    expect(permissions.readAssets).toBe(true);
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
});
