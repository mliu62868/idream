import { env } from "@/server/lib/env";
import { verifyReviewCase } from "@/server/modules/admin-v2/cases/service";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(request, "case.decide");
    const body = await jsonBody(request, "caseVerificationRequestSchema+idempotency-key");
    const idempotencyKey = requireIdempotencyKey(request);
    const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    return executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor,
      idempotencyKey,
      requestId,
      commandType: "case.verification.record",
      target: { type: "admin_case", id },
      expectedVersion: body.entityVersion,
      payload: body,
      mutate: async (tx) => {
        const updated = await verifyReviewCase({
        caseId: id,
        actor,
        expectedVersion: body.entityVersion,
        state: body.state,
        evidenceRefs: body.evidenceRefs,
        overrideReason: body.overrideReason,
        requestId,
        }, tx);
        return { caseId: updated.id, status: updated.status, verificationState: updated.verificationState, version: updated.version };
      },
    });
  });
}
