import type { ActorRole } from "@/server/lib/auth";
import { prisma } from "@/server/lib/db";
import { applyOverrides, resolvePermissions, type PermissionKey } from "./permissions";

// SPEC: 解析一个 actor 的有效 permission key 集合 = role 映射 ∪ grant − revoke（用户级覆盖）。
// INTENT: 权限判定的单一入口，page 初始门与每个 admin API 都走它，避免 role-only 与 override 两套逻辑漂移。
// INVARIANTS: 无 userId 时退化为纯 role 集合；只读，不写。
export async function effectivePermissions(
  userId: string | undefined,
  role: ActorRole | undefined,
): Promise<Set<PermissionKey>> {
  const base = resolvePermissions(role);
  if (!userId) return base;
  const overrides = await prisma.adminUserPermission.findMany({ where: { userId } });
  return applyOverrides(base, overrides);
}

export async function userHasPermission(
  userId: string | undefined,
  role: ActorRole | undefined,
  key: PermissionKey,
): Promise<boolean> {
  return (await effectivePermissions(userId, role)).has(key);
}
