import { Prisma, type AiUsageFact } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import { env } from "@/server/lib/env";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { classifyExistingCustomerMetricActor } from "@/server/modules/admin-v2/metrics/event-classification";

export type GenerationInvocationUsageFactInput = {
  readonly attemptId: string;
  readonly generationJobId: string;
  readonly transportAttemptNo: number;
  readonly transportExecutionId: string;
  readonly provider: string;
  readonly model?: string;
  readonly usage: Readonly<Record<string, unknown>>;
  readonly latencyMs: number | null;
  readonly costMicros: number | null;
  readonly pricingVersion: string | null;
  readonly occurredAt: Date;
};

export async function recordGenerationInvocationUsageFact(
  tx: Prisma.TransactionClient,
  input: GenerationInvocationUsageFactInput,
) {
  const sourceEventId = `${input.attemptId}:transport:${input.transportAttemptNo}:usage`;
  const job = await tx.generationJob.findUniqueOrThrow({
    where: { id: input.generationJobId },
    select: {
      userId: true,
      characterId: true,
      user: { select: { id: true, email: true, role: true, status: true, deletedAt: true, dataClass: true } },
    },
  });
  const desired = canonicalUsageFact(input, job.userId);
  const where = {
    sourceService_sourceEventId: { sourceService: "gen", sourceEventId },
  } as const;
  const existing = await tx.aiUsageFact.findUnique({ where });
  if (existing) {
    assertCanonicalUsageFact(existing, desired);
    return existing;
  }
  const classification = classifyExistingCustomerMetricActor(job.user);
  try {
    return await tx.aiUsageFact.create({
      data: {
        ...desired,
        // Main owns product attribution. Gen supplies invocation accounting,
        // never the actor class or Character scope of a business fact.
        characterId: job.characterId,
        environment: env.APP_ENV,
        dataClass: classification.dataClass,
        actorIsInternal: classification.actor.isInternal,
        trustClass: "canonical",
        usage: toInputJson(input.usage),
        costMicros:
          input.costMicros === null ? null : BigInt(input.costMicros),
        occurredAt: input.occurredAt,
      },
    });
  } catch (error) {
    if (!isUniqueConstraintViolation(error)) throw error;
    const raced = await tx.aiUsageFact.findUnique({ where });
    if (!raced) throw error;
    assertCanonicalUsageFact(raced, desired);
    return raced;
  }
}

export async function generationInvocationUsageFactConflicts(
  tx: Prisma.TransactionClient,
  input: GenerationInvocationUsageFactInput,
) {
  const sourceEventId = `${input.attemptId}:transport:${input.transportAttemptNo}:usage`;
  const existing = await tx.aiUsageFact.findUnique({
    where: {
      sourceService_sourceEventId: { sourceService: "gen", sourceEventId },
    },
  });
  if (!existing) return false;
  const job = await tx.generationJob.findUniqueOrThrow({
    where: { id: input.generationJobId },
    select: { userId: true },
  });
  return usageFactHash(existing) !==
    canonicalSha256(canonicalUsageFact(input, job.userId));
}

function canonicalUsageFact(
  input: GenerationInvocationUsageFactInput,
  userId: string | null,
) {
  return {
    source: `${input.attemptId}:${input.transportAttemptNo}`,
    sourceService: "gen",
    sourceEventId: `${input.attemptId}:transport:${input.transportAttemptNo}:usage`,
    requestId: input.generationJobId,
    attemptId: input.attemptId,
    transportExecutionId: input.transportExecutionId,
    userId,
    provider: input.provider,
    model: input.model ?? "unknown",
    usage: input.usage,
    latencyMs: input.latencyMs,
    costMicros:
      input.costMicros === null ? null : String(input.costMicros),
    pricingVersion: input.pricingVersion,
  };
}

function usageFactHash(fact: AiUsageFact) {
  // Attribution is a first-write snapshot, not provider replay identity.
  // Reclassification or a new writer version must neither quarantine exact
  // accounting replays nor silently rewrite previously accepted facts.
  return canonicalSha256({
    source: fact.source,
    sourceService: fact.sourceService,
    sourceEventId: fact.sourceEventId,
    requestId: fact.requestId,
    attemptId: fact.attemptId,
    transportExecutionId: fact.transportExecutionId,
    userId: fact.userId,
    provider: fact.provider,
    model: fact.model,
    usage: fact.usage,
    latencyMs: fact.latencyMs,
    costMicros: fact.costMicros === null ? null : String(fact.costMicros),
    pricingVersion: fact.pricingVersion,
  });
}

function assertCanonicalUsageFact(
  existing: AiUsageFact,
  desired: ReturnType<typeof canonicalUsageFact>,
) {
  if (usageFactHash(existing) !== canonicalSha256(desired)) {
    throw Errors.conflict(
      "Generation invocation usage identity was replayed with different accounting",
      {
        attemptId: desired.attemptId,
        sourceEventId: desired.sourceEventId,
      },
    );
  }
}

function isUniqueConstraintViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002";
}
