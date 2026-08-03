import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { waitCase } from "@/server/modules/admin-v2/cases/service";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(request, "case.assign");
    const body = await jsonBody(request, "caseWaitRequestSchema+idempotency-key");
    if (body.confirmation !== `${id}:wait`) throw Errors.badRequest("Confirmation did not match Case wait target");
    const idempotencyKey = requireIdempotencyKey(request);
    const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    return executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor,
      idempotencyKey,
      requestId,
      commandType: "case.wait",
      target: { type: "admin_case", id },
      expectedVersion: body.entityVersion,
      payload: body,
      mutate: async (tx) => {
        const updated = await waitCase({ caseId: id, actor, expectedVersion: body.entityVersion, reason: body.reason, resumeAt: body.resumeAt ? new Date(body.resumeAt) : undefined, requestId }, tx);
        return { caseId: updated.id, status: updated.status, verificationState: updated.verificationState, version: updated.version };
      },
    });
  });
}
