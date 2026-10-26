import { executeIncidentActionPlan } from "@/server/modules/admin-v2/incidents/service";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { durableAdminCommandReceipt, readDurableAdminCommand } from "@/server/modules/admin-v2/shared/durable-command-admission";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string; planId: string }> };
export async function POST(request: Request, context: Context) {
  const { id, planId } = await context.params;
  return adminV2Route(request, async () => {
    const { actor, body, idempotencyKey, requestId } = await readDurableAdminCommand(
      request,
      "POST /api/v2/admin/incidents/:id/action-plans/:planId/execute",
    );
    const command = await executeIncidentActionPlan({
      incidentId: id,
      actionPlanId: planId,
      expectedVersion: body.entityVersion,
      actor,
      confirmation: body.confirmation,
      idempotencyKey,
      requestId,
    });
    return durableAdminCommandReceipt(command);
  });
}
