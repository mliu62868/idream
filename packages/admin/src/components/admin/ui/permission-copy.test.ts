import { describe, expect, it } from "vitest";
import { ADMIN_PERMISSION_KEYS } from "@idream/shared/admin/permissions";
import { hasAdminZh } from "@/components/admin/i18n";
import { PERMISSION_LABEL_KEYS, permissionLabel } from "./permission-copy";

describe("permissionLabel", () => {
  // SPEC: 表是全集。类型上已经拦住了，这里再从值的一侧确认一遍——
  // Record 的编译期检查挡不住有人写 `"" as AdminPermissionKey` 之类的空壳占位。
  it("names a capability for every permission the authority defines", () => {
    const unnamed = ADMIN_PERMISSION_KEYS.filter((key) => !permissionLabel(key)?.trim());

    expect(unnamed).toEqual([]);
  });

  it("describes what the permission lets an operator do, not the code itself", () => {
    expect(permissionLabel("billing.subscription.refund")).toBe("Refunding subscriptions");
    // INVARIANT: 能力名里不许出现权限码——那正是这个模块要消灭的东西。
    const leaked = ADMIN_PERMISSION_KEYS.filter((key) => permissionLabel(key).includes(key));
    expect(leaked).toEqual([]);
  });

  // SPEC: 调用点存在 `as AdminPermissionKey`，断言错了不能白屏。
  it("falls back to an honest phrase instead of crashing on an unmapped key", () => {
    const label = permissionLabel("not.a.real.permission" as never);

    expect(label).toBe("An admin capability");
    expect(label).not.toContain("not.a.real.permission");
  });

  it("has a Chinese translation for every capability name", () => {
    expect(PERMISSION_LABEL_KEYS.filter((key) => !hasAdminZh(key))).toEqual([]);
  });
});
