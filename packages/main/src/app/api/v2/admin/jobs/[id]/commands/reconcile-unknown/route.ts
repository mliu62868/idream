import {
  unknownGenerationReconciliationCommandSchema,
  unknownGenerationReconciliationResultSchema,
} from "@idream/shared/admin";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { reconcileUnknownGenerationRequest } from "@/server/modules/admin-v2/jobs/unknown-reconciliation";
import {
  actorWithPermission,
  jsonBody,
} from "@/server/modules/admin-v2/shared/authority";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "generation.job.requeue");
    const body = unknownGenerationReconciliationCommandSchema.parse(
      await jsonBody(request),
    );
    if (body.confirmation !== `${id}:${body.resolution}`) {
      throw Errors.badRequest(
        "Confirmation did not match unknown Generation reconciliation target",
      );
    }
    const result = await reconcileUnknownGenerationRequest({
      requestId: id,
      command: body,
      actor,
      idempotencyKey: requireIdempotencyKey(request),
      traceId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
    });
    return ok(unknownGenerationReconciliationResultSchema.parse(result));
  });
}
