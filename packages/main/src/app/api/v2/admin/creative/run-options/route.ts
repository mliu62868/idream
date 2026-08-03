import { creativeRunCreateOptionsSchema } from "@idream/shared/admin";
import { ok } from "@/server/lib/http";
import { getCreativeRunCreateOptions } from "@/server/modules/admin-v2/creative/workflow";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(request, "creative.run.read");
    return ok(creativeRunCreateOptionsSchema.parse(
      await getCreativeRunCreateOptions({ actor }),
    ));
  });
}
