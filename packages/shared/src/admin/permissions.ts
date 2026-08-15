import { z } from "zod";

export const ADMIN_PERMISSION_KEYS = [
  "dashboard.read",
  "user.read",
  "user.status.write",
  "user.role.write",
  "content.read",
  "content.takedown.write",
  "content.official.write",
  "content.template.write",
  "content.tag.write",
  "content.production.write",
  "content.asset.read",
  "content.asset.review",
  "content.placement.write",
  "generation.job.read",
  "generation.job.requeue",
  "generation.config.read",
  "generation.config.write",
  "safety.review.read",
  "safety.review.write",
  "billing.read",
  "billing.ledger.adjust",
  "billing.checkout.reconcile",
  "billing.subscription.refund",
  "config.feature_flag.write",
  "config.pricing.write",
  "ops.queue.read",
  "ops.deadletter.write",
  "support.request.read",
  "support.request.write",
  "support.plaintext.view",
  "audit.read",
  "analytics.export",
  "growth.promo.read",
  "growth.promo.write",
  "chat.ops.read",
  "admin.approval.review",
  "content.cms.write",
  "compliance.read",
  "compliance.write",
  "character.project.read",
  "character.project.write",
  "character.release.read",
  "character.release.propose",
  "character.release.review",
  "character.release.publish",
  "character.performance.read",
  "creative.run.read",
  "creative.run.write",
  "creative.run.review",
  "creative.asset.read",
  "creative.placement.read",
  "creative.placement.publish",
  "ops.incident.read",
  "ops.incident.manage",
  "case.read",
  "case.assign",
  "case.decide",
  "customer.read",
  "analytics.metric.read",
  "analytics.metric.export",
  "experiment.manage",
] as const;

export const adminPermissionKeySchema = z.enum(ADMIN_PERMISSION_KEYS);
export type AdminPermissionKey = z.infer<typeof adminPermissionKeySchema>;

export const adminActorRoleSchema = z.enum(["user", "moderator", "support", "ops", "analyst", "admin"]);
export type AdminActorRole = z.infer<typeof adminActorRoleSchema>;

export const ADMIN_ROLE_PERMISSIONS = {
  user: [],
  admin: ADMIN_PERMISSION_KEYS,
  moderator: [
    "dashboard.read",
    "user.read",
    "content.read",
    "content.takedown.write",
    "content.official.write",
    "content.template.write",
    "content.tag.write",
    "content.asset.read",
    "content.cms.write",
    "generation.job.read",
    "safety.review.read",
    "safety.review.write",
    "chat.ops.read",
    "audit.read",
    "case.read",
    "case.assign",
    "case.decide",
  ],
  support: [
    "dashboard.read",
    "user.read",
    "content.read",
    "content.asset.read",
    "generation.job.read",
    "billing.read",
    "support.request.read",
    "support.request.write",
    "support.plaintext.view",
    "growth.promo.read",
    "chat.ops.read",
    "compliance.read",
    "audit.read",
    "ops.incident.read",
    "case.read",
    "case.assign",
    "case.decide",
    "customer.read",
  ],
  ops: [
    "dashboard.read",
    "user.read",
    "generation.job.read",
    "generation.job.requeue",
    "generation.config.read",
    "content.production.write",
    "content.asset.read",
    "content.asset.review",
    "content.placement.write",
    "config.feature_flag.write",
    "ops.queue.read",
    "ops.deadletter.write",
    "chat.ops.read",
    "audit.read",
    "creative.run.read",
    "creative.asset.read",
    "creative.placement.read",
    "ops.incident.read",
    "ops.incident.manage",
    "analytics.metric.read",
  ],
  analyst: [
    "dashboard.read",
    "analytics.export",
    "growth.promo.read",
    "character.performance.read",
    "analytics.metric.read",
    "analytics.metric.export",
  ],
} as const satisfies Record<AdminActorRole, readonly AdminPermissionKey[]>;

export const adminPermissionScopeSchema = z.enum([
  "all",
  "assigned_characters",
  "assigned_or_customer_linked_incidents",
  "support_case_subtypes",
  "technical_metrics",
]);
export type AdminPermissionScope = z.infer<typeof adminPermissionScopeSchema>;

export const ADMIN_ROLE_PERMISSION_SCOPES: Partial<
  Record<AdminActorRole, Partial<Record<AdminPermissionKey, AdminPermissionScope>>>
> = {
  support: {
    "ops.incident.read": "assigned_or_customer_linked_incidents",
    "case.read": "support_case_subtypes",
    "case.assign": "support_case_subtypes",
    "case.decide": "support_case_subtypes",
  },
  ops: {
    "analytics.metric.read": "technical_metrics",
  },
};

export const ADMIN_GRANT_BUNDLES = {
  character_producer: {
    permissions: [
      "character.project.read",
      "character.project.write",
      "character.release.read",
      "character.release.propose",
      "character.release.review",
      "character.performance.read",
    ],
    scopes: { "character.performance.read": "assigned_characters" },
  },
  creative_operator: {
    permissions: [
      "creative.run.read",
      "creative.run.write",
      "creative.run.review",
      "creative.asset.read",
      "creative.placement.read",
      "creative.placement.publish",
    ],
    scopes: {},
  },
  growth_operator: {
    permissions: ["analytics.metric.read", "experiment.manage"],
    scopes: {},
  },
} as const satisfies Record<
  string,
  {
    readonly permissions: readonly AdminPermissionKey[];
    readonly scopes: Partial<Record<AdminPermissionKey, AdminPermissionScope>>;
  }
>;

export type AdminGrantBundleKey = keyof typeof ADMIN_GRANT_BUNDLES;

export const adminPermissionOverrideSchema = z
  .object({
    permissionKey: z.string(),
    effect: z.enum(["grant", "revoke"]),
  })
  .strict();
export type AdminPermissionOverride = z.infer<typeof adminPermissionOverrideSchema>;

const permissionKeySet = new Set<string>(ADMIN_PERMISSION_KEYS);

export function isAdminPermissionKey(key: string): key is AdminPermissionKey {
  return permissionKeySet.has(key);
}

export function expandAdminGrantBundles(bundleKeys: readonly AdminGrantBundleKey[]): Set<AdminPermissionKey> {
  const permissions = new Set<AdminPermissionKey>();
  for (const bundleKey of bundleKeys) {
    for (const permission of ADMIN_GRANT_BUNDLES[bundleKey].permissions) permissions.add(permission);
  }
  return permissions;
}

export function resolveAdminPermissions(input: {
  role: AdminActorRole | undefined;
  grantBundles?: readonly AdminGrantBundleKey[];
  overrides?: ReadonlyArray<{ permissionKey: string; effect: string }>;
}): Set<AdminPermissionKey> {
  const resolved = new Set<AdminPermissionKey>(input.role ? ADMIN_ROLE_PERMISSIONS[input.role] : []);
  for (const permission of expandAdminGrantBundles(input.grantBundles ?? [])) resolved.add(permission);
  for (const override of input.overrides ?? []) {
    if (!isAdminPermissionKey(override.permissionKey)) continue;
    if (override.effect === "grant") resolved.add(override.permissionKey);
    if (override.effect === "revoke") resolved.delete(override.permissionKey);
  }
  return resolved;
}
