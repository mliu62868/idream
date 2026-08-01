import { generationRouteQualificationEvaluateRequestSchema } from "@idream/shared/admin";
import { env } from "@/server/lib/env";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { evaluateGenerationRouteQualification } from "@/server/modules/admin-v2/characters/route-qualification";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request) {
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "content.production.write");
    const body = generationRouteQualificationEvaluateRequestSchema.parse(await jsonBody(request));
    const idempotencyKey = requireIdempotencyKey(request);
    const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    const result = await executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor,
      idempotencyKey,
      requestId,
      commandType: "generation.route_qualification.evaluate",
      target: { type: "generation_route_qualification", id: body.matrixKey },
      payload: body,
      mutate: (tx) => evaluateGenerationRouteQualification({ actor, request: body, requestId, tx }),
    });
    return Response.json({ ok: true, data: result }, { status: 201 });
  });
}
