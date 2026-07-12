import type { Prisma } from "@prisma/client";
import type { AdminActor } from "@/server/modules/admin/shared/legacy-primitives";
import {
  adminAuditData,
  toInputJson,
} from "@/server/modules/admin/shared/legacy-primitives";

interface TransactionalAdminMutationInput {
  readonly audit: {
    readonly action: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly reason?: string;
    readonly before?: unknown;
    readonly after?: unknown;
  };
  readonly event: {
    readonly eventType: string;
    readonly aggregateType: string;
    readonly aggregateId: string;
    readonly payload: Readonly<Record<string, unknown>>;
  };
}

export async function persistTransactionalAdminMutation(
  tx: Prisma.TransactionClient,
  request: Request,
  actor: AdminActor,
  input: TransactionalAdminMutationInput,
) {
  const audit = adminAuditData(request, actor, input.audit);
  await tx.adminAuditLog.create({ data: audit });
  return tx.mainOutboxEvent.create({
    data: {
      eventType: input.event.eventType,
      aggregateType: input.event.aggregateType,
      aggregateId: input.event.aggregateId,
      payload: toInputJson({
        ...input.event.payload,
        actorId: actor.id,
        actorRole: actor.role,
        requestId: audit.requestId,
      }),
    },
  });
}
