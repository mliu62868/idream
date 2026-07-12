import { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { canonicalRequestHash } from "./control-plane-command";
import { toInputJson } from "./prisma-json";

export async function executeAtomicIdempotentMutation(input: {
  readonly environment: string;
  readonly actor: { readonly id: string; readonly role: string };
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly commandType: string;
  readonly target: { readonly type: string; readonly id: string };
  readonly expectedVersion?: number;
  readonly payload: unknown;
  readonly mutate: (tx: Prisma.TransactionClient) => Promise<unknown>;
}) {
  const scope = `${input.environment}:${input.actor.id}`;
  const requestHash = canonicalRequestHash({
    commandType: input.commandType,
    target: input.target,
    expectedVersion: input.expectedVersion,
    payload: input.payload,
    retryMode: "idempotent",
  });
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${scope}:${input.idempotencyKey}`}))`;
    const existing = await tx.controlPlaneCommand.findUnique({
      where: { scope_idempotencyKey: { scope, idempotencyKey: input.idempotencyKey } },
    });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw Errors.conflict("Idempotency key is bound to another mutation", {
          existingRequestHash: existing.requestHash,
          submittedRequestHash: requestHash,
        });
      }
      return existing.result;
    }

    const result = toInputJson(await input.mutate(tx));
    await tx.controlPlaneCommand.create({
      data: {
        scope,
        idempotencyKey: input.idempotencyKey,
        commandType: input.commandType,
        targetType: input.target.type,
        targetId: input.target.id,
        actorId: input.actor.id,
        requestId: input.requestId,
        requestHash,
        requestPayload: toInputJson(input.payload),
        expectedVersion: input.expectedVersion,
        retryMode: "idempotent",
        status: "succeeded",
        result,
        finishedAt: new Date(),
      },
    });
    return result;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
