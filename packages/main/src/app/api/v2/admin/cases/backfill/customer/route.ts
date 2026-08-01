import { adminBackfillRequestSchema } from "@idream/shared/admin";
import { backfillCustomerCases } from "@/server/modules/admin-v2/backfill/production-runner";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { executeAdminBackfillHttpMutation } from "@/server/modules/admin-v2/backfill/http-mutation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request) {
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "case.decide");
    const body = adminBackfillRequestSchema.parse(await jsonBody(request));
    return executeAdminBackfillHttpMutation({
      request,
      actor,
      domain: "customer_case_v1",
      body,
      execute: (identity) => identity.kind === "continuation"
        ? backfillCustomerCases({ runId: identity.runId, batchKey: identity.batchKey })
        : backfillCustomerCases({
            ...identity.body,
            actor,
            batchKey: identity.batchKey,
            stableRunId: identity.runId,
            optionsHash: identity.optionsHash,
          }),
    });
  });
}
