import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { canonicalRequestHash } from "@/server/modules/admin-v2/shared/control-plane-command";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { toInputJson, type AdminActor } from "./legacy-primitives";

export async function executeIdempotentDomainCommand(input: {
  request: Request;
  actor: AdminActor;
  commandType: string;
  targetType: string;
  targetId: string;
  payload: unknown;
  execute: (
    tx: Prisma.TransactionClient,
    requestId: string,
  ) => Promise<Record<string, unknown>>;
}) {
  const idempotencyKey = requireIdempotencyKey(input.request);
  const requestId =
    input.request.headers.get("x-request-id")?.trim() || randomUUID();
  const scope = `${env.APP_ENV}:${input.actor.id}`;
  const requestHash = canonicalRequestHash({
    commandType: input.commandType,
    target: { type: input.targetType, id: input.targetId },
    payload: input.payload,
    retryMode: "idempotent",
  });
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1::int AS locked FROM pg_advisory_xact_lock(hashtext(${`${scope}:${idempotencyKey}`}))`;
    const existing = await tx.controlPlaneCommand.findUnique({
      where: { scope_idempotencyKey: { scope, idempotencyKey } },
    });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw Errors.conflict(
          "Idempotency-Key was already used for a different admin command",
        );
      }
      if (existing.status !== "succeeded" || !existing.result) {
        throw Errors.conflict("The original admin command has not completed");
      }
      return {
        ...(existing.result as Record<string, unknown>),
        replayed: true,
      };
    }
    const command = await tx.controlPlaneCommand.create({
      data: {
        scope,
        idempotencyKey,
        commandType: input.commandType,
        targetType: input.targetType,
        targetId: input.targetId,
        actorId: input.actor.id,
        requestId,
        requestHash,
        requestPayload: toInputJson(input.payload),
        retryMode: "idempotent",
        status: "accepted",
      },
    });
    const result = { ...(await input.execute(tx, requestId)), replayed: false };
    await tx.controlPlaneCommand.update({
      where: { id: command.id },
      data: {
        status: "succeeded",
        result: toInputJson(result),
        finishedAt: new Date(),
      },
    });
    return result;
  });
}
