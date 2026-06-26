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
  | "analytics.export";

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
  ],
  moderator: [
    "dashboard.read",
    "user.read",
    "content.read",
    "content.takedown.write",
    "generation.job.read",
    "safety.review.read",
    "safety.review.write",
    "audit.read",
  ],
  support: [
    "dashboard.read",
    "user.read",
    "content.read",
    "generation.job.read",
    "billing.read",
    "support.plaintext.view",
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
    "audit.read",
  ],
  analyst: ["dashboard.read", "analytics.export"],
};

export function resolvePermissions(role: ActorRole | undefined) {
  return new Set(role ? ROLE_PERMISSIONS[role] : []);
}

export function hasPermission(role: ActorRole | undefined, key: PermissionKey) {
  return resolvePermissions(role).has(key);
}

export function assertPermission(role: ActorRole | undefined, key: PermissionKey) {
  if (!hasPermission(role, key)) {
    throw Errors.forbidden("Missing admin permission", { permission: key });
  }
}
