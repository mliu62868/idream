import { adminBackfillRequestSchema } from "@idream/shared/admin";
import { backfillReviewCases } from "@/server/modules/admin-v2/cases/service";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export function POST(request: Request) {
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "case.decide");
    return backfillReviewCases({
      ...adminBackfillRequestSchema.parse(await request.json()),
      actor,
    });
  });
}
