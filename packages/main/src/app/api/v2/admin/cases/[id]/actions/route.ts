import { customerCaseActionRequestSchema } from "@idream/shared/admin";
import { recordCustomerCaseAction } from "@/server/modules/admin-v2/cases/service";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "case.decide");
    const body = customerCaseActionRequestSchema.parse(await request.json());
    return recordCustomerCaseAction({
      caseId: id,
      actor,
      expectedVersion: body.entityVersion,
      action: body.action,
      summary: body.summary,
      evidenceRefs: body.evidenceRefs,
      outcomeRef: body.outcomeRef,
      requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
    });
  });
}
