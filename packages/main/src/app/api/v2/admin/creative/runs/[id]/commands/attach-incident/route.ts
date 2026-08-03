import {
  creativeRunAttachIncidentResultSchema,
} from "@idream/shared/admin";
import { env } from "@/server/lib/env";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import {
  attachCreativeRunToIncident,
} from "@/server/modules/admin-v2/creative/incident-attachment";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(request, "ops.incident.manage");
    await actorWithPermission(request, "creative.run.write");
    const body = await jsonBody(request, "creativeRunAttachIncidentRequestSchema+idempotency-key");
    const idempotencyKey = requireIdempotencyKey(request);
    const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    return executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor,
      idempotencyKey,
      requestId,
      commandType: "creative.run.attach_incident",
      target: { type: "creative_run", id },
      expectedVersion: body.entityVersion,
      payload: body,
      mutate: async (tx) => creativeRunAttachIncidentResultSchema.parse(
        await attachCreativeRunToIncident({
          runId: id,
          incidentId: body.incidentId,
          actor,
          expectedVersion: body.entityVersion,
          reason: body.reason,
          requestId,
        }, tx),
      ),
    });
  });
}
