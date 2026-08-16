import {
  getFeaturedCharacters,
  putFeaturedCharacters,
} from "@/server/modules/admin-v2/content/featured";
import { executeAdminMutation } from "@/server/modules/admin-v2/shared/admin-mutation";
import {
  actorWithPermission,
  type AdminV2RequestBody,
} from "@/server/modules/admin-v2/shared/authority";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { FEATURED_SETTING_KEY } from "@/server/modules/ourdream/featured-setting";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = AdminV2RequestBody<
  "contentFeaturedUpdateRequestSchema+idempotency-key"
>;

export function GET(request: Request) {
  return adminV2Route(request, async () => {
    await actorWithPermission(request, "content.read");
    return getFeaturedCharacters();
  });
}

export function PUT(request: Request) {
  return adminV2Route(request, () =>
    executeAdminMutation<Body>("PUT /api/v2/admin/content/featured", request, {
      params: {},
      target: () => ({ type: "app_setting", id: FEATURED_SETTING_KEY }),
      reason: (body) => body.reason,
      mutate: (tx, { actor, body, requestId }) =>
        putFeaturedCharacters({ tx, request, actor, requestId, body }),
      decorateResult: (result, replayed) => ({ ...(result as object), replayed }),
    })
  );
}
