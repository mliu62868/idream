import { z } from "zod";
import { Errors } from "@/server/lib/errors";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { splitIncidentOccurrences } from "@/server/modules/admin-v2/incidents/service";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

const bodySchema = z.object({ entityVersion: z.number().int().positive(), occurrenceIds: z.array(z.string().min(1)).min(1), reason: z.string().trim().min(3), confirmation: z.string().min(1) }).strict();
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "ops.incident.manage");
    const body = bodySchema.parse(await request.json());
    if (body.confirmation !== `${id}:split:${[...new Set(body.occurrenceIds)].sort().join(",")}`) throw Errors.badRequest("Confirmation did not match Incident split scope");
    return splitIncidentOccurrences({ incidentId: id, expectedVersion: body.entityVersion, occurrenceIds: body.occurrenceIds, actor, reason: body.reason, requestId: request.headers.get("x-request-id") ?? crypto.randomUUID() });
  });
}
