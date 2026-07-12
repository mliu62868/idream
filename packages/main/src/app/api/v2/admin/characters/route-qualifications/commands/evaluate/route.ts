import { generationRouteQualificationEvaluateRequestSchema } from "@idream/shared/admin";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { evaluateGenerationRouteQualification } from "@/server/modules/admin-v2/characters/route-qualification";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request) {
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "content.production.write");
    const body = generationRouteQualificationEvaluateRequestSchema.parse(await request.json());
    const result = await evaluateGenerationRouteQualification({
      actor,
      request: body,
      requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
    });
    return Response.json({ ok: true, data: result }, { status: result.replayed ? 200 : 201 });
  });
}
