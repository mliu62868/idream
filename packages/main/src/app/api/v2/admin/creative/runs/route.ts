import { creativeRunCreateResultSchema } from "@idream/shared/admin";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { Errors } from "@/server/lib/errors";
import { createProductionBatchCore } from "@/server/modules/admin/content-ops";
import { listCreativeRuns } from "@/server/modules/admin-v2/creative/workflow";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { ok } from "@/server/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(request, "creative.run.read");
    return listCreativeRuns({ requestUrl: request.url, actor });
  });
}

export function POST(request: Request) {
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(request, "creative.run.write");
    if (!request.headers.get("idempotency-key")?.trim()) {
      throw Errors.badRequest("Idempotency-Key is required for Creative Run creation");
    }
    const body = await jsonBody(request, "creativeRunCreateRequestSchema+idempotency-key");
    const response = await createProductionBatchCore(request, actor, body);
    const envelope = await response.json() as {
      readonly data?: {
        readonly batch?: { readonly id?: unknown };
        readonly replayed?: unknown;
      };
    };
    const result = creativeRunCreateResultSchema.parse({
      batch: { id: envelope.data?.batch?.id },
      replayed: envelope.data?.replayed,
    });
    return ok(result, { status: response.status });
  });
}
