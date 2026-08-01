import type { Prisma } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import {
  INCIDENT_STATES,
  isIncidentTransitionAllowed,
} from "../shared/state-transition-authority";

type IncidentState = (typeof INCIDENT_STATES)[number];

export async function transitionIncident(
  tx: Prisma.TransactionClient,
  input: {
    readonly incidentId: string;
    readonly to: IncidentState;
    readonly expected: { readonly from: IncidentState; readonly version: number };
    readonly data?: Omit<Prisma.OpsIncidentUpdateManyMutationInput, "status" | "version">;
  },
) {
  if (!isIncidentTransitionAllowed(input.expected.from, input.to)) {
    throw Errors.conflict("Incident transition is not allowed", {
      from: input.expected.from,
      to: input.to,
    });
  }
  const changed = await tx.opsIncident.updateMany({
    where: {
      id: input.incidentId,
      status: input.expected.from,
      version: input.expected.version,
    },
    data: { ...input.data, status: input.to, version: { increment: 1 } },
  });
  if (changed.count !== 1) throw Errors.conflict("Incident changed before transition");
  return tx.opsIncident.findUniqueOrThrow({ where: { id: input.incidentId } });
}
