import { z } from "zod";
import { Errors } from "@/server/lib/errors";
import { actorWithPermission } from "@/server/modules/admin/service";
import { mergeIncidents } from "@/server/modules/admin-v2/incidents/service";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

const bodySchema = z.object({ entityVersion: z.number().int().positive(), sources: z.array(z.object({ incidentId: z.string().min(1), version: z.number().int().positive() }).strict()).min(1), reason: z.string().trim().min(3), confirmation: z.string().min(1) }).strict();
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "ops.incident.manage");
    const body = bodySchema.parse(await request.json());
    const sourceIds = [...new Set(body.sources.map((source) => source.incidentId).filter((sourceId) => sourceId !== id))].sort();
    if (body.confirmation !== `${id}:merge:${sourceIds.join(",")}`) throw Errors.badRequest("Confirmation did not match Incident merge scope");
    return mergeIncidents({ targetIncidentId: id, expectedVersion: body.entityVersion, sources: body.sources, actor, reason: body.reason, requestId: request.headers.get("x-request-id") ?? crypto.randomUUID() });
  });
}
