import { incidentRecoveryVerificationRequestSchema } from "@idream/shared/admin";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { verifyIncidentRecovery } from "@/server/modules/admin-v2/incidents/workflow";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "ops.incident.manage");
    const body = incidentRecoveryVerificationRequestSchema.parse(await request.json());
    return verifyIncidentRecovery({
      incidentId: id,
      actor,
      expectedVersion: body.entityVersion,
      mode: body.mode,
      evidenceRefs: body.evidenceRefs,
      overrideReason: body.mode === "override" ? body.overrideReason : undefined,
      requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
    });
  });
}
