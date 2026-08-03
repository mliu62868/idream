import {
  retryGenerationRequestResultSchema,
} from "@idream/shared/admin";
import { retryGenerationRequest } from "@/server/ai/generation-request-lifecycle";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(request, "generation.job.requeue");
    const body = await jsonBody(request, "retryGenerationRequestCommandSchema+idempotency-key");
    if (body.confirmation !== `${id}:retry`) {
      throw Errors.badRequest("Confirmation did not match Generation Request retry target");
    }
    const result = await retryGenerationRequest({
      requestId: id,
      expectedVersion: body.entityVersion,
      actor,
      reason: body.reason,
      idempotencyKey: requireIdempotencyKey(request),
      traceId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
    });
    return ok(retryGenerationRequestResultSchema.parse(result));
  });
}
