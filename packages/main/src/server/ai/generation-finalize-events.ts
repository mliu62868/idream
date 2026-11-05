// SPEC: small writes shared by finalization, refunds and stale quarantine.
import { Prisma } from "@prisma/client";

export async function markGenerationTerminalRecordDelivered(
  tx: Prisma.TransactionClient,
  attemptId: string,
) {
  await tx.mainOutboxEvent.updateMany({
    where: { id: `generation_terminal_record_${attemptId}` },
    data: { status: "delivered", deliveredAt: new Date() },
  });
}

export async function appendGenerationEvent(
  tx: Prisma.TransactionClient,
  jobId: string,
  type: string,
  message: string,
  metadata: Record<string, unknown>,
) {
  return tx.generationJobEvent.create({
    data: {
      jobId,
      type,
      message,
      metadata: toInputJson(metadata),
    },
  });
}

export function toInputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}
