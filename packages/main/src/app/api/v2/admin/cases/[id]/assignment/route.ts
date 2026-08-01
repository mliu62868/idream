import { caseAssignmentRequestSchema } from "@idream/shared/admin";
import { env } from "@/server/lib/env";
import { assignReviewCaseInTransaction } from "@/server/modules/admin-v2/cases/service";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "case.assign");
    const body = caseAssignmentRequestSchema.parse(await jsonBody(request));
    const idempotencyKey = requireIdempotencyKey(request);
    const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    return executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor,
      idempotencyKey,
      requestId,
      commandType: "case.assignment",
      target: { type: "admin_case", id },
      expectedVersion: body.entityVersion,
      payload: body,
      mutate: async (tx) => {
        const updated = await assignReviewCaseInTransaction(tx, {
        caseId: id,
        actor,
        expectedVersion: body.entityVersion,
        ownerId: body.ownerId,
        priority: body.priority,
        slaDueAt: body.slaDueAt ? new Date(body.slaDueAt) : undefined,
        reason: body.reason,
        requestId,
        });
        return { caseId: updated.id, status: updated.status, verificationState: updated.verificationState, version: updated.version };
      },
    });
  });
}
