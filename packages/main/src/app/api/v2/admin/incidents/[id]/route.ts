import { incidentTriageRequestSchema } from "@idream/shared/admin";
import { Errors } from "@/server/lib/errors";
import { getIncidentDetail } from "@/server/modules/admin-v2/incidents/query";
import { triageIncident } from "@/server/modules/admin-v2/incidents/workflow";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

function requireMatchingIfMatch(request: Request, entityVersion: number) {
  const value = request.headers.get("if-match")?.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  if (!value || !/^\d+$/.test(value) || Number(value) !== entityVersion) {
    throw Errors.badRequest("If-Match must equal body entityVersion");
  }
}

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(() => getIncidentDetail(request, id));
}

export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "ops.incident.manage");
    const body = incidentTriageRequestSchema.parse(await request.json());
    requireMatchingIfMatch(request, body.entityVersion);
    const updated = await triageIncident({
      incidentId: id,
      actor,
      expectedVersion: body.entityVersion,
      ownerId: body.ownerId,
      severity: body.severity,
      slaDueAt: body.slaDueAt ? new Date(body.slaDueAt) : undefined,
      suspectedCause: body.suspectedCause,
      confidence: body.confidence,
      runbookUrl: body.runbookUrl,
      rollbackTarget: body.rollbackTarget,
      reason: body.reason,
      requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
    });
    return {
      incidentId: updated.id,
      status: updated.status,
      severity: updated.severity,
      ownerId: updated.ownerId,
      version: updated.version,
    };
  });
}
