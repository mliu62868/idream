import type { Prisma } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import {
  ADMIN_CASE_STATES,
  isAdminCaseTransitionAllowed,
} from "../shared/state-transition-authority";

type CaseState = (typeof ADMIN_CASE_STATES)[number];

export async function transitionCase(
  tx: Prisma.TransactionClient,
  input: {
    readonly caseId: string;
    readonly to: CaseState;
    readonly expected: { readonly from: CaseState; readonly version: number };
    readonly data?: Omit<Prisma.AdminCaseUpdateManyMutationInput, "status" | "version">;
  },
) {
  if (!isAdminCaseTransitionAllowed(input.expected.from, input.to)) {
    throw Errors.conflict("Case transition is not allowed", {
      from: input.expected.from,
      to: input.to,
    });
  }
  const changed = await tx.adminCase.updateMany({
    where: {
      id: input.caseId,
      status: input.expected.from,
      version: input.expected.version,
    },
    data: { ...input.data, status: input.to, version: { increment: 1 } },
  });
  if (changed.count !== 1) throw Errors.conflict("Case changed before transition");
  return tx.adminCase.findUniqueOrThrow({ where: { id: input.caseId } });
}
