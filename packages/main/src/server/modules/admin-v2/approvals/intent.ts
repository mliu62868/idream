import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import { canonicalSha256 } from "../shared/canonical-json";

const policies = {
  "billing.ledger.adjust": {
    permission: "billing.ledger.adjust", targetType: "user",
    payload: z.object({ delta: z.number().int() }).strict(),
  },
  "config.pricing.publish": {
    permission: "config.pricing.write", targetType: "pricing_rule",
    payload: z.object({ baseCost: z.number().finite(), multiplier: z.number().finite(), version: z.number().int().positive() }).strict(),
  },
  "promo.redeem_code.create": {
    permission: "growth.promo.write", targetType: "redeem_code",
    payload: z.object({ dreamcoins: z.number().int().nonnegative(), maxRedemptions: z.union([z.number().int().positive(), z.literal("unlimited")]) }).strict(),
  },
  "config.feature_flag.write": {
    permission: "config.feature_flag.write", targetType: "feature_flag",
    payload: z.object({ enabled: z.literal(false).default(false) }).strict(),
  },
  "config.coin_offer.publish": {
    permission: "config.pricing.write", targetType: "coin_offer",
    payload: z.object({ version: z.number().int().positive(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  },
} as const;

export type BoundApprovalAction = keyof typeof policies;
type ApprovalIntent = {
  action: string; permissionKey: string; targetType: string; targetId: string; payload: unknown;
};
const bindingSchema = z.object({
  version: z.literal(1),
  commandType: z.string(), targetType: z.string(), targetId: z.string(),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  expectedVersion: z.number().int().positive().nullable(),
  expiresAt: z.iso.datetime(),
}).strict();

export function boundApprovalPolicy(action: string) {
  return Object.hasOwn(policies, action) ? policies[action as BoundApprovalAction] : undefined;
}

function canonicalPayload(action: BoundApprovalAction, payload: unknown) {
  const parsed = policies[action].payload.safeParse(payload);
  if (!parsed.success) throw Errors.badRequest("Approval payload must name the exact values it approves", parsed.error.flatten());
  return parsed.data;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export async function bindApprovalIntent(tx: Prisma.TransactionClient, input: ApprovalIntent, now = new Date()) {
  const policy = boundApprovalPolicy(input.action);
  if (!policy) return input.payload;
  if (policy.permission !== input.permissionKey || policy.targetType !== input.targetType) {
    throw Errors.badRequest("Approval permission and target type must match the requested action");
  }
  const payload = canonicalPayload(input.action as BoundApprovalAction, input.payload);
  let expectedVersion: number | null = "version" in payload ? payload.version : null;
  if (input.action === "config.feature_flag.write") {
    const flag = await tx.featureFlag.findUnique({ where: { key: input.targetId } });
    if (!flag) throw Errors.notFound("Feature flag not found");
    expectedVersion = flag.version;
  }
  // Append-only ledger adjustments and one-time issuance have no mutable target version.
  // The explicit null is part of their bound intent; it is not a wildcard.
  return {
    ...payload,
    approvalBinding: {
      version: 1, commandType: input.action, targetType: input.targetType, targetId: input.targetId,
      payloadHash: canonicalSha256(payload), expectedVersion,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
    },
  };
}

export function assertBoundApprovalIntent(input: ApprovalIntent, now = new Date()) {
  const policy = boundApprovalPolicy(input.action);
  if (!policy) return null;
  const { approvalBinding, ...rawPayload } = record(input.payload);
  const binding = bindingSchema.safeParse(approvalBinding);
  const payload = policy.payload.safeParse(rawPayload);
  if (!binding.success || !payload.success ||
      input.permissionKey !== policy.permission || input.targetType !== policy.targetType ||
      binding.data.commandType !== input.action || binding.data.targetType !== input.targetType ||
      binding.data.targetId !== input.targetId || binding.data.payloadHash !== canonicalSha256(payload.data) ||
      new Date(binding.data.expiresAt).getTime() <= now.getTime()) {
    throw Errors.forbidden("Approval is unbound, expired, or invalid; request a new approval", {
      action: input.action, targetId: input.targetId, recovery: "request_new_approval",
    });
  }
  return { binding: binding.data, payload: payload.data };
}

export function approvalMatchesIntent(
  input: ApprovalIntent, payload: unknown, expectedVersion: number | null,
) {
  try {
    const approved = assertBoundApprovalIntent(input);
    return approved !== null && approved.binding.expectedVersion === expectedVersion &&
      approved.binding.payloadHash === canonicalSha256(canonicalPayload(input.action as BoundApprovalAction, payload));
  } catch {
    return false;
  }
}
