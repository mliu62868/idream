import { caseAssignmentRequestSchema } from "@idream/shared/admin";
import { assignReviewCase } from "@/server/modules/admin-v2/cases/service";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { actorWithPermission } from "@/server/modules/admin/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "case.assign");
    const body = caseAssignmentRequestSchema.parse(await request.json());
    return assignReviewCase({
      caseId: id,
      actor,
      expectedVersion: body.entityVersion,
      ownerId: body.ownerId,
      priority: body.priority,
      slaDueAt: body.slaDueAt ? new Date(body.slaDueAt) : undefined,
      reason: body.reason,
      requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
    });
  });
}
