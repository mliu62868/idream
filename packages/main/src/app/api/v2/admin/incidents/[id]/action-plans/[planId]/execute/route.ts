import { incidentActionPlanExecuteRequestSchema } from "@idream/shared/admin";
import { executeIncidentActionPlan } from "@/server/modules/admin-v2/incidents/service";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { actorWithPermission } from "@/server/modules/admin/service";
import { Errors } from "@/server/lib/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string; planId: string }> };
export async function POST(request: Request, context: Context) {
  const { id, planId } = await context.params;
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "ops.incident.manage");
    const body = incidentActionPlanExecuteRequestSchema.parse(await request.json());
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey) throw Errors.badRequest("Idempotency-Key is required");
    return executeIncidentActionPlan({
      incidentId: id,
      actionPlanId: planId,
      expectedVersion: body.entityVersion,
      actor,
      confirmation: body.confirmation,
      idempotencyKey,
      requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
    });
  });
}
