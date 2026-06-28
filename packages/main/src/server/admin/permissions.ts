import type { ActorRole } from "@/server/lib/auth";
import { Errors } from "@/server/lib/errors";

export type PermissionKey =
  | "dashboard.read"
  | "user.read"
  | "user.status.write"
  | "user.role.write"
  | "content.read"
  | "content.takedown.write"
  | "generation.job.read"
  | "generation.job.requeue"
  | "generation.config.read"
  | "generation.config.write"
  | "safety.review.read"
  | "safety.review.write"
  | "billing.read"
  | "billing.ledger.adjust"
  | "config.feature_flag.write"
  | "config.pricing.write"
  | "ops.queue.read"
  | "ops.deadletter.write"
  | "support.plaintext.view"
  | "audit.read"
  | "analytics.export"
  | "growth.promo.read"
  | "growth.promo.write"
  | "chat.ops.read"
  | "admin.approval.review";

export const ROLE_PERMISSIONS: Record<ActorRole, readonly PermissionKey[]> = {
  user: [],
  admin: [
    "dashboard.read",
    "user.read",
    "user.status.write",
    "user.role.write",
    "content.read",
    "content.takedown.write",
    "generation.job.read",
    "generation.job.requeue",
    "generation.config.read",
    "generation.config.write",
    "safety.review.read",
    "safety.review.write",
    "billing.read",
    "billing.ledger.adjust",
    "config.feature_flag.write",
    "config.pricing.write",
    "ops.queue.read",
    "ops.deadletter.write",
    "support.plaintext.view",
    "audit.read",
    "analytics.export",
    "growth.promo.read",
    "growth.promo.write",
    "chat.ops.read",
    "admin.approval.review",
  ],
  moderator: [
    "dashboard.read",
    "user.read",
    "content.read",
    "content.takedown.write",
    "generation.job.read",
    "safety.review.read",
    "safety.review.write",
    "chat.ops.read",
    "audit.read",
  ],
  support: [
    "dashboard.read",
    "user.read",
    "content.read",
    "generation.job.read",
    "billing.read",
    "support.plaintext.view",
    "growth.promo.read",
    "chat.ops.read",
    "audit.read",
  ],
  ops: [
    "dashboard.read",
    "user.read",
    "generation.job.read",
    "generation.job.requeue",
    "generation.config.read",
    "config.feature_flag.write",
    "ops.queue.read",
    "ops.deadletter.write",
    "chat.ops.read",
    "audit.read",
  ],
  analyst: ["dashboard.read", "analytics.export", "growth.promo.read"],
};

export function resolvePermissions(role: ActorRole | undefined) {
  return new Set(role ? ROLE_PERMISSIONS[role] : []);
}

// admin 拥有全部 key，用作合法 permission key 的单一事实来源。
export function isPermissionKey(key: string): key is PermissionKey {
  return (ROLE_PERMISSIONS.admin as readonly string[]).includes(key);
}

// SPEC: 用户级权限覆盖 —— 最终 key 集合 = roleKeys ∪ granted − revoked（07/ADMIN_CONSOLE_PLAN §3.1 P1）。
// INVARIANTS: 纯函数，不碰 DB；未知 key 的 override 忽略；revoke 可移除 role 自带的 key。
export function applyOverrides(
  base: Set<PermissionKey>,
  overrides: ReadonlyArray<{ permissionKey: string; effect: string }>,
) {
  const out = new Set(base);
  for (const override of overrides) {
    if (!isPermissionKey(override.permissionKey)) continue;
    if (override.effect === "grant") out.add(override.permissionKey);
    else if (override.effect === "revoke") out.delete(override.permissionKey);
  }
  return out;
}

export function hasPermission(role: ActorRole | undefined, key: PermissionKey) {
  return resolvePermissions(role).has(key);
}

export function assertPermission(role: ActorRole | undefined, key: PermissionKey) {
  if (!hasPermission(role, key)) {
    throw Errors.forbidden("Missing admin permission", { permission: key });
  }
}
