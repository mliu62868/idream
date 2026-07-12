import { Prisma, type GenerationJob } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import {
  GENERATION_REQUEST_STATES,
  isGenerationRequestTransitionAllowed,
} from "@/server/modules/admin-v2/shared/state-transition-authority";

export type GenerationRequestStatus = (typeof GENERATION_REQUEST_STATES)[number];

type GenerationRequestTransitionData = Omit<
  Prisma.GenerationJobUpdateManyMutationInput,
  "status" | "version"
>;

interface GenerationRequestTransitionExpectation {
  readonly from?: GenerationRequestStatus | readonly GenerationRequestStatus[];
  readonly version?: number;
}

interface TransitionGenerationRequestInput {
  readonly requestId: string;
  readonly to: GenerationRequestStatus;
  readonly expected?: GenerationRequestTransitionExpectation;
  readonly data?: GenerationRequestTransitionData;
  readonly onConflict?: "throw" | "return-null";
}

function expectedStates(expected: GenerationRequestTransitionExpectation | undefined) {
  if (!expected?.from) return null;
  return Array.isArray(expected.from) ? expected.from : [expected.from];
}

function conflict(
  input: Pick<TransitionGenerationRequestInput, "requestId" | "onConflict">,
  message: string,
  details: Record<string, unknown>,
) {
  if (input.onConflict === "return-null") return null;
  throw Errors.conflict(message, details);
}

export function transitionGenerationRequest(
  tx: Prisma.TransactionClient,
  input: TransitionGenerationRequestInput & { readonly onConflict: "return-null" },
): Promise<GenerationJob | null>;
export function transitionGenerationRequest(
  tx: Prisma.TransactionClient,
  input: TransitionGenerationRequestInput & { readonly onConflict?: "throw" },
): Promise<GenerationJob>;
export async function transitionGenerationRequest(
  tx: Prisma.TransactionClient,
  input: TransitionGenerationRequestInput,
): Promise<GenerationJob | null> {
  const current = await tx.generationJob.findUnique({ where: { id: input.requestId } });
  if (!current) {
    return conflict(input, "Generation Request does not exist", { requestId: input.requestId });
  }

  const states = expectedStates(input.expected);
  if (
    (states && !states.includes(current.status as GenerationRequestStatus)) ||
    (input.expected?.version !== undefined && current.version !== input.expected.version)
  ) {
    return conflict(input, "Generation Request changed before transition", {
      requestId: input.requestId,
      expectedFrom: states,
      actualFrom: current.status,
      expectedVersion: input.expected?.version,
      actualVersion: current.version,
    });
  }
  if (!isGenerationRequestTransitionAllowed(current.status, input.to)) {
    return conflict(
      input,
      `Generation Request transition ${current.status} -> ${input.to} is not allowed`,
      { requestId: input.requestId, version: current.version },
    );
  }

  const changed = await tx.generationJob.updateMany({
    where: {
      id: current.id,
      status: current.status,
      version: current.version,
    },
    data: {
      ...input.data,
      status: input.to,
      version: { increment: 1 },
    },
  });
  if (changed.count !== 1) {
    return conflict(input, "Generation Request changed during transition", {
      requestId: input.requestId,
      from: current.status,
      to: input.to,
      version: current.version,
    });
  }
  return tx.generationJob.findUniqueOrThrow({ where: { id: current.id } });
}
