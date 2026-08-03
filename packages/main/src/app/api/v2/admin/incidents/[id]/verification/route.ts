import { env } from "@/server/lib/env";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { verifyIncidentRecovery } from "@/server/modules/admin-v2/incidents/workflow";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(request, "ops.incident.manage");
    const body = await jsonBody(request, "incidentRecoveryVerificationRequestSchema+idempotency-key");
    const idempotencyKey = requireIdempotencyKey(request);
    const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    return executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor,
      idempotencyKey,
      requestId,
      commandType: "incident.verification",
      target: { type: "ops_incident", id },
      expectedVersion: body.entityVersion,
      payload: body,
      mutate: (tx) => verifyIncidentRecovery({
        incidentId: id,
        actor,
        expectedVersion: body.entityVersion,
        mode: body.mode,
        evidenceRefs: body.evidenceRefs,
        overrideReason: body.mode === "override" ? body.overrideReason : undefined,
        requestId,
      }, tx),
    });
  });
}
