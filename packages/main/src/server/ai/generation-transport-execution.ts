import { Prisma } from "@prisma/client";
import { generationTransportExecutionEventSchema, type GenerationTransportExecutionEvent } from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { recordGenerationAttemptEvent } from "./generation-attempt-events";
import { isGenerationTransportExecutionTransitionAllowed } from "./generation-evidence-transition-authority";
import { recordGenerationInvocationUsageFact } from "./generation-invocation-usage";
import { resolveExactGenerationDispatchAuthority } from "./generation-dispatch-evidence-authority";

export async function recordGenerationTransportExecution(rawInput: unknown) {
  const input = generationTransportExecutionEventSchema.parse(rawInput);
  return prisma.$transaction(async (tx) => {
    // INVARIANT: cancellation takes the Request lock before sealing its exact
    // Attempt and dispatch Outbox. A worker must acquire that same authority
    // before Main acknowledges the pre-provider `running` transport event.
    await tx.$queryRaw(Prisma.sql`
      SELECT id
      FROM generation_jobs
      WHERE id = ${input.generationJobId}
      FOR UPDATE
    `);
    const request = await tx.generationJob.findUnique({
      where: { id: input.generationJobId },
      select: { status: true },
    });
    await tx.$queryRaw(Prisma.sql`
      SELECT id
      FROM generation_attempts
      WHERE id = ${input.attemptId}
      FOR UPDATE
    `);
    const attempt = await tx.generationAttempt.findUnique({ where: { id: input.attemptId } });
    if (!attempt || attempt.requestId !== input.generationJobId || attempt.attemptNo !== input.attemptNo) {
      throw Errors.conflict(
        `Generation transport identity does not match its business Attempt (${input.attemptId}/${input.generationJobId}/${input.attemptNo})`,
        {
          attemptId: input.attemptId,
          generationJobId: input.generationJobId,
          attemptNo: input.attemptNo,
          storedRequestId: attempt?.requestId ?? null,
          storedAttemptNo: attempt?.attemptNo ?? null,
        },
      );
    }
    if (
      input.status === "running" &&
      (
        !request ||
        !["queued", "moderating_input", "running", "moderating_output"].includes(
          request.status,
        ) ||
        !["queued", "running"].includes(attempt.status)
      )
    ) {
      throw Errors.conflict(
        "Generation transport cannot invoke a provider after dispatch authority was revoked",
        {
          requestId: input.generationJobId,
          requestStatus: request?.status ?? null,
          attemptId: attempt.id,
          attemptStatus: attempt.status,
        },
      );
    }
    const dispatch = await resolveExactGenerationDispatchAuthority(tx, {
      generationJobId: input.generationJobId,
      attemptId: input.attemptId,
      attemptNo: input.attemptNo,
      transportAttemptNo: input.transportAttemptNo,
      provider: input.provider,
      model: input.model,
      providerIdempotencyKey: input.idempotencyKey,
    }, attempt);
    if (!dispatch.ok) {
      throw Errors.conflict(
        "Generation transport does not match its exact dispatch authority",
        { attemptId: attempt.id, code: dispatch.code },
      );
    }
    const key = { attemptId_transportAttemptNo: { attemptId: input.attemptId, transportAttemptNo: input.transportAttemptNo } };
    await tx.$queryRaw(Prisma.sql`
      SELECT id
      FROM generation_transport_executions
      WHERE "attemptId" = ${input.attemptId}
        AND "transportAttemptNo" = ${input.transportAttemptNo}
      FOR UPDATE
    `);
    const existing = await tx.generationTransportExecution.findUnique({ where: key });
    if (
      existing &&
      (existing.idempotencyKey !== input.idempotencyKey ||
        (existing.providerRequestId !== null &&
          existing.providerRequestId !== input.providerRequestId))
    ) {
      throw Errors.conflict("Generation TransportExecution identity changed", {
        attemptId: input.attemptId,
        transportAttemptNo: input.transportAttemptNo,
      });
    }
    let disposition: "persisted" | "duplicate" = "persisted";
    if (!existing) {
      await tx.generationTransportExecution.create({ data: {
        attemptId: input.attemptId,
        transportAttemptNo: input.transportAttemptNo,
        providerRequestId: input.providerRequestId,
        idempotencyKey: input.idempotencyKey,
        status: input.status,
        latencyMs: input.accounting?.latencyMs,
        costMicros: input.accounting?.costMicros === null || input.accounting?.costMicros === undefined
          ? null
          : BigInt(input.accounting.costMicros),
        pricingVersion: input.accounting?.pricingVersion,
        startedAt: new Date(input.occurredAt),
        finishedAt: input.status === "running" ? null : new Date(input.occurredAt),
      } });
    } else if (existing.status === input.status) {
      disposition = "duplicate";
    } else if (isGenerationTransportExecutionTransitionAllowed(existing.status, input.status)) {
      const updated = await tx.generationTransportExecution.updateMany({
        where: {
          attemptId: input.attemptId,
          transportAttemptNo: input.transportAttemptNo,
          status: existing.status,
          idempotencyKey: existing.idempotencyKey,
          providerRequestId: existing.providerRequestId,
        },
        data: {
          status: input.status,
          providerRequestId: input.providerRequestId ?? existing.providerRequestId,
          latencyMs: input.accounting?.latencyMs,
          costMicros: input.accounting?.costMicros === null || input.accounting?.costMicros === undefined
            ? null
            : BigInt(input.accounting.costMicros),
          pricingVersion: input.accounting?.pricingVersion,
          finishedAt: new Date(input.occurredAt),
        },
      });
      if (updated.count !== 1) {
        throw Errors.conflict("Generation TransportExecution changed during transition", {
          attemptId: input.attemptId,
          transportAttemptNo: input.transportAttemptNo,
        });
      }
    } else {
      throw Errors.conflict("Generation TransportExecution is already terminal with a different outcome");
    }
    const terminalRecordPersistenceUnknown =
      input.status === "unknown" &&
      input.error?.code === "terminal_record_persist_failed";
    await recordGenerationAttemptEvent(
      tx,
      terminalRecordPersistenceUnknown
        ? {
            eventId: `${input.attemptId}:terminal-record-persistence-unknown`,
            attemptId: input.attemptId,
            eventType: "generation.attempt.unknown.v1",
            outcome: "unknown",
            occurredAt: new Date(input.occurredAt),
            payload: transportEventPayload(input),
            errorClass: "durable_terminal_evidence_persistence",
            errorCode: "terminal_record_persist_failed",
            errorSignature: `durable_terminal_evidence_persistence:${input.provider}`,
            retryability: "operator_retry",
            operatorGuidance:
              "Reconcile provider output before retrying; the invocation completed without durable terminal evidence.",
          }
        : {
            eventId: `${input.attemptId}:transport:${input.transportAttemptNo}:${input.status}`,
            attemptId: input.attemptId,
            eventType: `generation.transport.${input.status}.v1`,
            occurredAt: new Date(input.occurredAt),
            payload: transportEventPayload(input),
            status: "running",
            startedAt: attempt.startedAt ?? new Date(input.occurredAt),
          },
    );
    if (input.status !== "running") {
      const execution = await tx.generationTransportExecution.findUniqueOrThrow({ where: key });
      await recordGenerationInvocationUsageFact(tx, {
        attemptId: input.attemptId,
        generationJobId: input.generationJobId,
        transportAttemptNo: input.transportAttemptNo,
        transportExecutionId: execution.id,
        provider: input.provider,
        model: input.model,
        usage: input.accounting?.usage ?? {},
        latencyMs: input.accounting?.latencyMs ?? null,
        costMicros: input.accounting?.costMicros ?? null,
        pricingVersion: input.accounting?.pricingVersion ?? null,
        occurredAt: new Date(input.occurredAt),
      });
    }
    return { acknowledged: true, status: disposition };
  });
}

function transportEventPayload(input: GenerationTransportExecutionEvent) {
  return {
    generationJobId: input.generationJobId,
    transportAttemptNo: input.transportAttemptNo,
    provider: input.provider,
    model: input.model,
    providerRequestId: input.providerRequestId,
    idempotencyKey: input.idempotencyKey,
    status: input.status,
    error: input.error,
    accounting: input.accounting,
  };
}
