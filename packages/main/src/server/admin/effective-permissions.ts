import type { ActorRole } from "@/server/lib/auth";
import { prisma } from "@/server/lib/db";
import { applyOverrides, resolvePermissions, type PermissionKey } from "./permissions";
import { expandGrantBundles, type AdminGrantBundleKey } from "./permissions";
import { ADMIN_GRANT_BUNDLES } from "@idream/shared";

function isGrantBundleKey(value: string): value is AdminGrantBundleKey {
  return Object.hasOwn(ADMIN_GRANT_BUNDLES, value);
}

// SPEC: 解析一个 actor 的有效 permission key 集合 = role 映射 ∪ grant − revoke（用户级覆盖）。
// INTENT: 权限判定的单一入口，page 初始门与每个 admin API 都走它，避免 role-only 与 override 两套逻辑漂移。
// INVARIANTS: 无 userId 时退化为纯 role 集合；只读，不写。
export async function effectivePermissions(
  userId: string | undefined,
  role: ActorRole | undefined,
): Promise<Set<PermissionKey>> {
  const base = resolvePermissions(role);
  if (!userId) return base;
  const [overrides, bundleRows] = await Promise.all([
    prisma.adminUserPermission.findMany({ where: { userId } }),
    prisma.adminUserGrantBundle.findMany({
      where: {
        userId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { bundleKey: true },
    }),
  ]);
  for (const permission of expandGrantBundles(
    bundleRows.map((row) => row.bundleKey).filter(isGrantBundleKey),
  )) base.add(permission);
  return applyOverrides(base, overrides);
}

export async function userHasPermission(
  userId: string | undefined,
  role: ActorRole | undefined,
  key: PermissionKey,
): Promise<boolean> {
  return (await effectivePermissions(userId, role)).has(key);
}

export async function effectiveCharacterIdsForPermission(
  userId: string,
  role: ActorRole | undefined,
  key: PermissionKey,
): Promise<ReadonlySet<string> | null> {
  const [overrides, bundleRows] = await Promise.all([
    prisma.adminUserPermission.findMany({ where: { userId, permissionKey: key } }),
    prisma.adminUserGrantBundle.findMany({
      where: {
        userId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { bundleKey: true, scope: true },
    }),
  ]);
  if (overrides.some((row) => row.effect === "revoke")) return new Set();
  if (resolvePermissions(role).has(key) || overrides.some((row) => row.effect === "grant")) return null;
  const ids = new Set<string>();
  for (const row of bundleRows) {
    if (
      !isGrantBundleKey(row.bundleKey) ||
      !new Set<string>(ADMIN_GRANT_BUNDLES[row.bundleKey].permissions).has(key)
    ) continue;
    const scope = row.scope && typeof row.scope === "object" && !Array.isArray(row.scope)
      ? row.scope as Record<string, unknown>
      : {};
    const characterIds = Array.isArray(scope.characterIds)
      ? scope.characterIds.filter((value): value is string => typeof value === "string")
      : [];
    characterIds.forEach((id) => ids.add(id));
  }
  return ids;
}
