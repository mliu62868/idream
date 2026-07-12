import { incidentActionPlanPreviewRequestSchema } from "@idream/shared/admin";
import { previewIncidentActionPlan } from "@/server/modules/admin-v2/incidents/service";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "ops.incident.manage");
    const body = incidentActionPlanPreviewRequestSchema.parse(await request.json());
    return previewIncidentActionPlan({
      incidentId: id,
      action: body.action,
      actorId: actor.id,
      targetVersion: body.targetVersion,
      ttlMs: body.ttlSeconds ? body.ttlSeconds * 1_000 : undefined,
    });
  });
}
