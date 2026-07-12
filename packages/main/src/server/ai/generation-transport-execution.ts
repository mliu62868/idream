import { generationTransportExecutionEventSchema, type GenerationTransportExecutionEvent } from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { recordGenerationAttemptEvent } from "./generation-attempt-events";
import { isGenerationTransportExecutionTransitionAllowed } from "./generation-evidence-transition-authority";

export async function recordGenerationTransportExecution(rawInput: unknown) {
  const input = generationTransportExecutionEventSchema.parse(rawInput);
  return prisma.$transaction(async (tx) => {
    const attempt = await tx.generationAttempt.findUnique({ where: { id: input.attemptId } });
    if (!attempt || attempt.requestId !== input.generationJobId || attempt.attemptNo !== input.attemptNo) {
      throw Errors.conflict("Generation transport identity does not match its business Attempt");
    }
    const key = { attemptId_transportAttemptNo: { attemptId: input.attemptId, transportAttemptNo: input.transportAttemptNo } };
    const existing = await tx.generationTransportExecution.findUnique({ where: key });
    let disposition: "persisted" | "duplicate" = "persisted";
    if (!existing) {
      await tx.generationTransportExecution.create({ data: {
        attemptId: input.attemptId,
        transportAttemptNo: input.transportAttemptNo,
        providerRequestId: input.providerRequestId,
        idempotencyKey: input.idempotencyKey,
        status: input.status,
        startedAt: new Date(input.occurredAt),
        finishedAt: input.status === "running" ? null : new Date(input.occurredAt),
      } });
    } else if (existing.status === input.status) {
      disposition = "duplicate";
    } else if (isGenerationTransportExecutionTransitionAllowed(existing.status, input.status)) {
      await tx.generationTransportExecution.update({
        where: key,
        data: { status: input.status, providerRequestId: input.providerRequestId, finishedAt: new Date(input.occurredAt) },
      });
    } else {
      throw Errors.conflict("Generation TransportExecution is already terminal with a different outcome");
    }
    await recordGenerationAttemptEvent(tx, {
      eventId: `${input.attemptId}:transport:${input.transportAttemptNo}:${input.status}`,
      attemptId: input.attemptId,
      eventType: `generation.transport.${input.status}.v1`,
      occurredAt: new Date(input.occurredAt),
      payload: transportEventPayload(input),
      status: "running",
      startedAt: attempt.startedAt ?? new Date(input.occurredAt),
    });
    return { acknowledged: true, status: disposition };
  });
}

function transportEventPayload(input: GenerationTransportExecutionEvent) {
  return {
    generationJobId: input.generationJobId,
    transportAttemptNo: input.transportAttemptNo,
    provider: input.provider,
    providerRequestId: input.providerRequestId,
    idempotencyKey: input.idempotencyKey,
    status: input.status,
    error: input.error,
  };
}
