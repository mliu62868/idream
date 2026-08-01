import { incidentActionPlanPreviewRequestSchema } from "@idream/shared/admin";
import { env } from "@/server/lib/env";
import { previewIncidentActionPlan } from "@/server/modules/admin-v2/incidents/service";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "ops.incident.manage");
    const body = incidentActionPlanPreviewRequestSchema.parse(await jsonBody(request));
    const idempotencyKey = requireIdempotencyKey(request);
    const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    return executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor,
      idempotencyKey,
      requestId,
      commandType: "incident.action_plan.preview",
      target: { type: "ops_incident", id },
      payload: body,
      mutate: (tx) => previewIncidentActionPlan({
        incidentId: id,
        action: body.action,
        actorId: actor.id,
        requestId,
        targetVersion: body.targetVersion,
        ttlMs: body.ttlSeconds ? body.ttlSeconds * 1_000 : undefined,
      }, tx),
    });
  });
}
