import {
  ADMIN_GRANT_BUNDLES,
  ADMIN_ROLE_PERMISSIONS,
  ADMIN_ROLE_PERMISSION_SCOPES,
  expandAdminGrantBundles,
  isAdminPermissionKey,
  type AdminGrantBundleKey,
  type AdminPermissionKey,
} from "@idream/shared";
import type { ActorRole } from "@/server/lib/auth";
import { Errors } from "@/server/lib/errors";

export type PermissionKey = AdminPermissionKey;

// Keep the legacy main-server export while making shared the single source of truth.
export const ROLE_PERMISSIONS: Record<ActorRole, readonly PermissionKey[]> = ADMIN_ROLE_PERMISSIONS;
export { ADMIN_GRANT_BUNDLES, ADMIN_ROLE_PERMISSION_SCOPES };
export type { AdminGrantBundleKey };

export function resolvePermissions(role: ActorRole | undefined): Set<PermissionKey> {
  return new Set(role ? ROLE_PERMISSIONS[role] : []);
}

export function isPermissionKey(key: string): key is PermissionKey {
  return isAdminPermissionKey(key);
}

// SPEC: 用户级权限覆盖 —— 最终 key 集合 = roleKeys ∪ granted − revoked。
// INVARIANTS: 纯函数，不碰 DB；未知 key 的 override 忽略；revoke 可移除 role 自带的 key。
export function applyOverrides(
  base: Set<PermissionKey>,
  overrides: ReadonlyArray<{ permissionKey: string; effect: string }>,
): Set<PermissionKey> {
  const out = new Set(base);
  for (const override of overrides) {
    if (!isPermissionKey(override.permissionKey)) continue;
    if (override.effect === "grant") out.add(override.permissionKey);
  }
  // A persisted revoke is an explicit deny. Apply it after every grant so the
  // result is the documented `role ∪ grants − revokes` set and never depends
  // on PostgreSQL row order when historical grant and revoke rows coexist.
  for (const override of overrides) {
    if (!isPermissionKey(override.permissionKey)) continue;
    if (override.effect === "revoke") out.delete(override.permissionKey);
  }
  return out;
}

export function expandGrantBundles(bundleKeys: readonly AdminGrantBundleKey[]): Set<PermissionKey> {
  return expandAdminGrantBundles(bundleKeys);
}

export function hasPermission(role: ActorRole | undefined, key: PermissionKey): boolean {
  return resolvePermissions(role).has(key);
}

export function assertPermission(role: ActorRole | undefined, key: PermissionKey): void {
  if (!hasPermission(role, key)) {
    throw Errors.forbidden("Missing admin permission", { permission: key });
  }
}
