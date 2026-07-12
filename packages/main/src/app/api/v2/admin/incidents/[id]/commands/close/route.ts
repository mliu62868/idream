import { z } from "zod";
import { Errors } from "@/server/lib/errors";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { closeIncidentWithPostmortem } from "@/server/modules/admin-v2/incidents/service";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

const bodySchema = z.object({ entityVersion: z.number().int().positive(), summary: z.string().trim().min(10), rootCause: z.string().trim().min(3), contributingFactors: z.array(z.string().trim().min(1)), correctiveActions: z.array(z.string().trim().min(1)).min(1), evidenceRefs: z.array(z.string().trim().min(1)).min(1), reason: z.string().trim().min(3), confirmation: z.string().min(1) }).strict();
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "ops.incident.manage");
    const body = bodySchema.parse(await request.json());
    if (body.confirmation !== `${id}:close`) throw Errors.badRequest("Confirmation did not match Incident close target");
    return closeIncidentWithPostmortem({ incidentId: id, expectedVersion: body.entityVersion, actor, summary: body.summary, rootCause: body.rootCause, contributingFactors: body.contributingFactors, correctiveActions: body.correctiveActions, evidenceRefs: body.evidenceRefs, reason: body.reason, requestId: request.headers.get("x-request-id") ?? crypto.randomUUID() });
  });
}
