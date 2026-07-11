import { Prisma } from "@prisma/client";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";

export const GENERATION_ATTEMPT_TERMINAL_OUTCOMES = [
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
] as const;

export type GenerationAttemptTerminalOutcome =
  (typeof GENERATION_ATTEMPT_TERMINAL_OUTCOMES)[number];

type NonTerminalAttemptStatus = "queued" | "running";

export class GenerationAttemptEventConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationAttemptEventConflictError";
  }
}

export interface GenerationAttemptEventInput {
  readonly eventId: string;
  readonly attemptId: string;
  readonly expectedSequence?: number;
  readonly eventType: string;
  readonly outcome?: GenerationAttemptTerminalOutcome;
  readonly occurredAt: Date;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly status?: NonTerminalAttemptStatus;
  readonly startedAt?: Date;
  readonly errorClass?: string | null;
  readonly errorCode?: string | null;
  readonly errorSignature?: string | null;
  readonly retryability?: string | null;
  readonly operatorGuidance?: string | null;
  readonly completionManifestRef?: string | null;
}

export async function recordGenerationAttemptQueuedEvent(
  tx: Prisma.TransactionClient,
  attempt: {
    readonly id: string;
    readonly requestId: string;
    readonly attemptNo: number;
    readonly createdAt: Date;
  },
) {
  return recordGenerationAttemptEvent(tx, {
    eventId: `${attempt.id}:queued`,
    attemptId: attempt.id,
    eventType: "generation.attempt.queued.v1",
    occurredAt: attempt.createdAt,
    payload: { requestId: attempt.requestId, attemptNo: attempt.attemptNo },
    status: "queued",
  });
}

function eventHash(input: GenerationAttemptEventInput, sequence: number) {
  return canonicalSha256({
    attemptId: input.attemptId,
    sequence,
    eventType: input.eventType,
    outcome: input.outcome ?? null,
    occurredAt: input.occurredAt,
    payload: input.payload,
  });
}

function validateEventShape(input: GenerationAttemptEventInput) {
  if (input.outcome) {
    const requiredType = `generation.attempt.${input.outcome}.v1`;
    if (input.eventType !== requiredType) {
      throw new GenerationAttemptEventConflictError(
        `Terminal outcome ${input.outcome} requires eventType ${requiredType}`,
      );
    }
    if (input.status) {
      throw new GenerationAttemptEventConflictError("A terminal event cannot carry a non-terminal status");
    }
  } else if (input.eventType.startsWith("generation.attempt.") && input.eventType.endsWith(".v1")) {
    const encodedOutcome = input.eventType.slice("generation.attempt.".length, -".v1".length);
    if ((GENERATION_ATTEMPT_TERMINAL_OUTCOMES as readonly string[]).includes(encodedOutcome)) {
      throw new GenerationAttemptEventConflictError("A terminal eventType requires an outcome");
    }
  }
}

export async function recordGenerationAttemptEvent(
  tx: Prisma.TransactionClient,
  input: GenerationAttemptEventInput,
) {
  validateEventShape(input);
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM generation_attempts WHERE id = ${input.attemptId} FOR UPDATE
  `);
  if (locked.length !== 1) {
    throw new GenerationAttemptEventConflictError(`Generation Attempt ${input.attemptId} does not exist`);
  }

  const existingById = await tx.generationAttemptEvent.findUnique({ where: { id: input.eventId } });
  if (existingById) {
    const hash = eventHash(input, existingById.sequence);
    if (existingById.attemptId !== input.attemptId || existingById.payloadHash !== hash) {
      throw new GenerationAttemptEventConflictError(`Event id ${input.eventId} was reused with a different fact`);
    }
    return { ...existingById, disposition: "duplicate" as const };
  }

  const existingTerminal = await tx.generationAttemptEvent.findUnique({
    where: { attemptId_terminalScope: { attemptId: input.attemptId, terminalScope: "terminal" } },
  });
  if (existingTerminal) {
    throw new GenerationAttemptEventConflictError(
      `Generation Attempt ${input.attemptId} already has terminal outcome ${existingTerminal.outcome}`,
    );
  }

  const latest = await tx.generationAttemptEvent.findFirst({
    where: { attemptId: input.attemptId },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  const sequence = (latest?.sequence ?? 0) + 1;
  if (input.expectedSequence !== undefined && input.expectedSequence !== sequence) {
    throw new GenerationAttemptEventConflictError(
      `Generation Attempt ${input.attemptId} expected sequence ${sequence}, received ${input.expectedSequence}`,
    );
  }

  const attempt = await tx.generationAttempt.findUniqueOrThrow({ where: { id: input.attemptId } });
  if (input.outcome) {
    if (
      GENERATION_ATTEMPT_TERMINAL_OUTCOMES.includes(
        attempt.status as GenerationAttemptTerminalOutcome,
      ) && attempt.status !== input.outcome
    ) {
      throw new GenerationAttemptEventConflictError(
        `Attempt status ${attempt.status} conflicts with terminal outcome ${input.outcome}`,
      );
    }
  } else if (GENERATION_ATTEMPT_TERMINAL_OUTCOMES.includes(attempt.status as GenerationAttemptTerminalOutcome)) {
    throw new GenerationAttemptEventConflictError(
      `Generation Attempt ${input.attemptId} is already terminal (${attempt.status})`,
    );
  }

  const payloadHash = eventHash(input, sequence);
  const event = await tx.generationAttemptEvent.create({
    data: {
      id: input.eventId,
      attemptId: input.attemptId,
      sequence,
      eventType: input.eventType,
      outcome: input.outcome ?? null,
      terminalScope: input.outcome ? "terminal" : null,
      occurredAt: input.occurredAt,
      payload: toInputJson(input.payload),
      payloadHash,
    },
  });

  if (input.outcome) {
    await tx.generationAttempt.update({
      where: { id: input.attemptId },
      data: {
        status: input.outcome,
        terminalSequence: sequence,
        finishedAt: input.occurredAt,
        errorClass: input.errorClass,
        errorCode: input.errorCode,
        errorSignature: input.errorSignature,
        retryability: input.retryability,
        operatorGuidance: input.operatorGuidance,
        completionManifestRef: input.completionManifestRef,
      },
    });
  } else if (input.status) {
    await tx.generationAttempt.update({
      where: { id: input.attemptId },
      data: {
        status: input.status,
        ...(input.startedAt ? { startedAt: input.startedAt } : {}),
        ...(input.completionManifestRef !== undefined
          ? { completionManifestRef: input.completionManifestRef }
          : {}),
      },
    });
  }

  return { ...event, disposition: "created" as const };
}
