import { caseDecisionRequestSchema } from "@idream/shared/admin";
import { recordReviewCaseDecisionAtomic } from "@/server/modules/admin-v2/cases/service";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "case.decide");
    const body = caseDecisionRequestSchema.parse(await request.json());
    return recordReviewCaseDecisionAtomic({
        caseId: id,
        actor,
        expectedVersion: body.entityVersion,
        decision: body.decision,
        summary: body.summary,
        evidenceRefs: body.evidenceRefs,
        confidence: body.confidence,
        requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
      });
  });
}
