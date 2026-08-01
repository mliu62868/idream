import type { Prisma } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import { isExperimentTransitionAllowed } from "../shared/state-transition-authority";

export async function transitionExperiment(
  tx: Prisma.TransactionClient,
  input: {
    readonly experimentId: string;
    readonly to: "running" | "stopped";
    readonly expected: {
      readonly from: "draft" | "running";
      readonly stateVersion: number;
    };
    readonly data: Omit<
      Prisma.ExperimentDefinitionUpdateManyMutationInput,
      "status" | "stateVersion"
    >;
  },
) {
  const current = await tx.experimentDefinition.findUnique({
    where: { id: input.experimentId },
    select: { status: true, stateVersion: true },
  });
  if (!current) throw Errors.notFound("Experiment definition not found");
  if (
    current.status !== input.expected.from ||
    current.stateVersion !== input.expected.stateVersion ||
    !isExperimentTransitionAllowed(current.status, input.to)
  ) {
    throw Errors.conflict("Experiment lifecycle changed; reload before retrying");
  }
  const changed = await tx.experimentDefinition.updateMany({
    where: {
      id: input.experimentId,
      status: input.expected.from,
      stateVersion: input.expected.stateVersion,
    },
    data: {
      ...input.data,
      status: input.to,
      stateVersion: { increment: 1 },
    },
  });
  if (changed.count !== 1) {
    throw Errors.conflict("Experiment lifecycle changed; reload before retrying");
  }
  return tx.experimentDefinition.findUniqueOrThrow({
    where: { id: input.experimentId },
  });
}
