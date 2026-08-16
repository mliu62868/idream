import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { toInputJson } from "../shared/prisma-json";
import type { AdminActor } from "../shared/authority";

// SPEC: 内容运营域写操作的 AdminAuditLog 行构造。
// INTENT: 从 legacy `admin/shared/legacy-primitives` 搬过来的同一份实现。v1 dispatch 整体删除后
//         那个文件会消失，而这些审计语义（redaction、ipHash、requestId 回填）不能跟着消失。
//         留在本域内而不是提升成新的全域原语 —— 谁真的需要它，等下一个域搬过来时再说。

type AuditInput = {
  action: string;
  targetType: string;
  targetId: string;
  reason?: string;
  before?: unknown;
  after?: unknown;
};

export function contentAuditData(
  request: Request,
  actor: AdminActor,
  input: AuditInput,
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

export async function writeContentAudit(
  request: Request,
  actor: AdminActor,
  input: AuditInput,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
) {
  return tx.adminAuditLog.create({ data: contentAuditData(request, actor, input) });
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

function hashHeader(value: string | null) {
  if (!value) return undefined;
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
