import { caseDecisionRequestSchema } from "@idream/shared/admin";
import { env } from "@/server/lib/env";
import { recordReviewCaseDecision } from "@/server/modules/admin-v2/cases/service";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
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
    const idempotencyKey = requireIdempotencyKey(request);
    const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    return executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor,
      idempotencyKey,
      requestId,
      commandType: "case.decision.record",
      target: { type: "admin_case", id },
      expectedVersion: body.entityVersion,
      payload: body,
      mutate: async (tx) => {
        const updated = await recordReviewCaseDecision(tx, {
        caseId: id,
        actor,
        expectedVersion: body.entityVersion,
        decision: body.decision,
        summary: body.summary,
        evidenceRefs: body.evidenceRefs,
        confidence: body.confidence,
        requestId,
        });
        return { caseId: updated.id, status: updated.status, verificationState: updated.verificationState, version: updated.version };
      },
    });
  });
}
