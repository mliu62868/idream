import type { Prisma } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import {
  CHARACTER_PROJECT_PHASE_STATES,
  CHARACTER_RELEASE_STATES,
  CHARACTER_SERVING_STATES,
  isCharacterProjectPhaseTransitionAllowed,
  isCharacterReleaseTransitionAllowed,
  isCharacterServingTransitionAllowed,
} from "../shared/state-transition-authority";

type ProjectPhase = (typeof CHARACTER_PROJECT_PHASE_STATES)[number];
type ReleaseStatus = (typeof CHARACTER_RELEASE_STATES)[number];
type ServingState = (typeof CHARACTER_SERVING_STATES)[number];

export async function transitionCharacterRelease(
  tx: Prisma.TransactionClient,
  input: {
    readonly releaseId: string;
    readonly to: ReleaseStatus;
    readonly expected: { readonly from: ReleaseStatus; readonly version: number };
    readonly data?: Omit<Prisma.CharacterReleaseUpdateManyMutationInput, "status" | "version">;
  },
) {
  if (!isCharacterReleaseTransitionAllowed(input.expected.from, input.to)) {
    throw Errors.conflict("Character Release transition is not allowed");
  }
  const changed = await tx.characterRelease.updateMany({
    where: { id: input.releaseId, status: input.expected.from, version: input.expected.version },
    data: { ...input.data, status: input.to, version: { increment: 1 } },
  });
  if (changed.count !== 1) throw Errors.conflict("Character Release changed before transition");
  return tx.characterRelease.findUniqueOrThrow({ where: { id: input.releaseId } });
}

export async function transitionCharacterProject(
  tx: Prisma.TransactionClient,
  input: {
    readonly projectId: string;
    readonly to: ProjectPhase;
    readonly expected: { readonly from: ProjectPhase; readonly version: number };
    readonly data?: Omit<Prisma.CharacterProjectUpdateManyMutationInput, "phase" | "version">;
  },
) {
  if (!isCharacterProjectPhaseTransitionAllowed(input.expected.from, input.to)) {
    throw Errors.conflict("Character Project phase transition is not allowed");
  }
  const changed = await tx.characterProject.updateMany({
    where: { id: input.projectId, phase: input.expected.from, version: input.expected.version },
    data: { ...input.data, phase: input.to, version: { increment: 1 } },
  });
  if (changed.count !== 1) throw Errors.conflict("Character Project changed before transition");
  return tx.characterProject.findUniqueOrThrow({ where: { id: input.projectId } });
}

export async function transitionCharacterServing(
  tx: Prisma.TransactionClient,
  input: {
    readonly servingId: string;
    readonly to: ServingState;
    readonly expected: {
      readonly from: ServingState;
      readonly version: number;
      readonly currentReleaseId?: string | null;
    };
    readonly data?: Omit<Prisma.CharacterServingUncheckedUpdateManyInput, "state" | "version">;
  },
) {
  if (!isCharacterServingTransitionAllowed(input.expected.from, input.to)) {
    throw Errors.conflict("Character Serving transition is not allowed");
  }
  const changed = await tx.characterServing.updateMany({
    where: {
      id: input.servingId,
      state: input.expected.from,
      version: input.expected.version,
      ...(input.expected.currentReleaseId !== undefined
        ? { currentReleaseId: input.expected.currentReleaseId }
        : {}),
    },
    data: { ...input.data, state: input.to, version: { increment: 1 } },
  });
  if (changed.count !== 1) throw Errors.conflict("Character Serving changed before transition");
  return tx.characterServing.findUniqueOrThrow({ where: { id: input.servingId } });
}
