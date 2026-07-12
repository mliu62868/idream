import { adminBackfillRequestSchema } from "@idream/shared/admin";
import { backfillGenerationIncidents } from "@/server/modules/admin-v2/incidents/service";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export function POST(request: Request) {
  return adminV2Route(async () => {
    await actorWithPermission(request, "ops.incident.manage");
    return backfillGenerationIncidents(adminBackfillRequestSchema.parse(await request.json()));
  });
}
