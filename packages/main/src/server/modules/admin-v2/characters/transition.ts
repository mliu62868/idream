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

/**
 * SPEC: 调用方在冲突时想抛的错。缺省是通用 409。
 *
 * INTENT: §2.4 要求当前状态由 transition 自己读、自己判，调用方不得先问 isTransitionAllowed 再
 * 自写 update。但 release executor 有自己的错误词表（ReleaseCommandError 的 code 会进命令记录，
 * 运营按它归因）。把「谁判不变量」和「用谁的词表报错」拆开：不变量只判一次，词表仍归调用方。
 */
type TransitionConflict = () => Error;

function conflictError(
  conflict: TransitionConflict | undefined,
  message: string,
  details: Record<string, unknown>,
) {
  return conflict?.() ?? Errors.conflict(message, details);
}

/**
 * SPEC: CharacterRelease 状态写入的唯一入口 —— 读取当前状态、校验边、CAS、返回新快照。
 *
 * INVARIANT: 当前状态永远来自紧邻 CAS 的这次读取，不是调用方几十行之前拿到的那份。此前
 * `expected.from` 由调用方用 `release.status as "in_review"` 这类断言喂进来 —— 断言的是它希望
 * 的状态，不是行上的状态。
 */
export async function transitionCharacterRelease(
  tx: Prisma.TransactionClient,
  input: {
    readonly releaseId: string;
    readonly to: ReleaseStatus;
    readonly expectedVersion?: number;
    readonly data?: Omit<Prisma.CharacterReleaseUpdateManyMutationInput, "status" | "version">;
    readonly conflict?: TransitionConflict;
  },
) {
  const current = await tx.characterRelease.findUnique({
    where: { id: input.releaseId },
    select: { status: true, version: true },
  });
  if (
    !current ||
    (input.expectedVersion !== undefined && current.version !== input.expectedVersion) ||
    !isCharacterReleaseTransitionAllowed(current.status, input.to)
  ) {
    throw conflictError(input.conflict, "Character Release transition is not allowed", {
      releaseId: input.releaseId,
      from: current?.status ?? null,
      to: input.to,
    });
  }
  const changed = await tx.characterRelease.updateMany({
    where: { id: input.releaseId, status: current.status, version: current.version },
    data: { ...input.data, status: input.to, version: { increment: 1 } },
  });
  if (changed.count !== 1) {
    throw conflictError(input.conflict, "Character Release changed before transition", {
      releaseId: input.releaseId,
    });
  }
  return tx.characterRelease.findUniqueOrThrow({ where: { id: input.releaseId } });
}

export async function transitionCharacterProject(
  tx: Prisma.TransactionClient,
  input: {
    readonly projectId: string;
    readonly to: ProjectPhase;
    readonly expectedVersion?: number;
    readonly data?: Omit<Prisma.CharacterProjectUpdateManyMutationInput, "phase" | "version">;
    readonly conflict?: TransitionConflict;
  },
) {
  const current = await tx.characterProject.findUnique({
    where: { id: input.projectId },
    select: { phase: true, version: true },
  });
  if (
    !current ||
    (input.expectedVersion !== undefined && current.version !== input.expectedVersion) ||
    !isCharacterProjectPhaseTransitionAllowed(current.phase, input.to)
  ) {
    throw conflictError(input.conflict, "Character Project phase transition is not allowed", {
      projectId: input.projectId,
      from: current?.phase ?? null,
      to: input.to,
    });
  }
  const changed = await tx.characterProject.updateMany({
    where: { id: input.projectId, phase: current.phase, version: current.version },
    data: { ...input.data, phase: input.to, version: { increment: 1 } },
  });
  if (changed.count !== 1) {
    throw conflictError(input.conflict, "Character Project changed before transition", {
      projectId: input.projectId,
    });
  }
  return tx.characterProject.findUniqueOrThrow({ where: { id: input.projectId } });
}

export async function transitionCharacterServing(
  tx: Prisma.TransactionClient,
  input: {
    readonly servingId: string;
    readonly to: ServingState;
    readonly expectedVersion?: number;
    readonly expectedCurrentReleaseId?: string | null;
    readonly data?: Omit<Prisma.CharacterServingUncheckedUpdateManyInput, "state" | "version">;
    readonly conflict?: TransitionConflict;
  },
) {
  const current = await tx.characterServing.findUnique({
    where: { id: input.servingId },
    select: { state: true, version: true },
  });
  if (
    !current ||
    (input.expectedVersion !== undefined && current.version !== input.expectedVersion) ||
    !isCharacterServingTransitionAllowed(current.state, input.to)
  ) {
    throw conflictError(input.conflict, "Character Serving transition is not allowed", {
      servingId: input.servingId,
      from: current?.state ?? null,
      to: input.to,
    });
  }
  const changed = await tx.characterServing.updateMany({
    where: {
      id: input.servingId,
      state: current.state,
      version: current.version,
      ...(input.expectedCurrentReleaseId !== undefined
        ? { currentReleaseId: input.expectedCurrentReleaseId }
        : {}),
    },
    data: { ...input.data, state: input.to, version: { increment: 1 } },
  });
  if (changed.count !== 1) {
    throw conflictError(input.conflict, "Character Serving changed before transition", {
      servingId: input.servingId,
    });
  }
  return tx.characterServing.findUniqueOrThrow({ where: { id: input.servingId } });
}
