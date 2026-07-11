import { creativeReviewDecisionRequestSchema } from "@idream/shared/admin";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { recordCreativeReviewDecision } from "@/server/modules/admin-v2/creative/workflow";
import { actorWithPermission } from "@/server/modules/admin/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string; itemId: string }> };

export async function POST(request: Request, context: Context) {
  const { id, itemId } = await context.params;
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "creative.run.review");
    const body = creativeReviewDecisionRequestSchema.parse(await request.json());
    return recordCreativeReviewDecision({
      runId: id,
      itemId,
      actor,
      expectedVersion: body.entityVersion,
      decision: body.decision,
      identityConsistency: body.identityConsistency,
      score: body.score,
      reason: body.reason,
      requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
    });
  });
}
