import type { ActorRole } from "@/server/lib/auth";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { applyOverrides, resolvePermissions, type PermissionKey } from "./permissions";
import { expandGrantBundles, type AdminGrantBundleKey } from "./permissions";
import {
  ADMIN_GRANT_BUNDLES,
  ADMIN_ROLE_PERMISSION_SCOPES,
  adminGrantBundlePermissionIsCharacterScoped,
  adminGrantBundleRequiresCharacterScope,
  type AdminPermissionScope,
} from "@idream/shared";

function isGrantBundleKey(value: string): value is AdminGrantBundleKey {
  return Object.hasOwn(ADMIN_GRANT_BUNDLES, value);
}

type PermissionDb = Pick<Prisma.TransactionClient, "adminUserPermission" | "adminUserGrantBundle">;

/**
 * SPEC: canonical key -> legacy key it is still derived from (unless the canonical key is revoked).
 * INVARIANT: `effectivePermissions` and the character-scope resolver share this table, so a
 *            derived key is scoped exactly like the key it comes from.
 */
const PERMISSION_COMPATIBILITY: ReadonlyArray<readonly [legacy: PermissionKey, canonical: PermissionKey]> = [
  ["content.asset.read", "creative.asset.read"],
  ["content.asset.read", "creative.placement.read"],
  ["content.placement.write", "creative.placement.publish"],
];

// SPEC: 解析一个 actor 的有效 permission key 集合 = role 映射 ∪ grant − revoke（用户级覆盖）。
// INTENT: 权限判定的单一入口，page 初始门与每个 admin API 都走它，避免 role-only 与 override 两套逻辑漂移。
// INVARIANTS: 无 userId 时退化为纯 role 集合；只读，不写。
export async function effectivePermissions(
  userId: string | undefined,
  role: ActorRole | undefined,
  db: PermissionDb = prisma,
): Promise<Set<PermissionKey>> {
  const base = resolvePermissions(role);
  if (!userId) return base;
  const overrides = await db.adminUserPermission.findMany({ where: { userId } });
  const bundleRows = await db.adminUserGrantBundle.findMany({
    where: {
      userId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { bundleKey: true },
  });
  for (const permission of expandGrantBundles(
    bundleRows.map((row) => row.bundleKey).filter(isGrantBundleKey),
  )) base.add(permission);
  const resolved = applyOverrides(base, overrides);
  const explicitlyRevoked = new Set(overrides.filter((row) => row.effect === "revoke").map((row) => row.permissionKey));
  for (const [legacy, canonical] of PERMISSION_COMPATIBILITY) {
    if (resolved.has(legacy) && !explicitlyRevoked.has(canonical)) resolved.add(canonical);
  }
  return resolved;
}

export async function userHasPermission(
  userId: string | undefined,
  role: ActorRole | undefined,
  key: PermissionKey,
): Promise<boolean> {
  return (await effectivePermissions(userId, role)).has(key);
}

// A scoped producer can edit assigned Characters, but cannot grant itself a
// new Character by creating one outside that scope.
export async function canCreateCharacterProjects(
  userId: string | undefined,
  role: ActorRole | undefined,
): Promise<boolean> {
  if (!userId || !await userHasPermission(userId, role, "character.project.write")) return false;
  return await effectiveCharacterIdsForPermission(userId, role, "character.project.write") === null;
}

export async function effectivePermissionScope(
  userId: string,
  role: ActorRole | undefined,
  key: PermissionKey,
  db: PermissionDb = prisma,
): Promise<AdminPermissionScope | null> {
  const overrides = await db.adminUserPermission.findMany({ where: { userId, permissionKey: key } });
  const bundleRows = await db.adminUserGrantBundle.findMany({
    where: {
      userId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { bundleKey: true },
  });
  if (overrides.some((row) => row.effect === "grant")) return null;
  for (const row of bundleRows) {
    if (!isGrantBundleKey(row.bundleKey)) continue;
    const bundle = ADMIN_GRANT_BUNDLES[row.bundleKey];
    if (!new Set<string>(bundle.permissions).has(key)) continue;
    return Object.hasOwn(bundle.scopes, key)
      ? bundle.scopes[key as keyof typeof bundle.scopes] as AdminPermissionScope
      : null;
  }
  return role ? ADMIN_ROLE_PERMISSION_SCOPES[role]?.[key] ?? null : null;
}

export type CharacterScope = ReadonlySet<string> | null;

/**
 * SPEC: 每个权限的角色范围：null = 全局；Set = 只在这些角色上生效（可能为空）。
 * INVARIANTS:
 *   - role、用户级 grant、非角色级包、角色级包的 `globalPermissions` 任何一个来源授予了它，都是全局。
 *   - 用户级 revoke 是显式拒绝，范围为空。
 *   - 由旧键兼容派生的键沿用旧键的范围。
 *   - 历史上写错了 characterIds 的非角色级包行只会收窄，不会放大；角色级包缺 scope 时关闭。
 */
export async function effectiveCharacterScopes(
  userId: string,
  role: ActorRole | undefined,
  keys: readonly PermissionKey[],
): Promise<ReadonlyMap<PermissionKey, CharacterScope>> {
  const wanted = [...new Set(keys)];
  const result = new Map<PermissionKey, CharacterScope>();
  if (wanted.length === 0) return result;
  const legacyFor = new Map<PermissionKey, PermissionKey>(
    PERMISSION_COMPATIBILITY.map(([legacy, canonical]) => [canonical, legacy]),
  );
  const lookupKeys = [...new Set([
    ...wanted,
    ...wanted.flatMap((key) => legacyFor.get(key) ?? []),
  ])];
  const [overrides, bundleRows] = await Promise.all([
    prisma.adminUserPermission.findMany({ where: { userId, permissionKey: { in: lookupKeys } } }),
    prisma.adminUserGrantBundle.findMany({
      where: {
        userId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { bundleKey: true, scope: true },
    }),
  ]);
  const rolePermissions = resolvePermissions(role);
  const direct = (key: PermissionKey): CharacterScope | "absent" => {
    const keyOverrides = overrides.filter((row) => row.permissionKey === key);
    if (keyOverrides.some((row) => row.effect === "revoke")) return new Set();
    if (rolePermissions.has(key) || keyOverrides.some((row) => row.effect === "grant")) return null;
    const ids = new Set<string>();
    let granted = false;
    for (const row of bundleRows) {
      if (
        !isGrantBundleKey(row.bundleKey) ||
        !new Set<string>(ADMIN_GRANT_BUNDLES[row.bundleKey].permissions).has(key)
      ) continue;
      granted = true;
      // Grant-bundle writes only permit Character scope on Character-scoped bundles
      // (character_producer / creator / publisher). A persisted null scope on every
      // other matching bundle is therefore the canonical global grant. Historical
      // rows that incorrectly contain Character ids still narrow access rather than
      // widening it, while a malformed/missing Character scope remains closed.
      if (adminGrantBundleRequiresCharacterScope(row.bundleKey)) {
        // A Character-scoped bundle's declared global permissions are global by contract.
        if (!adminGrantBundlePermissionIsCharacterScoped(row.bundleKey, key)) return null;
      } else if (row.scope === null) {
        return null;
      }
      const scope = row.scope && typeof row.scope === "object" && !Array.isArray(row.scope)
        ? row.scope as Record<string, unknown>
        : {};
      const characterIds = Array.isArray(scope.characterIds)
        ? scope.characterIds.filter((value): value is string => typeof value === "string")
        : [];
      characterIds.forEach((id) => ids.add(id));
    }
    return granted ? ids : "absent";
  };
  for (const key of wanted) {
    const own = direct(key);
    if (own !== "absent") {
      result.set(key, own);
      continue;
    }
    const legacy = legacyFor.get(key);
    const derived = legacy ? direct(legacy) : "absent";
    result.set(key, derived === "absent" ? new Set() : derived);
  }
  return result;
}

export async function effectiveCharacterIdsForPermission(
  userId: string,
  role: ActorRole | undefined,
  key: PermissionKey,
): Promise<CharacterScope> {
  const scopes = await effectiveCharacterScopes(userId, role, [key]);
  // `null` is the global scope, so it must not fall through a nullish default.
  return scopes.has(key) ? scopes.get(key)! : new Set();
}
