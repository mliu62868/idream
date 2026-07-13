import type { Prisma } from "@prisma/client";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";

export async function recordGenerationInvocationUsageFact(
  tx: Prisma.TransactionClient,
  input: {
    attemptId: string;
    generationJobId: string;
    transportAttemptNo: number;
    transportExecutionId: string;
    provider: string;
    model?: string;
    usage: Readonly<Record<string, unknown>>;
    latencyMs: number | null;
    costMicros: number | null;
    pricingVersion: string | null;
    occurredAt: Date;
  },
) {
  const sourceEventId = `${input.attemptId}:transport:${input.transportAttemptNo}:usage`;
  const job = await tx.generationJob.findUnique({
    where: { id: input.generationJobId },
    select: { userId: true },
  });
  return tx.aiUsageFact.upsert({
    where: { sourceService_sourceEventId: { sourceService: "gen", sourceEventId } },
    create: {
      source: `${input.attemptId}:${input.transportAttemptNo}`,
      sourceService: "gen",
      sourceEventId,
      requestId: input.generationJobId,
      attemptId: input.attemptId,
      transportExecutionId: input.transportExecutionId,
      userId: job?.userId ?? null,
      provider: input.provider,
      model: input.model ?? "unknown",
      usage: toInputJson(input.usage),
      latencyMs: input.latencyMs,
      costMicros: input.costMicros === null ? null : BigInt(input.costMicros),
      pricingVersion: input.pricingVersion,
      occurredAt: input.occurredAt,
    },
    update: {},
  });
}
