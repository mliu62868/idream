import { z } from "zod";
import { blockerSchema } from "./contracts/common";
import { adminPermissionKeySchema } from "./permissions";

const errorBase = {
  message: z.string().trim().min(1),
  requestId: z.string().trim().min(1),
};

export const adminErrorSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("bad_request"), ...errorBase, details: z.unknown().optional() }).strict(),
  z.object({ code: z.literal("unauthorized"), ...errorBase }).strict(),
  z.object({ code: z.literal("not_found"), ...errorBase, target: z.string().trim().min(1).optional() }).strict(),
  z
    .object({
      code: z.literal("conflict"),
      ...errorBase,
      currentSnapshot: z.unknown(),
      differences: z.array(z.string().trim().min(1)).min(1).readonly(),
    })
    .strict(),
  z
    .object({
      code: z.literal("idempotency_conflict"),
      ...errorBase,
      commandId: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      code: z.literal("invariant_failed"),
      ...errorBase,
      blockers: z.array(blockerSchema).min(1).readonly(),
      repairDeepLink: z.string().trim().min(1).optional(),
    })
    .strict(),
  z
    .object({
      code: z.literal("permission_denied"),
      ...errorBase,
      permission: adminPermissionKeySchema,
    })
    .strict(),
  z
    .object({
      code: z.literal("dependency_unhealthy"),
      ...errorBase,
      dependency: z.string().trim().min(1),
      retryAfterSeconds: z.number().int().positive().optional(),
    })
    .strict(),
  z.object({ code: z.literal("internal"), ...errorBase }).strict(),
]);

export const adminErrorResponseSchema = z
  .object({
    ok: z.literal(false),
    error: adminErrorSchema,
  })
  .strict();

export const ADMIN_ERROR_HTTP_STATUS = {
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
  idempotency_conflict: 409,
  invariant_failed: 422,
  permission_denied: 403,
  dependency_unhealthy: 503,
  internal: 500,
} as const satisfies Record<z.infer<typeof adminErrorSchema>["code"], number>;

export type AdminError = z.infer<typeof adminErrorSchema>;
export type AdminErrorResponse = z.infer<typeof adminErrorResponseSchema>;
