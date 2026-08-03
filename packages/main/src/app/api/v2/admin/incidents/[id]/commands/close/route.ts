import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { closeIncidentWithPostmortem } from "@/server/modules/admin-v2/incidents/service";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "ops.incident.manage");
    const body = await jsonBody(request, "incidentCloseRequestSchema+idempotency-key");
    if (body.confirmation !== `${id}:close`) throw Errors.badRequest("Confirmation did not match Incident close target");
    const idempotencyKey = requireIdempotencyKey(request);
    const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    return executeAtomicIdempotentMutation({ environment: env.APP_ENV, actor, idempotencyKey, requestId, commandType: "incident.close", target: { type: "ops_incident", id }, expectedVersion: body.entityVersion, payload: body, mutate: (tx) => closeIncidentWithPostmortem({ incidentId: id, expectedVersion: body.entityVersion, actor, summary: body.summary, rootCause: body.rootCause, contributingFactors: body.contributingFactors, correctiveActions: body.correctiveActions, evidenceRefs: body.evidenceRefs, reason: body.reason, requestId }, tx) });
  });
}
