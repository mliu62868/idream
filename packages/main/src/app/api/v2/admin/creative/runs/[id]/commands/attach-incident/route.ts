import { creativeRunAttachIncidentRequestSchema } from "@idream/shared/admin";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { attachCreativeRunToIncident } from "@/server/modules/admin-v2/creative/workflow";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "ops.incident.manage");
    await actorWithPermission(request, "creative.run.write");
    const body = creativeRunAttachIncidentRequestSchema.parse(await request.json());
    return attachCreativeRunToIncident({
      runId: id,
      incidentId: body.incidentId,
      actor,
      expectedVersion: body.entityVersion,
      reason: body.reason,
      requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
    });
  });
}
