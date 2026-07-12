import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;
type Actor = { id: string; role: string };

export async function incidentReadScopeWhere(db: Db, actor: Actor): Promise<Prisma.OpsIncidentWhereInput> {
  if (actor.role !== "support") return {};
  const linked = await db.$queryRaw<Array<{ incidentId: string }>>`
    SELECT DISTINCT occurrence."incidentId"
    FROM "ops_incident_occurrences" occurrence
    JOIN "generation_jobs" job ON job.id = occurrence."requestId"
    JOIN "admin_cases" customer_case
      ON customer_case."targetType" = 'user'
      AND customer_case."targetId" = job."userId"
      AND customer_case.type IN ('support_request', 'billing_dispute')
  `;
  return { OR: [{ ownerId: actor.id }, { id: { in: linked.map((row) => row.incidentId) } }] };
}

export async function assertIncidentReadable(db: Db, actor: Actor, incidentId: string) {
  const row = await db.opsIncident.findFirst({
    where: { id: incidentId, ...(await incidentReadScopeWhere(db, actor)) },
    select: { id: true },
  });
  return Boolean(row);
}
