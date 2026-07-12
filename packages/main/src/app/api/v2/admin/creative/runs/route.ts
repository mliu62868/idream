import { creativeRunCreateRequestSchema } from "@idream/shared/admin";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { Errors } from "@/server/lib/errors";
import { createProductionBatchCore } from "@/server/modules/admin/content-ops";
import { listCreativeRuns } from "@/server/modules/admin-v2/creative/workflow";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "creative.run.read");
    return listCreativeRuns({ requestUrl: request.url, actor });
  });
}

export function POST(request: Request) {
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "creative.run.write");
    if (!request.headers.get("idempotency-key")?.trim()) {
      throw Errors.badRequest("Idempotency-Key is required for Creative Run creation");
    }
    const body = creativeRunCreateRequestSchema.parse(await request.json());
    return createProductionBatchCore(request, actor, body);
  });
}
