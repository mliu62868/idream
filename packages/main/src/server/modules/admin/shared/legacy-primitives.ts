import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import {
  actorWithPermission,
  jsonBody,
  type AdminActor,
} from "@/server/modules/admin-v2/shared/authority";

export { actorWithPermission, jsonBody, type AdminActor };

export function toInputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export function clampInt(value: string | null, min: number, max: number, fallback: number) {
  const parsed = value ? Number.parseInt(value, 10) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export async function writeAudit(
  request: Request,
  actor: AdminActor,
  input: {
    action: string;
    targetType: string;
    targetId: string;
    reason?: string;
    before?: unknown;
    after?: unknown;
  },
) {
  return prisma.adminAuditLog.create({
    data: adminAuditData(request, actor, input),
  });
}

export function adminAuditData(
  request: Request,
  actor: AdminActor,
  input: {
    action: string;
    targetType: string;
    targetId: string;
    reason?: string;
    before?: unknown;
    after?: unknown;
  },
) {
  return {
    actorId: actor.id,
    actorRole: actor.role,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    reason: input.reason,
    before: input.before === undefined ? undefined : toInputJson(stripSensitive(input.before)),
    after: input.after === undefined ? undefined : toInputJson(stripSensitive(input.after)),
    requestId: request.headers.get("x-request-id") ?? randomUUID(),
    ipHash: hashHeader(request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip")),
    userAgent: request.headers.get("user-agent") ?? undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSensitive);
  if (!isRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (["prompt", "negativePrompt", "body", "password", "token", "secret"].includes(key)) {
      output[key] = "[redacted]";
    } else {
      output[key] = stripSensitive(child);
    }
  }
  return output;
}

export function hashHeader(value: string | null) {
  if (!value) return undefined;
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
