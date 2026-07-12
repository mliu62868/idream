import type { Prisma } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import { isControlPlaneCommandAttemptTransitionAllowed } from "./state-transition-authority";

type AttemptUpdate = Omit<
  Prisma.ControlPlaneCommandAttemptUpdateManyMutationInput,
  "status"
>;

export async function transitionControlPlaneCommandAttempt(
  tx: Prisma.TransactionClient,
  input: {
    readonly commandId: string;
    readonly attemptNo: number;
    readonly to: "succeeded" | "failed";
    readonly data?: AttemptUpdate;
  },
) {
  const key = {
    commandId_attemptNo: {
      commandId: input.commandId,
      attemptNo: input.attemptNo,
    },
  } as const;
  const current = await tx.controlPlaneCommandAttempt.findUnique({ where: key });
  if (!current) {
    throw Errors.conflict("Control-plane command attempt does not exist", {
      commandId: input.commandId,
      attemptNo: input.attemptNo,
    });
  }
  if (!isControlPlaneCommandAttemptTransitionAllowed(current.status, input.to)) {
    throw Errors.conflict(
      `Control-plane command attempt transition ${current.status} -> ${input.to} is not allowed`,
      { commandId: input.commandId, attemptNo: input.attemptNo },
    );
  }
  const changed = await tx.controlPlaneCommandAttempt.updateMany({
    where: { id: current.id, status: current.status },
    data: { ...input.data, status: input.to },
  });
  if (changed.count !== 1) {
    throw Errors.conflict("Control-plane command attempt changed during transition", {
      commandId: input.commandId,
      attemptNo: input.attemptNo,
    });
  }
}
