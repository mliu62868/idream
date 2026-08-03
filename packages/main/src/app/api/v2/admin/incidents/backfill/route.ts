import { backfillGenerationIncidents } from "@/server/modules/admin-v2/backfill/production-runner";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { executeAdminBackfillHttpMutation } from "@/server/modules/admin-v2/backfill/http-mutation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export function POST(request: Request) {
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(request, "ops.incident.manage");
    const body = await jsonBody(request, "adminBackfillRequestSchema+idempotency-key");
    return executeAdminBackfillHttpMutation({
      request,
      actor,
      domain: "generation_incident_v1",
      body,
      execute: (identity) => identity.kind === "continuation"
        ? backfillGenerationIncidents({ runId: identity.runId, batchKey: identity.batchKey })
        : backfillGenerationIncidents({
            ...identity.body,
            actor,
            batchKey: identity.batchKey,
            stableRunId: identity.runId,
            optionsHash: identity.optionsHash,
          }),
    });
  });
}
