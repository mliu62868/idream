import { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { canonicalRequestHash } from "./control-plane-command";
import {
  isSerializableWriteConflict,
  isUniqueConstraintConflict,
} from "./prisma-transaction-conflict";
import { toInputJson } from "./prisma-json";

export async function executeAtomicIdempotentMutation<
  Prepared = undefined,
>(input: {
  readonly environment: string;
  readonly actor: { readonly id: string; readonly role: string };
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly commandType: string;
  readonly target: { readonly type: string; readonly id: string };
  readonly expectedVersion?: number;
  readonly payload: unknown;
  readonly prepare?: () => Promise<Prepared>;
  readonly mutate: (
    tx: Prisma.TransactionClient,
    prepared: Prepared,
  ) => Promise<unknown>;
  readonly decorateResult?: (result: unknown, replayed: boolean) => unknown;
  // SPEC: 响应契约的校验入口，返回值就是这次调用的返回值。
  // INTENT: 校验必须发生在事务内、写 controlPlaneCommand 之前。放在提交之后时，不满足响应契约
  // 的 result 已经落库：调用方拿到 500，重试用同一个幂等键取回那条未经校验的 result，再 500，
  // 永远好不了，而且每次重试都多堆一行垃圾。校验在事务里失败则整笔回滚，这个状态就不存在。
  readonly validateResult?: (result: unknown, replayed: boolean) => unknown;
}) {
  const scope = `${input.environment}:${input.actor.id}`;
  const respond = (result: unknown, replayed: boolean) => {
    const decorated = input.decorateResult
      ? input.decorateResult(result, replayed)
      : result;
    return input.validateResult ? input.validateResult(decorated, replayed) : decorated;
  };
  const requestHash = canonicalRequestHash({
    commandType: input.commandType,
    target: input.target,
    expectedVersion: input.expectedVersion,
    payload: input.payload,
    retryMode: "idempotent",
  });
  if (input.prepare) {
    const existing = await prisma.controlPlaneCommand.findUnique({
      where: {
        scope_idempotencyKey: {
          scope,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw Errors.conflict(
          "Idempotency key is bound to another mutation",
          {
            existingRequestHash: existing.requestHash,
            submittedRequestHash: requestHash,
          },
        );
      }
      return respond(existing.result, true);
    }
  }
  const prepared = input.prepare
    ? await input.prepare()
    : undefined as Prepared;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
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
          return respond(existing.result, true);
        }

        const result = toInputJson(await input.mutate(tx, prepared));
        // INVARIANT: 只有能被响应契约表达的 result 才会被写进 controlPlaneCommand。
        const response = respond(result, false);
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
        return response;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (cause) {
      if (isSerializableWriteConflict(cause)) {
        if (attempt < 2) continue;
        throw Errors.conflict(
          "Mutation could not be serialized against the latest authority state",
          {
            commandType: input.commandType,
            target: input.target,
            attempts: attempt + 1,
          },
        );
      }
      if (isUniqueConstraintConflict(cause)) {
        throw Errors.conflict(
          "Mutation conflicted with an authority that changed concurrently",
          {
            commandType: input.commandType,
            target: input.target,
            constraint: cause.meta?.target ?? null,
          },
        );
      }
      throw cause;
    }
  }
  throw Errors.conflict("Mutation could not be serialized after retry");
}
