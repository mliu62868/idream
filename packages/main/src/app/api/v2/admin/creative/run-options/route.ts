import { creativeRunCreateOptionsSchema } from "@idream/shared/admin";
import { ok } from "@/server/lib/http";
import { getCreativeRunCreateOptions } from "@/server/modules/admin-v2/creative/create-options";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  return adminV2Route(request, async () => {
    // INTENT: the create options are the generation route / recipe catalog, not Character data;
    //         a scoped creator needs them to generate for an assigned Character.
    const actor = await actorWithPermission(request, "creative.run.read", { characterScope: "handler_enforced" });
    return ok(creativeRunCreateOptionsSchema.parse(
      await getCreativeRunCreateOptions({ actor }),
    ));
  });
}
